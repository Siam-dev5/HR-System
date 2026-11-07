-- Holiday maker-checker: who last changed the content of a holiday or a holiday-work record. The approver must be
-- neither the creator nor this content editor (the Super Admin exception still applies, with a note). Source
-- verification, approval, rejection and deactivation do not change it — they are not content changes.
--
-- Additive only: two nullable columns, no default, no backfill (NULL means "no content change since creation" and the
-- API falls back to created_by). No existing row is updated or deleted; payroll is not touched. The columns hold a
-- users.id but carry no REFERENCES clause so that the rollback can drop them (SQLite cannot drop a column that is part
-- of a foreign key). Rollback: scripts/rollback/0015_holiday_content_editor.down.sql

ALTER TABLE holidays ADD COLUMN content_updated_by INTEGER;
ALTER TABLE holiday_work_records ADD COLUMN content_updated_by INTEGER;
