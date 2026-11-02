-- Self-registration (pending approval) and the HR Staff role.

-- approved: normal account · pending: self-registered, waiting for a Super Admin · rejected: registration declined
ALTER TABLE users ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'approved' CHECK (approval_status IN ('approved', 'pending', 'rejected'));
-- employee code typed by the registrant; only a hint for the approving Super Admin, never trusted
ALTER TABLE users ADD COLUMN requested_employee_code TEXT;
CREATE INDEX idx_users_approval ON users(approval_status);

UPDATE roles SET name = 'Manager (หัวหน้างาน / ผู้อนุมัติ)', description = 'อนุมัติคำขอและดูข้อมูลบุคลากรในความรับผิดชอบ' WHERE code = 'hr_manager';

INSERT INTO roles (code, name, description, privileged, system) VALUES
  ('hr_staff', 'HR Staff', 'งานปฏิบัติการ HR (ไม่รวมเงินเดือน ข้อมูลอ่อนไหว และการจัดการสิทธิ์)', 0, 1);

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.value FROM roles r, json_each('["dashboard.view","ess.view","payslip.own","workflow.view","security.self","help.view","analytics.view","reports.view","departments.view","positions.view","companies.view","branches.view","shifts.view","leave_types.view","employees.view","employees.create","employees.update","employees.all","employees.export","onboarding.*","offboarding.*","manpower.view","requisitions.*","candidates.*","attendance.view","attendance.create","attendance.update","attendance.all","shift_assignments.*","time_corrections.view","time_corrections.create","time_corrections.all","overtime.view","overtime.create","overtime.all","leave.view","leave.create","leave.all","performance_cycles.view","performance.view","performance.all","competencies.view","skills.view","employee_skills.*","training_needs.*","courses.*","training.*","training_enrollments.*","ojt.*","idp.*","career_paths.view","documents.view","documents.create","documents.update","documents.all","pdpa.view","pdpa.create","pdpa.update"]') p
WHERE r.code = 'hr_staff';

INSERT INTO settings (key, value, type, description) VALUES
  ('security.self_registration', 'true', 'bool', 'เปิดให้ลงทะเบียนด้วยตนเอง (บัญชีใหม่ไม่มีบทบาทจนกว่า Super Admin จะอนุมัติ)'),
  ('security.registration_limit_per_hour', '5', 'number', 'จำนวนคำขอลงทะเบียนสูงสุดต่อ IP ต่อชั่วโมง');
