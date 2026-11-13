import { describe, expect, it } from 'vitest';
import { detectHolds, holdKey, holdsApply, type HoldInput, type ScheduleKind } from '../../src/shared/attendance-holds';

// 2027-03: 1 March 2027 is a Monday. Weekly rest Sat/Sun (6, 0).
const base = (over: Partial<HoldInput> = {}): HoldInput => ({
  periodStart: '2027-03-01',
  periodEnd: '2027-03-07',
  today: '2027-12-31',
  employees: [{ id: 1, company_id: 10, hire_date: '2026-01-01', termination_date: null }],
  schedule: new Map(),
  calendars: new Map([[10, { weeklyRest: [0, 6], holidays: new Set<string>() }]]),
  attendance: [],
  leaves: [],
  exemptions: [],
  ...over,
});
const present = (d: string, id = 1, extra: Partial<{ status: string; clock_in: string | null }> = {}) => ({ id: Number(d.slice(8)) * 100 + id, employee_id: id, work_date: d, status: 'present', clock_in: '09:00', clock_out: '18:00', ...extra });
const week = ['2027-03-01', '2027-03-02', '2027-03-03', '2027-03-04', '2027-03-05'];
const summary = (h: ReturnType<typeof detectHolds>) => h.map((x) => `${x.kind}:${x.work_date ?? '-'}`);

describe('detectHolds', () => {
  it('a full week present: no hold', () => {
    expect(detectHolds(base({ attendance: week.map((d) => present(d)) }))).toEqual([]);
  });

  it('absent: a workday without attendance or leave (weekend never counted)', () => {
    const h = detectHolds(base({ attendance: week.filter((d) => d !== '2027-03-03').map((d) => present(d)) }));
    expect(summary(h)).toEqual(['absent:2027-03-03']);
    expect(h[0]).toMatchObject({ employee_id: 1, company_id: 10, source: {} });
  });

  it('missing attendance: one hold per employee and period, not one per day', () => {
    const h = detectHolds(base());
    expect(h).toEqual([{ employee_id: 1, company_id: 10, kind: 'missing_attendance', work_date: null, source: { workdays: 5 } }]);
  });

  it('pending leave holds the day; approved leave is OK; rejected / cancelled leave is absent', () => {
    const att = week.filter((d) => !['2027-03-02', '2027-03-03', '2027-03-04'].includes(d)).map((d) => present(d));
    const h = detectHolds(base({
      attendance: att,
      leaves: [
        { source: 'request', id: 7, employee_id: 1, start_date: '2027-03-02', end_date: '2027-03-02', status: 'pending' },
        { source: 'import', id: 8, employee_id: 1, start_date: '2027-03-03', end_date: '2027-03-03', status: 'approved' },
        { source: 'request', id: 9, employee_id: 1, start_date: '2027-03-04', end_date: '2027-03-04', status: 'rejected' },
      ],
    }));
    expect(summary(h)).toEqual(['pending_leave:2027-03-02', 'absent:2027-03-04']);
    expect(h[0]!.source.leaves).toEqual([{ source: 'request', id: 7, status: 'pending' }]);
    expect(h[1]!.source.leaves).toEqual([{ source: 'request', id: 9, status: 'rejected' }]);
  });

  it('overlaps: present wins over any leave; approved wins over pending on the same day', () => {
    const h = detectHolds(base({
      attendance: week.map((d) => present(d)),
      leaves: [{ source: 'request', id: 1, employee_id: 1, start_date: '2027-03-01', end_date: '2027-03-05', status: 'pending' }],
    }));
    expect(h).toEqual([]);
    const h2 = detectHolds(base({
      attendance: week.filter((d) => d !== '2027-03-02').map((d) => present(d)),
      leaves: [
        { source: 'request', id: 1, employee_id: 1, start_date: '2027-03-02', end_date: '2027-03-02', status: 'pending' },
        { source: 'import', id: 2, employee_id: 1, start_date: '2027-03-02', end_date: '2027-03-02', status: 'approved' },
      ],
    }));
    expect(h2).toEqual([]);
  });

  it('a manual absent / leave row is not attendance; a row with a clock time is', () => {
    const att = [...week.filter((d) => d !== '2027-03-01' && d !== '2027-03-02').map((d) => present(d)),
      { id: 1, employee_id: 1, work_date: '2027-03-01', status: 'absent', clock_in: null, clock_out: null },
      { id: 2, employee_id: 1, work_date: '2027-03-02', status: 'leave', clock_in: null, clock_out: '17:00' }];
    const h = detectHolds(base({ attendance: att }));
    expect(summary(h)).toEqual(['absent:2027-03-01']);
    expect(h[0]!.source.attendance).toEqual([1]);
  });

  it('holidays and weekly rest days are never absent; the shift schedule decides when it exists', () => {
    const cal = new Map([[10, { weeklyRest: [0, 6], holidays: new Set(['2027-03-03']) }]]);
    const schedule = new Map<string, ScheduleKind>([['1|2027-03-04', 'day_off'], ['1|2027-03-06', 'shift'], ['1|2027-03-05', 'holiday']]);
    const att = [present('2027-03-01'), present('2027-03-02')];
    // 03 holiday, 04 day off, 05 schedule holiday, 06 Saturday but scheduled shift → absent, 07 Sunday rest
    expect(summary(detectHolds(base({ calendars: cal, schedule, attendance: att })))).toEqual(['absent:2027-03-06']);
    // a scheduled shift on an approved holiday is still a holiday (never absent)
    const onHoliday = new Map<string, ScheduleKind>([['1|2027-03-03', 'shift']]);
    expect(summary(detectHolds(base({ calendars: cal, schedule: onHoliday, attendance: week.filter((d) => d !== '2027-03-03').map((d) => present(d)) })))).toEqual([]);
  });

  it('exempt days are not checked; a revoked exemption does not count', () => {
    const att = [present('2027-03-01')];
    const h = detectHolds(base({ attendance: att, exemptions: [{ employee_id: 1, effective_from: '2027-03-02', effective_to: '2027-03-04', revoked_at: null }] }));
    expect(summary(h)).toEqual(['absent:2027-03-05']);
    const revoked = detectHolds(base({ attendance: att, exemptions: [{ employee_id: 1, effective_from: '2027-03-02', effective_to: null, revoked_at: '2027-01-01' }] }));
    expect(summary(revoked)).toEqual(['absent:2027-03-02', 'absent:2027-03-03', 'absent:2027-03-04', 'absent:2027-03-05']);
    // exempt for the whole period: nothing to judge, not even missing attendance
    expect(detectHolds(base({ exemptions: [{ employee_id: 1, effective_from: '2026-01-01', effective_to: null, revoked_at: null }] }))).toEqual([]);
  });

  it('employment start / end dates limit the judged days', () => {
    const joiner = base({ employees: [{ id: 1, company_id: 10, hire_date: '2027-03-04', termination_date: null }], attendance: [present('2027-03-04')] });
    expect(summary(detectHolds(joiner))).toEqual(['absent:2027-03-05']);
    const leaver = base({ employees: [{ id: 1, company_id: 10, hire_date: '2026-01-01', termination_date: '2027-03-02' }], attendance: [present('2027-03-01')] });
    expect(summary(detectHolds(leaver))).toEqual(['absent:2027-03-02']);
    const notYet = base({ employees: [{ id: 1, company_id: 10, hire_date: '2027-04-01', termination_date: null }] });
    expect(detectHolds(notYet)).toEqual([]);
  });

  it('days after today are never judged', () => {
    const h = detectHolds(base({ today: '2027-03-02', attendance: [present('2027-03-01')] }));
    expect(summary(h)).toEqual(['absent:2027-03-02']);
    expect(detectHolds(base({ today: '2027-02-28' }))).toEqual([]);
  });

  it('several employees and companies are judged independently; keys are stable', () => {
    const h = detectHolds(base({
      employees: [{ id: 1, company_id: 10, hire_date: '2026-01-01', termination_date: null }, { id: 2, company_id: 20, hire_date: '2026-01-01', termination_date: null }],
      calendars: new Map([[10, { weeklyRest: [0, 6], holidays: new Set<string>() }], [20, { weeklyRest: [0], holidays: new Set<string>() }]]),
      attendance: [...week.map((d) => present(d, 1)), ...week.map((d) => present(d, 2))],
    }));
    // company 20 works Saturdays
    expect(h.map(holdKey)).toEqual(['2|absent|2027-03-06']);
    expect(h[0]!.company_id).toBe(20);
  });
});

describe('holdsApply', () => {
  it('only monthly periods starting on or after a configured date', () => {
    expect(holdsApply({ kind: 'monthly', start_date: '2027-03-01' }, '')).toBe(false);
    expect(holdsApply({ kind: 'monthly', start_date: '2027-03-01' }, 'not-a-date')).toBe(false);
    expect(holdsApply({ kind: 'monthly', start_date: '2027-03-01' }, '2027-03-01')).toBe(true);
    expect(holdsApply({ kind: 'monthly', start_date: '2027-02-26' }, '2027-03-01')).toBe(false);
    expect(holdsApply({ kind: 'mid_month', start_date: '2027-03-01' }, '2027-01-01')).toBe(false);
  });
});
