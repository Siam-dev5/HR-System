-- Employee selection of payroll periods (P4). Selection (who HR puts in a period), eligibility (whether the period may
-- pay them — computed, never stored as a decision) and the result of a calculation are kept apart. Nothing here
-- changes money: the engine's formula is untouched; it only receives the employees that are selected AND payable.
--
--  1. payroll_period_selections: HR's changes to a period's standard list (the employees computePeriod has always
--     chosen): 'deselected' takes a standard employee out, 'selected' adds one from outside (new hire after the list was
--     read, suspended, a status the list does not know, a past employee to review…). A period without rows keeps
--     exactly the standard list. A review case confirmed by HR keeps the reasons it was confirmed for (the confirmation
--     lapses when they change). Never deleted; every change is an append-only event.
--  2. payroll_period_selection_versions: a counter per period, increased by every selection change; the calculation
--     records the one it used, so approval refuses figures made from an older selection.
--  3. payroll_selection_results: per calc_version, who was selected, their eligibility and whether they were paid
--     (append-only history of every calculation).
--  4. Permissions payroll_selection.view / .manage / .override.
-- Rollback: scripts/rollback/0022_payroll_employee_selection.down.sql

CREATE TABLE payroll_period_selections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id INTEGER NOT NULL REFERENCES payroll_periods(id),
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  -- the employee's company when the row was last written (history; the checks always use live data)
  company_id INTEGER NOT NULL REFERENCES companies(id),
  status TEXT NOT NULL CHECK (status IN ('selected', 'deselected')),
  reason TEXT,
  -- HR confirmation of a review case (never of a blocked one): who, when, why and the reason codes it covered
  review_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (review_confirmed IN (0, 1)),
  review_basis TEXT,
  review_reason TEXT,
  review_confirmed_by INTEGER REFERENCES users(id),
  review_confirmed_at TEXT,
  op_token TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  UNIQUE (period_id, employee_id),
  CHECK (review_confirmed = 0 OR (review_basis IS NOT NULL AND review_reason IS NOT NULL AND review_confirmed_by IS NOT NULL))
);
CREATE INDEX idx_payroll_period_selections_period ON payroll_period_selections(period_id, status);
CREATE INDEX idx_payroll_period_selections_op ON payroll_period_selections(op_token);
CREATE TRIGGER trg_payroll_period_selections_nodelete BEFORE DELETE ON payroll_period_selections
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_selections rows are deselected, never deleted');
END;
-- a row stays with its period and employee
CREATE TRIGGER trg_payroll_period_selections_fixed BEFORE UPDATE OF period_id, employee_id ON payroll_period_selections
WHEN NEW.period_id IS NOT OLD.period_id OR NEW.employee_id IS NOT OLD.employee_id
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_selections period and employee are fixed');
END;

CREATE TABLE payroll_period_selection_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  selection_id INTEGER NOT NULL REFERENCES payroll_period_selections(id),
  period_id INTEGER NOT NULL REFERENCES payroll_periods(id),
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  action TEXT NOT NULL CHECK (action IN ('selected', 'deselected', 'review_confirmed')),
  previous_status TEXT,
  new_status TEXT NOT NULL,
  reason TEXT,
  detail_json TEXT,
  actor_id INTEGER REFERENCES users(id),
  op_token TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_payroll_period_selection_events_period ON payroll_period_selection_events(period_id, id);
CREATE INDEX idx_payroll_period_selection_events_employee ON payroll_period_selection_events(employee_id, id);
CREATE TRIGGER trg_payroll_period_selection_events_readonly BEFORE UPDATE ON payroll_period_selection_events
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_selection_events is append-only');
END;
CREATE TRIGGER trg_payroll_period_selection_events_nodelete BEFORE DELETE ON payroll_period_selection_events
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_selection_events is append-only');
END;

CREATE TABLE payroll_period_selection_versions (
  period_id INTEGER PRIMARY KEY REFERENCES payroll_periods(id),
  -- increased by every selection change (select, deselect, review confirmation)
  version INTEGER NOT NULL DEFAULT 0,
  -- the version the calculation in force used (NULL: not calculated since selections exist)
  calculated_version INTEGER,
  calc_version INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE payroll_selection_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id INTEGER NOT NULL REFERENCES payroll_periods(id),
  calc_version INTEGER NOT NULL,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  -- standard / added / deselected
  selection TEXT NOT NULL CHECK (selection IN ('standard', 'added', 'deselected')),
  eligibility TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('pay', 'review', 'block', 'not_selected')),
  reasons_json TEXT NOT NULL DEFAULT '[]',
  review_confirmed INTEGER NOT NULL DEFAULT 0,
  calculated INTEGER NOT NULL CHECK (calculated IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (period_id, calc_version, employee_id)
);
CREATE TRIGGER trg_payroll_selection_results_readonly BEFORE UPDATE ON payroll_selection_results
BEGIN
  SELECT RAISE(ABORT, 'payroll_selection_results is append-only');
END;
CREATE TRIGGER trg_payroll_selection_results_nodelete BEFORE DELETE ON payroll_selection_results
BEGIN
  SELECT RAISE(ABORT, 'payroll_selection_results is append-only');
END;

-- ===== Permissions (super_admin holds *) =========================================================================
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.value FROM roles r, json_each('["payroll_selection.view","payroll_selection.manage"]') p
WHERE r.code IN ('payroll_officer', 'hr_payroll') AND NOT EXISTS (SELECT 1 FROM role_permissions x WHERE x.role_id = r.id AND x.permission = p.value);
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.value FROM roles r, json_each('["payroll_selection.view","payroll_selection.override"]') p
WHERE r.code IN ('hr_leader', 'hr_payroll') AND NOT EXISTS (SELECT 1 FROM role_permissions x WHERE x.role_id = r.id AND x.permission = p.value);
