-- Feishu import separation: attendance (FEISHU_DAILY_ATTENDANCE_V1), leave (FEISHU_LEAVE_V1) and overtime
-- (FEISHU_OVERTIME_V1), one worksheet per import. Additive only: new columns with defaults, new tables, indexes,
-- triggers and permissions; no existing row is updated or deleted. Rollback: scripts/rollback/0012_feishu_import_separation.down.sql
--
-- Payroll is not touched. Imported leave and overtime are kept in their own tables (leave_import_records,
-- overtime_import_records), never in leave_requests / overtime_requests, which the payroll engine reads.

-- ===== Attendance import: template of the batch, where each vertical row came from, the Feishu punch results ======
ALTER TABLE attendance_file_imports ADD COLUMN template_code TEXT NOT NULL DEFAULT 'CLOCK_FILE_V1';
ALTER TABLE attendance_file_imports ADD COLUMN template_version INTEGER NOT NULL DEFAULT 1;
-- rows of the worksheet before a daily report is turned into one row per employee and day
ALTER TABLE attendance_file_imports ADD COLUMN source_rows INTEGER;

ALTER TABLE attendance_raw_records ADD COLUMN source_ref TEXT;
ALTER TABLE attendance_raw_records ADD COLUMN in_result TEXT;
ALTER TABLE attendance_raw_records ADD COLUMN out_result TEXT;
CREATE TRIGGER trg_attendance_raw_readonly_feishu BEFORE UPDATE OF source_ref, in_result, out_result ON attendance_raw_records
BEGIN
  SELECT RAISE(ABORT, 'attendance_raw_records is read-only');
END;

-- Events of one imported day (leave, overtime, out-of-office, break punches) as written in the daily report.
-- Information only: nothing here is a leave request, an OT request or a payroll item.
CREATE TABLE attendance_day_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES attendance_file_imports(id),
  raw_record_id INTEGER NOT NULL REFERENCES attendance_raw_records(id),
  employee_id INTEGER REFERENCES employees(id),
  work_date TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('leave', 'overtime', 'out_of_office', 'break_punch', 'other')),
  label TEXT NOT NULL,
  amount REAL,
  unit TEXT CHECK (unit IN ('hour', 'day', 'minute')),
  ranges TEXT,
  all_day INTEGER NOT NULL DEFAULT 0,
  overnight INTEGER NOT NULL DEFAULT 0,
  raw_text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (raw_record_id, seq)
);
CREATE INDEX idx_attendance_day_events_batch ON attendance_day_events(batch_id);
CREATE INDEX idx_attendance_day_events_employee_day ON attendance_day_events(employee_id, work_date);
CREATE TRIGGER trg_attendance_day_events_readonly BEFORE UPDATE ON attendance_day_events
BEGIN
  SELECT RAISE(ABORT, 'attendance_day_events is read-only');
END;
CREATE TRIGGER trg_attendance_day_events_nodelete BEFORE DELETE ON attendance_day_events
BEGIN
  SELECT RAISE(ABORT, 'attendance_day_events is read-only');
END;

-- ===== Column mapping templates per company, import type, template and file layout ==========================
CREATE TABLE import_mapping_templates (
  company_id INTEGER NOT NULL REFERENCES companies(id),
  import_type TEXT NOT NULL CHECK (import_type IN ('attendance', 'leave', 'overtime')),
  template_code TEXT NOT NULL,
  template_version INTEGER NOT NULL DEFAULT 1,
  header_signature TEXT NOT NULL,
  mapping_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  PRIMARY KEY (company_id, import_type, template_code, header_signature)
);

-- ===== Leave and overtime imports =========================================================================
CREATE TABLE request_import_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_type TEXT NOT NULL CHECK (import_type IN ('leave', 'overtime')),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  template_code TEXT NOT NULL,
  template_version INTEGER NOT NULL DEFAULT 1,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL CHECK (file_type IN ('xlsx', 'xls', 'csv')),
  file_sha256 TEXT NOT NULL,
  file_size INTEGER,
  sheet_name TEXT,
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
CREATE INDEX idx_request_import_batches_type ON request_import_batches(import_type, company_id, created_at);
CREATE INDEX idx_request_import_batches_sha ON request_import_batches(import_type, company_id, file_sha256);

-- Every row of a leave worksheet as read, with its validation result. Rows with status valid / warning are the
-- imported leave records; one per company and Request ID.
CREATE TABLE leave_import_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES request_import_batches(id),
  row_no INTEGER NOT NULL,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  request_no TEXT,
  employee_code TEXT,
  employee_id INTEGER REFERENCES employees(id),
  employee_name TEXT,
  department TEXT,
  leave_type TEXT,
  start_at TEXT,
  end_at TEXT,
  start_date TEXT,
  end_date TEXT,
  duration REAL,
  duration_unit TEXT CHECK (duration_unit IN ('hour', 'day', 'minute')),
  approval_status TEXT CHECK (approval_status IN ('approved', 'pending', 'rejected', 'cancelled')),
  status_text TEXT,
  approver TEXT,
  reason TEXT,
  submitted_at TEXT,
  completed_at TEXT,
  raw_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('valid', 'warning', 'duplicate', 'invalid')),
  issues_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (batch_id, row_no)
);
CREATE UNIQUE INDEX ux_leave_import_request ON leave_import_records(company_id, request_no) WHERE status IN ('valid', 'warning');
CREATE INDEX idx_leave_import_employee ON leave_import_records(employee_id, start_date);
CREATE TRIGGER trg_leave_import_readonly BEFORE UPDATE ON leave_import_records
BEGIN
  SELECT RAISE(ABORT, 'leave_import_records is read-only');
END;
CREATE TRIGGER trg_leave_import_nodelete BEFORE DELETE ON leave_import_records
BEGIN
  SELECT RAISE(ABORT, 'leave_import_records is read-only');
END;

-- Every row of an overtime worksheet: one row per request detail (a request over two days has details 1 and 2).
-- No OT pay is calculated from these rows and nothing here is read by payroll.
CREATE TABLE overtime_import_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES request_import_batches(id),
  row_no INTEGER NOT NULL,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  request_no TEXT,
  detail_no INTEGER NOT NULL DEFAULT 1,
  employee_code TEXT,
  employee_id INTEGER REFERENCES employees(id),
  employee_name TEXT,
  department TEXT,
  work_date TEXT,
  ot_start_at TEXT,
  ot_end_at TEXT,
  request_hours REAL,
  detail_hours REAL,
  duration_unit TEXT CHECK (duration_unit IN ('hour', 'day', 'minute')),
  overnight INTEGER NOT NULL DEFAULT 0,
  ot_type TEXT,
  date_type TEXT,
  approval_status TEXT CHECK (approval_status IN ('approved', 'pending', 'rejected', 'cancelled')),
  status_text TEXT,
  approver TEXT,
  reason TEXT,
  submitted_at TEXT,
  completed_at TEXT,
  raw_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('valid', 'warning', 'duplicate', 'invalid')),
  issues_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (batch_id, row_no)
);
CREATE UNIQUE INDEX ux_overtime_import_request ON overtime_import_records(company_id, request_no, detail_no) WHERE status IN ('valid', 'warning');
CREATE INDEX idx_overtime_import_employee ON overtime_import_records(employee_id, work_date);
CREATE TRIGGER trg_overtime_import_readonly BEFORE UPDATE ON overtime_import_records
BEGIN
  SELECT RAISE(ABORT, 'overtime_import_records is read-only');
END;
CREATE TRIGGER trg_overtime_import_nodelete BEFORE DELETE ON overtime_import_records
BEGIN
  SELECT RAISE(ABORT, 'overtime_import_records is read-only');
END;

-- ===== Permissions (hr_admin already holds *.view; super_admin holds *) ======================================
INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT r.id, p.value FROM roles r, json_each('["leave_import.import","overtime_import.import"]') p WHERE r.code = 'hr_admin';

INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT r.id, p.value FROM roles r, json_each('["leave_import.view","leave_import.import","overtime_import.view","overtime_import.import"]') p WHERE r.code = 'hr_staff';

INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT r.id, p.value FROM roles r, json_each('["leave_import.view","overtime_import.view"]') p WHERE r.code = 'payroll_officer';
