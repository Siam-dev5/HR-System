import { describe, expect, it } from 'vitest';
import { classifyEmployee, detectCompany, matchMapping, normalizeCode, payrollCompanyCheck, PREFIX_RE, type CodeMapping, type CompanyAssignment } from '../../src/shared/company-detection';

// Companies 1, 2, 3 are synthetic ids: which real company a prefix belongs to is configuration, never code.
const map = (id: number, company_id: number, prefix: string, over: Partial<CodeMapping> = {}): CodeMapping => ({ id, company_id, prefix, priority: 100, status: 'active', effective_from: '2026-01-01', effective_to: null, ...over });
const MAPS = [map(1, 1, 'ST'), map(2, 2, 'DP'), map(3, 3, 'FF')];
const asg = (id: number, employee_id: number, company_id: number, from: string, to: string | null = null, over: Partial<CompanyAssignment> = {}): CompanyAssignment => ({ id, employee_id, company_id, effective_from: from, effective_to: to, status: 'verified', source: 'baseline', ...over });
const detect = (code: string | null, date = '2026-06-15', mappings = MAPS, assignments: CompanyAssignment[] = []) => detectCompany({ code, date, mappings, assignments });

describe('matchMapping / detectCompany — mappings (no assignment)', () => {
  it('1–3. ST, DP and FF prefixes each map to the company HR configured', () => {
    expect(detect('ST0001')).toMatchObject({ status: 'mapped', companyId: 1, mappingId: 1, source: 'mapping', error: null });
    expect(detect('dp017')).toMatchObject({ status: 'mapped', companyId: 2, mappingId: 2 });
    expect(detect(' FF4 ')).toMatchObject({ status: 'mapped', companyId: 3, mappingId: 3 });
  });

  it('4. an unknown prefix is unresolved and never defaults to a company', () => {
    expect(detect('XX001')).toEqual({ status: 'company_unresolved', companyId: null, mappingId: null, assignmentId: null, source: null, error: 'no_mapping', mappingCompanyId: null });
    expect(detect('001')).toMatchObject({ status: 'company_unresolved', companyId: null });
  });

  it('5. an empty code is unresolved', () => {
    expect(detect('')).toMatchObject({ status: 'company_unresolved', error: 'empty_code', companyId: null });
    expect(detect(null)).toMatchObject({ status: 'company_unresolved', error: 'empty_code' });
    expect(detect('   ')).toMatchObject({ error: 'empty_code' });
  });

  it('6. an inactive mapping is never used (and is reported as such)', () => {
    expect(detect('ST01', '2026-06-15', [map(1, 1, 'ST', { status: 'inactive' })])).toMatchObject({ status: 'company_unresolved', error: 'inactive_mapping', companyId: null });
  });

  it('7–8. effective from / to: a mapping applies only inside its dates', () => {
    const m = [map(1, 1, 'ST', { effective_from: '2026-03-01', effective_to: '2026-06-30' })];
    expect(detect('ST01', '2026-02-28', m)).toMatchObject({ status: 'company_unresolved', error: 'inactive_mapping' });
    expect(detect('ST01', '2026-03-01', m)).toMatchObject({ status: 'mapped', companyId: 1 });
    expect(detect('ST01', '2026-06-30', m)).toMatchObject({ status: 'mapped', companyId: 1 });
    expect(detect('ST01', '2026-07-01', m)).toMatchObject({ status: 'company_unresolved' });
  });

  it('9–10. a future change of mapping: consecutive periods of one prefix pick the company of the date', () => {
    const m = [map(1, 1, 'ST', { effective_to: '2026-06-30' }), map(4, 2, 'ST', { effective_from: '2026-07-01' })];
    expect(detect('ST01', '2026-06-30', m)).toMatchObject({ companyId: 1, mappingId: 1 });
    expect(detect('ST01', '2026-07-01', m)).toMatchObject({ companyId: 2, mappingId: 4 });
  });

  it('11. several companies: the highest priority decides between a short and a long prefix', () => {
    const m = [map(1, 1, 'S', { priority: 10 }), map(2, 2, 'ST', { priority: 20 })];
    expect(detect('ST01', '2026-06-15', m)).toMatchObject({ status: 'mapped', companyId: 2, mappingId: 2 });
    expect(detect('SX01', '2026-06-15', m)).toMatchObject({ status: 'mapped', companyId: 1, mappingId: 1 });
  });

  it('12. equal priority for different companies is a conflict, never a guess', () => {
    const m = [map(1, 1, 'S'), map(2, 2, 'ST')];
    expect(detect('ST01', '2026-06-15', m)).toMatchObject({ status: 'company_conflict', error: 'mapping_conflict', companyId: null });
    expect(matchMapping('ST01', '2026-06-15', m).conflict.map((x) => x.id)).toEqual([1, 2]);
    // the same company twice is not a conflict
    expect(detect('ST01', '2026-06-15', [map(1, 1, 'S'), map(2, 1, 'ST')])).toMatchObject({ status: 'mapped', companyId: 1, mappingId: 1 });
  });

  it('prefix format and code normalisation', () => {
    expect(['ST', 'A', 'AB12', 'ABCDEFGHIJ'].every((p) => PREFIX_RE.test(p))).toBe(true);
    expect(['', 'st', 'A-B', 'ABCDEFGHIJK', 'ก'].some((p) => PREFIX_RE.test(p))).toBe(false);
    expect(normalizeCode('  st001 ')).toBe('ST001');
  });
});

describe('detectCompany — assignments first', () => {
  it('13. a verified assignment wins over a mapping that points elsewhere (the mapping is only reported)', () => {
    const d = detect('ST0099', '2026-06-15', MAPS, [asg(7, 1, 2, '2026-01-01')]);
    expect(d).toMatchObject({ status: 'assigned', companyId: 2, assignmentId: 7, source: 'assignment', error: null, mappingCompanyId: 1, mappingId: 1 });
  });

  it('14. a new employee without an assignment: detection only suggests from the mapping (or stays unresolved)', () => {
    expect(detect('DP900', '2026-06-15', MAPS, [])).toMatchObject({ status: 'mapped', assignmentId: null, companyId: 2 });
    expect(detect('ZZ900', '2026-06-15', MAPS, [])).toMatchObject({ status: 'company_unresolved' });
  });

  it('15–16. a transfer: the assignment of the date decides (history kept); a held assignment is a conflict', () => {
    const history = [asg(1, 1, 1, '2026-01-01', '2026-05-31'), asg(2, 1, 2, '2026-06-01', null, { source: 'transfer' })];
    expect(detect('ST1', '2026-05-31', MAPS, history)).toMatchObject({ companyId: 1, assignmentId: 1 });
    expect(detect('ST1', '2026-06-01', MAPS, history)).toMatchObject({ companyId: 2, assignmentId: 2 });
    expect(detect('ST1', '2026-06-01', MAPS, [asg(3, 1, 2, '2026-01-01', null, { status: 'pending_review' })])).toMatchObject({ status: 'company_conflict', error: 'assignment_pending_review', companyId: null });
    // a cancelled assignment is ignored
    expect(detect('ST1', '2026-06-01', MAPS, [asg(4, 1, 2, '2026-01-01', null, { status: 'cancelled' })])).toMatchObject({ status: 'mapped', companyId: 1 });
  });
});

describe('classifyEmployee (dry run)', () => {
  const e = (id: number, code: string, company: number) => ({ id, emp_code: code, company_id: company });
  it('classifies without changing anything: assigned, assigned-but-mapping-differs, mapped, unresolved, conflict, inactive, transfers', () => {
    const maps = [...MAPS, map(9, 1, 'X'), map(10, 2, 'XY'), map(11, 3, 'OLD', { status: 'inactive' })];
    const assignments = [asg(1, 1, 1, '2026-01-01'), asg(2, 2, 2, '2026-01-01'), asg(3, 7, 1, '2026-01-01', '2026-03-31'), asg(4, 7, 2, '2026-04-01', null, { source: 'transfer' })];
    const rows = [e(1, 'ST1', 1), e(2, 'ST2', 2), e(3, 'DP3', 2), e(4, 'QQ4', 1), e(5, 'XY5', 1), e(6, 'OLD6', 3), e(7, 'DP7', 2)].map((x) => classifyEmployee(x, '2026-06-15', maps, assignments));
    expect(rows.map((r) => `${r.emp_code}:${r.classification}${r.historicalTransfer ? ':moved' : ''}`)).toEqual([
      'ST1:already_assigned', 'ST2:assigned_mapping_differs', 'DP3:mapping_matched', 'QQ4:unresolved', 'XY5:conflict', 'OLD6:inactive_mapping', 'DP7:already_assigned:moved',
    ]);
  });
});

describe('payrollCompanyCheck', () => {
  const emp = { id: 1, company_id: 1, hire_date: '2026-01-01' };
  const june = (company_id: number | null = 1) => ({ company_id });
  it('23. one verified assignment of the period company for the whole paid range: ok', () => {
    expect(payrollCompanyCheck(june(), emp, '2026-06-01', '2026-06-30', [asg(1, 1, 1, '2026-01-01')])).toEqual({ ok: true, error: null, reason: null, companyId: 1 });
    // an all-company period: the assignment must still match the employee record
    expect(payrollCompanyCheck(june(null), emp, '2026-06-01', '2026-06-30', [asg(1, 1, 1, '2026-01-01')]).ok).toBe(true);
  });

  it('24. unresolved: no assignment, or a gap inside the paid range', () => {
    expect(payrollCompanyCheck(june(), emp, '2026-06-01', '2026-06-30', [])).toMatchObject({ ok: false, error: 'company_unresolved', reason: 'no_assignment' });
    expect(payrollCompanyCheck(june(), emp, '2026-06-01', '2026-06-30', [asg(1, 1, 1, '2026-01-01', '2026-06-10', { source: 'transfer' })])).toMatchObject({ error: 'company_unresolved', reason: 'assignment_gap' });
  });

  it('25. conflict: held for review, record differs, or another company than the period', () => {
    expect(payrollCompanyCheck(june(), emp, '2026-06-01', '2026-06-30', [asg(1, 1, 1, '2026-01-01', null, { status: 'pending_review' })])).toMatchObject({ error: 'company_conflict', reason: 'assignment_pending_review' });
    expect(payrollCompanyCheck(june(), emp, '2026-06-01', '2026-06-30', [asg(1, 1, 2, '2026-01-01')])).toMatchObject({ error: 'company_conflict', reason: 'record_differs' });
    expect(payrollCompanyCheck(june(2), emp, '2026-06-01', '2026-06-30', [asg(1, 1, 1, '2026-01-01')])).toMatchObject({ error: 'company_conflict', reason: 'period_company_differs' });
  });

  it('26. a move inside the period is refused (no pay is split between companies)', () => {
    const moved = [asg(1, 1, 2, '2026-01-01', '2026-06-14'), asg(2, 1, 1, '2026-06-15', null, { source: 'transfer' })];
    expect(payrollCompanyCheck(june(), emp, '2026-06-01', '2026-06-30', moved)).toMatchObject({ ok: false, error: 'company_transfer_in_period', reason: 'transfer_in_period' });
    // a move on the first day of the period is clean for the new company
    const clean = [asg(1, 1, 2, '2026-01-01', '2026-05-31'), asg(2, 1, 1, '2026-06-01', null, { source: 'transfer' })];
    expect(payrollCompanyCheck(june(), emp, '2026-06-01', '2026-06-30', clean).ok).toBe(true);
  });

  it('the first (baseline / record) assignment covers the employment from the hire date, a transfer does not', () => {
    const e2 = { id: 1, company_id: 1, hire_date: '2026-01-01' };
    expect(payrollCompanyCheck(june(), e2, '2026-01-01', '2026-01-31', [asg(1, 1, 1, '2026-01-15')]).ok).toBe(true);
    expect(payrollCompanyCheck(june(), e2, '2026-01-01', '2026-01-31', [asg(1, 1, 1, '2026-01-15', null, { source: 'transfer' })])).toMatchObject({ reason: 'assignment_gap' });
  });
});
