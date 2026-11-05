# Browser tests (`tests/ui`)

End-to-end checks of the real SPA in Chromium (Playwright, via `playwright-core`). Each suite:

- builds the web bundle;
- creates a **fresh local D1** under `.tmp/` (migrations, `seeds/demo.sql`, synthetic users with random passwords);
- starts `wrangler dev --local` on a free port, runs, and stops the server.

Nothing touches a remote database or production. `ui-footer` refuses any non-local base URL.

| Suite | Covers |
|---|---|
| `ui-smoke` | Sign-in, menu per role, every menu page renders |
| `ui-auth` | Login, registration, pending accounts, forced MFA, MFA login, mobile layout |
| `ui-header` | Company switcher, theme, user menu, notifications, keyboard, dark theme, print |
| `ui-footer` | Fixed solid footer on every layout, nothing hidden behind it, LINE link, EWF card |
| `ui-workstreams` | Feishu import (synthetic fixtures), OT review, payroll preview and export, payslip YTD, org design, RBAC |
| `ui-period-admin` | Super Admin payroll-period management with step-up MFA |
| `ui-org` | Organization chart: employee photos (private API, initials fallback, broken photo, self-contained SVG export), floating zoom toolbar (zoom, wheel, drag-pan, fit, reset, expand / collapse all), node expand / collapse, department chips (API counts, cross-department context, no double counting), search + filter, reports-to loop, multi-company, 1440 / 1024 / 768 / 375, light / dark, keyboard, read-only (fails on any write to `/api/org-design`) |
| `ui-avatar` | Employee photo in the employee form: initials fallback, pick → preview → upload with progress → replace → remove (confirmed), client-side rejection, view-only users without controls, org chart picks up the photo, light / dark, 1440 / 768 / 375 |
| `ui-holidays` | Holiday Calendar: month / year view with Buddhist years, approved vs draft, add holiday (draft), list search, import with preview (invalid rows flagged, drafts only), Excel export, work / pay-rule tabs, view-only employee without controls, light / dark, 1440 / 768 / 375 without overflow |
| `ui-sidebar` | Collapsible sidebar: expanded by default, collapse / expand (260 ↔ 76px, `aria-expanded`, labels, tooltip on hover and focus), `hr.sidebar.collapsed` restored on reload and safe when storage throws, brand header fixed while only the menu list scrolls, active item and navigation in both modes, content width follows, mobile drawer (Escape, tap outside) unaffected, no overflow at 1440 / 1024 / 768 / 375; menu groups open / close independently (button, keyboard), `hr.sidebar.groups` restored on reload, icon-only mode shows every item, saved group states return on expand, drawer keeps them |
| `ui-c3` | Sign-in screens (logo, overflow, hooks, stacking); **page content** vs a baseline (shell hidden) |
| `ui-d` | App shell: sidebar, header, footer, drawer, skip link, focus, contrast, reduced motion, print, 2× logo; content and sign-in screens vs a baseline |
| `ui-design-shots` | Screenshot harness for design review (no assertions) |

`fixtures/mkfixture.ts` writes synthetic Feishu-style files (no real personal data). `lib/env.mjs` holds the shared helpers: repository root, browser discovery, free ports, result folders, server start and stop, and screenshot comparison.

## Run locally

```bash
npm ci
# a Chromium for Playwright, once (skip if one is already in the ms-playwright cache):
npx playwright-core install chromium

npm run test:ui                                   # all suites, one after another
npm run test:ui -- --only ui-auth,ui-header       # a subset
node tests/ui/ui-header.mjs                       # one suite directly
```

**Browser discovery:**

1. `CHROMIUM_PATH`
2. the Chromium matching the installed `playwright-core`
3. the newest `chromium-*` already in the ms-playwright cache (`PLAYWRIGHT_BROWSERS_PATH`, or the platform default)

**Outputs:** results and screenshots go to `.tmp/ui-results/` (gitignored); set `UI_RESULTS_DIR` to change this. `run-all` writes `logs/<suite>.log` and `summary.json` there with every suite's own exit code. It exits 1 if any suite fails.

## Visual regression baselines

`ui-c3` and `ui-d` compare the working tree with a **baseline**: a folder with `styles.css` and `app.js` served in place of the current ones in the same browser session.

- Without `--baseline`, those comparisons are **SKIPPED** and printed as `SKIP` (they never count as passes).
- `ui-c3` compares only page content (the `<main>` box, or a dialog), with the sidebar, header and footer hidden in both captures, at 0 px tolerance and with an identical layout box.
- `ui-d` compares the same content, plus the sign-in screens with the same footer style in both captures.

```bash
npm run test:ui:baseline -- origin/main            # -> .tmp/ui-baselines/origin_main
npm run test:ui -- --baseline .tmp/ui-baselines/origin_main
```

`make-baseline.mjs` reads `src/` and `styles.css` at the ref with `git show` and bundles them like `scripts/build-web.mjs`. It never touches the index or the working tree.

Use as the baseline the commit the change should **not** visibly differ from in page content: usually the target branch, or the commit before a shell-only change.

## CI (example: GitHub Actions)

```yaml
ui-tests:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
      with: { fetch-depth: 0 }          # make-baseline needs the baseline commit
    - uses: actions/setup-node@v4
      with: { node-version: 24, cache: npm }
    - run: npm ci
    - run: npx playwright-core install --with-deps chromium
    - run: npm run check                # typecheck, lint, build, unit + integration
    - run: npm run test:ui:baseline -- origin/${{ github.base_ref || 'main' }} .tmp/ui-baselines/base
    - run: npm run test:ui -- --baseline .tmp/ui-baselines/base
    - if: always()
      uses: actions/upload-artifact@v4
      with: { name: ui-results, path: .tmp/ui-results }
```

**Notes:**

- The suites run sequentially (each starts its own server).
- A full run takes about 15–20 minutes.
- Several suites wait for a fresh 30-second TOTP step, because step-up MFA codes are single-use.
- No secrets are needed: each run generates its own `MFA_ENCRYPTION_KEY` and user passwords, and they are never written outside `.tmp/`.
