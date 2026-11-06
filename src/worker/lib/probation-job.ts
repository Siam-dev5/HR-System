// Daily probation job (Worker scheduled handler, or a manual run by a Super Admin):
//   day 90        → notify HR to review the probation result (once)
//   days 91–119   → follow-up reminder every N days while the status is still "probation" (once per reminder day)
//   day 120       → status probation → active (only that column; employment_type, salary, the hire date and the
//                   recorded probation end are never touched, and the probation end never postpones the change)
// Day numbers are counted against the Asia/Bangkok date of the run, never against a browser or a page view.
// Every action is keyed (employee, kind, due date) in probation_events and written in one D1 batch (a transaction)
// together with its gated effects, so a retry, a second cron trigger or a concurrent run never repeats an action.
import { SUPER_ADMIN_ROLE } from '../../shared/modules';
import { hasPermission } from '../../shared/permissions';
import { formatTenure, probationActions, probationTimeline, tenure, thaiDate, type ProbationAction } from '../../shared/probation';
import { loadSettings, settingBool, settingNumber } from './settings';

export const PROBATION_JOB = 'probation';
/** audit_logs.username of changes made by the job (user_id stays NULL: no person made them) */
export const SYSTEM_ACTOR = 'system:probation-job';

export interface ProbationJobOptions {
  /** Asia/Bangkok date (YYYY-MM-DD) the run evaluates */
  today: string;
  trigger: 'scheduled' | 'manual';
  requestedBy?: { id: number; username: string } | null;
  /** list what would happen without writing anything */
  dryRun?: boolean;
}

export interface ProbationJobItem {
  employeeId: number;
  empCode: string;
  kind: ProbationAction['kind'];
  due: string;
  /** done: written by this run · skipped: already recorded earlier (or the employee changed meanwhile) · would_do: dry run */
  result: 'done' | 'skipped' | 'suppressed' | 'would_do' | 'failed';
  /** users notified (or, in a dry run, who would be) */
  notified?: number;
  /** D1 attempts of the step when more than one was needed */
  attempts?: number;
  error?: string;
}

export interface ProbationJobResult {
  runId: number | null;
  today: string;
  status: 'ok' | 'partial' | 'error';
  settings: { notifications: boolean; reminderIntervalDays: number; autoActivate: boolean };
  summary: Record<string, number>;
  items: ProbationJobItem[];
}

interface Candidate {
  id: number;
  emp_code: string;
  first_name: string;
  last_name: string;
  company: string | null;
  hire_date: string;
  termination_date: string | null;
  employment_type: string;
  status: string;
}

/**
 * Recipients of probation notices: active, approved users who hold the Super Admin role, or whose roles together let
 * them maintain every employee record (employees.update + employees.all: HR Admin and HR Staff as seeded). Each user
 * appears once, however many of those roles they hold.
 */
export async function probationRecipients(db: D1Database): Promise<number[]> {
  const { results } = await db
    .prepare(
      `SELECT ur.user_id, r.code, rp.permission FROM user_roles ur JOIN users u ON u.id = ur.user_id JOIN roles r ON r.id = ur.role_id
       LEFT JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE u.active = 1 AND u.approval_status = 'approved'`,
    )
    .all<{ user_id: number; code: string; permission: string | null }>();
  const perms = new Map<number, string[]>();
  const out = new Set<number>();
  for (const r of results) {
    if (r.code === SUPER_ADMIN_ROLE) out.add(r.user_id);
    if (r.permission) perms.set(r.user_id, [...(perms.get(r.user_id) ?? []), r.permission]);
  }
  for (const [id, p] of perms) if (hasPermission(p, 'employees.update') && hasPermission(p, 'employees.all')) out.add(id);
  return [...out].sort((a, b) => a - b);
}

function message(e: Candidate, a: ProbationAction, today: string): { title: string; body: string } {
  const t = probationTimeline(e.hire_date, today);
  const who = `${e.emp_code} ${e.first_name} ${e.last_name}`;
  const facts = `บริษัท ${e.company ?? '-'} · เริ่มงาน ${thaiDate(e.hire_date)} · ครบทดลองงาน 90 วัน ${thaiDate(t.day90)}`;
  switch (a.kind) {
    case 'day90_notice':
      return { title: `ครบทดลองงาน 90 วัน: ${who}`, body: `${facts} · โปรดประเมินผลทดลองงาน (สถานะจะเปลี่ยนเป็น "ปฏิบัติงาน" เมื่อครบ 120 วัน ${thaiDate(t.day120)})` };
    case 'reminder':
      return { title: `ติดตามผลทดลองงาน: ${who}`, body: `${facts} · วันนี้เป็นวันทำงานที่ ${t.day} ยังอยู่ในสถานะทดลองงาน · ครบ 120 วัน ${thaiDate(t.day120)}` };
    case 'activate':
      return { title: `เปลี่ยนสถานะเป็นปฏิบัติงานแล้ว: ${who}`, body: `${facts} · ครบ 120 วัน ${thaiDate(t.day120)} ระบบเปลี่ยนสถานะ ทดลองงาน → ปฏิบัติงาน (ประเภทการจ้างคงเดิม)` };
    case 'activate_due':
      return { title: `ครบ 120 วัน รอเปลี่ยนสถานะ: ${who}`, body: `${facts} · ครบ 120 วัน ${thaiDate(t.day120)} การเปลี่ยนสถานะอัตโนมัติปิดอยู่ โปรดเปลี่ยนสถานะในข้อมูลพนักงาน` };
  }
}

/** Timeline and payroll-cycle note kept with each event, so the switch from two pay rounds to one can be traced. */
function details(e: Candidate, today: string): string {
  const t = probationTimeline(e.hire_date, today);
  return JSON.stringify({
    day: t.day,
    day90: t.day90,
    day91: t.day91,
    day120: t.day120,
    tenure: formatTenure(tenure(e.hire_date, today)),
    employmentType: e.employment_type,
    payrollCycle: { twoRoundsThrough: t.day90, rule: 'mid-month rounds that start after day 90 no longer include the employee; the month already started keeps both rounds' },
  });
}

/** Runs `fn` up to `attempts` times; `onAttempt` sees each attempt number (the retry details of the run log). */
async function withRetry<T>(fn: () => Promise<T>, onAttempt: (n: number) => void, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    onAttempt(i);
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 200 * i));
    }
  }
}

/** The probation.* System Settings, with the defaults of migration 0010. */
export async function probationSettings(db: D1Database): Promise<ProbationJobResult['settings']> {
  const s = await loadSettings(db);
  return {
    notifications: settingBool(s, 'probation.notifications_enabled', true),
    reminderIntervalDays: Math.max(0, Math.floor(settingNumber(s, 'probation.reminder_interval_days', 7))),
    autoActivate: settingBool(s, 'probation.auto_activate', true),
  };
}

export async function runProbationJob(db: D1Database, opts: ProbationJobOptions): Promise<ProbationJobResult> {
  const settings = await probationSettings(db);
  const run = opts.dryRun
    ? null
    : await db
        .prepare("INSERT INTO job_runs (job, run_date, trigger, status, requested_by) VALUES (?, ?, ?, 'running', ?) RETURNING id")
        .bind(PROBATION_JOB, opts.today, opts.trigger, opts.requestedBy?.id ?? null)
        .first<{ id: number }>();
  const runId = run?.id ?? null;
  const items: ProbationJobItem[] = [];
  try {
    const { results: employees } = await db
      .prepare(
        `SELECT e.id, e.emp_code, e.first_name, e.last_name, c.name AS company, e.hire_date, e.termination_date, e.employment_type, e.status
         FROM employees e LEFT JOIN companies c ON c.id = e.company_id WHERE e.status = 'probation' ORDER BY e.id`,
      )
      .all<Candidate>();
    const recipients = settings.notifications ? await probationRecipients(db) : [];
    const { results: existing } = await db
      .prepare("SELECT p.employee_id, p.kind, p.due_date FROM probation_events p JOIN employees e ON e.id = p.employee_id WHERE e.status = 'probation'")
      .all<{ employee_id: number; kind: string; due_date: string }>();
    const recorded = new Set(existing.map((x) => `${x.employee_id}|${x.kind}|${x.due_date}`));

    for (const e of employees) {
      let noticeNow = false;
      for (const planned of probationActions(e, opts.today, settings.reminderIntervalDays)) {
        // with the automatic change switched off, day 120 becomes a notice asking HR to change the status
        const a: ProbationAction = planned.kind === 'activate' && !settings.autoActivate ? { kind: 'activate_due', due: planned.due } : planned;
        const item: ProbationJobItem = { employeeId: e.id, empCode: e.emp_code, kind: a.kind, due: a.due, result: 'skipped' };
        items.push(item);
        if (recorded.has(`${e.id}|${a.kind}|${a.due}`)) continue;
        const isNotice = a.kind !== 'activate';
        if (isNotice && !settings.notifications) {
          item.result = 'skipped';
          continue;
        }
        // a first run after day 90 (catch-up) sends the day-90 notice only, not a reminder on the same day
        const suppressed = a.kind === 'reminder' && noticeNow;
        const notify = suppressed ? [] : recipients;
        if (opts.dryRun) {
          item.result = suppressed ? 'suppressed' : 'would_do';
          item.notified = notify.length;
          if (a.kind === 'day90_notice') noticeNow = true;
          continue;
        }
        const { title, body } = message(e, a, opts.today);
        const mine = 'SELECT 1 FROM probation_events WHERE employee_id = ?1 AND kind = ?2 AND due_date = ?3 AND run_id = ?4';
        const stmts: D1PreparedStatement[] = [
          // the key: inserted only while the employee is still on probation with the same hire date
          db.prepare(
            `INSERT OR IGNORE INTO probation_events (employee_id, kind, due_date, hire_date, run_id, notified, details)
             SELECT id, ?2, ?3, hire_date, ?4, ?5, ?6 FROM employees WHERE id = ?1 AND status = 'probation' AND hire_date = ?7`,
          ).bind(e.id, a.kind, a.due, runId, notify.length, details(e, opts.today), e.hire_date),
        ];
        if (a.kind === 'activate') {
          stmts.push(
            db.prepare(`UPDATE employees SET status = 'active', updated_at = datetime('now'), updated_by = NULL WHERE id = ?1 AND status = 'probation' AND EXISTS (${mine})`)
              .bind(e.id, a.kind, a.due, runId),
            db.prepare(`INSERT INTO audit_logs (user_id, username, action, entity, entity_id, details, ip) SELECT NULL, ?5, 'employee.status_auto_changed', 'employees', ?6, ?7, NULL WHERE EXISTS (${mine})`)
              .bind(e.id, a.kind, a.due, runId, SYSTEM_ACTOR, String(e.id), JSON.stringify({
                employeeId: e.id,
                previousStatus: 'probation',
                newStatus: 'active',
                effectiveDate: a.due,
                trigger: opts.trigger,
                actor: SYSTEM_ACTOR,
                ...(opts.requestedBy ? { requestedBy: opts.requestedBy.username } : {}),
                runId,
                employmentType: e.employment_type,
              })),
          );
        }
        if (notify.length) {
          stmts.push(
            db.prepare(`INSERT INTO notifications (user_id, title, body, link) SELECT value, ?5, ?6, ?7 FROM json_each(?8) WHERE EXISTS (${mine})`)
              .bind(e.id, a.kind, a.due, runId, title, body, `/employees?open=${e.id}`, JSON.stringify(notify)),
          );
        }
        try {
          const res = await withRetry(() => db.batch(stmts), (n) => {
            if (n > 1) item.attempts = n;
          });
          item.result = (res[0]?.meta.changes ?? 0) > 0 ? (suppressed ? 'suppressed' : 'done') : 'skipped';
          if (item.result === 'done') item.notified = notify.length;
          if (a.kind === 'day90_notice' && item.result === 'done') noticeNow = true;
        } catch (err) {
          item.result = 'failed';
          item.error = err instanceof Error ? err.message.slice(0, 200) : 'error';
          console.error('probation job: employee step failed', { runId, employeeId: e.id, kind: a.kind, attempts: item.attempts, error: item.error });
        }
      }
    }
    // counts only, no names: processed = employees on probation evaluated · notifications = notices delivered (one per
    // recipient) · activated = status changes · retries = extra D1 attempts · failed = steps that failed every attempt
    const summary: Record<string, number> = { processed: employees.length, recipients: recipients.length, notifications: 0, activated: 0, retries: 0, failed: 0 };
    for (const i of items) {
      summary.retries! += Math.max(0, (i.attempts ?? 1) - 1);
      if (i.result === 'failed') summary.failed! += 1;
      else if (i.result === 'done' || i.result === 'would_do') {
        summary[i.kind] = (summary[i.kind] ?? 0) + 1;
        summary.notifications! += i.notified ?? 0;
        if (i.kind === 'activate') summary.activated! += 1;
      }
    }
    const status = summary.failed ? 'partial' : 'ok';
    // a partial run keeps its failed steps (employee id, action, attempts, message) for the run log
    const failures = items.filter((i) => i.result === 'failed').map((i) => ({ employeeId: i.employeeId, kind: i.kind, attempts: i.attempts ?? 1, error: i.error }));
    if (runId !== null) {
      await db.prepare("UPDATE job_runs SET status = ?, finished_at = datetime('now'), summary = ?, error = ? WHERE id = ?")
        .bind(status, JSON.stringify(summary), failures.length ? JSON.stringify(failures) : null, runId).run();
    }
    return { runId, today: opts.today, status, settings, summary, items };
  } catch (err) {
    const msg = err instanceof Error ? err.message.slice(0, 500) : 'error';
    console.error('probation job failed', { runId, today: opts.today, error: msg });
    if (runId !== null) {
      await db.prepare("UPDATE job_runs SET status = 'error', finished_at = datetime('now'), error = ? WHERE id = ?").bind(msg, runId).run().catch(() => undefined);
    }
    throw err;
  }
}
