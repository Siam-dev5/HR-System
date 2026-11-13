-- Attendance holds (P1): absent workdays, days covered only by a leave pending approval, and employees without any
-- attendance in a monthly payroll period are held for HR review. While a hold is open, HR approval of the period is
-- refused. Nothing here pays or deducts money: HR clears a hold with a reason (no deduction), or the source data is
-- corrected (e.g. the leave is approved — an unpaid leave is then deducted by the existing engine rule) and the next
-- scan resolves it. Off by default: holds apply only to monthly periods starting on or after the System Setting
-- payroll.attendance_review_from (empty = off), so every existing period behaves exactly as before.
-- Additive only: two new tables, indexes, triggers, one setting and one permission grant. No existing row is changed.
-- Rollback: scripts/rollback/0019_payroll_attendance_holds.down.sql

CREATE TABLE payroll_attendance_holds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id INTEGER NOT NULL REFERENCES payroll_periods(id),
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  kind TEXT NOT NULL CHECK (kind IN ('absent', 'pending_leave', 'missing_attendance')),
  -- the held workday; NULL for missing_attendance (one per employee and period)
  work_date TEXT CHECK (work_date IS NULL OR (length(work_date) = 10 AND date(work_date) = work_date)),
  -- what was found: attendance row ids, leave references with their status, judged workdays (JSON)
  source_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'cleared', 'resolved')),
  first_detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- set when a scan no longer finds the problem (source data corrected)
  resolved_at TEXT,
  -- HR decision (clear): who, when, why
  decision_by INTEGER REFERENCES users(id),
  decision_at TEXT,
  decision_reason TEXT,
  -- the request that made the last status change, and that change (for its history event)
  op_token TEXT,
  last_action TEXT CHECK (last_action IS NULL OR last_action IN ('opened', 'cleared', 'resolved', 'reopened')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- a dated hold for absent / pending_leave, one undated hold per employee and period for missing_attendance
  CHECK ((kind = 'missing_attendance') = (work_date IS NULL))
);
CREATE UNIQUE INDEX ux_payroll_attendance_hold ON payroll_attendance_holds(period_id, employee_id, kind, IFNULL(work_date, ''));
CREATE INDEX idx_payroll_attendance_holds_period ON payroll_attendance_holds(period_id, status, company_id);
CREATE INDEX idx_payroll_attendance_holds_op ON payroll_attendance_holds(op_token);
CREATE TRIGGER trg_payroll_attendance_holds_nodelete BEFORE DELETE ON payroll_attendance_holds
BEGIN
  SELECT RAISE(ABORT, 'payroll_attendance_holds rows are cleared or resolved, never deleted');
END;

-- Every status change of a hold (append-only): opened / cleared / resolved / reopened, by whom, when, why, and what the
-- scan found at that moment.
CREATE TABLE payroll_attendance_hold_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hold_id INTEGER NOT NULL REFERENCES payroll_attendance_holds(id),
  period_id INTEGER NOT NULL REFERENCES payroll_periods(id),
  action TEXT NOT NULL CHECK (action IN ('opened', 'cleared', 'resolved', 'reopened')),
  actor_id INTEGER REFERENCES users(id),
  reason TEXT,
  source_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
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

INSERT INTO settings (key, value, type, description) VALUES
  ('payroll.attendance_review_from', '', 'text', 'ตรวจสอบเวลาทำงานก่อนอนุมัติเงินเดือน (Attendance Hold): ใช้กับงวดรายเดือนที่เริ่มตั้งแต่วันที่นี้ (YYYY-MM-DD) · เว้นว่าง = ปิด');

-- clear a hold (HR payroll roles; super_admin holds *)
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, 'payroll_hold.resolve' FROM roles r
WHERE r.code IN ('payroll_officer', 'hr_payroll')
AND NOT EXISTS (SELECT 1 FROM role_permissions x WHERE x.role_id = r.id AND x.permission = 'payroll_hold.resolve');
