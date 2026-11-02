-- Fictional demo data for evaluation and automated tests. Not applied by migrations.
-- Apply with: wrangler d1 execute hr-system-db --local --file seeds/demo.sql

INSERT INTO companies (code, name, tax_id, address, phone, active) VALUES
  ('DEMO', 'บริษัท เดโม่ เอชอาร์ จำกัด', '0105500000001', 'กรุงเทพมหานคร', '02-000-0000', 1);

INSERT INTO branches (company_id, code, name, address, active) VALUES
  (1, 'HQ', 'สำนักงานใหญ่', 'กรุงเทพมหานคร', 1),
  (1, 'CNX', 'สาขาเชียงใหม่', 'เชียงใหม่', 1);

INSERT INTO cost_centers (company_id, code, name, active) VALUES
  (1, 'CC-ADM', 'บริหาร', 1),
  (1, 'CC-OPS', 'ปฏิบัติการ', 1);

INSERT INTO departments (code, name, company_id, parent_id, cost_center_id, active) VALUES
  ('EXE', 'สำนักกรรมการผู้จัดการ', 1, NULL, 1, 1),
  ('HR', 'ฝ่ายทรัพยากรบุคคล', 1, 1, 1, 1),
  ('IT', 'ฝ่ายเทคโนโลยีสารสนเทศ', 1, 1, 1, 1),
  ('OPS', 'ฝ่ายปฏิบัติการ', 1, 1, 2, 1),
  ('OPS-PRD', 'แผนกผลิต', 1, 4, 2, 1);

INSERT INTO positions (code, title, department_id, job_grade, headcount, description, active) VALUES
  ('P-MD', 'กรรมการผู้จัดการ', 1, 'M5', 1, NULL, 1),
  ('P-HRM', 'ผู้จัดการฝ่ายบุคคล', 2, 'M3', 1, NULL, 1),
  ('P-HRO', 'เจ้าหน้าที่บุคคล', 2, 'S2', 2, NULL, 1),
  ('P-DEV', 'นักพัฒนาซอฟต์แวร์', 3, 'S3', 3, NULL, 1),
  ('P-SUP', 'หัวหน้างานผลิต', 5, 'S4', 1, NULL, 1),
  ('P-OPR', 'พนักงานผลิต', 5, 'O1', 6, NULL, 1);

INSERT INTO employees (emp_code, first_name, last_name, email, phone, company_id, branch_id, department_id, position_id, manager_id, hire_date, probation_end, employment_type, status, base_salary, bank_name, bank_account, tax_id) VALUES
  ('E001', 'สมชาย', 'ตัวอย่าง', 'e001@example.com', NULL, 1, 1, 1, 1, NULL, '2018-01-02', NULL, 'permanent', 'active', 150000, 'ธนาคารเดโม่', '000-0-00001-0', '1000000000011'),
  ('E002', 'สมหญิง', 'ทดสอบ', 'e002@example.com', NULL, 1, 1, 2, 2, 1, '2019-03-01', NULL, 'permanent', 'active', 85000, 'ธนาคารเดโม่', '000-0-00002-0', '1000000000022'),
  ('E003', 'วิชัย', 'สมมุติ', 'e003@example.com', NULL, 1, 1, 2, 3, 2, '2022-06-01', NULL, 'permanent', 'active', 32000, 'ธนาคารเดโม่', '000-0-00003-0', '1000000000033'),
  ('E004', 'กานดา', 'ตัวอย่าง', 'e004@example.com', NULL, 1, 1, 3, 4, 1, '2021-09-15', NULL, 'permanent', 'active', 55000, 'ธนาคารเดโม่', '000-0-00004-0', '1000000000044'),
  ('E005', 'ประเสริฐ', 'ทดลอง', 'e005@example.com', NULL, 1, 2, 5, 5, 1, '2017-05-01', NULL, 'permanent', 'active', 28000, 'ธนาคารเดโม่', '000-0-00005-0', '1000000000055'),
  ('E006', 'มาลี', 'สมมุติ', 'e006@example.com', NULL, 1, 2, 5, 6, 5, '2026-09-01', '2026-11-29', 'probation', 'probation', 14000, 'ธนาคารเดโม่', '000-0-00006-0', '1000000000066'),
  ('E007', 'ธนา', 'ทดสอบ', 'e007@example.com', NULL, 1, 2, 5, 6, 5, '2023-02-01', NULL, 'permanent', 'active', 16500, 'ธนาคารเดโม่', '000-0-00007-0', '1000000000077'),
  ('E008', 'อรุณ', 'ตัวอย่าง', 'e008@example.com', NULL, 1, 1, 3, 4, 4, '2020-01-06', NULL, 'contract', 'resigned', 48000, 'ธนาคารเดโม่', '000-0-00008-0', '1000000000088');

INSERT INTO shifts (code, name, start_time, end_time, break_minutes, active) VALUES
  ('DAY', 'กะปกติ', '09:00', '18:00', 60, 1),
  ('MORN', 'กะเช้า (ผลิต)', '07:00', '16:00', 60, 1);
INSERT INTO shift_assignments (employee_id, shift_id, start_date, end_date) VALUES
  (5, 2, '2026-01-01', NULL), (6, 2, '2026-09-01', NULL), (7, 2, '2026-01-01', NULL);

INSERT INTO attendance_records (employee_id, work_date, clock_in, clock_out, status, source, note) VALUES
  (3, '2026-10-30', '08:52', '18:05', 'present', 'device', NULL),
  (4, '2026-10-30', '09:21', '18:30', 'late', 'device', NULL),
  (5, '2026-10-30', '06:55', '16:02', 'present', 'device', NULL),
  (7, '2026-10-30', '07:10', '19:00', 'late', 'device', NULL);

INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days, reason, status) VALUES
  (3, 1, '2026-10-20', '2026-10-21', 2, 'พักผ่อน', 'approved'),
  (7, 4, '2026-10-27', '2026-10-27', 1, 'ธุระส่วนตัว', 'approved');
INSERT INTO overtime_requests (employee_id, work_date, hours, rate, reason, status) VALUES
  (7, '2026-10-30', 3, '1.5', 'งานผลิตเร่งด่วน', 'approved'),
  (5, '2026-10-30', 2, '1.5', 'ตรวจเครื่องจักร', 'approved');

INSERT INTO performance_cycles (code, name, start_date, end_date, status) VALUES
  ('PC-2026H2', 'รอบประเมินครึ่งปีหลัง 2569', '2026-07-01', '2026-12-31', 'active');
INSERT INTO performance_reviews (cycle_id, employee_id, reviewer_employee_id, kpi_score, okr_progress, rating, comment, status) VALUES
  (1, 3, 2, 4.2, 80, '4', NULL, 'submitted'),
  (1, 4, 1, 3.6, 70, '3', NULL, 'submitted'),
  (1, 5, 1, 4.6, 90, '5', NULL, 'calibrated'),
  (1, 7, 5, 2.8, 50, '2', NULL, 'submitted');
INSERT INTO talent_assessments (cycle_id, employee_id, performance, potential, note) VALUES
  (1, 2, 3, 3, NULL), (1, 3, 2, 3, NULL), (1, 4, 2, 2, NULL), (1, 5, 3, 2, NULL), (1, 7, 1, 2, NULL);

INSERT INTO competencies (code, name, category, max_level, description) VALUES
  ('C-COMM', 'การสื่อสาร', 'core', 5, NULL), ('C-LEAD', 'ภาวะผู้นำ', 'managerial', 5, NULL), ('C-DATA', 'การวิเคราะห์ข้อมูล', 'functional', 5, NULL);
INSERT INTO skills (code, name, category) VALUES
  ('S-EXCEL', 'Excel ขั้นสูง', 'Office'), ('S-SQL', 'SQL', 'Data'), ('S-SAFETY', 'ความปลอดภัยในการทำงาน', 'Operation');
INSERT INTO employee_skills (employee_id, skill_id, current_level, required_level) VALUES
  (3, 1, 3, 4), (4, 2, 4, 4), (5, 3, 4, 5), (7, 3, 2, 4);
INSERT INTO courses (code, name, provider, hours, cost, mode) VALUES
  ('CR-SAFE', 'ความปลอดภัยในโรงงาน', 'ภายใน', 6, 0, 'classroom'), ('CR-DATA', 'Data Literacy', 'ภายนอก', 12, 4500, 'online');
INSERT INTO training_needs (employee_id, competency_id, course_id, year, priority, status) VALUES
  (7, NULL, 1, 2026, 'high', 'planned'), (3, 3, 2, 2026, 'medium', 'identified');
INSERT INTO training_sessions (course_id, start_date, end_date, location, capacity, status) VALUES
  (1, '2026-11-15', '2026-11-15', 'ห้องประชุม 1', 20, 'open');
INSERT INTO training_enrollments (session_id, employee_id, status, score) VALUES (1, 7, 'enrolled', NULL), (1, 6, 'enrolled', NULL);
INSERT INTO ojt_assignments (employee_id, mentor_employee_id, topic, start_date, end_date, progress, status) VALUES
  (6, 5, 'การควบคุมเครื่องจักรสายการผลิต', '2026-09-01', '2026-11-30', 60, 'in_progress');
INSERT INTO idps (employee_id, year, goal, actions, target_date, progress, status) VALUES
  (3, 2026, 'เตรียมพร้อมเป็นหัวหน้างานบุคคล', 'อบรมภาวะผู้นำ, โครงการพัฒนาระบบ HR', '2026-12-31', 40, 'active');
INSERT INTO career_paths (name, from_position_id, to_position_id, min_years, requirements) VALUES
  ('เจ้าหน้าที่บุคคล → ผู้จัดการฝ่ายบุคคล', 3, 2, 5, 'ผ่านการประเมิน 4 ขึ้นไป 2 รอบติด'),
  ('พนักงานผลิต → หัวหน้างานผลิต', 6, 5, 3, 'ผ่านหลักสูตรความปลอดภัย');

INSERT INTO org_design_scenarios (code, name, description, effective_date, status) VALUES
  ('OD-2027', 'ปรับโครงสร้างฝ่ายปฏิบัติการ 2570', 'แยกแผนกซ่อมบำรุงออกจากแผนกผลิต', '2027-01-01', 'review');
INSERT INTO workforce_plans (year, department_id, position_id, demand, supply, action) VALUES
  (2027, 5, 6, 8, 6, 'สรรหาเพิ่ม 2 อัตรา'), (2027, 3, 4, 4, 3, 'สรรหาเพิ่ม 1 อัตรา');
INSERT INTO manpower_plans (year, department_id, position_id, approved_headcount, current_headcount, note) VALUES
  (2026, 5, 6, 6, 3, NULL), (2026, 3, 4, 3, 2, NULL), (2026, 2, 3, 2, 1, NULL);
INSERT INTO requisitions (code, title, position_id, department_id, openings, opened_date, status, recruiter_employee_id) VALUES
  ('JR-2026-001', 'พนักงานผลิต', 6, 5, 3, '2026-09-15', 'open', 3),
  ('JR-2026-002', 'นักพัฒนาซอฟต์แวร์', 4, 3, 1, '2026-10-01', 'open', 3);
INSERT INTO candidates (requisition_id, full_name, email, phone, source, stage, pdpa_consent_until, note) VALUES
  (1, 'ผู้สมัคร ตัวอย่างหนึ่ง', 'cand1@example.com', NULL, 'jobboard', 'interview', '2027-09-15', NULL),
  (1, 'ผู้สมัคร ตัวอย่างสอง', 'cand2@example.com', NULL, 'referral', 'screening', '2027-09-20', NULL),
  (2, 'ผู้สมัคร ตัวอย่างสาม', 'cand3@example.com', NULL, 'website', 'applied', '2027-10-05', NULL);
INSERT INTO surveys (code, title, type, open_date, close_date, status) VALUES
  ('ENG-2026', 'Engagement Survey 2569', 'enps', '2026-10-01', '2026-10-31', 'closed');
INSERT INTO survey_responses (survey_id, score, comment) VALUES
  (1, 9, NULL), (1, 10, 'บรรยากาศดี'), (1, 7, NULL), (1, 6, 'อยากให้มีการอบรมมากขึ้น'), (1, 8, NULL), (1, 9, NULL);
INSERT INTO od_projects (code, name, owner_employee_id, start_date, end_date, budget, progress, status) VALUES
  ('ODP-01', 'Digital HR Transformation', 2, '2026-06-01', '2027-03-31', 500000, 35, 'active');
INSERT INTO documents (title, category, employee_id, url, effective_date, confidential) VALUES
  ('ระเบียบข้อบังคับการทำงาน', 'policy', NULL, 'https://example.com/hr/work-regulations.pdf', '2026-01-01', 0),
  ('สัญญาจ้าง E006', 'contract', 6, 'https://example.com/hr/contracts/E006.pdf', '2026-09-01', 1);
INSERT INTO pdpa_requests (requester_name, employee_id, type, received_date, due_date, status, note) VALUES
  ('อรุณ ตัวอย่าง', 8, 'access', '2026-10-15', '2026-11-14', 'in_progress', NULL);
INSERT INTO employee_pay_items (employee_id, component_id, amount, start_date, end_date) VALUES
  (2, 1, 10000, '2026-01-01', NULL), (5, 1, 3000, '2026-01-01', NULL), (7, 3, 1000, '2026-01-01', NULL), (3, 4, 1500, '2026-01-01', '2026-12-31');
