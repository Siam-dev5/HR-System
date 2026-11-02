import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AppEnv, AuthUser } from './env';
import { base64url, randomBytes, sha256Hex } from '../shared/crypto';
import { hasPermission } from '../shared/permissions';
import type { ModuleDef } from '../shared/modules';
import { canOpenModule, isSuperAdmin } from '../shared/modules';
import { HttpError, forbidden, unauthorized } from './lib/http';
import { sqlDateTime } from './lib/time';

export const SESSION_COOKIE = 'hr_session';

export function can(user: AuthUser | null, permission: string): boolean {
  return !!user && hasPermission(user.permissions, permission);
}

export async function createSession(c: Context<AppEnv>, userId: number, mfaPending: boolean, hours: number): Promise<void> {
  const token = base64url(randomBytes(32));
  const id = await sha256Hex(token);
  await c.env.DB.prepare('INSERT INTO sessions (id, user_id, mfa_pending, ip, user_agent, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, userId, mfaPending ? 1 : 0, c.req.header('cf-connecting-ip') ?? null, (c.req.header('user-agent') ?? '').slice(0, 200), sqlDateTime(hours * 60))
    .run();
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Strict',
    path: '/',
    maxAge: hours * 3600,
  });
}

export async function destroySession(c: Context<AppEnv>): Promise<void> {
  const user = c.get('user');
  if (user) await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(user.sessionId).run();
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  active: number;
  mfa_enabled: number;
  must_change_password: number;
  mfa_pending: number;
  employee_id: number | null;
}

export async function loadAuthUser(db: D1Database, userId: number, sessionId: string, mfaPending: boolean): Promise<AuthUser | null> {
  const row = await db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.active, u.mfa_enabled, u.must_change_password, ? AS mfa_pending,
              (SELECT e.id FROM employees e WHERE e.user_id = u.id) AS employee_id
       FROM users u WHERE u.id = ?`,
    )
    .bind(mfaPending ? 1 : 0, userId)
    .first<UserRow>();
  if (!row || !row.active) return null;
  const { results: roles } = await db
    .prepare('SELECT r.id, r.code, r.privileged FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ?')
    .bind(userId)
    .all<{ id: number; code: string; privileged: number }>();
  const { results: perms } = await db
    .prepare('SELECT DISTINCT rp.permission FROM role_permissions rp JOIN user_roles ur ON ur.role_id = rp.role_id WHERE ur.user_id = ?')
    .bind(userId)
    .all<{ permission: string }>();
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    employeeId: row.employee_id,
    roles: roles.map((r) => r.code),
    permissions: perms.map((p) => p.permission),
    privileged: roles.some((r) => r.privileged === 1),
    mfaEnabled: row.mfa_enabled === 1,
    mustChangePassword: row.must_change_password === 1,
    mfaPending: row.mfa_pending === 1,
    sessionId,
  };
}

/** Resolves the session cookie into c.var.user (or null). */
export const sessionMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('user', null);
  const token = getCookie(c, SESSION_COOKIE);
  if (token && token.length <= 100) {
    const id = await sha256Hex(token);
    const s = await c.env.DB.prepare("SELECT user_id, mfa_pending FROM sessions WHERE id = ? AND expires_at > datetime('now')")
      .bind(id)
      .first<{ user_id: number; mfa_pending: number }>();
    if (s) c.set('user', await loadAuthUser(c.env.DB, s.user_id, id, s.mfa_pending === 1));
  }
  await next();
};

// Endpoints reachable while a session is restricted (MFA enrolment pending / password change required).
const RESTRICTED_ALLOW = ['/api/auth/me', '/api/auth/logout', '/api/auth/policy', '/api/auth/change-password', '/api/security/mfa/setup', '/api/security/mfa/enable', '/api/security/status'];

/** Requires a full session; restricted sessions may only reach the allow-list above. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get('user');
  if (!user) throw unauthorized();
  if (!RESTRICTED_ALLOW.includes(c.req.path)) {
    if (user.mfaPending) throw new HttpError(403, 'mfa_enrollment_required', 'บทบาทของคุณต้องตั้งค่า MFA ก่อนใช้งาน');
    if (user.mustChangePassword) throw new HttpError(403, 'password_change_required', 'กรุณาเปลี่ยนรหัสผ่านก่อนใช้งาน');
  }
  await next();
};

/** Requires at least one of the given permissions. */
export function requirePerm(...permissions: string[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get('user');
    if (!user) throw unauthorized();
    if (!permissions.some((p) => can(user, p))) throw forbidden(`ต้องมีสิทธิ์ ${permissions.join(' หรือ ')}`);
    await next();
  };
}

/**
 * User / role / permission management: the super_admin role itself is required. Permission patterns are
 * deliberately not enough, so a mis-configured role (e.g. "users.manage" granted by SQL) still gets 403.
 */
export const requireSuperAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get('user');
  if (!user) throw unauthorized();
  if (!isSuperAdmin(user.roles)) throw forbidden('เฉพาะ Super Admin เท่านั้นที่จัดการผู้ใช้ บทบาท และสิทธิ์ได้');
  await next();
};

export function canOpen(user: AuthUser, m: ModuleDef): boolean {
  return canOpenModule(m, user.permissions, user.roles);
}

export function currentUser(c: Context<AppEnv>): AuthUser {
  const u = c.get('user');
  if (!u) throw unauthorized();
  return u;
}
