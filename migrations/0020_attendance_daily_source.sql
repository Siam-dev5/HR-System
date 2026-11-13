-- Daily attendance as the validated, versioned source of payroll attendance (P2). Nothing here changes money: the
-- payroll engine keeps its inputs (salary, OT requests / confirmed Feishu OT, unpaid leave); P2 validates the daily
-- records, aggregates them per Calculation Version and refuses approval / sign-off / publish when they changed.
--
--  1. attendance_records: never deleted; every change carries an operation token and appends an immutable revision
--     (original and corrected values, who, when, why, reference) — written by triggers, so no path can skip it.
--  2. payroll_attendance_snapshots (+ rows): the exact aggregation and attendance version used by each calc_version,
--     append-only (a recalculation adds a new snapshot, never rewrites an old one).
--  3. payroll_attendance_holds gains two kinds for the validation engine: invalid_record (must be corrected) and
--     pending_review (HR confirms). SQLite cannot alter a CHECK, so the holds table and its events table are rebuilt
--     with every row, id and sequence kept (both tables only exist since 0019; production is at 0017).
--  4. Permission attendance.correct for roles that already edit attendance.
-- Rollback: scripts/rollback/0020_attendance_daily_source.down.sql
PRAGMA defer_foreign_keys = on;

-- ===== 1. Attendance revisions =================================================================================
-- the change being written: set by every writer together with the tracked columns (see the triggers below)
ALTER TABLE attendance_records ADD COLUMN change_op TEXT;
ALTER TABLE attendance_records ADD COLUMN change_channel TEXT;
ALTER TABLE attendance_records ADD COLUMN change_reason TEXT;
ALTER TABLE attendance_records ADD COLUMN change_reference TEXT;

CREATE TABLE attendance_record_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id INTEGER NOT NULL REFERENCES attendance_records(id),
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  work_date TEXT NOT NULL,
  -- the day before the change when it moved the record to another date
  prev_work_date TEXT,
  action TEXT NOT NULL CHECK (action IN ('created', 'corrected')),
  -- import / web / crud / correction / time_correction / manual …
  channel TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT NOT NULL,
  reason TEXT,
  reference TEXT,
  -- 1 = written without a reason (legacy CRUD outside the attendance review dates); kept visible, never hidden
  reason_missing INTEGER NOT NULL DEFAULT 0 CHECK (reason_missing IN (0, 1)),
  actor_id INTEGER REFERENCES users(id),
  op_token TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_attendance_revisions_record ON attendance_record_revisions(record_id, id);
CREATE INDEX idx_attendance_revisions_date ON attendance_record_revisions(work_date, id);
CREATE INDEX idx_attendance_revisions_prev_date ON attendance_record_revisions(prev_work_date, id) WHERE prev_work_date IS NOT NULL;
CREATE INDEX idx_attendance_revisions_op ON attendance_record_revisions(op_token);
CREATE TRIGGER trg_attendance_revisions_readonly BEFORE UPDATE ON attendance_record_revisions
BEGIN
  SELECT RAISE(ABORT, 'attendance_record_revisions is append-only');
END;
CREATE TRIGGER trg_attendance_revisions_nodelete BEFORE DELETE ON attendance_record_revisions
BEGIN
  SELECT RAISE(ABORT, 'attendance_record_revisions is append-only');
END;

-- attendance history is corrected, never deleted
CREATE TRIGGER trg_attendance_records_nodelete BEFORE DELETE ON attendance_records
BEGIN
  SELECT RAISE(ABORT, 'attendance_records are corrected, never deleted');
END;

-- a change of what the record says must come with a new operation token (= one revision); a writer that forgets the
-- token fails instead of changing attendance without history
CREATE TRIGGER trg_attendance_records_change_op BEFORE UPDATE OF employee_id, work_date, clock_in, clock_out, clock_out_next_day, status, source, note, shift_id, late_minutes, early_leave_minutes, worked_minutes ON attendance_records
WHEN NEW.change_op IS NULL OR NEW.change_op IS OLD.change_op
BEGIN
  SELECT RAISE(ABORT, 'attendance_records change needs a new change_op (revision)');
END;

CREATE TRIGGER trg_attendance_records_revision_insert AFTER INSERT ON attendance_records
BEGIN
  INSERT INTO attendance_record_revisions (record_id, employee_id, work_date, prev_work_date, action, channel, before_json, after_json, reason, reference, reason_missing, actor_id, op_token)
  VALUES (
    NEW.id, NEW.employee_id, NEW.work_date, NULL, 'created',
    COALESCE(NEW.change_channel, CASE WHEN NEW.import_batch_id IS NOT NULL THEN 'import' END, NEW.source, 'unknown'),
    NULL,
    json_object('employee_id', NEW.employee_id, 'work_date', NEW.work_date, 'clock_in', NEW.clock_in, 'clock_out', NEW.clock_out, 'clock_out_next_day', NEW.clock_out_next_day,
      'status', NEW.status, 'source', NEW.source, 'note', NEW.note, 'shift_id', NEW.shift_id, 'late_minutes', NEW.late_minutes, 'early_leave_minutes', NEW.early_leave_minutes, 'worked_minutes', NEW.worked_minutes),
    COALESCE(NEW.change_reason, CASE WHEN NEW.import_batch_id IS NOT NULL THEN 'นำเข้าไฟล์เวลาทำงาน' END),
    COALESCE(NEW.change_reference, CASE WHEN NEW.import_batch_id IS NOT NULL THEN 'batch:' || NEW.import_batch_id END),
    CASE WHEN COALESCE(NEW.change_reason, CASE WHEN NEW.import_batch_id IS NOT NULL THEN 'import' END) IS NULL THEN 1 ELSE 0 END,
    COALESCE(NEW.created_by, NEW.updated_by), NEW.change_op
  );
END;

CREATE TRIGGER trg_attendance_records_revision_update AFTER UPDATE ON attendance_records
WHEN NEW.change_op IS NOT OLD.change_op
BEGIN
  INSERT INTO attendance_record_revisions (record_id, employee_id, work_date, prev_work_date, action, channel, before_json, after_json, reason, reference, reason_missing, actor_id, op_token)
  VALUES (
    NEW.id, NEW.employee_id, NEW.work_date, CASE WHEN OLD.work_date IS NOT NEW.work_date THEN OLD.work_date END, 'corrected',
    COALESCE(NEW.change_channel, 'unknown'),
    json_object('employee_id', OLD.employee_id, 'work_date', OLD.work_date, 'clock_in', OLD.clock_in, 'clock_out', OLD.clock_out, 'clock_out_next_day', OLD.clock_out_next_day,
      'status', OLD.status, 'source', OLD.source, 'note', OLD.note, 'shift_id', OLD.shift_id, 'late_minutes', OLD.late_minutes, 'early_leave_minutes', OLD.early_leave_minutes, 'worked_minutes', OLD.worked_minutes),
    json_object('employee_id', NEW.employee_id, 'work_date', NEW.work_date, 'clock_in', NEW.clock_in, 'clock_out', NEW.clock_out, 'clock_out_next_day', NEW.clock_out_next_day,
      'status', NEW.status, 'source', NEW.source, 'note', NEW.note, 'shift_id', NEW.shift_id, 'late_minutes', NEW.late_minutes, 'early_leave_minutes', NEW.early_leave_minutes, 'worked_minutes', NEW.worked_minutes),
    NEW.change_reason, NEW.change_reference,
    CASE WHEN NEW.change_reason IS NULL OR trim(NEW.change_reason) = '' THEN 1 ELSE 0 END,
    NEW.updated_by, NEW.change_op
  );
END;

-- the days of an approved or published monthly period are locked for every writer (imports, CRUD, corrections, Time
-- Correction approval and web clock-in alike): a change needs the period reopened through the existing authorised
-- workflow (reopen-closed).
CREATE TRIGGER trg_attendance_records_lock_insert BEFORE INSERT ON attendance_records
WHEN EXISTS (
  SELECT 1 FROM payroll_periods pp JOIN employees e ON e.id = NEW.employee_id
  WHERE pp.kind = 'monthly' AND pp.deleted_at IS NULL AND pp.status IN ('approved', 'published') AND (pp.company_id IS NULL OR pp.company_id = e.company_id)
    AND NEW.work_date BETWEEN pp.start_date AND pp.end_date)
BEGIN
  SELECT RAISE(ABORT, 'attendance_period_locked');
END;
CREATE TRIGGER trg_attendance_records_lock_update BEFORE UPDATE OF employee_id, work_date, clock_in, clock_out, clock_out_next_day, status, source, note, shift_id, late_minutes, early_leave_minutes, worked_minutes ON attendance_records
WHEN EXISTS (
  SELECT 1 FROM payroll_periods pp JOIN employees e ON e.id IN (OLD.employee_id, NEW.employee_id)
  WHERE pp.kind = 'monthly' AND pp.deleted_at IS NULL AND pp.status IN ('approved', 'published') AND (pp.company_id IS NULL OR pp.company_id = e.company_id)
    AND (OLD.work_date BETWEEN pp.start_date AND pp.end_date OR NEW.work_date BETWEEN pp.start_date AND pp.end_date))
BEGIN
  SELECT RAISE(ABORT, 'attendance_period_locked');
END;

-- ===== 2. Attendance snapshot per Calculation Version ============================================================
CREATE TABLE payroll_attendance_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id INTEGER NOT NULL REFERENCES payroll_periods(id),
  calc_version INTEGER NOT NULL,
  -- deterministic hash of every attendance input of the period (records, revisions, schedule, calendar, leave,
  -- exemptions, approved OT, HR confirmations, last judged day)
  attendance_version TEXT NOT NULL,
  -- last day judged (period end, or the calculation day when the period was still running)
  judged_through TEXT NOT NULL,
  -- highest attendance revision id inside the period's dates when the snapshot was read
  revision_watermark INTEGER NOT NULL DEFAULT 0,
  totals_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id),
  UNIQUE (period_id, calc_version)
);
CREATE TABLE payroll_attendance_snapshot_rows (
  snapshot_id INTEGER NOT NULL REFERENCES payroll_attendance_snapshots(id),
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  aggregate_json TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, employee_id)
);
CREATE INDEX idx_payroll_attendance_snapshot_rows_company ON payroll_attendance_snapshot_rows(snapshot_id, company_id);
CREATE TRIGGER trg_payroll_attendance_snapshots_readonly BEFORE UPDATE ON payroll_attendance_snapshots
BEGIN
  SELECT RAISE(ABORT, 'payroll_attendance_snapshots is append-only');
END;
CREATE TRIGGER trg_payroll_attendance_snapshots_nodelete BEFORE DELETE ON payroll_attendance_snapshots
BEGIN
  SELECT RAISE(ABORT, 'payroll_attendance_snapshots is append-only');
END;
CREATE TRIGGER trg_payroll_attendance_snapshot_rows_readonly BEFORE UPDATE ON payroll_attendance_snapshot_rows
BEGIN
  SELECT RAISE(ABORT, 'payroll_attendance_snapshot_rows is append-only');
END;
CREATE TRIGGER trg_payroll_attendance_snapshot_rows_nodelete BEFORE DELETE ON payroll_attendance_snapshot_rows
BEGIN
  SELECT RAISE(ABORT, 'payroll_attendance_snapshot_rows is append-only');
END;

-- ===== 3. Hold kinds of the validation engine (rebuild of the 0019 tables, rows kept) ============================
-- order matters with foreign keys on: the new events table references the new holds table, so dropping the old
-- tables leaves no row pointing at a dropped table; the rename then points events at payroll_attendance_holds
CREATE TABLE payroll_attendance_holds_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id INTEGER NOT NULL REFERENCES payroll_periods(id),
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  kind TEXT NOT NULL CHECK (kind IN ('absent', 'pending_leave', 'missing_attendance', 'invalid_record', 'pending_review')),
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
INSERT INTO payroll_attendance_holds_v2 (id, period_id, employee_id, company_id, kind, work_date, source_json, status, first_detected_at, last_detected_at, resolved_at,
  decision_by, decision_at, decision_reason, op_token, last_action, created_at, updated_at)
SELECT id, period_id, employee_id, company_id, kind, work_date, source_json, status, first_detected_at, last_detected_at, resolved_at,
  decision_by, decision_at, decision_reason, op_token, last_action, created_at, updated_at FROM payroll_attendance_holds;

CREATE TABLE payroll_attendance_hold_events_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hold_id INTEGER NOT NULL REFERENCES payroll_attendance_holds_v2(id),
  period_id INTEGER NOT NULL REFERENCES payroll_periods(id),
  action TEXT NOT NULL CHECK (action IN ('opened', 'cleared', 'resolved', 'reopened')),
  actor_id INTEGER REFERENCES users(id),
  reason TEXT,
  source_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO payroll_attendance_hold_events_v2 (id, hold_id, period_id, action, actor_id, reason, source_json, created_at)
SELECT id, hold_id, period_id, action, actor_id, reason, source_json, created_at FROM payroll_attendance_hold_events;

DROP TABLE payroll_attendance_hold_events;
DROP TABLE payroll_attendance_holds;
ALTER TABLE payroll_attendance_holds_v2 RENAME TO payroll_attendance_holds;
ALTER TABLE payroll_attendance_hold_events_v2 RENAME TO payroll_attendance_hold_events;

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

-- ===== 4. Permission =============================================================================================
-- correct attendance with a reason and reference: roles that already update attendance (super_admin holds *)
INSERT INTO role_permissions (role_id, permission)
SELECT DISTINCT rp.role_id, 'attendance.correct' FROM role_permissions rp
WHERE rp.permission = 'attendance.update'
AND NOT EXISTS (SELECT 1 FROM role_permissions x WHERE x.role_id = rp.role_id AND x.permission = 'attendance.correct');
