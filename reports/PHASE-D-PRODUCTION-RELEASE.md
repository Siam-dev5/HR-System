# Phase D Production Release — Record

**Superseded (2026-11-04 15:31Z):** after approval of migration 0007 and the credential refresh, the release was completed: Worker `6cd27abe-6dab-478f-a92d-0fd55c6f24b1` from `main` @ `b947f6a`. See `reports/PRODUCTION-RELEASE-FINAL.md`. The record below describes the earlier blocked attempt.

**Status at the time: COMMIT and PUSH done. PRODUCTION DEPLOY NOT PERFORMED (blocked; see §4).**

| Item | Value |
|---|---|
| Date | 2026-11-04 |
| Repository / remote | `D:\Programe Files\HR-3-in-1` → `origin` = `https://github.com/Siam-dev5/HR-System.git` |
| Branch | `ui-redesign` (new on the remote; `main` untouched at `eb1fc11`) |
| Starting HEAD | `9f6748e` |
| Phase D commit | `dca8701a33ad2996fc9ce64ffef3061d30e350b3` — `feat(ui): finalize Phase D responsive HR system redesign` (27 files) |
| Push | `git push -u origin ui-redesign` → `* [new branch]`, exit 0, no force. GitHub API: branch `ui-redesign` = `dca8701…`, commit has 27 files. |
| Production Worker | `hr-system` (`wrangler.jsonc`: name `hr-system`, main `src/worker/index.ts`, assets `public`, D1 `hr-system-db` `ba67e6d1-…`) |
| Production URL | `https://hr-system.siamhrbp.workers.dev` |
| Production version (unchanged) | `b984f052-6300-4392-818f-f8580e1a104e`, deployed 2026-11-03T15:33Z |
| New deployment ID / version | **none: not deployed** |

## 1. Preflight

- **Repository:** project root, branch `ui-redesign` and HEAD `9f6748e` verified; remote `origin` checked (the remote had only `main` before the push).
- **Staged files:** nothing was staged at the start. Phase D files were staged by explicit path; the staged set was checked against the expected list (27 files, nothing else).
- **Secrets and ignored files:** `.dev.vars`, `.secrets/` and `.tmp/` are present and gitignored. The secret and personal-data scan of the staged diff was clean (no tokens, keys, emails, 13-digit IDs or phone numbers).
- **Dependencies:** consistent (`npm ls`). The only new package is `playwright-core@1.64.1` (dev, no transitive dependencies). `npm audit --omit=dev`: 0 vulnerabilities.

## 2. Final tests (exit codes captured directly)

| Step | Exit | Result |
|---|---|---|
| `npm run typecheck` | 0 | — |
| `npm run lint` | 0 | 0 problems |
| `npm run build` (includes `wrangler deploy --dry-run`) | 0 | 0 warnings |
| `npm test` (unit + integration) | 0 | 195 / 0 |
| ui-smoke · ui-auth · ui-header | 0 · 0 · 0 | 18/0 · 31/0 · 179/0 |
| ui-footer · ui-workstreams · ui-period-admin | 0 · 0 · 0 | 110/0 · 96/0 · 24/0 |
| ui-c3 (first run) | **1** | 156 / **1**: see below |
| ui-d | 0 | 273 / 0 |
| ui-c3 + ui-d after the fix (`npm run test:ui -- --only ui-c3,ui-d --baseline .tmp/ui-baselines/phase-c`) | 0 · 0 | 157/0 (36 content comparisons at 0 px) · 273/0 (44 at 0 px) |
| typecheck · lint · build before the commit | 0 · 0 · 0 | — |

**The pre-release ui-c3 finding:**

- "content light leave-1440" differed by 24,582 px. It reproduced in the full sequence but was 0 px in isolation.
- **Cause:**
  - All differing pixels were in the light page background, ±1 level (e.g. `237,245,253` vs `238,245,253`) in alternating rows: Chrome's gradient dithering, which depends on earlier rasterisation in the tab.
  - Dark mode (no gradient) passed.
  - No text, table, button or badge pixel differed.
- **Fix:**
  - Content comparisons switch off the background gradient image in both captures; the background colour is still compared.
  - 0 px tolerance unchanged.
  - Committed in `dca8701`.

**Totals before the commit:** 1,083 checks passed and 0 open failures. There are no known critical or high defects in the Phase D work.

## 3. Files in the commit

- **Application (front end):** `public/assets/styles.css`, `public/assets/siamhrbp-logo.png`, `public/assets/siamhrbp-logo@2x.png`, `src/web/icons.ts`, `src/web/main.ts`, `src/web/header.ts`, `src/web/pages/auth.ts`
- **Tests and tooling:** `tests/ui/**` (8 suites, harness, fixtures, `lib/env.mjs`, `make-baseline.mjs`, `run-all.mjs`, `README.md`), `eslint.config.js`, `package.json`, `package-lock.json`
- **Docs:** `README.md`, `reports/FINAL-EXECUTION-REPORT.md`, `reports/TEST-RESULTS.md`
- **Not changed by Phase D:** `src/worker/**`, `src/shared/**`, `migrations/**`, `wrangler.jsonc`, `public/_headers`, `public/index.html`

## 4. Why the production deploy was not performed

The release request assumed Phase D is front-end only and needs no database change. That is true of the Phase D commit itself, but **not of what a deploy of this branch ships**:

1. **A Worker deploy ships the whole branch.**
   - Cloudflare deploys the Worker code and the static assets together.
   - `ui-redesign` contains, below Phase D, three release commits that have never been deployed: `8994cd4`, `6c6bda5`, `9f6748e`.
   - They change 642 lines of backend code (`src/worker/routes/payroll.ts`, `auth.ts`, `lib/step-up.ts`, `payroll-engine.ts`, `overview.ts`, `attendance.ts`, …) and add **migration 0007**.
2. **That backend code requires migration 0007.** It reads columns and tables that 0007 creates, in 17 queries across payroll, overview, attendance and the payroll engine:
   - `payroll_periods.deleted_at`
   - `payroll_periods.op_token`
   - `payroll_periods.reopened_from`
   - `payslip_archive.op_token`
   - the `mfa_step_up` table
3. **Production does not have 0007.** A read-only query (`SELECT name FROM d1_migrations`, `changed_db: false`) shows 0001–0006 only.
   - Deploying without 0007 would make the production payroll period list, the Executive Dashboard and attendance pages fail with "no such column".
4. **Applying 0007 is a schema change on the production database, which holds real payroll data.**
   - The request said not to run migrations unless necessary.
   - The project runbook `docs/DEPLOY-PERIOD-ADMIN.md` requires, in order: a verified backup (`wrangler d1 export --remote`), a local restore test, the migration, then the deploy.
5. **The backup step cannot run with the current credentials.** `wrangler d1 migrations list --remote` fails with Cloudflare error 7403 ("account … not authorized to access this service"), so the export the runbook requires is not possible with wrangler right now.
6. **A front-end-only deploy is not a safe alternative.** The Phase D SPA includes the period-management UI from `6c6bda5`, which calls API routes that the deployed backend (`b984f052`) does not have, and mixing builds is untested.

Deploying anyway would therefore either break production pages, or change the production schema without the approved backup procedure. Neither is covered by the approval as given, so the deploy was stopped before any production change.

## 5. Production verification (read-only, current state)

| Check | Result |
|---|---|
| `GET /api/health` | 200 `{"ok":true,"database":"d1","tables":60}` |
| `GET /login` | 200 `text/html` |
| `GET /assets/styles.css` | 200 `text/css`, 33,684 bytes (the pre-redesign stylesheet, as expected) |
| `GET /assets/siamhrbp-logo.png` | 200 `text/html` (SPA fallback: the logo is not deployed, as expected) |
| Active version | `b984f052-6300-4392-818f-f8580e1a104e` (`wrangler deployments list`) |
| D1 migrations | 0001–0006 applied, 0007 pending |

No production data, configuration, secret or version was changed.

## 6. What is needed to complete the release

1. **Credentials:** a wrangler login or API token with D1 access to account `f08eea3f…` (fixes error 7403).
2. **Your explicit approval for migration 0007 on production** (additive only: 6 new columns, 1 index, 1 table, 4 permission rows; no existing row changed). It goes with the earlier release `9f6748e`, which still awaits written deployment approval.
3. **Then follow `docs/DEPLOY-PERIOD-ADMIN.md`:**
   1. record the version;
   2. `d1 export` backup plus SHA-256;
   3. local restore test;
   4. `npm run db:migrate:remote` (0007 only);
   5. `npm run deploy` from `dca8701`;
   6. post-deploy checks (health, login, assets incl. both logos, shell at desktop and mobile, light and dark, console errors, active version = the new one).

**Rollback reference:**
- **Worker:** `npx wrangler rollback b984f052-6300-4392-818f-f8580e1a104e`. 0007 is additive, so the old Worker keeps working on the migrated schema.
- **Code:** branch `ui-redesign` at `dca8701`. The previous release state is `9f6748e`; production code corresponds to `b984f052`.

## 7. Known issues (unchanged)

- Phase E not started: tall mobile table rows, wrapping chart labels.
- System font stack only (the CSP blocks Google Fonts).
- CI workflow not wired (example in `tests/ui/README.md`).
- The source of the official 2× logo is `D:\siamhrbp\LOGO SIAM-HRBP Full.png` (outside the repository).
