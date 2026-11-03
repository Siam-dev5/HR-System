// Organization Design: chart / table views built from the real master data (companies, departments, positions,
// employees, reports-to), approved vs occupied headcount, and a validated reporting-line import (never a wholesale
// replace: only manager / department / position of existing employees change, each change is audited).
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import type { CompanyOption, OrgDepartmentRow, OrgDesignResponse, OrgEmployeeNode, OrgPositionRow } from '../../shared/types';
import { normalizeHeader } from '../../shared/feishu';
import { writeXlsx, type Cell } from '../../shared/xlsx';
import { safeName, badRequest, conflict, csv, forbidden, intParam, notFound, readJson } from '../lib/http';
import { audit } from '../lib/audit';
import { companyScope, requireCompany } from '../lib/companies';
import { can, currentUser, requireAuth, requirePerm } from '../auth';

export const orgRoutes = new Hono<AppEnv>();
orgRoutes.use('*', requireAuth);

const ACTIVE = "e.status IN ('active', 'probation')";

async function orgCompany(c: Context<AppEnv>, raw: string | undefined): Promise<{ company: CompanyOption | null; companies: CompanyOption[] }> {
  const user = currentUser(c);
  const scope = await companyScope(c.env.DB, user);
  const company = await requireCompany(c.env.DB, user, raw);
  if (company) return { company, companies: scope.items };
  if (scope.scope === 'all') return { company: null, companies: scope.items };
  const own = scope.items[0];
  if (!own) throw forbidden('บัญชีนี้ยังไม่ได้ผูกกับบริษัท');
  return { company: own, companies: scope.items };
}

async function loadOrg(db: D1Database, companyId: number | null): Promise<Omit<OrgDesignResponse, 'company' | 'companies' | 'canUpdate' | 'canImport' | 'canExport'>> {
  const { results: deps } = await db
    .prepare('SELECT id, code, name, company_id, parent_id FROM departments WHERE active = 1 AND (?1 IS NULL OR company_id = ?1) ORDER BY code')
    .bind(companyId)
    .all<Omit<OrgDepartmentRow, 'level' | 'employees'>>();
  const { results: emps } = await db
    .prepare(
      `SELECT e.id, e.emp_code, e.first_name || ' ' || e.last_name AS name, e.company_id, e.department_id, e.position_id, e.manager_id, e.status, e.hire_date
       FROM employees e WHERE ${ACTIVE} AND (?1 IS NULL OR e.company_id = ?1) ORDER BY e.emp_code`,
    )
    .bind(companyId)
    .all<Omit<OrgEmployeeNode, 'email'>>();
  const { results: pos } = await db
    .prepare(
      `SELECT x.id, x.code, x.title, x.department_id, x.job_grade, COALESCE(x.headcount, 0) AS approved
       FROM positions x LEFT JOIN departments d ON d.id = x.department_id
       WHERE x.active = 1 AND (?1 IS NULL OR d.company_id = ?1 OR (x.department_id IS NULL AND EXISTS (SELECT 1 FROM employees e WHERE e.position_id = x.id AND e.company_id = ?1)))
       ORDER BY x.code`,
    )
    .bind(companyId)
    .all<{ id: number; code: string; title: string; department_id: number | null; job_grade: string | null; approved: number }>();

  const depIds = new Set(deps.map((d) => d.id));
  const level = new Map<number, number>();
  const depth = (id: number, seen: Set<number> = new Set()): number => {
    if (level.has(id)) return level.get(id) as number;
    const d = deps.find((x) => x.id === id);
    if (!d || seen.has(id)) return 1;
    seen.add(id);
    const v = d.parent_id && depIds.has(d.parent_id) ? depth(d.parent_id, seen) + 1 : 1;
    level.set(id, v);
    return v;
  };
  const departments: OrgDepartmentRow[] = deps.map((d) => ({ ...d, level: depth(d.id), employees: emps.filter((e) => e.department_id === d.id).length }));
  const positions: OrgPositionRow[] = pos.map((x) => {
    const occupied = emps.filter((e) => e.position_id === x.id).length;
    const approved = Math.max(0, Math.round(x.approved));
    return { ...x, approved, occupied, vacant: Math.max(0, approved - occupied), over: Math.max(0, occupied - approved) };
  });
  const employees: OrgEmployeeNode[] = emps.map((e) => ({ ...e, email: null }));
  // reporting depth (levels of the reports-to chain inside this scope)
  const ids = new Set(employees.map((e) => e.id));
  const mgrDepth = new Map<number, number>();
  const chain = (e: OrgEmployeeNode, seen: Set<number> = new Set()): number => {
    if (mgrDepth.has(e.id)) return mgrDepth.get(e.id) as number;
    if (seen.has(e.id)) return 1;
    seen.add(e.id);
    const m = e.manager_id && ids.has(e.manager_id) ? employees.find((x) => x.id === e.manager_id) : undefined;
    const v = m ? chain(m, seen) + 1 : 1;
    mgrDepth.set(e.id, v);
    return v;
  };
  for (const e of employees) chain(e);
  return {
    departments,
    positions,
    employees,
    stats: {
      employees: employees.length,
      departments: departments.length,
      levels: Math.max(0, ...mgrDepth.values()),
      positions: positions.length,
      occupiedPositions: positions.filter((p) => p.occupied > 0).length,
      approved: positions.reduce((a, p) => a + p.approved, 0),
      occupied: positions.reduce((a, p) => a + p.occupied, 0),
      vacant: positions.reduce((a, p) => a + p.vacant, 0),
      over: positions.reduce((a, p) => a + p.over, 0),
    },
  };
}

orgRoutes.get('/', requirePerm('org_chart.view'), async (c) => {
  const user = currentUser(c);
  const { company, companies } = await orgCompany(c, c.req.query('company'));
  const data = await loadOrg(c.env.DB, company?.id ?? null);
  return c.json<OrgDesignResponse>({ company, companies, ...data, canUpdate: can(user, 'org_chart.update'), canImport: can(user, 'org_chart.import'), canExport: can(user, 'org_chart.export') });
});

function tableRows(d: Awaited<ReturnType<typeof loadOrg>>, companies: CompanyOption[]): Cell[][] {
  const head = ['รหัสพนักงาน', 'ชื่อ-นามสกุล', 'บริษัท', 'หน่วยงาน', 'ตำแหน่ง', 'ระดับ (Grade)', 'หัวหน้า (Reports To)', 'จำนวนผู้ใต้บังคับบัญชา', 'สถานะ', 'วันเริ่มงาน'];
  const rows = d.employees.map((e) => {
    const dep = d.departments.find((x) => x.id === e.department_id);
    const pos = d.positions.find((x) => x.id === e.position_id);
    const mgr = d.employees.find((x) => x.id === e.manager_id);
    return [e.emp_code, e.name, companies.find((x) => x.id === e.company_id)?.name ?? null, dep?.name ?? null, pos?.title ?? null, pos?.job_grade ?? null, mgr ? `${mgr.emp_code} ${mgr.name}` : null, d.employees.filter((x) => x.manager_id === e.id).length, e.status, e.hire_date];
  });
  const head2 = ['รหัสตำแหน่ง', 'ตำแหน่ง', 'หน่วยงาน', 'Grade', 'อัตราอนุมัติ', 'มีคนครอง', 'ว่าง (Vacant)', 'เกินอัตรา (Over)'];
  const rows2 = d.positions.map((p) => [p.code, p.title, d.departments.find((x) => x.id === p.department_id)?.name ?? null, p.job_grade, p.approved, p.occupied, p.vacant, p.over]);
  return [head, ...rows, [], head2, ...rows2];
}

const exportOrg = (ext: 'csv' | 'xlsx') => async (c: Context<AppEnv>) => {
  const { company, companies } = await orgCompany(c, c.req.query('company'));
  const data = await loadOrg(c.env.DB, company?.id ?? null);
  const rows = tableRows(data, companies);
  const name = safeName(`organization${company ? `-${company.code}` : ''}`);
  await audit(c, 'org.exported', 'employees', null, { company: company?.id ?? null, format: ext, rows: data.employees.length });
  if (ext === 'csv') return c.body(csv(rows as Array<Array<string | number | null>>), 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}.csv"`, 'cache-control': 'no-store' });
  return c.body(writeXlsx('Organization', rows) as unknown as ArrayBuffer, 200, {
    'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'content-disposition': `attachment; filename="${name}.xlsx"`,
    'cache-control': 'no-store',
  });
};
orgRoutes.get('/export.csv', requirePerm('org_chart.export'), exportOrg('csv'));
orgRoutes.get('/export.xlsx', requirePerm('org_chart.export'), exportOrg('xlsx'));

// ---- Reporting-line import (template → preview → apply) ------------------------------------
const TEMPLATE_HEAD = ['Employee ID', 'Reports To (Employee ID)', 'Department Code', 'Position Code', 'ชื่อ-นามสกุล (ไม่นำเข้า)'];

orgRoutes.get('/template.xlsx', requirePerm('org_chart.import'), async (c) => {
  const { company } = await orgCompany(c, c.req.query('company'));
  const { results } = await c.env.DB.prepare(
    `SELECT e.emp_code, m.emp_code AS manager, d.code AS dept, x.code AS pos, e.first_name || ' ' || e.last_name AS name
     FROM employees e LEFT JOIN employees m ON m.id = e.manager_id LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN positions x ON x.id = e.position_id
     WHERE ${ACTIVE} AND (?1 IS NULL OR e.company_id = ?1) ORDER BY e.emp_code`,
  )
    .bind(company?.id ?? null)
    .all<{ emp_code: string; manager: string | null; dept: string | null; pos: string | null; name: string }>();
  await audit(c, 'org.template_downloaded', 'employees', null, { company: company?.id ?? null, rows: results.length });
  return c.body(writeXlsx('Org Import', [TEMPLATE_HEAD, ...results.map((r) => [r.emp_code, r.manager, r.dept, r.pos, r.name])]) as unknown as ArrayBuffer, 200, {
    'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'content-disposition': `attachment; filename="${safeName(`org-import-template${company ? `-${company.code}` : ''}`)}.xlsx"`,
    'cache-control': 'no-store',
  });
});

interface OrgChange {
  rowNo: number;
  emp_code: string;
  employee_id: number | null;
  name: string | null;
  changes: Array<{ field: 'manager_id' | 'department_id' | 'position_id'; label: string; from: string | null; to: string | null; toId: number | null }>;
  errors: string[];
}

async function analyzeOrgImport(c: Context<AppEnv>, body: Record<string, unknown>) {
  const db = c.env.DB;
  const { company } = await orgCompany(c, body.company_id === undefined || body.company_id === null ? undefined : String(body.company_id));
  const grid = body.grid;
  if (!Array.isArray(grid) || grid.length < 2 || grid.length > 20_000) throw badRequest('ไฟล์ไม่มีข้อมูล หรือมีจำนวนแถวมากเกินไป');
  const cell = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());
  const headerIdx = grid.findIndex((r, i) => i < 10 && Array.isArray(r) && r.some((v) => normalizeHeader(v).key === 'employee id'));
  if (headerIdx < 0) throw badRequest('ไม่พบหัวตาราง "Employee ID" — กรุณาใช้ Template ของระบบ');
  const head = (grid[headerIdx] as unknown[]).map((v) => normalizeHeader(v).key);
  const col = (label: string) => head.indexOf(normalizeHeader(label).key);
  const [cEmp, cMgr, cDep, cPos] = [col(TEMPLATE_HEAD[0] as string), col(TEMPLATE_HEAD[1] as string), col(TEMPLATE_HEAD[2] as string), col(TEMPLATE_HEAD[3] as string)];
  if (cMgr < 0 && cDep < 0 && cPos < 0) throw badRequest('ไม่พบคอลัมน์ Reports To / Department Code / Position Code');

  const { results: emps } = await db.prepare("SELECT id, emp_code, first_name || ' ' || last_name AS name, company_id, manager_id, department_id, position_id, status FROM employees").all<{ id: number; emp_code: string; name: string; company_id: number; manager_id: number | null; department_id: number | null; position_id: number | null; status: string }>();
  const { results: deps } = await db.prepare('SELECT id, code, name, company_id FROM departments WHERE active = 1').all<{ id: number; code: string; name: string; company_id: number }>();
  const { results: poss } = await db.prepare('SELECT x.id, x.code, x.title, d.company_id FROM positions x LEFT JOIN departments d ON d.id = x.department_id WHERE x.active = 1').all<{ id: number; code: string; title: string; company_id: number | null }>();
  const byCode = new Map(emps.map((e) => [e.emp_code.toUpperCase(), e]));
  const scopeIds = company ? null : (await companyScope(db, currentUser(c))).items.map((x) => x.id);
  const inScope = (companyId: number) => (company ? companyId === company.id : !scopeIds || scopeIds.includes(companyId));

  const out: OrgChange[] = [];
  const seen = new Set<string>();
  const after = new Map(emps.map((e) => [e.id, e.manager_id]));
  for (let r = headerIdx + 1; r < grid.length; r++) {
    const row = grid[r] as unknown[];
    if (!Array.isArray(row) || !row.some((v) => cell(v))) continue;
    const code = cell(row[cEmp]);
    const item: OrgChange = { rowNo: r + 1, emp_code: code, employee_id: null, name: null, changes: [], errors: [] };
    out.push(item);
    const e = byCode.get(code.toUpperCase());
    if (!code) { item.errors.push('ไม่มี Employee ID'); continue; }
    if (!e) { item.errors.push(`ไม่พบพนักงาน ${code}`); continue; }
    if (!inScope(e.company_id)) { item.errors.push('พนักงานอยู่นอกขอบเขตบริษัทที่เลือก'); continue; }
    if (seen.has(code.toUpperCase())) { item.errors.push('Employee ID ซ้ำในไฟล์'); continue; }
    seen.add(code.toUpperCase());
    item.employee_id = e.id;
    item.name = e.name;
    if (cMgr >= 0) {
      const m = cell(row[cMgr]);
      const mgr = m ? byCode.get(m.toUpperCase()) : null;
      if (m && !mgr) item.errors.push(`ไม่พบหัวหน้า ${m}`);
      else if (mgr && mgr.id === e.id) item.errors.push('หัวหน้าต้องไม่ใช่ตัวเอง');
      else if (mgr && mgr.company_id !== e.company_id) item.errors.push('หัวหน้าอยู่คนละบริษัท');
      else if (mgr && mgr.status !== 'active' && mgr.status !== 'probation') item.errors.push(`หัวหน้า ${m} พ้นสภาพแล้ว`);
      else if ((mgr?.id ?? null) !== e.manager_id) {
        item.changes.push({ field: 'manager_id', label: 'หัวหน้า', from: emps.find((x) => x.id === e.manager_id)?.emp_code ?? null, to: mgr?.emp_code ?? null, toId: mgr?.id ?? null });
      }
    }
    if (cDep >= 0) {
      const d = cell(row[cDep]);
      const dep = d ? deps.find((x) => x.code.toUpperCase() === d.toUpperCase()) : null;
      if (d && !dep) item.errors.push(`ไม่พบหน่วยงาน ${d}`);
      else if (dep && dep.company_id !== e.company_id) item.errors.push(`หน่วยงาน ${d} อยู่คนละบริษัท`);
      else if ((dep?.id ?? null) !== e.department_id) item.changes.push({ field: 'department_id', label: 'หน่วยงาน', from: deps.find((x) => x.id === e.department_id)?.code ?? null, to: dep?.code ?? null, toId: dep?.id ?? null });
    }
    if (cPos >= 0) {
      const p = cell(row[cPos]);
      const pos = p ? poss.find((x) => x.code.toUpperCase() === p.toUpperCase()) : null;
      if (p && !pos) item.errors.push(`ไม่พบตำแหน่ง ${p}`);
      else if (pos && pos.company_id !== null && pos.company_id !== e.company_id) item.errors.push(`ตำแหน่ง ${p} อยู่คนละบริษัท`);
      else if ((pos?.id ?? null) !== e.position_id) item.changes.push({ field: 'position_id', label: 'ตำแหน่ง', from: poss.find((x) => x.id === e.position_id)?.code ?? null, to: pos?.code ?? null, toId: pos?.id ?? null });
    }
    // reporting lines are checked in file order against the changes already accepted: the result must not loop
    const mgrChange = item.changes.find((x) => x.field === 'manager_id');
    if (!item.errors.length && mgrChange) {
      const visited = new Set<number>([e.id]);
      let cur = mgrChange.toId;
      while (cur !== null && !visited.has(cur)) {
        visited.add(cur);
        cur = after.get(cur) ?? null;
      }
      if (cur !== null) item.errors.push('สายบังคับบัญชาวนกลับมาที่ตัวเอง (Circular reporting line)');
      else after.set(e.id, mgrChange.toId);
    }
  }
  const valid = out.filter((x) => !x.errors.length && x.changes.length);
  return { company, rows: out, stats: { total: out.length, changed: valid.length, unchanged: out.filter((x) => !x.errors.length && !x.changes.length).length, errors: out.filter((x) => x.errors.length).length } };
}

orgRoutes.post('/import/preview', requirePerm('org_chart.import'), async (c) => c.json(await analyzeOrgImport(c, await readJson(c))));

orgRoutes.post('/import', requirePerm('org_chart.import'), async (c) => {
  const body = await readJson(c);
  const a = await analyzeOrgImport(c, body);
  if (a.stats.errors && body.skip_invalid !== true) throw conflict(`มีรายการผิดพลาด ${a.stats.errors} แถว — ยืนยัน "นำเข้าเฉพาะรายการที่ถูกต้อง" หรือแก้ไขไฟล์ก่อน`);
  const changed = a.rows.filter((x) => !x.errors.length && x.changes.length);
  if (!changed.length) throw conflict('ไม่มีการเปลี่ยนแปลงที่จะนำเข้า');
  const user = currentUser(c);
  const db = c.env.DB;
  await db.batch(changed.map((x) => {
    const sets = x.changes.map((ch) => `${ch.field} = ?`).join(', ');
    return db.prepare(`UPDATE employees SET ${sets}, updated_at = datetime('now'), updated_by = ? WHERE id = ?`).bind(...x.changes.map((ch) => ch.toId), user.id, x.employee_id);
  }));
  await audit(c, 'org.imported', 'employees', null, { company: a.company?.id ?? null, changed: changed.length, skipped: a.stats.errors, changes: changed.slice(0, 200).map((x) => ({ emp: x.emp_code, c: x.changes.map((ch) => [ch.field, ch.from, ch.to]) })) });
  return c.json({ changed: changed.length, skipped: a.stats.errors });
});

/** Edit one employee's reporting line / department / position from the chart. */
orgRoutes.patch('/employees/:id', requirePerm('org_chart.update'), async (c) => {
  const db = c.env.DB;
  const user = currentUser(c);
  const id = intParam(c.req.param('id'));
  const e = await db.prepare('SELECT id, emp_code, company_id, manager_id, department_id, position_id FROM employees WHERE id = ?').bind(id).first<{ id: number; emp_code: string; company_id: number; manager_id: number | null; department_id: number | null; position_id: number | null }>();
  if (!e) throw notFound('ไม่พบพนักงาน');
  await requireCompany(db, user, String(e.company_id));
  const body = await readJson(c);
  const sets: string[] = [];
  const args: unknown[] = [];
  const before: Record<string, unknown> = {};
  const nextId = (k: string) => (body[k] === null || body[k] === '' ? null : intParam(String(body[k]), k));
  if ('manager_id' in body) {
    const m = nextId('manager_id');
    if (m !== null) {
      if (m === id) throw badRequest('หัวหน้าต้องไม่ใช่ตัวเอง');
      const mgr = await db.prepare('SELECT id, company_id FROM employees WHERE id = ?').bind(m).first<{ id: number; company_id: number }>();
      if (!mgr) throw badRequest('ไม่พบหัวหน้า');
      if (mgr.company_id !== e.company_id) throw badRequest('หัวหน้าอยู่คนละบริษัท');
      const loop = await db
        .prepare('WITH RECURSIVE up(id, mid) AS (SELECT id, manager_id FROM employees WHERE id = ?1 UNION SELECT x.id, x.manager_id FROM employees x JOIN up ON x.id = up.mid) SELECT 1 AS hit FROM up WHERE id = ?2 LIMIT 1')
        .bind(m, id)
        .first<{ hit: number }>();
      if (loop) throw badRequest('สายบังคับบัญชาวนกลับมาที่ตัวเอง (Circular reporting line)');
    }
    before.manager_id = e.manager_id;
    sets.push('manager_id = ?');
    args.push(m);
  }
  if ('department_id' in body) {
    const d = nextId('department_id');
    if (d !== null) {
      const dep = await db.prepare('SELECT company_id FROM departments WHERE id = ?').bind(d).first<{ company_id: number }>();
      if (!dep) throw badRequest('ไม่พบหน่วยงาน');
      if (dep.company_id !== e.company_id) throw badRequest('หน่วยงานอยู่คนละบริษัท');
    }
    before.department_id = e.department_id;
    sets.push('department_id = ?');
    args.push(d);
  }
  if ('position_id' in body) {
    const p = nextId('position_id');
    if (p !== null && !(await db.prepare('SELECT 1 AS ok FROM positions WHERE id = ?').bind(p).first())) throw badRequest('ไม่พบตำแหน่ง');
    before.position_id = e.position_id;
    sets.push('position_id = ?');
    args.push(p);
  }
  if (!sets.length) throw badRequest('ไม่มีข้อมูลที่จะแก้ไข');
  await db.prepare(`UPDATE employees SET ${sets.join(', ')}, updated_at = datetime('now'), updated_by = ? WHERE id = ?`).bind(...args, user.id, id).run();
  await audit(c, 'org.updated', 'employees', id, { emp: e.emp_code, before, after: Object.fromEntries(Object.keys(before).map((k) => [k, body[k] ?? null])) });
  return c.json({ ok: true });
});
