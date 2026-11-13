-- Rollback of migrations/0020_attendance_daily_source.sql. Run only after a backup (docs/BACKUP-RECOVERY.md) and
-- after the Worker has been rolled back to a version without P2 (that Worker writes attendance without change_op and
-- would otherwise be refused by the revision trigger).
-- Lost with the rollback (export first if they must be kept):
--   SELECT * FROM attendance_record_revisions;            -- correction history (original / corrected values)
--   SELECT * FROM payroll_attendance_snapshots; SELECT * FROM payroll_attendance_snapshot_rows;
--   SELECT * FROM payroll_attendance_holds WHERE kind IN ('invalid_record', 'pending_review');  -- and their events
-- attendance_records keeps every current value; only the four change_* columns are dropped. No payslip, period or
-- money row was changed by 0020.
--   npx wrangler d1 execute hr-system-db --remote --file scripts/rollback/0020_attendance_daily_source.down.sql
PRAGMA defer_foreign_keys = on;

-- attendance revisions
DROP TRIGGER IF EXISTS trg_attendance_records_revision_update;
DROP TRIGGER IF EXISTS trg_attendance_records_revision_insert;
DROP TRIGGER IF EXISTS trg_attendance_records_change_op;
DROP TRIGGER IF EXISTS trg_attendance_records_nodelete;
DROP TRIGGER IF EXISTS trg_attendance_records_lock_insert;
DROP TRIGGER IF EXISTS trg_attendance_records_lock_update;
DROP TRIGGER IF EXISTS trg_attendance_revisions_readonly;
DROP TRIGGER IF EXISTS trg_attendance_revisions_nodelete;
DROP TABLE IF EXISTS attendance_record_revisions;
ALTER TABLE attendance_records DROP COLUMN change_op;
ALTER TABLE attendance_records DROP COLUMN change_channel;
ALTER TABLE attendance_records DROP COLUMN change_reason;
ALTER TABLE attendance_records DROP COLUMN change_reference;

-- snapshots
DROP TRIGGER IF EXISTS trg_payroll_attendance_snapshot_rows_readonly;
DROP TRIGGER IF EXISTS trg_payroll_attendance_snapshot_rows_nodelete;
DROP TRIGGER IF EXISTS trg_payroll_attendance_snapshots_readonly;
DROP TRIGGER IF EXISTS trg_payroll_attendance_snapshots_nodelete;
DROP TABLE IF EXISTS payroll_attendance_snapshot_rows;
DROP TABLE IF EXISTS payroll_attendance_snapshots;

-- holds back to the 0019 kinds (rows of the two P2 kinds and their events are left out)
CREATE TABLE payroll_attendance_holds_v1 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id INTEGER NOT NULL REFERENCES payroll_periods(id),
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  kind TEXT NOT NULL CHECK (kind IN ('absent', 'pending_leave', 'missing_attendance')),
  work_date TEXT CHECK (work_date IS NULL OR (length(work_date) = 10 AND date(work_date) = work_date)),
  source_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'cleared', 'resolved')),
  first_detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  decision_by INTEGER REFERENCES users(id),
  decision_at TEXT,
  decision_reason TEXT,
  op_token TEXT,
  last_action TEXT CHECK (last_action IS NULL OR last_action IN ('opened', 'cleared', 'resolved', 'reopened')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((kind = 'missing_attendance') = (work_date IS NULL))
);
INSERT INTO payroll_attendance_holds_v1 (id, period_id, employee_id, company_id, kind, work_date, source_json, status, first_detected_at, last_detected_at, resolved_at,
  decision_by, decision_at, decision_reason, op_token, last_action, created_at, updated_at)
SELECT id, period_id, employee_id, company_id, kind, work_date, source_json, status, first_detected_at, last_detected_at, resolved_at,
  decision_by, decision_at, decision_reason, op_token, last_action, created_at, updated_at
FROM payroll_attendance_holds WHERE kind IN ('absent', 'pending_leave', 'missing_attendance');

CREATE TABLE payroll_attendance_hold_events_v1 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hold_id INTEGER NOT NULL REFERENCES payroll_attendance_holds_v1(id),
  period_id INTEGER NOT NULL REFERENCES payroll_periods(id),
  action TEXT NOT NULL CHECK (action IN ('opened', 'cleared', 'resolved', 'reopened')),
  actor_id INTEGER REFERENCES users(id),
  reason TEXT,
  source_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO payroll_attendance_hold_events_v1 (id, hold_id, period_id, action, actor_id, reason, source_json, created_at)
SELECT e.id, e.hold_id, e.period_id, e.action, e.actor_id, e.reason, e.source_json, e.created_at
FROM payroll_attendance_hold_events e WHERE e.hold_id IN (SELECT id FROM payroll_attendance_holds_v1);

DROP TABLE payroll_attendance_hold_events;
DROP TABLE payroll_attendance_holds;
ALTER TABLE payroll_attendance_holds_v1 RENAME TO payroll_attendance_holds;
ALTER TABLE payroll_attendance_hold_events_v1 RENAME TO payroll_attendance_hold_events;

CREATE UNIQUE INDEX ux_payroll_attendance_hold ON payroll_attendance_holds(period_id, employee_id, kind, IFNULL(work_date, ''));
CREATE INDEX idx_payroll_attendance_holds_period ON payroll_attendance_holds(period_id, status, company_id);
CREATE INDEX idx_payroll_attendance_holds_op ON payroll_attendance_holds(op_token);
CREATE TRIGGER trg_payroll_attendance_holds_nodelete BEFORE DELETE ON payroll_attendance_holds
BEGIN
  SELECT RAISE(ABORT, 'payroll_attendance_holds rows are cleared or resolved, never deleted');
END;
CREATE INDEX idx_payroll_attendance_hold_events_hold ON payroll_attendance_hold_events(hold_id, id);
CREATE INDEX idx_payroll_attendance_hold_events_period ON payroll_attendance_hold_events(period_id, id);
CREATE TRIGGER trg_payroll_attendance_hold_events_readonly BEFORE UPDATE ON payroll_attendance_hold_events
BEGIN
  SELECT RAISE(ABORT, 'payroll_attendance_hold_events is append-only');
END;
CREATE TRIGGER trg_payroll_attendance_hold_events_nodelete BEFORE DELETE ON payroll_attendance_hold_events
BEGIN
  SELECT RAISE(ABORT, 'payroll_attendance_hold_events is append-only');
END;

DELETE FROM role_permissions WHERE permission = 'attendance.correct';
DELETE FROM d1_migrations WHERE name = '0020_attendance_daily_source.sql';
