// App Management (Super Admin only): read models for users, roles, the permission matrix, company scope, security and
// the security audit trail, plus the account actions that have no endpoint elsewhere. Creating / editing users and
// roles stays on the existing Admin API (routes/admin.ts), so there is one write path and one set of safeguards.
// Every route requires a full session and the super_admin role itself (never a permission pattern).
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import type { AppAuditRow, AppOverview, AppRole, AppUserDetail } from '../../shared/app-management';
import { MATRIX_ACTIONS, SECURITY_AUDIT_PREFIXES, permissionMatrix } from '../../shared/app-management';
import { RESERVED_PERMISSIONS, permissionCatalogue } from '../../shared/modules';
import { hasPermission } from '../../shared/permissions';
import { badRequest, conflict, intParam, notFound, readJson } from '../lib/http';
import { audit } from '../lib/audit';
import { authPolicy, loadSettings } from '../lib/settings';
import { USER_COLUMNS, decorateUsers, loadUserRow, stateOf, userPatterns } from '../lib/user-admin';
import { currentUser, requireAuth, requireSuperAdmin } from '../auth';

export const appManagementRoutes = new Hono<AppEnv>();
appManagementRoutes.use('*', requireAuth, requireSuperAdmin);

const AUDIT_SQL = `SELECT id, at, user_id, username, action, entity, entity_id, details, ip FROM audit_logs`;
const securityWhere = `(${SECURITY_AUDIT_PREFIXES.map(() => 'action LIKE ?').join(' OR ')})`;
const securityParams = SECURITY_AUDIT_PREFIXES.map((p) => `${p}%`);

const STATUS = ['active', 'inactive', 'pending', 'rejected', 'locked', 'must_change'] as const;

// ---- Overview ----------------------------------------------------------------------------------------------------
appManagementRoutes.get('/overview', async (c) => {
  const db = c.env.DB;
  const [u, r, co, sa, priv, recent] = await db.batch([
    db.prepare(`SELECT COUNT(*) total, COALESCE(SUM(active = 1 AND approval_status = 'approved'), 0) active, COALESCE(SUM(active = 0), 0) inactive,
      COALESCE(SUM(approval_status = 'pending'), 0) pending, COALESCE(SUM(locked_until > datetime('now')), 0) locked,
      COALESCE(SUM(mfa_enabled = 1), 0) mfa, COALESCE(SUM(must_change_password = 1), 0) must FROM users`),
    db.prepare('SELECT COUNT(*) total, COALESCE(SUM(system = 1), 0) system FROM roles'),
    db.prepare('SELECT COUNT(*) n FROM companies WHERE active = 1'),
    db.prepare("SELECT COUNT(DISTINCT u.id) n FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE r.code = 'super_admin' AND u.active = 1"),
    db.prepare('SELECT COUNT(DISTINCT u.id) n FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE r.privileged = 1 AND u.active = 1 AND u.mfa_enabled = 0'),
    db.prepare(`${AUDIT_SQL} WHERE ${securityWhere} ORDER BY id DESC LIMIT 8`).bind(...securityParams),
  ]);
  const one = (x: D1Result | undefined) => (x?.results?.[0] ?? {}) as Record<string, number>;
  const users = one(u);
  const roles = one(r);
  const policy = authPolicy(await loadSettings(db));
  return c.json<AppOverview>({
    users: {
      total: users.total ?? 0, active: users.active ?? 0, inactive: users.inactive ?? 0, pending: users.pending ?? 0, locked: users.locked ?? 0,
      mfaEnabled: users.mfa ?? 0, mustChange: users.must ?? 0, privilegedWithoutMfa: one(priv).n ?? 0, superAdmins: one(sa).n ?? 0,
    },
    roles: { total: roles.total ?? 0, system: roles.system ?? 0, custom: (roles.total ?? 0) - (roles.system ?? 0) },
    permissions: { catalogue: permissionCatalogue().length, reserved: RESERVED_PERMISSIONS.length },
    companies: one(co).n ?? 0,
    policy,
    mfaAvailable: !!c.env.MFA_ENCRYPTION_KEY,
    recent: (recent?.results ?? []) as unknown as AppAuditRow[],
  });
});

// ---- Users -------------------------------------------------------------------------------------------------------
appManagementRoutes.get('/users', async (c) => {
  const where: string[] = ['1'];
  const params: unknown[] = [];
  const q = (c.req.query('q') ?? '').trim();
  if (q.length > 100) throw badRequest('คำค้นยาวเกินไป');
  if (q) {
    where.push(`(u.username LIKE ? OR u.display_name LIKE ? OR u.email LIKE ? OR EXISTS (SELECT 1 FROM employees e WHERE e.user_id = u.id AND (e.emp_code LIKE ? OR e.first_name LIKE ? OR e.last_name LIKE ?)))`);
    params.push(...Array(6).fill(`%${q}%`));
  }
  const role = c.req.query('role');
  if (role) {
    if (!/^[a-z][a-z0-9_]{1,49}$/.test(role)) throw badRequest('รหัสบทบาทไม่ถูกต้อง');
    where.push('EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.code = ?)');
    params.push(role);
  }
  const status = c.req.query('status');
  if (status) {
    if (!(STATUS as readonly string[]).includes(status)) throw badRequest('สถานะไม่ถูกต้อง');
    where.push({
      active: "u.active = 1 AND u.approval_status = 'approved'",
      inactive: 'u.active = 0',
      pending: "u.approval_status = 'pending'",
      rejected: "u.approval_status = 'rejected'",
      locked: "u.locked_until > datetime('now')",
      must_change: 'u.must_change_password = 1',
    }[status as (typeof STATUS)[number]]);
  }
  const mfa = c.req.query('mfa');
  if (mfa) {
    if (mfa !== 'on' && mfa !== 'off') throw badRequest('ตัวกรอง MFA ไม่ถูกต้อง');
    where.push(mfa === 'on' ? 'u.mfa_enabled = 1' : 'u.mfa_enabled = 0');
  }
  const { results } = await c.env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users u WHERE ${where.join(' AND ')} ORDER BY (u.approval_status = 'pending') DESC, u.username LIMIT 500`)
    .bind(...params)
    .all<Parameters<typeof decorateUsers>[1][number]>();
  return c.json(await decorateUsers(c.env.DB, results));
});

appManagementRoutes.get('/users/:id', async (c) => {
  const db = c.env.DB;
  const id = intParam(c.req.param('id'));
  const row = await loadUserRow(db, id);
  if (!row) throw notFound('ไม่พบผู้ใช้');
  const [sec, sessions, log] = await db.batch([
    db.prepare('SELECT failed_attempts, password_changed_at FROM users WHERE id = ?').bind(id),
    db.prepare("SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND expires_at > datetime('now')").bind(id),
    db.prepare(`${AUDIT_SQL} WHERE ((entity = 'user' AND entity_id = ?) OR user_id = ?) AND ${securityWhere} ORDER BY id DESC LIMIT 30`).bind(String(id), id, ...securityParams),
  ]);
  const s = (sec?.results?.[0] ?? {}) as { failed_attempts?: number; password_changed_at?: string | null };
  const patterns = await userPatterns(db, id);
  return c.json<AppUserDetail>({
    ...row,
    failed_attempts: s.failed_attempts ?? 0,
    password_changed_at: s.password_changed_at ?? null,
    active_sessions: ((sessions?.results?.[0] ?? {}) as { n?: number }).n ?? 0,
    role_patterns: patterns,
    effective_permissions: [...permissionCatalogue(), ...RESERVED_PERMISSIONS].filter((p) => hasPermission(patterns, p)).sort(),
    audit: (log?.results ?? []) as unknown as AppAuditRow[],
  });
});

/** Requires a password change at the next request (the current password keeps working until then; nothing is revealed). */
appManagementRoutes.post('/users/:id/require-password-change', async (c) => {
  const db = c.env.DB;
  const id = intParam(c.req.param('id'));
  const u = await db.prepare('SELECT id, username, must_change_password FROM users WHERE id = ?').bind(id).first<{ id: number; username: string; must_change_password: number }>();
  if (!u) throw notFound('ไม่พบผู้ใช้');
  if (u.id === currentUser(c).id) throw conflict('บังคับเปลี่ยนรหัสผ่านของตนเองไม่ได้ ใช้เมนูความปลอดภัยของบัญชีแทน');
  if (u.must_change_password === 1) return c.json({ ok: true, changed: false });
  await db.prepare("UPDATE users SET must_change_password = 1, updated_at = datetime('now') WHERE id = ?").bind(id).run();
  await audit(c, 'user.password_change_required', 'user', id, { username: u.username, before: false, after: true });
  return c.json({ ok: true, changed: true });
});

// ---- Company scope -----------------------------------------------------------------------------------------------
appManagementRoutes.get('/company-scope', async (c) => {
  const db = c.env.DB;
  const { results: companies } = await db.prepare('SELECT id, code, name, active FROM companies ORDER BY code').all<{ id: number; code: string; name: string; active: number }>();
  const { results } = await db.prepare(`SELECT ${USER_COLUMNS} FROM users u WHERE u.approval_status <> 'rejected' ORDER BY u.username LIMIT 500`).all<Parameters<typeof decorateUsers>[1][number]>();
  const users = await decorateUsers(db, results);
  // roles granting organisation-wide scope, decided by the same matcher the API uses (patterns included)
  const { results: grants } = await db.prepare('SELECT r.code, r.name, group_concat(rp.permission, \' \') AS perms FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id GROUP BY r.id ORDER BY r.code')
    .all<{ code: string; name: string; perms: string | null }>();
  const allCompanyRoles = grants.filter((r) => hasPermission((r.perms ?? '').split(' ').filter(Boolean), 'employees.all')).map((r) => ({ code: r.code, name: r.name }));
  return c.json({ companies, users, allCompanyRoles });
});

/**
 * Company scope in the existing data model: organisation-wide comes from a role holding employees.all; otherwise the
 * scope is the company of the linked employee. This endpoint changes the employee link (own-company scope), validated
 * on the server: the employee must exist, must not belong to another account, and must be in the stated company.
 */
appManagementRoutes.put('/users/:id/company-scope', async (c) => {
  const db = c.env.DB;
  const id = intParam(c.req.param('id'));
  const before = await loadUserRow(db, id);
  if (!before) throw notFound('ไม่พบผู้ใช้');
  const body = await readJson(c);
  const raw = body.employeeId;
  const employeeId = raw === null || raw === '' ? null : Number(raw);
  if (employeeId !== null && (!Number.isInteger(employeeId) || employeeId <= 0)) throw badRequest('employeeId ไม่ถูกต้อง');
  const companyId = body.companyId === undefined || body.companyId === null || body.companyId === '' ? null : Number(body.companyId);
  if (companyId !== null && (!Number.isInteger(companyId) || companyId <= 0)) throw badRequest('companyId ไม่ถูกต้อง');
  const stmts: D1PreparedStatement[] = [db.prepare('UPDATE employees SET user_id = NULL WHERE user_id = ?').bind(id)];
  if (employeeId !== null) {
    const emp = await db.prepare('SELECT id, user_id, company_id FROM employees WHERE id = ?').bind(employeeId).first<{ id: number; user_id: number | null; company_id: number | null }>();
    if (!emp) throw badRequest('ไม่พบพนักงานที่จะผูก');
    if (emp.user_id !== null && emp.user_id !== id) throw conflict('พนักงานนี้ผูกกับบัญชีอื่นแล้ว');
    if (companyId !== null && emp.company_id !== companyId) throw badRequest('พนักงานไม่ได้อยู่ในบริษัทที่ระบุ');
    const co = emp.company_id === null ? null : await db.prepare('SELECT id FROM companies WHERE id = ?').bind(emp.company_id).first();
    if (!co) throw badRequest('พนักงานนี้ไม่มีบริษัทที่ถูกต้อง');
    stmts.push(db.prepare('UPDATE employees SET user_id = ? WHERE id = ? AND (user_id IS NULL OR user_id = ?)').bind(id, employeeId, id));
  } else if (companyId !== null) {
    throw badRequest('ระบุบริษัทได้เฉพาะเมื่อผูกพนักงาน');
  }
  await db.batch(stmts);
  const after = await loadUserRow(db, id);
  if (!after) throw notFound('ไม่พบผู้ใช้');
  const b = stateOf(before);
  const a = stateOf(after);
  if (b.employee_id !== a.employee_id) await audit(c, 'user.employee_link_changed', 'user', id, { username: after.username, before: b.employee_id, after: a.employee_id });
  if (JSON.stringify(b.scope) !== JSON.stringify(a.scope)) await audit(c, 'user.company_scope_changed', 'user', id, { username: after.username, before: b.scope, after: a.scope });
  return c.json(after);
});

// ---- Roles and the permission matrix -----------------------------------------------------------------------------
appManagementRoutes.get('/permissions', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.code, r.name, r.description, r.privileged, r.system,
       (SELECT COUNT(*) FROM user_roles ur WHERE ur.role_id = r.id) AS users,
       (SELECT group_concat(permission, ' ') FROM role_permissions p WHERE p.role_id = r.id) AS permissions
     FROM roles r ORDER BY r.id`,
  ).all<Omit<AppRole, 'permissions'> & { permissions: string | null }>();
  const roles: AppRole[] = results.map((r) => ({ ...r, permissions: r.permissions ? r.permissions.split(' ').sort() : [] }));
  return c.json({ actions: MATRIX_ACTIONS, groups: permissionMatrix(), catalogue: permissionCatalogue(), reserved: RESERVED_PERMISSIONS, roles });
});

// ---- Security ----------------------------------------------------------------------------------------------------
appManagementRoutes.get('/security', async (c) => {
  const db = c.env.DB;
  const { results } = await db.prepare(`SELECT ${USER_COLUMNS} FROM users u WHERE u.approval_status = 'approved' ORDER BY u.username LIMIT 500`).all<Parameters<typeof decorateUsers>[1][number]>();
  const users = await decorateUsers(db, results);
  const { results: extra } = await db.prepare(
    "SELECT u.id, u.failed_attempts, u.password_changed_at, (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > datetime('now')) AS sessions FROM users u",
  ).all<{ id: number; failed_attempts: number; password_changed_at: string | null; sessions: number }>();
  const byId = new Map(extra.map((x) => [x.id, x]));
  const policy = authPolicy(await loadSettings(db));
  return c.json({
    policy,
    mfaAvailable: !!c.env.MFA_ENCRYPTION_KEY,
    users: users.map((u) => ({
      ...u,
      failed_attempts: byId.get(u.id)?.failed_attempts ?? 0,
      password_changed_at: byId.get(u.id)?.password_changed_at ?? null,
      active_sessions: byId.get(u.id)?.sessions ?? 0,
      mfa_required: policy.mfaEnforcedForPrivileged && u.privileged,
    })),
  });
});

// ---- Audit -------------------------------------------------------------------------------------------------------
appManagementRoutes.get('/audit', async (c) => {
  const where: string[] = [securityWhere];
  const params: unknown[] = [...securityParams];
  const userId = c.req.query('userId');
  if (userId) {
    const uid = intParam(userId, 'userId');
    where.push("((entity = 'user' AND entity_id = ?) OR user_id = ?)");
    params.push(String(uid), uid);
  }
  const action = c.req.query('action');
  if (action) {
    if (!/^[a-z_]+(\.[a-z_]+)*\.?$/.test(action) || action.length > 60) throw badRequest('action ไม่ถูกต้อง');
    where.push('action LIKE ?');
    params.push(`${action}%`);
  }
  const page = Math.max(1, Math.min(10_000, Number(c.req.query('page')) || 1));
  const pageSize = 50;
  const db = c.env.DB;
  const total = await db.prepare(`SELECT COUNT(*) n FROM audit_logs WHERE ${where.join(' AND ')}`).bind(...params).first<{ n: number }>();
  const { results } = await db.prepare(`${AUDIT_SQL} WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`).bind(...params, pageSize, (page - 1) * pageSize).all<AppAuditRow>();
  return c.json({ rows: results, total: total?.n ?? 0, page, pageSize });
});
