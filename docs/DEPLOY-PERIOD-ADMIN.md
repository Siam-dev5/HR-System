# Deploy Runbook: Super Admin Period Management (Migration 0007)

> **ดำเนินการแล้ว 4 พ.ย. 2569** (อนุมัติโดยเจ้าของระบบ): Migration 0007 Apply 15:30:16 UTC, Worker `6cd27abe-6dab-478f-a92d-0fd55c6f24b1` — บันทึกผลที่ `reports/PRODUCTION-RELEASE-FINAL.md` และ BACKUP-RECOVERY ข้อ 2
> เอกสารนี้ยังใช้เป็นขั้นตอน Rollback ได้ (ข้อ 6)
> ห้ามทำในช่วงประมวลผลเงินเดือนจริง (รอบกลางเดือนวันที่ 10–11 และรอบสิ้นเดือน)

## ลำดับที่ต้องรักษา

**Migration ก่อน แล้วจึง Deploy Worker** โค้ดใหม่อ่านคอลัมน์ `deleted_at` / `reopened_from` และตาราง `mfa_step_up`
ถ้า Deploy ก่อน Migration หน้าเงินเดือนจะ Error ทันที

ส่วนโค้ด Production เดิม (`b984f052`) ทำงานกับ Schema 0007 ได้ตามปกติ (ผ่านชุดทดสอบเดิมทั้งหมดบน Schema 0007)
ช่วงระหว่าง Migration กับ Deploy จึงปลอดภัย และการ Rollback Worker หลัง Migration ก็ปลอดภัย

## 1. ก่อนเริ่ม (อ่านอย่างเดียว)

```
git switch main && git pull --ff-only          # merge แล้วเท่านั้น; commit ที่จะ Deploy ต้องผ่าน npm run check
npm ci && npm run check
npx wrangler deployments list                   # บันทึก Worker version ปัจจุบัน (ตอน Audit: b984f052-6300-4392-818f-f8580e1a104e)
npx wrangler d1 migrations list hr-system-db --remote   # ต้องค้างเพียง 0007_period_admin.sql
npx wrangler d1 execute hr-system-db --remote --command "SELECT COUNT(*) FROM payslips; SELECT COUNT(*) FROM payslip_archive; SELECT COUNT(*) FROM role_permissions; SELECT id, code, status, updated_at FROM payroll_periods"
```

บันทึกค่าทั้งหมดไว้เทียบหลัง Migration (ตอน Audit: สลิป 0, Archive 0, role_permissions 160, งวด 2 งวด)

## 2. สำรองข้อมูล (บังคับ)

ตาม [BACKUP-RECOVERY.md](BACKUP-RECOVERY.md) ข้อ 1:

```
npx wrangler d1 export hr-system-db --remote --output .secrets/backups/hr-system-db-pre-0007-<YYYYMMDD-HHMMSS>.sql
sha256sum .secrets/backups/hr-system-db-pre-0007-<...>.sql > .secrets/backups/hr-system-db-pre-0007-<...>.sql.sha256
npx wrangler d1 time-travel info hr-system-db   # บันทึก bookmark ก่อน Migration
```

ทดสอบไฟล์สำรองบน Local แยกต่างหากก่อนไปต่อ (ข้อ 3 ของ BACKUP-RECOVERY): Restore → `migrations apply --local` → จำนวนทุกตารางต้องเท่าเดิม ยกเว้น `role_permissions` +4

## 3. Migration

```
npm run db:migrate:remote        # = wrangler d1 migrations apply hr-system-db --remote (ใช้ 0007 เท่านั้น)
```

ตรวจทันที:

```
npx wrangler d1 migrations list hr-system-db --remote        # ไม่มีรายการค้าง
npx wrangler d1 execute hr-system-db --remote --command "SELECT COUNT(*) FROM payslips; SELECT COUNT(*) FROM payslip_archive; SELECT COUNT(*) FROM role_permissions; SELECT id, code, status, updated_at, deleted_at, reopened_from FROM payroll_periods; PRAGMA foreign_key_check"
```

ผ่านเมื่อ: role_permissions = เดิม + 4, จำนวนอื่นเท่าเดิม, `updated_at` ของงวดไม่เปลี่ยน, `deleted_at` / `reopened_from` เป็น NULL, `foreign_key_check` ว่าง
**ไม่ผ่าน → หยุด อย่า Deploy** แล้วไปข้อ 6

## 4. Deploy Worker

```
npm run deploy
npx wrangler deployments list     # บันทึก version ใหม่
```

## 5. ตรวจหลัง Deploy (ห้ามแตะงวดจริง)

1. `GET /api/health` ได้ 200
2. Login ด้วยบัญชีทดสอบ / HR ตามปกติ, หน้าเงินเดือนแสดงงวด 2026-11 และ 2026-11-M เหมือนเดิม
3. Super Admin ที่มี MFA (id 4) เห็นปุ่มจัดการงวด; Payroll Officer / HR Admin ไม่เห็น
4. เปิด "ผลกระทบ" ของงวดได้ (อ่านอย่างเดียว) **ห้ามกดยืนยัน** เปิดงวด / แก้ไข / ลบ / คำนวณใหม่ กับงวดจริง
5. บัญชี Super Admin id 1 (ยังไม่มี MFA) จะถูกบังคับตั้ง MFA ก่อนใช้งาน ตามนโยบาย `security.mfa_enforce_privileged`
6. นับ Audit / สลิป / งวด อีกครั้ง ต้องเท่ากับข้อ 3
7. บันทึกจุดสำรอง, bookmark, Worker version ก่อน/หลัง ลงตาราง BACKUP-RECOVERY ข้อ 2

## 6. Rollback และกู้คืน

| สถานการณ์ | วิธี |
|---|---|
| Migration ล้มเหลวกลางทาง (บาง ALTER สำเร็จ) | หยุด ไม่ Deploy; Worker เดิมยังทำงานได้กับคอลัมน์ที่เพิ่มบางส่วน; แจ้งเจ้าของระบบ ทางเลือก: Time Travel ไป bookmark ข้อ 2 (ข้อมูลหลังจุดนั้นหาย) หรือเติมคำสั่งที่เหลือด้วยมือหลังอนุมัติ |
| Worker ใหม่มีปัญหา | `npx wrangler rollback b984f052-6300-4392-818f-f8580e1a104e` ไม่ต้องแตะฐานข้อมูล (Schema 0007 ใช้กับ Worker เดิมได้) |
| Rollback Worker หลังมีการลบงวดแบบ Soft delete แล้ว | ก่อน Rollback ตรวจ `SELECT id, deleted_code FROM payroll_periods WHERE deleted_at IS NOT NULL` Worker เดิมไม่กรองงวดที่ลบ จะแสดงเป็นรหัส `<code>~deleted~<id>` ให้ Super Admin กู้คืนหรือรับทราบก่อน |
| Rollback Worker ขณะมีงวด "เปิดโดย Super Admin" | Worker เดิมไม่บังคับ Super Admin สำหรับการคำนวณใหม่ของงวดนั้น ให้อนุมัติงวดให้เสร็จก่อน หรือแจ้ง Payroll ไม่ให้คำนวณจนกว่าจะ Deploy ใหม่ |
| ต้องการถอด Schema 0007 | **ไม่แนะนำ** คอลัมน์ / ตารางที่เพิ่มไม่กระทบ Worker เดิม ถ้าจำเป็นจริงใช้ Time Travel bookmark ข้อ 2 โดยเจ้าของระบบอนุมัติเป็นลายลักษณ์อักษร |
