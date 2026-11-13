-- Rollback of migrations/0023_employee_contracts.sql. Run only after a backup (docs/BACKUP-RECOVERY.md) and after the
-- Worker has been rolled back to a version without P5 (that Worker never reads these tables).
-- Lost with the rollback (export first if they must be kept):
--   SELECT * FROM employee_contracts; SELECT * FROM employee_contract_history;
-- No employee, payroll, payslip or money row was changed by 0023.
--   npx wrangler d1 execute hr-system-db --remote --file scripts/rollback/0023_employee_contracts.down.sql
DROP TRIGGER IF EXISTS trg_employee_contract_history_readonly;
DROP TRIGGER IF EXISTS trg_employee_contract_history_nodelete;
DROP TABLE IF EXISTS employee_contract_history;
DROP TRIGGER IF EXISTS trg_employee_contracts_nodelete;
DROP TRIGGER IF EXISTS trg_employee_contracts_overlap_insert;
DROP TRIGGER IF EXISTS trg_employee_contracts_overlap_update;
DROP TRIGGER IF EXISTS trg_employee_contracts_fixed;
DROP TABLE IF EXISTS employee_contracts;

DELETE FROM role_permissions WHERE permission IN ('employee_contract.view', 'employee_contract.manage');
DELETE FROM d1_migrations WHERE name = '0023_employee_contracts.sql';
