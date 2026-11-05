-- Holiday calendar (Thailand first, any country by ISO 3166 code), verified holiday-work evidence and holiday pay rules.
-- Additive only: no existing table or row is changed, so payroll for employees without holiday work is unaffected.
-- No holiday DATES are seeded: official holidays are entered or imported as unverified drafts and become usable by
-- attendance / payroll only after the source (official announcement) is verified and a second person approves them.
-- Holiday pay RULES are not seeded either (entitlement and multipliers are an HR / legal decision).
-- No triggers on purpose: scripts/prepare-d1-restore.mjs splits a dump on ";" and must keep working.
-- Local rollback: scripts/rollback/0009_holiday_calendar.down.sql (never on production without a backup).

-- one calendar per country (company_id NULL = central calendar) and per company that has its own announcements
CREATE TABLE holiday_calendars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  country_code TEXT NOT NULL DEFAULT 'TH' CHECK (length(country_code) = 2 AND country_code = upper(country_code)),
  company_id INTEGER REFERENCES companies(id),
  -- weekly rest days of employees on this calendar: 0 = Sunday … 6 = Saturday
  weekly_rest_days TEXT NOT NULL DEFAULT '0,6',
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id)
);
CREATE UNIQUE INDEX ux_holiday_calendar_scope ON holiday_calendars(country_code, IFNULL(company_id, 0));
CREATE INDEX idx_holiday_calendar_company ON holiday_calendars(company_id);

CREATE TABLE holidays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  calendar_id INTEGER NOT NULL REFERENCES holiday_calendars(id),
  -- Gregorian date; date() normalises impossible dates (2027-02-29 → 2027-03-01), so the equality rejects them
  holiday_date TEXT NOT NULL CHECK (length(holiday_date) = 10 AND date(holiday_date) = holiday_date),
  year INTEGER NOT NULL CHECK (year = CAST(substr(holiday_date, 1, 4) AS INTEGER)),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  name_en TEXT,
  holiday_type TEXT NOT NULL CHECK (holiday_type IN ('traditional', 'national_labour', 'company', 'substitute', 'local')),
  -- draft → approved (usable by attendance and payroll) → inactive (kept for history, never deleted once referenced)
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'inactive')),
  -- how the row was created, and whether its source announcement was checked (separate from approval)
  origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'import')),
  verification TEXT NOT NULL DEFAULT 'unverified' CHECK (verification IN ('unverified', 'verified')),
  source_reference TEXT,
  source_url TEXT,
  region TEXT,
  note TEXT,
  import_batch TEXT,
  verified_by INTEGER REFERENCES users(id),
  verified_at TEXT,
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  deactivated_by INTEGER REFERENCES users(id),
  deactivated_at TEXT,
  deactivate_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  CHECK (status <> 'approved' OR (verification = 'verified' AND length(trim(COALESCE(source_reference, ''))) > 0))
);
-- one active holiday per calendar and day (an inactive row keeps its history and frees the day)
CREATE UNIQUE INDEX ux_holidays_day ON holidays(calendar_id, holiday_date) WHERE status <> 'inactive';
CREATE INDEX idx_holidays_date ON holidays(holiday_date, status);
CREATE INDEX idx_holidays_year ON holidays(year, calendar_id);
CREATE INDEX idx_holidays_status ON holidays(status);

-- a substitute day (its own holidays row, type 'substitute') given for a holiday that falls on a weekly rest day
CREATE TABLE holiday_substitutions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_holiday_id INTEGER NOT NULL REFERENCES holidays(id),
  substitute_holiday_id INTEGER NOT NULL UNIQUE REFERENCES holidays(id),
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id),
  CHECK (original_holiday_id <> substitute_holiday_id)
);
CREATE INDEX idx_holiday_substitutions_original ON holiday_substitutions(original_holiday_id);

-- hours actually worked on a holiday, backed by evidence and approved by a second person before payroll may use them.
-- The holiday FK makes a referenced holiday impossible to delete; payroll_period_id locks the row once a calculation used it.
CREATE TABLE holiday_work_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  holiday_id INTEGER NOT NULL REFERENCES holidays(id),
  work_date TEXT NOT NULL CHECK (length(work_date) = 10 AND date(work_date) = work_date),
  -- hours inside normal working hours (Normal Holiday Work) and beyond them (Holiday OT)
  normal_hours REAL NOT NULL DEFAULT 0 CHECK (normal_hours >= 0),
  ot_hours REAL NOT NULL DEFAULT 0 CHECK (ot_hours >= 0),
  evidence_source TEXT NOT NULL CHECK (evidence_source IN ('attendance', 'feishu', 'manual')),
  attendance_record_id INTEGER REFERENCES attendance_records(id),
  attendance_import_row_id INTEGER REFERENCES attendance_import_rows(id),
  evidence_ref TEXT,
  -- the approver confirms these hours are not also part of the employee's normal (Feishu / request) OT
  excluded_from_regular_ot INTEGER NOT NULL DEFAULT 0 CHECK (excluded_from_regular_ot IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  note TEXT,
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  review_reason TEXT,
  payroll_period_id INTEGER REFERENCES payroll_periods(id),
  paid_calc_version INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  CHECK (normal_hours + ot_hours > 0 AND normal_hours + ot_hours <= 24),
  CHECK (evidence_source <> 'attendance' OR attendance_record_id IS NOT NULL),
  CHECK (evidence_source <> 'feishu' OR attendance_import_row_id IS NOT NULL),
  CHECK (evidence_source <> 'manual' OR length(trim(COALESCE(evidence_ref, ''))) > 0),
  CHECK (status <> 'approved' OR excluded_from_regular_ot = 1),
  CHECK (payroll_period_id IS NULL OR status = 'approved')
);
-- the same employee-day can never be recorded twice while pending / approved (duplicate attendance rows)
CREATE UNIQUE INDEX ux_holiday_work_day ON holiday_work_records(employee_id, work_date) WHERE status IN ('pending', 'approved');
CREATE INDEX idx_holiday_work_date ON holiday_work_records(work_date, status);
CREATE INDEX idx_holiday_work_holiday ON holiday_work_records(holiday_id);
CREATE INDEX idx_holiday_work_period ON holiday_work_records(payroll_period_id);

-- holiday pay entitlement and multipliers per employment type (company_id NULL = every company); statutory minimums enforced
CREATE TABLE holiday_pay_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies(id),
  employment_type TEXT NOT NULL CHECK (employment_type IN ('permanent', 'contract', 'probation', 'intern')),
  holiday_pay_entitled INTEGER NOT NULL CHECK (holiday_pay_entitled IN (0, 1)),
  -- multiples of the hourly wage paid ON TOP of the monthly salary
  work_multiplier REAL NOT NULL,
  ot_multiplier REAL NOT NULL,
  effective_from TEXT NOT NULL CHECK (date(effective_from) = effective_from),
  effective_to TEXT CHECK (effective_to IS NULL OR date(effective_to) = effective_to),
  legal_basis TEXT NOT NULL CHECK (length(trim(legal_basis)) > 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'inactive')),
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  CHECK (work_multiplier >= CASE WHEN holiday_pay_entitled = 1 THEN 1 ELSE 2 END AND work_multiplier <= 10),
  CHECK (ot_multiplier >= 3 AND ot_multiplier <= 10),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE UNIQUE INDEX ux_holiday_pay_rule ON holiday_pay_rules(IFNULL(company_id, 0), employment_type, effective_from) WHERE status <> 'inactive';
CREATE INDEX idx_holiday_pay_rule_status ON holiday_pay_rules(status, employment_type);

-- the central Thai calendar (no dates)
INSERT INTO holiday_calendars (code, name, country_code, description) VALUES
  ('TH', 'ปฏิทินวันหยุดกลาง · ประเทศไทย', 'TH', 'วันหยุดตามประเพณีและวันแรงงานแห่งชาติ ใช้กับทุกบริษัท (บริษัทเพิ่มวันหยุดของตนเองได้ในปฏิทินบริษัท)');

-- permissions (super_admin holds "*"; hr_admin already holds *.view / *.create / *.update / *.delete / *.export)
INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT r.id, p.value FROM roles r, json_each('["holiday_calendar.approve","holiday_calendar.import"]') p WHERE r.code = 'hr_admin';

INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT r.id, p.value FROM roles r, json_each('["holiday_calendar.view","holiday_calendar.create","holiday_calendar.update","holiday_calendar.import","holiday_calendar.export"]') p WHERE r.code = 'hr_staff';

INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT r.id, p.value FROM roles r, json_each('["holiday_calendar.view","holiday_calendar.export"]') p WHERE r.code = 'payroll_officer';

INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT r.id, p.value FROM roles r, json_each('["holiday_calendar.view"]') p WHERE r.code IN ('hr_manager', 'employee');
