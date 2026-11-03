-- Every payslip replaced by a recalculation or removed by "reopen" is copied here first (full row as JSON),
-- so earlier calculation versions — including legacy (pre-0005, calc_version 0) payslips — are never lost.
-- Additive only.
CREATE TABLE payslip_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id INTEGER NOT NULL REFERENCES payroll_periods(id),
  payslip_id INTEGER NOT NULL,
  employee_id INTEGER NOT NULL,
  calc_version INTEGER NOT NULL,
  net REAL NOT NULL,
  row_json TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('recalculate', 'reopen')),
  archived_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_payslip_archive_period ON payslip_archive(period_id, calc_version);
