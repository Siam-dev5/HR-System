-- HR System initial schema (Cloudflare D1 / SQLite).
-- Module tables below the "Module tables" marker mirror src/shared/modules.ts; an integration test
-- verifies every registry field exists here.

-- ===== Identity & access =====================================================================
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  email TEXT,
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  mfa_enabled INTEGER NOT NULL DEFAULT 0,
  mfa_secret_enc TEXT,
  last_login_at TEXT,
  password_changed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  privileged INTEGER NOT NULL DEFAULT 0,
  system INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE role_permissions (
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (role_id, permission)
);

CREATE TABLE user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

-- id = SHA-256 of the session token; the raw token only lives in the HttpOnly cookie.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mfa_pending INTEGER NOT NULL DEFAULT 0,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('bool', 'number', 'text')),
  description TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER
);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER,
  username TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  details TEXT,
  ip TEXT
);
CREATE INDEX idx_audit_at ON audit_logs(at);
CREATE INDEX idx_audit_entity ON audit_logs(entity, entity_id);

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT,
  -- app path ("/leave") or absolute http(s) URL; resolved by src/shared/links.ts
  link TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_notifications_user ON notifications(user_id, read_at);

-- ===== Workflow ==============================================================================
CREATE TABLE workflow_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  ref_table TEXT NOT NULL,
  ref_id INTEGER NOT NULL,
  module_key TEXT NOT NULL,
  requester_user_id INTEGER NOT NULL REFERENCES users(id),
  employee_id INTEGER REFERENCES employees(id),
  current_step INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (ref_table, ref_id)
);
CREATE INDEX idx_workflow_status ON workflow_requests(status, type, current_step);

CREATE TABLE workflow_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES workflow_requests(id) ON DELETE CASCADE,
  step INTEGER NOT NULL,
  actor_user_id INTEGER NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'cancelled')),
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===== Payroll ===============================================================================
CREATE TABLE payroll_periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  pay_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'calculated', 'approved', 'published')),
  calculated_by INTEGER REFERENCES users(id),
  calculated_at TEXT,
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  published_by INTEGER REFERENCES users(id),
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER,
  CHECK (start_date <= end_date)
);

CREATE TABLE payslips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id INTEGER NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  base_salary REAL NOT NULL,
  ot_amount REAL NOT NULL DEFAULT 0,
  earnings REAL NOT NULL DEFAULT 0,
  unpaid_leave REAL NOT NULL DEFAULT 0,
  gross REAL NOT NULL,
  sso REAL NOT NULL DEFAULT 0,
  tax REAL NOT NULL DEFAULT 0,
  deductions REAL NOT NULL DEFAULT 0,
  net REAL NOT NULL,
  lines_json TEXT NOT NULL,
  published INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (period_id, employee_id)
);
CREATE INDEX idx_payslips_employee ON payslips(employee_id, published);

-- ===== Module tables (generated from src/shared/modules.ts) ==================================
-- หน่วยงาน
CREATE TABLE departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  parent_id INTEGER REFERENCES departments(id),
  cost_center_id INTEGER REFERENCES cost_centers(id),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
CREATE INDEX idx_departments_company_id ON departments(company_id);
CREATE INDEX idx_departments_parent_id ON departments(parent_id);
CREATE INDEX idx_departments_cost_center_id ON departments(cost_center_id);
-- Job & Position
CREATE TABLE positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  department_id INTEGER REFERENCES departments(id),
  job_grade TEXT,
  headcount REAL,
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
CREATE INDEX idx_positions_department_id ON positions(department_id);
-- พนักงาน
CREATE TABLE employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  emp_code TEXT NOT NULL UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  branch_id INTEGER REFERENCES branches(id),
  department_id INTEGER REFERENCES departments(id),
  position_id INTEGER REFERENCES positions(id),
  manager_id INTEGER REFERENCES employees(id),
  hire_date TEXT NOT NULL,
  probation_end TEXT,
  employment_type TEXT NOT NULL,
  status TEXT NOT NULL,
  base_salary REAL,
  bank_name TEXT,
  bank_account TEXT,
  tax_id TEXT,
  user_id INTEGER UNIQUE REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
CREATE INDEX idx_employees_company_id ON employees(company_id);
CREATE INDEX idx_employees_branch_id ON employees(branch_id);
CREATE INDEX idx_employees_department_id ON employees(department_id);
CREATE INDEX idx_employees_position_id ON employees(position_id);
CREATE INDEX idx_employees_manager_id ON employees(manager_id);
-- Onboarding
CREATE TABLE onboarding_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  start_date TEXT NOT NULL,
  buddy_employee_id INTEGER REFERENCES employees(id),
  checklist TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
CREATE INDEX idx_onboarding_cases_employee_id ON onboarding_cases(employee_id);
CREATE INDEX idx_onboarding_cases_buddy_employee_id ON onboarding_cases(buddy_employee_id);
-- Offboarding
CREATE TABLE offboarding_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  last_day TEXT NOT NULL,
  reason TEXT NOT NULL,
  exit_interview TEXT,
  clearance_status TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
CREATE INDEX idx_offboarding_cases_employee_id ON offboarding_cases(employee_id);
-- อัตรากำลัง
CREATE TABLE manpower_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year REAL NOT NULL,
  department_id INTEGER NOT NULL REFERENCES departments(id),
  position_id INTEGER REFERENCES positions(id),
  approved_headcount REAL NOT NULL,
  current_headcount REAL NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
CREATE INDEX idx_manpower_plans_department_id ON manpower_plans(department_id);
CREATE INDEX idx_manpower_plans_position_id ON manpower_plans(position_id);
-- สรรหา (ATS)
CREATE TABLE requisitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  position_id INTEGER REFERENCES positions(id),
  department_id INTEGER REFERENCES departments(id),
  openings REAL NOT NULL,
  opened_date TEXT,
  status TEXT NOT NULL,
  recruiter_employee_id INTEGER REFERENCES employees(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
CREATE INDEX idx_requisitions_position_id ON requisitions(position_id);
CREATE INDEX idx_requisitions_department_id ON requisitions(department_id);
CREATE INDEX idx_requisitions_recruiter_employee_id ON requisitions(recruiter_employee_id);
-- ผู้สมัคร
CREATE TABLE candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requisition_id INTEGER NOT NULL REFERENCES requisitions(id),
  full_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  source TEXT,
  stage TEXT NOT NULL,
  pdpa_consent_until TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
CREATE INDEX idx_candidates_requisition_id ON candidates(requisition_id);
-- เวลาทำงาน
CREATE TABLE attendance_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  work_date TEXT NOT NULL,
  clock_in TEXT,
  clock_out TEXT,
  status TEXT NOT NULL,
  source TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
CREATE INDEX idx_attendance_records_employee_id ON attendance_records(employee_id);
-- กะการทำงาน
CREATE TABLE shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  break_minutes REAL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
-- ตารางกะพนักงาน
CREATE TABLE shift_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  start_date TEXT NOT NULL,
  end_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
CREATE INDEX idx_shift_assignments_employee_id ON shift_assignments(employee_id);
CREATE INDEX idx_shift_assignments_shift_id ON shift_assignments(shift_id);
-- แก้ไขเวลา
CREATE TABLE time_corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  work_date TEXT NOT NULL,
  clock_in TEXT,
  clock_out TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
CREATE INDEX idx_time_corrections_employee_id ON time_corrections(employee_id);
-- คำขอ OT
CREATE TABLE overtime_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  work_date TEXT NOT NULL,
  hours REAL NOT NULL,
  rate TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
CREATE INDEX idx_overtime_requests_employee_id ON overtime_requests(employee_id);
-- การลา
CREATE TABLE leave_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  leave_type_id INTEGER NOT NULL REFERENCES leave_types(id),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  days REAL NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
CREATE INDEX idx_leave_requests_employee_id ON leave_requests(employee_id);
CREATE INDEX idx_leave_requests_leave_type_id ON leave_requests(leave_type_id);
-- รอบประเมิน
CREATE TABLE performance_cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
-- ประเมินผล (KPI/OKR)
CREATE TABLE performance_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id INTEGER NOT NULL REFERENCES performance_cycles(id),
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  reviewer_employee_id INTEGER REFERENCES employees(id),
  kpi_score REAL,
  okr_progress REAL,
  rating TEXT,
  comment TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
CREATE INDEX idx_performance_reviews_cycle_id ON performance_reviews(cycle_id);
CREATE INDEX idx_performance_reviews_employee_id ON performance_reviews(employee_id);
CREATE INDEX idx_performance_reviews_reviewer_employee_id ON performance_reviews(reviewer_employee_id);
-- ประเมิน Talent
CREATE TABLE talent_assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id INTEGER NOT NULL REFERENCES performance_cycles(id),
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  performance REAL NOT NULL,
  potential REAL NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
CREATE INDEX idx_talent_assessments_cycle_id ON talent_assessments(cycle_id);
CREATE INDEX idx_talent_assessments_employee_id ON talent_assessments(employee_id);
-- Competency
CREATE TABLE competencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  max_level REAL,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
-- ทักษะ
CREATE TABLE skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
-- Skill Matrix & Gap
CREATE TABLE employee_skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  skill_id INTEGER NOT NULL REFERENCES skills(id),
  current_level REAL NOT NULL,
  required_level REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
CREATE INDEX idx_employee_skills_employee_id ON employee_skills(employee_id);
CREATE INDEX idx_employee_skills_skill_id ON employee_skills(skill_id);
-- Training Need (TNA)
CREATE TABLE training_needs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  competency_id INTEGER REFERENCES competencies(id),
  course_id INTEGER REFERENCES courses(id),
  year REAL NOT NULL,
  priority TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
CREATE INDEX idx_training_needs_employee_id ON training_needs(employee_id);
CREATE INDEX idx_training_needs_competency_id ON training_needs(competency_id);
CREATE INDEX idx_training_needs_course_id ON training_needs(course_id);
-- หลักสูตร
CREATE TABLE courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  provider TEXT,
  hours REAL,
  cost REAL,
  mode TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
-- อบรม / LMS
CREATE TABLE training_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id),
  start_date TEXT NOT NULL,
  end_date TEXT,
  location TEXT,
  capacity REAL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
CREATE INDEX idx_training_sessions_course_id ON training_sessions(course_id);
-- ผู้เข้าอบรม
CREATE TABLE training_enrollments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES training_sessions(id),
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  status TEXT NOT NULL,
  score REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
CREATE INDEX idx_training_enrollments_session_id ON training_enrollments(session_id);
CREATE INDEX idx_training_enrollments_employee_id ON training_enrollments(employee_id);
-- OJT
CREATE TABLE ojt_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  mentor_employee_id INTEGER REFERENCES employees(id),
  topic TEXT NOT NULL,
  start_date TEXT,
  end_date TEXT,
  progress REAL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
CREATE INDEX idx_ojt_assignments_employee_id ON ojt_assignments(employee_id);
CREATE INDEX idx_ojt_assignments_mentor_employee_id ON ojt_assignments(mentor_employee_id);
-- IDP
CREATE TABLE idps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  year REAL NOT NULL,
  goal TEXT NOT NULL,
  actions TEXT,
  target_date TEXT,
  progress REAL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
CREATE INDEX idx_idps_employee_id ON idps(employee_id);
-- Career Path
CREATE TABLE career_paths (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  from_position_id INTEGER NOT NULL REFERENCES positions(id),
  to_position_id INTEGER NOT NULL REFERENCES positions(id),
  min_years REAL,
  requirements TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
CREATE INDEX idx_career_paths_from_position_id ON career_paths(from_position_id);
CREATE INDEX idx_career_paths_to_position_id ON career_paths(to_position_id);
-- Organization Design
CREATE TABLE org_design_scenarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  effective_date TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
-- Workforce Planning
CREATE TABLE workforce_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year REAL NOT NULL,
  department_id INTEGER NOT NULL REFERENCES departments(id),
  position_id INTEGER REFERENCES positions(id),
  demand REAL NOT NULL,
  supply REAL NOT NULL,
  action TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
CREATE INDEX idx_workforce_plans_department_id ON workforce_plans(department_id);
CREATE INDEX idx_workforce_plans_position_id ON workforce_plans(position_id);
-- Engagement & eNPS
CREATE TABLE surveys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  open_date TEXT,
  close_date TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
-- คำตอบแบบสำรวจ
CREATE TABLE survey_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  survey_id INTEGER NOT NULL REFERENCES surveys(id),
  score REAL NOT NULL,
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
CREATE INDEX idx_survey_responses_survey_id ON survey_responses(survey_id);
-- OD Projects
CREATE TABLE od_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  owner_employee_id INTEGER REFERENCES employees(id),
  start_date TEXT,
  end_date TEXT,
  budget REAL,
  progress REAL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
CREATE INDEX idx_od_projects_owner_employee_id ON od_projects(owner_employee_id);
-- รายการเงินได้/เงินหัก
CREATE TABLE pay_components (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  taxable INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
-- เงินได้/เงินหักประจำ
CREATE TABLE employee_pay_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  component_id INTEGER NOT NULL REFERENCES pay_components(id),
  amount REAL NOT NULL,
  start_date TEXT,
  end_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
CREATE INDEX idx_employee_pay_items_employee_id ON employee_pay_items(employee_id);
CREATE INDEX idx_employee_pay_items_component_id ON employee_pay_items(component_id);
-- บริษัท
CREATE TABLE companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  tax_id TEXT,
  address TEXT,
  phone TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
-- สาขา
CREATE TABLE branches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  address TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
CREATE INDEX idx_branches_company_id ON branches(company_id);
-- Cost Center
CREATE TABLE cost_centers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
CREATE INDEX idx_cost_centers_company_id ON cost_centers(company_id);
-- ประเภทการลา
CREATE TABLE leave_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  days_per_year REAL NOT NULL,
  paid INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
-- Workflow Engine
CREATE TABLE workflow_definitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  step REAL NOT NULL,
  name TEXT NOT NULL,
  approver_role_id INTEGER NOT NULL REFERENCES roles(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
CREATE INDEX idx_workflow_definitions_approver_role_id ON workflow_definitions(approver_role_id);
-- เอกสาร
CREATE TABLE documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  employee_id INTEGER REFERENCES employees(id),
  url TEXT,
  effective_date TEXT,
  confidential INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
CREATE INDEX idx_documents_employee_id ON documents(employee_id);
-- PDPA
CREATE TABLE pdpa_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_name TEXT NOT NULL,
  employee_id INTEGER REFERENCES employees(id),
  type TEXT NOT NULL,
  received_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  updated_by INTEGER
);
CREATE INDEX idx_pdpa_requests_employee_id ON pdpa_requests(employee_id);

-- Business constraints on module tables
CREATE UNIQUE INDEX ux_attendance_employee_day ON attendance_records(employee_id, work_date);
CREATE UNIQUE INDEX ux_employee_skill ON employee_skills(employee_id, skill_id);
CREATE UNIQUE INDEX ux_talent_cycle_employee ON talent_assessments(cycle_id, employee_id);
CREATE UNIQUE INDEX ux_workflow_def_step ON workflow_definitions(type, step);
CREATE INDEX idx_employees_status ON employees(status);
CREATE INDEX idx_leave_dates ON leave_requests(start_date, end_date);
