// Attendance exemption periods of an employee: exempt from recording time from effective_from to effective_to (no end
// when empty) unless revoked. An exemption only changes what an attendance import warns about; it never changes
// leave, OT, payroll or employee / company validation.

export interface ExemptionPeriod {
  effective_from: string;
  effective_to: string | null;
  revoked_at?: string | null;
}
export type ExemptionState = 'active' | 'future' | 'expired' | 'revoked';
export const EXEMPTION_STATE_LABEL: Record<ExemptionState, string> = { active: 'มีผลอยู่', future: 'ยังไม่ถึงวันเริ่ม', expired: 'สิ้นสุดแล้ว', revoked: 'ยกเลิกแล้ว' };

export function exemptionState(p: ExemptionPeriod, today: string): ExemptionState {
  if (p.revoked_at) return 'revoked';
  if (p.effective_from > today) return 'future';
  if (p.effective_to && p.effective_to < today) return 'expired';
  return 'active';
}

/** Whether a period (not revoked) covers the date. */
export const coversDate = (p: ExemptionPeriod, date: string): boolean => !p.revoked_at && p.effective_from <= date && (!p.effective_to || p.effective_to >= date);

/** Whether two periods share at least one day (open ends count as unbounded). */
export function overlaps(a: ExemptionPeriod, b: ExemptionPeriod): boolean {
  const aEnd = a.effective_to ?? '9999-12-31';
  const bEnd = b.effective_to ?? '9999-12-31';
  return a.effective_from <= bEnd && b.effective_from <= aEnd;
}

/** Import warnings that only say a punch is missing: an exempt employee does not get them for an exempt day. */
export const MISSING_PUNCH_CODES: ReadonlySet<string> = new Set(['no_record_in', 'no_record_out', 'missing_clock_in', 'missing_clock_out', 'pending_out']);

/**
 * Issues of an import row for an exempt day: the missing-punch warnings are dropped and an information line is added.
 * Errors (employee, company, dates) and every other issue are kept; punches are processed as usual.
 */
export function exemptIssues<T extends { code: string; level: string; message: string }>(issues: readonly T[], info: (removed: number) => T): T[] {
  const kept = issues.filter((i) => !MISSING_PUNCH_CODES.has(i.code));
  return [...kept, info(issues.length - kept.length)];
}
