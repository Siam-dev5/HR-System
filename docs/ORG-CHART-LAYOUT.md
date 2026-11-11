# Organization Chart: master-template layout

The **Organization Design · ผังองค์กร** page draws each company like the master template: the top person (MD, or the AMD where a company has no MD) sits at the top centre, and the divisions spread out left, centre and right. Each manager sits centred over its own teams, and Staff / Admin sit in short columns under their own manager. Card borders take the department colour, with a legend above the chart. The level labels L1–L5 stay on the left edge.

This is a presentation-only change. No API, schema, employee, position or reporting-line data was changed.

## Two separate concepts

| Concept | Source | Decides |
|---|---|---|
| **Position Level** (L1–L5) | Exact Position Title → Level table in `src/shared/org-levels.ts` | The band (row) the card sits in |
| **Reporting line** | `employees.manager_id` (unchanged) | Who the card hangs under, and every connector line |

The chart never re-parents anyone and never invents a manager.

When the level and the reporting line disagree, the card moves down, never up:
- **Staff directly under a Manager:** the card sits in the L5 band, and the line simply runs longer.
- **An L5 with their own reports:** their reports go one row further down. For example, "Business Development" with reports stays L5, and their reports appear below them.
- **No MD or AMD in a company:** nothing is invented; the L1 / L2 bands of that company stay empty.

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
- **Tidy tree:** each subtree has its own column, so cards never overlap and divisions never interleave. A manager is centred over its first and last team. Teams of one manager are grouped by department (department master order), then by the API order.
- **No folding:** a wide organisation stays wide, like the template. Zoom, pan and the two fit buttons handle the size. (The earlier "tiers around a trunk" stacking was removed: it made the chart narrow, tall and crowded in the middle.)
- **Level bands:** the five bands L1–L5 have the same height in every company, so a level lines up across companies and with its label.
- **Staff / Admin blocks** (people at L5 without reports of their own, one manager per block):
  - 1–3 people: one column, stacked as in the template;
  - 4–6 people: two columns;
  - 7 or more: three columns;
  - never more than 3 per row, the last row centred, a large team grows downwards.
- **Per company:**
  - the largest tree is in the centre;
  - other trees and the "external manager" frames are split left / right to keep the chart balanced;
  - the **"ไม่มีสายบังคับบัญชา"** block (no manager and no reports) is at the right end, on the band of its highest level.
- **Manager in another company** (`manager_id` points outside the company, or outside the chart): the people sit in a dotted frame titled **"รายงานต่อ <manager> · <company code>"** in the all-companies view (or "หัวหน้าอยู่ต่างบริษัท / นอกผังนี้" when that manager is not in the current scope). No line is drawn across companies, and the people's own teams still hang below them.
- **All companies:** each company gets its own titled frame, side by side, on the same level bands. No line is drawn across companies.
- **Connector lines** run in the gaps only: a bus under the manager, a spine beside a multi-row block, a bus above each block row. Unit tests check geometrically that no line crosses a card.
- **Unchanged:** reports-to loops are cut and flagged "วนลูป"; the department filter keeps out-of-department managers as dashed context cards; search, zoom, pan, fit, collapse / expand, detail, editing, export and the table view (with its "ระดับในผัง" column) work as before.

## Department colours (`src/shared/org-colors.ts`)
- The card **border** takes the department colour; the same department always has the same colour on the page.
- Colours are handed out in the department master order of the current scope (only departments with people), from an 18-colour list. Each colour keeps at least 3:1 contrast against both the light card (#ffffff) and the dark card (#111827). People without a department are slate grey.
- Colours never depend on position, level or a hard-coded department name.
- The **legend** above the chart lists the departments of the cards on screen, with counts. It is rebuilt on every company or department filter change. Out-of-department managers shown as context have a dashed swatch.
- Search hits, the selected card, keyboard focus and loops are shown by a ring **outside** the card, so the border keeps its department colour.

## Level labels
- The live chart shows the labels in a **rail fixed to the left edge** of the chart. Each label follows its band through zoom and pan, so it never scrolls away. The rail sits above the chart; the toolbar is on the right, so nothing covers it. Phones show the short form (L1–L5).
- Fit and centring keep the chart clear of the rail.
- Exports (PNG / SVG / PDF) carry the labels as text on the left of the chart.

## Viewing: Readable Fit, Whole Chart Fit, detail drawer
- **Readable Fit** (toolbar button "Aa", key `r`) is the starting view.
  - If the whole chart would show at 70 % or more, Readable Fit uses that larger scale.
  - Otherwise it starts at 70 % at the top of the chart, with MD / AMD in view (from the left edge when they are close to it).
- **Whole Chart Fit** (fit-screen icon, key `f`): the entire chart in the canvas at whatever scale it needs.
- **Detail drawer:** employee details open in a drawer over the right edge of the chart when a card is clicked. Opening or closing it never changes zoom or pan. Below 900 px the details are the static panel under the chart.

## Tests
- `tests/unit/org-layout.test.ts`: the exact mapping; the master-template shape (MD over AMDs over managers, divisions left / centre / right); level bands; staff grouping 1 / 2 / 3 columns; last-row centring; multiple managers and teams; unassigned people; unmapped titles; no MD / AMD; managers in another company; loops; cross-department reporting; multi-company separation; balance; department filter; collapse; a production-shaped company; a ~900-person organisation; department colour contrast and assignment. Every case checks: nobody missing or duplicated, no overlap, one line per report from the real manager, reports below their manager, no line through a card, frames hold exactly their people, cards on their band.
- `tests/ui/ui-org-layout.mjs`: a browser run over a synthetic local company ("ZZL") with the production titles. It checks the template shape, the level rail (alignment, zoom, pan), department colours and legend (also with the department filter), and the fits / drawer / search at desktop and laptop sizes.
- `tests/ui/ui-org.mjs`: filters, search, detail, zoom / pan, collapse, photos, responsive 1024 / 768 / 375 and light / dark, including the rail and border colours.
