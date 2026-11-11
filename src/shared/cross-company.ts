// Cross Company Manager Assignment: an employee (the responsible "manager") takes a functional / operational
// responsibility for a department or team of another company, optionally for one named employee of that team. It is
// a second kind of relationship next to the primary reporting line (employees.manager_id), which it never changes.
// Pure rules shared by the API, the screens and the organization chart (unit-tested).
import type { OrgLevel } from './org-levels';

export const ASSIGNMENT_TYPES = ['team_lead', 'functional_manager', 'project_lead', 'operational_supervisor'] as const;
export type AssignmentType = (typeof ASSIGNMENT_TYPES)[number];
export const ASSIGNMENT_TYPE_LABEL: Record<AssignmentType, string> = {
  team_lead: 'หัวหน้างานทีม (Team Lead)',
  functional_manager: 'หัวหน้างานตามสายงาน (Functional Manager)',
  project_lead: 'หัวหน้าโครงการ (Project Lead)',
  operational_supervisor: 'ผู้ดูแลการปฏิบัติงาน (Operational Supervisor)',
};
export const ASSIGNMENT_TYPE_SHORT: Record<AssignmentType, string> = { team_lead: 'Team Lead', functional_manager: 'Functional', project_lead: 'Project Lead', operational_supervisor: 'Operational' };

export const ASSIGNMENT_STATUSES = ['active', 'inactive', 'cancelled'] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];
/** what an assignment means today: stored status + effective dates */
export type AssignmentState = 'active' | 'scheduled' | 'expired' | 'inactive' | 'cancelled';
export const ASSIGNMENT_STATE_LABEL: Record<AssignmentState, string> = { active: 'มีผลอยู่', scheduled: 'ยังไม่ถึงวันเริ่ม', expired: 'หมดอายุแล้ว', inactive: 'ระงับชั่วคราว (Inactive)', cancelled: 'ยกเลิกแล้ว' };

export interface AssignmentPeriod {
  status: AssignmentStatus;
  effective_from: string;
  effective_to: string | null;
}

export function assignmentState(a: AssignmentPeriod, today: string): AssignmentState {
  if (a.status === 'cancelled') return 'cancelled';
  if (a.status === 'inactive') return 'inactive';
  if (a.effective_from > today) return 'scheduled';
  if (a.effective_to && a.effective_to < today) return 'expired';
  return 'active';
}
/** in effect on the date (only these are drawn in the organization chart) */
export const inEffect = (a: AssignmentPeriod, today: string): boolean => assignmentState(a, today) === 'active';

const END = '9999-12-31';
export const periodsOverlap = (a: { effective_from: string; effective_to: string | null }, b: { effective_from: string; effective_to: string | null }): boolean =>
  a.effective_from <= (b.effective_to ?? END) && b.effective_from <= (a.effective_to ?? END);

export const isIsoDate = (s: unknown): s is string => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

// ---- validation ------------------------------------------------------------------------------------------------
export interface PersonFact {
  id: number;
  company_id: number;
  /** active or probation */
  active: boolean;
}
export interface DepartmentFact {
  id: number;
  company_id: number;
  active: boolean;
}
export interface AssignmentDraft {
  manager_employee_id: number;
  target_company_id: number;
  target_department_id: number;
  team_name: string | null;
  employee_id: number | null;
  relationship_type: string;
  responsibility: string | null;
  effective_from: string;
  effective_to: string | null;
}
export interface ExistingAssignment extends AssignmentPeriod {
  id: number;
  manager_employee_id: number;
  target_department_id: number;
  team_name: string | null;
  employee_id: number | null;
  relationship_type: string;
}
export interface ValidationContext {
  person: (id: number) => PersonFact | undefined;
  department: (id: number) => DepartmentFact | undefined;
  companyExists: (id: number) => boolean;
  /** other assignments (any status); `exceptId` = the one being edited */
  existing: readonly ExistingAssignment[];
  exceptId?: number;
  /** functional loop check (see assignmentLoop) */
  loop: (draft: AssignmentDraft) => boolean;
}

const norm = (s: string | null) => (s ?? '').trim().toLowerCase();

/** All rule violations of a draft (empty = valid). Messages are user-facing (Thai). */
export function validateAssignment(d: AssignmentDraft, ctx: ValidationContext): string[] {
  const errors: string[] = [];
  const mgr = ctx.person(d.manager_employee_id);
  if (!mgr) errors.push('ไม่พบผู้รับผิดชอบ (หัวหน้างาน)');
  else if (!mgr.active) errors.push('ผู้รับผิดชอบพ้นสภาพพนักงานแล้ว');
  if (!ctx.companyExists(d.target_company_id)) errors.push('ไม่พบบริษัทปลายทาง');
  const dep = ctx.department(d.target_department_id);
  if (!dep) errors.push('ไม่พบหน่วยงาน / ทีมปลายทาง');
  else if (!dep.active) errors.push('หน่วยงานปลายทางถูกปิดใช้งานแล้ว');
  else if (dep.company_id !== d.target_company_id) errors.push('หน่วยงานปลายทางไม่ได้อยู่ในบริษัทปลายทาง');
  if (mgr && mgr.company_id === d.target_company_id) errors.push('ผู้รับผิดชอบอยู่บริษัทเดียวกับบริษัทปลายทาง — ใช้ "หัวหน้า (Reports To)" ตามปกติ ไม่ใช่ความสัมพันธ์ข้ามบริษัท');
  if (d.employee_id !== null) {
    const emp = ctx.person(d.employee_id);
    if (d.employee_id === d.manager_employee_id) errors.push('พนักงานและผู้รับผิดชอบต้องเป็นคนละคน');
    else if (!emp) errors.push('ไม่พบพนักงาน');
    else if (!emp.active) errors.push('พนักงานพ้นสภาพแล้ว');
    else if (emp.company_id !== d.target_company_id) errors.push('พนักงานต้องสังกัดบริษัทปลายทาง');
  }
  if (!(ASSIGNMENT_TYPES as readonly string[]).includes(d.relationship_type)) errors.push('ประเภทความสัมพันธ์ไม่ถูกต้อง');
  if (!isIsoDate(d.effective_from)) errors.push('วันที่เริ่มมีผลไม่ถูกต้อง');
  if (d.effective_to !== null && !isIsoDate(d.effective_to)) errors.push('วันที่สิ้นสุดไม่ถูกต้อง');
  if (isIsoDate(d.effective_from) && d.effective_to !== null && isIsoDate(d.effective_to) && d.effective_to < d.effective_from) errors.push('วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่มมีผล');
  if (errors.length) return errors;
  const dup = ctx.existing.find((x) => x.id !== ctx.exceptId && x.status !== 'cancelled' && x.manager_employee_id === d.manager_employee_id && x.target_department_id === d.target_department_id
    && norm(x.team_name) === norm(d.team_name) && (x.employee_id ?? 0) === (d.employee_id ?? 0) && x.relationship_type === d.relationship_type && periodsOverlap(x, d));
  if (dup) errors.push(`มีความสัมพันธ์เดียวกันอยู่แล้วในช่วงวันที่ซ้อนกัน (#${dup.id} ${dup.effective_from} – ${dup.effective_to ?? 'ไม่กำหนด'})`);
  else if (ctx.loop(d)) errors.push('ความสัมพันธ์นี้ทำให้เกิดวงวน (Relationship Loop): ผู้รับผิดชอบอยู่ใต้สายของพนักงาน / ทีมที่จะดูแลเอง');
  return errors;
}

/**
 * Whether adding the draft closes a loop in the combined graph "child → parent" of the primary reporting line
 * (manager_id) and the assignments in effect (named employee → manager, or every member of the target department →
 * manager). The draft's children (the named employee, or the department members) must not be the manager nor above
 * the manager in that graph. Bounded walk, so existing loops in the data never hang it.
 */
export function assignmentLoop(
  draft: Pick<AssignmentDraft, 'manager_employee_id' | 'employee_id' | 'target_department_id'>,
  people: ReadonlyArray<{ id: number; manager_id: number | null; department_id: number | null }>,
  active: ReadonlyArray<Pick<ExistingAssignment, 'manager_employee_id' | 'employee_id' | 'target_department_id'>>,
): boolean {
  const parents = new Map<number, Set<number>>();
  const add = (child: number, parent: number) => {
    if (child === parent) return;
    const s = parents.get(child) ?? new Set<number>();
    s.add(parent);
    parents.set(child, s);
  };
  const membersOf = (dep: number) => people.filter((p) => p.department_id === dep).map((p) => p.id);
  for (const p of people) if (p.manager_id !== null) add(p.id, p.manager_id);
  for (const a of active) for (const c of a.employee_id !== null ? [a.employee_id] : membersOf(a.target_department_id)) add(c, a.manager_employee_id);
  const children = new Set(draft.employee_id !== null ? [draft.employee_id] : membersOf(draft.target_department_id));
  if (children.has(draft.manager_employee_id)) return true;
  // everyone above the manager
  const seen = new Set<number>([draft.manager_employee_id]);
  const queue = [draft.manager_employee_id];
  while (queue.length) {
    const id = queue.shift() as number;
    for (const p of parents.get(id) ?? []) {
      if (children.has(p)) return true;
      if (!seen.has(p)) {
        seen.add(p);
        queue.push(p);
      }
    }
  }
  return false;
}

// ---- organization chart payload --------------------------------------------------------------------------------
/** one assignment in effect, as the chart receives it */
export interface OrgCrossLink {
  id: number;
  type: AssignmentType;
  manager_id: number;
  employee_id: number | null;
  target_company_id: number;
  target_company_code: string;
  target_department_id: number;
  target_department_name: string;
  team_name: string | null;
  responsibility: string | null;
  effective_from: string;
  effective_to: string | null;
}
/** a person a link refers to; `masked` = outside the viewer's company scope (only the company is shown) */
export interface OrgCrossPerson {
  id: number;
  masked: boolean;
  company_id: number;
  company_code: string;
  company_name: string;
  emp_code: string | null;
  name: string | null;
  position_title: string | null;
  department_id: number | null;
  department_name: string | null;
  avatar: string | null;
  /** chart level from the exact Position Title → Level table (also for a masked person, so the reference card sits
   *  on the right band without revealing the title) */
  level: OrgLevel;
}
export interface OrgCrossCompany {
  links: OrgCrossLink[];
  people: OrgCrossPerson[];
}

/** the reference card key: one card per responsible person and target department / team */
export const refKey = (l: Pick<OrgCrossLink, 'manager_id' | 'target_department_id' | 'team_name'>): string => `${l.manager_id}|${l.target_department_id}|${norm(l.team_name)}`;
/** the reference frame key: one frame per target department / team */
export const refFrameKey = (l: Pick<OrgCrossLink, 'target_department_id' | 'team_name'>): string => `${l.target_department_id}|${norm(l.team_name)}`;
