// Step-up MFA for high-impact actions: a fresh TOTP code with every request, accepted once per action and target,
// and repeated failures are throttled. Verified against the secret stored now, not the state captured at login.
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { decryptString } from '../../shared/crypto';
import { totpCounter } from '../../shared/totp';
import { audit } from './audit';
import { HttpError } from './http';

const MAX_FAILURES = 5;
const WINDOW_MINUTES = 15;

export async function verifyStepUp(c: Context<AppEnv>, code: unknown, action: string, target: string | number): Promise<void> {
  const user = c.get('user');
  if (!user) throw new HttpError(401, 'unauthorized', 'กรุณาเข้าสู่ระบบ');
  const db = c.env.DB;
  if (typeof code !== 'string' || !code.trim()) throw new HttpError(403, 'mfa_step_up_required', 'กรุณากรอกรหัส MFA (6 หลัก) เพื่อยืนยันตัวตนก่อนดำเนินการ');
  const failures = await db
    .prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE user_id = ? AND action = 'mfa.step_up_failed' AND at > datetime('now', '-${WINDOW_MINUTES} minutes')`)
    .bind(user.id)
    .first<{ n: number }>();
  if ((failures?.n ?? 0) >= MAX_FAILURES) throw new HttpError(429, 'mfa_step_up_locked', `กรอกรหัส MFA ผิดหลายครั้ง กรุณารอ ${WINDOW_MINUTES} นาที`);
  const key = c.env.MFA_ENCRYPTION_KEY;
  const row = await db.prepare('SELECT mfa_enabled, mfa_secret_enc FROM users WHERE id = ?').bind(user.id).first<{ mfa_enabled: number; mfa_secret_enc: string | null }>();
  if (!key || !row?.mfa_enabled || !row.mfa_secret_enc) throw new HttpError(403, 'mfa_enrollment_required', 'ต้องเปิดใช้ MFA ก่อนดำเนินการ');
  const counter = await totpCounter(await decryptString(row.mfa_secret_enc, key), code);
  if (counter === null) {
    await audit(c, 'mfa.step_up_failed', 'user', user.id, { action, target: String(target) });
    throw new HttpError(403, 'mfa_invalid', 'รหัส MFA ไม่ถูกต้อง');
  }
  try {
    await db.prepare('INSERT INTO mfa_step_up (user_id, counter, action, target) VALUES (?, ?, ?, ?)').bind(user.id, counter, action, String(target)).run();
  } catch (e) {
    if (e instanceof Error && /UNIQUE|PRIMARY KEY|constraint/i.test(e.message)) {
      throw new HttpError(409, 'mfa_code_used', 'รหัส MFA นี้ถูกใช้กับรายการนี้แล้ว (ป้องกันการทำซ้ำ) กรุณารอรหัสถัดไป');
    }
    throw e;
  }
}
