// API contracts shared by the Worker and the SPA. Changing a field here breaks the type check
// on both sides, which is how backend/frontend mapping drift is caught at build time.
import type { FieldDef, MenuGroup, WorkflowType, ComputedDef } from './modules';

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

export interface Me {
  id: number;
  username: string;
  displayName: string;
  employeeId: number | null;
  roles: string[];
  permissions: string[];
  mfaEnabled: boolean;
  mfaPending: boolean;
  mustChangePassword: boolean;
}

export interface AuthPolicy {
  mfaEnforcedForPrivileged: boolean;
  lockoutThreshold: number;
  lockoutMinutes: number;
  passwordMinLength: number;
  /** self-registration open (new accounts are pending, without roles, until a Super Admin approves) */
  selfRegistration: boolean;
}

export type LoginResponse =
  | { status: 'ok'; me: Me }
  | { status: 'mfa_required' }
  | { status: 'mfa_enroll_required'; me: Me };

export interface MenuItem {
  key: string;
  path: string;
  title: string;
  group: MenuGroup;
}

export interface ModulePerms {
  view: boolean;
  create: boolean;
  update: boolean;
  delete: boolean;
  export: boolean;
  all: boolean;
  sensitive: boolean;
}

export interface CrudMeta {
  kind: 'crud';
  key: string;
  path: string;
  title: string;
  group: MenuGroup;
  description: string;
  fields: FieldDef[];
  computed: Array<Pick<ComputedDef, 'name' | 'label'>>;
  ownerField: string | null;
  workflow: WorkflowType | null;
  perms: ModulePerms;
}

export interface PageMeta {
  kind: 'page';
  key: string;
  path: string;
  title: string;
  group: MenuGroup;
  allowed: boolean;
  perm: string;
}

export interface MetaResponse {
  me: Me;
  appName: string;
  basePath: string;
  menu: MenuItem[];
  modules: Array<CrudMeta | PageMeta>;
}

/** Contract for every dropdown option. label is always a non-empty string. */
export interface LookupOption {
  value: number;
  label: string;
  code: string | null;
  parentId: number | null;
  depth: number;
}

export type Row = Record<string, string | number | null>;

export interface ListResponse {
  rows: Row[];
  total: number;
  page: number;
  pageSize: number;
}

export interface NotificationItem {
  id: number;
  title: string;
  body: string | null;
  href: string | null;
  external: boolean;
  read: boolean;
  createdAt: string;
}

export interface DashboardWidgetLink {
  label: string;
  value: number;
  /** null when the current user may not open the target */
  href: string | null;
}

export interface DashboardResponse {
  kpis: DashboardWidgetLink[];
  headcountByDepartment: Array<{ department: string; count: number }>;
  nineBox: Array<{ box: number; title: string; count: number; href: string | null }> | null;
  pendingApprovals: number;
  notifications: NotificationItem[];
}

export interface WorkflowRequestRow {
  id: number;
  type: string;
  refTable: string;
  refId: number;
  summary: string;
  status: string;
  currentStep: number;
  stepName: string | null;
  requester: string;
  createdAt: string;
  href: string;
}

export interface PayrollPeriod {
  id: number;
  code: string;
  name: string;
  start_date: string;
  end_date: string;
  pay_date: string;
  status: 'draft' | 'calculated' | 'approved' | 'published';
  employees: number;
  total_net: number;
}

export interface PayslipSummary {
  id: number;
  period_code: string;
  period_name: string;
  pay_date: string;
  employee_id: number;
  employee: string;
  gross: number;
  deductions: number;
  net: number;
  published: number;
}

export interface PayslipDetail extends PayslipSummary {
  base_salary: number;
  ot_amount: number;
  earnings: number;
  unpaid_leave: number;
  sso: number;
  tax: number;
  lines: Array<{ code: string; name: string; kind: 'earning' | 'deduction'; amount: number }>;
  department: string | null;
  position: string | null;
}

export interface NineBoxResponse {
  cycleId: number | null;
  cycles: LookupOption[];
  boxes: Array<{ box: number; title: string; performance: number; potential: number; employees: Array<{ id: number; name: string }> }>;
}

export interface SettingItem {
  key: string;
  value: string;
  type: 'bool' | 'number' | 'text';
  description: string;
}
