-- Rollback of migrations/0019_payroll_attendance_holds.sql. Run only after a backup (docs/BACKUP-RECOVERY.md) and
-- after the Worker has been rolled back to a version without attendance holds (that Worker approves without the
-- attendance review gate).
-- The holds and their history are deleted with their tables (export them first if they must be kept:
--   SELECT * FROM payroll_attendance_holds; SELECT * FROM payroll_attendance_hold_events;).
-- No payroll period, payslip, attendance, leave or employee row was ever changed by 0019, so nothing else needs
-- restoring.
--   npx wrangler d1 execute hr-system-db --remote --file scripts/rollback/0019_payroll_attendance_holds.down.sql

DROP TRIGGER IF EXISTS trg_payroll_attendance_hold_events_readonly;
DROP TRIGGER IF EXISTS trg_payroll_attendance_hold_events_nodelete;
DROP TRIGGER IF EXISTS trg_payroll_attendance_holds_nodelete;
DROP TABLE IF EXISTS payroll_attendance_hold_events;
DROP TABLE IF EXISTS payroll_attendance_holds;

DELETE FROM settings WHERE key = 'payroll.attendance_review_from';
DELETE FROM role_permissions WHERE permission = 'payroll_hold.resolve';
DELETE FROM d1_migrations WHERE name = '0019_payroll_attendance_holds.sql';
