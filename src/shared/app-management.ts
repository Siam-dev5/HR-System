// App Management (Super Admin): shared types and the permission matrix built from the real permission catalogue.
// Nothing here defines new permissions: rows and cells come from permissionCatalogue() and RESERVED_PERMISSIONS.
import type { MenuGroup } from './modules';
import { MODULES, MENU_GROUPS, RESERVED_PERMISSIONS, permissionCatalogue } from './modules';

/** Matrix columns, in display order. Any other action of a resource is listed under "extras". */
export const MATRIX_ACTIONS = ['view', 'create', 'update', 'delete', 'export', 'approve', 'calculate', 'publish', 'manage'] as const;
export type MatrixAction = (typeof MATRIX_ACTIONS)[number];

export const MATRIX_ACTION_LABELS: Record<MatrixAction, string> = {
  view: 'View', create: 'Create', update: 'Update', delete: 'Delete', export: 'Export', approve: 'Approve', calculate: 'Calculate', publish: 'Publish', manage: 'Manage',
};

export interface MatrixRow {
  resource: string;
  title: string;
  group: MenuGroup;
  /** permission key per action column (null = the action does not exist for this resource) */
  cells: Partial<Record<MatrixAction, string>>;
  /** other real permissions of this resource (all, sensitive, import, own, …) */
  extras: string[];
  /** reserved for the super_admin role: shown, never grantable */
  reserved: string[];
}

export interface MatrixGroup {
  key: MenuGroup;
  title: string;
  rows: MatrixRow[];
}

function resourceInfo(resource: string): { title: string; group: MenuGroup } {
  const crud = MODULES.find((m) => m.kind === 'crud' && m.key === resource);
  if (crud) return { title: crud.title, group: crud.group };
  const page = MODULES.find((m) => m.kind === 'page' && m.perm.split('.')[0] === resource);
  if (page) return { title: page.title, group: page.group };
  if (resource === 'payroll_layout') return { title: 'รูปแบบคอลัมน์ Payroll', group: 'payroll' };
  return { title: resource, group: 'system' };
}

/** The permission matrix: every catalogue permission and every reserved one, grouped by menu group and resource. */
export function permissionMatrix(): MatrixGroup[] {
  const rows = new Map<string, MatrixRow>();
  const row = (resource: string): MatrixRow => {
    let r = rows.get(resource);
    if (!r) {
      r = { resource, ...resourceInfo(resource), cells: {}, extras: [], reserved: [] };
      rows.set(resource, r);
    }
    return r;
  };
  for (const p of permissionCatalogue()) {
    const [resource, ...rest] = p.split('.');
    const action = rest.join('.');
    const r = row(resource as string);
    if ((MATRIX_ACTIONS as readonly string[]).includes(action)) r.cells[action as MatrixAction] = p;
    else r.extras.push(p);
  }
  for (const p of RESERVED_PERMISSIONS) row(p.split('.')[0] as string).reserved.push(p);
  return MENU_GROUPS.map((g) => ({
    key: g.key,
    title: g.title,
    rows: [...rows.values()].filter((r) => r.group === g.key).sort((a, b) => a.title.localeCompare(b.title, 'th')),
  })).filter((g) => g.rows.length);
}

export type ScopeKind = 'all' | 'own' | 'none';

export interface UserScope {
  scope: ScopeKind;
  /** company of the linked employee (own scope; also shown for "all") */
  companyId: number | null;
  company: string | null;
  /** roles that grant organisation-wide scope (employees.all) */
  via: string[];
}

export interface AppUserRow {
  id: number;
  username: string;
  display_name: string;
  email: string | null;
  active: number;
  approval_status: string;
  mfa_enabled: number;
  must_change_password: number;
  last_login_at: string | null;
  locked_until: string | null;
  created_at: string;
  roles: string[];
  privileged: boolean;
  employee: { id: number; emp_code: string; name: string; company_id: number | null; company: string | null } | null;
  scope: UserScope;
}

export interface AppUserDetail extends AppUserRow {
  failed_attempts: number;
  password_changed_at: string | null;
  active_sessions: number;
  role_patterns: string[];
  effective_permissions: string[];
  audit: AppAuditRow[];
}

export interface AppAuditRow {
  id: number;
  at: string;
  user_id: number | null;
  username: string | null;
  action: string;
  entity: string | null;
  entity_id: string | null;
  details: string | null;
  ip: string | null;
}

export interface AppOverview {
  users: { total: number; active: number; inactive: number; pending: number; locked: number; mfaEnabled: number; mustChange: number; privilegedWithoutMfa: number; superAdmins: number };
  roles: { total: number; system: number; custom: number };
  permissions: { catalogue: number; reserved: number };
  companies: number;
  policy: { mfaEnforcedForPrivileged: boolean; passwordMinLength: number; lockoutThreshold: number; lockoutMinutes: number; selfRegistration: boolean };
  mfaAvailable: boolean;
  recent: AppAuditRow[];
}

export interface AppRole {
  id: number;
  code: string;
  name: string;
  description: string | null;
  privileged: number;
  system: number;
  users: number;
  permissions: string[];
}

/** Audit actions App Management shows (security-relevant only). */
export const SECURITY_AUDIT_PREFIXES = ['user.', 'role.', 'settings.', 'auth.', 'mfa.', 'security.', 'job.'] as const;
