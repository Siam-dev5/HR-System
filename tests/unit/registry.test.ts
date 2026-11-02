import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CRUD_MODULES, MODULES, PAGE_MODULES, crudModule, permissionCatalogue } from '../../src/shared/modules';
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

describe('role seed permissions', () => {
  const sql = readFileSync('migrations/0002_reference_data.sql', 'utf8');
  const patterns = [...sql.matchAll(/json_each\('(\[[^']+\])'\)/g)].flatMap((m) => JSON.parse(m[1] as string) as string[]).filter((p) => p.includes('.'));
  const catalogue = permissionCatalogue();
  it('every seeded permission pattern grants at least one real permission (no typos)', () => {
    expect(patterns.length).toBeGreaterThan(20);
    for (const p of patterns) expect(catalogue.some((c) => permissionMatches(p, c)), p).toBe(true);
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
