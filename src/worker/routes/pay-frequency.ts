// Pay frequency (P6): monthly / semi-monthly per company and per employee (override). It decides who takes part in a
// mid-month round (the existing semi-monthly advance, docs/HR-PAYROLL-POLICY.md section 3): 'monthly' employees are
// left out; not configured = as before. No amount, date or deduction rule is created here. Reads need payroll.view or
// pay_frequency.manage; changes need pay_frequency.manage and a reason; company scope everywhere; every change keeps
// an append-only history row and an audit entry.
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { can, currentUser, requireAuth, requirePerm } from '../auth';
import { audit } from '../lib/audit';
import { companyScope } from '../lib/companies';
import { badRequest, forbidden, HttpError, intParam, notFound, readJson } from '../lib/http';

export const payFrequencyRoutes = new Hono<AppEnv>();
payFrequencyRoutes.use('*', requireAuth);

type Frequency = 'monthly' | 'semi_monthly';
const FREQUENCIES: ReadonlySet<string> = new Set(['monthly', 'semi_monthly']);

async function scopeIds(c: Context<AppEnv>): Promise<{ all: boolean; ids: number[] }> {
  const s = await companyScope(c.env.DB, currentUser(c));
  return { all: s.scope === 'all', ids: s.items.map((x) => x.id) };
}
function canRead(c: Context<AppEnv>): void {
  const u = currentUser(c);
  if (!can(u, 'payroll.view') && !can(u, 'pay_frequency.manage')) throw forbidden('ต้องมีสิทธิ์ payroll.view หรือ pay_frequency.manage');
}
function readChange(body: Record<string, unknown>): { value: Frequency | null; reason: string } {
  if (!('pay_frequency' in body)) throw badRequest('ต้องระบุ pay_frequency (monthly / semi_monthly / null = ไม่กำหนด)');
  const v = body.pay_frequency;
  if (v !== null && (typeof v !== 'string' || !FREQUENCIES.has(v))) throw badRequest('pay_frequency ต้องเป็น monthly, semi_monthly หรือ null');
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < 5 || reason.length > 500) throw new HttpError(400, 'reason_required', 'ต้องระบุเหตุผล (5–500 ตัวอักษร)');
  return { value: v as Frequency | null, reason };
}

payFrequencyRoutes.get('/companies', async (c) => {
  canRead(c);
  const s = await scopeIds(c);
  const { results } = await c.env.DB
    .prepare('SELECT id, code, name, pay_frequency FROM companies WHERE active = 1 AND (?1 = 1 OR id IN (SELECT value FROM json_each(?2))) ORDER BY code')
    .bind(s.all ? 1 : 0, JSON.stringify(s.ids))
    .all();
  return c.json({ companies: results });
});

/** Set (or clear) a company's pay frequency. */
payFrequencyRoutes.put('/companies/:id', requirePerm('pay_frequency.manage'), async (c) => {
  const db = c.env.DB;
  const s = await scopeIds(c);
  const id = intParam(c.req.param('id'));
  const co = await db.prepare('SELECT id, pay_frequency FROM companies WHERE id = ?').bind(id).first<{ id: number; pay_frequency: string | null }>();
  if (!co || !(s.all || s.ids.includes(co.id))) throw notFound('ไม่พบบริษัท');
  const { value, reason } = readChange(await readJson(c));
  if (co.pay_frequency === value) return c.json({ id: co.id, pay_frequency: value, unchanged: true });
  const user = currentUser(c);
  // the update and its history row in one transaction; the update only applies to the value that was read
  const res = await db.batch([
    db.prepare('UPDATE companies SET pay_frequency = ?1 WHERE id = ?2 AND pay_frequency IS ?3').bind(value, co.id, co.pay_frequency),
    db.prepare("INSERT INTO pay_frequency_history (entity, entity_id, company_id, before_value, after_value, reason, actor_id) SELECT 'company', ?1, ?1, ?2, ?3, ?4, ?5 WHERE changes() > 0").bind(co.id, co.pay_frequency, value, reason, user.id),
  ]);
  if (!res[0]?.meta.changes) throw new HttpError(409, 'pay_frequency_changed', 'ค่าถูกแก้ไขระหว่างดำเนินการ กรุณาโหลดใหม่');
  await audit(c, 'pay_frequency.company_changed', 'companies', co.id, { before: co.pay_frequency, after: value, reason });
  return c.json({ id: co.id, pay_frequency: value });
});

payFrequencyRoutes.get('/employees/:id', async (c) => {
  canRead(c);
  const s = await scopeIds(c);
  const e = await c.env.DB
    .prepare('SELECT e.id, e.emp_code, e.company_id, e.pay_frequency, c.pay_frequency AS company_frequency FROM employees e JOIN companies c ON c.id = e.company_id WHERE e.id = ?')
    .bind(intParam(c.req.param('id')))
    .first<{ id: number; emp_code: string; company_id: number; pay_frequency: string | null; company_frequency: string | null }>();
  if (!e || !(s.all || s.ids.includes(e.company_id))) throw notFound('ไม่พบพนักงาน');
  return c.json({ ...e, effective: e.pay_frequency ?? e.company_frequency ?? null });
});

/** Set (or clear: back to the company's) an employee's pay frequency. */
payFrequencyRoutes.put('/employees/:id', requirePerm('pay_frequency.manage'), async (c) => {
  const db = c.env.DB;
  const s = await scopeIds(c);
  const e = await db.prepare('SELECT id, company_id, pay_frequency FROM employees WHERE id = ?').bind(intParam(c.req.param('id'))).first<{ id: number; company_id: number; pay_frequency: string | null }>();
  if (!e || !(s.all || s.ids.includes(e.company_id))) throw notFound('ไม่พบพนักงาน');
  const { value, reason } = readChange(await readJson(c));
  if (e.pay_frequency === value) return c.json({ id: e.id, pay_frequency: value, unchanged: true });
  const user = currentUser(c);
  const res = await db.batch([
    db.prepare('UPDATE employees SET pay_frequency = ?1 WHERE id = ?2 AND pay_frequency IS ?3').bind(value, e.id, e.pay_frequency),
    db.prepare("INSERT INTO pay_frequency_history (entity, entity_id, company_id, before_value, after_value, reason, actor_id) SELECT 'employee', ?1, ?2, ?3, ?4, ?5, ?6 WHERE changes() > 0").bind(e.id, e.company_id, e.pay_frequency, value, reason, user.id),
  ]);
  if (!res[0]?.meta.changes) throw new HttpError(409, 'pay_frequency_changed', 'ค่าถูกแก้ไขระหว่างดำเนินการ กรุณาโหลดใหม่');
  await audit(c, 'pay_frequency.employee_changed', 'employees', e.id, { company_id: e.company_id, before: e.pay_frequency, after: value, reason });
  return c.json({ id: e.id, pay_frequency: value });
});

/** History of changes (append-only), limited to the companies of the scope. */
payFrequencyRoutes.get('/history', async (c) => {
  canRead(c);
  const s = await scopeIds(c);
  const { results } = await c.env.DB
    .prepare(
      `SELECT h.id, h.entity, h.entity_id, h.company_id, h.before_value, h.after_value, h.reason, h.created_at, u.username AS actor
       FROM pay_frequency_history h LEFT JOIN users u ON u.id = h.actor_id WHERE (?1 = 1 OR h.company_id IN (SELECT value FROM json_each(?2))) ORDER BY h.id DESC LIMIT 200`,
    )
    .bind(s.all ? 1 : 0, JSON.stringify(s.ids))
    .all();
  return c.json({ history: results });
});
