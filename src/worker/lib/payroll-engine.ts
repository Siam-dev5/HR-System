// Period calculation shared by "calculate" (writes payslips) and the Payroll Preview of a draft period (read-only).
// Inputs come only from D1: employees, approved salary history, active attendance imports (confirmed OT only),
// approved requests, recurring pay items, System Settings. Nothing here writes.
import type { PayResult } from '../../shared/payroll';
import { STANDARD_WHERE } from './payroll-selection';
import { calculatePay, resolveEwf, round2, wageSegments, type EwfStatus, type WageResult } from '../../shared/payroll';
import { priceHolidayWork, type ApplicableRule, type HolidayWorkInput as HolidayWorkBase } from '../../shared/holidays';
import type { HolidayPaySnapshot, PayslipCalc, PayrollPeriod } from '../../shared/types';
import { conflict } from './http';
import { ewfConfig, loadSettings, payrollConfig } from './settings';

export interface ComputedSlip {
  employee: {
    id: number;
    emp_code: string;
    name: string;
    company_id: number;
    company: string | null;
    department: string | null;
    position: string | null;
    hire_date: string;
    bank_account: string | null;
  };
  wage: WageResult;
  pay: PayResult;
  ewf: { status: EwfStatus; employeeRate: number | null; employerRate: number | null };
  calc: PayslipCalc;
  /** approved holiday-work records paid by this slip (locked to the period when the calculation is saved) */
  holidayRecordIds: number[];
}

type HolidayWorkInput = HolidayWorkBase & { employee_id: number };

/**
 * Approved holiday work of a monthly period that no other period has used. Refuses (409) instead of guessing when an
 * hour could be paid twice (an approved OT request on the same day) or when no approved pay rule applies.
 */
async function holidayWorkOf(db: D1Database, p: PeriodRowLike): Promise<{ work: HolidayWorkInput[]; rules: ApplicableRule[]; otClash: Array<{ employee_id: number; work_date: string }> }> {
  const { results: work } = await db
    .prepare(
      `SELECT w.id, w.employee_id, w.holiday_id, w.work_date, w.normal_hours, w.ot_hours, h.name AS holiday_name, h.holiday_type
       FROM holiday_work_records w JOIN holidays h ON h.id = w.holiday_id
       WHERE w.status = 'approved' AND h.status = 'approved' AND w.work_date BETWEEN ?1 AND ?2 AND (w.payroll_period_id IS NULL OR w.payroll_period_id = ?3)
       ORDER BY w.employee_id, w.work_date, w.id`,
    )
    .bind(p.start_date, p.end_date, p.id)
    .all<HolidayWorkInput>();
  if (!work.length) return { work, rules: [], otClash: [] };
  const { results: rules } = await db
    .prepare("SELECT id, company_id, employment_type, holiday_pay_entitled, work_multiplier, ot_multiplier, effective_from, effective_to FROM holiday_pay_rules WHERE status = 'approved'")
    .all<ApplicableRule>();
  const { results: otClash } = await db
    .prepare(
      `SELECT DISTINCT o.employee_id, o.work_date FROM overtime_requests o JOIN holiday_work_records w ON w.employee_id = o.employee_id AND w.work_date = o.work_date
       WHERE o.status = 'approved' AND w.status = 'approved' AND o.work_date BETWEEN ?1 AND ?2`,
    )
    .bind(p.start_date, p.end_date)
    .all<{ employee_id: number; work_date: string }>();
  return { work, rules, otClash };
}

export type PeriodRowLike = Pick<PayrollPeriod, 'id' | 'code' | 'start_date' | 'end_date' | 'pay_date' | 'status' | 'kind' | 'company_id'>;

/** Periods of the same kind conflict only when their company scopes can contain the same employee. */
export const sameScope = (param: number) => `(company_id IS NULL OR ?${param} IS NULL OR company_id = ?${param})`;

const fmt = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

/** Mid-month periods inside a monthly period (their slips are advances deducted at month-end). */
export async function advancePeriods(db: D1Database, p: PeriodRowLike): Promise<Array<{ id: number; code: string; status: string }>> {
  const { results } = await db
    .prepare(`SELECT id, code, status FROM payroll_periods WHERE kind = 'mid_month' AND deleted_at IS NULL AND start_date >= ?1 AND end_date <= ?2 AND ${sameScope(3)} ORDER BY start_date`)
    .bind(p.start_date, p.end_date, p.company_id)
    .all<{ id: number; code: string; status: string }>();
  return results;
}

/** The monthly period covering a mid-month round (null if none has been created yet). */
export async function coveringMonthly(db: D1Database, p: PeriodRowLike): Promise<{ id: number; code: string; status: string } | null> {
  return db
    .prepare(`SELECT id, code, status FROM payroll_periods WHERE kind = 'monthly' AND deleted_at IS NULL AND start_date <= ?1 AND end_date >= ?2 AND ${sameScope(3)} ORDER BY start_date LIMIT 1`)
    .bind(p.start_date, p.end_date, p.company_id)
    .first<{ id: number; code: string; status: string }>();
}

/**
 * Double-payment guards: a month-end cannot be calculated while one of its mid-month rounds is calculated but not yet
 * approved (its advance amount could still change), and a mid-month round cannot change once its month-end exists.
 */
export async function assertCalculable(db: D1Database, p: PeriodRowLike): Promise<void> {
  if (p.kind === 'monthly') {
    const pending = (await advancePeriods(db, p)).filter((x) => x.status === 'calculated');
    if (pending.length) throw conflict(`ต้องอนุมัติรอบจ่ายกลางเดือน ${pending.map((x) => x.code).join(', ')} ก่อนคำนวณสิ้นเดือน (ป้องกันการจ่ายซ้ำ)`);
  } else {
    const m = await coveringMonthly(db, p);
    if (m && m.status !== 'draft') throw conflict(`งวดสิ้นเดือน ${m.code} คำนวณแล้ว จึงแก้ไขรอบกลางเดือนไม่ได้ (ป้องกันการจ่ายซ้ำ)`);
  }
}

interface EmpRow {
  id: number;
  emp_code: string;
  first_name: string;
  last_name: string;
  company_id: number;
  company: string | null;
  department: string | null;
  position: string | null;
  hire_date: string;
  termination_date: string | null;
  base_salary: number;
  ewf_equivalent_welfare: number;
  bank_account: string | null;
  employment_type: string;
}

/**
 * `employeeIds` (P4): the employees HR selected and eligibility allows — replaces the standard selection below when the
 * period's list was changed; everything after the selection (salary, proration, OT, leave, deductions…) is unchanged.
 */
export async function computePeriod(db: D1Database, p: PeriodRowLike, filterCompany: number | null = null, employeeIds?: readonly number[]): Promise<ComputedSlip[]> {
  // a company-scoped period only ever pays that company's employees
  if (p.company_id !== null && filterCompany !== null && p.company_id !== filterCompany) return [];
  const companyId = p.company_id ?? filterCompany;
  const settings = await loadSettings(db);
  const cfg = payrollConfig(settings);
  const ewf = ewfConfig(settings);
  const midMonth = p.kind === 'mid_month';

  const { results: emps } = await db
    .prepare(
      `SELECT e.id, e.emp_code, e.first_name, e.last_name, e.company_id, c.name AS company, d.name AS department, x.title AS position,
              e.hire_date, e.termination_date, e.base_salary, e.ewf_equivalent_welfare, e.bank_account, e.employment_type
       FROM employees e LEFT JOIN companies c ON c.id = e.company_id LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN positions x ON x.id = e.position_id
       WHERE ${employeeIds ? 'e.id IN (SELECT value FROM json_each(?4)) AND (?3 IS NULL OR e.company_id = ?3) AND ?1 IS NOT NULL AND ?2 IS NOT NULL' : STANDARD_WHERE}
       ORDER BY e.emp_code`,
    )
    .bind(p.end_date, p.start_date, companyId, ...(employeeIds ? [JSON.stringify(employeeIds)] : []))
    .all<EmpRow>();
  const { results: history } = await db
    .prepare('SELECT employee_id, effective_date, base_salary FROM employee_salary_history WHERE effective_date <= ?')
    .bind(p.end_date)
    .all<{ employee_id: number; effective_date: string; base_salary: number }>();
  const { results: headcounts } = await db
    .prepare("SELECT company_id, COUNT(*) AS n FROM employees WHERE status IN ('active', 'probation') GROUP BY company_id")
    .all<{ company_id: number; n: number }>();

  // attendance: an active Feishu import replaces OT requests and unpaid-leave requests for its company
  const { results: imports } = await db
    .prepare("SELECT id, company_id, version FROM attendance_imports WHERE payroll_period_id = ? AND status = 'active'")
    .bind(p.id)
    .all<{ id: number; company_id: number; version: number }>();
  const { results: attRows } = imports.length
    ? await db
        .prepare(
          `SELECT r.import_id, r.employee_id, r.actual_work_days, r.expected_work_days, r.actual_work_hours, r.ot_status, r.ot_confirmed_hours, r.ot_rate,
                  r.unpaid_sick_leave_hours, r.unpaid_personal_leave_hours
           FROM attendance_import_rows r JOIN attendance_imports i ON i.id = r.import_id
           WHERE i.payroll_period_id = ? AND i.status = 'active' AND r.included = 1 AND r.employee_id IS NOT NULL`,
        )
        .bind(p.id)
        .all<{ import_id: number; employee_id: number; actual_work_days: number | null; expected_work_days: number | null; actual_work_hours: number | null; ot_status: string; ot_confirmed_hours: number | null; ot_rate: number | null; unpaid_sick_leave_hours: number | null; unpaid_personal_leave_hours: number | null }>()
    : { results: [] };
  const { results: otReq } = await db
    .prepare("SELECT employee_id, hours, rate FROM overtime_requests WHERE status = 'approved' AND work_date BETWEEN ? AND ?")
    .bind(p.start_date, p.end_date)
    .all<{ employee_id: number; hours: number; rate: string }>();
  const { results: items } = await db
    .prepare(
      `SELECT i.employee_id, i.amount, c.code, c.name, c.kind, c.taxable, c.category FROM employee_pay_items i JOIN pay_components c ON c.id = i.component_id
       WHERE c.active = 1 AND (i.start_date IS NULL OR i.start_date <= ?) AND (i.end_date IS NULL OR i.end_date >= ?)`,
    )
    .bind(p.end_date, p.start_date)
    .all<{ employee_id: number; amount: number; code: string; name: string; kind: string; taxable: number; category: string | null }>();
  const { results: unpaid } = await db
    .prepare("SELECT l.employee_id, SUM(l.days) AS days FROM leave_requests l JOIN leave_types t ON t.id = l.leave_type_id WHERE l.status = 'approved' AND t.paid = 0 AND l.start_date BETWEEN ? AND ? GROUP BY l.employee_id")
    .bind(p.start_date, p.end_date)
    .all<{ employee_id: number; days: number }>();
  // advances paid in this month (approved / published mid-month rounds inside the period)
  const advanceIds = midMonth ? [] : (await advancePeriods(db, p)).filter((x) => x.status === 'approved' || x.status === 'published').map((x) => x.id);
  const { results: advances } = advanceIds.length
    ? await db
        .prepare(`SELECT employee_id, SUM(net) AS amount FROM payslips WHERE period_id IN (${advanceIds.map(() => '?').join(',')}) GROUP BY employee_id`)
        .bind(...advanceIds)
        .all<{ employee_id: number; amount: number }>()
    : { results: [] };
  // holiday work is paid at month-end only (a mid-month round is a wage advance, like OT)
  const holidays = midMonth ? { work: [] as HolidayWorkInput[], rules: [] as ApplicableRule[], otClash: [] as Array<{ employee_id: number; work_date: string }> } : await holidayWorkOf(db, p);

  const out: ComputedSlip[] = [];
  for (const e of emps) {
    const employeeHistory = history.filter((h) => h.employee_id === e.id).map((h) => ({ from: h.effective_date, amount: h.base_salary }));
    const wage = wageSegments({
      periodStart: p.start_date,
      periodEnd: p.end_date,
      hireDate: e.hire_date,
      terminationDate: e.termination_date,
      baseSalary: e.base_salary,
      history: employeeHistory,
      mode: midMonth ? 'mid_month' : 'monthly',
      divisorDays: cfg.otDivisorDays,
    });
    if (wage.eligibleDays === 0) continue;

    const imp = imports.find((i) => i.company_id === e.company_id) ?? null;
    const att = imp ? attRows.find((r) => r.import_id === imp.id && r.employee_id === e.id) ?? null : null;
    const overtime = midMonth
      ? []
      : imp
        ? att && (att.ot_status === 'confirmed' || att.ot_status === 'revised') && (att.ot_confirmed_hours ?? 0) > 0
          ? [{ hours: att.ot_confirmed_hours as number, rate: att.ot_rate ?? 1.5 }]
          : []
        : otReq.filter((o) => o.employee_id === e.id).map((o) => ({ hours: o.hours, rate: Number(o.rate) }));
    const unpaidHours = att ? (att.unpaid_sick_leave_hours ?? 0) + (att.unpaid_personal_leave_hours ?? 0) : null;
    const unpaidDays = midMonth ? 0 : imp ? round2((unpaidHours ?? 0) / cfg.hoursPerDay) : (unpaid.find((u) => u.employee_id === e.id)?.days ?? 0);

    const mine = midMonth ? [] : items.filter((i) => i.employee_id === e.id);
    const ewfFor = midMonth
      ? { status: 'disabled' as EwfStatus, rates: null }
      : resolveEwf(ewf, {
          date: p.pay_date,
          companyEmployeeCount: headcounts.find((h) => h.company_id === e.company_id)?.n ?? 0,
          providentFundMember: mine.some((i) => i.code === ewf.providentFundComponent),
          equivalentWelfare: e.ewf_equivalent_welfare === 1,
        });

    const worked = holidays.work.filter((w) => w.employee_id === e.id);
    let holiday: HolidayPaySnapshot | null = null;
    if (worked.length) {
      // an approved OT request on a holiday-work day would pay the same hours twice (Feishu OT is excluded by the
      // approver's confirmation on the record instead, because a Feishu import only carries period totals)
      const clash = imp ? undefined : holidays.otClash.find((x) => x.employee_id === e.id);
      if (clash) throw conflict(`พนักงาน ${e.emp_code} มีทั้งคำขอ OT ที่อนุมัติแล้วและบันทึกทำงานวันหยุดในวันที่ ${clash.work_date} ต้องยกเลิกรายการใดรายการหนึ่งก่อนคำนวณ (ป้องกันการจ่ายซ้ำ)`);
      // each record is priced at the salary in force on its own work date (salary history), not the period-end rate
      const priced = priceHolidayWork(worked, {
        companyId: e.company_id,
        employmentType: e.employment_type,
        baseSalary: e.base_salary,
        history: employeeHistory,
        divisorDays: cfg.otDivisorDays,
        hoursPerDay: cfg.hoursPerDay,
        rules: holidays.rules,
      });
      if (!priced.ok) {
        throw conflict(priced.reason === 'unknown_employment_type'
          ? `พนักงาน ${e.emp_code} มีประเภทการจ้าง "${e.employment_type}" ที่ระบบไม่รู้จัก จึงเลือกกฎค่าจ้างวันหยุดไม่ได้ ต้องแก้ข้อมูลพนักงานก่อนคำนวณ`
          : `ยังไม่มีกฎค่าจ้างวันหยุดที่อนุมัติแล้วสำหรับพนักงาน ${e.emp_code} (ประเภทการจ้าง ${e.employment_type}) ณ วันที่ ${priced.date} ต้องกำหนดและอนุมัติกฎก่อนคำนวณ`);
      }
      holiday = priced.snapshot;
    }

    const single = wage.segments.length === 1 && wage.fullPeriod;
    const wageLines = single
      ? undefined
      : wage.segments.map((s, i) => ({
          code: wage.segments.length === 1 ? 'BASE' : `BASE_${s.status === 'probation' ? 'PROB' : 'PASS'}${wage.segments.filter((x) => x.status === s.status).length > 1 ? `_${i + 1}` : ''}`,
          name: `${s.status === 'probation' ? 'ค่าจ้างช่วงทดลองงาน' : wage.probationStatus === 'passed' ? 'เงินเดือน' : 'ค่าจ้างหลังผ่านทดลองงาน'} ${fmt(s.start)}–${fmt(s.end)} (${s.paidDays} วัน)`,
          amount: s.amount,
        }));
    const pay = calculatePay(
      {
        baseSalary: wage.rate,
        earnedWage: wage.wage,
        wageLines,
        overtime,
        earnings: mine.filter((i) => i.kind === 'earning').map((i) => ({ code: i.code, name: i.name, amount: i.amount, taxable: i.taxable === 1, category: i.category ?? 'other' })),
        deductions: mine.filter((i) => i.kind === 'deduction').map((i) => ({ code: i.code, name: i.name, amount: i.amount, category: i.code === ewf.providentFundComponent ? 'provident_fund' : (i.category ?? 'other') })),
        unpaidLeaveDays: unpaidDays,
        ewf: ewfFor.rates,
        advance: advances.find((a) => a.employee_id === e.id)?.amount ?? 0,
        advanceOnly: midMonth,
        ...(holiday
          ? {
              holidayPay: [
                { code: 'HOLIDAY_WORK' as const, name: 'ค่าทำงานในวันหยุด', amount: holiday.workAmount },
                { code: 'HOLIDAY_OT' as const, name: 'ค่าล่วงเวลาในวันหยุด', amount: holiday.otAmount },
              ],
            }
          : {}),
      },
      cfg,
    );
    out.push({
      employee: { id: e.id, emp_code: e.emp_code, name: `${e.first_name} ${e.last_name}`, company_id: e.company_id, company: e.company, department: e.department, position: e.position, hire_date: e.hire_date, bank_account: e.bank_account },
      wage,
      pay,
      ewf: { status: ewfFor.status, employeeRate: ewfFor.rates?.employeeRate ?? null, employerRate: ewfFor.rates?.employerRate ?? null },
      calc: {
        segments: wage.segments,
        probationEnd: wage.probationEnd,
        probationStatus: wage.probationStatus,
        eligibleDays: wage.eligibleDays,
        fullPeriod: wage.fullPeriod,
        department: e.department,
        position: e.position,
        attendance: {
          source: imp ? 'feishu' : 'requests',
          importId: imp?.id ?? null,
          importVersion: imp?.version ?? null,
          workDays: att?.actual_work_days ?? null,
          expectedWorkDays: att?.expected_work_days ?? null,
          actualWorkHours: att?.actual_work_hours ?? null,
          otHours: round2(overtime.reduce((a, o) => a + o.hours, 0)),
          unpaidLeaveDays: unpaidDays,
          unpaidLeaveHours: unpaidHours,
        },
        // only present with holiday work, so the snapshot of every other payslip stays exactly as before
        ...(holiday ? { holiday } : {}),
      },
      holidayRecordIds: holiday ? holiday.items.map((x) => x.recordId) : [],
    });
  }
  return out;
}
