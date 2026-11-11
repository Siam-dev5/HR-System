# Organization Chart: 5-level layout

The **Organization Design · ผังองค์กร** page draws each company as an inverted bell. MD is at the top, the levels widen downwards, and Staff / Admin sit in compact grids under their own manager.

This is a presentation-only change. No API, schema, employee, position or reporting-line data was changed.

## Two separate concepts

| Concept | Source | Decides |
|---|---|---|
| **Position Level** (L1–L5) | Exact Position Title → Level table in `src/shared/org-levels.ts` | The band (row) the card sits in |
| **Reporting line** | `employees.manager_id` (unchanged) | Who the card hangs under, and every connector line |

The chart never re-parents anyone.

When the level and the reporting line disagree, the card moves down, never up:
- **Staff directly under a Manager:** the card sits in the L5 band, and the line simply runs longer.
- **An L5 with their own reports:** their reports go one row further down. For example, "Business Development" with reports stays L5, and their reports appear below them.

## Levels

| Level | Meaning |
|---|---|
| L1 | MD |
| L2 | AMD |
| L3 | Manager |
| L4 | Head of Department / Leader |
| L5 | Staff / Admin |

The mapping was built from the 26 position titles in use in production on 2026-11-10 (read-only query) and approved by HR. Matching is exact and case-sensitive. Only leading and trailing spaces are ignored.

Levels are **never guessed from keywords or job grade.**

If a title is not in the table, or a person has no position:
- the card is shown as **L5** with an amber **"Unmapped Level"** tab;
- a note above the chart lists the unmapped titles;
- the detail panel explains the marker.

### Adding or changing a title
1. Edit `POSITION_LEVELS` in `src/shared/org-levels.ts`, using the title exactly as stored.
2. Update the count expectations in `tests/unit/org-layout.test.ts`.
3. Run the tests and deploy through the normal PR flow.

## Layout rules (`src/shared/org-layout.ts`)
- **Staff / Admin grids:**
  - The grid holds people at L5 who have no reports of their own. Only one manager's reports share a grid.
  - Rows hold at most 3 cards (3 + 3 + …). The last row is centred.
  - A large team grows downwards instead of sideways.
- **Everyone else** is laid out as a tidy tree. Each subtree has its own column, so cards cannot overlap.
- **Balanced multi-row layout:** when a manager's teams side by side would be too wide for the chart area, they are stacked into tiers.
  - The tiers are either two columns around a central trunk, or one column on a trunk down the left side.
  - The page passes the chart area's width / height, and the layout keeps the arrangement with the largest whole-chart fit.
  - Within a tier, the levels line up and the L3–L5 labels repeat per tier.
  - Card size and font sizes never change.
- **Connector lines** run in the gaps only:
  - a bus under the manager;
  - a spine beside a multi-row grid;
  - a bus above each grid row.
  - Lines never cross cards. Unit tests check this geometrically.
- **"ไม่มีสายบังคับบัญชา" block:** each company gets a dashed block under its tree for people who have no manager and no reports.
  - A person whose manager is outside the chart (another company) is not put in this block.
  - The top of a company (MD or AMD with reports) stays the tree root.
- **All companies:** each company gets its own titled frame, side by side, and no line is drawn across companies.
  - A cross-company manager is still named in the detail panel ("หัวหน้าอยู่ต่างบริษัท").
  - Each frame looks exactly like that company selected on its own.
- **Unchanged:**
  - reports-to loops are still cut and flagged "วนลูป";
  - department filtering keeps out-of-department managers as dashed context cards;
  - search, zoom, pan, fit, collapse / expand, detail, editing, export and the table view work as before. The table view gains a "ระดับในผัง" column.

## Viewing: Readable Fit, Whole Chart Fit, detail drawer
- **Readable Fit** (toolbar button "Aa", key `r`) is the starting view.
  - If the whole chart would show at 70 % or more, Readable Fit uses that larger scale.
  - Otherwise it starts at 70 % at the top of the chart, with MD / AMD in view.
  - Nothing is cropped: the rest of the chart is a pan or zoom away, and search or a department chip brings any person into view.
- **Whole Chart Fit** (fit-screen icon, key `f`) is the existing behaviour: the entire chart in the canvas at whatever scale it needs.
- **Chart size:** the chart uses the full page width and the viewport height below the header.
- **Detail drawer:** employee details open in a drawer over the right edge of the chart when a card is clicked.
  - The zoom toolbar moves left of the drawer, so it is never covered.
  - Opening or closing the drawer (× or Esc) never changes zoom or pan.
  - Below 900 px the details are the static panel under the chart, as before.

## Tests
- `tests/unit/org-layout.test.ts`:
  - Covers the exact mapping and the 10 required scenarios: small company, multiple departments, teams of 1–3 / 4–6 / 7–12, multiple managers and leaders, no reporting line, loops, multiple companies, company switch. It also covers the department filter, collapse, and a 45-person company shaped like production data.
  - Every case checks: nobody missing or duplicated, no card overlap, one line per report from the real manager, reports below their manager, ≤ 3 per grid row, last row centred, no line through a card.
- `tests/ui/ui-org-layout.mjs`:
  - A browser run over a synthetic local company ("ZZL") using the production titles.
  - Covers desktop 2560 / 1920 / 1440 and laptop 1366 / 1280.
