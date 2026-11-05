# Backup & Recovery Procedure: HR System (Cloudflare D1 `hr-system-db`)

## หลักการ

- **ห้าม Restore ทับ Production โดยไม่มีการตัดสินใจเป็นลายลักษณ์อักษรจากเจ้าของระบบ**
  การ Restore ทั้งฐานจะลบทุกอย่างที่เกิดหลังจุดสำรอง ทั้ง Login, Audit และข้อมูล HR
- ไฟล์สำรองมีข้อมูลส่วนบุคคล เงินเดือน และรหัสผ่านที่ Hash แล้ว:
  - ห้าม Commit เข้า Git และห้ามแชร์ผ่านช่องทางสาธารณะ
  - เก็บที่ `.secrets/backups/` ซึ่งถูก `.gitignore` กันไว้
  - ควรสำเนาไปไดรฟ์ที่เข้ารหัสหรือสื่อสำรองที่ปลอดภัย

## 1. สำรองข้อมูล (ทำทุกครั้งก่อน Migration และก่อนเปลี่ยนแปลงสำคัญ)

```
npx wrangler d1 export hr-system-db --remote --output .secrets/backups/hr-system-db-<ชื่อ>-<YYYYMMDD-HHMMSS>.sql
sha256sum .secrets/backups/<ไฟล์>.sql > .secrets/backups/<ไฟล์>.sql.sha256
```

นอกจากไฟล์สำรอง ให้บันทึก Time Travel bookmark ณ เวลานั้นด้วย (Cloudflare เก็บย้อนหลังได้ 30 วัน):

```
npx wrangler d1 time-travel info hr-system-db                                   # bookmark ปัจจุบัน
npx wrangler d1 time-travel info hr-system-db --timestamp=2026-11-03T14:50:00Z  # bookmark ณ เวลาที่ระบุ
```

## 2. ทะเบียนจุดสำรอง

| จุดสำรอง | รายละเอียด |
|---|---|
| ไฟล์ก่อน Migration 0005 | `.secrets/backups/hr-system-db-pre-0005-20261103-213536.sql` (980 คำสั่ง, 268,802 bytes) |
| SHA-256 | `6692a65a023f1706f39cecf0039cb88f003ee1f81e1de82fe06e8c40f5174714` |
| ไฟล์พร้อม Restore | `.secrets/backups/hr-system-db-pre-0005-20261103-213536.restore.sql` |
| Time Travel ก่อน 0005 (14:50 UTC; 0005 ถูก Apply 14:51:12 UTC) | `0000004e-0000000a-00005118-7d17ca321c43baacd4a527483892beee` |
| เนื้อหาที่ตรวจแล้ว | สลิป 45 ใบ, สุทธิรวม 1,066,144.89, บริษัท 4, พนักงาน 46, ผู้ใช้ 7 |
| ไฟล์ก่อน Migration 0006 | `.secrets/backups/hr-system-db-pre-0006-20261103-222231.sql` (1,047 คำสั่ง, 264,994 bytes) |
| SHA-256 | `8560a25ecda32f158dc4addb477539eb7b89759f3d4fee7a92139bf9dbc7ed1b` |
| Time Travel ณ เวลาสำรองก่อน 0006 | `00000055-00000000-00005118-4becd2ea97cb151665ed35f58a3ad52c` |
| เนื้อหาที่ตรวจแล้ว | งวด 2 งวด (ทั้งคู่เป็นร่าง), สลิป 0 ใบ (สลิป 45 ใบเดิมถูกนำออกเมื่อ 15:07:26 UTC ด้วยการ "เปิดแก้ไข" ยังกู้ได้จากไฟล์ก่อน 0005 และ Time Travel), พนักงาน 46, ผู้ใช้ 7 |
| ไฟล์ก่อน Migration 0007 (4 พ.ย. 2569) | `.secrets/backups/hr-system-db-pre-0007-20261104-152020.sql` (1,061 คำสั่ง, 269,069 bytes) |
| SHA-256 | `a1e73f895346ddb07c408be528dae75bf65bdc4061c94dde2d318a2ba9ed96ef` |
| ไฟล์พร้อม Restore | `.secrets/backups/hr-system-db-pre-0007-20261104-152020.restore.sql` |
| Time Travel ก่อน 0007 (15:20 UTC; 0007 ถูก Apply 15:30:16 UTC) | `00000073-00000000-00005119-48b25975fe7672a49081950348c1881b` |
| เนื้อหาที่ตรวจแล้ว | 59 ตาราง 896 แถว, งวด 2 งวด (ร่าง), สลิป 0, Archive 0, role_permissions 160, Audit 487, พนักงาน 46, ผู้ใช้ 7 — Restore ลง Local ตรงทุกตาราง, `foreign_key_check` ว่าง, `quick_check` ok, ทดสอบ Apply 0007 ผ่าน |
| Worker ก่อน / หลัง Deploy 0007 | `b984f052-6300-4392-818f-f8580e1a104e` → `6cd27abe-6dab-478f-a92d-0fd55c6f24b1` (15:31:14 UTC, จาก `main` @ `b947f6a`) |
| ไฟล์ก่อน Migration 0008 (5 พ.ย. 2569 เวลาไทย) | `.secrets/backups/hr-system-db-pre-0008-20261104-191211.sql` (1,078 คำสั่ง, 273,081 bytes) |
| SHA-256 | `d1ce85d74b567af61e5d72e98fdeb0d39f79b128d846574f0695307bc9b8f52d` |
| ไฟล์พร้อม Restore | `.secrets/backups/hr-system-db-pre-0008-20261104-191211.restore.sql` |
| Time Travel ก่อน 0008 (19:12 UTC; 0008 ถูก Apply 19:22:45 UTC) | `0000007d-00000000-00005119-771132f56414da6b76a36e0ec8ea7001` |
| เนื้อหาที่ตรวจแล้ว | 60 ตาราง 910 แถว, สลิป 0, Archive 0, งวด 2 งวด (ร่าง), พนักงาน 46, ผู้ใช้ 7 — Restore ลง Local ตรงทุกตาราง, `foreign_key_check` ว่าง, `quick_check` ok, ทดสอบ Apply 0008 ผ่าน |
| Worker ก่อน / หลัง Deploy 0008 | `6cd27abe-6dab-478f-a92d-0fd55c6f24b1` → `c50ce2c5-4fcc-46db-ba12-4a6d3bab7fd5` (19:23:39 UTC, จาก `main` @ `342e642`, binding R2 `AVATARS`) |
| รูปพนักงาน (R2) | Bucket `hr-system-employee-assets` แบบ private ไม่อยู่ในไฟล์สำรอง D1 — ไฟล์สำรอง D1 มีเฉพาะ metadata (`employee_avatars`) ถ้ากู้ D1 ย้อนกลับ ให้ตรวจว่า object key ใน metadata ยังมีใน bucket (รูปที่หายจะแสดงเป็นอักษรย่อ ระบบไม่ล่ม) |

## 3. ทดสอบ Restore (ทำบน Local D1 แยกต่างหากเท่านั้น)

ไฟล์จาก `wrangler d1 export` เรียงคำสั่งแบบที่ Restore ลงฐานว่างไม่ได้ (และบางคำสั่งยาวหลายบรรทัดเมื่อข้อมูลมีขึ้นบรรทัดใหม่) จะเจอ error `no such table: main.employees`
เพราะ INSERT ของ `payslips` มาก่อน CREATE TABLE `employees`
ต้องจัดลำดับใหม่ก่อนด้วยสคริปต์ ซึ่งไม่เปลี่ยนเนื้อหาหรือจำนวนคำสั่ง:

```
node scripts/prepare-d1-restore.mjs .secrets/backups/<ไฟล์>.sql .secrets/backups/<ไฟล์>.restore.sql
npx wrangler d1 execute hr-system-db --local --persist-to .tmp/restore-<วันที่> --file .secrets/backups/<ไฟล์>.restore.sql
```

สคริปต์เรียง INSERT ให้แถวแม่มาก่อนแถวลูกเสมอ (ตารางแม่ก่อนตารางลูก และในตารางที่อ้างอิงตัวเอง เช่น `employees.manager_id`, `departments.parent_id` หัวหน้า/หน่วยงานแม่มาก่อน)
เพราะการ Import เข้า **D1 แบบ Remote ฐานใหม่** (กรณีกู้ระบบจริง) ตรวจ Foreign Key ทีละแถว — `PRAGMA defer_foreign_keys` ใช้ไม่ได้ข้ามชุดคำสั่งของการ Import
ไฟล์ที่ไม่ได้เรียงแบบนี้จะล้มด้วย `FOREIGN KEY constraint failed` (Import ทั้งไฟล์ถูกยกเลิก ฐานยังว่าง)
ถ้ามีแถวในตารางเดียวกันอ้างอิงกันเป็นวง สคริปต์จะหยุดและแจ้ง ไม่สร้างไฟล์ที่ Restore ไม่ได้

Restore ลง **D1 Remote ฐานใหม่สำหรับ Staging** (ห้ามใช้ชื่อ `hr-system-db`): ใช้ไฟล์ config แยกที่มีเฉพาะฐาน Staging เพื่อไม่ให้คำสั่งชี้ไป Production ได้

```
npx wrangler d1 create hr-system-db-staging
# wrangler.staging.jsonc (นอก repo): d1_databases มีเฉพาะ hr-system-db-staging + migrations_dir ของ repo
npx wrangler d1 execute hr-system-db-staging --remote --config <wrangler.staging.jsonc> --file .secrets/backups/<ไฟล์>.restore.sql
npx wrangler d1 migrations apply hr-system-db-staging --remote --config <wrangler.staging.jsonc>
```

ตรวจผลหลัง Restore บนฐาน Local:

```
npx wrangler d1 execute hr-system-db --local --persist-to .tmp/restore-<วันที่> --command "SELECT COUNT(*), ROUND(SUM(net),2) FROM payslips"
npx wrangler d1 execute hr-system-db --local --persist-to .tmp/restore-<วันที่> --command "PRAGMA foreign_key_check"
npx wrangler d1 execute hr-system-db --local --persist-to .tmp/restore-<วันที่> --command "PRAGMA quick_check"
npx wrangler d1 migrations apply hr-system-db --local --persist-to .tmp/restore-<วันที่>   # ทดสอบ Migration ต่อจากจุดสำรอง
```

**ผลทดสอบล่าสุด (3 พ.ย. 2569):**
- 980 คำสั่งสำเร็จ
- จำนวนทุกตารางและยอดเงินตรงกับ Production ณ เวลาสำรอง
- `foreign_key_check` ไม่มีปัญหา, `quick_check` ได้ `ok`
- Apply Migration 0005 ต่อได้ และยอดสลิปไม่เปลี่ยน

**ผลทดสอบก่อน Migration 0008 (5 พ.ย. 2569 เวลาไทย, ตามรายงาน Release `reports/PHASE-E1-AVATAR-RELEASE.md`):**
- Restore ไฟล์ `hr-system-db-pre-0008-20261104-191211.restore.sql` ลง Local แยก: 60 ตาราง 910 แถว ตรงกับ Production ณ เวลาสำรองทุกตาราง
- `foreign_key_check` ไม่มีปัญหา, `quick_check` ได้ `ok`
- Apply Migration 0008 ต่อได้ เพิ่มเฉพาะตาราง `employee_avatars` ที่ว่าง ข้อมูลอื่นไม่เปลี่ยน

**ผลทดสอบก่อน Migration 0009 (5 พ.ย. 2569, ไฟล์ `hr-system-db-pre-0009-20261105-110751.sql`, bookmark `000000b5-00000000-0000511a-53c4171aa7010963fb3a83ec186c7f4d`):**
- Production อยู่ที่ Migration 0001–0008, 62 ตาราง; ไฟล์สำรองครบ (1,326 คำสั่ง: 62 ตาราง, 1,164 แถว, 78 index)
- Restore ลง Local แยก และลง D1 Remote ฐานใหม่ `hr-system-db-staging`: จำนวนแถวตรงกับไฟล์สำรองทุกตาราง (0 ต่าง), `quick_check` `ok`, `foreign_key_check` ไม่มีปัญหา (Local)
- ครั้งแรกที่ Restore ลง Remote ล้มด้วย `FOREIGN KEY constraint failed` (Import ถูกยกเลิกทั้งไฟล์ ฐานยังว่าง) — แก้ด้วยการเรียงแถวแม่ก่อนลูกในสคริปต์ แล้ว Restore สำเร็จ 1,326/1,326
- Apply Migration 0009 ทั้ง Local และ Staging Remote: เพิ่ม 5 ตารางว่าง + ปฏิทินกลาง 1 แถว + สิทธิ์ 11 แถว + ประวัติ Migration 1 แถว; ข้อมูลพนักงาน งวดเงินเดือน สลิป และประวัติเงินเดือน ไม่เปลี่ยน (เทียบ hash ก่อน/หลัง)
- ทดสอบ Rollback (`scripts/rollback/0009_holiday_calendar.down.sql`) บนสำเนา Local: กลับเป็นสถานะเดียวกับไฟล์สำรองทุกตาราง แล้ว Apply 0009 ซ้ำได้

## 4. การกู้คืนเมื่อเกิดเหตุ (ต้องได้รับอนุมัติก่อนทุกครั้ง)

| สถานการณ์ | วิธีที่แนะนำ |
|---|---|
| ต้องการดูหรือเทียบข้อมูลเก่า | Restore ลง Local (ข้อ 3) แล้ว Query เทียบ ไม่แตะ Production |
| สลิปถูกแทนที่จากการคำนวณใหม่หรือเปิดแก้ไข (ตั้งแต่ Migration 0006) | สำเนาเดิมอยู่ใน `payslip_archive` ค้นด้วย `period_id` และ `calc_version` ไม่ต้อง Restore ทั้งฐาน |
| งวดเงินเดือนถูกลบ (ตั้งแต่ Migration 0007) | การลบเป็นแบบ Soft delete: Super Admin กู้คืนได้ที่ งวดเงินเดือน → "งวดที่ลบแล้ว" (ต้องมีเหตุผลและรหัส MFA) ประวัติ Archive และ Audit ไม่หาย |
| งวดที่ปิดแล้วถูกเปิดใหม่หรือคำนวณใหม่ (ตั้งแต่ Migration 0007) | สลิปก่อนเปิดงวดอยู่ใน `payslip_archive` (`reason = 'reopen'`, `op_token` ตาม Audit `payroll.period_reopened_closed`) รวมสถานะการเผยแพร่เดิม |
| ข้อมูลบางตารางเสียหาย | Restore ลง Local → Export เฉพาะแถวที่ต้องการ → ตรวจโดย HR → นำเข้าเฉพาะแถวนั้นผ่านขั้นตอนที่อนุมัติ |
| ฐานข้อมูลเสียหายทั้งระบบ | `npx wrangler d1 time-travel restore hr-system-db --bookmark=<bookmark>` โดยเจ้าของระบบอนุมัติเป็นลายลักษณ์อักษร ข้อมูลหลังจุดนั้นจะหายทั้งหมด ให้สำรองสถานะปัจจุบันก่อนเสมอ |
| รูปพนักงานหายหรือไม่ตรงกับ metadata (ตั้งแต่ Migration 0008) | รูปอยู่ใน R2 bucket private `hr-system-employee-assets` ไม่อยู่ในไฟล์สำรอง D1 ตาราง `employee_avatars` เก็บเฉพาะ metadata (`object_key`, ชนิด, ขนาด) แถวที่ชี้ไปยัง object ที่ไม่มีแล้วจะแสดงเป็นอักษรย่อ ให้ลบแถวนั้นหรืออัปโหลดรูปใหม่ ส่วน object ที่ค้างหลังเปลี่ยนรูปไม่สำเร็จจะมี key อยู่ใน Audit (`orphan_key`) |
| Deploy ใหม่มีปัญหา (ไม่เกี่ยวกับข้อมูล) | `npx wrangler rollback` กลับ Worker Version ก่อนหน้า ไม่แตะฐานข้อมูล |

ทุกครั้งหลังกู้คืน:
1. ตรวจจำนวนสลิปและยอดรวม
2. ตรวจ `foreign_key_check`
3. ทดสอบ Login
4. บันทึกเหตุการณ์ วันที่ ผู้อนุมัติ และ bookmark ที่ใช้
