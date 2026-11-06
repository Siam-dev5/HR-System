-- Attendance file import (raw rows kept as read, processed rows in attendance_records), detailed shift settings,
-- shift groups with members, effective-dated group default shifts and the daily group schedule with revisions.
-- Additive only: existing tables get new nullable / defaulted columns, nothing is dropped or rebuilt and no existing
-- row changes value. Payroll tables are not touched (payroll reads the Feishu attendance_imports, not these tables).
-- Rollback: scripts/rollback/0011_attendance_shifts.down.sql

-- ===== Shift settings (extends shifts) ========================================================
-- company scope (NULL = every company), shift type, working days (0 = Sunday … 6 = Saturday), break periods
-- ([{"start":"12:00","end":"13:00"}, …]; legacy rows keep break_minutes), colour and clock-in / clock-out rules
ALTER TABLE shifts ADD COLUMN company_id INTEGER REFERENCES companies(id);
ALTER TABLE shifts ADD COLUMN shift_type TEXT NOT NULL DEFAULT 'fixed' CHECK (shift_type IN ('fixed', 'scheduled'));
ALTER TABLE shifts ADD COLUMN work_days TEXT NOT NULL DEFAULT '1,2,3,4,5';
ALTER TABLE shifts ADD COLUMN breaks_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE shifts ADD COLUMN color TEXT;
-- earliest clock-in before the start / latest clock-out after the end that still belong to the shift
ALTER TABLE shifts ADD COLUMN clock_in_before_minutes INTEGER NOT NULL DEFAULT 120;
ALTER TABLE shifts ADD COLUMN clock_out_after_minutes INTEGER NOT NULL DEFAULT 240;
-- 0 keeps the existing rule (late = clock-in after the start time)
ALTER TABLE shifts ADD COLUMN late_grace_minutes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shifts ADD COLUMN early_leave_grace_minutes INTEGER NOT NULL DEFAULT 0;
-- informational only: OT is still requested and approved through the existing OT workflow
ALTER TABLE shifts ADD COLUMN ot_eligible INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shifts ADD COLUMN deleted_at TEXT;
ALTER TABLE shifts ADD COLUMN deleted_by INTEGER REFERENCES users(id);
CREATE INDEX idx_shifts_company ON shifts(company_id);

-- ===== Attendance file import =================================================================
-- one batch per confirmed import; idempotency_key makes a repeated confirmation return the same batch
CREATE TABLE attendance_file_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL CHECK (file_type IN ('xlsx', 'xls', 'csv')),
  file_sha256 TEXT NOT NULL,
  file_size INTEGER,
  sheet_name TEXT,
  source TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  mapping_json TEXT NOT NULL,
  total_rows INTEGER NOT NULL DEFAULT 0,
  imported_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  warning_count INTEGER NOT NULL DEFAULT 0,
  invalid_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('completed', 'partial', 'failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_attendance_file_imports_company ON attendance_file_imports(company_id, created_at);
CREATE INDEX idx_attendance_file_imports_sha ON attendance_file_imports(company_id, file_sha256);

-- Raw attendance: every row of the file as read (valid or not), never edited after the import.
-- status = the validation result; attendance_record_id is set when the row created a processed record.
CREATE TABLE attendance_raw_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES attendance_file_imports(id),
  row_no INTEGER NOT NULL,
  employee_code TEXT,
  employee_id INTEGER REFERENCES employees(id),
  work_date TEXT,
  clock_in TEXT,
  clock_out TEXT,
  clock_out_next_day INTEGER NOT NULL DEFAULT 0,
  device TEXT,
  source TEXT,
  remark TEXT,
  raw_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('valid', 'warning', 'duplicate', 'invalid')),
  issues_json TEXT NOT NULL DEFAULT '[]',
  attendance_record_id INTEGER REFERENCES attendance_records(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (batch_id, row_no)
);
CREATE INDEX idx_attendance_raw_employee_day ON attendance_raw_records(employee_id, work_date);
CREATE TRIGGER trg_attendance_raw_readonly BEFORE UPDATE OF batch_id, row_no, employee_code, employee_id, work_date, clock_in, clock_out, clock_out_next_day, device, source, remark, raw_json ON attendance_raw_records
BEGIN
  SELECT RAISE(ABORT, 'attendance_raw_records is read-only');
END;
CREATE TRIGGER trg_attendance_raw_nodelete BEFORE DELETE ON attendance_raw_records
BEGIN
  SELECT RAISE(ABORT, 'attendance_raw_records is read-only');
END;

-- column mapping remembered per company and file layout (signature of the normalised header row)
CREATE TABLE attendance_file_mappings (
  company_id INTEGER NOT NULL REFERENCES companies(id),
  header_signature TEXT NOT NULL,
  mapping_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  PRIMARY KEY (company_id, header_signature)
);

-- Processed attendance stays in attendance_records (unique per employee and day): link to the batch, the device,
-- the shift the times were checked against and the result of that check
ALTER TABLE attendance_records ADD COLUMN import_batch_id INTEGER REFERENCES attendance_file_imports(id);
ALTER TABLE attendance_records ADD COLUMN device TEXT;
ALTER TABLE attendance_records ADD COLUMN shift_id INTEGER REFERENCES shifts(id);
ALTER TABLE attendance_records ADD COLUMN clock_out_next_day INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attendance_records ADD COLUMN late_minutes INTEGER;
ALTER TABLE attendance_records ADD COLUMN early_leave_minutes INTEGER;
ALTER TABLE attendance_records ADD COLUMN worked_minutes INTEGER;
CREATE INDEX idx_attendance_records_batch ON attendance_records(import_batch_id);

-- ===== Shift groups ===========================================================================
-- membership: how members are chosen (manual / department / company); shift_type: fixed (members work the group's
-- default shift) or scheduled (HR assigns a shift per member and day)
CREATE TABLE shift_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  department_id INTEGER REFERENCES departments(id),
  owner_employee_id INTEGER REFERENCES employees(id),
  membership TEXT NOT NULL DEFAULT 'manual' CHECK (membership IN ('manual', 'department', 'company')),
  shift_type TEXT NOT NULL CHECK (shift_type IN ('fixed', 'scheduled')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  deleted_at TEXT,
  deleted_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_shift_groups_company ON shift_groups(company_id);

-- default shift of a group from a date on (the row in force on a day is the latest effective_date <= that day)
CREATE TABLE shift_group_defaults (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES shift_groups(id),
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  effective_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id),
  UNIQUE (group_id, effective_date)
);

-- membership periods (history is kept: removing or transferring ends the period, nothing is deleted).
-- An employee belongs to at most one group on any day (open period unique; dated overlaps checked by the API).
CREATE TABLE shift_group_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES shift_groups(id),
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  start_date TEXT NOT NULL,
  end_date TEXT,
  method TEXT NOT NULL CHECK (method IN ('manual', 'department', 'company', 'transfer')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id),
  ended_at TEXT,
  ended_by INTEGER REFERENCES users(id),
  CHECK (end_date IS NULL OR end_date >= date(start_date, '-1 day'))
);
CREATE INDEX idx_shift_group_members_group ON shift_group_members(group_id, end_date);
CREATE INDEX idx_shift_group_members_employee ON shift_group_members(employee_id, start_date);
CREATE UNIQUE INDEX ux_shift_group_member_open ON shift_group_members(employee_id) WHERE end_date IS NULL;

-- ===== Group schedule =========================================================================
-- one entry per employee and day: a shift, a day off or a holiday. origin: group = assigned for the members of a
-- scheduled group, individual = an override for one person. Days without an entry use the group default shift.
CREATE TABLE shift_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  work_date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('shift', 'day_off', 'holiday')),
  shift_id INTEGER REFERENCES shifts(id),
  origin TEXT NOT NULL CHECK (origin IN ('group', 'individual')),
  group_id INTEGER REFERENCES shift_groups(id),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  CHECK ((kind = 'shift') = (shift_id IS NOT NULL)),
  UNIQUE (employee_id, work_date)
);
CREATE INDEX idx_shift_schedules_company_date ON shift_schedules(company_id, work_date);

-- every change of a schedule entry (one save = one change_token, which also makes a repeated save a no-op)
CREATE TABLE shift_schedule_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  work_date TEXT NOT NULL,
  change_token TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_shift_schedule_revisions_employee ON shift_schedule_revisions(employee_id, work_date);
CREATE INDEX idx_shift_schedule_revisions_token ON shift_schedule_revisions(change_token);

-- ===== Permissions ============================================================================
INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT r.id, p.value FROM roles r, json_each('["attendance_file.import","shift_groups.manage","shift_schedule.manage"]') p WHERE r.code = 'hr_admin';

INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT r.id, p.value FROM roles r, json_each('["attendance_file.view","attendance_file.import","shifts.create","shifts.update","shift_groups.view","shift_groups.manage","shift_schedule.view","shift_schedule.manage"]') p WHERE r.code = 'hr_staff';

INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT r.id, p.value FROM roles r, json_each('["shifts.view","shift_groups.view","shift_schedule.view"]') p WHERE r.code = 'hr_manager';

INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT r.id, p.value FROM roles r, json_each('["attendance_file.view","shift_schedule.view"]') p WHERE r.code = 'payroll_officer';
