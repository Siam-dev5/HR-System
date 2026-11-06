# Attendance file import, shift settings, shift groups and the group schedule

Migration `0011_attendance_shifts.sql` (rollback `scripts/rollback/0011_attendance_shifts.down.sql`). Payroll is not
part of this feature: no payroll formula, period, payslip or archive is read or written by it, and the payroll engine
still reads only the Feishu summary import (`attendance_imports`).

## Menus and permissions

| Menu (HRM) | Path | Permission |
|---|---|---|
| บันทึกเวลาทำงาน | `/attendance` | `attendance.view` (existing list; imported rows show source "นำเข้าไฟล์") |
| นำเข้าไฟล์เวลาทำงาน | `/attendance/file-import` | `attendance_file.import` |
| ประวัติการนำเข้าเวลา | `/attendance/file-imports` | `attendance_file.view` |
| กะการทำงาน | `/shifts` | `shifts.view` · create `shifts.create` · edit `shifts.update` · delete `shifts.delete` |
| กลุ่มกะ | `/shifts/groups` | `shift_groups.view` · changes `shift_groups.manage` |
| ตารางกะกลุ่ม | `/shifts/schedule` | `shift_schedule.view` · changes `shift_schedule.manage` |

Granted by the migration: HR Admin (import, groups, schedule; the rest through its wildcards), HR Staff (all of the
above except deleting shifts), Manager (view shifts, groups, schedule), Payroll Officer (view import history and the
schedule). Super Admin has everything. `/shifts` keeps the existing shift module (its CRUD API and lookups); the SPA
shows the detailed Shift Settings screen for it. Every API checks the permission and the company scope again: a company outside the user's scope is
refused (403) or not found (404), and an employee code of another company reads as unknown to a user who cannot see
that company.

## Attendance file import

1. **Upload** — `.xlsx`, `.xls` (Excel 97–2003; tab-separated or HTML tables saved as `.xls` are read too) or `.csv`
   (UTF-8 or TIS-620; comma, semicolon or tab), up to 15 MB and 10,000 rows. The content is checked, not only the
   extension. The file is read in the browser; only the cell grid is sent.
2. **Column mapping** — Employee Code, Work Date, Clock In (required), Clock Out, Check-in Device, Source, Remark.
   Headers are matched by name (Thai or English); the mapping used for a file layout is remembered per company.
3. **Preview & validation** — every row is checked on the server: employee exists and belongs to the chosen company,
   employed on that day, date and times valid, not in the future, not inside a calculated payroll period, clock-out at
   most the next day (cross-midnight), duplicates within the file and against existing attendance. Rows are Valid,
   Warning (imported; e.g. no clock-out, early leave, day off or holiday, approved leave), Duplicate or Invalid.
   Invalid and duplicate rows are never imported.
4. **Confirm** — summary (total, passed, duplicates, errors, to import) and an explicit confirmation. A repeated
   confirmation returns the same import (idempotency key).
5. **Result** — imported, duplicates, errors, time, operator and file; error report as CSV or Excel.

Raw rows (`attendance_raw_records`, every row as read, with the import batch, file and source) cannot be updated or
deleted (database triggers). Valid rows become processed attendance in the existing `attendance_records` (unique per
employee and day): an existing day is never overwritten, so importing the same file again adds nothing. Lateness is
the existing rule (clock-in after the start of the shift in force, plus the shift's grace minutes; without a shift
the default start time setting). Imports and report downloads are in the audit log.

## Shifts, groups and the schedule

- **Shift** — code, name, company (or all companies), type (fixed / scheduled), start and end ("22:00–07:00" and
  "15:00–24:00" are cross-midnight / end-of-day shifts), working days, several break periods (net hours = span minus
  breaks), clock-in / clock-out windows, late and early-leave grace, OT eligibility (information only; OT pay still
  goes through OT requests), colour, active.
- **Group** — company, department, owner, how members are chosen (manual / department / company), shift type, status.
  A fixed group has a default shift that changes only from a chosen date (never retroactively once members exist).
- **Members** — bulk add, remove (the end date is kept), transfer with an impact preview (the old group's scheduled
  days from the transfer date are removed and kept as revisions; individual overrides stay), department / company
  sync with a dry run. An employee is in at most one group on any day. Every change is audited.
- **Schedule** — month or week calendar per company, group, department and search. Assign a shift per day, bulk
  assign, rotation patterns, copy the previous day / week / month, day off, holiday, clear. Saving shows a summary,
  conflicts (cross-midnight overlap with the next day, not a member, inactive shift, outside employment, calculated
  payroll period) and warnings (holiday, approved leave) that need confirmation. Past days need a reason. Each cell
  shows whether it is the group's (G) or an individual override (I); every change is a revision.

**Shift in force on a day** (used by the import, web clock-in and approved time corrections): a schedule entry, then the
fixed group's default shift (a day outside its working days is a day off), then the legacy shift assignment.

## Release

1. Back up Production D1 (`docs/BACKUP-RECOVERY.md`), check the applied migrations.
2. Apply `0011` (additive: new tables, new nullable / defaulted columns, permissions; no existing row changes value).
3. Deploy the Worker from `main`.
4. Verify: health, migration list, the new tables exist and are empty, payroll fingerprint unchanged.
