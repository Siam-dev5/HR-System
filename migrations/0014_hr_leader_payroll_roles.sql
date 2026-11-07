-- Two built-in roles: HR Leader (reviews and approves payroll, manages the traditional holiday calendar) and HR
-- Payroll (prepares, calculates and publishes payroll; never approves it). Additive only: two roles and their
-- permission grants; no existing role, permission, user or payroll row is changed. No account is created here.
-- Rollback: scripts/rollback/0014_hr_leader_payroll_roles.down.sql
--
-- Maker-checker: HR Payroll has no payroll.approve and HR Leader has no payroll.calculate, so the person who
-- calculates a period can never be the one who approves it through these roles. Both are privileged (MFA required).

INSERT INTO roles (code, name, description, privileged, system) VALUES
  ('hr_leader', 'HR Leader', 'ตรวจสอบและอนุมัติงวดเงินเดือน และจัดการปฏิทินวันหยุดตามประเพณี (ไม่คำนวณเงินเดือน)', 1, 1),
  ('hr_payroll', 'HR Payroll', 'จัดทำ คำนวณ และเผยแพร่เงินเดือน (ไม่อนุมัติงวดเงินเดือน)', 1, 1);

-- HR Leader: view payroll and approve a calculated period; the holiday calendar (holidays, pay rules, holiday work).
-- employees.all gives organisation-wide company scope (needed for the central traditional calendar and for payroll of
-- every company); without employees.view it does not open the employee records themselves.
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.value FROM roles r, json_each('["dashboard.view","ess.view","payslip.own","workflow.view","security.self","help.view","payroll.view","payroll.approve","payroll_preview.view","employees.all","holiday_calendar.view","holiday_calendar.create","holiday_calendar.update","holiday_calendar.delete","holiday_calendar.approve","holiday_calendar.import","holiday_calendar.export","reports.view"]') p
WHERE r.code = 'hr_leader';

-- HR Payroll: payroll processing (create / calculate / reopen a calculated period / publish / export) and the data it
-- needs; no payroll.approve, no Super Admin period overrides (payroll.period.*), no workflow approvals
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.value FROM roles r, json_each('["dashboard.view","ess.view","payslip.own","workflow.view","security.self","help.view","payroll.view","payroll.calculate","payroll.publish","payroll.export","payroll_preview.view","payroll_preview.export","pay_components.view","employee_pay_items.view","employee_pay_items.create","employee_pay_items.update","employee_pay_items.export","employee_pay_items.sensitive","employees.view","employees.all","employees.sensitive","attendance_import.view","attendance_import.create","attendance_import.update","ot_review.view","ot_review.update","holiday_calendar.view","reports.view","reports.export"]') p
WHERE r.code = 'hr_payroll';
