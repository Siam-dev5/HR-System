-- Employee Welfare Fund (กองทุนสงเคราะห์ลูกจ้าง). Additive only: existing payroll history keeps its values
-- (new payslip columns default to 0) and approved/published periods cannot be recalculated.
-- Legal rates are NOT seeded: the fund starts disabled with zero rates; a Super Admin enters the values in force.

ALTER TABLE payslips ADD COLUMN ewf_employee REAL NOT NULL DEFAULT 0;      -- deducted from the employee (shown on the payslip)
ALTER TABLE payslips ADD COLUMN ewf_employer REAL NOT NULL DEFAULT 0;      -- employer contribution (never deducted from net pay)
ALTER TABLE payslips ADD COLUMN ewf_employee_rate REAL;                    -- % used for this payslip (audit trail)
ALTER TABLE payslips ADD COLUMN ewf_employer_rate REAL;
ALTER TABLE payslips ADD COLUMN ewf_status TEXT;                           -- applied / disabled / not_effective / below_min_employees / exempt_*

-- per-employee exemption: covered by an equivalent welfare scheme
ALTER TABLE employees ADD COLUMN ewf_equivalent_welfare INTEGER NOT NULL DEFAULT 0;

INSERT INTO settings (key, value, type, description) VALUES
  ('payroll.ewf_enabled', 'false', 'bool', 'เปิดใช้งานกองทุนสงเคราะห์ลูกจ้าง (EWF)'),
  ('payroll.ewf_effective_date', '', 'text', 'วันที่มีผลบังคับใช้ (YYYY-MM-DD)'),
  ('payroll.ewf_employee_rate', '0', 'number', 'อัตราสะสมของพนักงาน (% ของค่าจ้าง)'),
  ('payroll.ewf_employer_rate', '0', 'number', 'อัตราสมทบของนายจ้าง (% ของค่าจ้าง)'),
  ('payroll.ewf_next_rate_date', '', 'text', 'วันที่เปลี่ยนอัตราครั้งถัดไป (YYYY-MM-DD, เว้นว่างได้)'),
  ('payroll.ewf_next_employee_rate', '0', 'number', 'อัตราสะสมของพนักงานหลังวันที่เปลี่ยนอัตรา (%)'),
  ('payroll.ewf_next_employer_rate', '0', 'number', 'อัตราสมทบของนายจ้างหลังวันที่เปลี่ยนอัตรา (%)'),
  ('payroll.ewf_wage_cap', '0', 'number', 'เพดานค่าจ้างที่ใช้คำนวณต่อเดือน (บาท, 0 = ไม่มีเพดาน)'),
  ('payroll.ewf_min_employee_count', '0', 'number', 'จำนวนลูกจ้างขั้นต่ำของบริษัทที่ต้องเข้ากองทุน (0 = ทุกบริษัท)'),
  ('payroll.ewf_exempt_provident_fund', 'true', 'bool', 'ยกเว้นลูกจ้างที่เป็นสมาชิกกองทุนสำรองเลี้ยงชีพ'),
  ('payroll.ewf_provident_fund_component', 'PVD', 'text', 'รหัสรายการเงินหักที่แสดงการเป็นสมาชิกกองทุนสำรองเลี้ยงชีพ'),
  ('payroll.ewf_exempt_equivalent_welfare', 'true', 'bool', 'ยกเว้นลูกจ้างที่มีสวัสดิการเทียบเท่า (ตามที่ระบุในข้อมูลพนักงาน)');
