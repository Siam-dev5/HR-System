// Shift settings (detailed shift definitions), shift groups with members (manual / department / company, transfer,
// history), effective-dated group default shifts and the group schedule calendar (daily assignment, bulk, rotation,
// copy, day off, holiday, clear). Every change is company-scoped on the server, audited, and refused on days inside
// a payroll period that is already calculated; changes to past days need a reason and are kept as revisions.
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import type { CompanyScope } from '../../shared/types';
import { currentUser, requireAuth, requirePerm } from '../auth';
import { audit } from '../lib/audit';
import { companyScope, requireCompany } from '../lib/companies';
import { DATE_RE, badRequest, conflict, forbidden, intParam, notFound, readJson, str } from '../lib/http';
import { bangkokNow } from '../lib/time';
import { SHIFT_COLUMNS, loadShifts, lockedPeriods, resolveDays, shiftTimes, type ResolvedDay, type ShiftRow } from '../lib/shift-resolver';
import { applicable } from './holidays';
import { SHIFT_TYPES, dateRange, monthEnd, netWorkMinutes, overlapsNextDay, parseBreaks, parseWorkDays, shiftProblems, type BreakPeriod, type ShiftType } from '../../shared/shifts';
import { addDays } from '../../shared/payroll';

export const shiftRoutes = new Hono<AppEnv>();
shiftRoutes.use('*', requireAuth);

const CODE_RE = /^[A-Za-z0-9_-]{1,20}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const TOKEN_RE = /^[A-Za-z0-9-]{8,64}$/;
const MAX_RANGE_DAYS = 62;
const MAX_CHANGES = 5000;

async function scopeOf(c: Context<AppEnv>): Promise<CompanyScope> {
  return companyScope(c.env.DB, currentUser(c));
}
const inScope = (scope: CompanyScope, companyId: number | null) => scope.scope === 'all' || (companyId !== null && scope.items.some((x) => x.id === companyId));

function dateIn(body: Record<string, unknown>, key: string, required = true): string | null {
  const v = body[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw badRequest(`กรุณาระบุ ${key}`);
    return null;
  }
  if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw badRequest(`${key} ต้องเป็นวันที่ YYYY-MM-DD`);
  return v;
}
function intIn(body: Record<string, unknown>, key: string, min: number, max: number, fallback: number): number {
  const v = body[key];
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${key} ต้องเป็นจำนวนเต็ม ${min}–${max}`);
  return n;
}
function idList(v: unknown, name: string, max = 1000): number[] {
  if (!Array.isArray(v) || !v.length) throw badRequest(`กรุณาเลือก${name}`);
  if (v.length > max) throw badRequest(`เลือก${name}ได้ไม่เกิน ${max} รายการ`);
  const ids = [...new Set(v.map(Number))];
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) throw badRequest(`${name}ไม่ถูกต้อง`);
  return ids;
}
/** Changes on past days need a reason (kept in the audit trail / revisions). */
function pastReason(body: Record<string, unknown>, firstDate: string, today: string): string | null {
  const reason = str(body, 'reason', { max: 500 });
  if (firstDate < today && (!reason || reason.length < 3)) throw badRequest('การแก้ไขข้อมูลย้อนหลังต้องระบุเหตุผล (อย่างน้อย 3 ตัวอักษร)');
  return reason;
}
async function assertNotLocked(db: D1Database, companyId: number, from: string, to: string): Promise<void> {
  const locked = await lockedPeriods(db, companyId, from, to);
  if (locked.length) throw conflict(`ช่วงวันที่ ${from} – ${to} ทับงวดเงินเดือน ${locked.map((l) => `${l.code} (${l.status})`).join(', ')} ที่คำนวณแล้ว ต้องเปิดแก้ไขงวดก่อน`);
}

// ===== Shift settings ===========================================================================
interface ShiftOut extends Omit<ShiftRow, 'breaks_json'> {
  breaks: BreakPeriod[];
  work_day_list: number[];
  net_minutes: number;
  company: string | null;
}
const shiftOut = (s: ShiftRow & { company?: string | null }): ShiftOut => {
  const { breaks_json, ...rest } = s;
  return { ...rest, company: s.company ?? null, breaks: parseBreaks(breaks_json), work_day_list: parseWorkDays(s.work_days) ?? [], net_minutes: netWorkMinutes(shiftTimes(s)) };
};

async function visibleShift(c: Context<AppEnv>, id: number, write: boolean): Promise<ShiftRow> {
  const s = await c.env.DB.prepare(`SELECT ${SHIFT_COLUMNS} FROM shifts WHERE id = ? AND deleted_at IS NULL`).bind(id).first<ShiftRow>();
  const scope = await scopeOf(c);
  if (!s || (s.company_id !== null && !inScope(scope, s.company_id))) throw notFound('ไม่พบกะการทำงาน');
  if (write && s.company_id === null && scope.scope !== 'all') throw forbidden('กะที่ใช้ได้ทุกบริษัทแก้ไขได้เฉพาะผู้ที่เข้าถึงทุกบริษัท');
  return s;
}

async function readShift(c: Context<AppEnv>, body: Record<string, unknown>) {
  const scope = await scopeOf(c);
  const code = (str(body, 'code', { required: true, max: 20 }) as string).toUpperCase();
  if (!CODE_RE.test(code)) throw badRequest('รหัสกะใช้ได้เฉพาะ A-Z 0-9 _ - (ไม่เกิน 20 ตัว)');
  const name = str(body, 'name', { required: true, max: 100 }) as string;
  let companyId: number | null = null;
  if (body.company_id !== null && body.company_id !== undefined && body.company_id !== '') {
    companyId = (await requireCompany(c.env.DB, currentUser(c), String(body.company_id)))!.id;
  } else if (scope.scope !== 'all') throw forbidden('กะที่ใช้ได้ทุกบริษัทสร้างได้เฉพาะผู้ที่เข้าถึงทุกบริษัท กรุณาเลือกบริษัท');
  const shiftType = body.shift_type ?? 'fixed';
  if (!SHIFT_TYPES.includes(shiftType as ShiftType)) throw badRequest('ประเภทกะไม่ถูกต้อง');
  const breaks = body.breaks === undefined || body.breaks === null ? [] : Array.isArray(body.breaks) ? body.breaks.map((b) => ({ start: String((b as BreakPeriod)?.start ?? ''), end: String((b as BreakPeriod)?.end ?? '') })) : body.breaks;
  const problems = shiftProblems({ start_time: body.start_time, end_time: body.end_time, breaks, work_days: body.work_days ?? undefined });
  if (problems.length) throw badRequest(problems.join(' · '), { problems });
  const color = str(body, 'color', { max: 7 });
  if (color && !COLOR_RE.test(color)) throw badRequest('สีต้องเป็นรหัส #RRGGBB');
  // not given: Monday–Friday, the column default
  const workDays = body.work_days === undefined || body.work_days === null ? '1,2,3,4,5' : (parseWorkDays(body.work_days) as number[]).join(',');
  const times = { start_time: body.start_time as string, end_time: body.end_time as string, breaks: breaks as BreakPeriod[] };
  const breakTotal = (breaks as BreakPeriod[]).length ? netWorkMinutes({ ...times, breaks: [] }) - netWorkMinutes(times) : 0;
  return {
    code, name, companyId, shiftType: shiftType as ShiftType, start: times.start_time, end: times.end_time, breaksJson: JSON.stringify(breaks), breakTotal, workDays, color,
    inBefore: intIn(body, 'clock_in_before_minutes', 0, 720, 120), outAfter: intIn(body, 'clock_out_after_minutes', 0, 720, 240),
    lateGrace: intIn(body, 'late_grace_minutes', 0, 240, 0), earlyGrace: intIn(body, 'early_leave_grace_minutes', 0, 240, 0),
    ot: body.ot_eligible === true || body.ot_eligible === 1 ? 1 : 0, active: body.active === false || body.active === 0 ? 0 : 1,
  };
}

shiftRoutes.get('/settings', requirePerm('shifts.view'), async (c) => {
  const scope = await scopeOf(c);
  const { results } = await c.env.DB
    .prepare(`SELECT s.${SHIFT_COLUMNS.split(', ').join(', s.')}, co.name AS company,
        (SELECT COUNT(*) FROM shift_group_defaults d WHERE d.shift_id = s.id) AS used_by_groups,
        (SELECT COUNT(*) FROM shift_schedules x WHERE x.shift_id = s.id) AS used_in_schedule
      FROM shifts s LEFT JOIN companies co ON co.id = s.company_id
      WHERE s.deleted_at IS NULL AND (s.company_id IS NULL OR ?1 IS NULL OR s.company_id IN (SELECT value FROM json_each(?1))) ORDER BY s.code`)
    .bind(scope.scope === 'all' ? null : JSON.stringify(scope.items.map((x) => x.id)))
    .all<ShiftRow & { company: string | null; used_by_groups: number; used_in_schedule: number }>();
  return c.json(results.map((s) => ({ ...shiftOut(s), used_by_groups: s.used_by_groups, used_in_schedule: s.used_in_schedule })));
});

shiftRoutes.post('/settings', requirePerm('shifts.create'), async (c) => {
  const user = currentUser(c);
  const s = await readShift(c, await readJson(c));
  if (await c.env.DB.prepare('SELECT 1 FROM shifts WHERE code = ?').bind(s.code).first()) throw conflict(`รหัสกะ ${s.code} มีอยู่แล้ว`);
  const row = await c.env.DB
    .prepare(`INSERT INTO shifts (code, name, start_time, end_time, break_minutes, active, company_id, shift_type, work_days, breaks_json, color, clock_in_before_minutes, clock_out_after_minutes, late_grace_minutes, early_leave_grace_minutes, ot_eligible, created_by, updated_by)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?17) RETURNING id`)
    .bind(s.code, s.name, s.start, s.end, s.breakTotal, s.active, s.companyId, s.shiftType, s.workDays, s.breaksJson, s.color, s.inBefore, s.outAfter, s.lateGrace, s.earlyGrace, s.ot, user.id)
    .first<{ id: number }>();
  await audit(c, 'shift.created', 'shifts', row!.id, { code: s.code, start: s.start, end: s.end, breaks: s.breaksJson, company_id: s.companyId });
  return c.json(shiftOut((await visibleShift(c, row!.id, false)) as ShiftRow), 201);
});

shiftRoutes.put('/settings/:id', requirePerm('shifts.update'), async (c) => {
  const user = currentUser(c);
  const before = await visibleShift(c, intParam(c.req.param('id')), true);
  const s = await readShift(c, await readJson(c));
  if (s.code !== before.code && (await c.env.DB.prepare('SELECT 1 FROM shifts WHERE code = ? AND id <> ?').bind(s.code, before.id).first())) throw conflict(`รหัสกะ ${s.code} มีอยู่แล้ว`);
  await c.env.DB
    .prepare(`UPDATE shifts SET code = ?1, name = ?2, start_time = ?3, end_time = ?4, break_minutes = ?5, active = ?6, company_id = ?7, shift_type = ?8, work_days = ?9, breaks_json = ?10, color = ?11,
              clock_in_before_minutes = ?12, clock_out_after_minutes = ?13, late_grace_minutes = ?14, early_leave_grace_minutes = ?15, ot_eligible = ?16, updated_by = ?17, updated_at = datetime('now') WHERE id = ?18`)
    .bind(s.code, s.name, s.start, s.end, s.breakTotal, s.active, s.companyId, s.shiftType, s.workDays, s.breaksJson, s.color, s.inBefore, s.outAfter, s.lateGrace, s.earlyGrace, s.ot, user.id, before.id)
    .run();
  await audit(c, 'shift.updated', 'shifts', before.id, { before: shiftOut(before), after: { code: s.code, start: s.start, end: s.end, breaks: s.breaksJson, work_days: s.workDays, active: s.active } });
  return c.json(shiftOut(await visibleShift(c, before.id, false)));
});

/** Soft delete; a shift still used by a group default or a schedule entry can only be deactivated. */
shiftRoutes.delete('/settings/:id', requirePerm('shifts.delete'), async (c) => {
  const user = currentUser(c);
  const s = await visibleShift(c, intParam(c.req.param('id')), true);
  const used = await c.env.DB.prepare('SELECT (SELECT COUNT(*) FROM shift_group_defaults WHERE shift_id = ?1) + (SELECT COUNT(*) FROM shift_schedules WHERE shift_id = ?1) + (SELECT COUNT(*) FROM shift_assignments WHERE shift_id = ?1) AS n').bind(s.id).first<{ n: number }>();
  if ((used?.n ?? 0) > 0) throw conflict('กะนี้ถูกใช้ในกลุ่มหรือตารางกะแล้ว ลบไม่ได้ ให้ปิดการใช้งานแทน');
  await c.env.DB.prepare("UPDATE shifts SET deleted_at = datetime('now'), deleted_by = ?, active = 0 WHERE id = ?").bind(user.id, s.id).run();
  await audit(c, 'shift.deleted', 'shifts', s.id, { code: s.code });
  return c.json({ ok: true });
});

// ===== Shift groups =============================================================================
interface GroupRow {
  id: number;
  code: string;
  name: string;
  company_id: number;
  company: string;
  department_id: number | null;
  department: string | null;
  owner_employee_id: number | null;
  owner: string | null;
  membership: 'manual' | 'department' | 'company';
  shift_type: ShiftType;
  status: 'active' | 'inactive';
  description: string | null;
  members: number;
  default_shift_id: number | null;
  default_shift: string | null;
  default_effective_date: string | null;
  updated_at: string;
}
const GROUP_SELECT = `SELECT g.id, g.code, g.name, g.company_id, co.name AS company, g.department_id, dp.name AS department, g.owner_employee_id,
  CASE WHEN ow.id IS NULL THEN NULL ELSE ow.emp_code || ' ' || ow.first_name || ' ' || ow.last_name END AS owner, g.membership, g.shift_type, g.status, g.description, g.updated_at,
  (SELECT COUNT(*) FROM shift_group_members m WHERE m.group_id = g.id AND m.start_date <= ?9 AND (m.end_date IS NULL OR m.end_date >= ?9)) AS members,
  (SELECT d.shift_id FROM shift_group_defaults d WHERE d.group_id = g.id AND d.effective_date <= ?9 ORDER BY d.effective_date DESC LIMIT 1) AS default_shift_id,
  (SELECT s.code || ' ' || s.name || ' ' || s.start_time || '–' || s.end_time FROM shift_group_defaults d JOIN shifts s ON s.id = d.shift_id WHERE d.group_id = g.id AND d.effective_date <= ?9 ORDER BY d.effective_date DESC LIMIT 1) AS default_shift,
  (SELECT d.effective_date FROM shift_group_defaults d WHERE d.group_id = g.id AND d.effective_date <= ?9 ORDER BY d.effective_date DESC LIMIT 1) AS default_effective_date
  FROM shift_groups g JOIN companies co ON co.id = g.company_id LEFT JOIN departments dp ON dp.id = g.department_id LEFT JOIN employees ow ON ow.id = g.owner_employee_id`;

async function groupOr404(c: Context<AppEnv>, id: number): Promise<GroupRow> {
  const g = await c.env.DB.prepare(`${GROUP_SELECT} WHERE g.id = ?1 AND g.deleted_at IS NULL`).bind(id, null, null, null, null, null, null, null, bangkokNow().date).first<GroupRow>();
  if (!g || !inScope(await scopeOf(c), g.company_id)) throw notFound('ไม่พบกลุ่มกะ');
  return g;
}

async function usableShift(db: D1Database, shiftId: number, companyId: number): Promise<ShiftRow> {
  const s = await db.prepare(`SELECT ${SHIFT_COLUMNS} FROM shifts WHERE id = ? AND deleted_at IS NULL`).bind(shiftId).first<ShiftRow>();
  if (!s || (s.company_id !== null && s.company_id !== companyId)) throw badRequest('กะนี้ใช้กับบริษัทของกลุ่มไม่ได้');
  if (!s.active) throw badRequest(`กะ ${s.code} ปิดการใช้งานอยู่`);
  return s;
}

async function readGroup(c: Context<AppEnv>, body: Record<string, unknown>) {
  const company = await requireCompany(c.env.DB, currentUser(c), body.company_id === undefined || body.company_id === null ? undefined : String(body.company_id));
  if (!company) throw badRequest('กรุณาเลือกบริษัท');
  const code = (str(body, 'code', { required: true, max: 20 }) as string).toUpperCase();
  if (!CODE_RE.test(code)) throw badRequest('รหัสกลุ่มใช้ได้เฉพาะ A-Z 0-9 _ - (ไม่เกิน 20 ตัว)');
  const membership = body.membership ?? 'manual';
  if (!['manual', 'department', 'company'].includes(String(membership))) throw badRequest('ประเภทกลุ่มไม่ถูกต้อง');
  const shiftType = body.shift_type;
  if (!SHIFT_TYPES.includes(shiftType as ShiftType)) throw badRequest('ประเภทกะของกลุ่มไม่ถูกต้อง');
  const status = body.status ?? 'active';
  if (status !== 'active' && status !== 'inactive') throw badRequest('สถานะไม่ถูกต้อง');
  let departmentId: number | null = null;
  if (body.department_id !== undefined && body.department_id !== null && body.department_id !== '') {
    departmentId = intParam(String(body.department_id), 'department_id');
    const d = await c.env.DB.prepare('SELECT company_id FROM departments WHERE id = ?').bind(departmentId).first<{ company_id: number }>();
    if (!d || d.company_id !== company.id) throw badRequest('หน่วยงานไม่ได้อยู่ในบริษัทของกลุ่ม');
  }
  if (membership === 'department' && !departmentId) throw badRequest('กลุ่มตามหน่วยงานต้องเลือกหน่วยงาน');
  let ownerId: number | null = null;
  if (body.owner_employee_id !== undefined && body.owner_employee_id !== null && body.owner_employee_id !== '') {
    ownerId = intParam(String(body.owner_employee_id), 'owner_employee_id');
    const o = await c.env.DB.prepare('SELECT company_id FROM employees WHERE id = ?').bind(ownerId).first<{ company_id: number }>();
    if (!o || o.company_id !== company.id) throw badRequest('ผู้รับผิดชอบกลุ่มต้องเป็นพนักงานของบริษัทเดียวกัน');
  }
  return { company, code, name: str(body, 'name', { required: true, max: 100 }) as string, membership: membership as GroupRow['membership'], shiftType: shiftType as ShiftType, status, departmentId, ownerId, description: str(body, 'description', { max: 500 }) };
}

shiftRoutes.get('/groups', requirePerm('shift_groups.view'), async (c) => {
  const user = currentUser(c);
  const scope = await scopeOf(c);
  const company = await requireCompany(c.env.DB, user, c.req.query('company'));
  const ids = company ? [company.id] : scope.scope === 'all' ? null : scope.items.map((x) => x.id);
  if (scope.scope === 'none') return c.json([]);
  const { results } = await c.env.DB
    .prepare(`${GROUP_SELECT} WHERE g.deleted_at IS NULL AND (?1 IS NULL OR g.company_id IN (SELECT value FROM json_each(?1))) ORDER BY co.code, g.code`)
    .bind(ids ? JSON.stringify(ids) : null, null, null, null, null, null, null, null, bangkokNow().date)
    .all<GroupRow>();
  return c.json(results);
});

shiftRoutes.post('/groups', requirePerm('shift_groups.manage'), async (c) => {
  const user = currentUser(c);
  const body = await readJson(c);
  const g = await readGroup(c, body);
  const today = bangkokNow().date;
  if (await c.env.DB.prepare('SELECT 1 FROM shift_groups WHERE code = ?').bind(g.code).first()) throw conflict(`รหัสกลุ่ม ${g.code} มีอยู่แล้ว`);
  const defaultShift = body.default_shift_id ? await usableShift(c.env.DB, intParam(String(body.default_shift_id), 'default_shift_id'), g.company.id) : null;
  if (g.shiftType === 'fixed' && !defaultShift) throw badRequest('กลุ่มกะประจำต้องเลือกกะประจำของกลุ่ม');
  const effective = dateIn(body, 'default_effective_date', false) ?? today;
  const row = await c.env.DB
    .prepare(`INSERT INTO shift_groups (code, name, company_id, department_id, owner_employee_id, membership, shift_type, status, description, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(g.code, g.name, g.company.id, g.departmentId, g.ownerId, g.membership, g.shiftType, g.status, g.description, user.id, user.id)
    .first<{ id: number }>();
  if (defaultShift) await c.env.DB.prepare('INSERT INTO shift_group_defaults (group_id, shift_id, effective_date, created_by) VALUES (?, ?, ?, ?)').bind(row!.id, defaultShift.id, effective, user.id).run();
  await audit(c, 'shift_group.created', 'shift_groups', row!.id, { code: g.code, company_id: g.company.id, membership: g.membership, shift_type: g.shiftType, default_shift_id: defaultShift?.id ?? null, effective_date: defaultShift ? effective : null });
  return c.json(await groupOr404(c, row!.id), 201);
});

shiftRoutes.put('/groups/:id', requirePerm('shift_groups.manage'), async (c) => {
  const user = currentUser(c);
  const before = await groupOr404(c, intParam(c.req.param('id')));
  const g = await readGroup(c, await readJson(c));
  if (g.company.id !== before.company_id) throw badRequest('เปลี่ยนบริษัทของกลุ่มไม่ได้ ให้สร้างกลุ่มใหม่');
  if (g.code !== before.code.toUpperCase() && (await c.env.DB.prepare('SELECT 1 FROM shift_groups WHERE code = ? AND id <> ?').bind(g.code, before.id).first())) throw conflict(`รหัสกลุ่ม ${g.code} มีอยู่แล้ว`);
  if (g.shiftType !== before.shift_type && before.members > 0) throw conflict('เปลี่ยนประเภทกะของกลุ่มที่มีสมาชิกไม่ได้ ให้ย้ายสมาชิกไปกลุ่มใหม่');
  if (g.shiftType === 'fixed' && !before.default_shift_id && !(await c.env.DB.prepare('SELECT 1 FROM shift_group_defaults WHERE group_id = ?').bind(before.id).first())) throw badRequest('กลุ่มกะประจำต้องกำหนดกะประจำก่อน');
  await c.env.DB
    .prepare("UPDATE shift_groups SET code = ?, name = ?, department_id = ?, owner_employee_id = ?, membership = ?, shift_type = ?, status = ?, description = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(g.code, g.name, g.departmentId, g.ownerId, g.membership, g.shiftType, g.status, g.description, user.id, before.id)
    .run();
  await audit(c, 'shift_group.updated', 'shift_groups', before.id, { before: { code: before.code, name: before.name, membership: before.membership, status: before.status, department_id: before.department_id }, after: { code: g.code, name: g.name, membership: g.membership, status: g.status, department_id: g.departmentId } });
  return c.json(await groupOr404(c, before.id));
});

/** Soft delete of a group without current or future members. */
shiftRoutes.delete('/groups/:id', requirePerm('shift_groups.manage'), async (c) => {
  const user = currentUser(c);
  const g = await groupOr404(c, intParam(c.req.param('id')));
  const today = bangkokNow().date;
  const open = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM shift_group_members WHERE group_id = ? AND (end_date IS NULL OR end_date >= ?)').bind(g.id, today).first<{ n: number }>();
  if ((open?.n ?? 0) > 0) throw conflict('กลุ่มยังมีสมาชิกอยู่ ให้นำสมาชิกออกหรือย้ายกลุ่มก่อน');
  await c.env.DB.prepare("UPDATE shift_groups SET deleted_at = datetime('now'), deleted_by = ?, status = 'inactive' WHERE id = ?").bind(user.id, g.id).run();
  await audit(c, 'shift_group.deleted', 'shift_groups', g.id, { code: g.code });
  return c.json({ ok: true });
});

shiftRoutes.get('/groups/:id', requirePerm('shift_groups.view', 'shift_schedule.view'), async (c) => {
  const g = await groupOr404(c, intParam(c.req.param('id')));
  const [defaults, members, history] = await Promise.all([
    c.env.DB.prepare("SELECT d.id, d.shift_id, s.code || ' ' || s.name || ' ' || s.start_time || '–' || s.end_time AS shift, d.effective_date, d.created_at, u.username AS created_by FROM shift_group_defaults d JOIN shifts s ON s.id = d.shift_id LEFT JOIN users u ON u.id = d.created_by WHERE d.group_id = ? ORDER BY d.effective_date DESC").bind(g.id).all(),
    c.env.DB.prepare(`SELECT m.id, m.employee_id, e.emp_code, e.first_name || ' ' || e.last_name AS name, dp.name AS department, m.start_date, m.end_date, m.method, m.note, m.created_at, cu.username AS created_by, m.ended_at, eu.username AS ended_by
      FROM shift_group_members m JOIN employees e ON e.id = m.employee_id LEFT JOIN departments dp ON dp.id = e.department_id LEFT JOIN users cu ON cu.id = m.created_by LEFT JOIN users eu ON eu.id = m.ended_by
      WHERE m.group_id = ? ORDER BY (m.end_date IS NULL) DESC, e.emp_code, m.start_date DESC`).bind(g.id).all(),
    c.env.DB.prepare("SELECT id, at, username, action, details FROM audit_logs WHERE entity = 'shift_groups' AND entity_id = ? ORDER BY id DESC LIMIT 200").bind(String(g.id)).all(),
  ]);
  return c.json({ group: g, defaults: defaults.results, members: members.results, history: history.results, today: bangkokNow().date });
});

/** Changes the group's default shift from a date on; days before it keep the shift that applied (no retroactive change). */
shiftRoutes.post('/groups/:id/default', requirePerm('shift_groups.manage'), async (c) => {
  const user = currentUser(c);
  const g = await groupOr404(c, intParam(c.req.param('id')));
  const body = await readJson(c);
  const shift = await usableShift(c.env.DB, intParam(String(body.shift_id), 'shift_id'), g.company_id);
  const effective = dateIn(body, 'effective_date') as string;
  const today = bangkokNow().date;
  const hasHistory = await c.env.DB.prepare('SELECT 1 FROM shift_group_members WHERE group_id = ? AND start_date < ? LIMIT 1').bind(g.id, today).first();
  if (effective < today && hasHistory) throw badRequest('กะประจำใหม่ต้องมีผลตั้งแต่วันนี้เป็นต้นไป (ไม่เปลี่ยนข้อมูลย้อนหลัง)');
  await assertNotLocked(c.env.DB, g.company_id, effective, effective);
  await c.env.DB
    .prepare('INSERT INTO shift_group_defaults (group_id, shift_id, effective_date, created_by) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (group_id, effective_date) DO UPDATE SET shift_id = excluded.shift_id, created_by = excluded.created_by, created_at = datetime(\'now\')')
    .bind(g.id, shift.id, effective, user.id)
    .run();
  await audit(c, 'shift_group.default_changed', 'shift_groups', g.id, { shift_id: shift.id, shift: shift.code, effective_date: effective, previous_shift_id: g.default_shift_id });
  return c.json(await groupOr404(c, g.id));
});

// ---- members -----------------------------------------------------------------------------------
interface EmployeeLite {
  id: number;
  emp_code: string;
  name: string;
  company_id: number;
  department_id: number | null;
  status: string;
  hire_date: string | null;
  termination_date: string | null;
}
async function employeesById(db: D1Database, ids: readonly number[]): Promise<Map<number, EmployeeLite>> {
  const { results } = await db
    .prepare("SELECT id, emp_code, first_name || ' ' || last_name AS name, company_id, department_id, status, hire_date, termination_date FROM employees WHERE id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(ids))
    .all<EmployeeLite>();
  return new Map(results.map((e) => [e.id, e]));
}
/** Membership periods of these employees that overlap [from, ∞). */
async function overlapping(db: D1Database, ids: readonly number[], from: string): Promise<Array<{ id: number; employee_id: number; group_id: number; group_code: string; start_date: string; end_date: string | null }>> {
  const { results } = await db
    .prepare(`SELECT m.id, m.employee_id, m.group_id, g.code AS group_code, m.start_date, m.end_date FROM shift_group_members m JOIN shift_groups g ON g.id = m.group_id
              WHERE m.employee_id IN (SELECT value FROM json_each(?1)) AND (m.end_date IS NULL OR m.end_date >= ?2) AND (m.end_date IS NULL OR m.end_date >= m.start_date)`)
    .bind(JSON.stringify(ids), from)
    .all<{ id: number; employee_id: number; group_id: number; group_code: string; start_date: string; end_date: string | null }>();
  return results;
}
/** still employed on the date (a future hire may join a group before the first day) */
const employed = (e: EmployeeLite, date: string) => (!e.termination_date || e.termination_date >= date) && e.status !== 'resigned' && e.status !== 'terminated';

interface MemberPlan {
  add: Array<{ employee_id: number; emp_code: string; name: string }>;
  remove: Array<{ employee_id: number; emp_code: string; name: string; membership_id: number }>;
  conflicts: Array<{ employee_id: number; emp_code: string | null; message: string }>;
}

async function planAdd(c: Context<AppEnv>, g: GroupRow, ids: readonly number[], start: string): Promise<MemberPlan> {
  const emps = await employeesById(c.env.DB, ids);
  const busy = await overlapping(c.env.DB, ids, start);
  const plan: MemberPlan = { add: [], remove: [], conflicts: [] };
  for (const id of ids) {
    const e = emps.get(id);
    if (!e || e.company_id !== g.company_id) {
      plan.conflicts.push({ employee_id: id, emp_code: e && inScope(await scopeOf(c), e.company_id) ? e.emp_code : null, message: 'พนักงานไม่ได้อยู่ในบริษัทของกลุ่ม' });
      continue;
    }
    if (!employed(e, start)) {
      plan.conflicts.push({ employee_id: id, emp_code: e.emp_code, message: 'พนักงานพ้นสภาพแล้ว' });
      continue;
    }
    const b = busy.find((m) => m.employee_id === id);
    if (b) {
      plan.conflicts.push({ employee_id: id, emp_code: e.emp_code, message: b.group_id === g.id ? 'เป็นสมาชิกของกลุ่มนี้อยู่แล้ว' : `เป็นสมาชิกกลุ่ม ${b.group_code} ตั้งแต่ ${b.start_date} (ใช้การย้ายกลุ่มแทน เพื่อไม่ให้ตารางกะขัดแย้ง)` });
      continue;
    }
    plan.add.push({ employee_id: id, emp_code: e.emp_code, name: e.name });
  }
  return plan;
}

async function applyPlan(c: Context<AppEnv>, g: GroupRow, plan: MemberPlan, start: string, method: 'manual' | 'department' | 'company' | 'transfer', note: string | null): Promise<void> {
  const user = currentUser(c);
  const stmts: D1PreparedStatement[] = [];
  const end = addDays(start, -1);
  for (const r of plan.remove) stmts.push(c.env.DB.prepare("UPDATE shift_group_members SET end_date = ?, ended_at = datetime('now'), ended_by = ?, note = COALESCE(?, note) WHERE id = ? AND end_date IS NULL").bind(end, user.id, note, r.membership_id));
  for (const a of plan.add) stmts.push(c.env.DB.prepare('INSERT INTO shift_group_members (group_id, employee_id, start_date, method, note, created_by) VALUES (?, ?, ?, ?, ?, ?)').bind(g.id, a.employee_id, start, method, note, user.id));
  if (stmts.length) await c.env.DB.batch(stmts);
}

shiftRoutes.post('/groups/:id/members', requirePerm('shift_groups.manage'), async (c) => {
  const g = await groupOr404(c, intParam(c.req.param('id')));
  const body = await readJson(c);
  const start = dateIn(body, 'start_date') as string;
  const today = bangkokNow().date;
  const reason = pastReason(body, start, today);
  await assertNotLocked(c.env.DB, g.company_id, start, start < today ? today : start);
  const plan = await planAdd(c, g, idList(body.employee_ids, 'พนักงาน'), start);
  if (body.dry_run === true) return c.json({ ...plan, applied: false });
  if (!plan.add.length) throw conflict(plan.conflicts.map((x) => `${x.emp_code ?? x.employee_id}: ${x.message}`).join(' · ') || 'ไม่มีพนักงานที่เพิ่มได้');
  await applyPlan(c, g, plan, start, 'manual', reason);
  await audit(c, 'shift_group.members_added', 'shift_groups', g.id, { start_date: start, employees: plan.add.map((a) => a.emp_code), skipped: plan.conflicts.length, reason });
  return c.json({ ...plan, applied: true });
});

shiftRoutes.post('/groups/:id/members/remove', requirePerm('shift_groups.manage'), async (c) => {
  const user = currentUser(c);
  const g = await groupOr404(c, intParam(c.req.param('id')));
  const body = await readJson(c);
  const last = dateIn(body, 'end_date') as string;
  const today = bangkokNow().date;
  const reason = pastReason(body, addDays(last, 1), today);
  await assertNotLocked(c.env.DB, g.company_id, addDays(last, 1), addDays(last, 1) < today ? today : addDays(last, 1));
  const ids = idList(body.employee_ids, 'พนักงาน');
  const { results } = await c.env.DB
    .prepare("SELECT m.id, m.employee_id, m.start_date, e.emp_code FROM shift_group_members m JOIN employees e ON e.id = m.employee_id WHERE m.group_id = ?1 AND m.end_date IS NULL AND m.employee_id IN (SELECT value FROM json_each(?2))")
    .bind(g.id, JSON.stringify(ids))
    .all<{ id: number; employee_id: number; start_date: string; emp_code: string }>();
  const bad = results.filter((m) => last < addDays(m.start_date, -1));
  if (bad.length) throw badRequest(`วันสุดท้ายต้องไม่ก่อนวันเริ่มเป็นสมาชิก (${bad.map((b) => b.emp_code).join(', ')})`);
  if (!results.length) throw badRequest('พนักงานที่เลือกไม่ได้เป็นสมาชิกของกลุ่มนี้');
  await c.env.DB.batch(results.map((m) => c.env.DB.prepare("UPDATE shift_group_members SET end_date = ?, ended_at = datetime('now'), ended_by = ?, note = COALESCE(?, note) WHERE id = ?").bind(last, user.id, reason, m.id)));
  await audit(c, 'shift_group.members_removed', 'shift_groups', g.id, { end_date: last, employees: results.map((m) => m.emp_code), reason });
  return c.json({ removed: results.length });
});

/** Department / company groups: add the employees of the department or company, end the membership of those who left. */
shiftRoutes.post('/groups/:id/sync', requirePerm('shift_groups.manage'), async (c) => {
  const g = await groupOr404(c, intParam(c.req.param('id')));
  if (g.membership === 'manual') throw badRequest('กลุ่มแบบเลือกเองไม่มีการ Sync สมาชิก');
  const body = await readJson(c);
  const start = dateIn(body, 'start_date') as string;
  const today = bangkokNow().date;
  const reason = pastReason(body, start, today);
  await assertNotLocked(c.env.DB, g.company_id, start, start < today ? today : start);
  const { results: expected } = await c.env.DB
    .prepare("SELECT id FROM employees WHERE company_id = ?1 AND (?2 IS NULL OR department_id = ?2) AND status NOT IN ('resigned', 'terminated') AND (termination_date IS NULL OR termination_date >= ?3)")
    .bind(g.company_id, g.membership === 'department' ? g.department_id : null, start)
    .all<{ id: number }>();
  const { results: current } = await c.env.DB
    .prepare("SELECT m.id, m.employee_id, e.emp_code, e.first_name || ' ' || e.last_name AS name FROM shift_group_members m JOIN employees e ON e.id = m.employee_id WHERE m.group_id = ? AND m.end_date IS NULL")
    .bind(g.id)
    .all<{ id: number; employee_id: number; emp_code: string; name: string }>();
  const want = new Set(expected.map((e) => e.id));
  const have = new Set(current.map((m) => m.employee_id));
  const missing = [...want].filter((id) => !have.has(id));
  const plan = missing.length ? await planAdd(c, g, missing, start) : { add: [], remove: [], conflicts: [] } as MemberPlan;
  plan.remove = current.filter((m) => !want.has(m.employee_id)).map((m) => ({ employee_id: m.employee_id, emp_code: m.emp_code, name: m.name, membership_id: m.id }));
  if (body.dry_run === true) return c.json({ ...plan, applied: false });
  await applyPlan(c, g, plan, start, g.membership, reason ?? `Sync ตาม${g.membership === 'department' ? 'หน่วยงาน' : 'บริษัท'}`);
  await audit(c, 'shift_group.synced', 'shift_groups', g.id, { start_date: start, added: plan.add.map((a) => a.emp_code), removed: plan.remove.map((r) => r.emp_code), skipped: plan.conflicts.length });
  return c.json({ ...plan, applied: true });
});

/** Moves employees to another group from a date: their schedule entries assigned by the old group from that date are removed. */
shiftRoutes.post('/groups/:id/transfer', requirePerm('shift_groups.manage'), async (c) => {
  const user = currentUser(c);
  const target = await groupOr404(c, intParam(c.req.param('id')));
  const body = await readJson(c);
  const date = dateIn(body, 'date') as string;
  const today = bangkokNow().date;
  const reason = pastReason(body, date, today);
  await assertNotLocked(c.env.DB, target.company_id, date, date < today ? today : date);
  const ids = idList(body.employee_ids, 'พนักงาน');
  const emps = await employeesById(c.env.DB, ids);
  const busy = await overlapping(c.env.DB, ids, date);
  const moves: Array<{ employee_id: number; emp_code: string; from_group: string | null; membership_id: number | null; group_entries: number; overrides: number }> = [];
  const conflicts: MemberPlan['conflicts'] = [];
  for (const id of ids) {
    const e = emps.get(id);
    if (!e || e.company_id !== target.company_id) {
      conflicts.push({ employee_id: id, emp_code: null, message: 'พนักงานไม่ได้อยู่ในบริษัทของกลุ่ม' });
      continue;
    }
    const mine = busy.filter((m) => m.employee_id === id);
    if (mine.some((m) => m.group_id === target.id)) {
      conflicts.push({ employee_id: id, emp_code: e.emp_code, message: 'เป็นสมาชิกของกลุ่มนี้อยู่แล้ว' });
      continue;
    }
    if (mine.some((m) => m.start_date > date || m.end_date !== null)) {
      conflicts.push({ employee_id: id, emp_code: e.emp_code, message: 'มีการเป็นสมาชิกกลุ่มอื่นที่กำหนดวันสิ้นสุดหรือเริ่มหลังวันที่ย้าย กรุณาตรวจสอบประวัติก่อน' });
      continue;
    }
    const cur = mine[0] ?? null;
    const counts = await c.env.DB
      .prepare("SELECT COALESCE(SUM(origin = 'group' AND group_id = ?2), 0) AS g, COALESCE(SUM(origin = 'individual'), 0) AS o FROM shift_schedules WHERE employee_id = ?1 AND work_date >= ?3")
      .bind(id, cur?.group_id ?? -1, date)
      .first<{ g: number; o: number }>();
    moves.push({ employee_id: id, emp_code: e.emp_code, from_group: cur?.group_code ?? null, membership_id: cur?.id ?? null, group_entries: counts?.g ?? 0, overrides: counts?.o ?? 0 });
  }
  if (body.dry_run === true || !moves.length) return c.json({ moves, conflicts, applied: false });
  const token = crypto.randomUUID();
  const stmts: D1PreparedStatement[] = [];
  for (const m of moves) {
    if (m.membership_id) {
      const from = busy.find((b) => b.id === m.membership_id)!;
      stmts.push(c.env.DB.prepare("INSERT INTO shift_schedule_revisions (employee_id, work_date, change_token, before_json, after_json, reason, created_by) SELECT employee_id, work_date, ?1, json_object('kind', kind, 'shift_id', shift_id, 'origin', origin, 'group_id', group_id), NULL, ?2, ?3 FROM shift_schedules WHERE employee_id = ?4 AND work_date >= ?5 AND origin = 'group' AND group_id = ?6")
        .bind(token, `ย้ายกลุ่มไป ${target.code}`, user.id, m.employee_id, date, from.group_id));
      stmts.push(c.env.DB.prepare("DELETE FROM shift_schedules WHERE employee_id = ? AND work_date >= ? AND origin = 'group' AND group_id = ?").bind(m.employee_id, date, from.group_id));
      stmts.push(c.env.DB.prepare("UPDATE shift_group_members SET end_date = ?, ended_at = datetime('now'), ended_by = ?, note = COALESCE(?, note) WHERE id = ?").bind(addDays(date, -1), user.id, reason ?? `ย้ายไปกลุ่ม ${target.code}`, m.membership_id));
    }
    stmts.push(c.env.DB.prepare("INSERT INTO shift_group_members (group_id, employee_id, start_date, method, note, created_by) VALUES (?, ?, ?, 'transfer', ?, ?)").bind(target.id, m.employee_id, date, reason ?? (m.from_group ? `ย้ายจากกลุ่ม ${m.from_group}` : null), user.id));
  }
  await c.env.DB.batch(stmts);
  await audit(c, 'shift_group.members_transferred', 'shift_groups', target.id, { date, moves: moves.map((m) => ({ employee: m.emp_code, from: m.from_group, removed_group_entries: m.group_entries })), reason });
  return c.json({ moves, conflicts, applied: true });
});

/** Departments and employees of one company (with their current group) for the group and schedule pickers. */
shiftRoutes.get('/people', requirePerm('shift_groups.view', 'shift_schedule.view'), async (c) => {
  const company = await requireCompany(c.env.DB, currentUser(c), c.req.query('company'));
  if (!company) throw badRequest('กรุณาเลือกบริษัท');
  const today = bangkokNow().date;
  const [departments, employees] = await Promise.all([
    c.env.DB.prepare('SELECT id, code, name FROM departments WHERE company_id = ? AND active = 1 ORDER BY code').bind(company.id).all(),
    c.env.DB.prepare(`SELECT e.id, e.emp_code, e.first_name || ' ' || e.last_name AS name, e.department_id, dp.name AS department, g.id AS group_id, g.code AS group_code
      FROM employees e LEFT JOIN departments dp ON dp.id = e.department_id
      LEFT JOIN shift_group_members m ON m.employee_id = e.id AND m.start_date <= ?2 AND (m.end_date IS NULL OR m.end_date >= ?2)
      LEFT JOIN shift_groups g ON g.id = m.group_id
      WHERE e.company_id = ?1 AND e.status NOT IN ('resigned', 'terminated') AND (e.termination_date IS NULL OR e.termination_date >= ?2) ORDER BY e.emp_code LIMIT 2000`).bind(company.id, today).all(),
  ]);
  return c.json({ company, departments: departments.results, employees: employees.results });
});

// ===== Group schedule ===========================================================================
interface ScheduleEmployee {
  id: number;
  emp_code: string;
  name: string;
  department_id: number | null;
  department: string | null;
  company_id: number;
  hire_date: string | null;
  termination_date: string | null;
}

function rangeOf(c: Context<AppEnv>, defaultMonth = false): { from: string; to: string } {
  const month = bangkokNow().date.slice(0, 7);
  const from = c.req.query('from') ?? (defaultMonth ? `${month}-01` : '');
  const to = c.req.query('to') ?? (defaultMonth ? monthEnd(month) : '');
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || to < from) throw badRequest('ช่วงวันที่ไม่ถูกต้อง');
  if (dateRange(from, to).length > MAX_RANGE_DAYS) throw badRequest(`แสดงได้ครั้งละไม่เกิน ${MAX_RANGE_DAYS} วัน`);
  return { from, to };
}

const cellOf = (r: ResolvedDay) => ({ kind: r.kind, shift_id: r.shift?.id ?? null, source: r.source, group_id: r.groupId });

shiftRoutes.get('/schedule', requirePerm('shift_schedule.view'), async (c) => {
  const db = c.env.DB;
  const user = currentUser(c);
  // without parameters: the first company in scope and the current month
  const company = (await requireCompany(db, user, c.req.query('company'))) ?? (await companyScope(db, user)).items[0];
  if (!company) throw badRequest('ยังไม่มีบริษัทที่คุณเข้าถึงได้');
  const { from, to } = rangeOf(c, true);
  const groupId = c.req.query('group') ? intParam(c.req.query('group'), 'group') : null;
  const group = groupId ? await groupOr404(c, groupId) : null;
  if (group && group.company_id !== company.id) throw badRequest('กลุ่มไม่ได้อยู่ในบริษัทที่เลือก');
  const dept = c.req.query('department') ? intParam(c.req.query('department'), 'department') : null;
  const q = (c.req.query('q') ?? '').trim().slice(0, 50);
  const like = q ? `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%` : null;
  const { results: employees } = await db
    .prepare(`SELECT e.id, e.emp_code, e.first_name || ' ' || e.last_name AS name, e.department_id, dp.name AS department, e.company_id, e.hire_date, e.termination_date
      FROM employees e LEFT JOIN departments dp ON dp.id = e.department_id
      WHERE e.company_id = ?1 AND (e.hire_date IS NULL OR e.hire_date <= ?3) AND (e.termination_date IS NULL OR e.termination_date >= ?2) AND e.status NOT IN ('resigned', 'terminated')
        AND (?4 IS NULL OR EXISTS (SELECT 1 FROM shift_group_members m WHERE m.employee_id = e.id AND m.group_id = ?4 AND m.start_date <= ?3 AND (m.end_date IS NULL OR m.end_date >= ?2) AND (m.end_date IS NULL OR m.end_date >= m.start_date)))
        AND (?5 IS NULL OR e.department_id = ?5)
        AND (?6 IS NULL OR e.emp_code LIKE ?6 ESCAPE '\\' OR e.first_name LIKE ?6 ESCAPE '\\' OR e.last_name LIKE ?6 ESCAPE '\\')
      ORDER BY e.emp_code LIMIT 500`)
    .bind(company.id, from, to, groupId, dept, like)
    .all<ScheduleEmployee>();
  const ids = employees.map((e) => e.id);
  const shifts = await loadShifts(db);
  const [resolved, holidays, leaves, locked, memberships, groups] = await Promise.all([
    resolveDays(db, ids, from, to, shifts),
    applicable(db, company.id, from, to),
    ids.length
      ? db.prepare("SELECT l.employee_id, l.start_date, l.end_date, t.name AS type FROM leave_requests l JOIN leave_types t ON t.id = l.leave_type_id WHERE l.status = 'approved' AND l.employee_id IN (SELECT value FROM json_each(?1)) AND l.start_date <= ?3 AND l.end_date >= ?2").bind(JSON.stringify(ids), from, to).all()
      : Promise.resolve({ results: [] }),
    lockedPeriods(db, company.id, from, to),
    ids.length
      ? db.prepare("SELECT m.employee_id, m.group_id, g.code, g.name, g.shift_type, m.start_date, m.end_date FROM shift_group_members m JOIN shift_groups g ON g.id = m.group_id WHERE m.employee_id IN (SELECT value FROM json_each(?1)) AND m.start_date <= ?3 AND (m.end_date IS NULL OR m.end_date >= ?2) AND (m.end_date IS NULL OR m.end_date >= m.start_date)").bind(JSON.stringify(ids), from, to).all()
      : Promise.resolve({ results: [] }),
    db.prepare("SELECT id, code, name, shift_type FROM shift_groups WHERE company_id = ? AND deleted_at IS NULL AND status = 'active' ORDER BY code").bind(company.id).all(),
  ]);
  const cells: Record<string, Record<string, ReturnType<typeof cellOf>>> = {};
  for (const [key, r] of resolved) {
    if (r.kind === 'none' && r.source === 'none') continue;
    const [emp, d] = key.split('|') as [string, string];
    (cells[emp] ??= {})[d] = cellOf(r);
  }
  const usable = [...shifts.values()].filter((s) => !s.deleted_at && (s.company_id === null || s.company_id === company.id));
  return c.json({
    company, from, to, today: bangkokNow().date, group, groups: groups.results,
    employees, cells, memberships: memberships.results,
    shifts: usable.map((s) => ({ id: s.id, code: s.code, name: s.name, start_time: s.start_time, end_time: s.end_time, color: s.color, active: s.active, shift_type: s.shift_type, work_days: s.work_days })),
    holidays: holidays.holidays.map((h) => ({ date: h.holiday_date, name: h.name })), weekly_rest: holidays.weeklyRest,
    leaves: leaves.results, locked,
  });
});

interface Change {
  employee_id: number;
  date: string;
  kind: 'shift' | 'day_off' | 'holiday' | 'clear';
  shift_id: number | null;
}
interface ScheduleIssue {
  employee_id: number;
  date: string;
  level: 'error' | 'warning';
  message: string;
}

function readChanges(v: unknown): Change[] {
  if (!Array.isArray(v) || !v.length) throw badRequest('ไม่มีรายการที่จะบันทึก');
  if (v.length > MAX_CHANGES) throw badRequest(`บันทึกได้ครั้งละไม่เกิน ${MAX_CHANGES} รายการ`);
  const seen = new Set<string>();
  return v.map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const employee_id = Number(o.employee_id);
    const date = String(o.date ?? '');
    const kind = String(o.kind ?? '') as Change['kind'];
    if (!Number.isInteger(employee_id) || employee_id <= 0 || !DATE_RE.test(date) || !['shift', 'day_off', 'holiday', 'clear'].includes(kind)) throw badRequest('รายการตารางกะไม่ถูกต้อง');
    const shift_id = kind === 'shift' ? Number(o.shift_id) : null;
    if (kind === 'shift' && (!Number.isInteger(shift_id) || (shift_id as number) <= 0)) throw badRequest('กรุณาเลือกกะ');
    const key = `${employee_id}|${date}`;
    if (seen.has(key)) throw badRequest('มีรายการซ้ำของพนักงานและวันเดียวกัน');
    seen.add(key);
    return { employee_id, date, kind, shift_id };
  });
}

/** Validates schedule changes; returns errors (block saving) and warnings (need confirmation). */
async function checkChanges(c: Context<AppEnv>, companyId: number, changes: readonly Change[], groupId: number | null, reason: string | null): Promise<{ issues: ScheduleIssue[]; origin: Map<string, { origin: 'group' | 'individual'; group: number | null }> }> {
  const db = c.env.DB;
  const today = bangkokNow().date;
  const ids = [...new Set(changes.map((x) => x.employee_id))];
  const dates = changes.map((x) => x.date).sort();
  const from = dates[0] as string;
  const to = dates[dates.length - 1] as string;
  const issues: ScheduleIssue[] = [];
  const add = (x: Change, level: ScheduleIssue['level'], message: string) => issues.push({ employee_id: x.employee_id, date: x.date, level, message });
  const [emps, shifts, locked, around, holidays, leaves, members] = await Promise.all([
    employeesById(db, ids),
    loadShifts(db),
    lockedPeriods(db, companyId, from, to),
    resolveDays(db, ids, addDays(from, -1), addDays(to, 1)),
    applicable(db, companyId, from, to),
    db.prepare("SELECT employee_id, start_date, end_date FROM leave_requests WHERE status = 'approved' AND employee_id IN (SELECT value FROM json_each(?1)) AND start_date <= ?3 AND end_date >= ?2").bind(JSON.stringify(ids), from, to).all<{ employee_id: number; start_date: string; end_date: string }>(),
    db.prepare('SELECT m.employee_id, m.group_id, m.start_date, m.end_date, g.shift_type FROM shift_group_members m JOIN shift_groups g ON g.id = m.group_id WHERE m.employee_id IN (SELECT value FROM json_each(?1)) AND m.start_date <= ?3 AND (m.end_date IS NULL OR m.end_date >= ?2) AND (m.end_date IS NULL OR m.end_date >= m.start_date)')
      .bind(JSON.stringify(ids), from, to)
      .all<{ employee_id: number; group_id: number; start_date: string; end_date: string | null; shift_type: ShiftType }>(),
  ]);
  const holidayAt = new Map(holidays.holidays.map((h) => [h.holiday_date, h.name]));
  // state after the changes, for the overlap check with the neighbouring days
  const after = new Map<string, ShiftRow | null>();
  for (const [k, r] of around) after.set(k, r.kind === 'shift' ? r.shift : null);
  const origin = new Map<string, { origin: 'group' | 'individual'; group: number | null }>();
  for (const x of changes) {
    const e = emps.get(x.employee_id);
    if (!e || e.company_id !== companyId) {
      add(x, 'error', 'พนักงานไม่ได้อยู่ในบริษัทที่เลือก');
      continue;
    }
    if ((e.hire_date && x.date < e.hire_date) || (e.termination_date && x.date > e.termination_date)) add(x, 'error', `${e.emp_code}: วันที่อยู่นอกช่วงการจ้างงาน`);
    const lock = locked.find((l) => l.start_date <= x.date && l.end_date >= x.date);
    if (lock) add(x, 'error', `${x.date} อยู่ในงวดเงินเดือน ${lock.code} ที่คำนวณแล้ว (${lock.status}) ต้องเปิดแก้ไขงวดก่อน`);
    if (x.date < today && (!reason || reason.length < 3)) add(x, 'error', `${x.date}: การแก้ไขตารางย้อนหลังต้องระบุเหตุผล`);
    const m = members.results.find((y) => y.employee_id === x.employee_id && y.start_date <= x.date && (y.end_date === null || y.end_date >= x.date));
    if (groupId !== null && m?.group_id !== groupId) add(x, 'error', `${e.emp_code}: ไม่ได้เป็นสมาชิกของกลุ่มในวันที่ ${x.date}`);
    origin.set(`${x.employee_id}|${x.date}`, groupId !== null && m?.group_id === groupId && m.shift_type === 'scheduled' ? { origin: 'group', group: groupId } : { origin: 'individual', group: m?.group_id ?? null });
    if (x.kind === 'shift') {
      const s = shifts.get(x.shift_id as number);
      if (!s || s.deleted_at || (s.company_id !== null && s.company_id !== companyId)) {
        add(x, 'error', 'กะนี้ใช้กับบริษัทนี้ไม่ได้');
        continue;
      }
      if (!s.active) add(x, 'error', `กะ ${s.code} ปิดการใช้งานอยู่`);
      if (holidayAt.has(x.date)) add(x, 'warning', `${e.emp_code} ${x.date}: เป็นวันหยุด (${holidayAt.get(x.date)})`);
      if (leaves.results.some((l) => l.employee_id === x.employee_id && l.start_date <= x.date && l.end_date >= x.date)) add(x, 'warning', `${e.emp_code} ${x.date}: มีใบลาที่อนุมัติแล้ว`);
      after.set(`${x.employee_id}|${x.date}`, s);
    } else after.set(`${x.employee_id}|${x.date}`, null);
  }
  // a cross-midnight shift must end before the next day's shift starts
  for (const x of changes) {
    const prev = after.get(`${x.employee_id}|${addDays(x.date, -1)}`);
    const cur = after.get(`${x.employee_id}|${x.date}`);
    const next = after.get(`${x.employee_id}|${addDays(x.date, 1)}`);
    const code = emps.get(x.employee_id)?.emp_code ?? x.employee_id;
    if (prev && cur && overlapsNextDay(prev, cur)) add(x, 'error', `${code} ${x.date}: กะทับซ้อนกับกะข้ามวันของวันก่อนหน้า (${prev.code} ${prev.start_time}–${prev.end_time})`);
    if (cur && next && overlapsNextDay(cur, next)) add(x, 'error', `${code} ${x.date}: กะข้ามวันทับซ้อนกับกะของวันถัดไป (${next.code} ${next.start_time}–${next.end_time})`);
  }
  return { issues, origin };
}

async function applyChanges(c: Context<AppEnv>, companyId: number, changes: readonly Change[], origin: Map<string, { origin: 'group' | 'individual'; group: number | null }>, token: string, reason: string | null): Promise<void> {
  const db = c.env.DB;
  const user = currentUser(c);
  const { results: current } = await db
    .prepare("SELECT s.employee_id, s.work_date, json_object('kind', s.kind, 'shift_id', s.shift_id, 'origin', s.origin, 'group_id', s.group_id) AS snap FROM shift_schedules s JOIN json_each(?1) j ON json_extract(j.value, '$.e') = s.employee_id AND json_extract(j.value, '$.d') = s.work_date")
    .bind(JSON.stringify(changes.map((x) => ({ e: x.employee_id, d: x.date }))))
    .all<{ employee_id: number; work_date: string; snap: string }>();
  const before = new Map(current.map((r) => [`${r.employee_id}|${r.work_date}`, r.snap]));
  // every write is gated on the token: a repeated save (same token) changes nothing
  const notSaved = 'NOT EXISTS (SELECT 1 FROM shift_schedule_revisions WHERE change_token = ?9)';
  const stmts: D1PreparedStatement[] = [];
  const revisions: Array<{ e: number; d: string; b: string | null; a: string | null }> = [];
  for (const x of changes) {
    const o = origin.get(`${x.employee_id}|${x.date}`) ?? { origin: 'individual' as const, group: null };
    const after = x.kind === 'clear' ? null : JSON.stringify({ kind: x.kind, shift_id: x.shift_id, origin: o.origin, group_id: o.group });
    revisions.push({ e: x.employee_id, d: x.date, b: before.get(`${x.employee_id}|${x.date}`) ?? null, a: after });
    if (x.kind === 'clear') {
      stmts.push(db.prepare(`DELETE FROM shift_schedules WHERE employee_id = ?1 AND work_date = ?2 AND ${notSaved}`).bind(x.employee_id, x.date, null, null, null, null, null, null, token));
    } else {
      stmts.push(db.prepare(`INSERT INTO shift_schedules (company_id, employee_id, work_date, kind, shift_id, origin, group_id, created_by, updated_by)
          SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8 WHERE ${notSaved}
          ON CONFLICT (employee_id, work_date) DO UPDATE SET kind = excluded.kind, shift_id = excluded.shift_id, origin = excluded.origin, group_id = excluded.group_id, updated_by = excluded.updated_by, updated_at = datetime('now')`)
        .bind(companyId, x.employee_id, x.date, x.kind, x.shift_id, o.origin, o.group, user.id, token));
    }
  }
  stmts.push(db.prepare(`INSERT INTO shift_schedule_revisions (employee_id, work_date, change_token, before_json, after_json, reason, created_by)
      SELECT json_extract(value, '$.e'), json_extract(value, '$.d'), ?1, json_extract(value, '$.b'), json_extract(value, '$.a'), ?2, ?3 FROM json_each(?4)
      WHERE NOT EXISTS (SELECT 1 FROM shift_schedule_revisions WHERE change_token = ?1)`)
    .bind(token, reason, user.id, JSON.stringify(revisions)));
  await db.batch(stmts);
}

async function saveSchedule(c: Context<AppEnv>, body: Record<string, unknown>, changes: Change[]) {
  const user = currentUser(c);
  const company = await requireCompany(c.env.DB, user, body.company_id === undefined || body.company_id === null ? undefined : String(body.company_id));
  if (!company) throw badRequest('กรุณาเลือกบริษัท');
  const groupId = body.group_id ? intParam(String(body.group_id), 'group_id') : null;
  if (groupId) {
    const g = await groupOr404(c, groupId);
    if (g.company_id !== company.id) throw badRequest('กลุ่มไม่ได้อยู่ในบริษัทที่เลือก');
  }
  const reason = str(body, 'reason', { max: 500 });
  const { issues, origin } = await checkChanges(c, company.id, changes, groupId, reason);
  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');
  const summary = { changes: changes.length, shift: changes.filter((x) => x.kind === 'shift').length, day_off: changes.filter((x) => x.kind === 'day_off').length, holiday: changes.filter((x) => x.kind === 'holiday').length, clear: changes.filter((x) => x.kind === 'clear').length };
  if (body.dry_run === true || errors.length || (warnings.length && body.accept_warnings !== true)) return { applied: false, errors, warnings, summary };
  const token = str(body, 'change_token', { required: true, max: 64 }) as string;
  if (!TOKEN_RE.test(token)) throw badRequest('change_token ไม่ถูกต้อง');
  if (await c.env.DB.prepare('SELECT 1 FROM shift_schedule_revisions WHERE change_token = ? LIMIT 1').bind(token).first()) return { applied: true, repeated: true, errors: [], warnings, summary };
  await applyChanges(c, company.id, changes, origin, token, reason);
  await audit(c, 'shift_schedule.saved', 'shift_schedules', company.id, { change_token: token, group_id: groupId, ...summary, from: changes.map((x) => x.date).sort()[0], to: changes.map((x) => x.date).sort().at(-1), reason, warnings: warnings.length });
  return { applied: true, repeated: false, errors: [], warnings, summary };
}

shiftRoutes.post('/schedule/changes', requirePerm('shift_schedule.manage'), async (c) => {
  const body = await readJson(c);
  return c.json(await saveSchedule(c, body, readChanges(body.changes)));
});

/** Copies the explicit entries of a day / week / month to another range (days without an entry are cleared). */
shiftRoutes.post('/schedule/copy', requirePerm('shift_schedule.manage'), async (c) => {
  const body = await readJson(c);
  const ids = idList(body.employee_ids, 'พนักงาน', 500);
  const fromStart = dateIn(body, 'from_start') as string;
  const fromEnd = dateIn(body, 'from_end') as string;
  const toStart = dateIn(body, 'to_start') as string;
  const toEnd = dateIn(body, 'to_end', false);
  if (fromEnd < fromStart || dateRange(fromStart, fromEnd).length > 31) throw badRequest('ช่วงต้นทางไม่ถูกต้อง (ไม่เกิน 31 วัน)');
  const mode = body.mode === 'month' ? 'month' : 'offset';
  const source = dateRange(fromStart, fromEnd);
  // month: day N of the source month → day N of the target month (days the target month lacks are skipped)
  const targets: Array<[string, string]> = [];
  if (mode === 'month') {
    const last = toEnd ?? toStart;
    for (const d of source) {
      const t = `${toStart.slice(0, 8)}${d.slice(8)}`;
      if (!Number.isNaN(Date.parse(`${t}T00:00:00Z`)) && new Date(`${t}T00:00:00Z`).toISOString().slice(0, 10) === t && t <= last) targets.push([d, t]);
    }
  } else source.forEach((d, i) => targets.push([d, addDays(toStart, i)]));
  const { results } = await c.env.DB
    .prepare('SELECT employee_id, work_date, kind, shift_id FROM shift_schedules WHERE employee_id IN (SELECT value FROM json_each(?1)) AND work_date BETWEEN ?2 AND ?3')
    .bind(JSON.stringify(ids), fromStart, fromEnd)
    .all<{ employee_id: number; work_date: string; kind: Change['kind']; shift_id: number | null }>();
  const at = new Map(results.map((r) => [`${r.employee_id}|${r.work_date}`, r]));
  const changes: Change[] = [];
  for (const id of ids) for (const [s, t] of targets) {
    const e = at.get(`${id}|${s}`);
    changes.push(e ? { employee_id: id, date: t, kind: e.kind, shift_id: e.shift_id } : { employee_id: id, date: t, kind: 'clear', shift_id: null });
  }
  if (!changes.length) throw badRequest('ไม่มีวันที่ปลายทางที่คัดลอกได้');
  return c.json(await saveSchedule(c, body, changes));
});

shiftRoutes.get('/schedule/history', requirePerm('shift_schedule.view'), async (c) => {
  const employeeId = intParam(c.req.query('employee'), 'employee');
  const e = await c.env.DB.prepare('SELECT company_id FROM employees WHERE id = ?').bind(employeeId).first<{ company_id: number }>();
  if (!e || !inScope(await scopeOf(c), e.company_id)) throw notFound('ไม่พบพนักงาน');
  const { from, to } = rangeOf(c);
  const { results } = await c.env.DB
    .prepare('SELECT r.id, r.work_date, r.before_json, r.after_json, r.reason, r.created_at, u.username AS created_by FROM shift_schedule_revisions r LEFT JOIN users u ON u.id = r.created_by WHERE r.employee_id = ? AND r.work_date BETWEEN ? AND ? ORDER BY r.id DESC LIMIT 500')
    .bind(employeeId, from, to)
    .all();
  return c.json(results);
});
