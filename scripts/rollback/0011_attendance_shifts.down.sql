-- LOCAL rollback of migrations/0011_attendance_shifts.sql (development / rehearsal databases only).
-- Never run on production without a fresh backup and the owner's written decision: it deletes the import history,
-- the raw attendance rows, shift groups, members, default-shift history and the group schedule with its revisions.
-- Attendance records created by a file import are kept (they are attendance data) and only lose the batch link.
-- The columns added to shifts and attendance_records stay: SQLite cannot drop a column that carries a foreign key,
-- and the code before 0011 ignores them (they are nullable or have defaults).
--
--   npx wrangler d1 execute hr-system-db --local [--persist-to <dir>] --file scripts/rollback/0011_attendance_shifts.down.sql
--   npx wrangler d1 migrations apply hr-system-db --local [--persist-to <dir>]   # re-applying needs a fresh database
DROP TRIGGER IF EXISTS trg_attendance_raw_readonly;
DROP TRIGGER IF EXISTS trg_attendance_raw_nodelete;
UPDATE attendance_records SET import_batch_id = NULL WHERE import_batch_id IS NOT NULL;
DROP TABLE IF EXISTS shift_schedule_revisions;
DROP TABLE IF EXISTS shift_schedules;
DROP TABLE IF EXISTS shift_group_members;
DROP TABLE IF EXISTS shift_group_defaults;
DROP TABLE IF EXISTS shift_groups;
DROP TABLE IF EXISTS attendance_raw_records;
DROP TABLE IF EXISTS attendance_file_mappings;
DROP TABLE IF EXISTS attendance_file_imports;
DROP INDEX IF EXISTS idx_shifts_company;
DROP INDEX IF EXISTS idx_attendance_records_batch;
DELETE FROM role_permissions WHERE permission IN ('attendance_file.view', 'attendance_file.import', 'shift_groups.view', 'shift_groups.manage', 'shift_schedule.view', 'shift_schedule.manage');
DELETE FROM role_permissions WHERE permission IN ('shifts.create', 'shifts.update') AND role_id = (SELECT id FROM roles WHERE code = 'hr_staff');
DELETE FROM role_permissions WHERE permission = 'shifts.view' AND role_id = (SELECT id FROM roles WHERE code = 'hr_manager');
DELETE FROM d1_migrations WHERE name = '0011_attendance_shifts.sql';
