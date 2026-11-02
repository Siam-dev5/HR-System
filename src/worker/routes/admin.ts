import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import type { SettingItem } from '../../shared/types';
import { RESERVED_PERMISSIONS, permissionCatalogue } from '../../shared/modules';
import { permissionMatches } from '../../shared/permissions';
import { ROLE } from '../../shared/permissions';
import { generatePassword, hashPassword } from '../../shared/crypto';
import { badRequest, conflict, forbidden, intParam, notFound, readJson, str } from '../lib/http';
import { audit } from '../lib/audit';
import { currentUser, requireAuth, requirePerm, requireSuperAdmin } from '../auth';

const PERMISSION_PATTERN = /^(\*|\*\.[a-z_]+|[a-z_]+\.(\*|[a-z_]+))$/;

async function roleIds(db: D1Database, codes: unknown): Promise<number[]> {
  if (!Array.isArray(codes) || codes.some((x) => typeof x !== 'string')) throw badRequest('roles ต้องเป็นรายการรหัสบทบาท');
  if (!codes.length) return [];
  const { results } = await db.prepare(`SELECT id, code FROM roles WHERE code IN (${codes.map(() => '?').join(',')})`).bind(...codes).all<{ id: number; code: string }>();
  if (results.length !== new Set(codes).size) throw badRequest('มีบทบาทที่ไม่รู้จัก');
  return results.map((r) => r.id);
}

async function activeSuperAdmins(db: D1Database, excludeUserId?: number): Promise<number> {
  const r = await db
    .prepare('SELECT COUNT(DISTINCT u.id) n FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE r.code = ? AND u.active = 1 AND u.id <> ?')
    .bind(ROLE.superAdmin, excludeUserId ?? 0)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

async function linkEmployee(db: D1Database, userId: number, employeeId: unknown): Promise<D1PreparedStatement[]> {
  if (employeeId === undefined) return [];
  const stmts = [db.prepare('UPDATE employees SET user_id = NULL WHERE user_id = ?').bind(userId)];
  if (employeeId !== null && employeeId !== '') {
    const id = Number(employeeId);
    const emp = await db.prepare('SELECT id, user_id FROM employees WHERE id = ?').bind(id).first<{ id: number; user_id: number | null }>();
    if (!emp) throw badRequest('ไม่พบพนักงานที่จะผูก');
    if (emp.user_id !== null && emp.user_id !== userId) throw conflict('พนักงานนี้ผูกกับบัญชีอื่นแล้ว');
    stmts.push(db.prepare('UPDATE employees SET user_id = ? WHERE id = ?').bind(userId, id));
  }
  return stmts;
}

export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use('*', requireAuth);

// ---- Users ----------------------------------------------------------------------------------
adminRoutes.get('/users', requireSuperAdmin, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.username, u.display_name, u.email, u.active, u.mfa_enabled, u.must_change_password, u.last_login_at,
       CASE WHEN u.locked_until > datetime('now') THEN u.locked_until END AS locked_until,
       (SELECT group_concat(r.code) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id) AS roles,
       (SELECT e.id FROM employees e WHERE e.user_id = u.id) AS employee_id,
       (SELECT e.emp_code || ' ' || e.first_name || ' ' || e.last_name FROM employees e WHERE e.user_id = u.id) AS employee,
       u.approval_status, u.requested_employee_code, u.created_at
     FROM users u ORDER BY (u.approval_status = 'pending') DESC, u.username`,
  ).all<Record<string, string | number | null>>();
  return c.json(results.map((r) => ({ ...r, roles: r.roles ? String(r.roles).split(',') : [] })));
});

adminRoutes.post('/users', requireSuperAdmin, async (c) => {
  const body = await readJson(c);
  const username = str(body, 'username', { required: true, max: 50 }) as string;
  if (!/^[a-zA-Z0-9._-]{3,50}$/.test(username)) throw badRequest('ชื่อผู้ใช้ใช้ได้เฉพาะ a-z 0-9 . _ - (3-50 ตัว)');
  const displayName = str(body, 'displayName', { required: true, max: 100 }) as string;
  const email = str(body, 'email', { max: 200 });
  const ids = await roleIds(c.env.DB, body.roles ?? []);
  const temporaryPassword = generatePassword(16);
  const db = c.env.DB;
  if (body.employeeId !== undefined && body.employeeId !== null && body.employeeId !== '') {
    // validate before creating the user so a bad link never leaves a half-created account
    const emp = await db.prepare('SELECT user_id FROM employees WHERE id = ?').bind(Number(body.employeeId)).first<{ user_id: number | null }>();
    if (!emp) throw badRequest('ไม่พบพนักงานที่จะผูก');
    if (emp.user_id !== null) throw conflict('พนักงานนี้ผูกกับบัญชีอื่นแล้ว');
  }
  let userId: number;
  try {
    const row = await db.prepare('INSERT INTO users (username, display_name, email, password_hash, must_change_password) VALUES (?, ?, ?, ?, 1) RETURNING id')
      .bind(username, displayName, email, await hashPassword(temporaryPassword))
      .first<{ id: number }>();
    if (!row) throw new Error('insert failed');
    userId = row.id;
  } catch (e) {
    if (e instanceof Error && /UNIQUE/i.test(e.message)) throw conflict('ชื่อผู้ใช้นี้มีอยู่แล้ว');
    throw e;
  }
  const stmts = [
    ...ids.map((rid) => db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').bind(userId, rid)),
    ...(await linkEmployee(db, userId, body.employeeId)),
  ];
  if (stmts.length) await db.batch(stmts);
  await audit(c, 'user.created', 'user', userId, { username, roles: body.roles ?? [] });
  // The temporary password is returned once to the administrator and never stored in plain text or logs.
  return c.json({ id: userId, username, temporaryPassword }, 201);
});

adminRoutes.put('/users/:id', requireSuperAdmin, async (c) => {
  const me = currentUser(c);
  const id = intParam(c.req.param('id'));
  const db = c.env.DB;
  const existing = await db.prepare('SELECT id, active FROM users WHERE id = ?').bind(id).first<{ id: number; active: number }>();
  if (!existing) throw notFound('ไม่พบผู้ใช้');
  const body = await readJson(c);
  const stmts: D1PreparedStatement[] = [];
  const sets: string[] = [];
  const params: unknown[] = [];
  if ('displayName' in body) {
    sets.push('display_name = ?');
    params.push(str(body, 'displayName', { required: true, max: 100 }));
  }
  if ('email' in body) {
    sets.push('email = ?');
    params.push(str(body, 'email', { max: 200 }));
  }
  if ('active' in body) {
    const active = body.active === true || body.active === 1;
    if (!active && id === me.id) throw forbidden('ไม่สามารถปิดการใช้งานบัญชีของตนเองได้');
    if (!active && (await activeSuperAdmins(db, id)) === 0) throw conflict('ต้องมี Super Admin ที่ใช้งานได้อย่างน้อย 1 บัญชี');
    sets.push('active = ?');
    params.push(active ? 1 : 0);
    if (!active) stmts.push(db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id));
  }
  if ('roles' in body) {
    const ids = await roleIds(db, body.roles);
    const keepsSuper = (body.roles as string[]).includes(ROLE.superAdmin);
    if (!keepsSuper && (await activeSuperAdmins(db, id)) === 0) throw conflict('ต้องมี Super Admin ที่ใช้งานได้อย่างน้อย 1 บัญชี');
    stmts.push(db.prepare('DELETE FROM user_roles WHERE user_id = ?').bind(id));
    for (const rid of ids) stmts.push(db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').bind(id, rid));
  }
  stmts.push(...(await linkEmployee(db, id, body.employeeId)));
  if (sets.length) stmts.unshift(db.prepare(`UPDATE users SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).bind(...params, id));
  if (!stmts.length) throw badRequest('ไม่มีข้อมูลที่จะแก้ไข');
  await db.batch(stmts);
  await audit(c, 'user.updated', 'user', id, { fields: Object.keys(body) });
  return c.json({ ok: true });
});

async function adminAction(c: Context<AppEnv>, action: 'reset-password' | 'unlock' | 'reset-mfa') {
  const id = intParam(c.req.param('id'));
  const db = c.env.DB;
  const user = await db.prepare('SELECT id FROM users WHERE id = ?').bind(id).first();
  if (!user) throw notFound('ไม่พบผู้ใช้');
  if (action === 'reset-password') {
    const temporaryPassword = generatePassword(16);
    await db.batch([
      db.prepare("UPDATE users SET password_hash = ?, must_change_password = 1, failed_attempts = 0, locked_until = NULL, updated_at = datetime('now') WHERE id = ?").bind(await hashPassword(temporaryPassword), id),
      db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
    ]);
    await audit(c, 'user.password_reset', 'user', id);
    return c.json({ ok: true, temporaryPassword });
  }
  if (action === 'unlock') {
    await db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').bind(id).run();
    await audit(c, 'user.unlocked', 'user', id);
    return c.json({ ok: true });
  }
  await db.batch([
    db.prepare("UPDATE users SET mfa_enabled = 0, mfa_secret_enc = NULL, updated_at = datetime('now') WHERE id = ?").bind(id),
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
  ]);
  await audit(c, 'user.mfa_reset', 'user', id);
  return c.json({ ok: true });
}

adminRoutes.post('/users/:id/reset-password', requireSuperAdmin, (c) => adminAction(c, 'reset-password'));
adminRoutes.post('/users/:id/unlock', requireSuperAdmin, (c) => adminAction(c, 'unlock'));
adminRoutes.post('/users/:id/reset-mfa', requireSuperAdmin, (c) => adminAction(c, 'reset-mfa'));

// ---- Self-registration approvals ------------------------------------------------------------
async function pendingUser(db: D1Database, id: number): Promise<{ id: number; username: string }> {
  const u = await db.prepare("SELECT id, username FROM users WHERE id = ? AND approval_status = 'pending'").bind(id).first<{ id: number; username: string }>();
  if (!u) throw notFound('ไม่พบคำขอลงทะเบียนที่รออนุมัติ');
  return u;
}

adminRoutes.post('/users/:id/approve', requireSuperAdmin, async (c) => {
  const db = c.env.DB;
  const u = await pendingUser(db, intParam(c.req.param('id')));
  const body = await readJson(c);
  const ids = await roleIds(db, body.roles ?? []);
  if (!ids.length) throw badRequest('กรุณาเลือกบทบาทอย่างน้อย 1 บทบาทก่อนอนุมัติ');
  if (body.employeeId !== undefined && body.employeeId !== null && body.employeeId !== '') {
    const emp = await db.prepare('SELECT user_id FROM employees WHERE id = ?').bind(Number(body.employeeId)).first<{ user_id: number | null }>();
    if (!emp) throw badRequest('ไม่พบพนักงานที่จะผูก');
    if (emp.user_id !== null) throw conflict('พนักงานนี้ผูกกับบัญชีอื่นแล้ว');
  }
  await db.batch([
    db.prepare("UPDATE users SET approval_status = 'approved', active = 1, updated_at = datetime('now') WHERE id = ?").bind(u.id),
    db.prepare('DELETE FROM user_roles WHERE user_id = ?').bind(u.id),
    ...ids.map((rid) => db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').bind(u.id, rid)),
    ...(await linkEmployee(db, u.id, body.employeeId)),
  ]);
  await audit(c, 'user.registration_approved', 'user', u.id, { username: u.username, roles: body.roles });
  return c.json({ ok: true });
});

adminRoutes.post('/users/:id/reject', requireSuperAdmin, async (c) => {
  const db = c.env.DB;
  const u = await pendingUser(db, intParam(c.req.param('id')));
  await db.batch([
    db.prepare("UPDATE users SET approval_status = 'rejected', active = 0, updated_at = datetime('now') WHERE id = ?").bind(u.id),
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id),
  ]);
  await audit(c, 'user.registration_rejected', 'user', u.id, { username: u.username });
  return c.json({ ok: true });
});

// ---- Roles & permissions --------------------------------------------------------------------
adminRoutes.get('/roles', requireSuperAdmin, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.code, r.name, r.description, r.privileged, r.system,
       (SELECT group_concat(permission, ' ') FROM role_permissions p WHERE p.role_id = r.id) AS permissions,
       (SELECT COUNT(*) FROM user_roles ur WHERE ur.role_id = r.id) AS users
     FROM roles r ORDER BY r.id`,
  ).all<Record<string, string | number | null>>();
  return c.json({ roles: results.map((r) => ({ ...r, permissions: r.permissions ? String(r.permissions).split(' ').sort() : [] })), catalogue: permissionCatalogue() });
});

function parsePermissions(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.some((p) => typeof p !== 'string' || !PERMISSION_PATTERN.test(p))) throw badRequest('รูปแบบสิทธิ์ไม่ถูกต้อง (ตัวอย่าง: employees.view, payroll.*, *.view)');
  // user/role management stays with the super_admin role; no pattern may grant it to another role
  const reserved = (raw as string[]).filter((p) => RESERVED_PERMISSIONS.some((r) => permissionMatches(p, r)));
  if (reserved.length) throw badRequest(`สิทธิ์ ${reserved.join(', ')} สงวนไว้สำหรับ Super Admin เท่านั้น`);
  return [...new Set(raw as string[])];
}

adminRoutes.post('/roles', requireSuperAdmin, async (c) => {
  const body = await readJson(c);
  const code = str(body, 'code', { required: true, max: 50 }) as string;
  if (!/^[a-z][a-z0-9_]{2,49}$/.test(code)) throw badRequest('รหัสบทบาทใช้ได้เฉพาะ a-z 0-9 _');
  const name = str(body, 'name', { required: true, max: 100 }) as string;
  const perms = parsePermissions(body.permissions ?? []);
  if (perms.includes('*')) throw badRequest('สิทธิ์ * สงวนไว้สำหรับ Super Admin');
  const db = c.env.DB;
  try {
    const row = await db.prepare('INSERT INTO roles (code, name, description, privileged) VALUES (?, ?, ?, ?) RETURNING id')
      .bind(code, name, str(body, 'description', { max: 300 }), body.privileged ? 1 : 0)
      .first<{ id: number }>();
    if (perms.length) await db.batch(perms.map((p) => db.prepare('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)').bind(row?.id, p)));
    await audit(c, 'role.created', 'role', row?.id ?? null, { code, permissions: perms });
    return c.json({ id: row?.id }, 201);
  } catch (e) {
    if (e instanceof Error && /UNIQUE/i.test(e.message)) throw conflict('รหัสบทบาทซ้ำ');
    throw e;
  }
});

adminRoutes.put('/roles/:id', requireSuperAdmin, async (c) => {
  const id = intParam(c.req.param('id'));
  const db = c.env.DB;
  const role = await db.prepare('SELECT id, code FROM roles WHERE id = ?').bind(id).first<{ id: number; code: string }>();
  if (!role) throw notFound('ไม่พบบทบาท');
  if (role.code === ROLE.superAdmin) throw forbidden('สิทธิ์ของ Super Admin แก้ไขไม่ได้');
  const body = await readJson(c);
  const perms = parsePermissions(body.permissions);
  if (perms.includes('*')) throw badRequest('สิทธิ์ * สงวนไว้สำหรับ Super Admin');
  await db.batch([
    db.prepare('DELETE FROM role_permissions WHERE role_id = ?').bind(id),
    ...perms.map((p) => db.prepare('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)').bind(id, p)),
    db.prepare('UPDATE roles SET name = COALESCE(?, name), description = COALESCE(?, description), privileged = COALESCE(?, privileged) WHERE id = ?').bind(
      str(body, 'name', { max: 100 }),
      str(body, 'description', { max: 300 }),
      typeof body.privileged === 'boolean' ? (body.privileged ? 1 : 0) : null,
      id,
    ),
  ]);
  await audit(c, 'role.updated', 'role', id, { code: role.code, permissions: perms });
  return c.json({ ok: true });
});

// ---- Settings -------------------------------------------------------------------------------
adminRoutes.get('/settings', requirePerm('settings.manage'), async (c) => {
  const { results } = await c.env.DB.prepare('SELECT key, value, type, description FROM settings ORDER BY key').all<SettingItem>();
  return c.json(results);
});

adminRoutes.put('/settings', requirePerm('settings.manage'), async (c) => {
  const user = currentUser(c);
  const body = await readJson<Record<string, unknown>>(c);
  const { results } = await c.env.DB.prepare('SELECT key, value, type FROM settings').all<SettingItem>();
  const known = new Map(results.map((s) => [s.key, s]));
  const changes: Array<{ key: string; from: string; to: string }> = [];
  for (const [key, raw] of Object.entries(body)) {
    const s = known.get(key);
    if (!s) throw badRequest(`ไม่รู้จักค่าตั้ง ${key}`);
    let value: string;
    if (s.type === 'bool') {
      if (typeof raw !== 'boolean' && raw !== 'true' && raw !== 'false') throw badRequest(`${key} ต้องเป็น true/false`);
      value = String(raw === true || raw === 'true');
    } else if (s.type === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) throw badRequest(`${key} ต้องเป็นตัวเลขไม่ติดลบ`);
      value = String(n);
    } else {
      if (typeof raw !== 'string' || raw.length > 300) throw badRequest(`${key} ต้องเป็นข้อความไม่เกิน 300 ตัวอักษร`);
      value = raw.trim();
    }
    if (value !== s.value) changes.push({ key, from: s.value, to: value });
  }
  if (changes.length) {
    await c.env.DB.batch(changes.map((ch) => c.env.DB.prepare("UPDATE settings SET value = ?, updated_at = datetime('now'), updated_by = ? WHERE key = ?").bind(ch.to, user.id, ch.key)));
    await audit(c, 'settings.updated', 'settings', null, { changes });
  }
  return c.json({ ok: true, changed: changes.length });
});
