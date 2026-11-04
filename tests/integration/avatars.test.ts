// Employee photographs over the real Worker: wrangler dev with a local D1 and a local (simulated) R2 bucket.
// Authentication, CSRF, RBAC and row scope, validation, upload / replace / delete, D1 metadata ↔ R2 object
// consistency, audit entries, response headers and the org chart's photo version. Synthetic fixtures only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, startHarness, type Harness } from './harness';

const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, '..', 'fixtures', 'avatar', name)));
const JPG = fixture('sample.jpg');
const PNG = fixture('sample.png');
const WEBP = fixture('sample.webp');

let H: Harness;
const c: Record<string, Client> = {};
const emp: Record<string, number> = {};
const userId: Record<string, number> = {};
const cl = (k: string) => c[k] as Client;
const path = (code: string, rest = '') => `/api/employees/${emp[code]}/avatar${rest}`;
const meta = (code: string) => H.sql(`SELECT object_key, content_type, size_bytes, updated_by FROM employee_avatars WHERE employee_id = ${emp[code]}`)[0] as Record<string, unknown>;
const audits = (code: string) => H.sql(`SELECT action, details FROM audit_logs WHERE entity = 'employees' AND entity_id = '${emp[code]}' AND action LIKE 'employee.avatar_%' ORDER BY id`);

beforeAll(async () => {
  H = await startHarness();
  for (const [name, username] of [['admin', 'it_admin'], ['staff', 'it_staff'], ['manager', 'it_manager'], ['employee', 'it_employee'], ['payroll', 'it_payroll']] as const) {
    c[name] = new Client(H.baseUrl);
    const r = await cl(name).login(username, H.passwords[username]);
    expect(r.status, `${username} login`).toBe(200);
  }
  for (const r of H.sql("SELECT id, emp_code FROM employees WHERE emp_code IN ('E002', 'E003', 'E005', 'E007')")) emp[r.emp_code as string] = r.id as number;
  for (const r of H.sql("SELECT id, username FROM users WHERE username IN ('it_staff', 'it_admin')")) userId[r.username as string] = r.id as number;
}, 300_000);

afterAll(async () => {
  await H?.stop();
});

describe('avatar API — access control', () => {
  it('requires a session (401) and the CSRF header for changes (403)', async () => {
    const anon = new Client(H.baseUrl);
    expect((await anon.bytes('GET', path('E007'))).status).toBe(401);
    expect((await anon.bytes('GET', path('E007', '/meta'))).status).toBe(401);
    expect((await anon.bytes('PUT', path('E007'), JPG, 'image/jpeg')).status).toBe(401);
    expect((await anon.bytes('DELETE', path('E007'))).status).toBe(401);
    const noCsrf = await cl('staff').bytes('PUT', path('E007'), JPG, 'image/jpeg', { 'x-hr-requested': '0' });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe('csrf');
    expect(meta('E007')).toBeUndefined();
  });

  it('only users with employees.update may upload or delete', async () => {
    for (const who of ['employee', 'manager', 'payroll']) {
      expect((await cl(who).bytes('PUT', path('E007'), JPG, 'image/jpeg')).status, who).toBe(403);
      expect((await cl(who).bytes('DELETE', path('E007'))).status, who).toBe(403);
    }
    expect(meta('E007')).toBeUndefined();
  });

  it('meta tells whether a photo exists and whether the user may change it', async () => {
    expect((await cl('employee').get(path('E007', '/meta'))).body).toEqual({ avatar: null, canManage: false });
    expect((await cl('staff').get(path('E007', '/meta'))).body).toEqual({ avatar: null, canManage: true });
    expect((await cl('manager').get(path('E007', '/meta'))).body).toEqual({ avatar: null, canManage: false });
  });

  it('an employee without employees.all cannot see another employee\'s photo', async () => {
    expect((await cl('employee').get(path('E002', '/meta'))).status).toBe(403);
    expect((await cl('employee').bytes('GET', path('E002'))).status).toBe(403);
  });

  it('unknown employee: 404 for an authorized user', async () => {
    expect((await cl('staff').bytes('GET', '/api/employees/999999/avatar/meta')).status).toBe(404);
    expect((await cl('staff').bytes('PUT', '/api/employees/999999/avatar', JPG, 'image/jpeg')).status).toBe(404);
  });
});

describe('avatar API — upload, read, replace, delete', () => {
  let firstKey = '';

  it('HR uploads a JPEG: stored in R2, metadata in D1, audited', async () => {
    const r = await cl('staff').bytes('PUT', path('E007'), JPG, 'image/jpeg');
    expect(r.status, r.text).toBe(200);
    expect(r.body.avatar).toMatchObject({ content_type: 'image/jpeg', size_bytes: JPG.length });
    const m = meta('E007');
    expect(m).toMatchObject({ content_type: 'image/jpeg', size_bytes: JPG.length, updated_by: userId.it_staff });
    expect(m.object_key).toMatch(new RegExp(`^employees/1/${emp.E007}/avatar/[0-9a-f-]{36}\\.jpg$`));
    expect(String(m.object_key)).toContain(r.body.avatar.version);
    firstKey = String(m.object_key);
    expect(H.r2Has(firstKey)).toBe(true);
    const a = audits('E007');
    expect(a.map((x) => x.action)).toEqual(['employee.avatar_uploaded']);
    const details = JSON.parse(String(a[0]?.details));
    expect(details).toMatchObject({ content_type: 'image/jpeg', size_bytes: JPG.length, object_key: firstKey });
    expect(JSON.stringify(details).length).toBeLessThan(400); // no image bytes in the audit trail
  });

  it('the photo is served privately with the exact bytes and safe headers', async () => {
    const r = await cl('staff').bytes('GET', path('E007'));
    expect(r.status).toBe(200);
    expect(Buffer.from(r.raw).equals(Buffer.from(JPG))).toBe(true);
    expect(r.headers.get('content-type')).toBe('image/jpeg');
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(r.headers.get('content-security-policy')).toContain('sandbox');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    // other API responses keep their own policy
    expect((await cl('staff').bytes('GET', path('E007', '/meta'))).headers.get('cache-control')).toBe('no-store');
  });

  it('the employee sees their own photo; managers and payroll (employees.all) can view', async () => {
    expect((await cl('employee').bytes('GET', path('E007'))).status).toBe(200);
    expect((await cl('manager').bytes('GET', path('E007'))).status).toBe(200);
    expect((await cl('payroll').bytes('GET', path('E007'))).status).toBe(200);
  });

  it('the org chart lists the photo version, and only for employees that have one', async () => {
    const d = (await cl('staff').get('/api/org-design?company=1')).body;
    const rows = d.employees as Array<{ id: number; avatar: string | null }>;
    expect(rows.find((e) => e.id === emp.E007)?.avatar).toBe((await cl('staff').get(path('E007', '/meta'))).body.avatar.version);
    expect(rows.filter((e) => e.avatar !== null).map((e) => e.id)).toEqual([emp.E007]);
  });

  it('replacing with a PNG writes the new object, swaps metadata, removes the old object', async () => {
    const r = await cl('staff').bytes('PUT', path('E007'), PNG, 'image/png');
    expect(r.status, r.text).toBe(200);
    const m = meta('E007');
    expect(m).toMatchObject({ content_type: 'image/png', size_bytes: PNG.length });
    expect(m.object_key).not.toBe(firstKey);
    expect(H.r2Has(String(m.object_key))).toBe(true);
    expect(H.r2Has(firstKey)).toBe(false);
    expect(H.sql(`SELECT COUNT(*) AS n FROM employee_avatars WHERE employee_id = ${emp.E007}`)[0]?.n).toBe(1);
    expect(audits('E007').map((x) => x.action)).toEqual(['employee.avatar_uploaded', 'employee.avatar_replaced']);
    expect(JSON.parse(String(audits('E007')[1]?.details)).previous_key).toBe(firstKey);
  });

  it('WebP is accepted too (Super Admin)', async () => {
    const r = await cl('admin').bytes('PUT', path('E002'), WEBP, 'image/webp');
    expect(r.status, r.text).toBe(200);
    expect(meta('E002')).toMatchObject({ content_type: 'image/webp', size_bytes: WEBP.length, updated_by: userId.it_admin });
  });

  it('rejects unsupported types, forged signatures, mismatches, malformed, empty and oversized files — nothing changes', async () => {
    const before = meta('E007');
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set(PNG.subarray(0, 8));
    const cases: Array<[Uint8Array, string, number, string]> = [
      [PNG, 'image/gif', 415, 'unsupported_type'],
      [svg, 'image/svg+xml', 415, 'unsupported_type'],
      [svg, 'image/png', 415, 'bad_signature'],
      [PNG, 'image/jpeg', 415, 'type_mismatch'],
      [JPG.subarray(0, JPG.length - 2), 'image/jpeg', 400, 'malformed'],
      [new Uint8Array(0), 'image/png', 400, 'empty'],
      [big, 'image/png', 413, 'too_large'],
    ];
    for (const [data, type, status, code] of cases) {
      const r = await cl('staff').bytes('PUT', path('E007'), data, type);
      expect(r.status, `${type} → ${r.text}`).toBe(status);
      expect(r.body.error.code).toBe(code);
    }
    expect(meta('E007')).toEqual(before);
    expect(H.r2Has(String(before.object_key))).toBe(true);
    expect(audits('E007')).toHaveLength(2); // rejected uploads write nothing
  });

  it('two uploads at the same time leave exactly one consistent photo', async () => {
    const [a, b] = await Promise.all([cl('staff').bytes('PUT', path('E005'), JPG, 'image/jpeg'), cl('admin').bytes('PUT', path('E005'), PNG, 'image/png')]);
    expect([a.status, b.status].every((s) => s === 200 || s === 409)).toBe(true);
    expect([a.status, b.status]).toContain(200);
    const rows = H.sql(`SELECT object_key FROM employee_avatars WHERE employee_id = ${emp.E005}`);
    expect(rows).toHaveLength(1);
    expect(H.r2Has(String(rows[0]?.object_key))).toBe(true);
    const served = await cl('staff').bytes('GET', path('E005'));
    expect(served.status).toBe(200);
  });

  it('delete removes metadata and the object; the employee is back to initials', async () => {
    const key = String(meta('E007').object_key);
    const r = await cl('staff').bytes('DELETE', path('E007'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, deleted: true });
    expect(meta('E007')).toBeUndefined();
    expect(H.r2Has(key)).toBe(false);
    expect((await cl('staff').bytes('GET', path('E007'))).status).toBe(404);
    expect((await cl('staff').get(path('E007', '/meta'))).body.avatar).toBeNull();
    expect((await cl('staff').bytes('DELETE', path('E007'))).body).toEqual({ ok: true, deleted: false });
    expect(audits('E007').map((x) => x.action)).toEqual(['employee.avatar_uploaded', 'employee.avatar_replaced', 'employee.avatar_deleted']);
  });

  it('no avatar touched payroll or employee master data', async () => {
    const rows = H.sql("SELECT COUNT(*) AS n FROM audit_logs WHERE action LIKE 'employee.avatar_%' AND entity <> 'employees'");
    expect(rows[0]?.n).toBe(0);
    expect(H.sql('SELECT COUNT(*) AS n FROM payslips')[0]?.n).toBe(0);
  });
});
