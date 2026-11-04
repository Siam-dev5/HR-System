# Production Release — Migration 0007 + Phase D UI (final record)

**Status: RELEASED.**

- Migration 0007 is applied and verified.
- Worker `6cd27abe-6dab-478f-a92d-0fd55c6f24b1` is live from `main` @ `b947f6a`.
- Production is healthy. Public pages pass in the browser with 0 Worker exceptions, and data counts are unchanged apart from the migration's 4 permission rows.
- **Signed-in checks with real accounts are still open** (§8). They need a person with the Super Admin authenticator.

| Item | Value |
|---|---|
| Date (UTC) | 2026-11-04. The release ran 15:19–15:36. It is not a payroll processing day (runbook excludes the 10th–11th and month-end). |
| Repository | `Siam-dev5/HR-System`, local `D:\Programe Files\HR-3-in-1` |
| Released commit | `b947f6aa10c2d8e37b5782386ef018603b4f0179` |
| Merge to main | Fast-forward `eb1fc11 → b947f6a` (no merge commit, no force). It includes `8994cd4`, `6c6bda5`, `9f6748e` (period admin / step-up MFA) and `dca8701` (Phase D UI). `origin/main` = `origin/ui-redesign` = `b947f6a`. |
| Worker before → after | `b984f052-6300-4392-818f-f8580e1a104e` → **`6cd27abe-6dab-478f-a92d-0fd55c6f24b1`** (created 2026-11-04T15:31:14Z) |
| Production URL | `https://hr-system.siamhrbp.workers.dev` |
| D1 | `hr-system-db` (`ba67e6d1-61b6-44f7-8922-49401a2cb295`), migrations 0001–0007 |

## 1. Credentials (wrangler error 7403)

- The wrangler OAuth login is for account **Siamhrbp `f08eea3f…`** with `d1 (write)` scope, so the 7403 was not a missing permission.
- `wrangler whoami` refreshed the expired OAuth access token; after that the same read-only command (`d1 migrations list --remote`) succeeded.
- No credential was created, changed or printed.

## 2. Pre-release checks

- **Git:** `main` fast-forwarded to `b947f6a`; `npm ci` exit 0; `npm run check` on `main` exit 0 (typecheck, lint, build, **195/195** tests).
  - The `[ERROR] … reopen-closed … malformed JSON` in the test log is intentional. The archive-integrity test plants a corrupting trigger, expects 500 and verifies a full rollback.
- **Production before the migration (read-only):**
  - Only `0007_period_admin.sql` pending.
  - 59 tables, 896 rows.
  - payslips 0, payslip_archive 0, role_permissions 160, audit_logs 487, users 7, employees 46.
  - Periods `2026-11` (monthly) and `2026-11-M` (mid-month), both drafts, `updated_at` 2026-11-03 15:07:26 / 15:09:57.

## 3. Backup and restore test

| Item | Value |
|---|---|
| Backup file | `.secrets/backups/hr-system-db-pre-0007-20261104-152020.sql` (gitignored, not committed) |
| Size / statements | 269,069 bytes / 1,061 statements |
| SHA-256 | `a1e73f895346ddb07c408be528dae75bf65bdc4061c94dde2d318a2ba9ed96ef` (`.sha256` file alongside) |
| Time Travel bookmark (before 0007) | `00000073-00000000-00005119-48b25975fe7672a49081950348c1881b` |
| Restore file | `…-152020.restore.sql`, prepared by `scripts/prepare-d1-restore.mjs`: 60 tables, 902 inserts, 77 indexes |
| Restore target | Separate local D1 (`.tmp/restore-pre-0007-202611042220`) |
| Restore result | 59 tables and 896 rows: **identical to production for every table**; migrations 6; periods identical; `foreign_key_check` empty; `quick_check` ok |
| 0007 rehearsal on the restored copy | Only 0007 applied; role_permissions 160 → 164 (+4 super_admin); new `mfa_step_up` empty; every other count unchanged; period `updated_at` unchanged; `deleted_at` / `reopened_from` / `op_token` NULL; FK check empty; quick_check ok |

## 4. Migration 0007 on production

- **Command:** `npm run db:migrate:remote`
- **When:** started 15:30:11Z, completed 15:30:16Z
- **Result:** 14 statements, `0007_period_admin.sql ✅`, exit 0

| Check | Before | After | Pass |
|---|---|---|---|
| Pending migrations | 0007 | none | yes |
| Tables (excluding `d1_migrations`) | 59 | 60 (+`mfa_step_up`, empty) | yes |
| role_permissions | 160 | 164 (+`payroll.period.delete` / `edit_closed` / `force_recalculate` / `reopen` for super_admin) | yes |
| payslips / payslip_archive | 0 / 0 | 0 / 0 | yes |
| All other tables (audit 487, users 7, employees 46, …) | — | unchanged | yes |
| Periods `updated_at` | 15:07:26 / 15:09:57 | unchanged | yes |
| `deleted_at`, `reopened_from`, `op_token` on existing periods | — | NULL | yes |
| `PRAGMA foreign_key_check` | — | empty | yes |

## 5. Deployment

- **Command:** `npm run deploy` from `main` @ `b947f6a` (clean tree). Started 15:30:57Z.
- **Assets uploaded:** 5 changed (`styles.css`, `app.js`, `app.js.map`, `siamhrbp-logo.png`, `siamhrbp-logo@2x.png`); 3 unchanged.
- **Bindings:** `env.DB` = `hr-system-db` (D1, production), `env.ASSETS`, `APP_NAME`, `APP_BASE_PATH`.
- **Result:** Current Version ID `6cd27abe-6dab-478f-a92d-0fd55c6f24b1`. `wrangler deployments list` shows it at 100%.

## 6. Post-deploy verification (production)

| Check | Result |
|---|---|
| `GET /api/health` | 200 `{"ok":true,"database":"d1","tables":61}` |
| `GET /login`, `GET /` | 200 |
| Assets vs local build (SHA-256) | `styles.css`, `app.js`, `siamhrbp-logo.png`, `favicon.svg`, `theme-init.js`: **identical** |
| `siamhrbp-logo@2x.png` | 307 → `/assets/siamhrbp-logo%402x.png` → 200 `image/png`, SHA-256 identical (see §9) |
| Security headers | CSP, HSTS and `X-Frame-Options: DENY` unchanged |
| Browser check (Chromium, public pages only, no form submission) | **20/20 PASS.** Login and Register, light and dark, 1440 and 375, plus a 2× screen. Theme applied; logo loaded (1x on 1× screens, 2x on 2×), ≤ 200 px; no overflow; solid footer with exact colours; no console errors; no failed or ≥ 400 requests. Screenshots reviewed: `.tmp/prod-ui/` |
| Signed-out API boundary | `/api/meta`, `/api/dashboard`, `/api/payroll/periods`, `/api/payroll/periods/deleted`, `/api/attendance/imports`, `/api/admin/users`, `/api/notifications` all **401**; empty login 400 (validation); `/api/auth/policy`: MFA enforced for privileged roles |
| Live Worker log (`wrangler tail`) during the checks | 29 requests, all `ok`; **0 exceptions, 0 error logs** |
| New Worker's queries on the production schema (read-only) | Period list `WHERE p.deleted_at IS NULL` returns both periods; `mfa_step_up` 0 rows; archive 0 |
| Data after deploy vs after migration | **No change in any table.** Audit log still 487, with no events in the release window, so the verification wrote nothing. |

## 7. Files changed in this release step

- `docs/BACKUP-RECOVERY.md`: register entry for the pre-0007 backup, bookmark and Worker versions (runbook §5.7).
- `docs/DEPLOY-PERIOD-ADMIN.md`: status note (executed).
- `reports/PRODUCTION-RELEASE-FINAL.md` (this file); `reports/PHASE-D-PRODUCTION-RELEASE.md` status updated.
- These docs-only commits come after `b947f6a`. They do not change the running Worker, which was built from `b947f6a`.

## 8. Not verified by automation (needs a person)

These are runbook §5 items 2–5. They need signing in with real accounts, and privileged accounts require the owner's MFA authenticator. Decrypting a stored MFA secret to automate this would bypass MFA, so it was not done.

1. Sign in as HR / Payroll as normal. The payroll page must show `2026-11` and `2026-11-M` unchanged. Dashboard and attendance must open, and the new sidebar, header, footer and logo must appear.
2. Super Admin with MFA (id 4): the period-management buttons must be visible. Payroll Officer and HR Admin must not see them.
3. Open "ผลกระทบ" (impact) for a period, **read-only. Do not confirm** reopen, edit, delete or recalculate on real periods.
4. Super Admin id 1 (no MFA yet) must be forced to set up MFA (policy `security.mfa_enforce_privileged`).
5. Afterwards, recount audit logs, payslips and periods (or ask for the read-only count script to be run again).

## 9. Known issues

1. **`@` in the 2× logo path.**
   - Cloudflare's asset server answers `/assets/siamhrbp-logo@2x.png` with a 307 to `%402x`.
   - Browsers follow it and the image is correct (verified on a 2× screen), at the cost of one extra request on high-DPI screens.
   - Fix in the next release: rename it to `siamhrbp-logo-2x.png` (front end only).
2. `app.js.map` (source map) is published with the assets, as before this release. Removing it is optional hardening.
3. Phase E (module internals: tall mobile table rows, chart label wrapping) is not started. CI for `tests/ui` is not wired (documented in `tests/ui/README.md`).
4. Earlier open decisions remain: login-TOTP replay protection and a self-hosted Thai font.

## 10. Rollback reference

| Situation | Action |
|---|---|
| New Worker misbehaves | `npx wrangler rollback b984f052-6300-4392-818f-f8580e1a104e`. **No database change needed:** 0007 is additive and the old Worker works on it (runbook §6). |
| Rollback after a period was soft-deleted | Check first: `SELECT id, deleted_code FROM payroll_periods WHERE deleted_at IS NOT NULL` (the old Worker shows them as `<code>~deleted~<id>`) |
| Data recovery needed | Owner's written decision. Bookmark `00000073-00000000-00005119-48b25975fe7672a49081950348c1881b` or the backup file above. Data after the bookmark would be lost. |
| Code | `main` / `ui-redesign` @ `b947f6a`; previous production code = `eb1fc11` (Worker `b984f052`) |

## 11. Final production status

**Live and healthy on Worker `6cd27abe-6dab-478f-a92d-0fd55c6f24b1`, D1 at migration 0007.** Automated verification passed.

Before you call the release fully accepted, the signed-in checks in §8 should be done by the system owner.
