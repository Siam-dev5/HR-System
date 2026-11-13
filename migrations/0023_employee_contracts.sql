-- Contract periods of contract employees (P5). Until now a contract employee (employees.employment_type = 'contract')
-- had no contract dates: payroll paid them monthly from base_salary like everyone else, and nothing changes in that
-- formula. This adds the dated contract periods HR records, so payroll eligibility can see when the paid days are not
-- covered by a contract (review by HR: set the termination date, renew, or confirm). A contract employee without any
-- recorded contract keeps being paid as before (eligibility notes it).
--
-- Rows are cancelled, never deleted; non-cancelled periods of one employee never overlap (trigger); every change is an
-- append-only history row and an audit entry. Permissions employee_contract.view / .manage.
-- Rollback: scripts/rollback/0023_employee_contracts.down.sql

CREATE TABLE employee_contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  -- the employee's company when the row was last written (history; checks use live data)
  company_id INTEGER NOT NULL REFERENCES companies(id),
  contract_no TEXT,
  start_date TEXT NOT NULL CHECK (length(start_date) = 10 AND date(start_date) = start_date),
  -- NULL = open-ended
  end_date TEXT CHECK (end_date IS NULL OR (length(end_date) = 10 AND date(end_date) = end_date)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  reason TEXT,
  reference TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  op_token TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  cancelled_at TEXT,
  cancelled_by INTEGER REFERENCES users(id),
  cancel_reason TEXT,
  CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE INDEX idx_employee_contracts_employee ON employee_contracts(employee_id, start_date);
CREATE INDEX idx_employee_contracts_company ON employee_contracts(company_id, status);
CREATE TRIGGER trg_employee_contracts_nodelete BEFORE DELETE ON employee_contracts
BEGIN
  SELECT RAISE(ABORT, 'employee_contracts rows are cancelled, never deleted');
END;
CREATE TRIGGER trg_employee_contracts_overlap_insert BEFORE INSERT ON employee_contracts
WHEN NEW.status = 'active' AND EXISTS (
  SELECT 1 FROM employee_contracts c WHERE c.employee_id = NEW.employee_id AND c.status = 'active'
    AND c.start_date <= IFNULL(NEW.end_date, '9999-12-31') AND IFNULL(c.end_date, '9999-12-31') >= NEW.start_date)
BEGIN
  SELECT RAISE(ABORT, 'employee_contract_overlap');
END;
CREATE TRIGGER trg_employee_contracts_overlap_update BEFORE UPDATE OF employee_id, status, start_date, end_date ON employee_contracts
WHEN NEW.status = 'active' AND EXISTS (
  SELECT 1 FROM employee_contracts c WHERE c.id <> NEW.id AND c.employee_id = NEW.employee_id AND c.status = 'active'
    AND c.start_date <= IFNULL(NEW.end_date, '9999-12-31') AND IFNULL(c.end_date, '9999-12-31') >= NEW.start_date)
BEGIN
  SELECT RAISE(ABORT, 'employee_contract_overlap');
END;
-- a contract stays with its employee and start date (a new contract is a new row)
CREATE TRIGGER trg_employee_contracts_fixed BEFORE UPDATE OF employee_id, start_date ON employee_contracts
WHEN NEW.employee_id IS NOT OLD.employee_id OR NEW.start_date IS NOT OLD.start_date
BEGIN
  SELECT RAISE(ABORT, 'employee_contract_fixed');
END;

CREATE TABLE employee_contract_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES employee_contracts(id),
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  action TEXT NOT NULL CHECK (action IN ('created', 'updated', 'cancelled')),
  before_json TEXT,
  after_json TEXT NOT NULL,
  reason TEXT,
  reference TEXT,
  actor_id INTEGER REFERENCES users(id),
  op_token TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_employee_contract_history ON employee_contract_history(contract_id, id);
CREATE TRIGGER trg_employee_contract_history_readonly BEFORE UPDATE ON employee_contract_history
BEGIN
  SELECT RAISE(ABORT, 'employee_contract_history is append-only');
END;
CREATE TRIGGER trg_employee_contract_history_nodelete BEFORE DELETE ON employee_contract_history
BEGIN
  SELECT RAISE(ABORT, 'employee_contract_history is append-only');
END;

-- ===== Permissions (super_admin holds *) =========================================================================
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.value FROM roles r, json_each('["employee_contract.view","employee_contract.manage"]') p
WHERE r.code IN ('hr_admin', 'hr_payroll') AND NOT EXISTS (SELECT 1 FROM role_permissions x WHERE x.role_id = r.id AND x.permission = p.value);
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, 'employee_contract.view' FROM roles r
WHERE r.code IN ('payroll_officer', 'hr_leader') AND NOT EXISTS (SELECT 1 FROM role_permissions x WHERE x.role_id = r.id AND x.permission = 'employee_contract.view');
