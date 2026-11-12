-- Accounting review and manager sign-off for an exact payroll calculation version.
-- Additive only. Historical events are retained when a period is recalculated.
CREATE TABLE IF NOT EXISTS payroll_accounting_reviews (
  period_id INTEGER NOT NULL REFERENCES payroll_periods(id) ON DELETE RESTRICT,
  calc_version INTEGER NOT NULL CHECK (calc_version > 0),
  status TEXT NOT NULL CHECK (status IN ('reviewed','returned','signed_off')),
  staff_reviewed_by INTEGER NOT NULL REFERENCES users(id),
  staff_reviewed_at TEXT NOT NULL DEFAULT (datetime('now')),
  staff_note TEXT,
  manager_signed_by INTEGER REFERENCES users(id),
  manager_signed_at TEXT,
  manager_note TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (period_id, calc_version),
  CHECK ((status = 'signed_off' AND manager_signed_by IS NOT NULL AND manager_signed_at IS NOT NULL) OR status <> 'signed_off')
);
CREATE INDEX IF NOT EXISTS idx_payroll_accounting_reviews_status ON payroll_accounting_reviews(status, period_id);
CREATE TABLE IF NOT EXISTS payroll_accounting_review_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id INTEGER NOT NULL REFERENCES payroll_periods(id) ON DELETE RESTRICT,
  calc_version INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('staff_reviewed','manager_signed_off','returned')),
  actor_id INTEGER NOT NULL REFERENCES users(id),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payroll_accounting_review_events_period ON payroll_accounting_review_events(period_id, calc_version, id);
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, 'payroll.accounting.review' FROM roles r
WHERE r.code IN ('acc_staff','acc_manager')
AND NOT EXISTS (SELECT 1 FROM role_permissions x WHERE x.role_id = r.id AND x.permission = 'payroll.accounting.review');
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, 'payroll.accounting.signoff' FROM roles r
WHERE r.code = 'acc_manager'
AND NOT EXISTS (SELECT 1 FROM role_permissions x WHERE x.role_id = r.id AND x.permission = 'payroll.accounting.signoff');
