// scripts/prepare-d1-restore.mjs: a dump in export order (children before parents, rows that point at later rows of
// the same table) becomes a restore file that loads with foreign keys checked row by row, as a remote D1 import does.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCRIPT = resolve(__dirname, '../../scripts/prepare-d1-restore.mjs');

// export order: tables alphabetical, INSERTs right after each table, a manager (id 3) after the employee pointing at it
const DUMP = `PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE companies (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
INSERT INTO "companies" ("id","name") VALUES(1,'Synthetic Co; Ltd');
CREATE TABLE departments (id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), parent_id INTEGER REFERENCES departments(id), name TEXT);
INSERT INTO "departments" ("id","company_id","parent_id","name") VALUES(1,1,2,'Child dept');
INSERT INTO "departments" ("id","company_id","parent_id","name") VALUES(2,1,NULL,'Root dept');
CREATE TABLE employees (
  id INTEGER PRIMARY KEY,
  department_id INTEGER REFERENCES departments(id),
  manager_id INTEGER,
  note TEXT,
  FOREIGN KEY (manager_id) REFERENCES employees(id)
);
INSERT INTO "employees" ("id","department_id","manager_id","note") VALUES(1,1,3,replace('line one\\nline (two), ok','\\n',char(10)));
INSERT INTO "employees" ("id","department_id","manager_id","note") VALUES(2,1,1,'it''s fine');
INSERT INTO "employees" ("id","department_id","manager_id","note") VALUES(3,2,NULL,NULL);
CREATE TABLE payslips (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL REFERENCES employees(id), net REAL);
INSERT INTO "payslips" ("id","employee_id","net") VALUES(1,2,100.5);
CREATE TABLE audit (id INTEGER PRIMARY KEY, payslip_id INTEGER REFERENCES payslips(id));
INSERT INTO "audit" ("id","payslip_id") VALUES(1,1);
INSERT INTO "sqlite_sequence" VALUES('payslips',1);
CREATE INDEX idx_employees_manager ON employees(manager_id);
`;

function prepare(dump: string): { out: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'restore-'));
  try {
    writeFileSync(join(dir, 'dump.sql'), dump);
    const log = execFileSync(process.execPath, [SCRIPT, join(dir, 'dump.sql'), join(dir, 'restore.sql')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { out: readFileSync(join(dir, 'restore.sql'), 'utf8'), log };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** loads the restore file statement by statement with immediate foreign-key checks (no deferral) */
function load(restore: string): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const line of restore.split(/;\n(?=PRAGMA|CREATE|INSERT)/)) {
    const stmt = line.trim().replace(/;$/, '');
    if (!stmt || /^PRAGMA defer_foreign_keys/i.test(stmt)) continue; // the remote import does not keep the deferral
    db.exec(stmt);
  }
  return db;
}

describe('prepare-d1-restore', () => {
  const { out, log } = prepare(DUMP);
  const lines = out.trim().split('\n');
  const at = (re: RegExp) => lines.findIndex((l) => re.test(l));

  it('keeps every statement unchanged, only re-ordered', () => {
    expect(log).toMatch(/^ok: 16 statements \(5 tables, 8 inserts, 1 indexes, 0 triggers; parents before children, 2 self-referencing table\(s\) re-ordered\)/);
    const statements = (s: string) => s.split(/;\n(?=PRAGMA|CREATE|INSERT)/).map((x) => x.trim().replace(/;$/, '')).filter(Boolean).sort();
    expect(statements(out)).toEqual(statements(DUMP));
  });

  it('orders tables parents first, then rows that reference rows of the same table', () => {
    expect(at(/^PRAGMA/)).toBe(0);
    expect(at(/^INSERT INTO "companies"/)).toBeLessThan(at(/^INSERT INTO "departments"/));
    expect(at(/VALUES\(2,1,NULL,'Root dept'\)/)).toBeLessThan(at(/VALUES\(1,1,2,'Child dept'\)/));
    expect(at(/^INSERT INTO "employees".*VALUES\(3,/)).toBeLessThan(at(/^INSERT INTO "employees".*VALUES\(1,/));
    expect(at(/^INSERT INTO "employees".*VALUES\(1,/)).toBeLessThan(at(/^INSERT INTO "employees".*VALUES\(2,/));
    expect(at(/^INSERT INTO "payslips"/)).toBeLessThan(at(/^INSERT INTO "audit"/));
    expect(at(/^INSERT INTO "sqlite_sequence"/)).toBeGreaterThan(at(/^INSERT INTO "audit"/));
    expect(at(/^CREATE INDEX/)).toBe(lines.length - 1);
  });

  it('loads with foreign keys checked on every row and keeps every value', () => {
    const db = load(out);
    expect(db.prepare('SELECT COUNT(*) AS n FROM employees').get()).toEqual({ n: 3 });
    expect(db.prepare('SELECT note FROM employees WHERE id = 1').get()).toEqual({ note: 'line one\nline (two), ok' });
    expect(db.prepare('SELECT note FROM employees WHERE id = 2').get()).toEqual({ note: "it's fine" });
    expect(db.prepare('SELECT name FROM companies').get()).toEqual({ name: 'Synthetic Co; Ltd' });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });

  it('the export order itself fails that load (the defect this ordering fixes)', () => {
    expect(() => load(DUMP.replace(/^CREATE INDEX.*$/m, ''))).toThrow(/FOREIGN KEY|no such table/);
  });

  it('refuses rows that reference each other in a cycle instead of writing a file that cannot load', () => {
    const cyclic = DUMP.replace("VALUES(3,2,NULL,NULL)", 'VALUES(3,2,2,NULL)');
    expect(() => prepare(cyclic)).toThrow(/cycle/);
  });

  it('keeps a comment with an apostrophe inside a CREATE TABLE and restores triggers whole, after the rows', () => {
    // as in a real export since 0009 (comments in table definitions) and 0011 (triggers with BEGIN ... END bodies)
    const dump = `PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE records (
  id INTEGER PRIMARY KEY,
  -- the approver confirms these hours are not also part of the employee's normal OT
  hours REAL
);
INSERT INTO "records" ("id","hours") VALUES(1,2.5);
CREATE TRIGGER trg_records_nodelete BEFORE DELETE ON records
BEGIN
  SELECT RAISE(ABORT, 'records are kept; never deleted');
END;
CREATE INDEX idx_records_hours ON records(hours);
`;
    const r = prepare(dump);
    expect(r.log).toMatch(/^ok: 5 statements \(1 tables, 1 inserts, 1 indexes, 1 triggers;/);
    const order = r.out.trim().split(/\n(?=PRAGMA|CREATE|INSERT)/).map((x) => x.split(' ').slice(0, 2).join(' '));
    expect(order).toEqual(['PRAGMA defer_foreign_keys=TRUE;', 'CREATE TABLE', 'INSERT INTO', 'CREATE INDEX', 'CREATE TRIGGER']);
    expect(r.out).toContain("BEGIN\n  SELECT RAISE(ABORT, 'records are kept; never deleted');\nEND;");
    const db = new DatabaseSync(':memory:');
    db.exec(r.out);
    expect(db.prepare('SELECT hours FROM records').get()).toEqual({ hours: 2.5 });
    expect(() => db.exec('DELETE FROM records')).toThrow(/never deleted/);
    db.close();
  });
});
