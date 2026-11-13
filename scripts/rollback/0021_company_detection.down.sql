-- Rollback of migrations/0021_company_detection.sql. Run only after a backup (docs/BACKUP-RECOVERY.md) and after the
-- Worker has been rolled back to a version without P3 (that Worker never reads these tables).
-- Lost with the rollback (export first if they must be kept):
--   SELECT * FROM company_code_mappings; SELECT * FROM company_code_mapping_history;
--   SELECT * FROM employee_company_assignments; SELECT * FROM employee_company_assignment_history;
-- employees.company_id keeps its current value (a transfer made after 0021 stays in place); no payroll, payslip or
-- attendance row was changed by 0021.
--   npx wrangler d1 execute hr-system-db --remote --file scripts/rollback/0021_company_detection.down.sql
PRAGMA defer_foreign_keys = on;

DROP TRIGGER IF EXISTS trg_employees_company_change;
DROP TRIGGER IF EXISTS trg_employees_company_assignment_insert;
DROP TRIGGER IF EXISTS trg_employees_company_assignment_delete;

DROP TRIGGER IF EXISTS trg_employee_company_assignment_history_readonly;
DROP TRIGGER IF EXISTS trg_employee_company_assignment_history_nodelete;
DROP TABLE IF EXISTS employee_company_assignment_history;
DROP TRIGGER IF EXISTS trg_employee_company_assignments_nodelete;
DROP TRIGGER IF EXISTS trg_employee_company_assignments_overlap_insert;
DROP TRIGGER IF EXISTS trg_employee_company_assignments_overlap_update;
DROP TRIGGER IF EXISTS trg_employee_company_assignments_fixed;
DROP TABLE IF EXISTS employee_company_assignments;

DROP TRIGGER IF EXISTS trg_company_code_mapping_history_readonly;
DROP TRIGGER IF EXISTS trg_company_code_mapping_history_nodelete;
DROP TABLE IF EXISTS company_code_mapping_history;
DROP TRIGGER IF EXISTS trg_company_code_mappings_nodelete;
DROP TRIGGER IF EXISTS trg_company_code_mappings_overlap_insert;
DROP TRIGGER IF EXISTS trg_company_code_mappings_overlap_update;
DROP TABLE IF EXISTS company_code_mappings;

DELETE FROM role_permissions WHERE permission IN ('company_mapping.view', 'company_mapping.manage', 'employee_company.transfer');
DELETE FROM d1_migrations WHERE name = '0021_company_detection.sql';
