-- Rollback of migrations/0022_payroll_employee_selection.sql. Run only after a backup (docs/BACKUP-RECOVERY.md) and
-- after the Worker has been rolled back to a version without P4 (that Worker pays every period's standard list).
-- Lost with the rollback (export first if they must be kept):
--   SELECT * FROM payroll_period_selections; SELECT * FROM payroll_period_selection_events;
--   SELECT * FROM payroll_period_selection_versions; SELECT * FROM payroll_selection_results;
-- No payslip, period, employee or money row was changed by 0022. A period whose selection differed from its standard
-- list pays the standard list again after the rollback (recalculate before approving it).
--   npx wrangler d1 execute hr-system-db --remote --file scripts/rollback/0022_payroll_employee_selection.down.sql
DROP TRIGGER IF EXISTS trg_payroll_selection_results_readonly;
DROP TRIGGER IF EXISTS trg_payroll_selection_results_nodelete;
DROP TABLE IF EXISTS payroll_selection_results;
DROP TABLE IF EXISTS payroll_period_selection_versions;
DROP TRIGGER IF EXISTS trg_payroll_period_selection_events_readonly;
DROP TRIGGER IF EXISTS trg_payroll_period_selection_events_nodelete;
DROP TABLE IF EXISTS payroll_period_selection_events;
DROP TRIGGER IF EXISTS trg_payroll_period_selections_nodelete;
DROP TRIGGER IF EXISTS trg_payroll_period_selections_fixed;
DROP TABLE IF EXISTS payroll_period_selections;

DELETE FROM role_permissions WHERE permission IN ('payroll_selection.view', 'payroll_selection.manage', 'payroll_selection.override');
DELETE FROM d1_migrations WHERE name = '0022_payroll_employee_selection.sql';
