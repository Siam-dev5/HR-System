# Production Release — Phase E + E.1 (Org Chart UX + Employee Photos on R2)

**Status: RELEASED and verified in production.**

- Migration **0008** is applied.
- Worker **`c50ce2c5-4fcc-46db-ba12-4a6d3bab7fd5`** is live from `main` @ `342e642`, with the R2 binding `AVATARS`.
- The upload, read, replace and delete flow was verified on production with a self-removing test fixture.
- **Payroll and real employee data are unchanged** (fingerprint identical).

| Item | Value |
|---|---|
| Release window (UTC) | 2026-11-04 19:10 – 19:30 (2026-11-05 Thai time; not a payroll processing day) |
| Repository | `Siam-dev5/HR-System` |
| Feature branch / commits | `feature/org-chart-avatar-r2` (from `feature/org-chart-ux-phase-e`): `b9a78c0` (Phase E), `4804ee6` (Phase E.1). Local backup ref: `backup/org-chart-ux-phase-e-20261105` → `b9a78c0`. |
| Pull request | **#1**, merged with merge commit **`342e642`** (no force push) |
| Worker before → after | `6cd27abe-6dab-478f-a92d-0fd55c6f24b1` → **`c50ce2c5-4fcc-46db-ba12-4a6d3bab7fd5`** (created 19:23:39Z) |
| Bindings (deploy output) | `env.DB` = `hr-system-db` (D1), **`env.AVATARS` = `hr-system-employee-assets` (R2)**, `env.ASSETS` |
| D1 | migrations 0001–0008 |
| R2 bucket | `hr-system-employee-assets`: `r2.dev` public access **disabled**, **no** custom domain, 0 objects after the test |

## 0. Where each fact comes from

**Verified automatically from this repository** (re-checked when this record was committed; anyone can repeat these checks):

| Fact | Check |
|---|---|
| `b9a78c0` (Phase E) and `4804ee6` (Phase E.1) are in `main` | `git merge-base --is-ancestor <sha> 342e642` → exit 0 |
| `342e642` is the merge of PR #1 | `git log -1 342e642`: parents `40dcc88` + `4804ee6`, "Merge pull request #1: Phase E + E.1 …" |
| Migration 0008 exists | `migrations/0008_employee_avatars.sql` |
| R2 binding `AVATARS` → `hr-system-employee-assets` | `wrangler.jsonc` → `r2_buckets` |
| Backups cannot be committed by accident | `git check-ignore .secrets/backups/<file>.sql` → matched by `.gitignore` (`.secrets/`) |

**Reported by the release operator** (recorded in the release session's logs and command output; not re-checkable from git alone):
- the production migration, deploy and Worker version;
- the bucket's private state;
- the backup file, its SHA-256 and the Time Travel bookmark;
- the restore test;
- the test results (sections 2–5);
- the payroll fingerprint.

To re-confirm them:
- **Production state:** `npx wrangler deployments list`, `npx wrangler d1 migrations list hr-system-db --remote`, and the bucket settings in the Cloudflare dashboard.
- **Test results:** run `npm run check` and `node tests/ui/run-all.mjs` on `342e642`.

**Still open (UAT):** sign-in with real privileged accounts (Super Admin, HR Admin, Payroll) needs their MFA. That sign-in, and a visual check of the employee photo panel and the org chart, must be done once by a person. See section 7.

## 1. What was built

| Area | Implementation |
|---|---|
| Storage | Photo bytes only in the private R2 bucket. Metadata in D1 `employee_avatars` (migration 0008): `employee_id` (PK, FK, on-delete cascade), unique versioned `object_key` `employees/{company}/{employee}/avatar/{uuid}.{ext}`, `content_type` (JPEG/PNG/WebP check), `size_bytes` (≤ 5 MB check), `updated_at`, `updated_by` |
| API | `GET /api/employees/:id/avatar` (bytes), `GET …/avatar/meta`, `PUT …/avatar` (raw body), `DELETE …/avatar` |
| Access | Session required (401). CSRF header `x-hr-requested` (403). Reading needs `employees.view`, changing needs `employees.update`, with the employees module's row rule: `employees.all`, or else the user's own record. Same rule as the CRUD module. |
| Validation | Size ≤ 5 MB (checked on `content-length` and while reading); declared type JPEG/PNG/WebP; **file signature** must match the declared type; structure checks (PNG IHDR/IEND, JPEG EOI, WebP RIFF size/chunk) |
| Responses | `cache-control: private, no-store`, `content-security-policy: default-src 'none'; sandbox`, `nosniff`, same-origin resource policy |
| Replace / delete | New object first, then a **conditional** metadata swap (compare-and-swap on the old key), then the old object is deleted. A failure at any step keeps the last valid photo, and metadata never points at a missing object. A concurrent change gets 409, and the losing upload removes its own object. Delete: metadata first, then the object. |
| Audit | `employee.avatar_uploaded` / `_replaced` / `_deleted`, with type, size and keys only (never bytes) |
| Employee form | Photo panel with: initials fallback, file picker, preview (`data:` URL, CSP-safe), client-side resize to ≤ 512 px WebP (also **strips EXIF/GPS**), upload progress, replace, remove with confirmation, clear errors. Controls appear only when the API says the user may change the photo. |
| Org chart | Round photo or initials area on every card. Card size (210×66), department colours, the **toolbar at the top**, and all Phase E controls are unchanged. A failed photo falls back to initials. SVG/PNG export inlines the photos (self-contained). |

**Not changed:** payroll calculation, payslips, salary, attendance, payroll periods, authentication, MFA, RBAC grants, security headers, migrations 0001–0007.

## 2. Tests before the merge (commit `4804ee6`, clean tree)

| Step | Exit | Result |
|---|---|---|
| typecheck · lint · build (incl. `wrangler deploy --dry-run` with the R2 binding) | 0 · 0 · 0 | — |
| `npm test`: unit + integration | 0 | **236 / 236** (10 files) |
| … of which avatar unit tests | | 16: validation (valid JPEG/PNG/WebP; unsupported type; forged signature; type mismatch; truncated; > 5 MB; empty), storage protocol (upload/replace/delete; **R2 write failure; D1 failure after R2 write; old-object delete failure; concurrent change; delete failures**), Thai/Latin initials |
| … of which avatar integration tests (wrangler dev + local R2) | | 15: 401 / CSRF 403; only `employees.update` may change; employee cannot read another employee's photo (403); HR permission checks; upload, exact bytes and headers; replace (old object gone); WebP; every rejection leaves metadata unchanged; concurrent uploads consistent; delete; audit entries; org-chart version field; no payroll impact |
| Browser suites (10) | all 0 | smoke 18 · auth 31 · header 179 · footer 110 · workstreams 96 · period-admin 24 · **org 69** (incl. photos, broken-photo fallback, self-contained export, initials contrast, toolbar at the top) · **avatar 21** (form flow, progress, preview, replace, remove, client rejection, view-only users, light/dark, 1440/768/375) · c3 157 · d 273 |
| `npm run check` on merged `main` (`342e642`) | 0 | 236 / 236 |

**Problems found and fixed during the work:**
1. **The org Export menu could appear off-screen for a moment on phones.** It was positioned in an asynchronous `toggle` handler. It's now placed by CSS from the first frame: right-anchored, and a full-width sheet on phones. Two consecutive reruns passed.
2. **One `ui-header` run crashed:** a 30-second wait for the login form at one user switch, with no assertion failure. It did not reproduce: 179/179 in two isolated reruns and in the final full run.
3. **ESLint:** a misleading Thai character class was replaced by code-point ranges.
4. **Several test-side fixes:** typing, waiting for the image to load before asserting, and a deliberate 403 probe moved outside the page console. No assertion was loosened.

## 3. Production release steps

| Step | Result |
|---|---|
| Pre-check (read-only) | Worker `6cd27abe`; only `0008_employee_avatars.sql` pending; 60 tables / 910 rows; payroll fingerprint recorded |
| **Backup** | `.secrets/backups/hr-system-db-pre-0008-20261104-191211.sql` (gitignored), 273,081 bytes, 1,078 statements. **SHA-256 `d1ce85d74b567af61e5d72e98fdeb0d39f79b128d846574f0695307bc9b8f52d`**. Time Travel bookmark `0000007d-00000000-00005119-771132f56414da6b76a36e0ec8ea7001` |
| Restore test (separate local D1) | 60 tables / 910 rows, **identical to production**; FK check empty; `quick_check` ok |
| 0008 rehearsal on the restore | ✅; only the new empty `employee_avatars`; everything else unchanged |
| **Migration 0008 on production** | ✅ 19:22:45Z (2 statements); no pending migrations; only the new empty table; periods unchanged; FK check empty |
| **Deploy** | `npm run deploy` from `main` @ `342e642`. Version `c50ce2c5-4fcc-46db-ba12-4a6d3bab7fd5`; bindings DB + **AVATARS** + ASSETS |

## 4. Post-deploy verification (production)

| Check | Result |
|---|---|
| Active version | `c50ce2c5…` at 100% |
| `/api/health` | 200 `{"ok":true,"tables":62}` (61 app tables + D1's migration table) |
| Assets vs build (SHA-256) | `styles.css`, `app.js`, logo, favicon: identical |
| Public pages in Chromium | 20/20: Login/Register, light/dark, 1440/375 and 2×; no console errors, no failed requests |
| Avatar API signed out | GET / PUT / DELETE / meta → **401**; PUT without the CSRF header → **403 csrf** |
| R2 public access | `r2.dev` disabled, no custom domain |
| **Upload / read / replace / delete on production** (dedicated fixture) | **14/14 PASS** (details below) |

**Production avatar test, with a dedicated fixture that removed itself:**
- **Fixture:** inactive company `ZZTEST`, one resigned `zz_test` employee without salary (dates in 2000, so outside payroll, dashboard, org chart and current analytics), and a non-privileged `hr_staff` user `zz_avatar_test` with a random password that was never printed.
- **RBAC:** HR staff reach the menu, employees and the org chart (200); payroll periods and user admin return **403**.
- **Refusals:** anonymous read 401; missing CSRF header 403; forged SVG declared as PNG **415**.
- **Upload JPEG:** D1 row created; R2 holds **exactly** the uploaded bytes under `employees/10/55/avatar/<uuid>.jpg`; reading through the Worker gives the same bytes, `image/jpeg`, `private, no-store` and the sandbox CSP.
- **Replace with PNG:** new object and metadata; **old R2 object removed**.
- **Delete:** metadata and object gone; meta reports no photo.
- **Audit:** `uploaded`, `replaced`, `deleted`, metadata only.
- **Cleanup:** the test user (with its sessions and roles), the employee and the company were deleted; the credential file was removed.

## 5. Payroll and real data unchanged

- **Payroll fingerprint: identical before and after:**
  - payslips 0, archive 0;
  - employees 46, salary sum identical (exact amount kept out of git), last update 2026-11-03 11:11:44;
  - periods 2, last update 2026-11-03 15:09:57;
  - salary history 0, attendance 0.
- **Every table count is identical to the pre-release snapshot,** except:
  - `audit_logs` +5: the test's own login, uploaded, replaced, deleted and logout;
  - the new empty `employee_avatars`.
- **No avatar audit entry concerns any real employee.** The R2 bucket has 0 objects.

## 6. Rollback reference

| Situation | Action |
|---|---|
| Worker problem | `npx wrangler rollback 6cd27abe-6dab-478f-a92d-0fd55c6f24b1`. It works on schema 0008 (the table is additive), but the previous Worker has no avatar API, so photos are simply not shown. |
| Data | Owner's written decision; bookmark `0000007d-00000000-00005119-771132f56414da6b76a36e0ec8ea7001` or the backup above |
| Photos | Not part of the D1 backup (R2). The metadata is in D1, so after a D1 restore any photo whose object is missing falls back to initials. |

## 7. Remaining limitations

1. **The test fixture user was `hr_staff`.** Privileged roles (Super Admin, HR Admin, Payroll) need MFA, so their sign-in, and the visual check of the employee form and org chart with real accounts, should be done once by a person.
2. **Employees cannot upload their own photo.** Self-service read is supported (own photo only); upload needs `employees.update`, as the RBAC is today. Allowing self-upload would be a permission decision.
3. **Orphan objects are possible.** If the old R2 object can't be deleted after a successful replace (an R2 outage), it stays unreferenced. Its key is recorded in the audit entry (`orphan_key`) for later removal. Nothing user-visible breaks.
4. **Photos aren't cached** (`private, no-store`, as requested), so the org chart re-downloads photos on each render. That's fine at the current size (≤ 512 px each).
5. **Photos appear in the employee form and org chart only.** The header/user menu and ESS still show initials only (a possible follow-up).
6. **Process hygiene:** a `wrangler tail hr-system` started during the previous release verification is still running on this machine (it only reads production logs into `.tmp/prod-tail.jsonl`). This session isn't permitted to stop processes; please close it (Task Manager → the `node … wrangler … tail` processes), or it will end at the next reboot.
