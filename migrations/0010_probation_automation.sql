-- Probation automation: day-90 notice to HR, follow-up reminders on days 91–119, status probation → active on day 120,
-- run by the Worker's scheduled handler (cron). Additive only: two new tables and three settings, no existing column,
-- row or type changes. Rollback: scripts/rollback/0010_probation_automation.down.sql.

-- one row per execution of a scheduled job (also a manual run by a Super Admin); the run log asked for by operations
CREATE TABLE job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  -- Asia/Bangkok date the run evaluated (day numbers are counted against this date)
  run_date TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'partial', 'error')),
  requested_by INTEGER REFERENCES users(id),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  -- counts only (no names): {"processed":3,"notifications":4,"activated":1,"retries":0,"failed":0,...}
  summary TEXT,
  -- a failed run's message, or JSON of the failed steps of a partial run (employee id, action, attempts, message)
  error TEXT
);
CREATE INDEX idx_job_runs_job ON job_runs(job, id);

-- what the probation job did, once per (employee, kind, due date): the idempotency key that prevents a second notice,
-- reminder or status change for the same event, whatever the number of runs, retries or overlapping cron triggers
CREATE TABLE probation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  kind TEXT NOT NULL CHECK (kind IN ('day90_notice', 'reminder', 'activate', 'activate_due')),
  -- day the event belongs to (day 90, the reminder day or day 120, all counted from the hire date)
  due_date TEXT NOT NULL,
  -- hire date the event was computed from (a corrected hire date produces new due dates)
  hire_date TEXT NOT NULL,
  run_id INTEGER REFERENCES job_runs(id),
  -- number of HR users notified (0 = recorded without a notification, e.g. a reminder covered by the day-90 notice)
  notified INTEGER NOT NULL DEFAULT 0,
  -- JSON: timeline and payroll-cycle note (why / when the employee leaves the mid-month round)
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (employee_id, kind, due_date)
);
CREATE INDEX idx_probation_events_employee ON probation_events(employee_id);

INSERT INTO settings (key, value, type, description) VALUES
  ('probation.notifications_enabled', 'true', 'bool', 'แจ้งเตือน HR เมื่อพนักงานครบทดลองงาน 90 วัน และแจ้งเตือนติดตามจนถึงวันที่ 120'),
  ('probation.reminder_interval_days', '7', 'number', 'แจ้งเตือนติดตามผลทดลองงานทุกกี่วันหลังวันที่ 90 (0 = ไม่แจ้งเตือนซ้ำ)'),
  ('probation.auto_activate', 'true', 'bool', 'เปลี่ยนสถานะ ทดลองงาน → ปฏิบัติงาน อัตโนมัติเมื่อครบ 120 วันนับจากวันเริ่มงาน (ปิด: แจ้ง HR ให้เปลี่ยนเอง)');
