# Feishu imports: attendance, leave and overtime (one worksheet per import)

Migration `0012_feishu_import_separation.sql` (rollback `scripts/rollback/0012_feishu_import_separation.down.sql`).
A Feishu "Daily Report" export (`Starlive+Dairy+Report_YYYYMMDD_YYYYMMDD.xlsx`) has three worksheets. Each one is
imported on its own, in its own menu: **one import = one worksheet = one data domain**.

| Worksheet | Template | Menu | Permission (import · history) |
|---|---|---|---|
| `Sheet1` (daily attendance) | `FEISHU_DAILY_ATTENDANCE_V1` | บันทึกเวลาทำงาน › นำเข้าไฟล์เวลาทำงาน / ประวัติการนำเข้าเวลา | `attendance_file.import` · `attendance_file.view` |
| `Leave` | `FEISHU_LEAVE_V1` | การลา › นำเข้าข้อมูลการลา / ประวัติการนำเข้าการลา | `leave_import.import` · `leave_import.view` |
| `Overtime` | `FEISHU_OVERTIME_V1` | คำขอ OT › นำเข้าข้อมูล OT / ประวัติการนำเข้า OT | `overtime_import.import` · `overtime_import.view` |

Granted by the migration:
- **HR Admin:** import (history through `*.view`).
- **HR Staff:** import and history.
- **Payroll Officer:** history only.

Super Admin has everything. Every API checks the permission and the company scope again. An employee code is matched only inside the
chosen company, never by name. A code of another company is an error, and it reads as "unknown" to a user who can't
see that company.

## Payroll is not touched

The payroll engine pays approved `overtime_requests` and deducts approved unpaid `leave_requests`. The Feishu leave
and OT imports therefore never write those tables. They keep their rows in `leave_import_records` and
`overtime_import_records`, which payroll doesn't read.

Nothing in these imports:
- calculates OT pay;
- creates a leave request, an OT request or a payroll item;
- changes a payroll period, payslip, archive, formula or setting.

The monthly Feishu summary used by payroll ("นำเข้าเวลาทำงาน (Feishu)", `attendance_imports`) is unchanged.

## Wizard (same five steps for each type)

1. **Upload:** `.xlsx`, `.xls`, `.csv`, up to 15 MB and 10,000 rows.
   - The content is checked, not just the extension.
   - Every worksheet is listed with its detected template, and the wizard's own worksheet is preselected.
   - A worksheet of another domain is marked and can't continue.
   - Only the selected worksheet's cells are sent to the server, which detects the worksheet type again and refuses a wrong one.
2. **Column mapping:** headers are found automatically, including the 3-row grouped header of the daily report and
   the filter line above the leave / OT header. Required and optional fields are shown.
   - Exact header text is matched first, because the OT export has request-level `Start time` and detail-level
     `Start Time` columns.
   - The mapping used is saved as a template per company, import type, template and file layout
     (`import_mapping_templates`), and reused next time. Mappings are never shared between types.
3. **Preview & validation:** rows before and after validation; Valid / Warning / Duplicate / Invalid per row with
   reasons.
4. **Confirm:** summary and an explicit confirmation. A repeated confirmation returns the same batch (idempotency key).
5. **Result:** counts, error report (CSV / Excel), batch detail. Imports and report downloads are audited.

## Attendance — `FEISHU_DAILY_ATTENDANCE_V1`

The report has one row per employee and one column per day. Each day cell becomes one row (employee + work date). The
work date comes from the day header; `Employment date` is never used as a work date. Blank and `-` cells are counted
and skipped.

Example cells:
- `Regular(08:58),Regular(18:03)`
- `Late in9min(09:09),Regular(18:01);Overtime(18:00-20:00)`
- `Regular(08:55),Leave(13:00);Sick leave(4 hr,13:00-18:00)`
- `Break(-,-)`

- **Clock times.** Only times under Regular / Late in / Early leave / Leave / Out-of-office are used.
  - A time under `No record` stays in the raw data but is never a clock time.
  - `No record` is a warning, never an absence.
  - Nothing is invented when the file has no time.
- **Several statuses in one day.** All of them are kept:
  - the punch results (`in_result`, `out_result`) on the raw row;
  - each leave, OT, out-of-office or break-punch event in `attendance_day_events`, as information only.
- **Processed attendance.** A day with a clock time becomes a record in `attendance_records` (source `import`):
  - it is never overwritten (an existing day is a duplicate);
  - Feishu's late / early-leave minutes are kept;
  - an overnight clock-out is marked as next day.
- **Days without a clock time** (rest day, full-day leave, No record) are kept as raw rows only.
- **Blocked days.** Future dates, days outside employment and days in a calculated payroll period are refused.
- **Re-import.** Importing the same worksheet again adds nothing.

## Leave — `FEISHU_LEAVE_V1`

- Fields:
  - Request ID, employee ID and name, leave type (as written, Thai / English / Chinese);
  - start and end date / time, days or hours with their unit;
  - approval status, approver, reason, created date.
- Approval statuses are stored exactly as written: approved, pending, rejected, cancelled (English, Thai or Chinese words).
  - An unknown status is an error. A pending request is never made approved, and no approval is created.
- One imported record per company and Request ID:
  - a repeated ID in the file, or one already imported, is a duplicate;
  - a later file with a different status for the same ID is a duplicate and doesn't change the record.
- An end before the start, or a duration ≤ 0, is invalid.
- Rows are read-only (database triggers).
- The import doesn't change attendance records.

## Overtime — `FEISHU_OVERTIME_V1`

- A request split over several days has one row per detail (`Overtime Details1`, `Overtime Details2`).
- A row is identified by Request ID + detail number, and each row keeps:
  - the request's start / end;
  - the detail's day and hours;
  - the overnight flag;
  - type, date type and approval status.
- Duplicates are detected by Request ID + detail.
- Invalid duration:
  - hours ≤ 0 or > 24;
  - more hours than the requested time span;
  - a detail with more hours than its request.
- Details that don't add up to the request's hours give a warning.
- Rows are read-only.
- No OT pay is calculated.

## Checking a real file before importing

```
node scripts/check-feishu-report.mjs "Starlive+Dairy+Report_20260926_20261026.xlsx"
```

This is read-only and prints structure and counts only: worksheets, templates, header rows, mapping, rows before and
after, results, events. It never prints names, codes or request numbers.

Last check of the file above:
- **Sheet1:** 47 employees → 1,403 daily rows (54 blank days), 0 unreadable cells.
- **Leave:** 39 rows, all mapped.
- **Overtime:** 40 rows (35 requests, 5 second-day details, 10 overnight).

The real file isn't in the repository. The tests use `tests/fixtures/feishu-report.ts`, which has the same headers, column
order and cell grammar with made-up data.

## Release

1. Back up Production D1 (`docs/BACKUP-RECOVERY.md`) and check that only `0012` is pending.
2. Apply `0012` once. It is additive: new columns with defaults, new tables, indexes, triggers and permissions; no
   existing row changes.
3. Deploy the Worker from the merged `main`.
4. Verify:
   - health and the migration list;
   - the new tables exist and are empty;
   - `foreign_key_check`;
   - the payroll fingerprint is unchanged.

## V1.1 — one file for several companies, and attendance exemptions

Migration `0013_multicompany_import_exemption.sql` (rollback `scripts/rollback/0013_multicompany_import_exemption.down.sql`).
It is additive: new tables, one nullable column (`attendance_file_imports.group_id`), triggers and permissions.

### The company of each row (attendance wizard, step 2 "Worksheet / บริษัท")

The company is **never inferred from the employee-code prefix**. In Production, an IAMDP employee has an `ST…` code, and
the Starlive daily file contains Flying Fish staff with `ST…` codes. Employees are always looked up by **company + code**.
A code that belongs to another company is refused, never matched across companies.

- **บริษัทเดียว (separate file):** HR selects the company, and every row is checked against it.
  - Optionally, a company column of the file (or e.g. `Group`) can be matched to companies. A row whose value names
    another company, or isn't matched, is invalid.
  - An empty value keeps the selected company.
- **หลายบริษัทในไฟล์เดียว (combined file):** HR chooses the column that identifies the company and matches each of its
  values to a company.
  - Only exact matches on company code, name or id are suggested; e.g. `Team A` or `ST` is never auto-matched.
  - A row with an empty or unmatched value has no company. It is invalid and kept apart as raw data
    (`import_group_unassigned_rows`); it is never assigned to the selected company.
  - The real daily report has no company column; HR can use `Group` or `Department`.
  - The rule is remembered per file layout (`import_company_rules`).
- **Before validation:** step 2 shows the detected companies with their row counts and flags rows without a company.
- **Validation:** step 4 shows Valid / Warning / Duplicate / Invalid per company, and a filter to inspect one company.
- **Batches:** a combined file creates one `import_groups` row and **one `attendance_file_imports` batch per company**.
  - Each batch has its own raw rows, records, counts, error report and audit (`attendance_file.imported`), plus
    `attendance_file.group_imported` for the group.
  - Everything is written in one D1 batch: all or nothing for the database write. An invalid row (or a whole
    company of invalid rows) never blocks the valid rows of the other companies.
  - The idempotency key is per group; repeating a confirmation returns the same group.
- **Visibility:** the group page (`/attendance/file-imports?group=<id>`) lists the batches of the companies the user
  can see. The unassigned rows are shown only to the importer or an all-company user.
- **Preview** is read-only: no batch, row, rule, mapping or audit is written.
- **Scope:** every company named in a rule must be in the user's company scope (checked on the server; 403 otherwise).

Combined files apply to the Feishu daily template. Time-clock files (`CLOCK_FILE_V1`) and the leave / OT imports
remain one company per import, with other companies' employees refused.

### Attendance exemption (Employee Master → พนักงาน → "ยกเว้นการบันทึกเวลา")

- **Data:** `employee_attendance_exemptions` stores, per period:
  - `effective_from` and `effective_to` (open-ended when empty);
  - `reason`;
  - created / updated / revoked by and at, and `revoke_reason`.
- **Rules:**
  - Periods of one employee never overlap.
  - A period is revoked, never deleted (database trigger).
  - States: active, future, expired, revoked.
- **Permissions:**
  - `attendance_exemption.manage` (HR Admin; Super Admin) to add, end-date and revoke;
  - `attendance_exemption.view` (HR Staff; HR Admin through `*.view`) to view;
  - the employee must be in a company of the user's scope.
- **Audit:** every change is audited (`attendance_exemption.created / updated / revoked`, with before / after values).
- **Effect** (only inside a period, for an employee already resolved inside the row's company):
  - The attendance import drops the missing-punch warnings (`No record`, missing clock-in / clock-out, `Pending`) and
    notes "ได้รับยกเว้นการบันทึกเวลา".
  - Real punches are imported as usual.
  - Employee / company / date errors are never removed.
  - Leave, OT and payroll are not affected (nothing in the payroll engine reads exemptions).
- No employee is exempted by the code or the migration. The employees confirmed in Production (e.g. ST63002, ST65021,
  ST66012) only become exempt when HR adds a period for them, which is a separate, approved Production change.

### Release (after approval)

1. Back up Production D1 and check that only `0013` is pending (do not re-run 0010–0012).
2. Apply `0013` once.
3. Deploy the Worker from the merged `main`.
4. Verify:
   - the new tables are empty;
   - `foreign_key_check`;
   - the permissions: hr_admin `attendance_exemption.manage`, hr_staff `attendance_exemption.view`;
   - the payroll fingerprint is unchanged.
