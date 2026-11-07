-- Rollback of migrations/0015_holiday_content_editor.sql. Run only after a backup (docs/BACKUP-RECOVERY.md) and after
-- the Worker has been rolled back to a version that does not read content_updated_by. Drops the two columns (the
-- recorded content editors are lost; every other holiday / holiday-work value stays) and the migration record.
--   npx wrangler d1 execute hr-system-db --remote --file scripts/rollback/0015_holiday_content_editor.down.sql

ALTER TABLE holidays DROP COLUMN content_updated_by;
ALTER TABLE holiday_work_records DROP COLUMN content_updated_by;
DELETE FROM d1_migrations WHERE name = '0015_holiday_content_editor.sql';
