-- Feishu attendance import + OT review, probation (two-round) payroll, payroll preview layouts,
-- payslip YTD identity and organization design permissions.
-- Additive only: no table is dropped or rebuilt, existing payroll rows keep every value they had.

-- ===== Employees ==============================================================================
-- last day of employment (pay is prorated up to this date; NULL = still employed)
ALTER TABLE employees ADD COLUMN termination_date TEXT;
-- global identity for YTD across companies: a transferred employee's new record points at the original record
ALTER TABLE employees ADD COLUMN person_id INTEGER REFERENCES employees(id);
CREATE INDEX idx_employees_person_id ON employees(person_id);

-- approved salary history: the rate in force on a day is the latest row with effective_date <= that day
-- (no row applies → employees.base_salary)
CREATE TABLE employee_salary_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  effective_date TEXT NOT NULL,
  base_salary REAL NOT NULL CHECK (base_salary >= 0),
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
CREATE UNIQUE INDEX ux_salary_history_day ON employee_salary_history(employee_id, effective_date);

-- ===== Payroll ================================================================================
-- monthly: normal cycle · mid_month: advance for employees still on probation (paid by the 15th)
ALTER TABLE payroll_periods ADD COLUMN kind TEXT NOT NULL DEFAULT 'monthly' CHECK (kind IN ('monthly', 'mid_month'));
-- company whose employees the period pays (NULL = every company, the behaviour of existing periods)
ALTER TABLE payroll_periods ADD COLUMN company_id INTEGER REFERENCES companies(id);
-- incremented on every calculation; payslips carry the version they were produced by
ALTER TABLE payroll_periods ADD COLUMN calc_version INTEGER NOT NULL DEFAULT 0;

-- company that actually paid the slip (company YTD), mid-month advance deducted, calculation snapshot
ALTER TABLE payslips ADD COLUMN company_id INTEGER REFERENCES companies(id);
ALTER TABLE payslips ADD COLUMN advance REAL NOT NULL DEFAULT 0;
ALTER TABLE payslips ADD COLUMN calc_json TEXT;
ALTER TABLE payslips ADD COLUMN calc_version INTEGER NOT NULL DEFAULT 0;
-- metadata only (amounts untouched): existing slips are attributed to the employee's company
UPDATE payslips SET company_id = (SELECT e.company_id FROM employees e WHERE e.id = payslips.employee_id) WHERE company_id IS NULL;
CREATE INDEX idx_payslips_company ON payslips(company_id);

-- payroll preview column groups for pay components
ALTER TABLE pay_components ADD COLUMN category TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('allowance', 'commission', 'bonus', 'provident_fund', 'other'));
UPDATE pay_components SET category = 'allowance' WHERE code IN ('POS_ALLOW', 'TRAVEL', 'MEAL');
UPDATE pay_components SET category = 'provident_fund' WHERE code = 'PVD';

-- payroll preview column order / visibility per company (managed by Super Admin only)
CREATE TABLE payroll_column_layouts (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id),
  columns_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id)
);

-- ===== Feishu attendance import ===============================================================
CREATE TABLE attendance_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  payroll_period_id INTEGER NOT NULL REFERENCES payroll_periods(id),
  version INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  file_sha256 TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('days', 'hours')),
  layout TEXT NOT NULL CHECK (layout IN ('summary', 'daily')),
  source_start TEXT,
  source_end TEXT,
  headers_json TEXT NOT NULL,
  mapping_json TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  imported_count INTEGER NOT NULL DEFAULT 0,
  excluded_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'rolled_back')),
  locked INTEGER NOT NULL DEFAULT 0,
  locked_at TEXT,
  rolled_back_at TEXT,
  rolled_back_by INTEGER REFERENCES users(id),
  rollback_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id)
);
CREATE UNIQUE INDEX ux_attendance_import_version ON attendance_imports(company_id, payroll_period_id, version);
CREATE UNIQUE INDEX ux_attendance_import_active ON attendance_imports(company_id, payroll_period_id) WHERE status = 'active';
CREATE INDEX idx_attendance_import_sha ON attendance_imports(file_sha256);

-- one row per employee per import (daily reports are aggregated); raw_json keeps the original cells
CREATE TABLE attendance_import_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL REFERENCES attendance_imports(id) ON DELETE CASCADE,
  row_no INTEGER NOT NULL,
  employee_id INTEGER REFERENCES employees(id),
  employee_code TEXT NOT NULL,
  employee_name TEXT,
  external_department_id TEXT,
  department_name TEXT,
  company_name TEXT,
  hire_date TEXT,
  expected_work_days REAL,
  expected_work_hours REAL,
  actual_work_days REAL,
  actual_work_hours REAL,
  feishu_overtime_hours REAL,
  absence_days REAL,
  absence_minutes REAL,
  unpaid_sick_leave_hours REAL,
  unpaid_personal_leave_hours REAL,
  included INTEGER NOT NULL DEFAULT 1,
  issues_json TEXT NOT NULL DEFAULT '[]',
  raw_json TEXT NOT NULL,
  -- OT review: Feishu value stays in feishu_overtime_hours, the HR decision is recorded separately
  ot_status TEXT NOT NULL DEFAULT 'none' CHECK (ot_status IN ('none', 'pending', 'confirmed', 'rejected', 'revised')),
  ot_confirmed_hours REAL,
  ot_rate REAL,
  ot_reviewed_by INTEGER REFERENCES users(id),
  ot_reviewed_at TEXT,
  ot_reason TEXT
);
CREATE INDEX idx_attendance_rows_import ON attendance_import_rows(import_id);
CREATE INDEX idx_attendance_rows_employee ON attendance_import_rows(employee_id);
CREATE INDEX idx_attendance_rows_ot ON attendance_import_rows(ot_status);

CREATE TABLE attendance_mapping_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  company_id INTEGER REFERENCES companies(id),
  mapping_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id)
);

-- ===== Permissions ============================================================================
-- payroll_layout.manage is reserved for the super_admin role (checked by role in the API, never granted here)
INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT r.id, p.value FROM roles r, json_each('["org_chart.import","salary_history.sensitive"]') p WHERE r.code = 'hr_admin';

INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT r.id, p.value FROM roles r, json_each('["payroll_preview.view","payroll_preview.export","attendance_import.view","ot_review.view","payslip_ytd.view","salary_history.*","org_chart.view"]') p WHERE r.code = 'payroll_officer';

INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT r.id, p.value FROM roles r, json_each('["attendance_import.view","attendance_import.create","attendance_import.update","ot_review.view","ot_review.update","org_chart.view","org_chart.export","payslip_ytd.view"]') p WHERE r.code = 'hr_staff';

INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT r.id, p.value FROM roles r, json_each('["org_chart.view","ot_review.view"]') p WHERE r.code = 'hr_manager';

INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT r.id, p.value FROM roles r, json_each('["payslip_ytd.view"]') p WHERE r.code = 'employee';
