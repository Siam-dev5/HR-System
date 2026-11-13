-- Pay frequency (P6): monthly / semi-monthly per company, with an optional per-employee override. It maps onto the
-- payroll mechanism that already exists (docs/HR-PAYROLL-POLICY.md section 3, docs/MID-MONTH-PAYROLL-WORKFLOW.md):
-- a semi-monthly cycle is the mid-month round (an advance for the probation days, salary / 30 × days, no tax / SSO /
-- EWF) plus the month-end period that deducts the approved advance once. No amount, date or deduction rule changes:
--   * effective frequency = employee override, else the company's, else NULL ("not configured": exactly as today)
--   * 'monthly' employees are not part of mid-month rounds (left out of the round's standard list; blocked if selected)
--   * month-end periods pay everyone as before
-- Every change keeps an append-only history row (reason, actor) and an audit entry. Permission pay_frequency.manage.
-- Rollback: scripts/rollback/0024_pay_frequency.down.sql

ALTER TABLE companies ADD COLUMN pay_frequency TEXT CHECK (pay_frequency IS NULL OR pay_frequency IN ('monthly', 'semi_monthly'));
ALTER TABLE employees ADD COLUMN pay_frequency TEXT CHECK (pay_frequency IS NULL OR pay_frequency IN ('monthly', 'semi_monthly'));

CREATE TABLE pay_frequency_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL CHECK (entity IN ('company', 'employee')),
  entity_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  before_value TEXT,
  after_value TEXT,
  reason TEXT NOT NULL,
  actor_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_pay_frequency_history ON pay_frequency_history(entity, entity_id, id);
CREATE INDEX idx_pay_frequency_history_company ON pay_frequency_history(company_id, id);
CREATE TRIGGER trg_pay_frequency_history_readonly BEFORE UPDATE ON pay_frequency_history
BEGIN
  SELECT RAISE(ABORT, 'pay_frequency_history is append-only');
END;
CREATE TRIGGER trg_pay_frequency_history_nodelete BEFORE DELETE ON pay_frequency_history
BEGIN
  SELECT RAISE(ABORT, 'pay_frequency_history is append-only');
END;

-- ===== Permission (super_admin holds *) ==========================================================================
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, 'pay_frequency.manage' FROM roles r
WHERE r.code IN ('hr_admin', 'hr_payroll') AND NOT EXISTS (SELECT 1 FROM role_permissions x WHERE x.role_id = r.id AND x.permission = 'pay_frequency.manage');
