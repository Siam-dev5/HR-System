// Tenure and the probation timeline. Pure date-only arithmetic on YYYY-MM-DD strings (UTC calendar days), so the
// result never depends on the browser's or the Worker's timezone, nor on the time of day. "Today" is always passed in
// (the server's Asia/Bangkok date), never read from the device.
import { addDays, daysInclusive, probationEndDate } from './payroll';

/** Day 120 (hire date = day 1): an employee still on probation becomes "active" on this day. */
export const PROBATION_ACTIVATE_DAY = 120;

function parts(date: string): [number, number, number] {
  return date.split('-').map(Number) as [number, number, number];
}

const pad = (n: number) => String(n).padStart(2, '0');

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based: day 0 of the next month
}

/** from + n calendar months; a day that does not exist in the target month becomes its last day (31 Jan + 1 = 29 Feb). */
export function addMonths(from: string, n: number): string {
  const [y, m, d] = parts(from);
  const index = y * 12 + (m - 1) + n;
  const ty = Math.floor(index / 12);
  const tm = (index % 12) + 1;
  return `${ty}-${pad(tm)}-${pad(Math.min(d, daysInMonth(ty, tm)))}`;
}

export interface Tenure {
  years: number;
  months: number;
  days: number;
}

/**
 * Calendar years, months and days from `from` to `to` (exclusive of `to`'s own day: the hire date itself is 0 / 0 / 0).
 * Whole months are counted with addMonths (no 30- or 365-day approximation), the rest in calendar days.
 * null when `to` is before `from`.
 */
export function tenure(from: string, to: string): Tenure | null {
  if (to < from) return null;
  const [fy, fm] = parts(from);
  const [ty, tm] = parts(to);
  let months = (ty - fy) * 12 + (tm - fm);
  if (addMonths(from, months) > to) months -= 1;
  const days = daysInclusive(addMonths(from, months), to) - 1;
  return { years: Math.floor(months / 12), months: months % 12, days };
}

export function formatTenure(t: Tenure | null): string {
  return t ? `${t.years} ปี ${t.months} เดือน ${t.days} วัน` : '-';
}

/** Tenure is counted up to today, or up to the last working day of an employee who has left. */
export function tenureEnd(today: string, terminationDate: string | null | undefined): string {
  return terminationDate && terminationDate < today ? terminationDate : today;
}

export interface ProbationTimeline {
  /** day number of `today` (hire date = day 1); 0 before the hire date */
  day: number;
  /** day 90: probation completed — HR reviews the result */
  day90: string;
  /** day 91: the employee is past 90 days (mid-month rounds that start after day 90 no longer include them) */
  day91: string;
  /** day 120: status probation → active */
  day120: string;
}

export function probationTimeline(hireDate: string, today: string): ProbationTimeline {
  const day90 = probationEndDate(hireDate);
  return { day: daysInclusive(hireDate, today), day90, day91: addDays(day90, 1), day120: addDays(hireDate, PROBATION_ACTIVATE_DAY - 1) };
}

export type ProbationAction =
  /** day 90 or later (and before day 120): ask HR to review the probation result — once per hire date */
  | { kind: 'day90_notice'; due: string }
  /** days 91–119: follow-up every `intervalDays` after day 90 — once per due date */
  | { kind: 'reminder'; due: string }
  /** day 120 or later: status probation → active */
  | { kind: 'activate'; due: string }
  /** day 120 with the automatic change switched off (setting probation.auto_activate): HR is asked to change it */
  | { kind: 'activate_due'; due: string };

/**
 * What the daily probation job should do for one employee today. Only status "probation" is ever acted on, and only
 * the hire date counts: the recorded probation end (employees.probation_end) never postpones or suppresses day 120.
 * Every action carries the date it belongs to, so the job can make each one idempotent (employee, kind, due).
 * Catching up after missed runs yields the latest due action only, never one per missed day.
 */
export function probationActions(e: { hire_date: string; status: string }, today: string, intervalDays: number): ProbationAction[] {
  if (e.status !== 'probation') return [];
  const t = probationTimeline(e.hire_date, today);
  if (t.day >= PROBATION_ACTIVATE_DAY) return [{ kind: 'activate', due: t.day120 }];
  if (t.day < 90) return [];
  const out: ProbationAction[] = [{ kind: 'day90_notice', due: t.day90 }];
  const step = Math.floor(intervalDays);
  if (step > 0 && t.day > 90) {
    const k = Math.floor((t.day - 90) / step);
    if (k > 0) out.push({ kind: 'reminder', due: addDays(t.day90, k * step) });
  }
  return out;
}

/**
 * Whether a mid-month (advance) round still includes the employee: the same rule as wageSegments(mode 'mid_month'),
 * which pays the round only up to day 90. A round that starts after day 90 excludes them, so the switch from two
 * rounds to one happens at the next round, never in the middle of a month that already started with two.
 */
export function inMidMonthRound(hireDate: string, roundStart: string, roundEnd: string): boolean {
  return hireDate <= roundEnd && probationEndDate(hireDate) >= roundStart;
}

/** The cron triggers of wrangler.jsonc (UTC): 00:05 and 08:05 Asia/Bangkok. A unit test keeps the two in step. */
export const PROBATION_CRONS = ['5 17 * * *', '5 1 * * *'];

/** Next scheduled run after `now` (epoch ms), in UTC as D1 writes datetime('now'). Daily "minute hour * * *" crons only. */
export function nextScheduledRun(now: number, crons: readonly string[] = PROBATION_CRONS): string {
  const day = 86_400_000;
  const midnight = Math.floor(now / day) * day;
  let next = Infinity;
  for (const cron of crons) {
    const [minute, hour] = cron.split(' ').map(Number) as [number, number];
    const at = midnight + (hour * 60 + minute) * 60_000;
    next = Math.min(next, at > now ? at : at + day);
  }
  return new Date(next).toISOString().slice(0, 19).replace('T', ' ');
}

const THAI_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

/** "2026-11-29" → "29 พ.ย. 2569" (Buddhist year), for text stored on the server such as notification bodies. */
export function thaiDate(date: string): string {
  const [y, m, d] = parts(date);
  return `${d} ${THAI_MONTHS[m - 1]} ${y + 543}`;
}
