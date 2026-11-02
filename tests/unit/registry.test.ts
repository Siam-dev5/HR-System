import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { CRUD_MODULES, MODULES, PAGE_MODULES, RESERVED_PERMISSIONS, canOpenModule, crudModule, permissionCatalogue } from '../../src/shared/modules';
import { permissionMatches } from '../../src/shared/permissions';
import { PAGES } from '../../src/web/pages/registry';
import { verifyPassword } from '../../src/shared/crypto';
import { hashPassword as scriptHash, generatePassword as scriptPassword } from '../../scripts/lib/password.mjs';

describe('module registry', () => {
  it('has unique keys and paths', () => {
    expect(new Set(MODULES.map((m) => m.key)).size).toBe(MODULES.length);
    expect(new Set(MODULES.map((m) => m.path)).size).toBe(MODULES.length);
  });
  it('every ref field points at a known lookup', () => {
    for (const m of CRUD_MODULES) for (const f of m.fields.filter((x) => x.type === 'ref')) {
      expect(f.ref === 'roles' || !!crudModule(f.ref as string), `${m.key}.${f.name} → ${f.ref}`).toBe(true);
    }
  });
  it('every select field has options and every owner field exists', () => {
    for (const m of CRUD_MODULES) {
      for (const f of m.fields.filter((x) => x.type === 'select')) expect(f.options?.length, `${m.key}.${f.name}`).toBeGreaterThan(0);
      if (m.ownerField && m.ownerField !== 'id') expect(m.fields.some((f) => f.name === m.ownerField), m.key).toBe(true);
    }
  });
  it('every page module has a screen in the SPA (no menu entry without a page)', () => {
    for (const p of PAGE_MODULES) expect(PAGES[p.key], p.key).toBeTypeOf('function');
  });
  it('payroll and payslip have explicit routes and permissions', () => {
    const paths = MODULES.map((m) => m.path);
    expect(paths).toContain('/payroll');
    expect(paths).toContain('/payroll/payslips');
    expect(paths).toContain('/my/payslips');
    expect(PAGE_MODULES.find((p) => p.key === 'my_payslips')?.perm).toBe('payslip.own');
  });
});

/** Permission patterns seeded by every migration (the json_each('[...]') lists). */
function seededPatterns(): string[] {
  const sql = readdirSync('migrations').filter((f) => f.endsWith('.sql')).map((f) => readFileSync(`migrations/${f}`, 'utf8')).join('\n');
  return [...sql.matchAll(/json_each\('(\[[^']+\])'\)/g)].flatMap((m) => JSON.parse(m[1] as string) as string[]);
}

describe('role seed permissions', () => {
  const patterns = seededPatterns().filter((p) => p.includes('.'));
  const catalogue = permissionCatalogue();
  it('every seeded permission pattern grants at least one real permission (no typos)', () => {
    expect(patterns.length).toBeGreaterThan(20);
    for (const p of patterns) expect(catalogue.some((c) => permissionMatches(p, c)), p).toBe(true);
  });
});

describe('Super Admin only user / role management', () => {
  const users = MODULES.find((m) => m.key === 'users');
  const roles = MODULES.find((m) => m.key === 'roles');
  it('users and roles pages are reserved for the super_admin role', () => {
    expect(users && roles).toBeTruthy();
    for (const m of [users!, roles!]) {
      expect(canOpenModule(m, ['*'], ['super_admin'])).toBe(true);
      // even an explicit or wildcard permission does not open them without the role
      expect(canOpenModule(m, ['users.manage', 'roles.manage', '*'], ['hr_admin'])).toBe(false);
      expect(canOpenModule(m, ['*.manage'], ['hr_manager'])).toBe(false);
    }
  });
  it('reserved permissions are not offered in the role editor catalogue', () => {
    const cat = permissionCatalogue();
    for (const r of RESERVED_PERMISSIONS) expect(cat).not.toContain(r);
  });
  it('no seeded non-super role carries a pattern that grants user/role management', () => {
    for (const p of seededPatterns()) for (const r of RESERVED_PERMISSIONS) expect(permissionMatches(p, r), `${p} grants ${r}`).toBe(false);
  });
});

describe('scripts/lib/password.mjs', () => {
  it('produces hashes the Worker accepts', async () => {
    const hash = (await scriptHash('Script-Pass-123', 1000)) as string;
    expect(await verifyPassword('Script-Pass-123', hash)).toBe(true);
    expect(await verifyPassword('other', hash)).toBe(false);
  });
  it('generates policy-compliant passwords', () => {
    const p = scriptPassword(20) as string;
    expect(p).toHaveLength(20);
    expect(/[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p) && /[^A-Za-z0-9]/.test(p)).toBe(true);
  });
});
