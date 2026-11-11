# Cross Company Manager Assignment

HR can make one person responsible for a department or team of **another company**, for example "FF65001 leads the Content team of IAMDP". The organization chart shows the relationship as soon as it is saved.

There are now two kinds of relationship:

| Relationship | Source | Shown in the chart as |
|---|---|---|
| **Primary reporting line** | `employees.manager_id` (Reports To), unchanged | solid grey line |
| **Cross company functional relationship** | `cross_company_assignments` (this feature) | violet dashed line, plus a reference card in the target team |

An assignment **never** does any of the following:
- changes `manager_id`;
- moves anyone to another company;
- creates an employee record.

## Data model (migration `0017_cross_company_assignments.sql`)

### `cross_company_assignments`

| Column | Meaning |
|---|---|
| `manager_employee_id` | the responsible person (the "manager"), from any company |
| `manager_company_id` | that person's company at the last save (history only; checks use the live company) |
| `target_company_id`, `target_department_id`, `team_name` | the team that person is responsible for. The department must belong to the target company; the team name is optional. |
| `employee_id`, `employee_company_id` | optional: one named employee of the target company (NULL means the whole team) |
| `relationship_type` | one of the four types listed below |
| `responsibility` | free text describing the duties |
| `effective_from`, `effective_to` | dates; an empty end date means open-ended |
| `status` | `active`, `inactive` (paused, can be re-activated) or `cancelled` (final) |
| `cancel_reason`, `cancelled_at`, `cancelled_by` | recorded on cancellation |
| `created_*`, `updated_*` | who saved the row, and when |

The four relationship types are:
- `team_lead`: หัวหน้างานทีม (Team Lead)
- `functional_manager`: หัวหน้างานตามสายงาน (Functional Manager)
- `project_lead`: หัวหน้าโครงการ (Project Lead)
- `operational_supervisor`: ผู้ดูแลการปฏิบัติงาน (Operational Supervisor)

### `cross_company_assignment_history`

Every create, update, activate, deactivate and cancel adds a row with the values before and after, the reason, the time and the user. History rows are read-only. Each change is also written to `audit_logs` as `org_assignment.*`.

### Protection against data loss

Rows in both tables can never be deleted (enforced by triggers). Cancelling keeps the row and all of its history.

### State

The state shown on screen is worked out from the status and the dates:

| State | When |
|---|---|
| active | status is `active` and today falls between the start and end dates |
| scheduled | status is `active` and the start date is still ahead |
| expired | status is `active` and the end date has passed |
| inactive | status is `inactive` |
| cancelled | status is `cancelled` |

The chart draws only assignments that are **active** and whose people are still employed (status active or probation).

## Permissions

| Permission | Granted to | Allows |
|---|---|---|
| `org_assignment.view` | HR Admin (through `*.view`), HR Staff, Super Admin | the screen, the list, the history, the people search |
| `org_assignment.manage` | HR Admin, Super Admin | create, edit, pause / re-activate, cancel |

Company scope follows the existing rule: `employees.all` gives every company, otherwise only your own company.

- **Lists:** you see an assignment when at least one company involved is in your scope. People of companies outside your scope are **masked**: only their company code is shown, never their name, code, position, department or photo.
- **Managing:** you may change an assignment only when **every** company it involves is in your scope. Otherwise the request returns 403, and an assignment with no company in your scope returns 404.
- **Organization chart:** anyone with `org_chart.view` sees the relationships that involve the company being viewed, with the same masking. Reading or changing someone's reporting line still needs the existing permissions.

Every rule is enforced by the server. Hidden buttons in the browser are a convenience only.

## Validation (server, `src/shared/cross-company.ts`)

A save is refused when any of these applies:
1. The responsible person or the named employee doesn't exist, or has left.
2. The responsible person and the employee are the same record.
3. The responsible person is in the target company. That is not cross-company: use Reports To instead.
4. The named employee is not in the target company.
5. The target company doesn't exist, or the department is missing, inactive or belongs to another company.
6. The relationship type isn't one of the four types.
7. A date is invalid, or the end date is before the start date.
8. It duplicates another assignment that isn't cancelled: same person, same team (department and team name), same employee (or both the whole team) and same type, with overlapping dates. One person may hold several assignments for different teams, companies or types.
9. It would close a **relationship loop**. The check combines the primary reporting line with the active assignments whose dates overlap: the employee (or every member of the target department) must not be the responsible person, nor anyone above that person.

## API (`/api/org-assignments`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/meta` | companies in scope, departments, types, states, `canManage` |
| GET | `/people?q=&company=&exclude_company=` | search eligible employees (`company=`) and eligible managers (`exclude_company=` the target company); active or probation, in scope, at most 20 |
| GET | `/?q=&state=&type=&company=` | list |
| GET | `/:id` | detail |
| GET | `/:id/history` | history, with names (masked by scope) |
| POST | `/` | create |
| PUT | `/:id` | update (dates, person, team, type, employee, responsibility; optional `reason`) |
| POST | `/:id/status` | `{ status: 'active' \| 'inactive', reason? }` |
| POST | `/:id/cancel` | `{ reason }` (at least 3 characters) |

The organization chart data comes from `GET /api/org-design` as `crossCompany: { links, people }`:
- `links`: the assignments in effect;
- `people`: everyone those links refer to, listed once. Each person carries a `masked` flag and a chart `level`, so a masked person still sits on the right band.

## Screen: Cross Company Manager Assignment (`/org-chart/assignments`, menu HROD)

- **List:**
  - columns: Employee Code, Employee Name ("ทั้งทีม" when no employee is named), Primary Company, Primary Department, Assigned Manager, Manager Company, Target Department / Team, Relationship Type, Effective Start, Effective End, Status, Updated By, Updated At;
  - search, filters for state, type and company;
  - detail with history.
- **Create:**
  1. Find the responsible person in any company. The picker leaves out the target company, and shows the person's company, department and position.
  2. Choose the target company and the department or team, and optionally a team name.
  3. Choose the relationship type.
  4. Optionally name one employee of the target company.
  5. Describe the duties.
  6. Set the dates.

  A one-line summary ("who, is responsible for which team, in which company, from when") is shown before saving, and again in the confirmation.
- **Edit, pause / re-activate, cancel (reason required):** history is never lost.

## Organization chart

- **Reference card:**
  - The responsible person appears in the target company inside a violet dashed frame named after the target team.
  - It sits on the band of that person's level, so L1–L5 never change.
  - The card is marked **"อ้างอิงข้ามบริษัท"** and shows the type and the source company.
  - It is **not** an employee node: it isn't counted in headcount, KPIs, department chips or the legend counts, and it is never duplicated.
- **Dashed lines:**
  - one from the reference card to the person's real card (when it is on the chart);
  - one from the reference card to the named employee.
  - Lines are routed around every card and the collapse buttons (`src/shared/org-route.ts`, A* over the free space). They avoid running along a solid line, and two lines of the same person avoid sharing a path.
  - Lines are violet `7 5` dashes in light mode, lighter violet in dark mode.
- **Badge:** "ข้ามบริษัท n" on the real card of the responsible person and of a named employee.
- **Drawer:** a "ความรับผิดชอบข้ามบริษัท" section (or "หัวหน้างานข้ามบริษัท"). Clicking a reference card opens the real person when that person is on the chart; otherwise it opens a reference detail, masked when the person is outside your scope.
- **Views:**
  - Global view: every relationship involving a company in scope.
  - Single company: the relationships involving that company. References appear only in the target company.
  - Department filter: a reference is shown when the filter is its target department, or when it names an employee who is visible.
- **Legend:** a "ความสัมพันธ์" group (primary solid, cross-company dashed, reference card) next to the department colour legend.
- **Table view:** a "ความรับผิดชอบข้ามบริษัท" column.
- **Export:** PNG, SVG and PDF exports include the lines and reference cards.

## Rollback

1. Roll the Worker back to the previous version.
2. If the data is no longer needed, export the two tables and run `scripts/rollback/0017_cross_company_assignments.down.sql`.

Nothing else needs restoring, because no other table was changed.

## Tests

- `tests/unit/cross-company.test.ts` covers:
  - validation: invalid employee and manager, same company, department of another company, dates, duplicate, loop, multiple departments and companies;
  - states, including expired;
  - reference cards in the layout: no duplicate identity, same nodes, bands, rows, edges and colours, no overlap;
  - routing: never through a card, not along a solid line, no piling up, performance.
- `tests/integration/cross-company.test.ts` covers:
  - migration content, create, update, status, cancel, history and audit;
  - the chart payload in global and single-company views, with headcount unchanged;
  - expired and scheduled assignments;
  - people who have left;
  - `manager_id` unchanged;
  - no deletes;
  - permissions: none, view only, and own-company scope with masking, 403 and 404.
- `tests/ui/ui-cross-company.mjs`: the screen flow and the chart in global, company and department views, at 1920, 1440, 1366, 768 and 375 px in light and dark, with before and after screenshots and a masked own-company viewer.
