# App Management (จัดการระบบ)

Route `/admin/app-management` — menu **System › App Management · จัดการระบบ**. Super Admin only.

## Access control

- **Who can open it:** only holders of the `super_admin` role itself (`superAdminOnly`). A permission pattern never
  opens it, and `app_management.manage` is a reserved permission that the role editor refuses.
- **Everyone else:** the menu item is hidden. A direct URL shows the 403 page, and every API answers 403 (401 without
  a session). State-changing calls also need the CSRF header (`x-hr-requested: 1`).
- **One write path:** creating and editing users and roles still goes through the existing Admin API
  (`src/worker/routes/admin.ts`). The safeguards live in one place.

## Sections

| Tab | What it does |
|---|---|
| ภาพรวม | Counts for accounts, pending, locked, privileged accounts without MFA, Super Admins, roles, permissions and companies; the security policy; recent security changes |
| ผู้ใช้ | Search and filter by text, role, status and MFA. Create an account (random temporary password shown once, change at first login). Edit profile, roles and employee link. Activate or deactivate. Approve or reject registrations. Details: effective permissions and security history |
| บทบาท | All roles with type, MFA flag and user count. Create custom roles; edit name, description and MFA flag. Delete only custom roles that no one holds |
| Permission Matrix | Real permissions only (`permissionCatalogue()` and `RESERVED_PERMISSIONS`), grouped by menu group and module. Columns: View, Create, Update, Delete, Export, Approve, Calculate, Publish, Manage, plus other actions. Edit one role's exact grants; wildcard patterns are kept and shown as inherited; Super Admin is read-only |
| Company Scope | Each account's scope (see below), which roles grant all-company scope, and a server-validated change of the employee link |
| Security & MFA | Policy, MFA enrolment, forced password change, lock state, failed attempts, sessions. Actions: require a password change, reset password (temporary, shown once), unlock, reset MFA |
| Audit Log | Security events only (`user.`, `role.`, `settings.`, `auth.`, `mfa.`, `security.`, `job.`), filtered by type and user |

## Company scope (existing data model)

| Scope | Comes from |
|---|---|
| ทุกบริษัท (all) | a role that grants `employees.all` (e.g. HR Staff, Payroll Officer, HR Leader, HR Payroll, ACC Staff, ACC Manager) |
| บริษัทของตนเอง (own) | the company of the employee linked to the account |
| ไม่มี (none) | no link and no all-company role |

`PUT /api/admin/app/users/:id/company-scope { employeeId, companyId? }` changes the link. The server checks:

- the employee exists;
- the employee is not linked to another account;
- when `companyId` is sent, the employee belongs to that company.

Selecting a subset of companies per user is **not** part of the current data model. Every company-scoped API
(`lib/companies.ts`, CRUD row scope, payroll, imports) decides access with the rule above. Adding per-user company
lists would change data access across the whole application, so it is a separate design.

## Safeguards

- **Super Admin protection:**
  - nobody changes their own roles (403), whether escalating or demoting themselves;
  - nobody deactivates their own account;
  - the last active Super Admin cannot lose the role or be deactivated (409);
  - the `super_admin` role's permissions cannot be edited.
- **Role editor:**
  - every permission pattern must grant at least one real catalogue permission, so unknown or invented keys get 400;
  - reserved Super Admin permissions and `*` are refused;
  - built-in roles cannot be deleted (403); a role still assigned to someone cannot be deleted (409).
- **Secrets:** no response contains password hashes, MFA secrets or session tokens. Administrators cannot read
  passwords; they can only issue a temporary one that is shown once.
- **Audit (actor, target, timestamp, before / after):** no password, token or secret is ever stored.
  - `user.created`
  - `user.updated` (changed fields with before / after)
  - `user.roles_changed` (added / removed)
  - `user.activated` and `user.deactivated`
  - `user.employee_link_changed` and `user.company_scope_changed`
  - `user.password_change_required`, `user.password_reset`, `user.unlocked` and `user.mfa_reset`
  - `role.created`
  - `role.updated` (added / removed, before / after)
  - `role.deleted`
  - `settings.updated` (from / to)

## API (`/api/admin/app`, Super Admin)

| Method | Path | Purpose |
|---|---|---|
| GET | `/overview` | counts, policy, recent security events |
| GET | `/users?q=&role=&status=&mfa=` | accounts with roles, employee, company scope, MFA, status |
| GET | `/users/:id` | detail, effective permissions, security history |
| POST | `/users/:id/require-password-change` | force a password change (not for yourself) |
| GET | `/company-scope` | companies, scope per account, all-company roles |
| PUT | `/users/:id/company-scope` | change the employee link (validated) |
| GET | `/permissions` | matrix, catalogue, reserved permissions, roles |
| GET | `/security` | policy and account security status |
| GET | `/audit?userId=&action=&page=` | security audit trail |

The existing Admin API covers the following (all routes are under `/api/admin`):

- **Users:**
  - `GET` and `POST /users`, `PUT /users/:id`
  - `POST /users/:id/reset-password`, `POST /users/:id/unlock`, `POST /users/:id/reset-mfa`
  - `POST /users/:id/approve`, `POST /users/:id/reject`
- **Roles:**
  - `GET` and `POST /roles`, `PUT /roles/:id`
  - `DELETE /roles/:id` (new: custom roles that no one holds)
- **Settings:** `GET` and `PUT /settings`

## Tests

- `tests/integration/app-management.test.ts`: authorization matrix over every administrative endpoint × 10 identities
  (including unauthenticated), escalation, IDOR, injection, protected roles, company scope, audit before / after and
  secret checks.
- `tests/ui/ui-app-management.mjs`: menu visibility; 403 on direct navigation for ACC Staff and ACC Manager; the
  loading, empty, error and success states; the matrix; mobile width.

No database migration: App Management uses the existing tables.
