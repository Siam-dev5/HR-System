# HR System

ระบบบริหารทรัพยากรบุคคลแบบครบวงจร (HRM · HRD · HROD · Payroll) ทำงานบน **Cloudflare Workers** และใช้ **Cloudflare D1** เป็นฐานข้อมูลหลัก

| ส่วน | เทคโนโลยี |
|---|---|
| API | [Hono](https://hono.dev) บน Cloudflare Workers (TypeScript) |
| ฐานข้อมูล | Cloudflare D1 (SQLite) — migrations ใน `migrations/` |
| หน้าเว็บ | SPA เขียนด้วย TypeScript ล้วน (ไม่มี framework) bundle ด้วย esbuild → `public/assets/app.js` |
| ทดสอบ | Vitest — unit tests และ integration tests ที่รัน `wrangler dev` กับ D1 ภายในเครื่องจริง · Browser tests (Playwright / `playwright-core`) ใน `tests/ui/` |

## โครงสร้างโปรเจกต์

```
src/
  shared/          โค้ดที่ใช้ร่วมกันระหว่าง Worker และหน้าเว็บ
    modules.ts     ทะเบียนโมดูล (ตาราง ฟิลด์ เมนู สิทธิ์) — แหล่งความจริงเดียว
    types.ts       สัญญา API (API contract) ที่ทั้งสองฝั่งใช้ร่วมกัน
    permissions.ts ตัวตรวจสิทธิ์แบบ pattern (เช่น payroll.*, *.view)
    links.ts       การแปลงลิงก์ภายใน/ภายนอกอย่างปลอดภัย
    payroll.ts     การคำนวณเงินเดือน (ประกันสังคม ภาษีหัก ณ ที่จ่าย OT ลาไม่รับค่าจ้าง)
    crypto.ts, totp.ts  PBKDF2, AES-GCM, TOTP (RFC 6238)
  worker/          Cloudflare Worker (API)
    index.ts       entry: CSRF, security headers, routing, error handling
    auth.ts        session, middleware ตรวจสิทธิ์
    routes/        auth, crud (generic), workflow, payroll, overview, admin
  web/             SPA (router, layout, หน้าจอแต่ละโมดูล)
migrations/        D1 schema + reference data
seeds/demo.sql     ข้อมูลตัวอย่าง (สมมุติ) สำหรับทดลอง/ทดสอบ — ไม่ถูกใช้ใน production โดยอัตโนมัติ
scripts/           build SPA, สร้างผู้ใช้ (รหัสผ่านสุ่ม ไม่พิมพ์ออกหน้าจอ)
tests/             unit + integration (Vitest) · ui/ = browser tests (ดู tests/ui/README.md)
```

## โมดูล

- **ภาพรวม**: Executive Dashboard, ESS (ข้อมูลของฉัน + ลงเวลา), สลิปเงินเดือนของฉัน, HR Analytics, คำขอ & อนุมัติ
- **HRM**: ผังองค์กร, หน่วยงาน, นำเข้าเวลาทำงาน (Feishu), ตรวจสอบ OT (Feishu), Job & Position, พนักงาน, Onboarding, Offboarding, อัตรากำลัง, สรรหา (ATS) + ผู้สมัคร, เวลาทำงาน, กะ/ตารางกะ, แก้ไขเวลา, OT, การลา, รอบประเมิน, ประเมินผล KPI/OKR, Talent 9-Box
- **HRD**: Competency, ทักษะ, Skill Matrix & Gap, TNA, หลักสูตร, อบรม/LMS, ผู้เข้าอบรม, OJT, IDP, Career Path
- **HROD**: Organization Design (ผังองค์กรแบบโต้ตอบ), Organization Design Scenario, Workforce Planning, Engagement & eNPS, OD Projects
- **Payroll**: งวดเงินเดือนรายเดือน / กลางเดือน (สร้าง → คำนวณ → Preview → อนุมัติ → เผยแพร่), Payroll Preview, สลิปเงินเดือน (HR) + YTD, รายการเงินได้/เงินหัก, เงินได้/เงินหักประจำรายคน, ประวัติอัตราเงินเดือน
- **System**: บริษัท/สาขา/Cost Center/ประเภทการลา, Workflow Engine, เอกสาร, รายงาน & Export, PDPA, Audit Log, ผู้ใช้, บทบาท & สิทธิ์, ตั้งค่าระบบ, ความปลอดภัย & MFA, คู่มือ

## หลักการออกแบบที่สำคัญ

- **เมนู = Route = สิทธิ์**: เมนูสร้างจาก `src/shared/modules.ts` และกรองด้วยสิทธิ์เดียวกับที่ API ใช้ ผู้ใช้จะไม่เห็นเมนูที่เปิดไม่ได้ หากเปิด URL ตรง ๆ จะได้หน้า 403 ที่บอกสิทธิ์ที่ต้องใช้ — มี integration test ยืนยันว่าทุกเมนูของทุกบทบาทเปิดได้จริง
- **ลิงก์บน Dashboard/การแจ้งเตือน** คำนวณที่ server: แสดงเป็นลิงก์เฉพาะเมื่อผู้ใช้มีสิทธิ์เปิดปลายทาง URL ภายนอกไม่ถูกต่อกับ base path
- **Dropdown ทุกตัว** ใช้สัญญา `LookupOption { value, label, code, parentId, depth }` โดย `label` รับประกันว่าไม่ว่าง
- **Workflow**: คำขอลา/OT/แก้ไขเวลาเข้าสู่การอนุมัติตามบทบาท ผู้ยื่นอนุมัติคำขอของตนเองไม่ได้ การแก้ไขเวลาที่อนุมัติแล้วจะปรับข้อมูลลงเวลาอัตโนมัติ
- **Payroll**: ผู้อนุมัติต้องไม่ใช่ผู้คำนวณ (ตั้งค่าได้) อัตราประกันสังคม/ฐานค่าจ้างปรับได้ในหน้า ตั้งค่าระบบ
- **ความปลอดภัย**: รหัสผ่าน PBKDF2-SHA256 (100k), session token เก็บเป็น SHA-256 ใน D1 และ cookie HttpOnly/SameSite=Strict, CSRF header, ล็อกบัญชีตามนโยบาย, MFA (TOTP) บังคับสำหรับบทบาทสิทธิ์สูงตามค่าตั้ง (ข้อความหน้า Login มาจากค่าตั้งจริง), secret TOTP เข้ารหัส AES-GCM, ข้อมูลอ่อนไหว (เงินเดือน บัญชีธนาคาร เลขภาษี) ถูกปิดบังหากไม่มีสิทธิ์ `*.sensitive`, CSP เข้มงวด
- **กองทุนสงเคราะห์ลูกจ้าง (EWF)**: ตั้งค่าที่ ตั้งค่าระบบ → การ์ด "กองทุนสงเคราะห์ลูกจ้าง" (สถานะ, วันที่มีผล, อัตราพนักงาน/นายจ้าง, อัตราหลังวันที่เปลี่ยน, เพดานค่าจ้าง, เงื่อนไขการเข้าเกณฑ์) — Payroll Engine ไม่มีอัตรากฎหมายฝังในโค้ด อ่านค่าจาก Settings ทั้งหมด และเลือกอัตราตาม *วันจ่าย* ของงวด เงินสะสมพนักงานเป็นรายการหักในสลิป ส่วนเงินสมทบนายจ้างเก็บแยก (`payslips.ewf_employer`) ไม่หักจากเงินสุทธิและไม่แสดงในสลิปของพนักงาน งวดที่อนุมัติ/เผยแพร่แล้วไม่ถูกคำนวณใหม่
- **แถบด้านบน (Header)**: เลือกบริษัท · การแจ้งเตือน · ธีม · บัญชีผู้ใช้ (ไอคอน SVG ใน `src/web/icons.ts`) — dropdown เปิดได้ครั้งละหนึ่งตัว ปิดเมื่อคลิกภายนอกหรือกด Escape และใช้ลูกศรเลื่อนได้
  - **บริษัท**: รายชื่อมาจากตาราง `companies` (เฉพาะที่ active) ตามขอบเขตจริงของผู้ใช้ — บทบาทที่มี `employees.all` เห็นทุกบริษัท (+ "ทุกบริษัท") ผู้ใช้อื่นเห็นเฉพาะบริษัทต้นสังกัดของข้อมูลพนักงานที่ผูกไว้ บริษัทที่เลือกใช้กรอง Executive Dashboard (`/api/dashboard?company=<id>`) ซึ่ง API ตรวจขอบเขตทุกครั้ง (นอกขอบเขต = 403) ตัวเลขที่ไม่ผูกกับบริษัทในโครงสร้างข้อมูล (สรรหา อบรม งวดเงินเดือน) ระบุว่า "ทุกบริษัท" ส่วนหน้าอื่นแสดงข้อมูลตามสิทธิ์ของบทบาทเช่นเดิม
  - **ธีม**: สว่าง / มืด / อัตโนมัติ (`prefers-color-scheme`) บันทึกใน `localStorage` ของเบราว์เซอร์ (ระบบไม่มีตาราง preference ของผู้ใช้) และใช้ก่อนวาดหน้าจอผ่าน `public/assets/theme-init.js` — การพิมพ์ใช้โทนสว่างเสมอ
  - **บัญชีผู้ใช้**: ชื่อ อีเมล Badge บทบาทจริง ขอบเขตบริษัท และลิงก์ โปรไฟล์ของฉัน (ESS) · ความปลอดภัย & MFA · คู่มือ · ออกจากระบบ
- **นำเข้าเวลาทำงานจาก Feishu** (`/attendance/import`): อ่านไฟล์ .xlsx / .csv ในเบราว์เซอร์ (ไม่มี dependency เพิ่ม: `src/shared/xlsx.ts`) แล้วส่งตาราง cell ให้ Worker ตรวจซ้ำทั้งหมดกับ D1 — ตรวจรูปแบบอัตโนมัติ (Format A: Expected Working Days · Format B: Expected Working Hours · รายงานรายวันรวมยอดต่อคน), Column Mapping + Mapping Profile (จับคู่ตามชื่อคอลัมน์), ตรวจ Employee ID ไม่พบ / ต่างบริษัท / ซ้ำ / วันที่-ตัวเลขผิด / OT รอยืนยัน / การลาผิดปกติ / ไฟล์ซ้ำ, Reconciliation กับพนักงานของบริษัทและเวอร์ชันก่อน แถวที่ผิดไม่ถูกนำเข้า (ต้องยืนยัน "นำเข้าเฉพาะรายการที่ถูกต้อง") เก็บค่าดิบทุก cell (`raw_json`) มี Version / Rollback และ **ล็อก** เมื่อ Payroll คำนวณงวดนั้น (เปิดแก้ไขได้ด้วย "เปิดแก้ไข" เฉพาะงวดที่ยังไม่อนุมัติ)
- **ตรวจสอบ OT** (`/attendance/ot-review`): Feishu → รอตรวจสอบ → HR ยืนยัน / ปรับชั่วโมง (ต้องมีเหตุผล) / ปฏิเสธ — เก็บค่าเดิมจาก Feishu และค่าที่ยืนยันแยกกัน พร้อมผู้ตรวจ วันที่ เหตุผล และ Audit Log; OT ที่ยังไม่ยืนยันไม่ถูกคำนวณ และงวดอนุมัติไม่ได้ถ้ายังมี OT ค้างตรวจ เมื่อบริษัทมีข้อมูล Feishu ของงวด ระบบใช้ OT / ลาไม่รับค่าจ้างจาก Feishu แทนคำขอในระบบ (ไม่นับซ้ำ)
- **ทดลองงาน 90 วัน / จ่าย 2 รอบ**: วันเริ่มงาน = วันที่ 1, วันที่ 90 = ครบ, วันที่ 91 = ผ่าน (คำนวณวันแบบไม่ขึ้นกับ timezone) งวดประเภท *กลางเดือน* (26–10 จ่ายไม่เกินวันที่ 15) จ่ายเฉพาะวันที่ยังทดลองงาน = อัตรา/30 × วัน โดยไม่หักภาษี/ประกันสังคม งวด *สิ้นเดือน* คำนวณเต็มเดือนตามกติกาเดิมแล้วหัก "Mid-month Advance" — ห้ามคำนวณสิ้นเดือนขณะรอบกลางเดือนยังไม่อนุมัติ และแก้รอบกลางเดือนไม่ได้เมื่อสิ้นเดือนคำนวณแล้ว งวดประเภทเดียวกันห้ามมีวันที่ซ้อนกัน ถ้าผ่านทดลองงานระหว่างงวดจะแยกช่วงก่อน/หลัง (ฐาน 30 วัน: เต็มงวด = 30 วันเสมอ) และใช้อัตราตาม "ประวัติอัตราเงินเดือน" ที่อนุมัติ (ไม่เปลี่ยนอัตราเอง) พนักงานเข้าใหม่/ลาออก (`termination_date`) คิดตามวันมีสิทธิ์ ทุกสลิปเก็บ snapshot การคำนวณ (`calc_json`, `calc_version`, บริษัทที่จ่าย)
- **Payroll Preview** (`/payroll/preview`): ข้อมูลพนักงาน / เวลาทำงาน / เงินได้ / เงินหัก / นายจ้างสมทบ / สุทธิ จาก snapshot ของงวด (งวดร่างแสดงแบบคำนวณชั่วคราวโดยไม่บันทึก) ตรวจสอบก่อน Export เสมอ ไฟล์ CSV / Excel ตรงกับคอลัมน์ที่แสดง **การจัดคอลัมน์ (ลาก-วาง / ซ่อน / บันทึก / Reset) แยกตามบริษัท ทำได้เฉพาะบทบาท `super_admin`** — API ตรวจบทบาทโดยตรง และ `payroll_layout.manage` มอบให้บทบาทอื่นไม่ได้
- **สลิป YTD**: เงินได้ / ประกันสังคม / ภาษี / กองทุนสงเคราะห์ลูกจ้าง (ส่วนพนักงาน) สะสมตามปีปฏิทิน นับเฉพาะสลิปรายเดือนที่เผยแพร่แล้วจนถึงงวดที่เปิดดู แยก "บริษัทนี้" (บริษัทที่จ่ายจริงในแต่ละงวด) และ "รวมทุกบริษัท" ของพนักงานคนเดียวกัน (เชื่อมระเบียนที่โอนย้ายด้วย `employees.person_id` ไม่ใช้รหัสพนักงาน)
- **Organization Design** (`/org-chart`): ผังสายบังคับบัญชา (SVG) + ตาราง จากข้อมูลจริง (บริษัท หน่วยงาน ตำแหน่ง/Grade พนักงาน Reports To) ค้นหา กรองหน่วยงาน ซูม/พอดีจอ ย่อ/ขยาย รายละเอียดพนักงาน แก้ไขสายบังคับบัญชา (กันวนลูป/ข้ามบริษัท) อัตรากำลัง Approved / Occupied / Vacant (ไม่ติดลบ) / Over แยก, Export Excel / CSV / PNG / SVG / PDF และ Import ผ่าน Template + Preview (ปรับเฉพาะหัวหน้า / หน่วยงาน / ตำแหน่งของพนักงานที่มีอยู่ ไม่แทนที่ข้อมูลทั้งหมด) ทุกการแก้ไขบันทึก Audit Log
- **ค่าตั้งระบบ = Super Admin เท่านั้น** (ทั้งหน้าเว็บและ API; `settings.manage` มอบให้บทบาทอื่นไม่ได้)
- **ลงทะเบียนด้วยตนเอง** (`/register`): บัญชีใหม่ถูกสร้างแบบ *รออนุมัติ* และ **ไม่มีบทบาทใด ๆ** — ข้อมูลบทบาท/สิทธิ์ที่ส่งมากับคำขอถูกเพิกเฉย เข้าสู่ระบบไม่ได้จนกว่า Super Admin จะอนุมัติและเลือกบทบาท (ค่าเริ่มต้นคือ `employee`) มี rate limit ต่อ IP และปิดได้ที่ค่าตั้ง `security.self_registration`
- **จัดการผู้ใช้ / บทบาท / สิทธิ์ = Super Admin เท่านั้น**: API ตรวจ *บทบาท* `super_admin` โดยตรง (ไม่ใช่แค่ permission) และหน้าแก้ไขบทบาทไม่ยอมให้มอบ `users.manage` / `roles.manage` (รวมถึง `users.*`, `*.manage`) ให้บทบาทอื่น
- **บทบาทเริ่มต้น**: `super_admin`, `hr_admin`, `hr_manager` (Manager / ผู้อนุมัติ), `hr_staff` (งานปฏิบัติการ HR ไม่รวมเงินเดือน/ข้อมูลอ่อนไหว), `payroll_officer`, `employee`
- **Audit Log**: login/ล้มเหลว/ล็อก, MFA, สร้าง/แก้ไข/ลบ, Export, การอนุมัติ, ขั้นตอนเงินเดือน, การดูสลิป, การจัดการผู้ใช้และค่าตั้ง (ไม่บันทึกรหัสผ่านหรือค่าข้อมูลอ่อนไหว)

## พัฒนาบนเครื่อง

```bash
npm install
cp .dev.vars.example .dev.vars        # ใส่ MFA_ENCRYPTION_KEY (ดูคำสั่งสร้างในไฟล์)
npm run db:migrate:local
npx wrangler d1 execute hr-system-db --local --file seeds/demo.sql   # ข้อมูลตัวอย่าง (ไม่บังคับ)
node scripts/create-user.mjs --username admin --role super_admin --out .tmp/admin.sql
npx wrangler d1 execute hr-system-db --local --file .tmp/admin.sql   # รหัสผ่านอยู่ใน .secrets/credentials.txt
npm run dev
```

## ตรวจสอบคุณภาพ

```bash
npm run typecheck   # tsc: worker, web, tests
npm run lint        # eslint
npm run build       # bundle SPA + wrangler deploy --dry-run
npm test            # unit + integration (สร้าง D1 ชั่วคราวและรัน wrangler dev อัตโนมัติ)
npm run test:ui     # browser tests ทีละชุด (Chromium; สร้าง D1 + wrangler dev ภายในเครื่องเอง)
```

Browser tests ไม่แตะฐานข้อมูลจริง: ทุกชุดสร้าง D1 ชั่วคราวใน `.tmp/` ผู้ใช้ทดสอบรหัสผ่านสุ่ม และหยุด server เมื่อจบ
การเปรียบเทียบภาพกับ baseline (`npm run test:ui:baseline -- <git-ref>` แล้ว `npm run test:ui -- --baseline <dir>`)
วิธีรันใน Local / CI และรายละเอียดแต่ละชุดอยู่ที่ [tests/ui/README.md](tests/ui/README.md)

## Deploy (Cloudflare)

```bash
npx wrangler login                                   # หรือกำหนด CLOUDFLARE_API_TOKEN
npm run db:migrate:remote                            # ใช้ migrations_dir ใน wrangler.jsonc
npx wrangler secret put MFA_ENCRYPTION_KEY           # ค่า base64 ≥ 32 bytes
npm run deploy
```

สร้างผู้ดูแลระบบคนแรกบน D1 จริง:

```bash
node scripts/create-user.mjs --username admin --role super_admin --must-change --out .tmp/admin.sql
npx wrangler d1 execute hr-system-db --remote --file .tmp/admin.sql
```

ผู้ดูแลระบบต้องเปลี่ยนรหัสผ่านและตั้งค่า MFA ในการเข้าระบบครั้งแรก

> ห้าม commit `.dev.vars`, `.secrets/` หรือไฟล์ใด ๆ ที่มีรหัสผ่าน/คีย์ — ถูก ignore ไว้แล้วใน `.gitignore`
