# Roles, maker-checker and the Super Admin exception

Migration `0014_hr_leader_payroll_roles.sql` (rollback `scripts/rollback/0014_hr_leader_payroll_roles.down.sql`). It
adds two built-in, privileged roles (MFA required) and their grants. No existing role, permission, user, employee or
payroll row is changed, and no account is created by the migration.

## Permission matrix

| Capability | Super Admin | HR Admin | **HR Leader** (`hr_leader`) | **HR Payroll** (`hr_payroll`) | Payroll Officer | HR Manager (Manager) |
|---|---|---|---|---|---|---|
| View payroll periods / payslips | ✓ | ✓ (`*.view`) | ✓ `payroll.view` | ✓ | ✓ | – |
| Create / calculate / reopen a calculated period | ✓ | – | ✗ | ✓ `payroll.calculate` | ✓ | – |
| **Approve** a calculated period | ✓ | – | ✓ `payroll.approve` | ✗ | ✓ | – |
| Publish / export | ✓ | – | – | ✓ `payroll.publish`, `payroll.export` | ✓ | – |
| Payroll Preview, Feishu summary import, OT review, pay items | ✓ | partly | Preview (view) | ✓ | ✓ | – |
| Super Admin period overrides (`payroll.period.*`) | ✓ | – | – | – | – | – |
| Holiday calendar: create / edit / verify / **approve** / import / export | ✓ | ✓ | ✓ `holiday_calendar.*` | view | – | – |
| Workflow requests (leave / OT / time correction) | ✓ any | – | – | – | – | ✓ **own reporting line only** |
| Approve their **own** record | ✓ **with a note** | ✗ | ✗ | ✗ | ✗ | ✗ |

Notes:
- **HR Leader** holds `employees.all`. This is organisation-wide company scope, needed for the central traditional
  calendar and for the payroll of every company. Without `employees.view` it does not open employee records.
- **HR Payroll** holds the employee and pay-item data that payroll needs (`employees.view/all/sensitive`,
  `employee_pay_items.*` without delete). It has no user, role or approval permissions.
- **Separation of duties is structural:** HR Payroll has no `payroll.approve` and HR Leader has no `payroll.calculate`,
  so through these roles the person who calculates a period can never approve it.

## ACC Staff / ACC Manager (read-only review, migration 0016)

Migration `0016_acc_readonly_roles.sql` (rollback `scripts/rollback/0016_acc_readonly_roles.down.sql`) adds two
built-in, privileged roles (MFA required) for the Accounting & Finance department. Both review the employee and
payroll data of every company in the group and change nothing. Tests: `tests/integration/acc-roles.test.ts`.

| Capability | ACC Staff (`acc_staff`) | ACC Manager (`acc_manager`) |
|---|---|---|
| Company scope | every company (`employees.all`) | every company (`employees.all`) |
| Dashboard, employee directory (personal data, masked bank / tax ID / base salary) | ✓ | ✓ |
| Payroll periods, payslips, payslip detail with YTD, Payroll Preview | ✓ | ✓ |
| Pay items and salary history, amounts included (`*.sensitive` of those two modules only) | ✓ | ✓ |
| Attendance, leave, OT records; Feishu / leave / OT import history; OT review; exemptions; holidays | view | view |
| Reports page | ✓ (lists what the role may view) | ✓ |
| Export Payroll Preview (CSV / XLSX, no bank or ID columns) | – | ✓ `payroll_preview.export` |
| Calculate / reopen / approve / publish payroll, `payroll.period.*`, `payroll.export` (CSV with bank accounts) | ✗ | ✗ |
| Any create / update / delete / import / approve; users, roles, settings, audit log | ✗ | ✗ |

Notes:
- **Least privilege:** `employees.sensitive` is not granted. It unmasks bank account, bank name and tax ID together
  with base salary, so it needs its own decision. Salary amounts are still available from salary history, pay items
  and the payslips.
- **No ACC review step yet:** the payroll workflow is still HR Payroll calculates → HR Leader approves → HR Payroll
  publishes. ACC can review at any status, but there is no "reviewed by ACC" status or sign-off. Adding one is a
  separate, additive workflow change.
- **Self-service:** the ACC roles carry no ESS or own-payslip permissions. Give the `employee` role as well if an ACC
  user should use ESS.
- **App Management readiness:** these are ordinary rows in `roles` / `role_permissions`. The job function is the role,
  company scope is a separate grant resolved from the `companies` table, and view / export / sensitive are separate
  permissions. Nothing is hard-coded by username or company.

## Maker-checker

`src/worker/lib/approval.ts` applies one rule everywhere a record is approved:

- **Holidays** (`/api/holidays/:id/approve`) and **holiday work** (`/work/:id/approve`): neither the creator nor the
  last content editor (`content_updated_by`, migration 0015; the creator when nobody has edited since) approves. A
  content edit records its editor; source verification, approval and deactivation do not.
- **Holiday pay rules** (`/pay-rules/:id/approve`): the creator does not approve (rules have no edit endpoint).
- **Payroll** (`/api/payroll/periods/:id/approve`): the user who calculated the period does not approve — always.
  The old setting `payroll.require_separate_approver` is no longer read and cannot switch this check off.
- **Publish** (`/api/payroll/periods/:id/publish`): only an approved period; the `payroll.published` audit records
  `calculated_by`, `approved_by`, `published_by` and `published_at`.
- **Workflow requests** (`/api/workflow/:id/decide`): the requester, and the employee the request is about, do not
  decide it.

**Super Admin exception:** a Super Admin (the highest authority; nobody above it could approve) may approve a record
they created, calculated or requested.

- An **approval note** is required (400 without it).
- The audit log records the creator, the approver, `self_approved: true` and the note.
- The exception follows membership of the `super_admin` role itself, never a permission. HR Admin's wildcard
  permissions, HR Leader, HR Payroll and the HR Manager never inherit it: a note in the request body does not help
  them (403).

## Manager scope (workflow)

- **Step approvers:** a role approver of a workflow step (the HR Manager for leave, OT and time correction) decides only
  requests of employees in their **reporting line**: direct and indirect reports through `employees.manager_id`, up
  to 10 levels.
- **Unlinked managers:** a manager account that is not linked to an employee record has no team and therefore no
  approvals.
- **Inbox and API:** the inbox shows exactly what may be approved; a direct API call outside the team is refused (403).
- **Super Admin** (`workflow.approve_any`) is not limited by team.

## UI

- **Holiday detail, pay rules and holiday work:**
  - the maker sees "คุณเป็นผู้สร้างรายการนี้ ต้องให้ผู้อนุมัติคนอื่นอนุมัติ" instead of the approve button;
  - a Super Admin's own record shows "อนุมัติ (Super Admin)", which asks for the approval note.
- **Payroll:** a Super Admin approving a period they calculated is asked for the note.
- **Server enforcement:** the API enforces every rule; hiding a button is not the control.

## Release and provisioning checklist (run with an approval for each Production step)

1. **Back up D1** (`docs/BACKUP-RECOVERY.md`) and check that only `0014` is pending.
2. **Apply `0014` once, then deploy** the Worker from the merged `main`.
3. **Check existing accounts before provisioning.**
   - Look up each username (Admin › Users) before creating anything.
   - If an account exists, never create it again and never reset it without an approval. Changing its roles is a
     Super Admin action in Admin › Users (audited) and needs no password reset.
4. **Create new accounts** in Admin › Users › add user (Super Admin).
   - The system generates a random temporary password shown once and requires a password change at first login.
   - The new roles are privileged, so MFA enrolment is enforced.
   - Use a real e-mail address (or none); the form and the script reject invalid addresses.
   - Do not choose passwords that can be guessed from the username, and do not share passwords in chat or tickets.
   - Scripted alternative: `scripts/create-user.mjs --create-only --must-change` with `NEW_USER_PASSWORD` from the
     environment. `--create-only` never touches an existing account, and the password is written only to the
     git-ignored credentials file.
5. **Link every manager account to its employee record** before relying on workflow approvals. Without a link the
   manager approves nothing.
6. **Maker-checker configuration.** Payroll maker-checker no longer depends on `payroll.require_separate_approver`
   (the setting is kept for compatibility but ignored). Apply migration `0015` before deploying the Worker that reads
   `content_updated_by`.
7. **Draft records waiting for a Super Admin's own approval** (e.g. holidays) can be approved after deploy, with a note.
