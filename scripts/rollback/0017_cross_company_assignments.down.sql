-- Rollback of migrations/0017_cross_company_assignments.sql. Run only after a backup (docs/BACKUP-RECOVERY.md) and
-- after the Worker has been rolled back to a version without the Cross Company Manager Assignment screen.
-- The assignments and their history are deleted with their tables (export them first if they must be kept:
--   SELECT * FROM cross_company_assignments; SELECT * FROM cross_company_assignment_history;).
-- No employee, manager_id, company, department, payroll or attendance row was ever changed by 0017, so nothing else
-- needs restoring.
--   npx wrangler d1 execute hr-system-db --remote --file scripts/rollback/0017_cross_company_assignments.down.sql

DROP TRIGGER IF EXISTS trg_cca_history_readonly;
DROP TRIGGER IF EXISTS trg_cca_history_nodelete;
DROP TRIGGER IF EXISTS trg_cca_nodelete;
DROP TABLE IF EXISTS cross_company_assignment_history;
DROP TABLE IF EXISTS cross_company_assignments;

DELETE FROM role_permissions WHERE permission IN ('org_assignment.view', 'org_assignment.manage');
DELETE FROM d1_migrations WHERE name = '0017_cross_company_assignments.sql';
