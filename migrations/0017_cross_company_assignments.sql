-- Cross Company Manager Assignment: a functional / operational responsibility of an employee (the "manager") for a
-- department or team of ANOTHER company, optionally for one named employee of that team. It is separate from the
-- primary reporting line: employees.manager_id is never read for writing nor changed by this feature, and no employee,
-- company, department, position, payroll or attendance row is touched. Additive only: two tables, two triggers, two
-- indexes and the grants of two new permissions.
-- Rollback: scripts/rollback/0017_cross_company_assignments.down.sql
--
-- * manager_company_id / employee_company_id are the companies at the time of the last save (history); the chart and
--   the scope checks always use the live employees.company_id.
-- * status: active | inactive (paused, can be re-activated) | cancelled (final). Whether an active row is in effect on
--   a date follows effective_from / effective_to (open-ended when null), so an expired row never shows as active.
-- * Rows are never deleted (trigger); every create / update / status change / cancel writes a history row with the
--   values before and after, and an audit_logs entry.

CREATE TABLE cross_company_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  manager_employee_id INTEGER NOT NULL REFERENCES employees(id),
  manager_company_id INTEGER NOT NULL REFERENCES companies(id),
  target_company_id INTEGER NOT NULL REFERENCES companies(id),
  target_department_id INTEGER NOT NULL REFERENCES departments(id),
  team_name TEXT,
  -- NULL = responsible for the whole target department / team
  employee_id INTEGER REFERENCES employees(id),
  employee_company_id INTEGER REFERENCES companies(id),
  relationship_type TEXT NOT NULL CHECK (relationship_type IN ('team_lead', 'functional_manager', 'project_lead', 'operational_supervisor')),
  responsibility TEXT,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'cancelled')),
  cancel_reason TEXT,
  cancelled_at TEXT,
  cancelled_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (employee_id IS NULL OR employee_id <> manager_employee_id),
  CHECK (manager_company_id <> target_company_id)
);
CREATE INDEX idx_cca_target ON cross_company_assignments(target_company_id, target_department_id);
CREATE INDEX idx_cca_manager ON cross_company_assignments(manager_employee_id);
CREATE TRIGGER trg_cca_nodelete BEFORE DELETE ON cross_company_assignments
BEGIN
  SELECT RAISE(ABORT, 'cross_company_assignments rows are cancelled, never deleted');
END;

CREATE TABLE cross_company_assignment_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES cross_company_assignments(id),
  action TEXT NOT NULL CHECK (action IN ('created', 'updated', 'activated', 'deactivated', 'cancelled')),
  before_json TEXT,
  after_json TEXT,
  reason TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  by_user_id INTEGER REFERENCES users(id)
);
CREATE INDEX idx_cca_history ON cross_company_assignment_history(assignment_id, id);
CREATE TRIGGER trg_cca_history_nodelete BEFORE DELETE ON cross_company_assignment_history
BEGIN
  SELECT RAISE(ABORT, 'cross_company_assignment_history rows are never deleted');
END;
CREATE TRIGGER trg_cca_history_readonly BEFORE UPDATE ON cross_company_assignment_history
BEGIN
  SELECT RAISE(ABORT, 'cross_company_assignment_history rows are read-only');
END;

-- ===== Permissions (super_admin holds *; hr_admin already holds *.view) =================================
INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT r.id, p.value FROM roles r, json_each('["org_assignment.view","org_assignment.manage"]') p WHERE r.code = 'hr_admin';

INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT r.id, p.value FROM roles r, json_each('["org_assignment.view"]') p WHERE r.code = 'hr_staff';
