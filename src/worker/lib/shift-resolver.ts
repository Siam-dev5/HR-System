// The shift in force for an employee on a day — the one rule used by the group schedule, the attendance file import,
// web clock-in and approved time corrections:
//   1. an entry in shift_schedules (individual override, or the day assigned for a scheduled group)
//   2. the employee's shift group that day: fixed group → its default shift in force that day (a day outside the
//      shift's working days is a day off); scheduled group without an entry → not scheduled
//   3. the legacy shift_assignments row covering the day
import { parseBreaks, type ShiftTimes } from '../../shared/shifts';
import { weekday } from '../../shared/holidays';

export interface ShiftRow {
  id: number;
  code: string;
  name: string;
  company_id: number | null;
  shift_type: 'fixed' | 'scheduled';
  start_time: string;
  end_time: string;
  break_minutes: number | null;
  breaks_json: string;
  work_days: string;
  color: string | null;
  clock_in_before_minutes: number;
  clock_out_after_minutes: number;
  late_grace_minutes: number;
  early_leave_grace_minutes: number;
  ot_eligible: number;
  active: number;
  deleted_at: string | null;
}

export const SHIFT_COLUMNS = 'id, code, name, company_id, shift_type, start_time, end_time, break_minutes, breaks_json, work_days, color, clock_in_before_minutes, clock_out_after_minutes, late_grace_minutes, early_leave_grace_minutes, ot_eligible, active, deleted_at';

export function shiftTimes(s: ShiftRow): ShiftTimes {
  return {
    start_time: s.start_time,
    end_time: s.end_time,
    breaks: parseBreaks(s.breaks_json),
    break_minutes: s.break_minutes,
    late_grace_minutes: s.late_grace_minutes,
    early_leave_grace_minutes: s.early_leave_grace_minutes,
    clock_in_before_minutes: s.clock_in_before_minutes,
    clock_out_after_minutes: s.clock_out_after_minutes,
  };
}

export type ResolvedSource = 'individual' | 'group' | 'group_default' | 'assignment' | 'none';
export interface ResolvedDay {
  kind: 'shift' | 'day_off' | 'holiday' | 'none';
  shift: ShiftRow | null;
  source: ResolvedSource;
  groupId: number | null;
  scheduleId: number | null;
}

interface Membership {
  employee_id: number;
  group_id: number;
  start_date: string;
  end_date: string | null;
  shift_type: 'fixed' | 'scheduled';
}

export async function loadShifts(db: D1Database): Promise<Map<number, ShiftRow>> {
  const { results } = await db.prepare(`SELECT ${SHIFT_COLUMNS} FROM shifts`).all<ShiftRow>();
  return new Map(results.map((s) => [s.id, s]));
}

/** Resolved day for every employee and date in [from, to]; key `${employeeId}|${date}`. */
export async function resolveDays(db: D1Database, employeeIds: readonly number[], from: string, to: string, shifts?: Map<number, ShiftRow>): Promise<Map<string, ResolvedDay>> {
  const out = new Map<string, ResolvedDay>();
  if (!employeeIds.length) return out;
  const ids = JSON.stringify([...new Set(employeeIds)]);
  const [entries, members, assignments, shiftMap] = await Promise.all([
    db.prepare('SELECT id, employee_id, work_date, kind, shift_id, origin, group_id FROM shift_schedules WHERE employee_id IN (SELECT value FROM json_each(?1)) AND work_date BETWEEN ?2 AND ?3')
      .bind(ids, from, to)
      .all<{ id: number; employee_id: number; work_date: string; kind: 'shift' | 'day_off' | 'holiday'; shift_id: number | null; origin: 'group' | 'individual'; group_id: number | null }>(),
    db.prepare(`SELECT m.employee_id, m.group_id, m.start_date, m.end_date, g.shift_type FROM shift_group_members m JOIN shift_groups g ON g.id = m.group_id
                WHERE m.employee_id IN (SELECT value FROM json_each(?1)) AND m.start_date <= ?3 AND (m.end_date IS NULL OR m.end_date >= ?2) AND (m.end_date IS NULL OR m.end_date >= m.start_date)
                  AND g.deleted_at IS NULL AND g.status = 'active'`)
      .bind(ids, from, to)
      .all<Membership>(),
    db.prepare('SELECT employee_id, shift_id, start_date, end_date FROM shift_assignments WHERE employee_id IN (SELECT value FROM json_each(?1)) AND start_date <= ?3 AND (end_date IS NULL OR end_date >= ?2) ORDER BY start_date DESC')
      .bind(ids, from, to)
      .all<{ employee_id: number; shift_id: number; start_date: string; end_date: string | null }>(),
    shifts ? Promise.resolve(shifts) : loadShifts(db),
  ]);
  const groupIds = [...new Set(members.results.map((m) => m.group_id))];
  const defaults = groupIds.length
    ? (await db.prepare('SELECT group_id, shift_id, effective_date FROM shift_group_defaults WHERE group_id IN (SELECT value FROM json_each(?1)) ORDER BY effective_date DESC').bind(JSON.stringify(groupIds)).all<{ group_id: number; shift_id: number; effective_date: string }>()).results
    : [];
  const entryAt = new Map(entries.results.map((e) => [`${e.employee_id}|${e.work_date}`, e]));
  const days: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`); t <= end; t += 86_400_000) days.push(new Date(t).toISOString().slice(0, 10));
  for (const emp of new Set(employeeIds)) {
    const mine = members.results.filter((m) => m.employee_id === emp);
    const legacy = assignments.results.filter((a) => a.employee_id === emp);
    for (const d of days) {
      const key = `${emp}|${d}`;
      const e = entryAt.get(key);
      if (e) {
        out.set(key, { kind: e.kind, shift: e.shift_id ? (shiftMap.get(e.shift_id) ?? null) : null, source: e.origin, groupId: e.group_id, scheduleId: e.id });
        continue;
      }
      const m = mine.find((x) => x.start_date <= d && (x.end_date === null || x.end_date >= d));
      if (m) {
        if (m.shift_type === 'fixed') {
          const def = defaults.find((x) => x.group_id === m.group_id && x.effective_date <= d);
          const s = def ? (shiftMap.get(def.shift_id) ?? null) : null;
          if (s) {
            const works = s.work_days.split(',').map(Number).includes(weekday(d));
            out.set(key, { kind: works ? 'shift' : 'day_off', shift: works ? s : null, source: 'group_default', groupId: m.group_id, scheduleId: null });
            continue;
          }
        }
        out.set(key, { kind: 'none', shift: null, source: 'none', groupId: m.group_id, scheduleId: null });
        continue;
      }
      const a = legacy.find((x) => x.start_date <= d && (x.end_date === null || x.end_date >= d));
      const s = a ? (shiftMap.get(a.shift_id) ?? null) : null;
      out.set(key, s ? { kind: 'shift', shift: s, source: 'assignment', groupId: null, scheduleId: null } : { kind: 'none', shift: null, source: 'none', groupId: null, scheduleId: null });
    }
  }
  return out;
}

/** The shift in force for one employee on one day (null: no shift → the default start time applies). */
export async function shiftForDay(db: D1Database, employeeId: number, date: string): Promise<ResolvedDay> {
  return (await resolveDays(db, [employeeId], date, date)).get(`${employeeId}|${date}`) as ResolvedDay;
}

/** A calculated / approved / published monthly payroll period already covers the date (it must be reopened first). */
export async function lockedPeriod(db: D1Database, companyId: number, date: string): Promise<{ code: string; status: string } | null> {
  return db
    .prepare("SELECT code, status FROM payroll_periods WHERE kind = 'monthly' AND deleted_at IS NULL AND status <> 'draft' AND start_date <= ?1 AND end_date >= ?1 AND (company_id IS NULL OR company_id = ?2) LIMIT 1")
    .bind(date, companyId)
    .first<{ code: string; status: string }>();
}

/** Non-draft monthly payroll periods overlapping [from, to] for a company (dates inside are locked for changes). */
export async function lockedPeriods(db: D1Database, companyId: number, from: string, to: string): Promise<Array<{ code: string; status: string; start_date: string; end_date: string }>> {
  const { results } = await db
    .prepare("SELECT code, status, start_date, end_date FROM payroll_periods WHERE kind = 'monthly' AND deleted_at IS NULL AND status <> 'draft' AND start_date <= ?2 AND end_date >= ?1 AND (company_id IS NULL OR company_id = ?3)")
    .bind(from, to, companyId)
    .all<{ code: string; status: string; start_date: string; end_date: string }>();
  return results;
}
