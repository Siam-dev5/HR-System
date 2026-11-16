-- HR attendance review before Calculate (management decision 2026-11-16, docs/HR-PAYROLL-POLICY.md §3.2).
-- Before a payroll period (mid-month or month-end) can be calculated, HR confirms the daily attendance of each company
-- of the period: expected and actual worked days, unpaid leave and confirmed absence (what the calculation deducts),
-- and the anomalies still waiting for review. A confirmation covers exactly one attendance version (SHA-256 of every
-- attendance input of that company in the period, lib/attendance-daily.ts): any later change of a record, a revision,
-- a leave, the schedule, the calendar or an HR decision gives another version, which ends the confirmation
-- ('invalidated') and blocks Calculate until HR confirms again. Additive only: no existing row changes.
CREATE TABLE payroll_attendance_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id INTEGER NOT NULL REFERENCES payroll_periods(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  -- what HR confirmed: the version of the company's attendance in the period, the last day judged, and the highest
  -- attendance revision inside the period's dates when it was read
  attendance_version TEXT NOT NULL,
  judged_through TEXT NOT NULL CHECK (length(judged_through) = 10 AND date(judged_through) = judged_through),
  revision_watermark INTEGER NOT NULL DEFAULT 0,
  -- per-employee figures HR saw (expected / actual days, hours, unpaid leave, absence, payable days, anomalies)
  summary_json TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'superseded', 'invalidated')),
  confirmed_by INTEGER NOT NULL REFERENCES users(id),
  confirmed_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- how the confirmation ended: superseded by a newer confirmation, or invalidated because the attendance changed
  ended_at TEXT,
  ended_by INTEGER REFERENCES users(id),
  ended_reason TEXT,
  op_token TEXT,
  CHECK ((status = 'confirmed') = (ended_at IS NULL))
);
CREATE INDEX idx_payroll_attendance_reviews_period ON payroll_attendance_reviews(period_id, company_id, id);
-- at most one confirmation in force per period and company
CREATE UNIQUE INDEX uq_payroll_attendance_reviews_confirmed ON payroll_attendance_reviews(period_id, company_id) WHERE status = 'confirmed';

-- history is kept: a confirmation is never deleted, and only its ending can be written (once)
CREATE TRIGGER trg_payroll_attendance_reviews_nodelete BEFORE DELETE ON payroll_attendance_reviews
BEGIN
  SELECT RAISE(ABORT, 'payroll_attendance_reviews is append-only');
END;
CREATE TRIGGER trg_payroll_attendance_reviews_end_only BEFORE UPDATE ON payroll_attendance_reviews
WHEN OLD.status <> 'confirmed' OR NEW.status NOT IN ('superseded', 'invalidated')
  OR NEW.period_id IS NOT OLD.period_id OR NEW.company_id IS NOT OLD.company_id OR NEW.attendance_version IS NOT OLD.attendance_version
  OR NEW.judged_through IS NOT OLD.judged_through OR NEW.revision_watermark IS NOT OLD.revision_watermark OR NEW.summary_json IS NOT OLD.summary_json
  OR NEW.note IS NOT OLD.note OR NEW.confirmed_by IS NOT OLD.confirmed_by OR NEW.confirmed_at IS NOT OLD.confirmed_at
BEGIN
  SELECT RAISE(ABORT, 'payroll_attendance_reviews: only a confirmation in force can be ended');
END;

-- confirm the attendance review (HR payroll roles, the same as clearing an attendance hold; super_admin holds *)
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, 'payroll_attendance.confirm' FROM roles r
WHERE r.code IN ('payroll_officer', 'hr_payroll')
AND NOT EXISTS (SELECT 1 FROM role_permissions x WHERE x.role_id = r.id AND x.permission = 'payroll_attendance.confirm');
