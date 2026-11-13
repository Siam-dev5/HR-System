-- Company detection (P3): configurable employee-code prefix mappings and dated company assignments of employees.
-- Nothing here changes which company an employee belongs to: the current employees.company_id of every employee is
-- recorded as a verified "baseline" assignment (from the hire date), a prefix mapping only ever suggests a company
-- for an employee WITHOUT an assignment, and moving an employee to another company goes through the transfer API
-- (history, reason, payroll lock). No payroll, payslip or attendance row is touched.
--
--  1. company_code_mappings (+ history): prefix → company, priority, active / inactive, effective dates. Rows are
--     deactivated, never deleted; an active prefix never has two overlapping effective periods (checked by the API in
--     the same statement that writes, and by a trigger).
--  2. employee_company_assignments (+ history): which company an employee belongs to on which days. Verified /
--     pending_review / cancelled; dates of the non-cancelled rows of one employee never overlap (trigger).
--  3. employees: a new employee records the company HR entered as its first assignment; employees.company_id can only
--     change to the company of the employee's open verified assignment (the transfer writes that first).
--  4. Permissions company_mapping.view / company_mapping.manage / employee_company.transfer for hr_admin.
-- Rollback: scripts/rollback/0021_company_detection.down.sql

-- ===== 1. Prefix mappings ======================================================================================
CREATE TABLE company_code_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  -- upper-case letters / digits, compared with the start of the employee code without case
  prefix TEXT NOT NULL CHECK (length(prefix) BETWEEN 1 AND 10 AND prefix = upper(prefix) AND prefix NOT GLOB '*[^A-Z0-9]*'),
  priority INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 1000),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  effective_from TEXT NOT NULL CHECK (length(effective_from) = 10 AND date(effective_from) = effective_from),
  effective_to TEXT CHECK (effective_to IS NULL OR (length(effective_to) = 10 AND date(effective_to) = effective_to)),
  note TEXT,
  -- optimistic concurrency: every update increments it and must name the version it read
  version INTEGER NOT NULL DEFAULT 1,
  -- the request that made the last change (its history row is the one carrying this token)
  op_token TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  deactivated_at TEXT,
  deactivated_by INTEGER REFERENCES users(id),
  deactivate_reason TEXT,
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX idx_company_code_mappings_prefix ON company_code_mappings(prefix, status);
CREATE INDEX idx_company_code_mappings_company ON company_code_mappings(company_id);
CREATE TRIGGER trg_company_code_mappings_nodelete BEFORE DELETE ON company_code_mappings
BEGIN
  SELECT RAISE(ABORT, 'company_code_mappings rows are deactivated, never deleted');
END;
-- two active rows of one prefix never cover the same day (whatever their companies)
CREATE TRIGGER trg_company_code_mappings_overlap_insert BEFORE INSERT ON company_code_mappings
WHEN NEW.status = 'active' AND EXISTS (
  SELECT 1 FROM company_code_mappings m WHERE m.status = 'active' AND m.prefix = NEW.prefix
    AND m.effective_from <= IFNULL(NEW.effective_to, '9999-12-31') AND IFNULL(m.effective_to, '9999-12-31') >= NEW.effective_from)
BEGIN
  SELECT RAISE(ABORT, 'company_mapping_overlap');
END;
CREATE TRIGGER trg_company_code_mappings_overlap_update BEFORE UPDATE OF prefix, status, effective_from, effective_to ON company_code_mappings
WHEN NEW.status = 'active' AND EXISTS (
  SELECT 1 FROM company_code_mappings m WHERE m.id <> NEW.id AND m.status = 'active' AND m.prefix = NEW.prefix
    AND m.effective_from <= IFNULL(NEW.effective_to, '9999-12-31') AND IFNULL(m.effective_to, '9999-12-31') >= NEW.effective_from)
BEGIN
  SELECT RAISE(ABORT, 'company_mapping_overlap');
END;

CREATE TABLE company_code_mapping_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mapping_id INTEGER NOT NULL REFERENCES company_code_mappings(id),
  action TEXT NOT NULL CHECK (action IN ('created', 'updated', 'deactivated', 'activated')),
  before_json TEXT,
  after_json TEXT NOT NULL,
  reason TEXT,
  actor_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_company_code_mapping_history ON company_code_mapping_history(mapping_id, id);
CREATE TRIGGER trg_company_code_mapping_history_readonly BEFORE UPDATE ON company_code_mapping_history
BEGIN
  SELECT RAISE(ABORT, 'company_code_mapping_history is append-only');
END;
CREATE TRIGGER trg_company_code_mapping_history_nodelete BEFORE DELETE ON company_code_mapping_history
BEGIN
  SELECT RAISE(ABORT, 'company_code_mapping_history is append-only');
END;

-- ===== 2. Company assignments of employees =====================================================================
CREATE TABLE employee_company_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  effective_from TEXT NOT NULL CHECK (length(effective_from) = 10 AND date(effective_from) = effective_from),
  effective_to TEXT CHECK (effective_to IS NULL OR (length(effective_to) = 10 AND date(effective_to) = effective_to)),
  -- verified: payroll may use it; pending_review: HR must confirm (e.g. the entered company differs from the prefix
  -- mapping); cancelled: entered by mistake (kept for history, never used)
  status TEXT NOT NULL DEFAULT 'verified' CHECK (status IN ('verified', 'pending_review', 'cancelled')),
  -- baseline: the company of the employee record when 0021 was applied; employee_record: the company HR entered for
  -- a new employee; transfer: a move through the transfer API
  source TEXT NOT NULL CHECK (source IN ('baseline', 'employee_record', 'transfer')),
  reason TEXT,
  reference TEXT,
  op_token TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  verified_at TEXT,
  verified_by INTEGER REFERENCES users(id),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX idx_employee_company_assignments_employee ON employee_company_assignments(employee_id, effective_from);
CREATE INDEX idx_employee_company_assignments_company ON employee_company_assignments(company_id, status);
CREATE INDEX idx_employee_company_assignments_op ON employee_company_assignments(op_token);
CREATE TRIGGER trg_employee_company_assignments_nodelete BEFORE DELETE ON employee_company_assignments
BEGIN
  SELECT RAISE(ABORT, 'employee_company_assignments rows are cancelled, never deleted');
END;
CREATE TRIGGER trg_employee_company_assignments_overlap_insert BEFORE INSERT ON employee_company_assignments
WHEN NEW.status <> 'cancelled' AND EXISTS (
  SELECT 1 FROM employee_company_assignments a WHERE a.employee_id = NEW.employee_id AND a.status <> 'cancelled'
    AND a.effective_from <= IFNULL(NEW.effective_to, '9999-12-31') AND IFNULL(a.effective_to, '9999-12-31') >= NEW.effective_from)
BEGIN
  SELECT RAISE(ABORT, 'company_assignment_overlap');
END;
CREATE TRIGGER trg_employee_company_assignments_overlap_update BEFORE UPDATE OF employee_id, status, effective_from, effective_to ON employee_company_assignments
WHEN NEW.status <> 'cancelled' AND EXISTS (
  SELECT 1 FROM employee_company_assignments a WHERE a.id <> NEW.id AND a.employee_id = NEW.employee_id AND a.status <> 'cancelled'
    AND a.effective_from <= IFNULL(NEW.effective_to, '9999-12-31') AND IFNULL(a.effective_to, '9999-12-31') >= NEW.effective_from)
BEGIN
  SELECT RAISE(ABORT, 'company_assignment_overlap');
END;
-- the company, employee and start of an assignment never change (a move is a new row; a mistake is cancelled)
CREATE TRIGGER trg_employee_company_assignments_fixed BEFORE UPDATE OF employee_id, company_id, effective_from ON employee_company_assignments
WHEN NEW.employee_id IS NOT OLD.employee_id OR NEW.company_id IS NOT OLD.company_id OR NEW.effective_from IS NOT OLD.effective_from
BEGIN
  SELECT RAISE(ABORT, 'company_assignment_fixed');
END;

CREATE TABLE employee_company_assignment_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES employee_company_assignments(id),
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  action TEXT NOT NULL CHECK (action IN ('created', 'ended', 'verified', 'held', 'cancelled')),
  before_json TEXT,
  after_json TEXT NOT NULL,
  reason TEXT,
  reference TEXT,
  actor_id INTEGER REFERENCES users(id),
  op_token TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_employee_company_assignment_history ON employee_company_assignment_history(assignment_id, id);
CREATE INDEX idx_employee_company_assignment_history_employee ON employee_company_assignment_history(employee_id, id);
CREATE TRIGGER trg_employee_company_assignment_history_readonly BEFORE UPDATE ON employee_company_assignment_history
BEGIN
  SELECT RAISE(ABORT, 'employee_company_assignment_history is append-only');
END;
CREATE TRIGGER trg_employee_company_assignment_history_nodelete BEFORE DELETE ON employee_company_assignment_history
BEGIN
  SELECT RAISE(ABORT, 'employee_company_assignment_history is append-only');
END;

-- baseline: the company every existing employee has today, from the hire date (nothing changes)
INSERT INTO employee_company_assignments (employee_id, company_id, effective_from, status, source, reason, verified_at)
SELECT id, company_id, hire_date, 'verified', 'baseline', 'บริษัทตามทะเบียนพนักงานเดิม (ก่อน Migration 0021)', datetime('now') FROM employees
WHERE hire_date IS NOT NULL AND length(hire_date) = 10 AND date(hire_date) = hire_date;
INSERT INTO employee_company_assignment_history (assignment_id, employee_id, action, after_json, reason)
SELECT id, employee_id, 'created', json_object('company_id', company_id, 'effective_from', effective_from, 'effective_to', effective_to, 'status', status, 'source', source), reason
FROM employee_company_assignments;

-- ===== 3. Employees =============================================================================================
-- a new employee: the company HR entered is the first assignment (verified; the API may hold it for review when it
-- differs from the prefix mapping)
CREATE TRIGGER trg_employees_company_assignment_insert AFTER INSERT ON employees
WHEN NEW.hire_date IS NOT NULL AND length(NEW.hire_date) = 10 AND date(NEW.hire_date) = NEW.hire_date
BEGIN
  INSERT INTO employee_company_assignments (employee_id, company_id, effective_from, status, source, reason, created_by, updated_by, verified_at, verified_by)
  VALUES (NEW.id, NEW.company_id, NEW.hire_date, 'verified', 'employee_record', 'บริษัทที่ระบุในทะเบียนพนักงาน', NEW.created_by, NEW.created_by, datetime('now'), NEW.created_by);
  INSERT INTO employee_company_assignment_history (assignment_id, employee_id, action, after_json, reason, actor_id)
  SELECT id, employee_id, 'created', json_object('company_id', company_id, 'effective_from', effective_from, 'effective_to', effective_to, 'status', status, 'source', source), reason, created_by
  FROM employee_company_assignments WHERE employee_id = NEW.id;
END;
-- employees.company_id follows the open verified assignment: changing it any other way (e.g. the generic employee
-- form) is refused, so a move always has a dated, reasoned, lock-checked transfer behind it
CREATE TRIGGER trg_employees_company_change BEFORE UPDATE OF company_id ON employees
WHEN NEW.company_id IS NOT OLD.company_id AND NOT EXISTS (
  SELECT 1 FROM employee_company_assignments a WHERE a.employee_id = NEW.id AND a.company_id = NEW.company_id AND a.status = 'verified' AND a.effective_to IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'employee_company_needs_transfer');
END;

-- ===== 4. Permissions (super_admin holds *) ======================================================================
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.value FROM roles r, json_each('["company_mapping.view","company_mapping.manage","employee_company.transfer"]') p
WHERE r.code = 'hr_admin' AND NOT EXISTS (SELECT 1 FROM role_permissions x WHERE x.role_id = r.id AND x.permission = p.value);
