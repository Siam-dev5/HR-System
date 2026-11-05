-- LOCAL rollback of migrations/0009_holiday_calendar.sql (development / rehearsal databases only).
-- Never run on production without a fresh backup and the owner's written decision: it deletes every holiday,
-- holiday-work record and holiday pay rule. Payslips keep their own snapshot (calc_json / lines_json) and are untouched.
--
--   npx wrangler d1 execute hr-system-db --local [--persist-to <dir>] --file scripts/rollback/0009_holiday_calendar.down.sql
--   npx wrangler d1 migrations apply hr-system-db --local [--persist-to <dir>]   # re-applies 0009 afterwards
DROP TABLE IF EXISTS holiday_work_records;
DROP TABLE IF EXISTS holiday_substitutions;
DROP TABLE IF EXISTS holiday_pay_rules;
DROP TABLE IF EXISTS holidays;
DROP TABLE IF EXISTS holiday_calendars;
DELETE FROM role_permissions WHERE permission LIKE 'holiday\_calendar.%' ESCAPE '\';
DELETE FROM d1_migrations WHERE name = '0009_holiday_calendar.sql';
