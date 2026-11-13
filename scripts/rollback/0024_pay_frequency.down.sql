-- Rollback of migrations/0024_pay_frequency.sql. Run only after a backup (docs/BACKUP-RECOVERY.md) and after the
-- Worker has been rolled back to a version without P6 (that Worker includes every employee in mid-month rounds).
-- Lost with the rollback (export first if they must be kept):
--   SELECT id, pay_frequency FROM companies WHERE pay_frequency IS NOT NULL;
--   SELECT id, pay_frequency FROM employees WHERE pay_frequency IS NOT NULL;
--   SELECT * FROM pay_frequency_history;
-- No payroll, payslip or money row was changed by 0024.
--   npx wrangler d1 execute hr-system-db --remote --file scripts/rollback/0024_pay_frequency.down.sql
DROP TRIGGER IF EXISTS trg_pay_frequency_history_readonly;
DROP TRIGGER IF EXISTS trg_pay_frequency_history_nodelete;
DROP TABLE IF EXISTS pay_frequency_history;
ALTER TABLE employees DROP COLUMN pay_frequency;
ALTER TABLE companies DROP COLUMN pay_frequency;

DELETE FROM role_permissions WHERE permission = 'pay_frequency.manage';
DELETE FROM d1_migrations WHERE name = '0024_pay_frequency.sql';
