// Cross Company Manager Assignment: queries shared by the management API (/api/org-assignments) and the organization
// chart (/api/org-design). Scope rule: a person whose live company is outside the viewer's company scope is masked
// (only the company is shown); employees.manager_id is only ever read here.
import type { AuthUser } from '../env';
import { avatarVersion } from '../../shared/avatar';
import { inEffect, type AssignmentStatus, type AssignmentType, type OrgCrossCompany, type OrgCrossLink, type OrgCrossPerson } from '../../shared/cross-company';
import { companyScope } from './companies';
import { positionLevel } from '../../shared/org-levels';

export interface AssignmentRow {
  id: number;
  manager_employee_id: number;
  manager_company_id: number;
  target_company_id: number;
  target_department_id: number;
  team_name: string | null;
  employee_id: number | null;
  employee_company_id: number | null;
  relationship_type: AssignmentType;
  responsibility: string | null;
  effective_from: string;
  effective_to: string | null;
  status: AssignmentStatus;
  cancel_reason: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
  // joined
  manager_code: string;
  manager_name: string;
  manager_live_company: number;
  manager_status: string;
  manager_company_code: string;
  manager_company_name: string;
  manager_department_name: string | null;
  manager_position: string | null;
  employee_code: string | null;
  employee_name: string | null;
  employee_live_company: number | null;
  employee_status: string | null;
  employee_company_code: string | null;
  employee_department_name: string | null;
  target_company_code: string;
  target_company_name: string;
  target_department_name: string;
  created_by_name: string | null;
  updated_by_name: string | null;
  cancelled_by_name: string | null;
}

export const ASSIGNMENT_SELECT = `SELECT a.id, a.manager_employee_id, a.manager_company_id, a.target_company_id, a.target_department_id, a.team_name, a.employee_id, a.employee_company_id,
  a.relationship_type, a.responsibility, a.effective_from, a.effective_to, a.status, a.cancel_reason, a.cancelled_at, a.created_at, a.updated_at,
  m.emp_code AS manager_code, m.first_name || ' ' || m.last_name AS manager_name, m.company_id AS manager_live_company, m.status AS manager_status,
  mc.code AS manager_company_code, mc.name AS manager_company_name, md.name AS manager_department_name, mp.title AS manager_position,
  e.emp_code AS employee_code, CASE WHEN e.id IS NULL THEN NULL ELSE e.first_name || ' ' || e.last_name END AS employee_name, e.company_id AS employee_live_company, e.status AS employee_status,
  ec.code AS employee_company_code, ed.name AS employee_department_name,
  tc.code AS target_company_code, tc.name AS target_company_name, td.name AS target_department_name,
  cu.username AS created_by_name, uu.username AS updated_by_name, xu.username AS cancelled_by_name
  FROM cross_company_assignments a
  JOIN employees m ON m.id = a.manager_employee_id
  LEFT JOIN companies mc ON mc.id = m.company_id
  LEFT JOIN departments md ON md.id = m.department_id
  LEFT JOIN positions mp ON mp.id = m.position_id
  LEFT JOIN employees e ON e.id = a.employee_id
  LEFT JOIN companies ec ON ec.id = e.company_id
  LEFT JOIN departments ed ON ed.id = e.department_id
  JOIN companies tc ON tc.id = a.target_company_id
  JOIN departments td ON td.id = a.target_department_id
  LEFT JOIN users cu ON cu.id = a.created_by
  LEFT JOIN users uu ON uu.id = a.updated_by
  LEFT JOIN users xu ON xu.id = a.cancelled_by`;

export async function assignmentRows(db: D1Database, where = '', ...args: unknown[]): Promise<AssignmentRow[]> {
  return (await db.prepare(`${ASSIGNMENT_SELECT} ${where} ORDER BY a.id DESC`).bind(...args).all<AssignmentRow>()).results;
}

/** ids of the companies the user may see */
export async function scopeCompanyIds(db: D1Database, user: AuthUser): Promise<Set<number>> {
  return new Set((await companyScope(db, user)).items.map((c) => c.id));
}

/** companies an assignment involves (live companies of the people + the target company) */
export const involved = (r: Pick<AssignmentRow, 'manager_live_company' | 'target_company_id' | 'employee_live_company'>): number[] => [r.manager_live_company, r.target_company_id, ...(r.employee_live_company !== null ? [r.employee_live_company] : [])];

/** an assignment row for a viewer: people outside the viewer's scope keep only their company */
export function maskRow(r: AssignmentRow, scope: ReadonlySet<number>) {
  const mOk = scope.has(r.manager_live_company);
  const eOk = r.employee_live_company === null || scope.has(r.employee_live_company);
  return {
    ...r,
    manager_masked: !mOk,
    manager_code: mOk ? r.manager_code : null,
    manager_name: mOk ? r.manager_name : null,
    manager_department_name: mOk ? r.manager_department_name : null,
    manager_position: mOk ? r.manager_position : null,
    employee_masked: !eOk,
    employee_code: eOk ? r.employee_code : null,
    employee_name: eOk ? r.employee_name : null,
    employee_department_name: eOk ? r.employee_department_name : null,
  };
}

const ACTIVE = (s: string | null) => s === 'active' || s === 'probation';

/**
 * Assignments in effect today for the organization chart: involving the viewed company (or any company in scope for
 * the all-companies view) and at least one company of the viewer's scope; both people still employed. Every person a
 * link refers to is listed once in `people`, masked when outside the viewer's scope.
 */
export async function orgCrossCompany(db: D1Database, scope: ReadonlySet<number>, companyId: number | null, today: string): Promise<OrgCrossCompany> {
  const rows = (await assignmentRows(db, "WHERE a.status = 'active'")).filter((r) => {
    if (!inEffect(r, today) || !ACTIVE(r.manager_status) || (r.employee_id !== null && !ACTIVE(r.employee_status))) return false;
    const inv = involved(r);
    return inv.some((c) => scope.has(c)) && (companyId === null ? inv.some((c) => scope.has(c)) : inv.includes(companyId));
  });
  const links: OrgCrossLink[] = rows.map((r) => ({
    id: r.id, type: r.relationship_type, manager_id: r.manager_employee_id, employee_id: r.employee_id,
    target_company_id: r.target_company_id, target_company_code: r.target_company_code, target_department_id: r.target_department_id, target_department_name: r.target_department_name,
    team_name: r.team_name, responsibility: r.responsibility, effective_from: r.effective_from, effective_to: r.effective_to,
  }));
  const ids = [...new Set(rows.flatMap((r) => [r.manager_employee_id, ...(r.employee_id !== null ? [r.employee_id] : [])]))];
  const people: OrgCrossPerson[] = [];
  if (ids.length) {
    const { results } = await db.prepare(
      `SELECT e.id, e.emp_code, e.first_name || ' ' || e.last_name AS name, e.company_id, c.code AS company_code, c.name AS company_name, e.department_id, d.name AS department_name, x.title AS position_title,
        (SELECT a.object_key FROM employee_avatars a WHERE a.employee_id = e.id) AS avatar_key
       FROM employees e JOIN companies c ON c.id = e.company_id LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN positions x ON x.id = e.position_id
       WHERE e.id IN (SELECT value FROM json_each(?))`,
    ).bind(JSON.stringify(ids)).all<{ id: number; emp_code: string; name: string; company_id: number; company_code: string; company_name: string; department_id: number | null; department_name: string | null; position_title: string | null; avatar_key: string | null }>();
    for (const p of results) {
      const ok = scope.has(p.company_id);
      people.push({
        id: p.id, masked: !ok, company_id: p.company_id, company_code: p.company_code, company_name: p.company_name,
        emp_code: ok ? p.emp_code : null, name: ok ? p.name : null, position_title: ok ? p.position_title : null,
        department_id: ok ? p.department_id : null, department_name: ok ? p.department_name : null, avatar: ok && p.avatar_key ? avatarVersion(p.avatar_key) : null, level: positionLevel(p.position_title).level,
      });
    }
  }
  return { links, people };
}
