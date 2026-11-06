// Shift arithmetic shared by the Worker and the SPA: working time net of break periods, shifts that cross midnight,
// and checking clock-in / clock-out times against a shift. Times are "HH:MM" wall-clock times in Asia/Bangkok;
// "24:00" is accepted as the end of a shift. Lateness follows the existing rule (late = clock-in after the start
// time), widened only by the shift's own grace minutes (0 by default).

export const SHIFT_TYPES = ['fixed', 'scheduled'] as const;
export type ShiftType = (typeof SHIFT_TYPES)[number];
export const SHIFT_TYPE_LABEL: Record<ShiftType, string> = { fixed: 'กะประจำ (Fixed)', scheduled: 'กะตามตาราง (Scheduled)' };
export const WEEKDAY_SHORT = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
/** longest span a shift (or one day's clock-in to clock-out) may cover */
export const MAX_SPAN_MINUTES = 24 * 60;
export const MAX_WORKED_MINUTES = 16 * 60;

export interface BreakPeriod {
  start: string;
  end: string;
}

export interface ShiftTimes {
  start_time: string;
  end_time: string;
  breaks: readonly BreakPeriod[];
  /** legacy total break used when no break periods are recorded */
  break_minutes?: number | null;
  late_grace_minutes?: number | null;
  early_leave_grace_minutes?: number | null;
  clock_in_before_minutes?: number | null;
  clock_out_after_minutes?: number | null;
}

const TIME_RE = /^(?:([01]\d|2[0-3]):([0-5]\d)|24:00)$/;
export const isTime = (v: unknown): v is string => typeof v === 'string' && TIME_RE.test(v);

/** "HH:MM" → minutes after midnight ("24:00" = 1440). */
export function toMinutes(t: string): number {
  if (!isTime(t)) throw new Error(`เวลาไม่ถูกต้อง: ${t}`);
  return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
}

/** minutes after midnight (any day) → "HH:MM" */
export function fromMinutes(m: number): string {
  const x = ((Math.round(m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
}

/** 510 → "8 ชม. 30 นาที" */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} ชม. ${m} นาที` : `${h} ชม.`;
}

/** The shift as a span of minutes from its start: end is after start, +1440 when the shift crosses midnight. */
export function shiftSpan(s: Pick<ShiftTimes, 'start_time' | 'end_time'>): { start: number; end: number; overnight: boolean } {
  const start = toMinutes(s.start_time);
  let end = toMinutes(s.end_time);
  if (end <= start) end += 1440;
  return { start, end, overnight: end > 1440 };
}

/** Break periods placed inside the shift span (a break that starts "earlier" than the shift is on the next day). */
export function breakWindows(s: ShiftTimes): Array<[number, number]> {
  const span = shiftSpan(s);
  return s.breaks.map((b) => {
    let bs = toMinutes(b.start);
    if (bs < span.start) bs += 1440;
    let be = toMinutes(b.end);
    while (be <= bs) be += 1440;
    return [bs, be] as [number, number];
  });
}

const overlap = (a: [number, number], b: [number, number]) => Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));

export function totalBreakMinutes(s: ShiftTimes): number {
  if (!s.breaks.length) return Math.max(0, Math.round(Number(s.break_minutes ?? 0)));
  return breakWindows(s).reduce((sum, w) => sum + (w[1] - w[0]), 0);
}

/** Scheduled working time of the shift: span minus breaks. */
export function netWorkMinutes(s: ShiftTimes): number {
  const span = shiftSpan(s);
  return span.end - span.start - totalBreakMinutes(s);
}

/** Problems with a shift definition (empty = valid). */
export function shiftProblems(s: { start_time: unknown; end_time: unknown; breaks: unknown; work_days?: unknown }): string[] {
  const out: string[] = [];
  if (!isTime(s.start_time) || s.start_time === '24:00') out.push('เวลาเข้างานไม่ถูกต้อง (HH:MM)');
  if (!isTime(s.end_time)) out.push('เวลาเลิกงานไม่ถูกต้อง (HH:MM)');
  if (out.length) return out;
  if (s.start_time === s.end_time || (s.start_time === '00:00' && s.end_time === '24:00')) out.push('เวลาเข้าและเลิกงานต้องต่างกัน และกะยาวไม่เกิน 24 ชั่วโมง');
  const breaks = Array.isArray(s.breaks) ? (s.breaks as BreakPeriod[]) : null;
  if (!breaks) return [...out, 'ช่วงเวลาพักไม่ถูกต้อง'];
  if (breaks.length > 6) out.push('กำหนดช่วงพักได้ไม่เกิน 6 ช่วง');
  for (const [i, b] of breaks.entries()) {
    if (!b || !isTime(b.start) || !isTime(b.end) || b.start === b.end) out.push(`ช่วงพักที่ ${i + 1}: เวลาไม่ถูกต้อง`);
  }
  if (out.length) return out;
  const shift: ShiftTimes = { start_time: s.start_time as string, end_time: s.end_time as string, breaks };
  const span = shiftSpan(shift);
  const wins = breakWindows(shift);
  wins.forEach((w, i) => {
    if (w[0] < span.start || w[1] > span.end) out.push(`ช่วงพักที่ ${i + 1} (${breaks[i]!.start}–${breaks[i]!.end}) อยู่นอกเวลากะ`);
  });
  for (let i = 0; i < wins.length; i++) for (let j = i + 1; j < wins.length; j++) {
    if (overlap(wins[i]!, wins[j]!) > 0) out.push(`ช่วงพักที่ ${i + 1} และ ${j + 1} ซ้อนกัน`);
  }
  if (!out.length && netWorkMinutes(shift) <= 0) out.push('เวลาพักรวมต้องน้อยกว่าเวลากะ');
  if (s.work_days !== undefined && parseWorkDays(s.work_days) === null) out.push('วันทำงานต้องเลือกอย่างน้อย 1 วัน');
  return out;
}

/** "1,2,3,4,5" → [1,2,3,4,5]; null when empty or invalid. */
export function parseWorkDays(raw: unknown): number[] | null {
  const parts = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(',') : [];
  const days = [...new Set(parts.map((p) => p.trim()).filter((p) => p !== ''))];
  if (!days.length || days.some((d) => !/^[0-6]$/.test(d))) return null;
  return days.map(Number).sort((a, b) => a - b);
}

export interface ClockCheck {
  status: 'present' | 'late';
  /** minutes after the start (beyond the grace the record is "late"); 0 when on time */
  lateMinutes: number;
  /** minutes before the end the employee left (0 when not early or no clock-out) */
  earlyLeaveMinutes: number;
  /** worked minutes net of the shift's breaks; null without a clock-out */
  workedMinutes: number | null;
  /** clock-out is on the day after the work date */
  outNextDay: boolean;
  warnings: Array<'clock_in_early' | 'clock_out_late' | 'early_leave' | 'missing_clock_out' | 'long_day' | 'cross_midnight_unplanned'>;
  /** the day is impossible (clock-out more than a day after clock-in, …) */
  error: 'out_before_in' | null;
}

/**
 * Checks one day's clock times. Without a shift only the existing default start time applies (no early-leave check).
 * `outNextDay` comes from the file when the clock-out carries a date; otherwise a clock-out not after the clock-in
 * is taken as the next morning (cross-midnight).
 */
export function checkClock(shift: ShiftTimes | null, clockIn: string, clockOut: string | null, opts: { outNextDay?: boolean; defaultStart?: string } = {}): ClockCheck {
  const warnings: ClockCheck['warnings'] = [];
  const span = shift ? shiftSpan(shift) : { start: toMinutes(opts.defaultStart ?? '09:00'), end: 0, overnight: false };
  let tin = toMinutes(clockIn);
  // an overnight shift: a clock-in far "before" the start (e.g. 00:30 for a 22:00 shift) is after midnight
  if (shift && span.overnight && tin < span.start - 720) tin += 1440;
  let tout: number | null = null;
  let outNextDay = false;
  if (clockOut !== null) {
    tout = toMinutes(clockOut) + (opts.outNextDay ? 1440 : 0);
    while (tout <= tin) tout += 1440;
    outNextDay = tout >= 1440;
    if (tout - tin > MAX_SPAN_MINUTES) return { status: 'present', lateMinutes: 0, earlyLeaveMinutes: 0, workedMinutes: null, outNextDay, warnings, error: 'out_before_in' };
  } else warnings.push('missing_clock_out');

  const lateBy = tin - span.start;
  const grace = shift ? Math.max(0, Number(shift.late_grace_minutes ?? 0)) : 0;
  const late = lateBy > grace;
  let early = 0;
  let worked: number | null = null;
  if (shift) {
    if (span.start - tin > Math.max(0, Number(shift.clock_in_before_minutes ?? 120))) warnings.push('clock_in_early');
    if (tout !== null) {
      const earlyBy = span.end - tout;
      if (earlyBy > Math.max(0, Number(shift.early_leave_grace_minutes ?? 0))) {
        early = earlyBy;
        warnings.push('early_leave');
      }
      if (tout - span.end > Math.max(0, Number(shift.clock_out_after_minutes ?? 240))) warnings.push('clock_out_late');
      const breaks = shift.breaks.length ? breakWindows(shift) : [];
      worked = tout - tin - breaks.reduce((s, w) => s + overlap([tin, tout as number], w), 0);
      if (!shift.breaks.length && shift.break_minutes) worked -= Math.min(Number(shift.break_minutes), Math.max(0, worked));
      if (outNextDay && !span.overnight) warnings.push('cross_midnight_unplanned');
    }
  } else if (tout !== null) worked = tout - tin;
  if (worked !== null && worked > MAX_WORKED_MINUTES) warnings.push('long_day');
  return { status: late ? 'late' : 'present', lateMinutes: late ? lateBy : 0, earlyLeaveMinutes: early, workedMinutes: worked, outNextDay, warnings, error: null };
}

/** True when shift `a` worked on `dayA` still runs when shift `b` starts on the next day (or b starts before a ends). */
export function overlapsNextDay(a: Pick<ShiftTimes, 'start_time' | 'end_time'>, b: Pick<ShiftTimes, 'start_time' | 'end_time'>): boolean {
  const sa = shiftSpan(a);
  const sb = shiftSpan(b);
  return sa.end > sb.start + 1440;
}

/** Repeats a rotation pattern over consecutive days, starting `offset` steps into the pattern. */
export function rotate<T>(pattern: readonly T[], days: number, offset = 0): T[] {
  if (!pattern.length) return [];
  return Array.from({ length: days }, (_, i) => pattern[(((i + offset) % pattern.length) + pattern.length) % pattern.length] as T);
}

/** Every date from `from` to `to` inclusive (YYYY-MM-DD, UTC arithmetic). */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end && out.length < 400; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** Last day of the month of a YYYY-MM or YYYY-MM-DD string. */
export function monthEnd(ym: string): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** Parses the stored break periods (JSON); invalid content gives no breaks. */
export function parseBreaks(raw: unknown): BreakPeriod[] {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? v.filter((b) => b && isTime(b.start) && isTime(b.end)).map((b) => ({ start: b.start as string, end: b.end as string })) : [];
  } catch {
    return [];
  }
}

export const CLOCK_WARNING_LABEL: Record<ClockCheck['warnings'][number], string> = {
  clock_in_early: 'เข้างานเร็วกว่าช่วงที่กะกำหนด',
  clock_out_late: 'ออกงานช้ากว่าช่วงที่กะกำหนด',
  early_leave: 'ออกงานก่อนเวลาเลิกกะ',
  missing_clock_out: 'ไม่มีเวลาออกงาน',
  long_day: 'ช่วงเวลาทำงานเกิน 16 ชั่วโมง',
  cross_midnight_unplanned: 'ออกงานหลังเที่ยงคืนแต่กะไม่ใช่กะข้ามวัน',
};
