// Employee selection of payroll periods (P4): list / search, select / deselect (single or bulk, per-employee results),
// validate eligibility, summary, HR confirmation of review cases, history. Selection is never approval of payment:
// eligibility (shared/payroll-eligibility.ts) decides who may be paid, and a calculation refuses while a selected
// employee is not payable. Every request checks permission and company scope (another company's employee or period
// answers like a missing one); every change is versioned, recorded as an append-only event and audited.
import { Hono, type Context } from 'hono';
import type { AppEnv, AuthUser } from '../env';
import { currentUser, requireAuth, requirePerm } from '../auth';
import { audit } from '../lib/audit';
import { companyScope } from '../lib/companies';
import { badRequest, conflict, HttpError, intParam, notFound, readJson } from '../lib/http';
import { effectiveSelection, evaluateEmployees, selectionVersion, type EffectiveSelection, type EvaluatedEmployee, type SelPeriod } from '../lib/payroll-selection';
import { ELIGIBILITY_NOTE_LABEL, ELIGIBILITY_REASON_LABEL, OUTSIDE_LABEL, outsideReason, reviewBasis } from '../../shared/payroll-eligibility';

export const payrollSelectionRoutes = new Hono<AppEnv>();
payrollSelectionRoutes.use('*', requireAuth);

const MAX_BULK = 200;

interface Scope {
  all: boolean;
  ids: number[];
}
async function scopeOf(db: D1Database, user: AuthUser): Promise<Scope> {
  const s = await companyScope(db, user);
  return { all: s.scope === 'all', ids: s.items.map((x) => x.id) };
}
const inScope = (s: Scope, companyId: number) => s.all || s.ids.includes(companyId);

/** A period the user may see: an all-company period needs the all-company scope (404 otherwise). */
async function scopedPeriod(c: Context<AppEnv>): Promise<{ p: SelPeriod & { code: string }; s: Scope }> {
  const db = c.env.DB;
  const s = await scopeOf(db, currentUser(c));
  const p = await db
    .prepare('SELECT id, code, kind, start_date, end_date, company_id, status, calc_version FROM payroll_periods WHERE id = ? AND deleted_at IS NULL')
    .bind(intParam(c.req.param('id')))
    .first<SelPeriod & { code: string }>();
  if (!p || (p.company_id === null ? !s.all : !inScope(s, p.company_id))) throw notFound('ไม่พบงวดเงินเดือน');
  return { p, s };
}

function assertOpen(p: SelPeriod): void {
  if (p.status !== 'draft' && p.status !== 'calculated') throw new HttpError(409, 'period_locked', 'เปลี่ยนรายชื่อพนักงานได้เฉพาะงวดที่ยังไม่อนุมัติ');
}

function readIds(body: Record<string, unknown>): number[] {
  const raw = Array.isArray(body.employee_ids) ? body.employee_ids : body.employee_id !== undefined ? [body.employee_id] : [];
  const ids = [...new Set(raw.map(Number))];
  if (!ids.length) throw badRequest('ต้องระบุพนักงานอย่างน้อย 1 คน (employee_ids)');
  if (ids.length > MAX_BULK) throw badRequest(`เลือกได้ครั้งละไม่เกิน ${MAX_BULK} คน`);
  if (ids.some((x) => !Number.isInteger(x) || x <= 0)) throw badRequest('รหัสพนักงานไม่ถูกต้อง');
  return ids;
}
function readReason(body: Record<string, unknown>, required: boolean): string | null {
  const r = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (required && (r.length < 5 || r.length > 500)) throw new HttpError(400, 'reason_required', 'ต้องระบุเหตุผล (5–500 ตัวอักษร)');
  if (r.length > 500) throw badRequest('เหตุผลยาวเกิน 500 ตัวอักษร');
  return r || null;
}

const view = (x: EvaluatedEmployee, names: Map<number, string>, sel: EffectiveSelection) => {
  const row = sel.rows.get(x.employee_id);
  return {
    employee_id: x.employee_id,
    emp_code: x.emp_code,
    name: names.get(x.employee_id) ?? null,
    company_id: x.company_id,
    origin: x.origin,
    eligibility: x.eligibility.status,
    decision: x.eligibility.decision,
    reasons: x.eligibility.reasons,
    labels: x.eligibility.reasons.map((r) => ELIGIBILITY_REASON_LABEL[r]),
    notes: x.eligibility.notes,
    note_labels: x.eligibility.notes.map((n) => ELIGIBILITY_NOTE_LABEL[n]),
    paid_from: x.eligibility.from,
    paid_to: x.eligibility.to,
    confirmed: x.confirmed,
    payable: x.payable,
    selection_reason: row?.reason ?? null,
    review_reason: row?.review_confirmed ? row.review_reason : null,
  };
};

async function names(db: D1Database, ids: readonly number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const { results } = await db.prepare("SELECT id, first_name || ' ' || last_name AS name FROM employees WHERE id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(ids)).all<{ id: number; name: string }>();
  return new Map(results.map((r) => [r.id, r.name]));
}

function summarize(list: readonly EvaluatedEmployee[], deselected: number) {
  const n = (f: (x: EvaluatedEmployee) => boolean) => list.filter(f).length;
  return {
    selected: list.length,
    added: n((x) => x.origin === 'added'),
    deselected,
    eligible: n((x) => x.eligibility.status === 'eligible'),
    eligible_prorated: n((x) => x.eligibility.status === 'eligible_prorated'),
    review_required: n((x) => x.eligibility.decision === 'review' && !x.confirmed),
    review_confirmed: n((x) => x.confirmed),
    blocked: n((x) => x.eligibility.decision === 'block'),
    payable: n((x) => x.payable),
  };
}

/** The period's selection as the user may see it (employees of companies outside the scope are left out). */
async function selectionView(db: D1Database, p: SelPeriod, s: Scope) {
  const sel = await effectiveSelection(db, p);
  const deselectedIds = [...sel.rows.values()].filter((r) => r.status === 'deselected' && !sel.origin.has(r.employee_id)).map((r) => r.employee_id);
  const all = await evaluateEmployees(db, p, [...sel.ids, ...deselectedIds], sel);
  const visible = all.filter((x) => inScope(s, x.company_id));
  const selected = visible.filter((x) => x.origin === 'standard' || x.origin === 'added');
  const out = visible.filter((x) => x.origin === 'deselected');
  const nm = await names(db, visible.map((x) => x.employee_id));
  return { sel, selected, deselected: out, nm, summary: summarize(selected, out.length) };
}

payrollSelectionRoutes.get('/periods/:id', requirePerm('payroll_selection.view'), async (c) => {
  const db = c.env.DB;
  const { p, s } = await scopedPeriod(c);
  const v = await selectionView(db, p, s);
  const q = (c.req.query('q') ?? '').trim().toUpperCase();
  const match = (x: EvaluatedEmployee) => !q || x.emp_code.toUpperCase().includes(q) || (v.nm.get(x.employee_id) ?? '').toUpperCase().includes(q);
  return c.json({
    period: { id: p.id, code: p.code, status: p.status, company_id: p.company_id, start_date: p.start_date, end_date: p.end_date },
    version: await selectionVersion(db, p.id),
    summary: v.summary,
    selected: v.selected.filter(match).map((x) => view(x, v.nm, v.sel)),
    deselected: v.deselected.filter(match).map((x) => view(x, v.nm, v.sel)),
  });
});

payrollSelectionRoutes.get('/periods/:id/summary', requirePerm('payroll_selection.view'), async (c) => {
  const { p, s } = await scopedPeriod(c);
  return c.json({ period_id: p.id, summary: (await selectionView(c.env.DB, p, s)).summary, version: await selectionVersion(c.env.DB, p.id) });
});

/** Validate eligibility of the selection now (read-only; audited so a review of the list is on record). */
payrollSelectionRoutes.post('/periods/:id/validate', requirePerm('payroll_selection.view'), async (c) => {
  const db = c.env.DB;
  const { p, s } = await scopedPeriod(c);
  const v = await selectionView(db, p, s);
  const notReady = v.selected.filter((x) => !x.payable);
  await audit(c, 'payroll_selection.validated', 'payroll_periods', p.id, { summary: v.summary });
  return c.json({ period_id: p.id, ready: notReady.length === 0, summary: v.summary, not_ready: notReady.map((x) => view(x, v.nm, v.sel)) });
});

/**
 * Employees not on the period's list who may be selected: of the period's company (or the companies of the scope for an
 * all-company period), plus employees who belonged to it during the period; with why they are outside and what
 * eligibility would say. Searching never shows another company.
 */
payrollSelectionRoutes.get('/periods/:id/available', requirePerm('payroll_selection.view'), async (c) => {
  const db = c.env.DB;
  const { p, s } = await scopedPeriod(c);
  const sel = await effectiveSelection(db, p);
  const q = `%${(c.req.query('q') ?? '').trim().toUpperCase()}%`;
  const { results } = await db
    .prepare(
      `SELECT e.id, e.emp_code, e.first_name || ' ' || e.last_name AS name, e.company_id, e.status, e.hire_date, e.termination_date, e.base_salary FROM employees e
       WHERE (upper(e.emp_code) LIKE ?1 OR upper(e.first_name || ' ' || e.last_name) LIKE ?1)
         AND (?2 = 1 OR e.company_id IN (SELECT value FROM json_each(?3)))
         AND (?4 IS NULL OR e.company_id = ?4 OR EXISTS (SELECT 1 FROM employee_company_assignments a WHERE a.employee_id = e.id AND a.company_id = ?4 AND a.status <> 'cancelled'
              AND a.effective_from <= ?5 AND (a.effective_to IS NULL OR a.effective_to >= ?6)))
         AND e.id NOT IN (SELECT value FROM json_each(?7))
       ORDER BY e.emp_code LIMIT 200`,
    )
    .bind(q, s.all ? 1 : 0, JSON.stringify(s.ids), p.company_id, p.end_date, p.start_date, JSON.stringify(sel.ids))
    .all<{ id: number; emp_code: string; name: string; company_id: number; status: string; hire_date: string | null; termination_date: string | null; base_salary: number | null }>();
  const evaluated = new Map((await evaluateEmployees(db, p, results.map((r) => r.id), sel)).map((x) => [x.employee_id, x]));
  return c.json({
    period_id: p.id,
    employees: results.map((e) => {
      const x = evaluated.get(e.id)!;
      const outside = sel.rows.get(e.id)?.status === 'deselected' ? 'deselected' : outsideReason(p, e);
      return { employee_id: e.id, emp_code: e.emp_code, name: e.name, company_id: e.company_id, outside, outside_label: OUTSIDE_LABEL[outside], eligibility: x.eligibility.status, decision: x.eligibility.decision, reasons: x.eligibility.reasons, labels: x.eligibility.reasons.map((r) => ELIGIBILITY_REASON_LABEL[r]) };
    }),
  });
});

type ResultCode = 'selected' | 'deselected' | 'unchanged' | 'not_found' | 'cross_company';

/** Employees of the request the user may act on, and whether they belong to the period's company in the period. */
async function candidates(db: D1Database, p: SelPeriod, s: Scope, ids: readonly number[]) {
  const { results } = await db
    .prepare(
      `SELECT e.id, e.company_id, (?2 IS NULL OR e.company_id = ?2 OR EXISTS (SELECT 1 FROM employee_company_assignments a WHERE a.employee_id = e.id AND a.company_id = ?2 AND a.status <> 'cancelled'
         AND a.effective_from <= ?3 AND (a.effective_to IS NULL OR a.effective_to >= ?4))) AS belongs
       FROM employees e WHERE e.id IN (SELECT value FROM json_each(?1))`,
    )
    .bind(JSON.stringify(ids), p.company_id, p.end_date, p.start_date)
    .all<{ id: number; company_id: number; belongs: number }>();
  return new Map(results.filter((e) => inScope(s, e.company_id)).map((e) => [e.id, e]));
}

async function change(c: Context<AppEnv>, target: 'selected' | 'deselected') {
  const user = currentUser(c);
  const db = c.env.DB;
  const { p, s } = await scopedPeriod(c);
  assertOpen(p);
  const body = await readJson(c);
  const ids = readIds(body);
  const reason = readReason(body, target === 'deselected');
  const sel = await effectiveSelection(db, p);
  const emps = await candidates(db, p, s, ids);
  const results: Array<{ employee_id: number; result: ResultCode; previous: string | null }> = [];
  const writes: Array<{ id: number; company: number; previous: string }> = [];
  for (const id of ids) {
    const e = emps.get(id);
    // an employee outside the scope answers like a missing one (nothing about another company is revealed)
    if (!e) {
      results.push({ employee_id: id, result: 'not_found', previous: null });
      continue;
    }
    const isSelected = sel.origin.has(id);
    const previous = isSelected ? 'selected' : sel.rows.get(id)?.status === 'deselected' ? 'deselected' : 'not_selected';
    if (target === 'selected' && !e.belongs) {
      results.push({ employee_id: id, result: 'cross_company', previous });
      continue;
    }
    if ((target === 'selected') === isSelected) {
      results.push({ employee_id: id, result: 'unchanged', previous });
      continue;
    }
    writes.push({ id, company: e.company_id, previous });
  }
  const op = crypto.randomUUID();
  if (writes.length) {
    const stmts: D1PreparedStatement[] = [
      db.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM payroll_periods WHERE id = ?1 AND status IN ('draft', 'calculated') AND deleted_at IS NULL) THEN 1 ELSE json('period locked') END AS ok`).bind(p.id),
    ];
    for (const w of writes) {
      // only a row not already in the target state changes (a concurrent request that got there first wins; no double event)
      stmts.push(
        db.prepare(
          `INSERT INTO payroll_period_selections (period_id, employee_id, company_id, status, reason, op_token, created_by, updated_by)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
           ON CONFLICT (period_id, employee_id) DO UPDATE SET status = excluded.status, reason = excluded.reason, company_id = excluded.company_id, op_token = excluded.op_token,
             review_confirmed = 0, review_basis = NULL, review_reason = NULL, review_confirmed_by = NULL, review_confirmed_at = NULL, updated_at = datetime('now'), updated_by = excluded.updated_by
           WHERE payroll_period_selections.status <> excluded.status`,
        ).bind(p.id, w.id, w.company, target, reason, op, user.id),
        db.prepare(
          `INSERT INTO payroll_period_selection_events (selection_id, period_id, employee_id, company_id, action, previous_status, new_status, reason, actor_id, op_token)
           SELECT id, period_id, employee_id, company_id, ?1, ?2, ?1, ?3, ?4, ?5 FROM payroll_period_selections WHERE period_id = ?6 AND employee_id = ?7 AND op_token = ?5`,
        ).bind(target, w.previous, reason, user.id, op, p.id, w.id),
      );
    }
    stmts.push(
      db.prepare(
        `INSERT INTO payroll_period_selection_versions (period_id, version) SELECT ?1, 1 WHERE EXISTS (SELECT 1 FROM payroll_period_selections WHERE period_id = ?1 AND op_token = ?2)
         ON CONFLICT (period_id) DO UPDATE SET version = version + 1, updated_at = datetime('now')`,
      ).bind(p.id, op),
    );
    try {
      await db.batch(stmts);
    } catch (e) {
      if (/malformed JSON/i.test(`${(e as Error).message} ${String((e as { cause?: unknown }).cause ?? '')}`)) throw new HttpError(409, 'period_locked', 'งวดนี้ถูกอนุมัติหรือเปลี่ยนสถานะระหว่างดำเนินการ');
      throw e;
    }
    const { results: done } = await db.prepare('SELECT employee_id FROM payroll_period_selections WHERE period_id = ? AND op_token = ?').bind(p.id, op).all<{ employee_id: number }>();
    const changed = new Set(done.map((d) => d.employee_id));
    for (const w of writes) results.push({ employee_id: w.id, result: changed.has(w.id) ? target : 'unchanged', previous: w.previous });
  }
  const ordered = ids.map((id) => results.find((r) => r.employee_id === id)!);
  const counts: Partial<Record<ResultCode, number>> = {};
  for (const r of ordered) counts[r.result] = (counts[r.result] ?? 0) + 1;
  await audit(c, target === 'selected' ? 'payroll_selection.selected' : 'payroll_selection.deselected', 'payroll_periods', p.id, {
    company_id: p.company_id, reason, op, counts,
    employees: ordered.filter((r) => r.result === target).map((r) => ({ employee_id: r.employee_id, previous: r.previous, new: target })),
  });
  // eligibility of the employees just selected (selection is not approval of payment)
  const after = await effectiveSelection(db, p);
  const ev = new Map((await evaluateEmployees(db, p, ordered.filter((r) => r.result !== 'not_found' && r.result !== 'cross_company').map((r) => r.employee_id), after)).map((x) => [x.employee_id, x]));
  return c.json({
    period_id: p.id,
    counts,
    results: ordered.map((r) => {
      const x = ev.get(r.employee_id);
      return { ...r, ...(x ? { eligibility: x.eligibility.status, decision: x.eligibility.decision, reasons: x.eligibility.reasons, payable: x.payable } : {}) };
    }),
  });
}

payrollSelectionRoutes.post('/periods/:id/select', requirePerm('payroll_selection.manage'), (c) => change(c, 'selected'));
payrollSelectionRoutes.post('/periods/:id/deselect', requirePerm('payroll_selection.manage'), (c) => change(c, 'deselected'));

/**
 * HR confirms a review case (e.g. a suspended employee to be paid this period). Never for a blocked case (missing
 * salary, company unresolved / conflict, not employed). The confirmation keeps the reasons it covers and lapses
 * when they change.
 */
payrollSelectionRoutes.post('/periods/:id/employees/:employeeId/confirm', requirePerm('payroll_selection.override'), async (c) => {
  const user = currentUser(c);
  const db = c.env.DB;
  const { p, s } = await scopedPeriod(c);
  assertOpen(p);
  const employeeId = intParam(c.req.param('employeeId'), 'employeeId');
  const reason = readReason(await readJson(c), true) as string;
  const sel = await effectiveSelection(db, p);
  const emp = (await candidates(db, p, s, [employeeId])).get(employeeId);
  if (!emp || !sel.origin.has(employeeId)) throw notFound('ไม่พบพนักงานนี้ในรายชื่อของงวด');
  const [x] = await evaluateEmployees(db, p, [employeeId], sel);
  if (!x || x.eligibility.decision === 'block') {
    throw new HttpError(409, 'not_reviewable', `ยืนยันจ่ายไม่ได้: ${x ? x.eligibility.reasons.map((r) => ELIGIBILITY_REASON_LABEL[r]).join(' · ') : 'ไม่พบข้อมูล'} (กรณีที่ถูกระงับต้องแก้ข้อมูลต้นทางหรือนำออกจากงวด)`);
  }
  if (x.eligibility.decision === 'pay') throw conflict('พนักงานนี้มีสิทธิ์ได้รับเงินอยู่แล้ว ไม่ต้องยืนยัน');
  if (x.confirmed) throw conflict('ยืนยันกรณีนี้แล้ว');
  const basis = reviewBasis(x.eligibility.reasons);
  const op = crypto.randomUUID();
  await db.batch([
    db.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM payroll_periods WHERE id = ?1 AND status IN ('draft', 'calculated') AND deleted_at IS NULL) THEN 1 ELSE json('period locked') END AS ok`).bind(p.id),
    db.prepare(
      `INSERT INTO payroll_period_selections (period_id, employee_id, company_id, status, review_confirmed, review_basis, review_reason, review_confirmed_by, review_confirmed_at, op_token, created_by, updated_by)
       VALUES (?1, ?2, ?3, 'selected', 1, ?4, ?5, ?6, datetime('now'), ?7, ?6, ?6)
       ON CONFLICT (period_id, employee_id) DO UPDATE SET review_confirmed = 1, review_basis = excluded.review_basis, review_reason = excluded.review_reason,
         review_confirmed_by = excluded.review_confirmed_by, review_confirmed_at = excluded.review_confirmed_at, op_token = excluded.op_token, updated_at = datetime('now'), updated_by = excluded.updated_by
       WHERE payroll_period_selections.status = 'selected' AND (payroll_period_selections.review_confirmed = 0 OR payroll_period_selections.review_basis IS NOT excluded.review_basis)`,
    ).bind(p.id, employeeId, emp.company_id, basis, reason, user.id, op),
    db.prepare(
      `INSERT INTO payroll_period_selection_events (selection_id, period_id, employee_id, company_id, action, previous_status, new_status, reason, detail_json, actor_id, op_token)
       SELECT id, period_id, employee_id, company_id, 'review_confirmed', 'selected', 'selected', ?1, ?2, ?3, ?4 FROM payroll_period_selections WHERE period_id = ?5 AND employee_id = ?6 AND op_token = ?4`,
    ).bind(reason, JSON.stringify({ eligibility: x.eligibility.status, reasons: x.eligibility.reasons }), user.id, op, p.id, employeeId),
    db.prepare(
      `INSERT INTO payroll_period_selection_versions (period_id, version) SELECT ?1, 1 WHERE EXISTS (SELECT 1 FROM payroll_period_selections WHERE period_id = ?1 AND op_token = ?2)
       ON CONFLICT (period_id) DO UPDATE SET version = version + 1, updated_at = datetime('now')`,
    ).bind(p.id, op),
  ]).catch((e: unknown) => {
    if (/malformed JSON/i.test(`${(e as Error).message} ${String((e as { cause?: unknown }).cause ?? '')}`)) throw new HttpError(409, 'period_locked', 'งวดนี้ถูกอนุมัติหรือเปลี่ยนสถานะระหว่างดำเนินการ');
    throw e;
  });
  const done = await db.prepare('SELECT 1 FROM payroll_period_selections WHERE period_id = ? AND employee_id = ? AND op_token = ?').bind(p.id, employeeId, op).first();
  if (!done) throw conflict('รายการนี้ถูกยืนยันหรือเปลี่ยนระหว่างดำเนินการ กรุณาโหลดใหม่');
  await audit(c, 'payroll_selection.review_confirmed', 'payroll_periods', p.id, { company_id: emp.company_id, employee_id: employeeId, eligibility: x.eligibility.status, reasons: x.eligibility.reasons, reason, op });
  return c.json({ ok: true, employee_id: employeeId, eligibility: x.eligibility.status, reasons: x.eligibility.reasons, confirmed: true });
});

/** History of the period's selection (append-only events), limited to the companies of the scope. */
payrollSelectionRoutes.get('/periods/:id/events', requirePerm('payroll_selection.view'), async (c) => {
  const db = c.env.DB;
  const { p, s } = await scopedPeriod(c);
  const { results } = await db
    .prepare(
      `SELECT ev.id, ev.employee_id, e.emp_code, ev.company_id, ev.action, ev.previous_status, ev.new_status, ev.reason, ev.created_at, u.username AS actor
       FROM payroll_period_selection_events ev JOIN employees e ON e.id = ev.employee_id LEFT JOIN users u ON u.id = ev.actor_id
       WHERE ev.period_id = ?1 AND (?2 = 1 OR ev.company_id IN (SELECT value FROM json_each(?3))) ORDER BY ev.id`,
    )
    .bind(p.id, s.all ? 1 : 0, JSON.stringify(s.ids))
    .all();
  return c.json({ period_id: p.id, events: results });
});
