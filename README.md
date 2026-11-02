# HR System

ระบบบริหารทรัพยากรบุคคลแบบครบวงจร (HRM · HRD · HROD · Payroll) ทำงานบน **Cloudflare Workers** และใช้ **Cloudflare D1** เป็นฐานข้อมูลหลัก

| ส่วน | เทคโนโลยี |
|---|---|
| API | [Hono](https://hono.dev) บน Cloudflare Workers (TypeScript) |
| ฐานข้อมูล | Cloudflare D1 (SQLite) — migrations ใน `migrations/` |
| หน้าเว็บ | SPA เขียนด้วย TypeScript ล้วน (ไม่มี framework) bundle ด้วย esbuild → `public/assets/app.js` |
| ทดสอบ | Vitest — unit tests และ integration tests ที่รัน `wrangler dev` กับ D1 ภายในเครื่องจริง |

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
tests/             unit + integration
```

## โมดูล

- **ภาพรวม**: Executive Dashboard, ESS (ข้อมูลของฉัน + ลงเวลา), สลิปเงินเดือนของฉัน, HR Analytics, คำขอ & อนุมัติ
- **HRM**: ผังองค์กร, หน่วยงาน, Job & Position, พนักงาน, Onboarding, Offboarding, อัตรากำลัง, สรรหา (ATS) + ผู้สมัคร, เวลาทำงาน, กะ/ตารางกะ, แก้ไขเวลา, OT, การลา, รอบประเมิน, ประเมินผล KPI/OKR, Talent 9-Box
- **HRD**: Competency, ทักษะ, Skill Matrix & Gap, TNA, หลักสูตร, อบรม/LMS, ผู้เข้าอบรม, OJT, IDP, Career Path
- **HROD**: Organization Design, Workforce Planning, Engagement & eNPS, OD Projects
- **Payroll**: งวดเงินเดือน (สร้าง → คำนวณ → อนุมัติ → เผยแพร่), สลิปเงินเดือน (HR), รายการเงินได้/เงินหัก, เงินได้/เงินหักประจำรายคน
- **System**: บริษัท/สาขา/Cost Center/ประเภทการลา, Workflow Engine, เอกสาร, รายงาน & Export, PDPA, Audit Log, ผู้ใช้, บทบาท & สิทธิ์, ตั้งค่าระบบ, ความปลอดภัย & MFA, คู่มือ

## หลักการออกแบบที่สำคัญ

- **เมนู = Route = สิทธิ์**: เมนูสร้างจาก `src/shared/modules.ts` และกรองด้วยสิทธิ์เดียวกับที่ API ใช้ ผู้ใช้จะไม่เห็นเมนูที่เปิดไม่ได้ หากเปิด URL ตรง ๆ จะได้หน้า 403 ที่บอกสิทธิ์ที่ต้องใช้ — มี integration test ยืนยันว่าทุกเมนูของทุกบทบาทเปิดได้จริง
- **ลิงก์บน Dashboard/การแจ้งเตือน** คำนวณที่ server: แสดงเป็นลิงก์เฉพาะเมื่อผู้ใช้มีสิทธิ์เปิดปลายทาง URL ภายนอกไม่ถูกต่อกับ base path
- **Dropdown ทุกตัว** ใช้สัญญา `LookupOption { value, label, code, parentId, depth }` โดย `label` รับประกันว่าไม่ว่าง
- **Workflow**: คำขอลา/OT/แก้ไขเวลาเข้าสู่การอนุมัติตามบทบาท ผู้ยื่นอนุมัติคำขอของตนเองไม่ได้ การแก้ไขเวลาที่อนุมัติแล้วจะปรับข้อมูลลงเวลาอัตโนมัติ
- **Payroll**: ผู้อนุมัติต้องไม่ใช่ผู้คำนวณ (ตั้งค่าได้) อัตราประกันสังคม/ฐานค่าจ้างปรับได้ในหน้า ตั้งค่าระบบ
- **ความปลอดภัย**: รหัสผ่าน PBKDF2-SHA256 (100k), session token เก็บเป็น SHA-256 ใน D1 และ cookie HttpOnly/SameSite=Strict, CSRF header, ล็อกบัญชีตามนโยบาย, MFA (TOTP) บังคับสำหรับบทบาทสิทธิ์สูงตามค่าตั้ง (ข้อความหน้า Login มาจากค่าตั้งจริง), secret TOTP เข้ารหัส AES-GCM, ข้อมูลอ่อนไหว (เงินเดือน บัญชีธนาคาร เลขภาษี) ถูกปิดบังหากไม่มีสิทธิ์ `*.sensitive`, CSP เข้มงวด
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
```

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
