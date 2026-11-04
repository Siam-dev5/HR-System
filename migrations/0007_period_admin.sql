-- Super Admin payroll period management: reopen of closed periods, metadata edit, recoverable (soft) delete,
-- single-use step-up MFA codes and operation tokens that make destructive batches run at most once.
-- Additive only: no existing row is changed.

-- soft delete: the row, its archive and audit history stay; the code is renamed so it can be reused, the original is kept
ALTER TABLE payroll_periods ADD COLUMN deleted_at TEXT;
ALTER TABLE payroll_periods ADD COLUMN deleted_by INTEGER REFERENCES users(id);
ALTER TABLE payroll_periods ADD COLUMN deleted_code TEXT;
ALTER TABLE payroll_periods ADD COLUMN delete_reason TEXT;
-- status the period had when a Super Admin reopened it (approved / published); cleared when it is approved again
ALTER TABLE payroll_periods ADD COLUMN reopened_from TEXT;
-- token of the last state-changing operation: statements of one batch only act when their own claim succeeded
ALTER TABLE payroll_periods ADD COLUMN op_token TEXT;

-- archive rows written by one operation (integrity check: same count and total as the payslips they copy)
ALTER TABLE payslip_archive ADD COLUMN op_token TEXT;
CREATE INDEX idx_payslip_archive_op ON payslip_archive(op_token);

-- a step-up TOTP code is accepted once per user, whatever the operation (action / target kept for the audit trail)
CREATE TABLE mfa_step_up (
  user_id INTEGER NOT NULL REFERENCES users(id),
  counter INTEGER NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  used_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, counter)
);

-- explicit grants (super_admin already holds "*"); reserved — the role editor cannot grant them to other roles
INSERT OR IGNORE INTO role_permissions (role_id, permission) SELECT id, 'payroll.period.reopen' FROM roles WHERE code = 'super_admin';
INSERT OR IGNORE INTO role_permissions (role_id, permission) SELECT id, 'payroll.period.edit_closed' FROM roles WHERE code = 'super_admin';
INSERT OR IGNORE INTO role_permissions (role_id, permission) SELECT id, 'payroll.period.delete' FROM roles WHERE code = 'super_admin';
INSERT OR IGNORE INTO role_permissions (role_id, permission) SELECT id, 'payroll.period.force_recalculate' FROM roles WHERE code = 'super_admin';
