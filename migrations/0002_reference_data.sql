-- Reference data required by the application (no personal data, no credentials).

INSERT INTO roles (code, name, description, privileged, system) VALUES
  ('super_admin', 'Super Admin', 'ทุกสิทธิ์ในระบบ', 1, 1),
  ('hr_admin', 'HR Admin', 'จัดการข้อมูล HR ทุกโมดูล (ไม่รวมการจ่ายเงินเดือนและการจัดการผู้ใช้)', 1, 1),
  ('hr_manager', 'HR Manager / ผู้อนุมัติ', 'อนุมัติคำขอและดูข้อมูลบุคลากร', 0, 1),
  ('payroll_officer', 'Payroll Officer', 'คำนวณ อนุมัติ และเผยแพร่เงินเดือน', 1, 1),
  ('employee', 'พนักงาน', 'บริการตนเอง (ESS)', 0, 1);

-- Permission patterns: "*" = all, "<resource>.*", "*.<action>"
INSERT INTO role_permissions (role_id, permission)
SELECT id, '*' FROM roles WHERE code = 'super_admin';

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.value FROM roles r, json_each('["dashboard.view","ess.view","payslip.own","analytics.view","workflow.view","workflow.approve","talent.view","reports.view","reports.export","audit.view","security.self","help.view","*.view","*.create","*.update","*.delete","*.export","*.all","*.sensitive"]') p
WHERE r.code = 'hr_admin';

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.value FROM roles r, json_each('["dashboard.view","ess.view","payslip.own","analytics.view","workflow.view","workflow.approve","talent.view","talent_assessments.*","performance.*","performance_cycles.view","reports.view","security.self","help.view","employees.view","employees.all","departments.view","positions.view","leave.view","leave.all","overtime.view","overtime.all","time_corrections.view","time_corrections.all","attendance.view","attendance.all","documents.view"]') p
WHERE r.code = 'hr_manager';

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.value FROM roles r, json_each('["dashboard.view","ess.view","payslip.own","workflow.view","security.self","help.view","payroll.*","pay_components.*","employee_pay_items.*","employees.view","employees.all","employees.sensitive","employees.export","reports.view","reports.export","documents.view"]') p
WHERE r.code = 'payroll_officer';

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.value FROM roles r, json_each('["dashboard.view","ess.view","payslip.own","workflow.view","security.self","help.view","employees.view","leave.view","leave.create","overtime.view","overtime.create","time_corrections.view","time_corrections.create","attendance.view","documents.view","idp.view","ojt.view","training_enrollments.view","performance.view","employee_skills.view"]') p
WHERE r.code = 'employee';

INSERT INTO settings (key, value, type, description) VALUES
  ('security.mfa_enforce_privileged', 'true', 'bool', 'บังคับ MFA สำหรับบทบาทสิทธิ์สูง (Super Admin, HR Admin, Payroll Officer)'),
  ('security.lockout_threshold', '5', 'number', 'ล็อกบัญชีเมื่อใส่รหัสผ่านผิดติดต่อกัน (ครั้ง)'),
  ('security.lockout_minutes', '15', 'number', 'ระยะเวลาล็อกบัญชี (นาที)'),
  ('security.session_hours', '12', 'number', 'อายุ session (ชั่วโมง)'),
  ('security.password_min_length', '12', 'number', 'ความยาวรหัสผ่านขั้นต่ำ'),
  ('payroll.sso_rate', '0.05', 'number', 'อัตราเงินสมทบประกันสังคม (ฝ่ายลูกจ้าง)'),
  ('payroll.sso_min_wage', '1650', 'number', 'ฐานค่าจ้างต่ำสุดสำหรับประกันสังคม'),
  ('payroll.sso_max_wage', '15000', 'number', 'ฐานค่าจ้างสูงสุดสำหรับประกันสังคม'),
  ('payroll.ot_divisor_days', '30', 'number', 'จำนวนวันหารเงินเดือนเพื่อคิดค่าจ้างรายวัน'),
  ('payroll.hours_per_day', '8', 'number', 'ชั่วโมงทำงานต่อวัน (คิดค่าล่วงเวลา)'),
  ('payroll.require_separate_approver', 'true', 'bool', 'ผู้อนุมัติงวดเงินเดือนต้องไม่ใช่ผู้คำนวณ'),
  ('attendance.default_start_time', '09:00', 'text', 'เวลาเข้างานเริ่มต้น (ใช้เมื่อไม่มีการกำหนดกะ)'),
  ('org.display_name', 'HR System', 'text', 'ชื่อองค์กรที่แสดงบนสลิปและรายงาน');

INSERT INTO leave_types (code, name, days_per_year, paid) VALUES
  ('ANNUAL', 'ลาพักร้อน', 6, 1),
  ('SICK', 'ลาป่วย', 30, 1),
  ('PERSONAL', 'ลากิจ', 3, 1),
  ('UNPAID', 'ลาไม่รับค่าจ้าง', 30, 0);

INSERT INTO pay_components (code, name, kind, taxable, active) VALUES
  ('POS_ALLOW', 'ค่าตำแหน่ง', 'earning', 1, 1),
  ('TRAVEL', 'ค่าเดินทาง', 'earning', 1, 1),
  ('MEAL', 'ค่าอาหาร', 'earning', 1, 1),
  ('LOAN', 'หักเงินกู้สวัสดิการ', 'deduction', 0, 1),
  ('PVD', 'กองทุนสำรองเลี้ยงชีพ', 'deduction', 0, 1);

INSERT INTO workflow_definitions (type, step, name, approver_role_id)
SELECT t.value, 1, 'หัวหน้า / HR Manager อนุมัติ', r.id
FROM roles r, json_each('["leave","overtime","time_correction"]') t
WHERE r.code = 'hr_manager';
