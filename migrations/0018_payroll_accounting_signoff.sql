-- Accounting review and manager sign-off for an exact payroll calculation version.
-- Additive only: two new tables, their indexes and three permission grants. No existing row is changed.
-- Rollback: scripts/rollback/0018_payroll_accounting_signoff.down.sql
--
-- Workflow: HR calculates → HR approves → ACC Staff reviews → ACC Manager signs off (or returns to HR) → publish.
-- A review belongs to one (period, calc_version). Recalculating, reopening or a Super Admin reopen marks the active
-- review 'superseded' (event 'invalidated'), so a sign-off can never be reused for other figures. Events are
-- append-only: they keep who did what, when and why, for every version.
CREATE TABLE IF NOT EXISTS payroll_accounting_reviews (
  period_id INTEGER NOT NULL REFERENCES payroll_periods(id) ON DELETE RESTRICT,
  calc_version INTEGER NOT NULL CHECK (calc_version > 0),
  status TEXT NOT NULL CHECK (status IN ('reviewed','returned','signed_off','superseded')),
  staff_reviewed_by INTEGER NOT NULL REFERENCES users(id),
  staff_reviewed_at TEXT NOT NULL DEFAULT (datetime('now')),
  staff_note TEXT,
  manager_signed_by INTEGER REFERENCES users(id),
  manager_signed_at TEXT,
  manager_note TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- identifies the request that made the last change (duplicate requests act once)
  op_token TEXT,
  PRIMARY KEY (period_id, calc_version),
  CHECK ((status = 'signed_off' AND manager_signed_by IS NOT NULL AND manager_signed_at IS NOT NULL) OR status <> 'signed_off')
);
CREATE INDEX IF NOT EXISTS idx_payroll_accounting_reviews_status ON payroll_accounting_reviews(status, period_id);
CREATE TABLE IF NOT EXISTS payroll_accounting_review_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id INTEGER NOT NULL REFERENCES payroll_periods(id) ON DELETE RESTRICT,
  calc_version INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('staff_reviewed','manager_signed_off','returned','invalidated')),
  actor_id INTEGER NOT NULL REFERENCES users(id),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payroll_accounting_review_events_period ON payroll_accounting_review_events(period_id, calc_version, id);
CREATE TRIGGER IF NOT EXISTS trg_payroll_accounting_events_readonly BEFORE UPDATE ON payroll_accounting_review_events
BEGIN
  SELECT RAISE(ABORT, 'payroll_accounting_review_events is append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_payroll_accounting_events_nodelete BEFORE DELETE ON payroll_accounting_review_events
BEGIN
  SELECT RAISE(ABORT, 'payroll_accounting_review_events is append-only');
END;
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, 'payroll.accounting.review' FROM roles r
WHERE r.code IN ('acc_staff','acc_manager')
AND NOT EXISTS (SELECT 1 FROM role_permissions x WHERE x.role_id = r.id AND x.permission = 'payroll.accounting.review');
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, 'payroll.accounting.review.submit' FROM roles r
WHERE r.code = 'acc_staff'
AND NOT EXISTS (SELECT 1 FROM role_permissions x WHERE x.role_id = r.id AND x.permission = 'payroll.accounting.review.submit');
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, 'payroll.accounting.signoff' FROM roles r
WHERE r.code = 'acc_manager'
AND NOT EXISTS (SELECT 1 FROM role_permissions x WHERE x.role_id = r.id AND x.permission = 'payroll.accounting.signoff');
