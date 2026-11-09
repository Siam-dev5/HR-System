-- Two built-in roles for the Accounting & Finance department (ACC): ACC Staff and ACC Manager review employee and
-- payroll data of every company in the group, read-only. Additive only: two roles and their permission grants; no
-- existing role, permission, user, employee or payroll row is changed. No account is created here.
-- Rollback: scripts/rollback/0016_acc_readonly_roles.down.sql
--
-- Design (so a future App Management screen can manage it):
-- * the role is the job function; company scope is a separate grant (employees.all = every company, resolved from the
--   companies table at request time, never a hard-coded list); view / export / sensitive are separate permissions;
-- * no wildcard, no create / update / delete / approve / publish / calculate / import permission, no payroll.period.*,
--   no users / roles / settings (those stay with the super_admin role itself);
-- * employees.sensitive is NOT granted: it unmasks bank account and tax ID together with base salary. Salary amounts
--   come from salary_history.sensitive, employee_pay_items.sensitive and the payslips (payroll.view) instead;
-- * payroll.export is NOT granted (its CSV carries bank accounts); ACC Manager may export the Payroll Preview, whose
--   columns never include bank or ID data;
-- * both roles are privileged, so MFA enrolment is enforced (security.mfa_enforce_privileged).
-- ACC has no review / sign-off step in the payroll workflow yet; that is a separate, later change.

INSERT INTO roles (code, name, description, privileged, system) VALUES
  ('acc_staff', 'ACC Staff', 'ฝ่ายบัญชีการเงิน: ตรวจสอบข้อมูลพนักงานและเงินเดือนของทุกบริษัทในเครือ (อ่านอย่างเดียว ไม่คำนวณ อนุมัติ หรือเผยแพร่เงินเดือน)', 1, 1),
  ('acc_manager', 'ACC Manager', 'หัวหน้าฝ่ายบัญชีการเงิน: ตรวจสอบข้อมูลพนักงานและเงินเดือนของทุกบริษัทในเครือ และ Export Payroll Preview (อ่านอย่างเดียว ไม่คำนวณ อนุมัติ หรือเผยแพร่เงินเดือน)', 1, 1);

-- ACC Staff: read-only review of employees, payroll, pay items, salary history and the attendance data payroll uses
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.value FROM roles r, json_each('["dashboard.view","help.view","security.self","employees.view","employees.all","payroll.view","payroll_preview.view","payslip_ytd.view","pay_components.view","employee_pay_items.view","employee_pay_items.sensitive","salary_history.view","salary_history.sensitive","attendance.view","attendance.all","leave.view","leave.all","overtime.view","overtime.all","attendance_import.view","ot_review.view","leave_import.view","overtime_import.view","attendance_file.view","attendance_exemption.view","holiday_calendar.view","reports.view"]') p
WHERE r.code = 'acc_staff';

-- ACC Manager: the same, plus exporting the Payroll Preview (CSV / XLSX)
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.value FROM roles r, json_each('["dashboard.view","help.view","security.self","employees.view","employees.all","payroll.view","payroll_preview.view","payroll_preview.export","payslip_ytd.view","pay_components.view","employee_pay_items.view","employee_pay_items.sensitive","salary_history.view","salary_history.sensitive","attendance.view","attendance.all","leave.view","leave.all","overtime.view","overtime.all","attendance_import.view","ot_review.view","leave_import.view","overtime_import.view","attendance_file.view","attendance_exemption.view","holiday_calendar.view","reports.view"]') p
WHERE r.code = 'acc_manager';
