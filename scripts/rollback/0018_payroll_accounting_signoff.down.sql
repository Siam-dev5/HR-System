-- Rollback of migrations/0018_payroll_accounting_signoff.sql. Run only after a backup (docs/BACKUP-RECOVERY.md) and
-- after the Worker has been rolled back to a version without the ACC review / sign-off gate (that Worker publishes
-- without the gate, so roll it back first only if publishing without ACC sign-off is acceptable again).
-- The review decisions and their events are deleted with their tables (export them first if they must be kept:
--   SELECT * FROM payroll_accounting_reviews; SELECT * FROM payroll_accounting_review_events;).
-- No payroll period, payslip, archive or employee row was ever changed by 0018, so nothing else needs restoring.
--   npx wrangler d1 execute hr-system-db --remote --file scripts/rollback/0018_payroll_accounting_signoff.down.sql

DROP TRIGGER IF EXISTS trg_payroll_accounting_events_readonly;
DROP TRIGGER IF EXISTS trg_payroll_accounting_events_nodelete;
DROP TABLE IF EXISTS payroll_accounting_review_events;
DROP TABLE IF EXISTS payroll_accounting_reviews;

DELETE FROM role_permissions WHERE permission IN ('payroll.accounting.review', 'payroll.accounting.review.submit', 'payroll.accounting.signoff');
DELETE FROM d1_migrations WHERE name = '0018_payroll_accounting_signoff.sql';
