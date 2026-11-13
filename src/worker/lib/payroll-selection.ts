// Employee selection of payroll periods in D1 (P4). The standard list is the selection computePeriod has always made;
// HR's rows in payroll_period_selections take employees out of it or add others. A period without rows keeps exactly
// the standard list (every existing period is unchanged). Eligibility (shared/payroll-eligibility.ts) decides whether
// a selected employee may be paid; only payable employees reach the unchanged engine.
import { evaluateEligibility, payable, ELIGIBILITY_REASON_LABEL, type Eligibility } from '../../shared/payroll-eligibility';
import { loadAssignments } from './company-detection';
import { HttpError } from './http';

export interface SelPeriod {
  id: number;
  kind: string;
  start_date: string;
  end_date: string;
  company_id: number | null;
  status: string;
  calc_version: number;
}

/** The standard list of computePeriod (params ?1 = period end, ?2 = period start, ?3 = company or NULL). */
export const STANDARD_WHERE = `e.hire_date <= ?1 AND e.base_salary IS NOT NULL AND e.base_salary > 0
  AND (e.status IN ('active', 'probation') OR (e.status IN ('resigned', 'terminated') AND e.termination_date IS NOT NULL AND e.termination_date >= ?2))
  AND (?3 IS NULL OR e.company_id = ?3)`;

export async function standardIds(db: D1Database, p: Pick<SelPeriod, 'start_date' | 'end_date' | 'company_id'>): Promise<number[]> {
  const { results } = await db.prepare(`SELECT e.id FROM employees e WHERE ${STANDARD_WHERE} ORDER BY e.id`).bind(p.end_date, p.start_date, p.company_id).all<{ id: number }>();
  return results.map((r) => r.id);
}

export interface SelectionRow {
  id: number;
  period_id: number;
  employee_id: number;
  company_id: number;
  status: 'selected' | 'deselected';
  reason: string | null;
  review_confirmed: number;
  review_basis: string | null;
  review_reason: string | null;
  review_confirmed_by: number | null;
  review_confirmed_at: string | null;
  updated_at: string;
}

export async function selectionRows(db: D1Database, periodId: number): Promise<SelectionRow[]> {
  const { results } = await db.prepare('SELECT * FROM payroll_period_selections WHERE period_id = ? ORDER BY employee_id').bind(periodId).all<SelectionRow>();
  return results;
}

export type Origin = 'standard' | 'added';
export interface EffectiveSelection {
  /** HR changed the standard list of this period */
  hasRows: boolean;
  /** selected employees (standard minus deselected, plus added), ordered by id */
  ids: number[];
  origin: Map<number, Origin>;
  rows: Map<number, SelectionRow>;
  standard: Set<number>;
}

export async function effectiveSelection(db: D1Database, p: Pick<SelPeriod, 'id' | 'start_date' | 'end_date' | 'company_id'>): Promise<EffectiveSelection> {
  const [standard, rows] = await Promise.all([standardIds(db, p), selectionRows(db, p.id)]);
  const byEmp = new Map(rows.map((r) => [r.employee_id, r]));
  const origin = new Map<number, Origin>();
  for (const id of standard) if (byEmp.get(id)?.status !== 'deselected') origin.set(id, 'standard');
  for (const r of rows) if (r.status === 'selected' && !origin.has(r.employee_id)) origin.set(r.employee_id, 'added');
  return { hasRows: rows.length > 0, ids: [...origin.keys()].sort((a, b) => a - b), origin, rows: byEmp, standard: new Set(standard) };
}

/** Selected employee ids when HR changed the list, otherwise null (callers keep the standard selection SQL). */
export async function selectedIdsOrNull(db: D1Database, p: Pick<SelPeriod, 'id' | 'start_date' | 'end_date' | 'company_id'>): Promise<number[] | null> {
  const has = await db.prepare('SELECT 1 FROM payroll_period_selections WHERE period_id = ? LIMIT 1').bind(p.id).first();
  return has ? (await effectiveSelection(db, p)).ids : null;
}

export interface EvaluatedEmployee {
  employee_id: number;
  emp_code: string;
  company_id: number;
  origin: Origin | 'deselected' | 'outside';
  eligibility: Eligibility;
  confirmed: boolean;
  payable: boolean;
}

interface EmpRow {
  id: number;
  emp_code: string;
  company_id: number;
  status: string;
  hire_date: string | null;
  termination_date: string | null;
  base_salary: number | null;
  employment_type: string | null;
}

/** Eligibility of these employees for the period (selection rows give origin and HR confirmations). */
export async function evaluateEmployees(db: D1Database, p: Pick<SelPeriod, 'start_date' | 'end_date' | 'company_id'>, ids: readonly number[], sel?: EffectiveSelection): Promise<EvaluatedEmployee[]> {
  if (!ids.length) return [];
  const json = JSON.stringify([...new Set(ids)]);
  const [{ results: emps }, { results: history }, assignments, { results: contracts }] = await Promise.all([
    db.prepare('SELECT id, emp_code, company_id, status, hire_date, termination_date, base_salary, employment_type FROM employees WHERE id IN (SELECT value FROM json_each(?1)) ORDER BY emp_code').bind(json).all<EmpRow>(),
    db.prepare('SELECT employee_id, effective_date, base_salary FROM employee_salary_history WHERE employee_id IN (SELECT value FROM json_each(?1)) AND effective_date <= ?2').bind(json, p.end_date).all<{ employee_id: number; effective_date: string; base_salary: number }>(),
    loadAssignments(db, ids),
    db.prepare("SELECT employee_id, start_date, end_date, status FROM employee_contracts WHERE employee_id IN (SELECT value FROM json_each(?1)) AND status = 'active'").bind(json).all<{ employee_id: number; start_date: string; end_date: string | null; status: 'active' | 'cancelled' }>(),
  ]);
  return emps.map((e) => {
    const eligibility = evaluateEligibility({ period: p, employee: e, salaryHistory: history.filter((h) => h.employee_id === e.id), assignments: assignments.filter((a) => a.employee_id === e.id), contracts: contracts.filter((c) => c.employee_id === e.id) });
    const row = sel?.rows.get(e.id) ?? null;
    const origin = sel ? (sel.origin.get(e.id) ?? (row?.status === 'deselected' ? 'deselected' : 'outside')) : 'standard';
    const ok = payable(eligibility, row);
    return { employee_id: e.id, emp_code: e.emp_code, company_id: e.company_id, origin, eligibility, confirmed: eligibility.decision === 'review' && ok, payable: ok };
  });
}

export interface SelectionVersion {
  version: number;
  calculated_version: number | null;
}
export async function selectionVersion(db: D1Database, periodId: number): Promise<SelectionVersion> {
  return (await db.prepare('SELECT version, calculated_version FROM payroll_period_selection_versions WHERE period_id = ?').bind(periodId).first<SelectionVersion>()) ?? { version: 0, calculated_version: null };
}

export interface Readiness {
  selection: EffectiveSelection;
  evaluated: EvaluatedEmployee[];
  notReady: EvaluatedEmployee[];
  version: SelectionVersion;
}

export async function selectionReadiness(db: D1Database, p: SelPeriod): Promise<Readiness> {
  const selection = await effectiveSelection(db, p);
  const evaluated = await evaluateEmployees(db, p, selection.ids, selection);
  return { selection, evaluated, notReady: evaluated.filter((x) => !x.payable), version: await selectionVersion(db, p.id) };
}

export function notReadyError(notReady: readonly EvaluatedEmployee[]): HttpError {
  const review = notReady.filter((x) => x.eligibility.decision === 'review').length;
  const blocked = notReady.length - review;
  return new HttpError(
    409,
    'selection_not_ready',
    `มีพนักงานที่เลือกไว้ ${notReady.length} คนที่ยังคำนวณไม่ได้ (รอ HR ยืนยัน ${review} คน · ไม่มีสิทธิ์/ถูกระงับ ${blocked} คน): ต้องยืนยันหรือนำออกจากงวดก่อน`,
    {
      employees: notReady.slice(0, 100).map((x) => ({ emp_code: x.emp_code, status: x.eligibility.status, decision: x.eligibility.decision, reasons: x.eligibility.reasons, labels: x.eligibility.reasons.map((r) => ELIGIBILITY_REASON_LABEL[r]) })),
      total: notReady.length,
    },
  );
}

/**
 * Before a calculation: every selected employee must be payable. Returns the ids to give the engine (undefined while
 * the period keeps its standard list, so the engine runs its own unchanged selection) and what to record.
 */
export async function selectionForCalculation(db: D1Database, p: SelPeriod): Promise<Readiness & { engineIds: number[] | undefined }> {
  const r = await selectionReadiness(db, p);
  if (r.notReady.length) throw notReadyError(r.notReady);
  return { ...r, engineIds: r.selection.hasRows ? r.selection.ids : undefined };
}

/** Before approval: the selection did not change since the calculation, and every selected employee is still payable. */
export async function assertSelectionApprovable(db: D1Database, p: SelPeriod): Promise<void> {
  const r = await selectionReadiness(db, p);
  if (r.version.version > 0 && r.version.calculated_version !== r.version.version) {
    throw new HttpError(409, 'selection_changed_recalculate', 'รายชื่อพนักงานของงวดเปลี่ยนหลังการคำนวณ ต้องคำนวณงวดใหม่ก่อนอนุมัติ');
  }
  if (r.notReady.length) throw notReadyError(r.notReady);
}

/** Statements of a calculation batch: the selection read is still current; record the version and the result. */
export function selectionCalcStatements(db: D1Database, p: SelPeriod, calcVersion: number, r: Readiness, paidIds: ReadonlySet<number>, guardFailed: string): D1PreparedStatement[] {
  const deselected = [...r.selection.rows.values()].filter((x) => x.status === 'deselected' && !r.selection.origin.has(x.employee_id));
  const rows = [
    ...r.evaluated.map((x) => ({ e: x.employee_id, c: x.company_id, s: x.origin === 'added' ? 'added' : 'standard', el: x.eligibility.status, d: x.eligibility.decision, r: JSON.stringify(x.eligibility.reasons), k: x.confirmed ? 1 : 0, p: paidIds.has(x.employee_id) ? 1 : 0 })),
    ...deselected.map((x) => ({ e: x.employee_id, c: x.company_id, s: 'deselected', el: 'not_selected', d: 'not_selected', r: '[]', k: 0, p: 0 })),
  ];
  return [
    db.prepare(`SELECT CASE WHEN IFNULL((SELECT version FROM payroll_period_selection_versions WHERE period_id = ?1), 0) = ?2 THEN 1 ELSE json('${guardFailed}') END AS ok`).bind(p.id, r.version.version),
    db.prepare(
      `INSERT INTO payroll_period_selection_versions (period_id, version, calculated_version, calc_version) VALUES (?1, ?2, ?2, ?3)
       ON CONFLICT (period_id) DO UPDATE SET calculated_version = excluded.calculated_version, calc_version = excluded.calc_version, updated_at = datetime('now')`,
    ).bind(p.id, r.version.version, calcVersion),
    db.prepare(
      `INSERT INTO payroll_selection_results (period_id, calc_version, run_token, employee_id, company_id, selection, eligibility, decision, reasons_json, review_confirmed, calculated)
       SELECT ?1, ?2, ?4, json_extract(j.value, '$.e'), json_extract(j.value, '$.c'), json_extract(j.value, '$.s'), json_extract(j.value, '$.el'), json_extract(j.value, '$.d'),
              json_extract(j.value, '$.r'), json_extract(j.value, '$.k'), json_extract(j.value, '$.p')
       FROM json_each(?3) j`,
    ).bind(p.id, calcVersion, JSON.stringify(rows), crypto.randomUUID()),
  ];
}
