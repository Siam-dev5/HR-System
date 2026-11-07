-- Feishu import V1.1: one file for several companies (an import group split into one batch per company) and
-- employee attendance exemptions. Additive only: new tables, one new nullable column, indexes, triggers and
-- permissions; no existing row is updated or deleted. Rollback: scripts/rollback/0013_multicompany_import_exemption.down.sql
--
-- Payroll is not touched: nothing here is read by the payroll engine, and an exemption only changes the warnings of
-- an attendance import (no salary, deduction, allowance or attendance bonus is derived from it).

-- ===== Import groups: one confirmed file → one batch per company ===========================================
CREATE TABLE import_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_type TEXT NOT NULL CHECK (import_type IN ('attendance')),
  -- single: the user chose the company; combined: the company of each row comes from an explicit rule
  company_mode TEXT NOT NULL CHECK (company_mode IN ('single', 'combined')),
  template_code TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL CHECK (file_type IN ('xlsx', 'xls', 'csv')),
  file_sha256 TEXT NOT NULL,
  file_size INTEGER,
  sheet_name TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  -- how the company of a row was found: {"column":"Group","values":{"FlyingFish":6,...}} (null: chosen company only)
  company_rule_json TEXT,
  total_rows INTEGER NOT NULL DEFAULT 0,
  company_count INTEGER NOT NULL DEFAULT 0,
  unassigned_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_import_groups_created ON import_groups(import_type, created_at);

ALTER TABLE attendance_file_imports ADD COLUMN group_id INTEGER REFERENCES import_groups(id);
CREATE INDEX idx_attendance_file_imports_group ON attendance_file_imports(group_id);

-- Rows of a combined file whose company could not be identified: kept as read, never imported.
CREATE TABLE import_group_unassigned_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES import_groups(id),
  row_no INTEGER NOT NULL,
  source_ref TEXT,
  employee_code TEXT,
  work_date TEXT,
  company_value TEXT,
  raw_json TEXT NOT NULL,
  issues_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (group_id, row_no)
);
CREATE TRIGGER trg_import_unassigned_readonly BEFORE UPDATE ON import_group_unassigned_rows
BEGIN
  SELECT RAISE(ABORT, 'import_group_unassigned_rows is read-only');
END;
CREATE TRIGGER trg_import_unassigned_nodelete BEFORE DELETE ON import_group_unassigned_rows
BEGIN
  SELECT RAISE(ABORT, 'import_group_unassigned_rows is read-only');
END;

-- Company rule and column mapping remembered per file layout for combined files (not tied to one company).
CREATE TABLE import_company_rules (
  import_type TEXT NOT NULL CHECK (import_type IN ('attendance')),
  template_code TEXT NOT NULL,
  header_signature TEXT NOT NULL,
  mapping_json TEXT NOT NULL,
  company_rule_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  PRIMARY KEY (import_type, template_code, header_signature)
);

-- ===== Attendance exemptions ===============================================================================
-- An employee is exempt from recording time between effective_from and effective_to (open-ended when null) unless
-- the period was revoked. Periods of one employee never overlap (checked by the API). Rows are never deleted.
CREATE TABLE employee_attendance_exemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  revoked_at TEXT,
  revoked_by INTEGER REFERENCES users(id),
  revoke_reason TEXT,
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX idx_attendance_exemptions_employee ON employee_attendance_exemptions(employee_id, effective_from);
CREATE TRIGGER trg_attendance_exemptions_nodelete BEFORE DELETE ON employee_attendance_exemptions
BEGIN
  SELECT RAISE(ABORT, 'employee_attendance_exemptions rows are revoked, never deleted');
END;

-- ===== Permissions (hr_admin already holds *.view; super_admin holds *) ===================================
INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT r.id, p.value FROM roles r, json_each('["attendance_exemption.manage"]') p WHERE r.code = 'hr_admin';

INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT r.id, p.value FROM roles r, json_each('["attendance_exemption.view"]') p WHERE r.code = 'hr_staff';
