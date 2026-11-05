# Probation automation: day 90 notice and day 120 status change

**Day count:** the hire date is day 1, day 90 is the last day of probation, day 91 is past probation, and day 120 is the day the status changes. Days are counted on the Asia/Bangkok date of the Worker run, never on a browser or a page view.

## What the daily job does

**Schedule:** the cron runs at 00:05 and 08:05 Asia/Bangkok (`wrangler.jsonc` → `triggers.crons`). The second run is the retry of the first.

| Day | Condition | Action |
|---|---|---|
| 90 or later, before 120 | `status = probation` | Notify HR once to review the probation result. The notice gives the employee code, name, company, hire date, day-90 date and a link to the employee form. |
| 91–119 | `status = probation` | Remind HR every `probation.reminder_interval_days` days (7 by default; 0 turns reminders off). After missed runs, only the latest reminder is sent, and a first run after day 90 sends the day-90 notice only. |
| 120 or later | `status = probation` and `probation.auto_activate = true` | Change the status to `active`. Only that column changes: `employment_type`, salary and dates are untouched. The change is written to `audit_logs` (`employee.status_auto_changed`). |
| 120 or later | `probation.auto_activate = false` (default) | Notify HR once to change the status by hand. |
| 120 or later | the recorded "ครบทดลองงาน" (probation end) is after day 120 (an extension) | Never changed automatically. HR is notified once. |

**Who is notified:** every active user who holds both `employees.update` and `employees.all`. This includes Super Admins, who hold `*`.

**Never acted on:** employees with status `active`, `resigned` or `terminated`.

**Idempotency:** each action is recorded once per (employee, kind, due date) in `probation_events`. It is written in the same D1 batch as its effects (status change, audit entry, notifications), so retries, the second trigger and concurrent runs never repeat it. If HR sets an activated employee back to `probation`, that decision is respected.

**Run log:** `job_runs` holds one row per run, with the date, trigger, status (`ok` / `partial` / `error`) and counts, but no names.

## Payroll rounds

The payroll engine already chooses the round from the hire date, not from the status:

- **Mid-month advance rounds** (26th–10th) pay only up to day 90.
- **A round that starts after day 90** excludes the employee.
- **Passing day 90 between the mid-month and month-end rounds:** the month keeps both rounds, and the next month has one round.

The automation does not change this. A `probation` status after day 90 does not keep someone in the mid-month round, and an `active` status before day 90 does not remove them.

## Super Admin API

- `GET /api/admin/jobs/probation`: today's date and the last 30 runs.
- `POST /api/admin/jobs/probation/run` with `{ "dryRun": true }`: what today's run would do. Writes nothing.
- `POST /api/admin/jobs/probation/run` with `{}`: run now. Same job, audited as `job.manual_run`.

## Release checklist (production)

1. **Back up D1**, then apply migration `0010_probation_automation.sql`. It is additive: two tables and three settings.
   - Rollback (local or rehearsal only): `scripts/rollback/0010_probation_automation.down.sql`.
2. **Deploy.** The cron triggers are part of the deployment. With the default `probation.auto_activate = false`, the first runs only notify.
3. **Review the dry run:** `POST /api/admin/jobs/probation/run {"dryRun": true}`.
   - Every employee with `status = probation` past day 120 appears as `activate_due` (or `extended`).
   - Correct any employee whose probation was extended: set a probation end after day 120, or change the status by hand.
4. **Only then** set `probation.auto_activate = true` (System Settings → ทดลองงาน).
