-- Rollback of migrations/0012_feishu_import_separation.sql. Run only after a backup (docs/BACKUP-RECOVERY.md) and
-- only when the imports it added must be removed: imported leave / overtime rows and attendance day events are deleted
-- with their tables. Attendance rows imported with the Feishu daily template stay in attendance_records /
-- attendance_raw_records (they belong to migration 0011's tables). The columns added to attendance_file_imports and
-- attendance_raw_records stay (SQLite cannot drop them safely); they have defaults and nothing reads them after
-- the Worker is rolled back.
--   npx wrangler d1 execute hr-system-db --remote --file scripts/rollback/0012_feishu_import_separation.down.sql

DROP TRIGGER IF EXISTS trg_attendance_raw_readonly_feishu;
DROP TRIGGER IF EXISTS trg_attendance_day_events_readonly;
DROP TRIGGER IF EXISTS trg_attendance_day_events_nodelete;
DROP TRIGGER IF EXISTS trg_leave_import_readonly;
DROP TRIGGER IF EXISTS trg_leave_import_nodelete;
DROP TRIGGER IF EXISTS trg_overtime_import_readonly;
DROP TRIGGER IF EXISTS trg_overtime_import_nodelete;

DROP TABLE IF EXISTS attendance_day_events;
DROP TABLE IF EXISTS leave_import_records;
DROP TABLE IF EXISTS overtime_import_records;
DROP TABLE IF EXISTS request_import_batches;
DROP TABLE IF EXISTS import_mapping_templates;

DELETE FROM role_permissions WHERE permission IN ('leave_import.view', 'leave_import.import', 'overtime_import.view', 'overtime_import.import');
DELETE FROM d1_migrations WHERE name = '0012_feishu_import_separation.sql';
