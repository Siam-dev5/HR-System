// Company detection (P3): which company an employee belongs to on a date, and whether a payroll period may pay them.
// Pure functions: the worker loads mappings and assignments from D1 (lib/company-detection.ts).
//
// Order (first match wins):
//   1. the employee's verified company assignment covering the date (a dated, reasoned record — never overwritten by
//      a mapping); an assignment held for review is a conflict until HR verifies it
//   2. without an assignment: the active employee-code prefix mapping effective on the date with the highest priority;
//      two matching mappings of the same priority for different companies are a conflict
//   3. nothing matches: unresolved — an unknown prefix never defaults to any company
// A mapping is configuration HR maintains (no prefix is known to the code); it only ever suggests a company for an
// employee without an assignment, and changing it never changes an existing assignment.

export interface CodeMapping {
  id: number;
  company_id: number;
  prefix: string;
  priority: number;
  status: 'active' | 'inactive';
  effective_from: string;
  effective_to: string | null;
}

export interface CompanyAssignment {
  id: number;
  employee_id: number;
  company_id: number;
  effective_from: string;
  effective_to: string | null;
  status: 'verified' | 'pending_review' | 'cancelled';
  source: 'baseline' | 'employee_record' | 'transfer';
}

export type DetectionStatus = 'assigned' | 'mapped' | 'company_unresolved' | 'company_conflict';
export type DetectionError = 'empty_code' | 'no_mapping' | 'inactive_mapping' | 'mapping_conflict' | 'assignment_pending_review';

export interface Detection {
  status: DetectionStatus;
  companyId: number | null;
  /** the mapping that decided (status 'mapped'), or that the mapping step would choose (information when assigned) */
  mappingId: number | null;
  assignmentId: number | null;
  source: 'assignment' | 'mapping' | null;
  error: DetectionError | null;
  /** what the mappings alone say (null: unresolved or conflict) — compared with the assignment for HR review */
  mappingCompanyId: number | null;
}

export const DETECTION_LABEL: Record<DetectionError, string> = {
  empty_code: 'ไม่มีรหัสพนักงาน',
  no_mapping: 'ไม่พบการจับคู่รหัสพนักงานกับบริษัท (ต้องให้ HR กำหนดบริษัท)',
  inactive_mapping: 'การจับคู่รหัสพนักงานที่ตรงกันถูกปิดใช้งานหรือหมดอายุแล้ว (ต้องให้ HR กำหนดบริษัท)',
  mapping_conflict: 'รหัสพนักงานตรงกับการจับคู่ของหลายบริษัทที่มีลำดับความสำคัญเท่ากัน',
  assignment_pending_review: 'บริษัทของพนักงานรอ HR ยืนยัน',
};

/** Employee codes compare without case and without surrounding spaces. */
export const normalizeCode = (code: string | null | undefined): string => String(code ?? '').trim().toUpperCase();

/** A mapping prefix: 1–10 upper-case letters or digits. */
export const PREFIX_RE = /^[A-Z0-9]{1,10}$/;

export const coversDate = (x: { effective_from: string; effective_to: string | null }, d: string): boolean => x.effective_from <= d && (x.effective_to === null || x.effective_to >= d);

export interface MappingMatch {
  winner: CodeMapping | null;
  conflict: CodeMapping[];
  /** the code matches only mappings that are inactive or not effective on the date */
  inactiveOnly: boolean;
}

/** The mapping that applies to a code on a date: highest priority among active, effective, matching mappings. */
export function matchMapping(code: string, date: string, mappings: readonly CodeMapping[]): MappingMatch {
  const k = normalizeCode(code);
  const matching = k ? mappings.filter((m) => k.startsWith(m.prefix)) : [];
  const live = matching.filter((m) => m.status === 'active' && coversDate(m, date));
  if (!live.length) return { winner: null, conflict: [], inactiveOnly: matching.length > 0 };
  const top = Math.max(...live.map((m) => m.priority));
  const best = live.filter((m) => m.priority === top).sort((a, b) => a.id - b.id);
  if (new Set(best.map((m) => m.company_id)).size > 1) return { winner: null, conflict: best, inactiveOnly: false };
  return { winner: best[0]!, conflict: [], inactiveOnly: false };
}

export interface DetectInput {
  code: string | null;
  date: string;
  mappings: readonly CodeMapping[];
  /** the employee's assignments (any status); empty for a code without an employee */
  assignments: readonly CompanyAssignment[];
}

export function detectCompany(input: DetectInput): Detection {
  const m = matchMapping(input.code ?? '', input.date, input.mappings);
  const mappingCompanyId = m.winner?.company_id ?? null;
  const a = input.assignments.find((x) => x.status !== 'cancelled' && coversDate(x, input.date));
  if (a) {
    if (a.status === 'pending_review') return { status: 'company_conflict', companyId: null, mappingId: m.winner?.id ?? null, assignmentId: a.id, source: 'assignment', error: 'assignment_pending_review', mappingCompanyId };
    return { status: 'assigned', companyId: a.company_id, mappingId: m.winner?.id ?? null, assignmentId: a.id, source: 'assignment', error: null, mappingCompanyId };
  }
  if (!normalizeCode(input.code)) return { status: 'company_unresolved', companyId: null, mappingId: null, assignmentId: null, source: null, error: 'empty_code', mappingCompanyId: null };
  if (m.conflict.length) return { status: 'company_conflict', companyId: null, mappingId: null, assignmentId: null, source: 'mapping', error: 'mapping_conflict', mappingCompanyId: null };
  if (m.winner) return { status: 'mapped', companyId: m.winner.company_id, mappingId: m.winner.id, assignmentId: null, source: 'mapping', error: null, mappingCompanyId };
  return { status: 'company_unresolved', companyId: null, mappingId: null, assignmentId: null, source: null, error: m.inactiveOnly ? 'inactive_mapping' : 'no_mapping', mappingCompanyId: null };
}

// ---- Existing data (dry run) -------------------------------------------------------------------------------------

export type Classification = 'already_assigned' | 'assigned_mapping_differs' | 'mapping_matched' | 'unresolved' | 'conflict' | 'inactive_mapping';

export interface ClassifiedEmployee {
  employee_id: number;
  emp_code: string;
  record_company_id: number;
  classification: Classification;
  detection: Detection;
  /** the employee has been in more than one company (history of transfers) */
  historicalTransfer: boolean;
}

/** How an existing employee stands on a date (read-only; nothing is assigned or changed). */
export function classifyEmployee(e: { id: number; emp_code: string; company_id: number }, date: string, mappings: readonly CodeMapping[], assignments: readonly CompanyAssignment[]): ClassifiedEmployee {
  const mine = assignments.filter((a) => a.employee_id === e.id);
  const d = detectCompany({ code: e.emp_code, date, mappings, assignments: mine });
  let classification: Classification;
  if (d.status === 'assigned') classification = d.mappingCompanyId !== null && d.mappingCompanyId !== d.companyId ? 'assigned_mapping_differs' : 'already_assigned';
  else if (d.status === 'mapped') classification = 'mapping_matched';
  else if (d.status === 'company_conflict') classification = 'conflict';
  else classification = d.error === 'inactive_mapping' ? 'inactive_mapping' : 'unresolved';
  const companies = new Set(mine.filter((a) => a.status !== 'cancelled').map((a) => a.company_id));
  return { employee_id: e.id, emp_code: e.emp_code, record_company_id: e.company_id, classification, detection: d, historicalTransfer: companies.size > 1 };
}

// ---- Payroll ----------------------------------------------------------------------------------------------------

export type PayrollCompanyError = 'company_unresolved' | 'company_conflict' | 'company_transfer_in_period';
export type PayrollCompanyReason = 'no_assignment' | 'assignment_gap' | 'assignment_pending_review' | 'record_differs' | 'period_company_differs' | 'transfer_in_period' | 'payslip_company_differs' | 'moved_out';

export interface PayrollCompanyCheck {
  ok: boolean;
  error: PayrollCompanyError | null;
  reason: PayrollCompanyReason | null;
  companyId: number | null;
}

export const PAYROLL_COMPANY_LABEL: Record<PayrollCompanyReason, string> = {
  no_assignment: 'ไม่มีการกำหนดบริษัทของพนักงานในช่วงงวด',
  assignment_gap: 'การกำหนดบริษัทของพนักงานไม่ครอบคลุมทุกวันที่จ่ายในงวด',
  assignment_pending_review: 'บริษัทของพนักงานรอ HR ยืนยัน',
  record_differs: 'บริษัทในทะเบียนพนักงานไม่ตรงกับการกำหนดบริษัท',
  period_company_differs: 'พนักงานไม่ได้อยู่ในบริษัทของงวดเงินเดือนนี้',
  transfer_in_period: 'พนักงานย้ายบริษัทระหว่างงวด (ระบบยังไม่แบ่งจ่ายตามบริษัท)',
  payslip_company_differs: 'สลิปเงินเดือนที่คำนวณไว้เป็นของบริษัทอื่น (พนักงานย้ายบริษัทหลังการคำนวณ) ต้องคำนวณใหม่',
  moved_out: 'พนักงานอยู่ในบริษัทนี้ช่วงงวดนี้แต่ย้ายไปบริษัทอื่นแล้ว (ระบบคำนวณงวดย้อนหลังของบริษัทเดิมให้ไม่ได้ ต้องอนุมัติงวดก่อนย้าย)',
};

const DAY = 86_400_000;
const next = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + DAY).toISOString().slice(0, 10);

/**
 * Whether a period may pay an employee for [from, to] (the employment inside the period): one company, verified for
 * every day, equal to the employee record's company and to the period's company (when the period has one). The
 * first assignment of an employee (baseline / employee record) covers the employment from the hire date.
 */
export function payrollCompanyCheck(period: { company_id: number | null }, e: { id: number; company_id: number; hire_date: string }, from: string, to: string, assignments: readonly CompanyAssignment[]): PayrollCompanyCheck {
  const fail = (error: PayrollCompanyError, reason: PayrollCompanyReason, companyId: number | null = null): PayrollCompanyCheck => ({ ok: false, error, reason, companyId });
  const mine = assignments
    .filter((a) => a.employee_id === e.id && a.status !== 'cancelled')
    .sort((a, b) => a.effective_from.localeCompare(b.effective_from))
    .map((a, i) => (i === 0 && a.source !== 'transfer' && e.hire_date < a.effective_from ? { ...a, effective_from: e.hire_date } : a));
  const inRange = mine.filter((a) => a.effective_from <= to && (a.effective_to === null || a.effective_to >= from));
  if (!inRange.length) return fail('company_unresolved', 'no_assignment');
  if (new Set(inRange.map((a) => a.company_id)).size > 1) return fail('company_transfer_in_period', 'transfer_in_period');
  if (inRange.some((a) => a.status === 'pending_review')) return fail('company_conflict', 'assignment_pending_review', inRange[0]!.company_id);
  // continuous cover of every paid day
  let day = from;
  for (const a of inRange) {
    if (a.effective_from > day) return fail('company_unresolved', 'assignment_gap');
    if (a.effective_to === null || a.effective_to >= to) {
      day = '9999-12-31';
      break;
    }
    day = next(a.effective_to);
  }
  if (day <= to) return fail('company_unresolved', 'assignment_gap');
  const companyId = inRange[0]!.company_id;
  if (companyId !== e.company_id) return fail('company_conflict', 'record_differs', companyId);
  if (period.company_id !== null && companyId !== period.company_id) return fail('company_conflict', 'period_company_differs', companyId);
  return { ok: true, error: null, reason: null, companyId };
}
