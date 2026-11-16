-- Rollback of migrations/0025_payroll_attendance_review.sql. Run only after a backup (docs/BACKUP-RECOVERY.md) and
-- after the Worker has been rolled back to a version without the attendance review gate (that Worker calculates
-- without an HR confirmation and pays mid-month rounds by the earlier rule).
-- Lost with the rollback (export first if it must be kept):
--   SELECT * FROM payroll_attendance_reviews;
-- No payroll, payslip, attendance or money row was changed by 0025. Payslips calculated after 0025 keep the review
-- ids in calc_json (attendance.review) as plain history.
--   npx wrangler d1 execute hr-system-db --remote --file scripts/rollback/0025_payroll_attendance_review.down.sql
DROP TRIGGER IF EXISTS trg_payroll_attendance_reviews_end_only;
DROP TRIGGER IF EXISTS trg_payroll_attendance_reviews_nodelete;
DROP INDEX IF EXISTS uq_payroll_attendance_reviews_confirmed;
DROP INDEX IF EXISTS idx_payroll_attendance_reviews_period;
DROP TABLE IF EXISTS payroll_attendance_reviews;

DELETE FROM role_permissions WHERE permission = 'payroll_attendance.confirm';
DELETE FROM d1_migrations WHERE name = '0025_payroll_attendance_review.sql';
