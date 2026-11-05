-- LOCAL rollback of migrations/0010_probation_automation.sql (development / rehearsal databases only).
-- Never run on production without a fresh backup and the owner's written decision: it deletes the probation event
-- history and the job run log. Status changes the job already made stay on the employees (each one is in audit_logs,
-- action "employee.status_auto_changed", with the previous status) and are not reverted here.
--
--   npx wrangler d1 execute hr-system-db --local [--persist-to <dir>] --file scripts/rollback/0010_probation_automation.down.sql
--   npx wrangler d1 migrations apply hr-system-db --local [--persist-to <dir>]   # re-applies 0010 afterwards
DROP TABLE IF EXISTS probation_events;
DROP TABLE IF EXISTS job_runs;
DELETE FROM settings WHERE key IN ('probation.notifications_enabled', 'probation.reminder_interval_days', 'probation.auto_activate');
DELETE FROM d1_migrations WHERE name = '0010_probation_automation.sql';
