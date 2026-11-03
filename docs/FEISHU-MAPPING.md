# Feishu → HR System: Mapping Profile และขั้นตอนตรวจไฟล์ก่อน Import

สถานะ: **ร่าง รอยืนยันกับไฟล์จริง** ไฟล์ `For Payroll System_*.xlsx` และ `For Payroll System+A_*.xlsx` ยังไม่อยู่ในเครื่องที่พัฒนา
Mapping ด้านล่างได้จากหัวคอลัมน์ของรายงาน Feishu ชุดเดียวกันที่มีอยู่จริง ได้แก่ `Test+A_…`, `ST ATD-Leave…` และ `Dairy+Report…`
ไม่ได้สร้างข้อมูลตัวอย่างขึ้นมาแทนไฟล์จริง

## 1. Mapping Profile ที่เตรียมไว้

ระบบจับคู่ตามชื่อคอลัมน์ให้อัตโนมัติ เทียบแบบไม่สนตัวพิมพ์ วงเล็บเต็มความกว้าง หรือหน่วย `(hr)` `(min)` `(days)`
ถ้าไฟล์จริงใช้ชื่อคอลัมน์ตามตารางนี้ ไม่ต้องสร้าง Profile ใด ๆ
ให้สร้าง Profile เฉพาะเมื่อไฟล์จริงตั้งชื่อต่างออกไป: หน้า "นำเข้าเวลาทำงาน" → ④ Column Mapping → "บันทึกเป็น Mapping Profile"

| ข้อมูลในระบบ | Format A: For Payroll System (Expected Working Days) | Format B: For Payroll System+A (Expected Working Hours) | หน่วยที่จัดเก็บ |
|---|---|---|---|
| employee_code * | `Employee ID` | `Employee ID` | ข้อความ |
| employee_name | `Name` | `Name` | ข้อความ |
| external_department_id | `Department ID` (ถ้ามี) | `Department ID` (ถ้ามี) | ข้อความ |
| department_name | `Department` | `Department` | ข้อความ (ใช้ตรวจกับหน่วยงานในระบบ) |
| hire_date | `Employment date` | `Employment date` | YYYY-MM-DD |
| expected_work_days | `Expected working days` / `Days of expected attendance` | – | วัน |
| expected_work_hours | `Expected working hours(hr)` | `Expected working hours(hr)` | ชั่วโมง |
| actual_work_days | `Workday attendance` / `Days of actual attendance` | `Workday attendance` | วัน |
| actual_work_hours | `Actual working hours(hr)` | `Actual working hours(hr)` | ชั่วโมง |
| feishu_overtime_hours | `Total overtime duration(hr)` | `Total overtime duration(hr)` | ชั่วโมง (ถ้าเป็น `(min)` ระบบแปลงให้) |
| absence_days | `Absence days` | `Absence days` | วัน |
| absence_minutes | `Absence hours(hr)` | `Absence hours(hr)` | นาที (ชั่วโมง × 60) |
| unpaid_sick_leave_hours | `Unpaid Sick Leave` / `Sick leave（Unpaid）(hr)` | เหมือน Format A | ชั่วโมง (ถ้าเป็น `(days)` × ชั่วโมงต่อวัน) |
| unpaid_personal_leave_hours | `Unpaid Personal Leave` / `Personal leave（Unpaid）(hr)` | เหมือน Format A | ชั่วโมง |

\* จำเป็นต้องมี

ระบบระบุ Format จากคอลัมน์ที่พบ ถ้ามี Expected working days ถือเป็น A ถ้ามีเฉพาะ Expected working hours ถือเป็น B
ไฟล์ที่ไม่มีคอลัมน์ทั้งสองแบบจะถูกปฏิเสธ เช่น รายงาน `Dairy+Report`

คอลัมน์ OT ที่ไม่ได้นำเข้าแยก (`… - Overtime pay`, `… - Compensatory leave`, `Overtime on working days / non-working days / holidays`) ยังถูกเก็บในข้อมูลดิบของแต่ละแถว (`raw_json`) เพื่อใช้ตรวจย้อนหลัง

## 2. ผลตรวจกับไฟล์ Feishu ชุดเดียวกันที่มีอยู่จริง

ตรวจเฉพาะโครงสร้างไฟล์ ไม่ได้อ่านหรือเผยแพร่ข้อมูลบุคคล

| ไฟล์ | ผล |
|---|---|
| `Test+A_20260601_20260604` | Format A, หัวตารางแถว 2, จับคู่ได้ 12 ฟิลด์ ไม่มีคอลัมน์ลาไม่รับค่าจ้าง |
| `ST ATD-Leave 1-25 May 2026` | Format A แบบรายวัน (รวมยอดต่อคน), จับคู่ได้ 11 ฟิลด์ |
| `Dairy+Report_20260501_20260531` | ไม่มี Expected Days/Hours จึงถูกปฏิเสธถูกต้อง, `Personal leave（Unpaid）(hr)` จับคู่ได้ |

## 3. ขั้นตอนเมื่อได้รับไฟล์จริง (ก่อน Import)

1. ตรวจโครงสร้างในเครื่อง สคริปต์อ่านอย่างเดียว ไม่ Import และไม่แสดงชื่อหรือค่าใด ๆ

   ```
   node scripts/check-feishu-file.mjs "For Payroll System_20261026_20261103.xlsx" "For Payroll System+A_20261103_20261103.xlsx"
   ```
2. ตรวจผลตามรายการ:
   - [ ] หัวตาราง (Header) ถูกพบ
   - [ ] มี Employee ID ทุกแถว และไม่ซ้ำ
   - [ ] Format ถูกต้อง: ไฟล์แรกเป็น A, ไฟล์ +A เป็น B หรือ A ตามคอลัมน์จริง
   - [ ] มี Expected Days และ/หรือ Expected Hours
   - [ ] คอลัมน์ OT ถูกจับคู่และหน่วยถูกต้อง
   - [ ] คอลัมน์ลาไม่รับค่าจ้าง (ป่วย / กิจ) ถูกจับคู่ ถ้าไม่ถูกจับคู่ ต้องเลือกเองใน Column Mapping
3. ในระบบ ไปที่หน้า "นำเข้าเวลาทำงาน (Feishu)" แล้วเลือกบริษัท งวด และไฟล์ จากนั้นกด "วิเคราะห์ไฟล์"
   - ขั้นนี้ยังไม่บันทึกข้อมูล
   - ตรวจผล ③ ถึง ⑦ ให้ครบ
4. ถ้าต้องปรับ Mapping ให้บันทึกเป็น Profile ชื่อ `Feishu For Payroll System` และ `Feishu For Payroll System+A`
5. กดยืนยันนำเข้าเมื่อทุกอย่างถูกต้อง จากนั้นไปที่หน้า "ตรวจสอบ OT" เพื่อยืนยัน OT ก่อนคำนวณเงินเดือน
