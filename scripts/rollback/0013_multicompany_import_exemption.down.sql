-- Rollback of migrations/0013_multicompany_import_exemption.sql. Run only after a backup (docs/BACKUP-RECOVERY.md).
-- Import groups, unassigned rows, company rules and exemption periods are deleted with their tables. Attendance
-- batches and rows imported through a group stay (they belong to 0011 / 0012 tables); their group_id is cleared.
-- The group_id column stays (SQLite cannot drop a column with a foreign key); nothing reads it after the Worker is
-- rolled back.
--   npx wrangler d1 execute hr-system-db --remote --file scripts/rollback/0013_multicompany_import_exemption.down.sql

DROP TRIGGER IF EXISTS trg_import_unassigned_readonly;
DROP TRIGGER IF EXISTS trg_import_unassigned_nodelete;
DROP TRIGGER IF EXISTS trg_attendance_exemptions_nodelete;

UPDATE attendance_file_imports SET group_id = NULL WHERE group_id IS NOT NULL;
DROP INDEX IF EXISTS idx_attendance_file_imports_group;
DROP TABLE IF EXISTS import_group_unassigned_rows;
DROP TABLE IF EXISTS import_company_rules;
DROP TABLE IF EXISTS employee_attendance_exemptions;
DROP TABLE IF EXISTS import_groups;

DELETE FROM role_permissions WHERE permission IN ('attendance_exemption.view', 'attendance_exemption.manage');
DELETE FROM d1_migrations WHERE name = '0013_multicompany_import_exemption.sql';
