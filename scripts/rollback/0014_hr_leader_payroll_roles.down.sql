-- Rollback of migrations/0014_hr_leader_payroll_roles.sql. Run only after a backup (docs/BACKUP-RECOVERY.md).
-- Removes the two roles, their permissions and every assignment of them to users (the users themselves stay; give
-- them another role first if they must keep working). Audit rows that mention the roles are kept.
--   npx wrangler d1 execute hr-system-db --remote --file scripts/rollback/0014_hr_leader_payroll_roles.down.sql

DELETE FROM user_roles WHERE role_id IN (SELECT id FROM roles WHERE code IN ('hr_leader', 'hr_payroll'));
DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE code IN ('hr_leader', 'hr_payroll'));
DELETE FROM roles WHERE code IN ('hr_leader', 'hr_payroll');
DELETE FROM d1_migrations WHERE name = '0014_hr_leader_payroll_roles.sql';
