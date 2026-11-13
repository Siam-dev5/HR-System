import { describe, expect, it } from 'vitest';
import { contractsCover, evaluateEligibility, outsideReason, payable, reviewBasis, type ContractPeriod, type EligibilityEmployee } from '../../src/shared/payroll-eligibility';
import type { CompanyAssignment } from '../../src/shared/company-detection';

const P = { start_date: '2026-06-01', end_date: '2026-06-30', company_id: 1 };
const emp = (over: Partial<EligibilityEmployee> = {}): EligibilityEmployee => ({ id: 1, company_id: 1, status: 'active', hire_date: '2026-01-01', termination_date: null, base_salary: 30000, ...over });
const asg = (company_id = 1, from = '2026-01-01', to: string | null = null, over: Partial<CompanyAssignment> = {}): CompanyAssignment => ({ id: 1, employee_id: 1, company_id, effective_from: from, effective_to: to, status: 'verified', source: 'baseline', ...over });
const ev = (e: Partial<EligibilityEmployee> = {}, assignments: CompanyAssignment[] = [asg()], salaryHistory: Array<{ effective_date: string; base_salary: number }> = [], period = P) =>
  evaluateEligibility({ period, employee: emp(e), salaryHistory, assignments });

describe('evaluateEligibility — employment', () => {
  it('9. hired before the period: eligible for the whole period', () => {
    expect(ev()).toEqual({ status: 'eligible', decision: 'pay', reasons: [], notes: [], from: '2026-06-01', to: '2026-06-30' });
  });

  it('10. hired during the period: eligible, prorated from the hire date (existing proration)', () => {
    expect(ev({ hire_date: '2026-06-15' }, [asg(1, '2026-06-15')])).toEqual({ status: 'eligible_prorated', decision: 'pay', reasons: ['starts_in_period'], notes: [], from: '2026-06-15', to: '2026-06-30' });
  });

  it('11. terminated during the period: prorated to the termination date', () => {
    expect(ev({ status: 'resigned', termination_date: '2026-06-10' })).toMatchObject({ status: 'eligible_prorated', decision: 'pay', reasons: ['ends_in_period'], to: '2026-06-10' });
  });

  it('12. terminated before the period: not employed — selectable for review, never paid automatically', () => {
    const r = ev({ status: 'terminated', termination_date: '2026-05-31' });
    expect(r).toMatchObject({ status: 'not_employed', decision: 'block', reasons: ['terminated_before_period'], from: null });
    expect(payable(r, { review_confirmed: 1, review_basis: reviewBasis(r.reasons) })).toBe(false);
  });

  it('hired after the period: not employed', () => {
    expect(ev({ hire_date: '2026-07-01' })).toMatchObject({ status: 'not_employed', decision: 'block', reasons: ['hired_after_period'] });
  });

  it('13–14. a status payroll does not know (suspended / on_leave) needs HR review; confirmation pays only for the same reasons', () => {
    for (const status of ['suspended', 'on_leave']) {
      const r = ev({ status });
      expect(r).toMatchObject({ status: 'review_required', decision: 'review', reasons: ['unknown_status'] });
      expect(payable(r, null)).toBe(false);
      expect(payable(r, { review_confirmed: 1, review_basis: 'unknown_status' })).toBe(true);
      expect(payable(r, { review_confirmed: 1, review_basis: 'terminated_without_date' })).toBe(false);
    }
  });

  it('17–18. missing or inconsistent employment dates', () => {
    expect(ev({ hire_date: null })).toMatchObject({ status: 'employment_period_mismatch', decision: 'block', reasons: ['invalid_hire_date'] });
    expect(ev({ hire_date: '2026-02-30' })).toMatchObject({ status: 'employment_period_mismatch', decision: 'block' });
    expect(ev({ termination_date: '2025-12-31', status: 'terminated' })).toMatchObject({ status: 'employment_period_mismatch', decision: 'block', reasons: ['termination_before_hire'] });
    // resigned without an end date: the end is unknown — HR must review (never "eligible")
    expect(ev({ status: 'resigned', termination_date: null })).toMatchObject({ status: 'employment_period_mismatch', decision: 'review', reasons: ['terminated_without_date'] });
  });
});

describe('evaluateEligibility — salary', () => {
  it('16. no base salary blocks; a salary of 0 in force on a paid day blocks', () => {
    expect(ev({ base_salary: null })).toMatchObject({ status: 'missing_salary', decision: 'block', reasons: ['no_base_salary'] });
    expect(ev({ base_salary: 0 })).toMatchObject({ status: 'missing_salary', decision: 'block' });
    expect(ev({}, [asg()], [{ effective_date: '2026-06-10', base_salary: 0 }])).toMatchObject({ status: 'missing_salary', reasons: ['zero_salary_in_period'] });
    expect(ev({}, [asg()], [{ effective_date: '2026-05-01', base_salary: 0 }])).toMatchObject({ status: 'missing_salary', reasons: ['zero_salary_in_period'] });
  });

  it('salary history is not required: the base salary on the record stands (as in the engine)', () => {
    expect(ev({}, [asg()], [])).toMatchObject({ status: 'eligible' });
    expect(ev({}, [asg()], [{ effective_date: '2026-06-10', base_salary: 32000 }])).toMatchObject({ status: 'eligible' });
  });
});

describe('evaluateEligibility — company (P3)', () => {
  it('19. verified assignment of the period company: eligible', () => {
    expect(ev({}, [asg(1)]).decision).toBe('pay');
  });
  it('20. no assignment: company_unresolved (blocked)', () => {
    expect(ev({}, [])).toMatchObject({ status: 'company_unresolved', decision: 'block', reasons: ['no_assignment'] });
  });
  it('21. held for review / record differs: company_conflict (blocked, never overridable)', () => {
    const r = ev({}, [asg(1, '2026-01-01', null, { status: 'pending_review' })]);
    expect(r).toMatchObject({ status: 'company_conflict', decision: 'block', reasons: ['assignment_pending_review'] });
    expect(payable(r, { review_confirmed: 1, review_basis: reviewBasis(r.reasons) })).toBe(false);
  });
  it('22. a move during the period is never split', () => {
    expect(ev({}, [asg(2, '2026-01-01', '2026-06-14'), asg(1, '2026-06-15', null, { source: 'transfer' })])).toMatchObject({ status: 'company_conflict', reasons: ['transfer_in_period'] });
  });
  it('23–24. a historical assignment of another company: not paid by this period', () => {
    expect(ev({ company_id: 2 }, [asg(2)])).toMatchObject({ status: 'company_conflict', reasons: ['period_company_differs'] });
    expect(ev({}, [asg(2, '2026-01-01', '2026-05-31'), asg(1, '2026-06-01', null, { source: 'transfer' })]).decision).toBe('pay');
  });
  it('precedence: a block is reported before a review reason', () => {
    expect(ev({ status: 'suspended', base_salary: null })).toMatchObject({ status: 'missing_salary', decision: 'block' });
  });
});

describe('outsideReason', () => {
  it('explains why an employee is not on the standard list', () => {
    expect(outsideReason(P, emp({ hire_date: '2026-07-02' }))).toBe('newly_hired');
    expect(outsideReason(P, emp({ status: 'resigned', termination_date: '2026-05-31' }))).toBe('resigned_terminated');
    expect(outsideReason(P, emp({ status: 'terminated', termination_date: '2024-01-31' }))).toBe('historical');
    expect(outsideReason(P, emp({ status: 'resigned', termination_date: null }))).toBe('resigned_terminated');
    expect(outsideReason(P, emp({ status: 'suspended' }))).toBe('status_other');
    expect(outsideReason(P, emp({ base_salary: null }))).toBe('no_salary');
    expect(outsideReason(P, emp({ company_id: 2 }))).toBe('transferred');
  });
});

describe('contract employees (P5)', () => {
  const ct = (start_date: string, end_date: string | null, status: ContractPeriod['status'] = 'active'): ContractPeriod => ({ start_date, end_date, status });
  const evc = (contracts: ContractPeriod[], over: Partial<EligibilityEmployee> = {}) =>
    evaluateEligibility({ period: P, employee: emp({ employment_type: 'contract', ...over }), salaryHistory: [], assignments: [asg()], contracts });

  it('a contract covering the whole period: eligible, no note (same as a regular employee)', () => {
    expect(evc([ct('2026-01-01', '2026-12-31')])).toEqual({ status: 'eligible', decision: 'pay', reasons: [], notes: [], from: '2026-06-01', to: '2026-06-30' });
    expect(evc([ct('2026-01-01', null)]).decision).toBe('pay');
  });

  it('no recorded contract: paid as before, with a note (never a block)', () => {
    expect(evc([])).toMatchObject({ status: 'eligible', decision: 'pay', notes: ['contract_unrecorded'] });
    expect(evc([ct('2026-01-01', '2026-12-31', 'cancelled')])).toMatchObject({ decision: 'pay', notes: ['contract_unrecorded'] });
  });

  it('a contract that ends, starts or has a gap inside the paid days: review (HR sets the end, renews or confirms)', () => {
    expect(evc([ct('2026-01-01', '2026-06-15')])).toMatchObject({ status: 'review_required', decision: 'review', reasons: ['contract_not_covering'] });
    expect(evc([ct('2026-06-10', null)])).toMatchObject({ decision: 'review', reasons: ['contract_not_covering'] });
    expect(evc([ct('2026-01-01', '2026-06-09'), ct('2026-06-11', null)])).toMatchObject({ decision: 'review', reasons: ['contract_not_covering'] });
    // consecutive contracts are continuous
    expect(evc([ct('2026-01-01', '2026-06-10'), ct('2026-06-11', null)]).decision).toBe('pay');
  });

  it('a termination date inside the contract makes the paid days end there (existing proration), no review', () => {
    expect(evc([ct('2026-01-01', '2026-06-15')], { status: 'resigned', termination_date: '2026-06-15' })).toMatchObject({ status: 'eligible_prorated', decision: 'pay', reasons: ['ends_in_period'], to: '2026-06-15' });
  });

  it('a confirmation covers exactly the contract reason; blocks still come first', () => {
    const r = evc([ct('2026-01-01', '2026-06-15')]);
    expect(payable(r, { review_confirmed: 1, review_basis: 'contract_not_covering' })).toBe(true);
    expect(evc([ct('2026-01-01', '2026-06-15')], { base_salary: null })).toMatchObject({ status: 'missing_salary', decision: 'block' });
  });

  it('contracts only matter for contract employees', () => {
    expect(evaluateEligibility({ period: P, employee: emp({ employment_type: 'permanent' }), salaryHistory: [], assignments: [asg()], contracts: [ct('2026-01-01', '2026-06-15')] })).toMatchObject({ decision: 'pay', notes: [] });
  });

  it('contractsCover', () => {
    expect(contractsCover([ct('2026-06-01', '2026-06-30')], '2026-06-01', '2026-06-30')).toBe(true);
    expect(contractsCover([], '2026-06-01', '2026-06-30')).toBe(false);
    expect(contractsCover([ct('2025-01-01', '2025-12-31'), ct('2026-06-01', null)], '2026-06-01', '2026-06-30')).toBe(true);
  });
});
