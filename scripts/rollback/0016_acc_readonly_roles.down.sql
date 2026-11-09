-- Rollback of migrations/0016_acc_readonly_roles.sql. Run only after a backup (docs/BACKUP-RECOVERY.md).
-- Removes the two ACC roles, their permissions and every assignment of them to users (the users themselves and their
-- employee links stay; deactivate them in Admin › Users if they must stop working). Audit rows are kept.
--   npx wrangler d1 execute hr-system-db --remote --file scripts/rollback/0016_acc_readonly_roles.down.sql

DELETE FROM user_roles WHERE role_id IN (SELECT id FROM roles WHERE code IN ('acc_staff', 'acc_manager'));
DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE code IN ('acc_staff', 'acc_manager'));
DELETE FROM roles WHERE code IN ('acc_staff', 'acc_manager');
DELETE FROM d1_migrations WHERE name = '0016_acc_readonly_roles.sql';
