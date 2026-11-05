// Holiday calendar API: calendars (central per country / per company), holidays (draft → verified source → approved by a
// second person → inactive), substitute days, Excel / CSV import as drafts, Excel export, day classification for
// attendance, verified holiday-work records and holiday pay rules. Every route checks the permission and the company
// scope; a holiday or record used by a payroll calculation can no longer change what was paid.
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv, AuthUser } from '../env';
import type { CompanyScope } from '../../shared/types';
import {
  DEFAULT_COUNTRY, EMPLOYMENT_TYPES, HOLIDAY_TYPES, classifyDay, exportGrid, holidayWindow, inWindow, isIsoDate, missingSubstitutes, parseWeeklyRest, ruleProblems,
  traditionalCompliance, validateImport, weekday, type ApplicableHoliday, type ComplianceHoliday, type HolidayCalendarRow, type HolidayListResponse, type HolidayPayRuleRow, type HolidayRow, type HolidayType, type HolidayWorkRow,
} from '../../shared/holidays';
import { writeXlsx, type Cell } from '../../shared/xlsx';
import { addDays, daysInclusive } from '../../shared/payroll';
import { badRequest, conflict, forbidden, intParam, notFound, readJson, safeName, str } from '../lib/http';
import { audit } from '../lib/audit';
import { companyScope } from '../lib/companies';
import { loadSettings, payrollConfig } from '../lib/settings';
import { bangkokNow } from '../lib/time';
import { can, currentUser, requireAuth, requirePerm } from '../auth';

export const holidayRoutes = new Hono<AppEnv>();
holidayRoutes.use('*', requireAuth, requirePerm('holiday_calendar.view'));

const P = {
  view: 'holiday_calendar.view',
  create: 'holiday_calendar.create',
  update: 'holiday_calendar.update',
  delete: 'holiday_calendar.delete',
  approve: 'holiday_calendar.approve',
  import: 'holiday_calendar.import',
  export: 'holiday_calendar.export',
} as const;

const openWindow = () => holidayWindow(bangkokNow().date);

// ---- scope ---------------------------------------------------------------------------------------
async function scopeOf(c: Context<AppEnv>): Promise<CompanyScope> {
  return companyScope(c.env.DB, currentUser(c));
}

/** SQL condition (alias cal) for calendars the user may see: central ones and companies in scope. */
function visibleCalendars(scope: CompanyScope): { sql: string; params: unknown[] } {
  if (scope.scope === 'all') return { sql: '1', params: [] };
  return { sql: `(cal.company_id IS NULL OR cal.company_id IN (SELECT value FROM json_each(?)))`, params: [JSON.stringify(scope.items.map((x) => x.id))] };
}

/** Writing to a central calendar needs organisation-wide scope; a company calendar needs that company in scope. */
function assertWritable(scope: CompanyScope, companyId: number | null): void {
  if (companyId === null ? scope.scope !== 'all' : !scope.items.some((x) => x.id === companyId)) throw forbidden('ไม่มีสิทธิ์แก้ไขปฏิทินของบริษัทนี้');
}

const CAL_SELECT = `SELECT cal.id, cal.code, cal.name, cal.country_code, cal.company_id, co.name AS company, cal.weekly_rest_days, cal.active
  FROM holiday_calendars cal LEFT JOIN companies co ON co.id = cal.company_id`;

async function calendarOr404(c: Context<AppEnv>, id: number, write: boolean): Promise<HolidayCalendarRow> {
  const scope = await scopeOf(c);
  const v = visibleCalendars(scope);
  const cal = await c.env.DB.prepare(`${CAL_SELECT} WHERE cal.id = ? AND ${v.sql}`).bind(id, ...v.params).first<HolidayCalendarRow>();
  if (!cal) throw notFound('ไม่พบปฏิทินวันหยุด');
  if (write) assertWritable(scope, cal.company_id);
  return cal;
}

const HOLIDAY_SELECT = `SELECT h.id, h.calendar_id, cal.code AS calendar_code, cal.country_code, cal.company_id, co.name AS company, h.holiday_date, h.year, h.name, h.name_en,
  h.holiday_type, h.status, h.origin, h.verification, h.source_reference, h.source_url, h.region, h.note, h.created_by, h.updated_at, h.approved_at,
  (SELECT u.username FROM users u WHERE u.id = h.approved_by) AS approved_by_name,
  (SELECT s.original_holiday_id FROM holiday_substitutions s WHERE s.substitute_holiday_id = h.id) AS substitute_for,
  (SELECT COUNT(*) FROM holiday_substitutions s JOIN holidays x ON x.id = s.substitute_holiday_id WHERE s.original_holiday_id = h.id AND x.status <> 'inactive') AS substituted,
  (SELECT COUNT(*) FROM holiday_work_records w WHERE w.holiday_id = h.id) AS work_records,
  (SELECT COUNT(*) FROM holiday_work_records w WHERE w.holiday_id = h.id AND w.payroll_period_id IS NOT NULL) AS payroll_locked
  FROM holidays h JOIN holiday_calendars cal ON cal.id = h.calendar_id LEFT JOIN companies co ON co.id = cal.company_id`;

type HolidayFull = HolidayRow & { updated_at: string; substituted: number };

async function holidayOr404(c: Context<AppEnv>, id: number, write: boolean): Promise<HolidayFull & { cal: HolidayCalendarRow }> {
  const h = await c.env.DB.prepare(`${HOLIDAY_SELECT} WHERE h.id = ?`).bind(id).first<HolidayFull>();
  if (!h) throw notFound('ไม่พบวันหยุด');
  // a holiday of a calendar outside the user's scope answers 404, exactly like a missing one
  return { ...h, cal: await calendarOr404(c, h.calendar_id, write) };
}

// ---- input helpers -------------------------------------------------------------------------------
function reasonOf(body: Record<string, unknown>): string {
  const r = str(body, 'reason', { required: true, max: 500 }) as string;
  if (r.length < 5) throw badRequest('กรุณาระบุเหตุผลอย่างน้อย 5 ตัวอักษร');
  return r;
}

function dateIn(body: Record<string, unknown>, key: string): string {
  const d = str(body, key, { required: true }) as string;
  if (!isIsoDate(d)) throw badRequest(`${key} ต้องเป็นวันที่จริงในรูปแบบ YYYY-MM-DD`);
  const w = openWindow();
  if (!inWindow(d, w)) throw badRequest(`วันที่ต้องอยู่ในปี ${w.from}–${w.to} (ปีปัจจุบันและล่วงหน้า 9 ปี)`);
  return d;
}

function httpsUrl(body: Record<string, unknown>): string | null {
  const u = str(body, 'source_url', { max: 500 });
  if (u && !/^https:\/\/[^\s]+$/i.test(u)) throw badRequest('ลิงก์ประกาศต้องขึ้นต้นด้วย https://');
  return u;
}

function typeIn(body: Record<string, unknown>): HolidayType {
  const t = str(body, 'holiday_type', { required: true }) as string;
  if (!(HOLIDAY_TYPES as readonly string[]).includes(t)) throw badRequest('ประเภทวันหยุดไม่ถูกต้อง');
  return t as HolidayType;
}

function hoursIn(body: Record<string, unknown>, key: string): number {
  const v = body[key] === undefined || body[key] === null || body[key] === '' ? 0 : Number(body[key]);
  if (!Number.isFinite(v) || v < 0 || v > 24 || Math.round(v * 100) !== v * 100) throw badRequest(`${key} ต้องเป็นตัวเลข 0–24 (ทศนิยมไม่เกิน 2 ตำแหน่ง)`);
  return v;
}

const isUnique = (e: unknown) => e instanceof Error && /UNIQUE/i.test(e.message);

// ---- list / export -------------------------------------------------------------------------------
interface Filters {
  where: string[];
  params: unknown[];
}

async function filters(c: Context<AppEnv>): Promise<Filters> {
  const scope = await scopeOf(c);
  const v = visibleCalendars(scope);
  const where = [v.sql];
  const params: unknown[] = [...v.params];
  const q = c.req.query();
  if (q.year) {
    where.push('h.year = ?');
    params.push(intParam(q.year, 'year'));
  }
  if (q.calendar_id) {
    where.push('h.calendar_id = ?');
    params.push(intParam(q.calendar_id, 'calendar_id'));
  }
  if (q.company) {
    // a company sees its own calendar plus the central calendars
    const id = intParam(q.company, 'company');
    if (scope.scope !== 'all' && !scope.items.some((x) => x.id === id)) throw forbidden('ไม่มีสิทธิ์เข้าถึงข้อมูลของบริษัทนี้');
    where.push('(cal.company_id IS NULL OR cal.company_id = ?)');
    params.push(id);
  }
  if (q.type) {
    if (!(HOLIDAY_TYPES as readonly string[]).includes(q.type)) throw badRequest('ประเภทวันหยุดไม่ถูกต้อง');
    where.push('h.holiday_type = ?');
    params.push(q.type);
  }
  if (q.status) {
    if (!['draft', 'approved', 'inactive'].includes(q.status)) throw badRequest('สถานะไม่ถูกต้อง');
    where.push('h.status = ?');
    params.push(q.status);
  }
  if (q.country) {
    where.push('cal.country_code = ?');
    params.push(q.country.toUpperCase().slice(0, 2));
  }
  if (q.q) {
    where.push("(h.name LIKE ? ESCAPE '\\' OR h.name_en LIKE ? ESCAPE '\\' OR h.note LIKE ? ESCAPE '\\' OR h.source_reference LIKE ? ESCAPE '\\')");
    const like = `%${q.q.slice(0, 100).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    params.push(like, like, like, like);
  }
  return { where, params };
}

/**
 * Traditional-holiday count per company context for one year (central calendar of the country + the company's own
 * calendar; the central calendar alone when the company has none). Independent of the list filters. Read-only: the
 * system never creates or approves holidays to reach the minimum.
 */
async function compliance(db: D1Database, scope: CompanyScope, calendars: HolidayCalendarRow[], year: number, companyId: number | null): Promise<HolidayListResponse['compliance']> {
  const active = calendars.filter((x) => x.active);
  const { results } = await db
    .prepare(`SELECT h.id, h.holiday_date, h.name, h.holiday_type, h.status, h.calendar_id FROM holidays h WHERE h.year = ? AND h.calendar_id IN (SELECT value FROM json_each(?))`)
    .bind(year, JSON.stringify(active.map((x) => x.id)))
    .all<ComplianceHoliday & { calendar_id: number }>();
  const contexts: Array<{ company_id: number | null; company: string | null; country_code: string; calendarIds: number[] }> = [];
  for (const cal of active) {
    if (cal.company_id === null) {
      if (companyId === null) contexts.push({ company_id: null, company: null, country_code: cal.country_code, calendarIds: [cal.id] });
      continue;
    }
    if (companyId !== null && cal.company_id !== companyId) continue;
    const central = active.find((x) => x.company_id === null && x.country_code === cal.country_code);
    contexts.push({ company_id: cal.company_id, company: cal.company, country_code: cal.country_code, calendarIds: [cal.id, ...(central ? [central.id] : [])] });
  }
  if (companyId !== null && !contexts.length) {
    // the company has no calendar of its own: the central calendar applies as it is
    const central = active.find((x) => x.company_id === null && x.country_code === DEFAULT_COUNTRY);
    const name = scope.items.find((x) => x.id === companyId)?.name ?? null;
    if (central) contexts.push({ company_id: companyId, company: name, country_code: central.country_code, calendarIds: [central.id] });
  }
  return contexts.map((ctx) => ({ company_id: ctx.company_id, company: ctx.company, country_code: ctx.country_code, ...traditionalCompliance(results.filter((h) => ctx.calendarIds.includes(h.calendar_id)), year) }));
}

holidayRoutes.get('/', async (c) => {
  const user = currentUser(c);
  const scope = await scopeOf(c);
  const f = await filters(c);
  const v = visibleCalendars(scope);
  const db = c.env.DB;
  const { results: calendars } = await db.prepare(`${CAL_SELECT} WHERE ${v.sql} ORDER BY cal.company_id IS NOT NULL, cal.country_code, co.name`).bind(...v.params).all<HolidayCalendarRow>();
  const { results } = await db.prepare(`${HOLIDAY_SELECT} WHERE ${f.where.join(' AND ')} ORDER BY h.holiday_date, cal.company_id IS NOT NULL, h.id LIMIT 3000`).bind(...f.params).all<HolidayFull>();
  // a traditional / labour holiday on a weekly rest day needs a substitute day: flagged for HR
  const needs = new Set<number>();
  for (const cal of calendars) {
    const rest = parseWeeklyRest(cal.weekly_rest_days) ?? [];
    const own = results.filter((h) => h.calendar_id === cal.id && h.status !== 'inactive' && h.holiday_type !== 'substitute');
    for (const id of missingSubstitutes(own.map((h) => ({ ...h, substituted: h.substituted > 0 })), rest)) needs.add(id);
  }
  const body: HolidayListResponse = {
    window: openWindow(),
    calendars,
    holidays: results.map((h) => ({ ...h, needs_substitute: needs.has(h.id) })),
    compliance: await compliance(db, scope, calendars, c.req.query('year') ? intParam(c.req.query('year'), 'year') : Number(bangkokNow().date.slice(0, 4)), c.req.query('company') ? intParam(c.req.query('company'), 'company') : null),
    can: {
      create: can(user, P.create),
      update: can(user, P.update),
      delete: can(user, P.delete),
      approve: can(user, P.approve),
      import: can(user, P.import),
      export: can(user, P.export),
      allCompanies: scope.scope === 'all',
    },
  };
  return c.json(body);
});

holidayRoutes.get('/export.xlsx', requirePerm(P.export), async (c) => {
  const f = await filters(c);
  const { results } = await c.env.DB.prepare(`${HOLIDAY_SELECT} WHERE ${f.where.join(' AND ')} ORDER BY h.holiday_date, h.id LIMIT 5000`).bind(...f.params).all<HolidayFull>();
  const name = safeName(`holidays-${c.req.query('year') ?? 'all'}`);
  await audit(c, 'holiday.exported', 'holidays', null, { rows: results.length, filters: c.req.query() });
  return c.body(writeXlsx('Holidays', exportGrid(results)) as unknown as ArrayBuffer, 200, {
    'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'content-disposition': `attachment; filename="${name}.xlsx"`,
    'cache-control': 'no-store',
  });
});

// ---- day classification (attendance integration) -------------------------------------------------
async function applicable(db: D1Database, companyId: number, from: string, to: string): Promise<{ holidays: ApplicableHoliday[]; weeklyRest: number[] }> {
  const { results: cals } = await db
    .prepare("SELECT id, company_id, weekly_rest_days, country_code FROM holiday_calendars WHERE active = 1 AND (company_id = ?1 OR (company_id IS NULL AND country_code = COALESCE((SELECT country_code FROM holiday_calendars WHERE company_id = ?1 AND active = 1), ?2)))")
    .bind(companyId, DEFAULT_COUNTRY)
    .all<{ id: number; company_id: number | null; weekly_rest_days: string }>();
  const own = cals.find((x) => x.company_id !== null) ?? cals[0];
  const ids = cals.map((x) => x.id);
  const { results } = ids.length
    ? await db
        .prepare(`SELECT h.id, h.holiday_date, h.name, h.holiday_type, cal.company_id FROM holidays h JOIN holiday_calendars cal ON cal.id = h.calendar_id WHERE h.status = 'approved' AND h.calendar_id IN (SELECT value FROM json_each(?1)) AND h.holiday_date BETWEEN ?2 AND ?3`)
        .bind(JSON.stringify(ids), from, to)
        .all<ApplicableHoliday>()
    : { results: [] as ApplicableHoliday[] };
  return { holidays: results, weeklyRest: parseWeeklyRest(own?.weekly_rest_days ?? '0,6') ?? [0, 6] };
}

holidayRoutes.get('/day-types', async (c) => {
  const scope = await scopeOf(c);
  const companyId = intParam(c.req.query('company'), 'company');
  if (scope.scope !== 'all' && !scope.items.some((x) => x.id === companyId)) throw forbidden('ไม่มีสิทธิ์เข้าถึงข้อมูลของบริษัทนี้');
  const from = c.req.query('from') ?? '';
  const to = c.req.query('to') ?? '';
  if (!isIsoDate(from) || !isIsoDate(to) || to < from || daysInclusive(from, to) > 366) throw badRequest('ช่วงวันที่ไม่ถูกต้อง (YYYY-MM-DD, ไม่เกิน 366 วัน)');
  const { holidays, weeklyRest } = await applicable(c.env.DB, companyId, from, to);
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(classifyDay(d, holidays, weeklyRest));
  return c.json({ company_id: companyId, weeklyRest, days });
});

// ---- calendars -----------------------------------------------------------------------------------
holidayRoutes.post('/calendars', requirePerm(P.create), async (c) => {
  const user = currentUser(c);
  const body = await readJson(c);
  const companyId = body.company_id === null || body.company_id === undefined || body.company_id === '' ? null : intParam(String(body.company_id), 'company_id');
  const country = (str(body, 'country_code') ?? DEFAULT_COUNTRY).toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw badRequest('รหัสประเทศต้องเป็น ISO 3166 สองตัวอักษร เช่น TH');
  assertWritable(await scopeOf(c), companyId);
  const company = companyId === null ? null : await c.env.DB.prepare('SELECT code, name FROM companies WHERE id = ?').bind(companyId).first<{ code: string; name: string }>();
  if (companyId !== null && !company) throw badRequest('ไม่พบบริษัท');
  const rest = parseWeeklyRest(str(body, 'weekly_rest_days') ?? '0,6');
  if (!rest) throw badRequest('วันหยุดประจำสัปดาห์ต้องเป็นตัวเลข 0–6 คั่นด้วยจุลภาค (0 = อาทิตย์)');
  const name = str(body, 'name', { max: 200 }) ?? `ปฏิทินวันหยุด · ${company?.name ?? country}`;
  try {
    const row = await c.env.DB.prepare('INSERT INTO holiday_calendars (code, name, country_code, company_id, weekly_rest_days, description, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id')
      .bind(company ? `${country}-${company.code}` : country, name, country, companyId, rest.join(','), str(body, 'description', { max: 500 }), user.id, user.id)
      .first<{ id: number }>();
    await audit(c, 'holiday.calendar_created', 'holiday_calendars', row?.id ?? null, { country, company: companyId });
    return c.json(await calendarOr404(c, row?.id ?? 0, false), 201);
  } catch (e) {
    if (isUnique(e)) throw conflict('มีปฏิทินของบริษัท/ประเทศนี้อยู่แล้ว');
    throw e;
  }
});

holidayRoutes.put('/calendars/:id', requirePerm(P.update), async (c) => {
  const user = currentUser(c);
  const cal = await calendarOr404(c, intParam(c.req.param('id')), true);
  const body = await readJson(c);
  const rest = body.weekly_rest_days === undefined ? cal.weekly_rest_days : parseWeeklyRest(String(body.weekly_rest_days))?.join(',');
  if (rest === undefined) throw badRequest('วันหยุดประจำสัปดาห์ต้องเป็นตัวเลข 0–6 คั่นด้วยจุลภาค (0 = อาทิตย์)');
  const name = str(body, 'name', { max: 200 }) ?? cal.name;
  const active = body.active === undefined ? cal.active : body.active === true || body.active === 1 ? 1 : 0;
  await c.env.DB.prepare("UPDATE holiday_calendars SET name = ?, weekly_rest_days = ?, active = ?, updated_at = datetime('now'), updated_by = ? WHERE id = ?").bind(name, rest, active, user.id, cal.id).run();
  await audit(c, 'holiday.calendar_updated', 'holiday_calendars', cal.id, { from: { name: cal.name, weekly_rest_days: cal.weekly_rest_days, active: cal.active }, to: { name, weekly_rest_days: rest, active } });
  return c.json(await calendarOr404(c, cal.id, false));
});

// ---- holiday pay rules ---------------------------------------------------------------------------
const RULE_SELECT = `SELECT r.id, r.company_id, co.name AS company, r.employment_type, r.holiday_pay_entitled, r.work_multiplier, r.ot_multiplier, r.effective_from, r.effective_to,
  r.legal_basis, r.status, r.created_by, r.approved_at, (SELECT u.username FROM users u WHERE u.id = r.approved_by) AS approved_by_name
  FROM holiday_pay_rules r LEFT JOIN companies co ON co.id = r.company_id`;

async function ruleOr404(c: Context<AppEnv>, id: number, write: boolean): Promise<HolidayPayRuleRow> {
  const scope = await scopeOf(c);
  const r = await c.env.DB.prepare(`${RULE_SELECT} WHERE r.id = ?`).bind(id).first<HolidayPayRuleRow>();
  if (!r || (r.company_id !== null && scope.scope !== 'all' && !scope.items.some((x) => x.id === r.company_id))) throw notFound('ไม่พบกฎค่าจ้างวันหยุด');
  if (write) assertWritable(scope, r.company_id);
  return r;
}

holidayRoutes.get('/pay-rules', async (c) => {
  const scope = await scopeOf(c);
  const ids = JSON.stringify(scope.items.map((x) => x.id));
  const { results } = await c.env.DB.prepare(`${RULE_SELECT} WHERE (?1 = 'all' OR r.company_id IS NULL OR r.company_id IN (SELECT value FROM json_each(?2))) ORDER BY r.status = 'inactive', r.company_id IS NOT NULL, r.employment_type, r.effective_from DESC`)
    .bind(scope.scope, ids)
    .all<HolidayPayRuleRow>();
  return c.json(results);
});

holidayRoutes.post('/pay-rules', requirePerm(P.create), async (c) => {
  const user = currentUser(c);
  const body = await readJson(c);
  const companyId = body.company_id === null || body.company_id === undefined || body.company_id === '' ? null : intParam(String(body.company_id), 'company_id');
  assertWritable(await scopeOf(c), companyId);
  const type = str(body, 'employment_type', { required: true }) as string;
  if (!(EMPLOYMENT_TYPES as readonly string[]).includes(type)) throw badRequest('ประเภทการจ้างไม่ถูกต้อง');
  if (typeof body.holiday_pay_entitled !== 'boolean') throw badRequest('กรุณาระบุว่ามีสิทธิได้รับค่าจ้างในวันหยุดหรือไม่ (true / false)');
  const rule = { entitled: body.holiday_pay_entitled, workMultiplier: Number(body.work_multiplier), otMultiplier: Number(body.ot_multiplier) };
  const problems = ruleProblems(rule);
  if (problems.length) throw badRequest(problems.join(' · '));
  const from = str(body, 'effective_from', { required: true }) as string;
  const to = str(body, 'effective_to');
  if (!isIsoDate(from) || (to !== null && (!isIsoDate(to) || to < from))) throw badRequest('ช่วงวันที่มีผลไม่ถูกต้อง');
  const basis = str(body, 'legal_basis', { required: true, max: 500 }) as string;
  try {
    const row = await c.env.DB.prepare(
      'INSERT INTO holiday_pay_rules (company_id, employment_type, holiday_pay_entitled, work_multiplier, ot_multiplier, effective_from, effective_to, legal_basis, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
    )
      .bind(companyId, type, rule.entitled ? 1 : 0, rule.workMultiplier, rule.otMultiplier, from, to, basis, user.id, user.id)
      .first<{ id: number }>();
    await audit(c, 'holiday.pay_rule_created', 'holiday_pay_rules', row?.id ?? null, { company: companyId, employment_type: type, ...rule, from, to });
    return c.json(await ruleOr404(c, row?.id ?? 0, false), 201);
  } catch (e) {
    if (isUnique(e)) throw conflict('มีกฎของบริษัท/ประเภทการจ้างนี้ที่เริ่มวันเดียวกันอยู่แล้ว');
    throw e;
  }
});

holidayRoutes.post('/pay-rules/:id/approve', requirePerm(P.approve), async (c) => {
  const user = currentUser(c);
  const r = await ruleOr404(c, intParam(c.req.param('id')), true);
  if (r.status !== 'draft') throw conflict('อนุมัติได้เฉพาะกฎที่เป็นร่าง');
  if (r.created_by === user.id) throw forbidden('ผู้อนุมัติต้องไม่ใช่ผู้สร้างกฎ (Segregation of duties)');
  const overlap = await c.env.DB.prepare(
    "SELECT id FROM holiday_pay_rules WHERE status = 'approved' AND id <> ?1 AND IFNULL(company_id, 0) = IFNULL(?2, 0) AND employment_type = ?3 AND effective_from <= COALESCE(?5, '9999-12-31') AND COALESCE(effective_to, '9999-12-31') >= ?4 LIMIT 1",
  )
    .bind(r.id, r.company_id, r.employment_type, r.effective_from, r.effective_to)
    .first<{ id: number }>();
  if (overlap) throw conflict(`ช่วงวันที่มีผลซ้อนกับกฎที่อนุมัติแล้ว #${overlap.id} ต้องปิดใช้งานหรือกำหนดวันสิ้นสุดของกฎเดิมก่อน`);
  const res = await c.env.DB.prepare("UPDATE holiday_pay_rules SET status = 'approved', approved_by = ?, approved_at = datetime('now'), updated_at = datetime('now'), updated_by = ? WHERE id = ? AND status = 'draft'").bind(user.id, user.id, r.id).run();
  if (!res.meta.changes) throw conflict('กฎนี้ถูกอนุมัติหรือเปลี่ยนสถานะไปแล้ว');
  await audit(c, 'holiday.pay_rule_approved', 'holiday_pay_rules', r.id, { employment_type: r.employment_type, entitled: r.holiday_pay_entitled, work: r.work_multiplier, ot: r.ot_multiplier });
  return c.json(await ruleOr404(c, r.id, false));
});

holidayRoutes.post('/pay-rules/:id/deactivate', requirePerm(P.delete), async (c) => {
  const user = currentUser(c);
  const r = await ruleOr404(c, intParam(c.req.param('id')), true);
  const reason = reasonOf(await readJson(c));
  const res = await c.env.DB.prepare("UPDATE holiday_pay_rules SET status = 'inactive', updated_at = datetime('now'), updated_by = ? WHERE id = ? AND status <> 'inactive'").bind(user.id, r.id).run();
  if (!res.meta.changes) throw conflict('กฎนี้ปิดใช้งานแล้ว');
  await audit(c, 'holiday.pay_rule_deactivated', 'holiday_pay_rules', r.id, { reason, was: r.status });
  return c.json(await ruleOr404(c, r.id, false));
});

// ---- holiday work records ------------------------------------------------------------------------
const WORK_SELECT = `SELECT w.id, w.employee_id, e.emp_code, e.first_name || ' ' || e.last_name AS employee, e.company_id, e.employment_type, w.holiday_id, h.name AS holiday_name,
  h.holiday_type, w.work_date, w.normal_hours, w.ot_hours, w.evidence_source, w.attendance_record_id, w.attendance_import_row_id, w.evidence_ref, w.excluded_from_regular_ot,
  w.status, w.note, w.review_reason, (SELECT u.username FROM users u WHERE u.id = w.reviewed_by) AS reviewer, w.reviewed_at, w.payroll_period_id,
  (SELECT p.code FROM payroll_periods p WHERE p.id = w.payroll_period_id) AS payroll_period, w.created_by, w.updated_at
  FROM holiday_work_records w JOIN employees e ON e.id = w.employee_id JOIN holidays h ON h.id = w.holiday_id`;

/** Users without organisation-wide employee access only see their own records. */
function workScope(user: AuthUser): { sql: string; params: unknown[] } {
  return can(user, 'employees.all') ? { sql: '1', params: [] } : { sql: 'w.employee_id = ?', params: [user.employeeId ?? -1] };
}

async function workOr404(c: Context<AppEnv>, id: number): Promise<HolidayWorkRow & { updated_at: string }> {
  const user = currentUser(c);
  const s = workScope(user);
  const scope = await scopeOf(c);
  const w = await c.env.DB.prepare(`${WORK_SELECT} WHERE w.id = ? AND ${s.sql}`).bind(id, ...s.params).first<HolidayWorkRow & { updated_at: string }>();
  if (!w || (scope.scope !== 'all' && !scope.items.some((x) => x.id === w.company_id))) throw notFound('ไม่พบบันทึกการทำงานวันหยุด');
  return w;
}

/** A calculated / approved / published month-end already covers the date: the period must be reopened first. */
async function assertPeriodOpen(db: D1Database, companyId: number, date: string): Promise<void> {
  const p = await db
    .prepare("SELECT code, status FROM payroll_periods WHERE kind = 'monthly' AND deleted_at IS NULL AND status <> 'draft' AND start_date <= ?1 AND end_date >= ?1 AND (company_id IS NULL OR company_id = ?2) LIMIT 1")
    .bind(date, companyId)
    .first<{ code: string; status: string }>();
  if (p) throw conflict(`วันที่ ${date} อยู่ในงวดเงินเดือน ${p.code} ที่คำนวณแล้ว (${p.status}) ต้องเปิดแก้ไขงวดก่อน (ป้องกันการจ่ายไม่ตรงกับสลิป)`);
}

interface WorkInput {
  employeeId: number;
  holidayId: number;
  date: string;
  companyId: number;
  normal: number;
  ot: number;
  source: 'attendance' | 'feishu' | 'manual';
  attendanceRecordId: number | null;
  importRowId: number | null;
  evidenceRef: string | null;
  note: string | null;
}

/**
 * Validates a holiday-work entry against the holiday (approved, applies to the employee's company), the employee
 * (employed that day) and the evidence: an attendance record of that employee and day whose clock times cover the
 * hours, an active Feishu import row of that employee whose date range covers the day, or a written reference.
 */
async function validateWork(c: Context<AppEnv>, body: Record<string, unknown>, fixed?: { employeeId: number; holidayId: number }): Promise<WorkInput> {
  const db = c.env.DB;
  const scope = await scopeOf(c);
  const employeeId = fixed?.employeeId ?? intParam(String(body.employee_id ?? ''), 'employee_id');
  const holidayId = fixed?.holidayId ?? intParam(String(body.holiday_id ?? ''), 'holiday_id');
  const emp = await db.prepare('SELECT id, company_id, hire_date, termination_date FROM employees WHERE id = ?').bind(employeeId).first<{ id: number; company_id: number; hire_date: string; termination_date: string | null }>();
  if (!emp || (scope.scope !== 'all' && !scope.items.some((x) => x.id === emp.company_id))) throw notFound('ไม่พบพนักงาน');
  const user = currentUser(c);
  if (!can(user, 'employees.all') && emp.id !== user.employeeId) throw forbidden('บันทึกได้เฉพาะข้อมูลของตนเอง');
  const hol = await db
    .prepare('SELECT h.id, h.holiday_date, h.status, cal.company_id FROM holidays h JOIN holiday_calendars cal ON cal.id = h.calendar_id WHERE h.id = ?')
    .bind(holidayId)
    .first<{ id: number; holiday_date: string; status: string; company_id: number | null }>();
  if (!hol) throw notFound('ไม่พบวันหยุด');
  if (hol.status !== 'approved') throw conflict('วันหยุดนี้ยังไม่ได้รับอนุมัติ (หรือถูกปิดใช้งาน) จึงบันทึกการทำงานวันหยุดไม่ได้');
  if (hol.company_id !== null && hol.company_id !== emp.company_id) throw badRequest('วันหยุดนี้เป็นของปฏิทินบริษัทอื่น');
  const date = hol.holiday_date;
  if (emp.hire_date > date || (emp.termination_date !== null && emp.termination_date < date)) throw badRequest('พนักงานไม่ได้อยู่ในสถานะพนักงานในวันหยุดนี้');

  const cfg = payrollConfig(await loadSettings(db));
  const normal = hoursIn(body, 'normal_hours');
  const ot = hoursIn(body, 'ot_hours');
  if (normal + ot <= 0) throw badRequest('กรุณาระบุชั่วโมงทำงาน');
  if (normal + ot > 24) throw badRequest('ชั่วโมงรวมต้องไม่เกิน 24 ชั่วโมง');
  if (normal > cfg.hoursPerDay) throw badRequest(`ชั่วโมงในเวลาปกติต้องไม่เกิน ${cfg.hoursPerDay} ชั่วโมง (ค่าตั้ง payroll.hours_per_day) ส่วนที่เกินให้บันทึกเป็น OT วันหยุด`);
  if (ot > 0 && normal < cfg.hoursPerDay) throw badRequest(`OT ในวันหยุดนับได้เมื่อทำงานครบเวลาปกติ ${cfg.hoursPerDay} ชั่วโมงแล้วเท่านั้น`);

  const source = str(body, 'evidence_source', { required: true }) as WorkInput['source'];
  if (!['attendance', 'feishu', 'manual'].includes(source)) throw badRequest('แหล่งหลักฐานเวลาทำงานไม่ถูกต้อง');
  const evidenceRef = str(body, 'evidence_ref', { max: 500 });
  let attendanceRecordId: number | null = null;
  let importRowId: number | null = null;
  if (source === 'attendance') {
    attendanceRecordId = intParam(String(body.attendance_record_id ?? ''), 'attendance_record_id');
    const a = await db.prepare('SELECT employee_id, work_date, clock_in, clock_out FROM attendance_records WHERE id = ?').bind(attendanceRecordId).first<{ employee_id: number; work_date: string; clock_in: string | null; clock_out: string | null }>();
    if (!a || a.employee_id !== emp.id || a.work_date !== date) throw badRequest('บันทึกเวลาทำงานไม่ตรงกับพนักงานหรือวันหยุดนี้');
    const mins = (t: string | null) => (t && /^\d{2}:\d{2}/.test(t) ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null);
    const inM = mins(a.clock_in);
    const outM = mins(a.clock_out);
    if (inM === null || outM === null) throw badRequest('บันทึกเวลาทำงานต้องมีทั้งเวลาเข้าและเวลาออก');
    const worked = ((outM - inM + 1440) % 1440) / 60;
    if (normal + ot > worked + 1e-9) throw badRequest(`ชั่วโมงที่บันทึก (${normal + ot}) มากกว่าเวลาเข้า–ออกจริง (${Math.round(worked * 100) / 100} ชั่วโมง)`);
  } else if (source === 'feishu') {
    importRowId = intParam(String(body.attendance_import_row_id ?? ''), 'attendance_import_row_id');
    const r = await db
      .prepare('SELECT r.employee_id, i.status, i.company_id, i.source_start, i.source_end FROM attendance_import_rows r JOIN attendance_imports i ON i.id = r.import_id WHERE r.id = ?')
      .bind(importRowId)
      .first<{ employee_id: number | null; status: string; company_id: number; source_start: string | null; source_end: string | null }>();
    if (!r || r.employee_id !== emp.id || r.company_id !== emp.company_id) throw badRequest('แถวข้อมูล Feishu ไม่ตรงกับพนักงานนี้');
    if (r.status !== 'active') throw badRequest('ข้อมูล Feishu ชุดนี้ไม่ได้ใช้งานแล้ว (ถูกแทนที่หรือย้อนกลับ)');
    if (r.source_start && r.source_end && (date < r.source_start || date > r.source_end)) throw badRequest('ช่วงวันที่ของข้อมูล Feishu ไม่ครอบคลุมวันหยุดนี้');
    if (!evidenceRef) throw badRequest('กรุณาระบุรายละเอียดหลักฐานจาก Feishu (เช่น ชั่วโมงทำงานวันหยุดตามรายงานรายวัน)');
  } else if (!evidenceRef || evidenceRef.length < 5) throw badRequest('การบันทึกเอง (manual) ต้องระบุหลักฐานอ้างอิง เช่น เลขที่ใบอนุมัติทำงานวันหยุด');
  return { employeeId: emp.id, holidayId: hol.id, date, companyId: emp.company_id, normal, ot, source, attendanceRecordId, importRowId, evidenceRef, note: str(body, 'note', { max: 500 }) };
}

holidayRoutes.get('/work', async (c) => {
  const user = currentUser(c);
  const scope = await scopeOf(c);
  const s = workScope(user);
  const q = c.req.query();
  const where = ["(? = 'all' OR e.company_id IN (SELECT value FROM json_each(?)))", s.sql];
  const params: unknown[] = [scope.scope, JSON.stringify(scope.items.map((x) => x.id)), ...s.params];
  const add = (sql: string, v: unknown) => (where.push(sql), params.push(v));
  if (q.from && isIsoDate(q.from)) add('w.work_date >= ?', q.from);
  if (q.to && isIsoDate(q.to)) add('w.work_date <= ?', q.to);
  if (q.company) add('e.company_id = ?', intParam(q.company, 'company'));
  if (q.status && ['pending', 'approved', 'rejected', 'cancelled'].includes(q.status)) add('w.status = ?', q.status);
  const { results } = await c.env.DB.prepare(`${WORK_SELECT} WHERE ${where.join(' AND ')} ORDER BY w.work_date DESC, e.emp_code LIMIT 1000`).bind(...params).all<HolidayWorkRow>();
  return c.json(results);
});

holidayRoutes.post('/work', requirePerm(P.create), async (c) => {
  const user = currentUser(c);
  const body = await readJson(c);
  const w = await validateWork(c, body);
  await assertPeriodOpen(c.env.DB, w.companyId, w.date);
  try {
    const row = await c.env.DB.prepare(
      `INSERT INTO holiday_work_records (employee_id, holiday_id, work_date, normal_hours, ot_hours, evidence_source, attendance_record_id, attendance_import_row_id, evidence_ref, note, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
      .bind(w.employeeId, w.holidayId, w.date, w.normal, w.ot, w.source, w.attendanceRecordId, w.importRowId, w.evidenceRef, w.note, user.id, user.id)
      .first<{ id: number }>();
    await audit(c, 'holiday_work.created', 'holiday_work_records', row?.id ?? null, { employee: w.employeeId, holiday: w.holidayId, date: w.date, normal: w.normal, ot: w.ot, source: w.source });
    return c.json(await workOr404(c, row?.id ?? 0), 201);
  } catch (e) {
    if (isUnique(e)) throw conflict('พนักงานคนนี้มีบันทึกการทำงานวันหยุดของวันนี้อยู่แล้ว (ป้องกันการบันทึกซ้ำ)');
    throw e;
  }
});

holidayRoutes.put('/work/:id', requirePerm(P.update), async (c) => {
  const user = currentUser(c);
  const cur = await workOr404(c, intParam(c.req.param('id')));
  if (cur.status !== 'pending') throw conflict('แก้ไขได้เฉพาะรายการที่รออนุมัติ');
  const w = await validateWork(c, await readJson(c), { employeeId: cur.employee_id, holidayId: cur.holiday_id });
  await assertPeriodOpen(c.env.DB, w.companyId, w.date);
  const res = await c.env.DB.prepare(
    `UPDATE holiday_work_records SET normal_hours = ?, ot_hours = ?, evidence_source = ?, attendance_record_id = ?, attendance_import_row_id = ?, evidence_ref = ?, note = ?,
       updated_at = datetime('now'), updated_by = ? WHERE id = ? AND status = 'pending' AND updated_at = ?`,
  )
    .bind(w.normal, w.ot, w.source, w.attendanceRecordId, w.importRowId, w.evidenceRef, w.note, user.id, cur.id, cur.updated_at)
    .run();
  if (!res.meta.changes) throw conflict('รายการนี้ถูกแก้ไขหรือเปลี่ยนสถานะไปแล้ว กรุณาโหลดใหม่');
  await audit(c, 'holiday_work.updated', 'holiday_work_records', cur.id, { from: { normal: cur.normal_hours, ot: cur.ot_hours, source: cur.evidence_source }, to: { normal: w.normal, ot: w.ot, source: w.source } });
  return c.json(await workOr404(c, cur.id));
});

holidayRoutes.post('/work/:id/approve', requirePerm(P.approve), async (c) => {
  const user = currentUser(c);
  const db = c.env.DB;
  const w = await workOr404(c, intParam(c.req.param('id')));
  const body = await readJson(c);
  if (w.status !== 'pending') throw conflict('อนุมัติได้เฉพาะรายการที่รออนุมัติ');
  if (w.created_by === user.id) throw forbidden('ผู้อนุมัติต้องไม่ใช่ผู้บันทึก (Segregation of duties)');
  if (body.excluded_from_regular_ot !== true) throw badRequest('ต้องยืนยันว่าชั่วโมงนี้ไม่ได้รวมอยู่ใน OT ปกติที่ยืนยันแล้ว (excluded_from_regular_ot = true) เพื่อป้องกันการจ่ายซ้ำ');
  const ot = await db.prepare("SELECT id FROM overtime_requests WHERE employee_id = ? AND work_date = ? AND status = 'approved' LIMIT 1").bind(w.employee_id, w.work_date).first<{ id: number }>();
  if (ot) throw conflict(`มีคำขอ OT ที่อนุมัติแล้วของวันเดียวกัน (OT-${ot.id}) ต้องยกเลิกคำขอนั้นหรือปฏิเสธรายการนี้ (ป้องกันการจ่ายซ้ำ)`);
  await assertPeriodOpen(db, w.company_id, w.work_date);
  const res = await db
    .prepare(
      `UPDATE holiday_work_records SET status = 'approved', excluded_from_regular_ot = 1, reviewed_by = ?1, reviewed_at = datetime('now'), review_reason = ?2, updated_at = datetime('now'), updated_by = ?1
       WHERE id = ?3 AND status = 'pending' AND EXISTS (SELECT 1 FROM holidays h WHERE h.id = holiday_id AND h.status = 'approved')`,
    )
    .bind(user.id, str(body, 'reason', { max: 500 }), w.id)
    .run();
  if (!res.meta.changes) throw conflict('รายการนี้ถูกอนุมัติ/เปลี่ยนสถานะไปแล้ว หรือวันหยุดถูกปิดใช้งาน');
  await audit(c, 'holiday_work.approved', 'holiday_work_records', w.id, { employee: w.employee_id, date: w.work_date, normal: w.normal_hours, ot: w.ot_hours, source: w.evidence_source });
  return c.json(await workOr404(c, w.id));
});

holidayRoutes.post('/work/:id/reject', requirePerm(P.approve), async (c) => {
  const user = currentUser(c);
  const w = await workOr404(c, intParam(c.req.param('id')));
  const reason = reasonOf(await readJson(c));
  const res = await c.env.DB.prepare("UPDATE holiday_work_records SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now'), review_reason = ?, updated_at = datetime('now'), updated_by = ? WHERE id = ? AND status = 'pending'")
    .bind(user.id, reason, user.id, w.id)
    .run();
  if (!res.meta.changes) throw conflict('ปฏิเสธได้เฉพาะรายการที่รออนุมัติ');
  await audit(c, 'holiday_work.rejected', 'holiday_work_records', w.id, { reason });
  return c.json(await workOr404(c, w.id));
});

holidayRoutes.post('/work/:id/cancel', requirePerm(P.update), async (c) => {
  const user = currentUser(c);
  const w = await workOr404(c, intParam(c.req.param('id')));
  const reason = reasonOf(await readJson(c));
  if (w.payroll_period_id !== null) throw conflict(`รายการนี้ถูกใช้คำนวณในงวด ${w.payroll_period} แล้ว ต้องเปิดแก้ไขงวดก่อน`);
  if (w.status === 'approved') await assertPeriodOpen(c.env.DB, w.company_id, w.work_date);
  const res = await c.env.DB.prepare(
    "UPDATE holiday_work_records SET status = 'cancelled', review_reason = ?, updated_at = datetime('now'), updated_by = ? WHERE id = ? AND status IN ('pending', 'approved') AND payroll_period_id IS NULL",
  )
    .bind(reason, user.id, w.id)
    .run();
  if (!res.meta.changes) throw conflict('ยกเลิกไม่ได้: รายการถูกเปลี่ยนสถานะหรือถูกใช้คำนวณเงินเดือนแล้ว');
  await audit(c, 'holiday_work.cancelled', 'holiday_work_records', w.id, { reason, was: w.status });
  return c.json(await workOr404(c, w.id));
});

// ---- import --------------------------------------------------------------------------------------
async function importInput(c: Context<AppEnv>): Promise<{ cal: HolidayCalendarRow; grid: Cell[][]; body: Record<string, unknown> }> {
  const body = await readJson(c);
  const cal = await calendarOr404(c, intParam(String(body.calendar_id ?? ''), 'calendar_id'), true);
  if (!Array.isArray(body.grid) || body.grid.length > 1001 || !body.grid.every((r) => Array.isArray(r) && r.length <= 50 && r.every((x) => x === null || ['string', 'number', 'boolean'].includes(typeof x)))) {
    throw badRequest('ข้อมูลไฟล์ไม่ถูกต้อง (ไม่เกิน 1,000 แถว)');
  }
  return { cal, grid: body.grid as Cell[][], body };
}

async function analyzeImport(db: D1Database, cal: HolidayCalendarRow, grid: Cell[][]) {
  const { results } = await db.prepare("SELECT holiday_date FROM holidays WHERE calendar_id = ? AND status <> 'inactive'").bind(cal.id).all<{ holiday_date: string }>();
  const v = validateImport(grid, { window: openWindow(), existingDates: new Set(results.map((r) => r.holiday_date)) });
  for (const r of v.rows) if (r.type === 'company' && cal.company_id === null) r.issues.push({ level: 'error', message: 'วันหยุดตามประกาศบริษัทต้องนำเข้าในปฏิทินของบริษัท' });
  const errors = v.rows.filter((r) => r.issues.some((i) => i.level === 'error')).length;
  return { ...v, errors, importable: v.rows.length - errors };
}

holidayRoutes.post('/import/preview', requirePerm(P.import), async (c) => {
  const { cal, grid } = await importInput(c);
  return c.json({ calendar: cal, ...(await analyzeImport(c.env.DB, cal, grid)) });
});

holidayRoutes.post('/import', requirePerm(P.import), async (c) => {
  const user = currentUser(c);
  const { cal, grid, body } = await importInput(c);
  const a = await analyzeImport(c.env.DB, cal, grid);
  if (a.missingColumns.length) throw badRequest(`ไม่พบคอลัมน์ที่จำเป็น: ${a.missingColumns.join(', ')}`);
  if (a.errors && body.skip_invalid !== true) throw conflict(`มี ${a.errors} แถวที่ไม่ถูกต้อง แก้ไขไฟล์หรือเลือกนำเข้าเฉพาะแถวที่ถูกต้อง`);
  const ok = a.rows.filter((r) => !r.issues.some((i) => i.level === 'error'));
  if (!ok.length) throw badRequest('ไม่มีแถวที่นำเข้าได้');
  const batch = crypto.randomUUID();
  const db = c.env.DB;
  try {
    await db.batch(ok.map((r) =>
      db.prepare(
        `INSERT INTO holidays (calendar_id, holiday_date, year, name, name_en, holiday_type, origin, source_reference, source_url, region, note, import_batch, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, 'import', ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(cal.id, r.date, Number((r.date as string).slice(0, 4)), r.name, r.name_en, r.type, r.source_reference, r.source_url, r.region, r.note, batch, user.id, user.id)));
  } catch (e) {
    if (isUnique(e)) throw conflict('มีวันหยุดบางวันถูกเพิ่มในปฏิทินระหว่างนำเข้า กรุณาตรวจสอบใหม่');
    throw e;
  }
  await audit(c, 'holiday.imported', 'holiday_calendars', cal.id, { batch, file: str(body, 'file_name', { max: 200 }), imported: ok.length, skipped: a.errors, status: 'draft' });
  return c.json({ batch, imported: ok.length, skipped: a.errors }, 201);
});

// ---- holidays ------------------------------------------------------------------------------------
holidayRoutes.post('/', requirePerm(P.create), async (c) => {
  const user = currentUser(c);
  const body = await readJson(c);
  const cal = await calendarOr404(c, intParam(String(body.calendar_id ?? ''), 'calendar_id'), true);
  if (!cal.active) throw conflict('ปฏิทินนี้ปิดใช้งานอยู่');
  const date = dateIn(body, 'holiday_date');
  const type = typeIn(body);
  if (type === 'substitute') throw badRequest('วันหยุดชดเชยต้องสร้างจากวันหยุดต้นทาง (ปุ่ม "กำหนดวันหยุดชดเชย")');
  if (type === 'company' && cal.company_id === null) throw badRequest('วันหยุดตามประกาศบริษัทต้องอยู่ในปฏิทินของบริษัท');
  const name = str(body, 'name', { required: true, max: 200 }) as string;
  try {
    const row = await c.env.DB.prepare(
      `INSERT INTO holidays (calendar_id, holiday_date, year, name, name_en, holiday_type, source_reference, source_url, region, note, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
      .bind(cal.id, date, Number(date.slice(0, 4)), name, str(body, 'name_en', { max: 200 }), type, str(body, 'source_reference', { max: 500 }), httpsUrl(body), str(body, 'region', { max: 200 }), str(body, 'note', { max: 500 }), user.id, user.id)
      .first<{ id: number }>();
    await audit(c, 'holiday.created', 'holidays', row?.id ?? null, { calendar: cal.code, date, type, name });
    return c.json(await holidayOr404(c, row?.id ?? 0, false), 201);
  } catch (e) {
    if (isUnique(e)) throw conflict(`มีวันหยุดวันที่ ${date} ในปฏิทินนี้อยู่แล้ว`);
    throw e;
  }
});

holidayRoutes.get('/:id', async (c) => {
  const h = await holidayOr404(c, intParam(c.req.param('id')), false);
  const { results: substitutes } = await c.env.DB.prepare(
    'SELECT x.id, x.holiday_date, x.name, x.status, s.reason FROM holiday_substitutions s JOIN holidays x ON x.id = s.substitute_holiday_id WHERE s.original_holiday_id = ? ORDER BY x.holiday_date',
  )
    .bind(h.id)
    .all();
  const rest = parseWeeklyRest(h.cal.weekly_rest_days) ?? [];
  return c.json({ ...h, weekday: weekday(h.holiday_date), on_weekly_rest: rest.includes(weekday(h.holiday_date)), substitutes });
});

/** Fields that decide what payroll pays: frozen once a calculation used the holiday. */
const PAYROLL_FIELDS = ['holiday_date', 'holiday_type'] as const;
const SOURCE_FIELDS = ['source_reference', 'source_url'] as const;

holidayRoutes.put('/:id', requirePerm(P.update), async (c) => {
  const user = currentUser(c);
  const h = await holidayOr404(c, intParam(c.req.param('id')), true);
  if (h.status === 'inactive') throw conflict('วันหยุดนี้ปิดใช้งานแล้ว');
  const body = await readJson(c);
  const next: Record<string, string | number | null> = {};
  if ('holiday_date' in body) {
    const d = dateIn(body, 'holiday_date');
    if (d !== h.holiday_date) {
      next.holiday_date = d;
      next.year = Number(d.slice(0, 4));
    }
  }
  if ('holiday_type' in body) {
    const t = typeIn(body);
    if (t !== h.holiday_type) {
      if (t === 'substitute' || h.holiday_type === 'substitute') throw badRequest('เปลี่ยนประเภทจาก/เป็นวันหยุดชดเชยไม่ได้');
      if (t === 'company' && h.cal.company_id === null) throw badRequest('วันหยุดตามประกาศบริษัทต้องอยู่ในปฏิทินของบริษัท');
      next.holiday_type = t;
    }
  }
  if ('name' in body) next.name = str(body, 'name', { required: true, max: 200 });
  for (const k of ['name_en', 'region', 'note'] as const) if (k in body) next[k] = str(body, k, { max: k === 'note' ? 500 : 200 });
  if ('source_reference' in body) next.source_reference = str(body, 'source_reference', { max: 500 });
  if ('source_url' in body) next.source_url = httpsUrl(body);
  for (const k of Object.keys(next)) if (next[k] === (h as unknown as Record<string, unknown>)[k]) delete next[k];
  if (!Object.keys(next).length) throw badRequest('ไม่มีข้อมูลที่เปลี่ยนแปลง');

  const touchesPayroll = PAYROLL_FIELDS.some((k) => k in next);
  const touchesSource = SOURCE_FIELDS.some((k) => k in next);
  if (h.payroll_locked > 0 && (touchesPayroll || touchesSource)) {
    throw conflict('วันหยุดนี้ถูกใช้คำนวณเงินเดือนแล้ว แก้ได้เฉพาะชื่อ ชื่อภาษาอังกฤษ พื้นที่ และหมายเหตุ (สลิปที่ออกไปแล้วไม่เปลี่ยน)');
  }
  if ((touchesPayroll || touchesSource) && h.work_records > 0) throw conflict('มีบันทึกการทำงานวันหยุดอ้างอิงวันหยุดนี้ ต้องยกเลิกบันทึกเหล่านั้นก่อนเปลี่ยนวันที่ ประเภท หรือแหล่งที่มา');
  // a changed date, type or source must be verified and approved again
  if ((touchesPayroll || touchesSource) && h.status !== 'draft') Object.assign(next, { status: 'draft', verification: 'unverified', approved_by: null, approved_at: null, verified_by: null, verified_at: null });
  else if (touchesSource && h.verification === 'verified') Object.assign(next, { verification: 'unverified', verified_by: null, verified_at: null });

  const keys = Object.keys(next);
  try {
    const res = await c.env.DB.prepare(
      `UPDATE holidays SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now'), updated_by = ?
       WHERE id = ? AND updated_at = ? AND (? = 0 OR NOT EXISTS (SELECT 1 FROM holiday_work_records w WHERE w.holiday_id = holidays.id))`,
    )
      .bind(...keys.map((k) => next[k]), user.id, h.id, h.updated_at, touchesPayroll || touchesSource ? 1 : 0)
      .run();
    if (!res.meta.changes) throw conflict('วันหยุดนี้ถูกแก้ไขหรือถูกอ้างอิงไปแล้ว กรุณาโหลดใหม่');
  } catch (e) {
    if (isUnique(e)) throw conflict(`มีวันหยุดวันที่ ${String(next.holiday_date)} ในปฏิทินนี้อยู่แล้ว`);
    throw e;
  }
  await audit(c, 'holiday.updated', 'holidays', h.id, { changes: Object.fromEntries(keys.map((k) => [k, { from: (h as unknown as Record<string, unknown>)[k] ?? null, to: next[k] }])) });
  return c.json(await holidayOr404(c, h.id, false));
});

holidayRoutes.post('/:id/verify', requirePerm(P.approve), async (c) => {
  const user = currentUser(c);
  const h = await holidayOr404(c, intParam(c.req.param('id')), true);
  const body = await readJson(c);
  if (h.status !== 'draft') throw conflict('ตรวจสอบแหล่งที่มาได้เฉพาะวันหยุดที่เป็นร่าง');
  const ref = str(body, 'source_reference', { max: 500 }) ?? h.source_reference;
  if (!ref || ref.length < 3) throw badRequest('ต้องระบุแหล่งที่มา / เลขที่ประกาศอย่างเป็นทางการก่อนยืนยันการตรวจสอบ');
  const url = 'source_url' in body ? httpsUrl(body) : h.source_url;
  const res = await c.env.DB.prepare(
    "UPDATE holidays SET verification = 'verified', source_reference = ?, source_url = ?, verified_by = ?, verified_at = datetime('now'), updated_at = datetime('now'), updated_by = ? WHERE id = ? AND status = 'draft' AND updated_at = ?",
  )
    .bind(ref, url, user.id, user.id, h.id, h.updated_at)
    .run();
  if (!res.meta.changes) throw conflict('วันหยุดนี้ถูกแก้ไขไปแล้ว กรุณาโหลดใหม่');
  await audit(c, 'holiday.verified', 'holidays', h.id, { source_reference: ref, source_url: url, origin: h.origin });
  return c.json(await holidayOr404(c, h.id, false));
});

holidayRoutes.post('/:id/approve', requirePerm(P.approve), async (c) => {
  const user = currentUser(c);
  const h = await holidayOr404(c, intParam(c.req.param('id')), true);
  if (h.status !== 'draft') throw conflict('อนุมัติได้เฉพาะวันหยุดที่เป็นร่าง');
  if (h.verification !== 'verified') throw conflict('ต้องตรวจสอบแหล่งที่มา (ประกาศอย่างเป็นทางการ) ก่อนอนุมัติ');
  if (h.created_by === user.id) throw forbidden('ผู้อนุมัติต้องไม่ใช่ผู้สร้าง / ผู้นำเข้าวันหยุด (Segregation of duties)');
  const res = await c.env.DB.prepare("UPDATE holidays SET status = 'approved', approved_by = ?, approved_at = datetime('now'), updated_at = datetime('now'), updated_by = ? WHERE id = ? AND status = 'draft' AND verification = 'verified' AND updated_at = ?")
    .bind(user.id, user.id, h.id, h.updated_at)
    .run();
  if (!res.meta.changes) throw conflict('วันหยุดนี้ถูกแก้ไขหรือเปลี่ยนสถานะไปแล้ว กรุณาโหลดใหม่');
  await audit(c, 'holiday.approved', 'holidays', h.id, { date: h.holiday_date, type: h.holiday_type, calendar: h.calendar_code, source_reference: h.source_reference });
  return c.json(await holidayOr404(c, h.id, false));
});

holidayRoutes.post('/:id/deactivate', requirePerm(P.delete), async (c) => {
  const user = currentUser(c);
  const h = await holidayOr404(c, intParam(c.req.param('id')), true);
  const reason = reasonOf(await readJson(c));
  if (h.status === 'inactive') throw conflict('วันหยุดนี้ปิดใช้งานแล้ว');
  if (h.payroll_locked > 0) throw conflict('วันหยุดนี้ถูกใช้คำนวณเงินเดือนแล้ว จึงปิดใช้งานไม่ได้ (เก็บไว้เป็นหลักฐานการจ่าย)');
  const res = await c.env.DB.prepare(
    `UPDATE holidays SET status = 'inactive', deactivated_by = ?, deactivated_at = datetime('now'), deactivate_reason = ?, updated_at = datetime('now'), updated_by = ?
     WHERE id = ? AND status <> 'inactive' AND NOT EXISTS (SELECT 1 FROM holiday_work_records w WHERE w.holiday_id = holidays.id AND w.status IN ('pending', 'approved'))`,
  )
    .bind(user.id, reason, user.id, h.id)
    .run();
  if (!res.meta.changes) throw conflict('มีบันทึกการทำงานวันหยุดที่รออนุมัติหรืออนุมัติแล้วอ้างอิงวันหยุดนี้ ต้องยกเลิกก่อนปิดใช้งาน');
  await audit(c, 'holiday.deactivated', 'holidays', h.id, { reason, date: h.holiday_date, was: h.status });
  return c.json(await holidayOr404(c, h.id, false));
});

/** Hard delete: only an unreferenced draft (a mistaken entry). Anything else is deactivated, never deleted. */
holidayRoutes.delete('/:id', requirePerm(P.delete), async (c) => {
  const h = await holidayOr404(c, intParam(c.req.param('id')), true);
  if (h.status !== 'draft' || h.work_records > 0 || h.substituted > 0) throw conflict('ลบได้เฉพาะวันหยุดร่างที่ไม่มีการอ้างอิง ใช้ "ปิดใช้งาน" แทน (ประวัติไม่ถูกลบ)');
  const db = c.env.DB;
  const res = await db.batch([
    db.prepare("DELETE FROM holiday_substitutions WHERE substitute_holiday_id = ?1 AND EXISTS (SELECT 1 FROM holidays WHERE id = ?1 AND status = 'draft')").bind(h.id),
    db.prepare("DELETE FROM holidays WHERE id = ? AND status = 'draft' AND NOT EXISTS (SELECT 1 FROM holiday_work_records w WHERE w.holiday_id = holidays.id)").bind(h.id),
  ]);
  if (!res[1]?.meta.changes) throw conflict('วันหยุดนี้ถูกเปลี่ยนสถานะหรือถูกอ้างอิงไปแล้ว');
  await audit(c, 'holiday.deleted', 'holidays', h.id, { date: h.holiday_date, name: h.name, calendar: h.calendar_code });
  return c.json({ ok: true, id: h.id });
});

holidayRoutes.post('/:id/substitute', requirePerm(P.create), async (c) => {
  const user = currentUser(c);
  const h = await holidayOr404(c, intParam(c.req.param('id')), true);
  if (h.status !== 'approved') throw conflict('กำหนดวันหยุดชดเชยได้เฉพาะวันหยุดที่อนุมัติแล้ว');
  if (h.holiday_type === 'substitute') throw badRequest('วันหยุดชดเชยไม่มีวันหยุดชดเชยซ้อนอีก');
  if (h.substituted > 0) throw conflict('วันหยุดนี้มีวันหยุดชดเชยอยู่แล้ว');
  const body = await readJson(c);
  const date = dateIn(body, 'holiday_date');
  if (date <= h.holiday_date) throw badRequest('วันหยุดชดเชยต้องอยู่หลังวันหยุดต้นทาง');
  const rest = parseWeeklyRest(h.cal.weekly_rest_days) ?? [];
  if (rest.includes(weekday(date))) throw badRequest('วันหยุดชดเชยต้องเป็นวันทำงาน (ไม่ใช่วันหยุดประจำสัปดาห์)');
  const name = str(body, 'name', { max: 200 }) ?? `ชดเชย${h.name}`;
  const ref = str(body, 'source_reference', { max: 500 }) ?? h.source_reference;
  const db = c.env.DB;
  try {
    // one transaction: the substitute day never exists without its link to the original holiday
    const res = await db.batch([
      db.prepare(
        `INSERT INTO holidays (calendar_id, holiday_date, year, name, holiday_type, source_reference, source_url, note, created_by, updated_by)
         VALUES (?, ?, ?, ?, 'substitute', ?, ?, ?, ?, ?)`,
      ).bind(h.calendar_id, date, Number(date.slice(0, 4)), name, ref, httpsUrl(body), str(body, 'note', { max: 500 }), user.id, user.id),
      db.prepare("INSERT INTO holiday_substitutions (original_holiday_id, substitute_holiday_id, reason, created_by) SELECT ?, id, ?, ? FROM holidays WHERE calendar_id = ? AND holiday_date = ? AND status <> 'inactive' RETURNING substitute_holiday_id")
        .bind(h.id, str(body, 'reason', { max: 500 }), user.id, h.calendar_id, date),
    ]);
    const id = (res[1]?.results?.[0] as { substitute_holiday_id: number } | undefined)?.substitute_holiday_id ?? 0;
    await audit(c, 'holiday.substitute_created', 'holidays', id, { original: h.id, originalDate: h.holiday_date, date });
    return c.json(await holidayOr404(c, id, false), 201);
  } catch (e) {
    if (isUnique(e)) throw conflict(`มีวันหยุดวันที่ ${date} ในปฏิทินนี้อยู่แล้ว`);
    throw e;
  }
});
