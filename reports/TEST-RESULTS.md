# Test Results — UI Redesign (Phases B–D, finalized), branch `ui-redesign`

Final run: 2026-11-04, 20:35–21:12, local machine only (local `wrangler dev` + throwaway local D1 under `.tmp/`).
Every exit code below is the command's own, captured immediately after it ran.

## Summary

| # | Step | Command | Exit | Pass | Fail | Skip |
|---|---|---|---|---|---|---|
| 1 | Typecheck | `npm run typecheck` (worker, web, test tsconfigs) | 0 | — | — | — |
| 2 | Lint | `npm run lint` (`eslint .`, includes `tests/ui`) | 0 | — | 0 problems | — |
| 3 | Build | `npm run build` (web bundle + `wrangler deploy --dry-run`; nothing deployed) | 0 | — | 0 warnings | — |
| 4 | Unit + integration | `npm test` (vitest, 7 files, 526 s) | 0 | 195 | 0 | — |
| 5 | ui-smoke | `npm run test:ui -- --baseline .tmp/ui-baselines/phase-c` | 0 | 18 | 0 | 0 |
| 6 | ui-auth | (same run) | 0 | 31 | 0 | 0 |
| 7 | ui-header | (same run) | 0 | 179 | 0 | 0 |
| 8 | ui-footer | (same run) | 0 | 110 | 0 | 0 |
| 9 | ui-workstreams | (same run) | 0 | 96 | 0 | 0 |
| 10 | ui-period-admin | (same run) | 0 | 24 | 0 | 0 |
| 11 | ui-c3 (baseline: Phase C) | (same run) | 0 | 157 | 0 | 1 * |
| 12 | ui-d (baseline: Phase C) | `npm run test:ui -- --only ui-d --baseline .tmp/ui-baselines/phase-c` (rerun, see below) | 0 | 273 | 0 | 0 |
| 13 | ui-c3 (baseline: Phase B, with reference) | `node tests/ui/ui-c3.mjs --baseline .tmp/ui-baselines/phase-b --ref .tmp/design-refs/ref-login.png` | 0 | 157 | 0 | 0 |
| 14 | Lint after the last test edit | `npm run lint` | 0 | — | 0 problems | — |

\* The skip is the reference side-by-side image, which needs `--ref`. The reference image is local only and not in the repository. Row 13 ran it.

**Totals:** 1,083 checks passed and 0 failed (195 unit/integration + 888 browser). Row 13 adds a further 157 passes against the Phase B baseline.

**The `ui-d` rerun.** The first `ui-d` run in this session (inside step 5) had 272 passes and 1 failure. The failure was a new check written wrongly:

- It expected `naturalWidth = 508` for the 2× logo.
- For a `srcset` "2x" candidate, browsers report the density-corrected size, 508 / 2 = 254. That is per the HTML specification, not an app defect.
- The check now verifies more, not less:
  - the chosen file is `@2x.png`;
  - the density-corrected size is 254×128;
  - the file itself decodes to 508×256 px;
  - the layout width is still 200 px.
- Only `ui-d` was rerun: 273/0.

## ui-c3 (reworked): page content, not the shell

`ui-c3` no longer compares whole screens. Its 36 content comparisons (8 pages × 1440/375 × light/dark, plus a dialog and the empty state, ×2 themes) work like this:

- The sidebar, header, footer, skip link and toasts are hidden with `visibility: hidden` **in both captures**, so the layout is unchanged.
- A page is compared as its `<main>` box; the dialog is compared over the whole viewport.
- The tolerance is **0 px**, and the `<main>` layout box must be identical.

The sign-in checks are unchanged:
- logo ≤ 200 px and never upscaled;
- alt text present, old badge gone;
- white plate in dark mode;
- test hooks present;
- brand stacked above the card on narrow screens;
- no overflow, no console errors.

The **page content is identical to both Phase B and Phase C** (rows 11 and 13: 36/36 at 0 px each).

## ui-d coverage (273 checks)

| Area | Result |
|---|---|
| Sign-in screens vs Phase C, same footer style in both captures | 8/8 at 0 px |
| `<main>` content vs Phase C (shell hidden in both), same box | 44/44 at 0 px |
| No horizontal overflow (8 pages at 1440/375, 3 at 1024/768, both themes) | PASS |
| Exactly one `aria-current="page"`, equal to the current path | PASS |
| Sidebar exactly 260 px (1440, 1024) | PASS |
| Logo ≤ 150 px, not upscaled, alt text; white plate in dark | PASS |
| Rendered contrast — light: item 8.03, active 14.03, group 5.12, hover 11.02 · dark: 13.59 / 7.41 / 7.87 / 13.35 | all ≥ 4.5 |
| Footer solid (`rgb(30,58,95)` / `rgb(2,6,23)`), fixed, z-index 50, no blur, exact text | PASS |
| Header tap targets at 375 px (41×41; company button 53×41) | PASS |
| Skip link: first tab stop, visible on focus, moves focus to `<main>`, URL unchanged | PASS |
| Visible keyboard focus (menu item 2 px outline, header focus ring) | PASS |
| Drawer at 375: on screen at left 0 above the scrim, 260 px, last item above the footer, Escape and tap-outside close it, navigation closes it | PASS |
| Reduced motion: drawer transition `0s` | PASS |
| Print hides sidebar, header, footer, skip link | PASS |
| **High-DPI:** sidebar offers 1x + 2x and uses 1x on 1x screens; on a 2× screen the Login logo uses the 508×256 file at the same 200 px width; asset served as `image/png` | PASS |
| Console / page errors | none |

## Test changes (with reasons)

| File | Change | Reason |
|---|---|---|
| `tests/ui/ui-c3.mjs` | Whole-screen Phase B comparisons → content comparisons (shell hidden in both, 0 px, same box). Baseline is now an argument; without it the comparisons print `SKIP`. `sharp` replaced by in-browser decoding. | Requested in this task. The shell is checked by ui-d. Content strictness is unchanged (0 px). |
| `tests/ui/ui-footer.mjs` | Glass assertion → solid `rgb(30, 58, 95)` (earlier in Phase D); refuses non-local base URLs | Approved design D2-B; safety |
| `tests/ui/ui-header.mjs` | Dark footer `blur` → solid `rgb(2, 6, 23)` (earlier in Phase D) | Approved design D2-B |
| `tests/ui/ui-d.mjs` | Baseline as an argument with SKIP when absent; in-browser pixel diff; new high-DPI logo checks | New requirements |
| `tests/ui/ui-c3.mjs`, `tests/ui/ui-d.mjs` (content comparisons) | Background gradient image switched off in **both** captures; the background colour is still compared; 0 px tolerance unchanged | The pre-release run found a deterministic ±1-level dithering difference in the light background gradient (24,582 px, max 1 level per channel, background pixels only) that appeared only after a long sequence in one tab. See the release report. |
| all suites | Repository-relative paths, free ports, shared browser discovery, cross-platform server stop, results under `.tmp/ui-results` | Moved into the repository; must run on any machine and in CI |
| `ui-auth`, `ui-footer`, `ui-smoke`, `ui-header`, `ui-workstreams` | Lint only: comments in empty `catch` blocks; two unused initial values removed | `eslint .` now covers `tests/ui` |

No assertion was removed or loosened.

## Logs and evidence

- **Step logs** (`summary.txt`, `<step>.log`, `ui-summary.json`, `ui-d-final.log`): `C:\Users\User\AppData\Local\Temp\claude\d--Programe-Files-HR-3-in-1\b2c87edb-0791-48ff-858c-6d6bbbc37872\scratchpad\final-run2\`. This is a temporary session folder.
- **Browser results** (logs per suite, screenshots, `summary.json`): `.tmp/ui-results/` in the repository (gitignored). Rerun `npm run test:ui` to regenerate.
- **Baselines used:** `.tmp/ui-baselines/phase-b` and `phase-c` are copies of the verified working-tree snapshots (styles.css SHA-256 `a0d82399…` / `0657a18a…`). `.tmp/ui-baselines/9f6748e` was built by `make-baseline` as a tool check.
