// Employee photographs: private R2 bytes + D1 metadata, served only through this authenticated API.
// Access follows the employees module's row rule: organisation-wide with employees.all, otherwise the user's own
// record; reading needs employees.view, changing needs employees.update. Every byte read is authorized per request
// (cache-control: private, no-store); uploads are validated by size, declared type, file signature and structure.
import { Hono, type Context } from 'hono';
import type { AppEnv, AuthUser } from '../env';
import { can, currentUser, requireAuth } from '../auth';
import { audit } from '../lib/audit';
import { HttpError, forbidden, intParam, notFound } from '../lib/http';
import {
  AVATAR_MAX_BYTES, AvatarError, deleteAvatar, saveAvatar, toMeta, validateAvatar,
  type AvatarMeta, type AvatarObjects, type AvatarRecord, type AvatarRecords,
} from '../../shared/avatar';

export const avatarRoutes = new Hono<AppEnv>();
avatarRoutes.use('*', requireAuth);

interface EmployeeRef {
  id: number;
  company_id: number;
}

const mayAccess = (user: AuthUser, employeeId: number) => can(user, 'employees.all') || user.employeeId === employeeId;

/** The employee behind :id, if this user may read (view) or change (update) their photo. */
async function employeeFor(c: Context<AppEnv>, user: AuthUser, action: 'view' | 'update'): Promise<EmployeeRef> {
  const id = intParam(c.req.param('id'));
  if (!can(user, `employees.${action}`)) throw forbidden(`ต้องมีสิทธิ์ employees.${action}`);
  if (!mayAccess(user, id)) throw forbidden('เข้าถึงรูปได้เฉพาะของตนเอง');
  const row = await c.env.DB.prepare('SELECT id, company_id FROM employees WHERE id = ?').bind(id).first<EmployeeRef>();
  if (!row) throw notFound('ไม่พบพนักงาน');
  return row;
}

function records(db: D1Database): AvatarRecords {
  return {
    get: (id) => db.prepare('SELECT employee_id, object_key, content_type, size_bytes, updated_at, updated_by FROM employee_avatars WHERE employee_id = ?').bind(id).first<AvatarRecord>(),
    insert: async (r) => (await db.prepare('INSERT INTO employee_avatars (employee_id, object_key, content_type, size_bytes, updated_by) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (employee_id) DO NOTHING')
      .bind(r.employee_id, r.object_key, r.content_type, r.size_bytes, r.updated_by).run()).meta.changes === 1,
    swap: async (oldKey, r) => (await db.prepare("UPDATE employee_avatars SET object_key = ?2, content_type = ?3, size_bytes = ?4, updated_by = ?5, updated_at = datetime('now') WHERE employee_id = ?1 AND object_key = ?6")
      .bind(r.employee_id, r.object_key, r.content_type, r.size_bytes, r.updated_by, oldKey).run()).meta.changes === 1,
    remove: async (id, key) => (await db.prepare('DELETE FROM employee_avatars WHERE employee_id = ? AND object_key = ?').bind(id, key).run()).meta.changes === 1,
  };
}

function objects(bucket: R2Bucket): AvatarObjects {
  return {
    put: async (key, bytes, type) => {
      await bucket.put(key, bytes, { httpMetadata: { contentType: type, cacheControl: 'private, no-store' } });
    },
    delete: (key) => bucket.delete(key),
  };
}

const asHttp = (e: unknown): never => {
  if (e instanceof AvatarError) throw new HttpError(e.status, e.code, e.message);
  throw e;
};

/** Reads the request body, stopping as soon as it exceeds the limit (never buffers an oversized upload). */
async function readCapped(c: Context<AppEnv>): Promise<Uint8Array> {
  const declared = Number(c.req.header('content-length'));
  if (Number.isFinite(declared) && declared > AVATAR_MAX_BYTES) throw new AvatarError(413, 'too_large', 'รูปภาพต้องมีขนาดไม่เกิน 5 MB');
  const body = c.req.raw.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > AVATAR_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new AvatarError(413, 'too_large', 'รูปภาพต้องมีขนาดไม่เกิน 5 MB');
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** Whether a photo exists (and its version), and whether this user may change it — never 404 for "no photo". */
avatarRoutes.get('/:id/avatar/meta', async (c) => {
  const user = currentUser(c);
  const emp = await employeeFor(c, user, 'view');
  const rec = await records(c.env.DB).get(emp.id);
  return c.json<{ avatar: AvatarMeta | null; canManage: boolean }>({ avatar: rec ? toMeta(rec) : null, canManage: can(user, 'employees.update') && mayAccess(user, emp.id) });
});

avatarRoutes.get('/:id/avatar', async (c) => {
  const user = currentUser(c);
  const emp = await employeeFor(c, user, 'view');
  const rec = await records(c.env.DB).get(emp.id);
  if (!rec) throw notFound('พนักงานคนนี้ยังไม่มีรูป');
  const obj = await c.env.AVATARS.get(rec.object_key);
  if (!obj) {
    console.error('avatar object missing for employee', emp.id);
    throw notFound('ไม่พบไฟล์รูปพนักงาน');
  }
  return new Response(obj.body, {
    headers: {
      'content-type': rec.content_type,
      'content-length': String(obj.size),
      'cache-control': 'private, no-store',
      'content-disposition': 'inline',
      // an image response can never run as a document
      'content-security-policy': "default-src 'none'; sandbox",
      'cross-origin-resource-policy': 'same-origin',
    },
  });
});

avatarRoutes.put('/:id/avatar', async (c) => {
  const user = currentUser(c);
  const emp = await employeeFor(c, user, 'update');
  try {
    const bytes = await readCapped(c);
    const type = validateAvatar(bytes, c.req.header('content-type'));
    const res = await saveAvatar(objects(c.env.AVATARS), records(c.env.DB), { employeeId: emp.id, companyId: emp.company_id, userId: user.id, bytes, type, uuid: crypto.randomUUID() });
    await audit(c, res.previousKey ? 'employee.avatar_replaced' : 'employee.avatar_uploaded', 'employees', emp.id, {
      content_type: type, size_bytes: bytes.byteLength, object_key: res.record.object_key,
      ...(res.previousKey ? { previous_key: res.previousKey } : {}), ...(res.orphanKey ? { orphan_key: res.orphanKey } : {}),
    });
    return c.json<{ avatar: AvatarMeta }>({ avatar: toMeta(res.record) });
  } catch (e) {
    return asHttp(e);
  }
});

avatarRoutes.delete('/:id/avatar', async (c) => {
  const user = currentUser(c);
  const emp = await employeeFor(c, user, 'update');
  try {
    const res = await deleteAvatar(objects(c.env.AVATARS), records(c.env.DB), emp.id);
    if (res.removed) await audit(c, 'employee.avatar_deleted', 'employees', emp.id, { object_key: res.removed.object_key, ...(res.orphanKey ? { orphan_key: res.orphanKey } : {}) });
    return c.json({ ok: true, deleted: !!res.removed });
  } catch (e) {
    return asHttp(e);
  }
});
