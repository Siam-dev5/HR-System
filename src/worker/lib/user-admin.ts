// User administration helpers shared by the Admin API and App Management: account state and company scope.
// Company scope follows the existing data model (lib/companies.ts): organisation-wide when any role grants
// employees.all, otherwise the linked employee's own company, otherwise none. No secret column is ever selected.
import type { AppUserRow, UserScope } from '../../shared/app-management';
import { hasPermission } from '../../shared/permissions';

export const USER_COLUMNS = `u.id, u.username, u.display_name, u.email, u.active, u.approval_status, u.mfa_enabled, u.must_change_password,
  u.last_login_at, CASE WHEN u.locked_until > datetime('now') THEN u.locked_until END AS locked_until, u.created_at`;

interface UserBase {
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
}

interface Grants {
  roles: Map<number, Array<{ code: string; privileged: number }>>;
  patterns: Map<number, Map<string, string[]>>; // user -> role code -> patterns
  employees: Map<number, { id: number; emp_code: string; name: string; company_id: number | null; company: string | null }>;
}

/** Roles, permission patterns and employee links of the given users in three queries. */
async function loadGrants(db: D1Database, ids: number[]): Promise<Grants> {
  const out: Grants = { roles: new Map(), patterns: new Map(), employees: new Map() };
  if (!ids.length) return out;
  const json = JSON.stringify(ids);
  const [roles, perms, emps] = await db.batch([
    db.prepare('SELECT ur.user_id, r.code, r.privileged FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id IN (SELECT value FROM json_each(?)) ORDER BY r.privileged DESC, r.code').bind(json),
    db.prepare('SELECT ur.user_id, r.code, rp.permission FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN role_permissions rp ON rp.role_id = r.id WHERE ur.user_id IN (SELECT value FROM json_each(?))').bind(json),
    db.prepare(`SELECT e.user_id, e.id, e.emp_code, e.first_name || ' ' || e.last_name AS name, e.company_id, c.name AS company
                FROM employees e LEFT JOIN companies c ON c.id = e.company_id WHERE e.user_id IN (SELECT value FROM json_each(?))`).bind(json),
  ]);
  for (const r of (roles?.results ?? []) as Array<{ user_id: number; code: string; privileged: number }>) {
    out.roles.set(r.user_id, [...(out.roles.get(r.user_id) ?? []), { code: r.code, privileged: r.privileged }]);
  }
  for (const p of (perms?.results ?? []) as Array<{ user_id: number; code: string; permission: string }>) {
    const byRole = out.patterns.get(p.user_id) ?? new Map<string, string[]>();
    byRole.set(p.code, [...(byRole.get(p.code) ?? []), p.permission]);
    out.patterns.set(p.user_id, byRole);
  }
  for (const e of (emps?.results ?? []) as Array<{ user_id: number; id: number; emp_code: string; name: string; company_id: number | null; company: string | null }>) {
    out.employees.set(e.user_id, { id: e.id, emp_code: e.emp_code, name: e.name, company_id: e.company_id, company: e.company });
  }
  return out;
}

function scopeFrom(byRole: Map<string, string[]> | undefined, emp: { company_id: number | null; company: string | null } | undefined): UserScope {
  const via = [...(byRole ?? new Map<string, string[]>()).entries()].filter(([, p]) => hasPermission(p, 'employees.all')).map(([code]) => code).sort();
  const companyId = emp?.company_id ?? null;
  const company = emp?.company ?? null;
  if (via.length) return { scope: 'all', companyId, company, via };
  if (companyId !== null) return { scope: 'own', companyId, company, via };
  return { scope: 'none', companyId: null, company: null, via };
}

/** Full rows (roles, employee link, company scope) for the given base rows. */
export async function decorateUsers(db: D1Database, base: UserBase[]): Promise<AppUserRow[]> {
  const g = await loadGrants(db, base.map((u) => u.id));
  return base.map((u) => {
    const roles = g.roles.get(u.id) ?? [];
    const emp = g.employees.get(u.id) ?? null;
    return {
      ...u,
      roles: roles.map((r) => r.code),
      privileged: roles.some((r) => r.privileged === 1),
      employee: emp,
      scope: scopeFrom(g.patterns.get(u.id), emp ?? undefined),
    };
  });
}

/** Permission patterns of a user, by role. */
export async function userPatterns(db: D1Database, id: number): Promise<string[]> {
  const g = await loadGrants(db, [id]);
  return [...new Set([...(g.patterns.get(id)?.values() ?? [])].flat())].sort();
}

export async function loadUserRow(db: D1Database, id: number): Promise<AppUserRow | null> {
  const base = await db.prepare(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = ?`).bind(id).first<UserBase>();
  if (!base) return null;
  return (await decorateUsers(db, [base]))[0] ?? null;
}

/** The audit-relevant state of an account (no secrets), for before / after comparison. */
export interface UserState {
  display_name: string;
  email: string | null;
  active: boolean;
  roles: string[];
  employee_id: number | null;
  scope: { scope: string; companyId: number | null };
}

export function stateOf(u: AppUserRow): UserState {
  return {
    display_name: u.display_name,
    email: u.email,
    active: u.active === 1,
    roles: [...u.roles].sort(),
    employee_id: u.employee?.id ?? null,
    scope: { scope: u.scope.scope, companyId: u.scope.companyId },
  };
}

/** Field-level before / after of two states (only what changed). */
export function diffState(before: UserState, after: UserState): Record<string, { before: unknown; after: unknown }> {
  const out: Record<string, { before: unknown; after: unknown }> = {};
  for (const k of Object.keys(before) as Array<keyof UserState>) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out[k] = { before: before[k], after: after[k] };
  }
  return out;
}
