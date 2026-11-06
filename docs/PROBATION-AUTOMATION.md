# Probation automation: day 90 notice and day 120 status change

**Day count:** the hire date is day 1, day 90 is the last day of probation, day 91 is past probation, and day 120 is the day the status changes. Days are counted on the Asia/Bangkok date of the Worker run, never on a browser or a page view.

## What the daily job does

**Schedule:** the cron runs at 00:05 and 08:05 Asia/Bangkok (`wrangler.jsonc` → `triggers.crons`). The second run is the retry of the first.

| Day | Condition | Action |
|---|---|---|
| 90 or later, before 120 | `status = probation` | Notify HR once to review the probation result. The notice gives the employee code, name, company, hire date, day-90 date and a link to the employee form. |
| 91–119 | `status = probation` | Remind HR every `probation.reminder_interval_days` days (7 by default; 0 turns reminders off). After missed runs, only the latest reminder is sent, and a first run after day 90 sends the day-90 notice only. |
| 120 or later | `status = probation` and `probation.auto_activate = true` (default) | Change the status to `active` and notify HR. Only that column changes: `employment_type`, salary, the hire date and the recorded probation end are untouched. The change is written to `audit_logs` (`employee.status_auto_changed`). |
| 120 or later | `probation.auto_activate = false` | Notify HR once to change the status by hand. |

**The recorded probation end (`employees.probation_end`, "ครบทดลองงาน") is ignored.** Day 120 is counted from the hire date only; a probation end before or after day 120, or none at all, neither postpones nor suppresses the change. The field and its values are kept as they are.

**Who is notified:** every active, approved user who holds the Super Admin role, or whose roles let them maintain every employee record (`employees.update` and `employees.all`). With the seeded roles that is Super Admin, HR Admin and HR Staff; Manager and Payroll Officer only view employees and are not notified. A user with several of these roles gets one notice.

**Never acted on:** employees with status `active`, `resigned` or `terminated`.

**Idempotency:** each action is recorded once per (employee, kind, due date) in `probation_events`. It is written in the same D1 batch as its effects (status change, audit entry, notifications), so retries, the second trigger and concurrent runs never repeat it. If HR sets an activated employee back to `probation`, that decision is respected.

**Run log:** `job_runs` holds one row per run: the date, trigger, status (`ok` / `partial` / `error`) and counts, with no names:

- `processed`: employees on probation evaluated
- `notifications`: notices delivered (one per recipient)
- `activated`: status changes
- `retries`: extra D1 attempts (each step is tried up to 3 times)
- `failed`: steps that failed every attempt

A partial run keeps its failed steps (employee ID, action, attempts, message) in `error`.

## Payroll rounds

The payroll engine already chooses the round from the hire date, not from the status:

- **Mid-month advance rounds** (26th–10th) pay only up to day 90.
- **A round that starts after day 90** excludes the employee.
- **Passing day 90 between the mid-month and month-end rounds:** the month keeps both rounds, and the next month has one round.

The automation does not change this. A `probation` status after day 90 does not keep someone in the mid-month round, and an `active` status before day 90 does not remove them. The job never writes to payroll periods or payslips.

## Run log screen and API (Super Admin only)

**Screen:** System Settings → "งานอัตโนมัติ: ทดลองงาน", above the settings form. It shows:

- the last run and the next scheduled run;
- the processed, notification, activation, failure and retry counts of the last run;
- the last 30 runs with their failure details;
- **ทดลองรัน (Dry Run)**: lists today's actions and writes nothing;
- **รันทันที**: runs the job now, after a confirmation.

**API:**

- `GET /api/admin/jobs/probation`: today's date, the next run, the probation settings and the last 30 runs.
- `POST /api/admin/jobs/probation/run` with `{ "dryRun": true }`: what today's run would do. Writes nothing.
- `POST /api/admin/jobs/probation/run` with `{}`: run now. Same job, audited as `job.manual_run`.

## Release checklist (production)

With `probation.auto_activate = true`, the first run changes every employee who is still on `probation` at day 120 or later. Review that list before the release:

1. **List who the first run will change** (read-only, before anything is applied):
   ```sql
   SELECT emp_code, hire_date, probation_end, employment_type FROM employees
   WHERE status = 'probation' AND julianday(date('now', '+7 hours')) - julianday(hire_date) + 1 >= 120;
   ```
   Correct any employee who should stay on probation by hand first; the job only acts on `status = probation`.
2. **Back up D1**, then apply migration `0010_probation_automation.sql`. It is additive: two tables and three settings, with `probation.auto_activate = true`.
   - Rollback (local or rehearsal only): `scripts/rollback/0010_probation_automation.down.sql`.
3. **Deploy** away from 00:05 and 08:05 Asia/Bangkok. The cron triggers are part of the deployment.
4. **Right after the deploy**, open the Dry Run (System Settings → งานอัตโนมัติ: ทดลองงาน) and check it matches step 1. To hold the change, switch `probation.auto_activate` off before the next scheduled run.
