import { Hono } from 'hono';
import type { AppEnv, AuthUser } from '../env';
import type { LoginResponse, Me } from '../../shared/types';
import { decryptString, encryptString, hashPassword, verifyPassword } from '../../shared/crypto';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../../shared/totp';
import { HttpError, badRequest, conflict, readJson, str, unauthorized } from '../lib/http';
import { audit } from '../lib/audit';
import { authPolicy, loadSettings, settingNumber, validatePassword } from '../lib/settings';
import { sqlDateTime } from '../lib/time';
import { createSession, currentUser, destroySession, loadAuthUser, requireAuth } from '../auth';

export function toMe(u: AuthUser): Me {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    employeeId: u.employeeId,
    roles: u.roles,
    permissions: u.permissions,
    mfaEnabled: u.mfaEnabled,
    mfaPending: u.mfaPending,
    mustChangePassword: u.mustChangePassword,
  };
}

interface LoginRow {
  id: number;
  username: string;
  password_hash: string;
  active: number;
  failed_attempts: number;
  locked_until: string | null;
  mfa_enabled: number;
  mfa_secret_enc: string | null;
}

// Used to keep timing similar when the username does not exist.
const DUMMY_HASH = 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export const authRoutes = new Hono<AppEnv>();

authRoutes.get('/policy', async (c) => c.json(authPolicy(await loadSettings(c.env.DB))));

authRoutes.post('/login', async (c) => {
  const body = await readJson(c);
  const username = str(body, 'username', { required: true, max: 100 }) as string;
  const password = typeof body.password === 'string' ? body.password : '';
  const totp = typeof body.totp === 'string' ? body.totp : null;
  if (!password) throw badRequest('กรุณาระบุรหัสผ่าน');

  const settings = await loadSettings(c.env.DB);
  const policy = authPolicy(settings);
  const row = await c.env.DB.prepare(
    'SELECT id, username, password_hash, active, failed_attempts, locked_until, mfa_enabled, mfa_secret_enc FROM users WHERE username = ?',
  )
    .bind(username)
    .first<LoginRow>();
  const invalid = () => unauthorized('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');

  if (!row || !row.active) {
    await verifyPassword(password, DUMMY_HASH);
    await audit(c, 'auth.login_failed', 'user', null, { username, reason: row ? 'inactive' : 'unknown_user' }, { id: null, username });
    throw invalid();
  }
  const actor = { id: row.id, username: row.username };
  if (row.locked_until && row.locked_until > sqlDateTime()) {
    await audit(c, 'auth.login_locked', 'user', row.id, undefined, actor);
    throw new HttpError(423, 'account_locked', `บัญชีถูกล็อกชั่วคราวเนื่องจากใส่รหัสผ่านผิด ${policy.lockoutThreshold} ครั้ง กรุณาลองใหม่ภายหลัง`);
  }

  const registerFailure = async (reason: string) => {
    const attempts = row.failed_attempts + 1;
    const lock = attempts >= policy.lockoutThreshold;
    await c.env.DB.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?')
      .bind(lock ? 0 : attempts, lock ? sqlDateTime(policy.lockoutMinutes) : null, row.id)
      .run();
    await audit(c, lock ? 'auth.account_locked' : 'auth.login_failed', 'user', row.id, { reason, attempts }, actor);
    if (lock) throw new HttpError(423, 'account_locked', `ใส่รหัสผ่านผิดครบ ${policy.lockoutThreshold} ครั้ง บัญชีถูกล็อก ${policy.lockoutMinutes} นาที`);
  };

  if (!(await verifyPassword(password, row.password_hash))) {
    await registerFailure('bad_password');
    throw invalid();
  }

  if (row.mfa_enabled) {
    if (!totp) return c.json<LoginResponse>({ status: 'mfa_required' });
    const key = c.env.MFA_ENCRYPTION_KEY;
    if (!key || !row.mfa_secret_enc) throw new HttpError(500, 'mfa_misconfigured', 'ระบบ MFA ยังไม่ได้ตั้งค่ากุญแจเข้ารหัส');
    if (!(await verifyTotp(await decryptString(row.mfa_secret_enc, key), totp))) {
      await registerFailure('bad_totp');
      throw unauthorized('รหัส MFA ไม่ถูกต้อง');
    }
  }

  await c.env.DB.prepare("UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = datetime('now') WHERE id = ?").bind(row.id).run();
  const probe = await loadAuthUser(c.env.DB, row.id, '', false);
  if (!probe) throw invalid();
  const mfaPending = !probe.mfaEnabled && probe.privileged && policy.mfaEnforcedForPrivileged;
  await createSession(c, row.id, mfaPending, settingNumber(settings, 'security.session_hours', 12));
  await audit(c, 'auth.login', 'user', row.id, { mfa: probe.mfaEnabled, mfaEnrollmentRequired: mfaPending }, actor);
  const me = toMe({ ...probe, mfaPending });
  return c.json<LoginResponse>(mfaPending ? { status: 'mfa_enroll_required', me } : { status: 'ok', me });
});

authRoutes.post('/logout', async (c) => {
  const user = c.get('user');
  if (user) await audit(c, 'auth.logout', 'user', user.id);
  await destroySession(c);
  return c.json({ ok: true });
});

authRoutes.get('/me', requireAuth, (c) => c.json(toMe(currentUser(c))));

/** Session probe for the SPA: 200 with me = null when signed out (no 401 noise on the login page). */
authRoutes.get('/session', (c) => {
  const user = c.get('user');
  return c.json<{ me: Me | null }>({ me: user ? toMe(user) : null });
});

authRoutes.post('/change-password', requireAuth, async (c) => {
  const user = currentUser(c);
  const body = await readJson(c);
  const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const next = typeof body.newPassword === 'string' ? body.newPassword : '';
  const policy = authPolicy(await loadSettings(c.env.DB));
  const row = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(user.id).first<{ password_hash: string }>();
  if (!row || !(await verifyPassword(current, row.password_hash))) throw badRequest('รหัสผ่านปัจจุบันไม่ถูกต้อง');
  const problem = validatePassword(next, policy.passwordMinLength);
  if (problem) throw badRequest(problem);
  if (await verifyPassword(next, row.password_hash)) throw badRequest('รหัสผ่านใหม่ต้องไม่ซ้ำรหัสผ่านเดิม');
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").bind(await hashPassword(next), user.id),
    // sign out every other session of this user
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').bind(user.id, user.sessionId),
  ]);
  await audit(c, 'auth.password_changed', 'user', user.id);
  return c.json({ ok: true });
});

// ---- Security / MFA (self-service) -----------------------------------------------------------
export const securityRoutes = new Hono<AppEnv>();
securityRoutes.use('*', requireAuth);

securityRoutes.get('/status', async (c) => {
  const user = currentUser(c);
  const policy = authPolicy(await loadSettings(c.env.DB));
  const { results } = await c.env.DB.prepare('SELECT id, ip, user_agent, created_at, expires_at FROM sessions WHERE user_id = ? AND expires_at > datetime(\'now\') ORDER BY created_at DESC')
    .bind(user.id)
    .all<{ id: string; ip: string | null; user_agent: string | null; created_at: string; expires_at: string }>();
  return c.json({
    mfaEnabled: user.mfaEnabled,
    mfaRequired: policy.mfaEnforcedForPrivileged && user.privileged,
    mfaAvailable: !!c.env.MFA_ENCRYPTION_KEY,
    policy,
    sessions: results.map((s) => ({ ip: s.ip, userAgent: s.user_agent, createdAt: s.created_at, expiresAt: s.expires_at, current: s.id === user.sessionId })),
  });
});

securityRoutes.post('/mfa/setup', async (c) => {
  const user = currentUser(c);
  if (user.mfaEnabled) throw conflict('เปิดใช้ MFA อยู่แล้ว');
  const key = c.env.MFA_ENCRYPTION_KEY;
  if (!key) throw new HttpError(503, 'mfa_unavailable', 'ผู้ดูแลระบบยังไม่ได้ตั้งค่า MFA_ENCRYPTION_KEY');
  const secret = generateTotpSecret();
  await c.env.DB.prepare('UPDATE users SET mfa_secret_enc = ? WHERE id = ?').bind(await encryptString(secret, key), user.id).run();
  await audit(c, 'mfa.setup_started', 'user', user.id);
  return c.json({ secret, otpauthUrl: otpauthUrl(secret, user.username, c.env.APP_NAME || 'HR System') });
});

securityRoutes.post('/mfa/enable', async (c) => {
  const user = currentUser(c);
  const body = await readJson(c);
  const code = str(body, 'code', { required: true, max: 10 }) as string;
  const key = c.env.MFA_ENCRYPTION_KEY;
  const row = await c.env.DB.prepare('SELECT mfa_secret_enc FROM users WHERE id = ?').bind(user.id).first<{ mfa_secret_enc: string | null }>();
  if (!key || !row?.mfa_secret_enc) throw badRequest('กรุณาเริ่มตั้งค่า MFA ก่อน');
  if (!(await verifyTotp(await decryptString(row.mfa_secret_enc, key), code))) throw badRequest('รหัส MFA ไม่ถูกต้อง');
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET mfa_enabled = 1, updated_at = datetime('now') WHERE id = ?").bind(user.id),
    c.env.DB.prepare('UPDATE sessions SET mfa_pending = 0 WHERE user_id = ?').bind(user.id),
  ]);
  await audit(c, 'mfa.enabled', 'user', user.id);
  return c.json({ ok: true });
});

securityRoutes.post('/mfa/disable', async (c) => {
  const user = currentUser(c);
  const policy = authPolicy(await loadSettings(c.env.DB));
  if (policy.mfaEnforcedForPrivileged && user.privileged) throw conflict('นโยบายของระบบบังคับใช้ MFA สำหรับบทบาทของคุณ จึงปิด MFA ไม่ได้');
  const body = await readJson(c);
  const password = typeof body.password === 'string' ? body.password : '';
  const row = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(user.id).first<{ password_hash: string }>();
  if (!row || !(await verifyPassword(password, row.password_hash))) throw badRequest('รหัสผ่านไม่ถูกต้อง');
  await c.env.DB.prepare("UPDATE users SET mfa_enabled = 0, mfa_secret_enc = NULL, updated_at = datetime('now') WHERE id = ?").bind(user.id).run();
  await audit(c, 'mfa.disabled', 'user', user.id);
  return c.json({ ok: true });
});
