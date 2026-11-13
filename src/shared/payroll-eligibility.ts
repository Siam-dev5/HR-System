// Payroll eligibility (P4): whether a period may pay an employee — separate from whether HR selected them. Pure
// function over the employee record, salary history, company assignments and the period dates. It never decides
// money: an employee who may be paid goes to the unchanged engine, which prorates with the existing rules.
//
// Order (the first block wins, then review, then pay):
//   block  employment_period_mismatch  hire date not a date, or termination before hire
//   block  not_employed                hired after the period, or terminated before it (a past employee may be
//                                      selected to review, never paid automatically)
//   block  missing_salary              no positive base salary, or a salary of 0 in force on a paid day
//   block  company_unresolved / company_conflict   P3 company check (transfer in the period, moved out, held…)
//   review employment_period_mismatch  resigned / terminated without a termination date (the end is unknown)
//   review review_required             a status payroll does not know (e.g. suspended): HR confirms or deselects
//   review review_required             a contract employee whose recorded contracts do not cover every paid day (P5):
//                                      HR sets the termination date (existing proration), renews, or confirms
//   block  blocked (monthly_pay_frequency)  a mid-month round never pays an employee whose pay frequency is monthly (P6)
//   note   no_mid_month_rule           a semi-monthly employee not on probation in a mid-month round: the only
//                                      mid-month rule is the probation advance (HR-PAYROLL-POLICY section 3), so
//                                      nothing is paid to them there (exactly as before) until HR defines a rule
//   note   contract_unrecorded         a contract employee without any recorded contract is paid as before (a note,
//                                      never a block, so existing payroll is not disrupted)
//   pay    eligible_prorated           the employment covers only part of the period (existing proration)
//   pay    eligible                    the whole period
// A review case is paid only after HR confirms it for exactly these reasons (permission payroll_selection.override);
// a blocked one never is. Missing information never becomes "eligible".
import { payrollCompanyCheck, type CompanyAssignment, type PayrollCompanyReason } from './company-detection';

export type EligibilityStatus =
  | 'eligible' | 'eligible_prorated' | 'review_required' | 'blocked' | 'not_employed'
  | 'company_unresolved' | 'company_conflict' | 'missing_salary' | 'employment_period_mismatch';
export type Decision = 'pay' | 'review' | 'block';

export type EligibilityReason =
  | 'invalid_hire_date' | 'termination_before_hire' | 'hired_after_period' | 'terminated_before_period'
  | 'no_base_salary' | 'zero_salary_in_period' | 'terminated_without_date' | 'unknown_status'
  | 'starts_in_period' | 'ends_in_period' | 'contract_not_covering' | 'monthly_pay_frequency'
  | PayrollCompanyReason;

/** Information that never changes the decision (shown to HR). */
export type EligibilityNote = 'contract_unrecorded' | 'no_mid_month_rule';
export const ELIGIBILITY_NOTE_LABEL: Record<EligibilityNote, string> = {
  contract_unrecorded: 'พนักงานสัญญาจ้างที่ยังไม่ได้บันทึกระยะเวลาสัญญา (จ่ายตามเดิม ควรบันทึกสัญญา)',
  no_mid_month_rule: 'จ่ายครึ่งเดือนแต่ไม่ได้อยู่ระหว่างทดลองงาน: ยังไม่มีกติกาจ่ายกลางเดือนสำหรับกรณีนี้ (ไม่จ่ายในรอบกลางเดือน รอ HR กำหนด)',
};

export const ELIGIBILITY_REASON_LABEL: Record<EligibilityReason, string> = {
  invalid_hire_date: 'วันเริ่มงานไม่ถูกต้อง',
  termination_before_hire: 'วันสิ้นสุดการจ้างอยู่ก่อนวันเริ่มงาน',
  hired_after_period: 'เริ่มงานหลังงวดนี้',
  terminated_before_period: 'สิ้นสุดการจ้างก่อนงวดนี้ (เลือกเพื่อตรวจสอบได้ แต่จ่ายอัตโนมัติไม่ได้)',
  no_base_salary: 'ไม่มีเงินเดือนพื้นฐาน',
  zero_salary_in_period: 'มีช่วงที่เงินเดือนเป็น 0 ในงวด',
  terminated_without_date: 'สถานะลาออก/เลิกจ้างแต่ไม่มีวันสิ้นสุดการจ้าง (ต้องให้ HR ตรวจสอบ)',
  unknown_status: 'สถานะพนักงานที่ระบบเงินเดือนไม่รู้จัก (เช่น พักงาน) ต้องให้ HR ยืนยัน',
  starts_in_period: 'เริ่มงานระหว่างงวด (คิดตามสัดส่วนตามกฎเดิม)',
  ends_in_period: 'สิ้นสุดการจ้างระหว่างงวด (คิดตามสัดส่วนตามกฎเดิม)',
  monthly_pay_frequency: 'พนักงานรับเงินรายเดือน จึงไม่อยู่ในรอบจ่ายกลางเดือน',
  contract_not_covering: 'สัญญาจ้างที่บันทึกไว้ไม่ครอบคลุมทุกวันที่จ่ายในงวด (ต้องกำหนดวันสิ้นสุดการจ้าง ต่อสัญญา หรือให้ HR ยืนยัน)',
  no_assignment: 'ไม่มีการกำหนดบริษัทของพนักงานในช่วงงวด',
  assignment_gap: 'การกำหนดบริษัทไม่ครอบคลุมทุกวันที่จ่าย',
  assignment_pending_review: 'บริษัทของพนักงานรอ HR ยืนยัน',
  record_differs: 'บริษัทในทะเบียนไม่ตรงกับการกำหนดบริษัท',
  period_company_differs: 'พนักงานไม่ได้อยู่ในบริษัทของงวดนี้',
  transfer_in_period: 'ย้ายบริษัทระหว่างงวด (ไม่แบ่งจ่ายข้ามบริษัท)',
  payslip_company_differs: 'สลิปที่คำนวณไว้เป็นของบริษัทอื่น',
  moved_out: 'ย้ายไปบริษัทอื่นแล้ว (งวดย้อนหลังของบริษัทเดิมจ่ายให้ไม่ได้)',
};

export const KNOWN_STATUSES: ReadonlySet<string> = new Set(['active', 'probation', 'resigned', 'terminated']);

export interface EligibilityEmployee {
  id: number;
  company_id: number;
  status: string;
  hire_date: string | null;
  termination_date: string | null;
  base_salary: number | null;
  /** employees.employment_type (permanent / contract / probation / intern) */
  employment_type?: string | null;
  /** effective pay frequency (employee override, else the company's; null = not configured) — P6 */
  pay_frequency?: string | null;
}

export interface ContractPeriod {
  start_date: string;
  end_date: string | null;
  status: 'active' | 'cancelled';
}

export interface EligibilityInput {
  period: { start_date: string; end_date: string; company_id: number | null; kind?: string };
  employee: EligibilityEmployee;
  /** salary history of the employee (effective_date, base_salary) */
  salaryHistory: ReadonlyArray<{ effective_date: string; base_salary: number }>;
  assignments: readonly CompanyAssignment[];
  /** recorded contract periods of the employee (P5; only read for contract employees) */
  contracts?: readonly ContractPeriod[];
}

export interface Eligibility {
  status: EligibilityStatus;
  decision: Decision;
  reasons: EligibilityReason[];
  notes: EligibilityNote[];
  /** paid range inside the period (null when there is none) */
  from: string | null;
  to: string | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v: string | null): v is string => !!v && DATE.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

const DAY = 86_400_000;
const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + DAY).toISOString().slice(0, 10);

/** Whether the active contract periods cover every day of [from, to]. */
export function contractsCover(contracts: readonly ContractPeriod[], from: string, to: string): boolean {
  let day = from;
  for (const c of contracts.filter((x) => x.status === 'active').sort((a, b) => a.start_date.localeCompare(b.start_date))) {
    if (c.end_date !== null && c.end_date < day) continue;
    if (c.start_date > day) return false;
    if (c.end_date === null || c.end_date >= to) return true;
    day = nextDay(c.end_date);
  }
  return false;
}

export function evaluateEligibility(input: EligibilityInput): Eligibility {
  const e = input.employee;
  const contracts = e.employment_type === 'contract' ? (input.contracts ?? []).filter((c) => c.status === 'active') : [];
  const notes: EligibilityNote[] = e.employment_type === 'contract' && !contracts.length ? ['contract_unrecorded'] : [];
  if (input.period.kind === 'mid_month' && e.pay_frequency === 'semi_monthly' && e.status !== 'probation') notes.push('no_mid_month_rule');
  return { ...decide(input, contracts), notes };
}

function decide(input: EligibilityInput, contracts: readonly ContractPeriod[]): Omit<Eligibility, 'notes'> {
  const { period: p, employee: e } = input;
  const block = (status: EligibilityStatus, reasons: EligibilityReason[], from: string | null = null, to: string | null = null): Omit<Eligibility, 'notes'> => ({ status, decision: 'block', reasons, from, to });
  if (!isDate(e.hire_date)) return block('employment_period_mismatch', ['invalid_hire_date']);
  const term = e.termination_date && isDate(e.termination_date) ? e.termination_date : null;
  if (term && term < e.hire_date) return block('employment_period_mismatch', ['termination_before_hire']);
  if (e.hire_date > p.end_date) return block('not_employed', ['hired_after_period']);
  if (term && term < p.start_date) return block('not_employed', ['terminated_before_period']);
  const from = e.hire_date > p.start_date ? e.hire_date : p.start_date;
  const to = term && term < p.end_date ? term : p.end_date;

  // salary in force on each paid day: the latest history entry on or before it, otherwise the record's base salary
  if (e.base_salary === null || !(e.base_salary > 0)) return block('missing_salary', ['no_base_salary'], from, to);
  const history = [...input.salaryHistory].sort((a, b) => a.effective_date.localeCompare(b.effective_date));
  const atFrom = history.filter((h) => h.effective_date <= from).at(-1)?.base_salary ?? e.base_salary;
  if (!(atFrom > 0) || history.some((h) => h.effective_date > from && h.effective_date <= to && !(h.base_salary > 0))) return block('missing_salary', ['zero_salary_in_period'], from, to);

  if (p.kind === 'mid_month' && e.pay_frequency === 'monthly') return block('blocked', ['monthly_pay_frequency'], from, to);

  const company = payrollCompanyCheck(p, { id: e.id, company_id: e.company_id, hire_date: e.hire_date }, from, to, input.assignments);
  if (!company.ok) return block(company.error === 'company_unresolved' ? 'company_unresolved' : 'company_conflict', [company.reason!], from, to);

  const review: EligibilityReason[] = [];
  if ((e.status === 'resigned' || e.status === 'terminated') && !term) review.push('terminated_without_date');
  if (!KNOWN_STATUSES.has(e.status)) review.push('unknown_status');
  if (contracts.length && !contractsCover(contracts, from, to)) review.push('contract_not_covering');
  if (review.length) return { status: review.includes('terminated_without_date') ? 'employment_period_mismatch' : 'review_required', decision: 'review', reasons: review, from, to };

  const partial: EligibilityReason[] = [];
  if (from > p.start_date) partial.push('starts_in_period');
  if (to < p.end_date) partial.push('ends_in_period');
  return partial.length ? { status: 'eligible_prorated', decision: 'pay', reasons: partial, from, to } : { status: 'eligible', decision: 'pay', reasons: [], from, to };
}

/** The reasons a review confirmation covers (a confirmation lapses when they change). */
export const reviewBasis = (reasons: readonly EligibilityReason[]): string => [...reasons].sort().join(',');

/** Whether the period pays this employee: eligible, or a review case HR confirmed for exactly these reasons. */
export function payable(el: Eligibility, confirmation: { review_confirmed: number; review_basis: string | null } | null): boolean {
  if (el.decision === 'pay') return true;
  if (el.decision === 'review') return !!confirmation && confirmation.review_confirmed === 1 && confirmation.review_basis === reviewBasis(el.reasons);
  return false;
}

// ---- Employees outside a period's list --------------------------------------------------------------------------

export type OutsideReason = 'newly_hired' | 'resigned_terminated' | 'status_other' | 'no_salary' | 'transferred' | 'deselected' | 'historical';

export const OUTSIDE_LABEL: Record<OutsideReason, string> = {
  newly_hired: 'เริ่มงานหลังสิ้นงวด',
  resigned_terminated: 'ลาออก/เลิกจ้างก่อนงวด หรือไม่มีวันสิ้นสุดการจ้าง',
  status_other: 'สถานะอื่น (เช่น พักงาน) ที่ไม่อยู่ในรายชื่อปกติ',
  no_salary: 'ไม่มีเงินเดือนพื้นฐาน',
  transferred: 'ย้ายบริษัท (เคยอยู่บริษัทของงวดนี้)',
  deselected: 'HR นำออกจากงวดนี้',
  historical: 'อดีตพนักงาน',
};

/** Why an employee is not on a period's standard list (for HR, before selecting them). */
export function outsideReason(p: { start_date: string; end_date: string; company_id: number | null }, e: EligibilityEmployee): OutsideReason {
  if (p.company_id !== null && e.company_id !== p.company_id) return 'transferred';
  if (e.hire_date && e.hire_date > p.end_date) return 'newly_hired';
  if (e.termination_date && e.termination_date < p.start_date) return e.termination_date < p.start_date.slice(0, 4) + '-01-01' ? 'historical' : 'resigned_terminated';
  if (e.status === 'resigned' || e.status === 'terminated') return 'resigned_terminated';
  if (!KNOWN_STATUSES.has(e.status)) return 'status_other';
  if (e.base_salary === null || !(e.base_salary > 0)) return 'no_salary';
  return 'deselected';
}
