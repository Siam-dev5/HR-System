// Permissions are "<resource>.<action>" strings. Roles hold patterns where either part may be "*",
// e.g. "*" (everything), "payroll.*", "*.view". The same matcher is used by the API and the UI,
// so a menu entry is shown exactly when its route would be allowed.

export function permissionMatches(pattern: string, permission: string): boolean {
  if (pattern === '*') return true;
  const [pr, pa] = pattern.split('.');
  const [r, a] = permission.split('.');
  if (!pr || !pa || !r || !a) return false;
  return (pr === '*' || pr === r) && (pa === '*' || pa === a);
}

export function hasPermission(patterns: readonly string[], permission: string): boolean {
  return patterns.some((p) => permissionMatches(p, permission));
}

export const CRUD_ACTIONS = ['view', 'create', 'update', 'delete', 'export'] as const;
export type CrudAction = (typeof CRUD_ACTIONS)[number];

/** Built-in role codes created by the reference-data migration. */
export const ROLE = {
  superAdmin: 'super_admin',
  hrAdmin: 'hr_admin',
  hrManager: 'hr_manager',
  payrollOfficer: 'payroll_officer',
  employee: 'employee',
} as const;
