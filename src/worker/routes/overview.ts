import { Hono } from 'hono';
import type { AppEnv, AuthUser } from '../env';
import { CRUD_MODULES, MODULES, viewPermission } from '../../shared/modules';
import type { CrudMeta, DashboardResponse, LookupOption, MenuItem, MetaResponse, NineBoxResponse, NotificationItem, PageMeta } from '../../shared/types';
import { resolveLink } from '../../shared/links';
import { DATE_RE, badRequest, conflict, forbidden, intParam } from '../lib/http';
import { audit } from '../lib/audit';
import { loadSettings, settingText } from '../lib/settings';
import { bangkokNow } from '../lib/time';
import { companyScope, requireCompany } from '../lib/companies';
import { can, canOpen, currentUser, requireAuth, requirePerm } from '../auth';
import { toMe } from './auth';
import { modulePerms, treeOrder } from './crud';

/** href for an app path, or null when the user may not open it — dashboards never show dead links. */
export function linkIfAllowed(user: AuthUser, path: string): string | null {
  const base = path.split('?')[0] ?? '';
  // longest module path that equals the link or is its parent ("/my/payslips/12" → "/my/payslips")
  const target = MODULES.filter((m) => base === m.path || base.startsWith(`${m.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
  if (!target) return null;
  return canOpen(user, target) ? path : null;
}

export const overviewRoutes = new Hono<AppEnv>();
overviewRoutes.use('*', requireAuth);

overviewRoutes.get('/meta', async (c) => {
  const user = currentUser(c);
  const menu: MenuItem[] = MODULES.filter((m) => !(m.kind === 'page' && m.hidden) && canOpen(user, m)).map((m) => ({ key: m.key, path: m.path, title: m.title, group: m.group }));
  const modules: Array<CrudMeta | PageMeta> = MODULES.map((m) =>
    m.kind === 'crud'
      ? {
          kind: 'crud', key: m.key, path: m.path, title: m.title, group: m.group, description: m.description,
          fields: [...m.fields], computed: (m.computed ?? []).map((x) => ({ name: x.name, label: x.label })),
          ownerField: m.ownerField ?? null, workflow: m.workflow ?? null, perms: modulePerms(user, m),
        }
      : { kind: 'page', key: m.key, path: m.path, title: m.title, group: m.group, allowed: canOpen(user, m), perm: m.superAdminOnly ? 'super_admin' : m.perm },
  );
  const account = await c.env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(user.id).first<{ email: string | null }>();
  const { results: roles } = await c.env.DB
    .prepare('SELECT r.code, r.name FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ? ORDER BY r.privileged DESC, r.name')
    .bind(user.id)
    .all<{ code: string; name: string }>();
  return c.json<MetaResponse>({
    me: toMe(user), appName: c.env.APP_NAME || 'HR System', basePath: c.env.APP_BASE_PATH || '', menu, modules,
    profile: { email: account?.email || null, roles },
    companies: await companyScope(c.env.DB, user),
  });
});

async function notificationsFor(db: D1Database, user: AuthUser, basePath: string, limit = 20): Promise<NotificationItem[]> {
  const { results } = await db
    .prepare('SELECT id, title, body, link, read_at, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .bind(user.id, limit)
    .all<{ id: number; title: string; body: string | null; link: string | null; read_at: string | null; created_at: string }>();
  return results.map((n) => {
    const link = resolveLink(n.link);
    let href: string | null = null;
    if (link?.external) href = link.href;
    else if (link) {
      // internal links are only rendered when the user may open the target
      const allowed = linkIfAllowed(user, link.href);
      href = allowed ? (resolveLink(allowed, basePath)?.href ?? null) : null;
    }
    return { id: n.id, title: n.title, body: n.body, href, external: !!link?.external, read: !!n.read_at, createdAt: n.created_at };
  });
}

const NINE_BOX_TITLES: Record<number, string> = {
  1: 'Risk', 2: 'Average Performer', 3: 'Solid Performer', 4: 'Inconsistent', 5: 'Core Player', 6: 'High Performer', 7: 'Enigma', 8: 'Growth Employee', 9: 'Future Leader',
};
const boxOf = (performance: number, potential: number) => (Math.min(3, Math.max(1, potential)) - 1) * 3 + Math.min(3, Math.max(1, performance));

overviewRoutes.get('/dashboard', requirePerm('dashboard.view'), async (c) => {
  const user = currentUser(c);
  const db = c.env.DB;
  const today = bangkokNow().date;
  const in30 = new Date(Date.parse(today) + 30 * 86400000).toISOString().slice(0, 10);
  const count = async (sql: string, ...params: unknown[]) => (await db.prepare(sql).bind(...params).first<{ n: number }>())?.n ?? 0;
  // ?company= limits employee-based figures to one company the user may access (403 otherwise)
  const company = await requireCompany(db, user, c.req.query('company'));
  const inCompany = company ? ' AND e.company_id = ?' : '';
  const companyParams: unknown[] = company ? [company.id] : [];
  const companyFilter = company ? `f.company_id=${company.id}` : '';
  const scoped = company !== null;
  const kpis: DashboardResponse['kpis'] = [];
  if (can(user, 'employees.view') && can(user, 'employees.all')) {
    kpis.push({ label: 'พนักงานปัจจุบัน', value: await count(`SELECT COUNT(*) n FROM employees e WHERE e.status IN ('active','probation')${inCompany}`, ...companyParams), href: linkIfAllowed(user, companyFilter ? `/employees?${companyFilter}` : '/employees'), companyScoped: scoped });
    kpis.push({ label: 'ครบทดลองงานใน 30 วัน', value: await count(`SELECT COUNT(*) n FROM employees e WHERE e.status = 'probation' AND e.probation_end BETWEEN ? AND ?${inCompany}`, today, in30, ...companyParams), href: linkIfAllowed(user, `/employees?f.status=probation${companyFilter ? `&${companyFilter}` : ''}`), companyScoped: scoped });
  }
  if (can(user, 'leave.all')) kpis.push({ label: 'ลาวันนี้', value: await count(`SELECT COUNT(*) n FROM leave_requests l JOIN employees e ON e.id = l.employee_id WHERE l.status = 'approved' AND ? BETWEEN l.start_date AND l.end_date${inCompany}`, today, ...companyParams), href: linkIfAllowed(user, '/leave'), companyScoped: scoped });
  if (can(user, 'attendance.all')) kpis.push({ label: 'มาสายวันนี้', value: await count(`SELECT COUNT(*) n FROM attendance_records a JOIN employees e ON e.id = a.employee_id WHERE a.work_date = ? AND a.status = 'late'${inCompany}`, today, ...companyParams), href: linkIfAllowed(user, '/attendance'), companyScoped: scoped });
  // recruitment, training and payroll periods are not tied to a company in this data model
  if (can(user, 'requisitions.view')) kpis.push({ label: 'ใบขอสรรหาที่เปิด', value: await count("SELECT COUNT(*) n FROM requisitions WHERE status = 'open'"), href: linkIfAllowed(user, '/recruitment'), companyScoped: false });
  if (can(user, 'training.view')) kpis.push({ label: 'รอบอบรมที่เปิดรับ', value: await count("SELECT COUNT(*) n FROM training_sessions WHERE status IN ('planned','open')"), href: linkIfAllowed(user, '/training'), companyScoped: false });
  if (can(user, 'payroll.view')) kpis.push({ label: 'งวดเงินเดือนรอดำเนินการ', value: await count("SELECT COUNT(*) n FROM payroll_periods WHERE status <> 'published' AND deleted_at IS NULL"), href: linkIfAllowed(user, '/payroll'), companyScoped: false });

  let headcountByDepartment: DashboardResponse['headcountByDepartment'] = [];
  if (can(user, 'employees.all') && can(user, 'employees.view')) {
    const { results } = await db
      .prepare(`SELECT COALESCE(d.name, 'ไม่ระบุหน่วยงาน') AS department, COUNT(*) AS count FROM employees e LEFT JOIN departments d ON d.id = e.department_id WHERE e.status IN ('active','probation')${inCompany} GROUP BY d.id ORDER BY count DESC`)
      .bind(...companyParams)
      .all<{ department: string; count: number }>();
    headcountByDepartment = results;
  }

  // The 9-box is only returned to users who can open the Talent page, so every box links somewhere valid.
  let nineBox: DashboardResponse['nineBox'] = null;
  if (can(user, 'talent.view')) {
    const cycle = await db.prepare("SELECT id FROM performance_cycles ORDER BY (status = 'active') DESC, start_date DESC LIMIT 1").first<{ id: number }>();
    const { results } = cycle
      ? await db.prepare(`SELECT t.performance, t.potential FROM talent_assessments t JOIN employees e ON e.id = t.employee_id WHERE t.cycle_id = ?${inCompany}`).bind(cycle.id, ...companyParams).all<{ performance: number; potential: number }>()
      : { results: [] as Array<{ performance: number; potential: number }> };
    nineBox = [7, 8, 9, 4, 5, 6, 1, 2, 3].map((box) => ({
      box,
      title: NINE_BOX_TITLES[box] ?? String(box),
      count: results.filter((r) => boxOf(r.performance, r.potential) === box).length,
      href: linkIfAllowed(user, `/talent?box=${box}`),
    }));
  }

  const pending = await c.env.DB.prepare("SELECT COUNT(*) n FROM workflow_requests WHERE status = 'pending' AND requester_user_id <> ?").bind(user.id).first<{ n: number }>();
  return c.json<DashboardResponse>({
    kpis,
    headcountByDepartment,
    nineBox,
    pendingApprovals: can(user, 'workflow.approve') || can(user, 'workflow.approve_any') ? (pending?.n ?? 0) : 0,
    notifications: await notificationsFor(db, user, c.env.APP_BASE_PATH || '', 5),
    company,
  });
});

// ---- ESS ------------------------------------------------------------------------------------
overviewRoutes.get('/ess', requirePerm('ess.view'), async (c) => {
  const user = currentUser(c);
  const db = c.env.DB;
  if (user.employeeId === null) return c.json({ linked: false, employee: null, today: null, leaveBalances: [], requests: [], payslips: [] });
  const year = bangkokNow().date.slice(0, 4);
  const employee = await db
    .prepare(
      `SELECT e.id, e.emp_code, e.first_name, e.last_name, e.email, e.hire_date, e.status,
         (SELECT name FROM departments d WHERE d.id = e.department_id) AS department,
         (SELECT title FROM positions p WHERE p.id = e.position_id) AS position
       FROM employees e WHERE e.id = ?`,
    )
    .bind(user.employeeId)
    .first();
  const today = await db.prepare('SELECT work_date, clock_in, clock_out, status FROM attendance_records WHERE employee_id = ? AND work_date = ?').bind(user.employeeId, bangkokNow().date).first();
  const { results: leaveBalances } = await db
    .prepare(
      `SELECT t.id, t.name, t.days_per_year AS entitled,
         COALESCE((SELECT SUM(l.days) FROM leave_requests l WHERE l.leave_type_id = t.id AND l.employee_id = ? AND l.status = 'approved' AND substr(l.start_date, 1, 4) = ?), 0) AS used
       FROM leave_types t ORDER BY t.code`,
    )
    .bind(user.employeeId, year)
    .all();
  const { results: requests } = await db.prepare("SELECT id, summary, status, created_at FROM workflow_requests WHERE requester_user_id = ? ORDER BY id DESC LIMIT 5").bind(user.id).all();
  const { results: payslips } = await db
    .prepare('SELECT s.id, p.name AS period_name, p.pay_date, s.net FROM payslips s JOIN payroll_periods p ON p.id = s.period_id WHERE s.employee_id = ? AND s.published = 1 ORDER BY p.start_date DESC LIMIT 3')
    .bind(user.employeeId)
    .all();
  return c.json({ linked: true, employee, today, leaveBalances, requests, payslips });
});

overviewRoutes.post('/ess/clock', requirePerm('ess.view'), async (c) => {
  const user = currentUser(c);
  if (user.employeeId === null) throw forbidden('บัญชีนี้ไม่ได้ผูกกับข้อมูลพนักงาน');
  const body = (await c.req.json().catch(() => ({}))) as { action?: string };
  const { date, time } = bangkokNow();
  const db = c.env.DB;
  const existing = await db.prepare('SELECT id, clock_in, clock_out FROM attendance_records WHERE employee_id = ? AND work_date = ?').bind(user.employeeId, date).first<{ id: number; clock_in: string | null; clock_out: string | null }>();
  if (body.action === 'in') {
    if (existing?.clock_in) throw conflict('ลงเวลาเข้าแล้ววันนี้');
    const shift = await db
      .prepare('SELECT s.start_time FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id WHERE a.employee_id = ? AND a.start_date <= ? AND (a.end_date IS NULL OR a.end_date >= ?) ORDER BY a.start_date DESC LIMIT 1')
      .bind(user.employeeId, date, date)
      .first<{ start_time: string }>();
    const start = shift?.start_time ?? settingText(await loadSettings(db), 'attendance.default_start_time', '09:00');
    const status = time > start ? 'late' : 'present';
    if (existing) await db.prepare("UPDATE attendance_records SET clock_in = ?, status = ?, source = 'web', updated_at = datetime('now'), updated_by = ? WHERE id = ?").bind(time, status, user.id, existing.id).run();
    else await db.prepare("INSERT INTO attendance_records (employee_id, work_date, clock_in, status, source, created_by, updated_by) VALUES (?, ?, ?, ?, 'web', ?, ?)").bind(user.employeeId, date, time, status, user.id, user.id).run();
    await audit(c, 'attendance.clock_in', 'attendance', user.employeeId, { date, time, status });
    return c.json({ ok: true, date, time, status });
  }
  if (body.action === 'out') {
    if (!existing?.clock_in) throw conflict('ยังไม่ได้ลงเวลาเข้า');
    if (existing.clock_out) throw conflict('ลงเวลาออกแล้ววันนี้');
    await db.prepare("UPDATE attendance_records SET clock_out = ?, updated_at = datetime('now'), updated_by = ? WHERE id = ?").bind(time, user.id, existing.id).run();
    await audit(c, 'attendance.clock_out', 'attendance', user.employeeId, { date, time });
    return c.json({ ok: true, date, time });
  }
  throw badRequest('action ต้องเป็น in หรือ out');
});

// ---- Analytics ------------------------------------------------------------------------------
overviewRoutes.get('/analytics', requirePerm('analytics.view'), async (c) => {
  const db = c.env.DB;
  const today = bangkokNow().date;
  const from = c.req.query('from') ?? `${today.slice(0, 4)}-01-01`;
  const to = c.req.query('to') ?? today;
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) throw badRequest('ช่วงวันที่ไม่ถูกต้อง');
  const dep = c.req.query('department_id') ? intParam(c.req.query('department_id'), 'department_id') : null;

  // include sub-departments of the selected department
  const { results: deptRows } = await db.prepare("SELECT id AS value, name || ' (' || code || ')' AS label, code, parent_id AS parentId FROM departments ORDER BY code").all<{ value: number; label: string; code: string; parentId: number | null }>();
  const departments: LookupOption[] = treeOrder(deptRows);
  let scope: number[] | null = null;
  if (dep !== null) {
    scope = [dep];
    for (let i = 0; i < scope.length; i++) for (const d of deptRows) if (d.parentId === scope[i] && !scope.includes(d.value)) scope.push(d.value);
  }
  const inDep = scope ? `AND e.department_id IN (${scope.map(() => '?').join(',')})` : '';
  const dp = scope ?? [];
  const one = async (sql: string, ...params: unknown[]) => (await db.prepare(sql).bind(...params).first<{ n: number | null }>())?.n ?? 0;

  const headcount = await one(`SELECT COUNT(*) n FROM employees e WHERE e.status IN ('active','probation') ${inDep}`, ...dp);
  const hires = await one(`SELECT COUNT(*) n FROM employees e WHERE e.hire_date BETWEEN ? AND ? ${inDep}`, from, to, ...dp);
  const leavers = await one(`SELECT COUNT(*) n FROM offboarding_cases o JOIN employees e ON e.id = o.employee_id WHERE o.last_day BETWEEN ? AND ? ${inDep}`, from, to, ...dp);
  const leaveDays = await one(`SELECT SUM(l.days) n FROM leave_requests l JOIN employees e ON e.id = l.employee_id WHERE l.status = 'approved' AND l.start_date BETWEEN ? AND ? ${inDep}`, from, to, ...dp);
  const otHours = await one(`SELECT SUM(o.hours) n FROM overtime_requests o JOIN employees e ON e.id = o.employee_id WHERE o.status = 'approved' AND o.work_date BETWEEN ? AND ? ${inDep}`, from, to, ...dp);
  const lateDays = await one(`SELECT COUNT(*) n FROM attendance_records a JOIN employees e ON e.id = a.employee_id WHERE a.status = 'late' AND a.work_date BETWEEN ? AND ? ${inDep}`, from, to, ...dp);
  const trainingHours = await one(
    `SELECT SUM(co.hours) n FROM training_enrollments en JOIN training_sessions s ON s.id = en.session_id JOIN courses co ON co.id = s.course_id JOIN employees e ON e.id = en.employee_id
     WHERE en.status IN ('attended','completed') AND s.start_date BETWEEN ? AND ? ${inDep}`, from, to, ...dp);
  const { results: byDepartment } = await db
    .prepare(`SELECT COALESCE(d.name, 'ไม่ระบุ') AS label, COUNT(*) AS value FROM employees e LEFT JOIN departments d ON d.id = e.department_id WHERE e.status IN ('active','probation') ${inDep} GROUP BY d.id ORDER BY value DESC`)
    .bind(...dp)
    .all<{ label: string; value: number }>();
  const enps = await db
    .prepare(`SELECT COUNT(*) AS n, SUM(score >= 9) AS promoters, SUM(score <= 6) AS detractors FROM survey_responses r JOIN surveys s ON s.id = r.survey_id WHERE s.type = 'enps' AND COALESCE(s.close_date, s.open_date) BETWEEN ? AND ?`)
    .bind(from, to)
    .first<{ n: number; promoters: number | null; detractors: number | null }>();
  const turnover = headcount ? Math.round((leavers / headcount) * 10000) / 100 : 0;
  return c.json({
    range: { from, to, departmentId: dep },
    departments,
    metrics: { headcount, hires, leavers, turnover, leaveDays, otHours, lateDays, trainingHours },
    byDepartment,
    enps: enps && enps.n ? { responses: enps.n, score: Math.round((((enps.promoters ?? 0) - (enps.detractors ?? 0)) / enps.n) * 100) } : null,
  });
});

// ---- Talent 9-box ---------------------------------------------------------------------------
overviewRoutes.get('/talent/ninebox', requirePerm('talent.view'), async (c) => {
  const db = c.env.DB;
  const { results: cycles } = await db.prepare("SELECT id AS value, name || ' (' || code || ')' AS label, code FROM performance_cycles ORDER BY start_date DESC").all<{ value: number; label: string; code: string }>();
  const requested = c.req.query('cycle_id');
  const cycleId = requested ? intParam(requested, 'cycle_id') : (cycles[0]?.value ?? null);
  const { results } = cycleId
    ? await db
        .prepare("SELECT e.id, e.emp_code || ' ' || e.first_name || ' ' || e.last_name AS name, t.performance, t.potential FROM talent_assessments t JOIN employees e ON e.id = t.employee_id WHERE t.cycle_id = ? ORDER BY e.emp_code")
        .bind(cycleId)
        .all<{ id: number; name: string; performance: number; potential: number }>()
    : { results: [] as Array<{ id: number; name: string; performance: number; potential: number }> };
  const boxes: NineBoxResponse['boxes'] = [];
  for (let box = 1; box <= 9; box++) {
    boxes.push({
      box,
      title: NINE_BOX_TITLES[box] ?? String(box),
      performance: ((box - 1) % 3) + 1,
      potential: Math.floor((box - 1) / 3) + 1,
      employees: results.filter((r) => boxOf(r.performance, r.potential) === box).map((r) => ({ id: r.id, name: r.name })),
    });
  }
  return c.json<NineBoxResponse>({ cycleId, cycles: cycles.map((x) => ({ ...x, parentId: null, depth: 0 })), boxes });
});

// ---- Organization chart ---------------------------------------------------------------------
overviewRoutes.get('/organization', requirePerm('departments.view'), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT d.id, d.code, d.name, d.parent_id,
       (SELECT emp_code || ' ' || first_name || ' ' || last_name FROM employees h WHERE h.department_id = d.id AND h.status IN ('active','probation') ORDER BY (SELECT job_grade FROM positions p WHERE p.id = h.position_id) DESC LIMIT 1) AS head,
       (SELECT COUNT(*) FROM employees e WHERE e.department_id = d.id AND e.status IN ('active','probation')) AS headcount
     FROM departments d WHERE d.active = 1 ORDER BY d.code`,
  ).all<{ id: number; code: string; name: string; parent_id: number | null; head: string | null; headcount: number }>();
  return c.json(results);
});

// ---- Notifications --------------------------------------------------------------------------
overviewRoutes.get('/notifications', async (c) => {
  const user = currentUser(c);
  const unread = await c.env.DB.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL').bind(user.id).first<{ n: number }>();
  return c.json({ unread: unread?.n ?? 0, items: await notificationsFor(c.env.DB, user, c.env.APP_BASE_PATH || '') });
});

overviewRoutes.post('/notifications/:id/read', async (c) => {
  const user = currentUser(c);
  await c.env.DB.prepare("UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND user_id = ? AND read_at IS NULL").bind(intParam(c.req.param('id')), user.id).run();
  return c.json({ ok: true });
});

overviewRoutes.post('/notifications/read-all', async (c) => {
  const user = currentUser(c);
  await c.env.DB.prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL").bind(user.id).run();
  return c.json({ ok: true });
});

// ---- Reports --------------------------------------------------------------------------------
overviewRoutes.get('/reports/datasets', requirePerm('reports.view'), (c) => {
  const user = currentUser(c);
  const datasets = CRUD_MODULES.filter((m) => modulePerms(user, m).view).map((m) => ({
    key: m.key,
    title: m.title,
    canExport: modulePerms(user, m).export,
    columns: [...m.fields.map((f) => ({ name: f.name, label: f.label, ref: f.type === 'ref' })), ...(m.computed ?? []).map((x) => ({ name: x.name, label: x.label, ref: false }))],
  }));
  return c.json(datasets);
});

// ---- Audit log ------------------------------------------------------------------------------
overviewRoutes.get('/audit', requirePerm('audit.view'), async (c) => {
  const where: string[] = ['1'];
  const params: unknown[] = [];
  const q = (c.req.query('q') ?? '').trim();
  if (q) {
    where.push('(action LIKE ? OR entity LIKE ? OR username LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const action = c.req.query('action');
  if (action) {
    where.push('action LIKE ?');
    params.push(`${action}%`);
  }
  const page = Math.max(1, Number(c.req.query('page')) || 1);
  const pageSize = 50;
  const total = await c.env.DB.prepare(`SELECT COUNT(*) n FROM audit_logs WHERE ${where.join(' AND ')}`).bind(...params).first<{ n: number }>();
  const { results } = await c.env.DB.prepare(`SELECT id, at, username, action, entity, entity_id, details, ip FROM audit_logs WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .bind(...params, pageSize, (page - 1) * pageSize)
    .all();
  return c.json({ rows: results, total: total?.n ?? 0, page, pageSize });
});

// ---- Help -----------------------------------------------------------------------------------
overviewRoutes.get('/help', requirePerm('help.view'), (c) => {
  const user = currentUser(c);
  return c.json({
    modules: MODULES.map((m) => ({ title: m.title, path: m.path, permission: m.kind === 'page' && m.superAdminOnly ? 'บทบาท super_admin เท่านั้น' : viewPermission(m), allowed: canOpen(user, m) })),
  });
});
