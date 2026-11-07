// Maker-checker for approvals: whoever created, recorded, calculated or requested a record does not approve it.
// The one exception is the Super Admin role, the highest authority (nobody above it could approve their records):
// a Super Admin may approve a record they created, with an approval note, and the audit marks it as a self-approval.
// The exception follows membership of the super_admin role itself — never a permission — so wildcard permissions
// (HR Admin's *.update, …) and the HR Admin / HR Leader / HR Payroll / Manager roles never inherit it.
import type { Context } from 'hono';
import type { AppEnv, AuthUser } from '../env';
import { isSuperAdmin } from '../../shared/modules';
import { badRequest, forbidden } from './http';

export interface ApprovalCheck {
  /** the approver is the maker (allowed only for a Super Admin) */
  selfApproved: boolean;
  note: string | null;
}

/**
 * Body of an approval call. Approve calls never needed a body, so no body — or an empty one sent with
 * Content-Type: application/json — is read as {}; a body that is present must be a JSON object (400 otherwise).
 */
export async function approvalBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  if (!(c.req.header('content-type') ?? '').includes('application/json')) return {};
  const text = (await c.req.text()).trim();
  if (!text) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw badRequest('รูปแบบ JSON ไม่ถูกต้อง');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw badRequest('รูปแบบ JSON ไม่ถูกต้อง');
  return body as Record<string, unknown>;
}

export const approvalNote = (body: Record<string, unknown>, key = 'note'): string | null => {
  const v = body[key];
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : null;
};

/**
 * Throws 403 when the approver is the maker and is not a Super Admin; a Super Admin approving their own record must
 * give a note (kept in the audit). `makers` are every user who made the record (creator, requester, …).
 */
export function checkMakerChecker(user: AuthUser, makers: ReadonlyArray<number | null | undefined>, note: string | null, message: string): ApprovalCheck {
  if (!makers.some((m) => m !== null && m !== undefined && m === user.id)) return { selfApproved: false, note };
  if (!isSuperAdmin(user.roles)) throw forbidden(message);
  if (!note || note.length < 3) throw badRequest('Super Admin อนุมัติรายการที่ตนเองสร้าง ต้องระบุบันทึกการอนุมัติ (อย่างน้อย 3 ตัวอักษร)');
  return { selfApproved: true, note };
}
