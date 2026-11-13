import { describe, expect, it } from 'vitest';
import {
  aggregateDaily, aggregateTotals, judgedThrough, payDifferences, todayFor, validateDaily, validationHolds, versionPayload,
  type DailyInput, type DailyLeave, type DailyRecord, type EmployeeAggregate,
} from '../../src/shared/attendance-daily';

// March 2027: Mon 1 … Sun 7, Mon 8 … Sun 14; weekly rest Sat/Sun (6, 0). Employee 1 of company 10.
const base = (over: Partial<DailyInput> = {}): DailyInput => ({
  periodStart: '2027-03-01',
  periodEnd: '2027-03-07',
  today: '2027-12-31',
  employees: [{ id: 1, company_id: 10, hire_date: '2026-01-01', termination_date: null }],
  schedule: new Map(),
  calendars: new Map([[10, { weeklyRest: [0, 6], holidays: new Set<string>() }]]),
  records: [],
  leaves: [],
  exemptions: [],
  overtime: [],
  confirmed: new Set(),
  ...over,
});
let seq = 0;
const rec = (d: string, over: Partial<DailyRecord> = {}): DailyRecord => ({
  id: ++seq, employee_id: 1, work_date: d, status: 'present', clock_in: '09:00', clock_out: '18:00', clock_out_next_day: 0, shift_id: null,
  late_minutes: 0, early_leave_minutes: 0, worked_minutes: 480, revision: 0, ...over,
});
const leave = (id: number, from: string, to: string, status: DailyLeave['status'], paid: boolean | null, source: DailyLeave['source'] = 'request'): DailyLeave => ({ source, id, employee_id: 1, start_date: from, end_date: to, status, paid });
const week = ['2027-03-01', '2027-03-02', '2027-03-03', '2027-03-04', '2027-03-05'];
const run = (input: DailyInput) => {
  const v = validateDaily(input);
  return { v, a: aggregateDaily(input, v)[0] as EmployeeAggregate };
};
const codes = (input: DailyInput) => validateDaily(input).records.map((x) => `${x.record.work_date}:${x.status}:${x.issues.map((i) => i.code).join('+')}`);

describe('validateDaily — record rules', () => {
  it('1. a complete record on a workday is valid and counted', () => {
    const { v } = run(base({ records: [rec('2027-03-01')] }));
    expect(v.records[0]).toMatchObject({ status: 'valid', counted: true, issues: [] });
    expect(v.counts).toEqual({ valid: 1, warning: 0, pending_review: 0, invalid: 0 });
  });

  it('2. duplicates cannot exist per employee and day (unique index); two employees on one day are separate', () => {
    const input = base({
      employees: [{ id: 1, company_id: 10, hire_date: '2026-01-01', termination_date: null }, { id: 2, company_id: 10, hire_date: '2026-01-01', termination_date: null }],
      records: [rec('2027-03-01'), rec('2027-03-01', { employee_id: 2 })],
    });
    expect(validateDaily(input).records.map((x) => [x.record.employee_id, x.status])).toEqual([[1, 'valid'], [2, 'valid']]);
  });

  it('3. missing clock-in (present without a time, or a clock-out alone) waits for HR review', () => {
    expect(codes(base({ records: [rec('2027-03-01', { clock_in: null })] }))).toEqual(['2027-03-01:pending_review:missing_clock_in']);
    expect(codes(base({ records: [rec('2027-03-02', { clock_in: null, status: 'absent' })] }))).toEqual(['2027-03-02:pending_review:missing_clock_in+status_conflict']);
  });

  it('4. missing clock-out of a past day waits for review; today is still open', () => {
    expect(codes(base({ records: [rec('2027-03-01', { clock_out: null })] }))).toEqual(['2027-03-01:pending_review:missing_clock_out']);
    expect(codes(base({ today: '2027-03-01', records: [rec('2027-03-01', { clock_out: null })] }))).toEqual(['2027-03-01:valid:']);
  });

  it('5. invalid time range: clock-out not after clock-in without the next-day flag; the flag makes it valid', () => {
    expect(codes(base({ records: [rec('2027-03-01', { clock_in: '18:00', clock_out: '09:00' })] }))).toEqual(['2027-03-01:invalid:out_before_in']);
    expect(codes(base({ records: [rec('2027-03-01', { clock_in: '22:00', clock_out: '06:00', clock_out_next_day: 1 })] }))).toEqual(['2027-03-01:valid:']);
  });

  it('6–7. late and early leave are valid and summed (minutes as checked against the shift)', () => {
    const { v, a } = run(base({ records: [rec('2027-03-01', { status: 'late', clock_in: '09:20', late_minutes: 20 }), rec('2027-03-02', { early_leave_minutes: 45, clock_out: '17:15' })] }));
    expect(v.records.map((x) => x.status)).toEqual(['valid', 'valid']);
    expect(a).toMatchObject({ presentDays: 2, lateDays: 1, lateMinutes: 20, earlyLeaveMinutes: 45 });
  });

  it('8. absent: an explicit absent row and a missing workday both count; the missing one is also "missing"', () => {
    const { a } = run(base({ records: [rec('2027-03-01', { status: 'absent', clock_in: null, clock_out: null }), ...week.slice(2).map((d) => rec(d))] }));
    expect(a).toMatchObject({ judgedWorkDays: 5, presentDays: 3, absentDays: 2, missingAttendanceDays: 1 });
  });

  it('9–10. holiday and weekly rest: not workdays; work on them is a warning and counted as holiday / rest-day work', () => {
    const input = base({
      calendars: new Map([[10, { weeklyRest: [0, 6], holidays: new Set(['2027-03-03']) }]]),
      records: [...week.filter((d) => d !== '2027-03-03').map((d) => rec(d)), rec('2027-03-03'), rec('2027-03-06')],
    });
    const { v, a } = run(input);
    expect(v.records.filter((x) => x.status === 'warning').map((x) => `${x.record.work_date}:${x.issues[0]!.code}`)).toEqual(['2027-03-03:non_workday', '2027-03-06:non_workday']);
    expect(a).toMatchObject({ scheduledWorkDays: 4, presentDays: 4, actualWorkDays: 6, holidayWorkDays: 1, restDayWorkDays: 1, absentDays: 0 });
  });

  it('11. approved leave is not absent: paid / unpaid by leave type, unknown type (Feishu) unclassified', () => {
    const { a } = run(base({
      records: [rec('2027-03-01'), rec('2027-03-05')],
      leaves: [leave(1, '2027-03-02', '2027-03-02', 'approved', true), leave(2, '2027-03-03', '2027-03-03', 'approved', false), leave(3, '2027-03-04', '2027-03-04', 'approved', null, 'import')],
    }));
    expect(a).toMatchObject({ paidLeaveDays: 1, unpaidLeaveDays: 1, unclassifiedLeaveDays: 1, absentDays: 0, presentDays: 2 });
  });

  it('12. pending leave is counted apart (neither absent nor leave); rejected leave leaves the day absent', () => {
    const { a } = run(base({
      records: week.slice(2).map((d) => rec(d)),
      leaves: [leave(1, '2027-03-01', '2027-03-01', 'pending', true), leave(2, '2027-03-02', '2027-03-02', 'rejected', true)],
    }));
    expect(a).toMatchObject({ pendingLeaveDays: 1, absentDays: 1, paidLeaveDays: 0 });
  });

  it('13. exemption: exempt workdays are neither absent nor present, records on them carry an info issue', () => {
    const { v, a } = run(base({ records: [rec('2027-03-01')], exemptions: [{ employee_id: 1, effective_from: '2027-03-01', effective_to: null, revoked_at: null }] }));
    expect(v.records[0]).toMatchObject({ status: 'valid', issues: [{ code: 'exempt_day' }] });
    expect(a).toMatchObject({ exemptDays: 5, absentDays: 0, presentDays: 0, actualWorkDays: 1 });
  });

  it('14. employment start: days before hire are not scheduled; a record before hire is invalid', () => {
    const input = base({ employees: [{ id: 1, company_id: 10, hire_date: '2027-03-03', termination_date: null }], records: [rec('2027-03-02'), ...week.slice(2).map((d) => rec(d))] });
    const { v, a } = run(input);
    expect(v.records[0]).toMatchObject({ status: 'invalid', issues: [{ code: 'not_employed' }] });
    expect(a).toMatchObject({ from: '2027-03-03', scheduledWorkDays: 3, presentDays: 3, absentDays: 0 });
  });

  it('15. employment end: days after termination are not scheduled; a record after it is invalid', () => {
    const input = base({ employees: [{ id: 1, company_id: 10, hire_date: '2026-01-01', termination_date: '2027-03-02' }], records: [rec('2027-03-01'), rec('2027-03-02'), rec('2027-03-03')] });
    const { v, a } = run(input);
    expect(v.records.map((x) => x.status)).toEqual(['valid', 'valid', 'invalid']);
    expect(a).toMatchObject({ to: '2027-03-02', scheduledWorkDays: 2, presentDays: 2 });
  });

  it('16. shift change: the schedule decides the workday; a record checked against another shift is a warning', () => {
    const schedule = new Map([
      ['1|2027-03-01', { kind: 'shift' as const, shiftId: 5 }],
      ['1|2027-03-02', { kind: 'day_off' as const, shiftId: null }],
      ['1|2027-03-06', { kind: 'shift' as const, shiftId: 6 }],
    ]);
    const { v, a } = run(base({ schedule, records: [rec('2027-03-01', { shift_id: 4 }), rec('2027-03-06', { shift_id: 6 })] }));
    expect(v.records.map((x) => `${x.record.work_date}:${x.status}:${x.issues.map((i) => i.code).join('+')}`)).toEqual(['2027-03-01:warning:shift_changed', '2027-03-06:valid:']);
    // Tue is a day off, Sat is a shift day: 3 weekdays + Sat = 5
    expect(a).toMatchObject({ scheduledWorkDays: 5, presentDays: 2, absentDays: 3 });
  });

  it('17. OT: approved requests are summed; OT on a day without usable attendance is a day warning', () => {
    const v = validateDaily(base({ records: [rec('2027-03-01')], overtime: [{ id: 1, employee_id: 1, work_date: '2027-03-01', hours: 2, rate: '1.5' }, { id: 2, employee_id: 1, work_date: '2027-03-02', hours: 1.5, rate: '1.5' }] }));
    expect(v.days.map((d) => `${d.work_date}:${d.code}`)).toEqual(['2027-03-02:ot_without_attendance']);
    const a = aggregateDaily(base({ records: [rec('2027-03-01')], overtime: [{ id: 1, employee_id: 1, work_date: '2027-03-01', hours: 2, rate: '1.5' }, { id: 2, employee_id: 1, work_date: '2027-03-02', hours: 1.5, rate: '1.5' }] }), v)[0]!;
    expect(a.otHours).toBe(3.5);
  });

  it('18. confirmation by HR counts a pending-review record for exactly the confirmed revision', () => {
    const r = rec('2027-03-01', { clock_out: null, revision: 41 });
    const unconfirmed = run(base({ records: [r] }));
    expect(unconfirmed.v.records[0]).toMatchObject({ status: 'pending_review', counted: false, confirmed: false });
    // the unverified day is neither present nor absent; the 4 other weekdays have no record (absent)
    expect(unconfirmed.a).toMatchObject({ presentDays: 0, unverifiedDays: 1, absentDays: 4 });
    const confirmed = run(base({ records: [r], confirmed: new Set([`${r.id}:41`]) }));
    expect(confirmed.v.records[0]).toMatchObject({ status: 'pending_review', counted: true, confirmed: true });
    expect(confirmed.a.presentDays).toBe(1);
    // a later correction (new revision) is not covered by the old confirmation
    expect(run(base({ records: [{ ...r, revision: 42 }], confirmed: new Set([`${r.id}:41`]) })).v.records[0]!.counted).toBe(false);
  });

  it('other rules: future date, unknown status, absent with times, long day', () => {
    expect(codes(base({ today: '2027-03-02', records: [rec('2027-03-03')] }))).toEqual(['2027-03-03:invalid:future_date']);
    expect(codes(base({ records: [rec('2027-03-01', { status: 'wfh' })] }))).toEqual(['2027-03-01:invalid:unknown_status']);
    expect(codes(base({ records: [rec('2027-03-01', { status: 'leave' })] }))).toEqual(['2027-03-01:pending_review:status_conflict']);
    expect(codes(base({ records: [rec('2027-03-01', { worked_minutes: 17 * 60 })] }))).toEqual(['2027-03-01:warning:long_day']);
  });

  it('invalid and pending-review records are never counted', () => {
    const { a } = run(base({ records: [rec('2027-03-01', { clock_in: '18:00', clock_out: '09:00', late_minutes: 600 }), rec('2027-03-02', { clock_out: null })] }));
    expect(a).toMatchObject({ presentDays: 0, actualWorkDays: 0, unverifiedDays: 2, lateMinutes: 0, records: { invalid: 1, pending_review: 1, valid: 0, warning: 0 } });
  });
});

describe('validationHolds', () => {
  it('one hold per invalid / pending record, with the record revision in the source (a correction reopens a cleared hold)', () => {
    const v = validateDaily(base({ records: [rec('2027-03-01', { clock_in: '18:00', clock_out: '09:00', revision: 3 }), rec('2027-03-02', { clock_out: null, revision: 7 }), rec('2027-03-03')] }));
    const h = validationHolds(v);
    expect(h.map((x) => `${x.kind}:${x.work_date}:${x.source.revision}:${x.source.codes.join('+')}`)).toEqual(['invalid_record:2027-03-01:3:out_before_in', 'pending_review:2027-03-02:7:missing_clock_out']);
    expect(h[0]!.source.attendance).toEqual([h[0]!.source.record]);
  });
});

describe('aggregateDaily — periods', () => {
  it('21–24, 32. a monthly period: scheduled vs actual vs present vs absent', () => {
    const month = base({ periodStart: '2027-03-01', periodEnd: '2027-03-31', records: ['2027-03-01', '2027-03-02', '2027-03-06'].map((d) => rec(d)) });
    const { a } = run(month);
    // March 2027 has 23 weekdays
    expect(a).toMatchObject({ scheduledWorkDays: 23, judgedWorkDays: 23, presentDays: 2, actualWorkDays: 3, restDayWorkDays: 1, absentDays: 21, missingAttendanceDays: 21 });
  });

  it('31. period boundary: records outside the period are ignored', () => {
    const { v, a } = run(base({ records: [rec('2027-02-26'), rec('2027-03-01'), rec('2027-03-08')] }));
    expect(v.records.map((x) => x.record.work_date)).toEqual(['2027-03-01']);
    expect(a.actualWorkDays).toBe(1);
  });

  it('33. a semi-monthly period (1–15) counts only its own days; no 30-day month is assumed', () => {
    const half = base({ periodStart: '2027-03-01', periodEnd: '2027-03-15', records: week.map((d) => rec(d)) });
    expect(run(half).a).toMatchObject({ scheduledWorkDays: 11, presentDays: 5, absentDays: 6 });
    const feb = base({ periodStart: '2027-02-01', periodEnd: '2027-02-28' });
    expect(run(feb).a.scheduledWorkDays).toBe(20);
  });

  it('a running period judges only completed days (up to yesterday); scheduled days cover the whole period', () => {
    const running = base({ periodStart: '2027-03-01', periodEnd: '2027-03-31', today: '2027-03-04', records: [rec('2027-03-01'), rec('2027-03-04', { clock_out: null })] });
    expect(judgedThrough(running)).toBe('2027-03-03');
    expect(run(running).a).toMatchObject({ scheduledWorkDays: 23, judgedWorkDays: 3, presentDays: 1, absentDays: 2 });
  });

  it('several companies: each employee uses their company calendar', () => {
    const input = base({
      employees: [{ id: 1, company_id: 10, hire_date: '2026-01-01', termination_date: null }, { id: 2, company_id: 20, hire_date: '2026-01-01', termination_date: null }],
      calendars: new Map([[10, { weeklyRest: [0, 6], holidays: new Set<string>() }], [20, { weeklyRest: [0], holidays: new Set(['2027-03-01']) }]]),
    });
    const v = validateDaily(input);
    expect(aggregateDaily(input, v).map((a) => [a.employee_id, a.scheduledWorkDays])).toEqual([[1, 5], [2, 5]]);
  });

  it('aggregation is repeatable and the totals add up', () => {
    const input = base({ records: week.map((d) => rec(d, { late_minutes: 5 })) });
    const once = run(input).a;
    expect(run(input).a).toEqual(once);
    expect(aggregateTotals([once, once])).toMatchObject({ employees: 2, presentDays: 10, lateMinutes: 50 });
  });
});

describe('versionPayload', () => {
  const p = { id: 9, kind: 'monthly', company_id: 10 };
  it('39. deterministic and independent of the load order', () => {
    const rs = week.map((d) => rec(d));
    expect(versionPayload(base({ records: rs }), p)).toBe(versionPayload(base({ records: [...rs].reverse() }), p));
  });

  it('37. any change of a judged input changes it: a time, a revision, a leave, a schedule entry, an HR confirmation', () => {
    const r = rec('2027-03-01');
    const v0 = versionPayload(base({ records: [r] }), p);
    expect(versionPayload(base({ records: [{ ...r, clock_out: '17:00' }] }), p)).not.toBe(v0);
    expect(versionPayload(base({ records: [{ ...r, revision: 99 }] }), p)).not.toBe(v0);
    expect(versionPayload(base({ records: [r], leaves: [leave(1, '2027-03-02', '2027-03-02', 'approved', false)] }), p)).not.toBe(v0);
    expect(versionPayload(base({ records: [r], schedule: new Map([['1|2027-03-02', { kind: 'day_off' as const, shiftId: null }]]) }), p)).not.toBe(v0);
    expect(versionPayload(base({ records: [r], confirmed: new Set(['1:1']) }), p)).not.toBe(v0);
  });

  it('days after the last judged day do not change it (a running period stays stable while today is written)', () => {
    const running = (records: DailyRecord[]) => versionPayload(base({ periodEnd: '2027-03-31', today: '2027-03-04', records }), p);
    const r1 = rec('2027-03-01');
    expect(running([r1, rec('2027-03-04', { clock_out: null })])).toBe(running([r1]));
    expect(running([r1])).not.toBe(versionPayload(base({ periodEnd: '2027-03-31', today: '2027-03-05', records: [r1] }), p));
    expect(todayFor('2027-03-03')).toBe('2027-03-04');
  });
});

describe('payDifferences (Preview warnings, no amount change)', () => {
  const agg = (over: Partial<EmployeeAggregate>): EmployeeAggregate => ({ ...run(base({ records: week.map((d) => rec(d)) })).a, ...over });
  it('matches: no warning', () => {
    expect(payDifferences(agg({}), { source: 'requests', otHours: 0, unpaidLeaveDays: 0, workDays: null })).toEqual([]);
  });
  it('unpaid leave, Feishu OT and work days that differ; absence the formula does not deduct; unknown leave type', () => {
    expect(payDifferences(agg({ unpaidLeaveDays: 1, absentDays: 2, unclassifiedLeaveDays: 1, otHours: 3 }), { source: 'feishu', otHours: 2, unpaidLeaveDays: 0, workDays: 4 }))
      .toEqual(['unpaid_leave_differs', 'ot_differs', 'work_days_differ', 'absent_not_deducted', 'unclassified_leave']);
    // OT from requests is the same source as the aggregation: never a difference
    expect(payDifferences(agg({ otHours: 3 }), { source: 'requests', otHours: 2, unpaidLeaveDays: 0, workDays: null })).toEqual([]);
  });
});
