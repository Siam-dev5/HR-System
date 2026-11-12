// API contracts shared by the Worker and the SPA. Changing a field here breaks the type check
// on both sides, which is how backend/frontend mapping drift is caught at build time.
import type { FieldDef, MenuGroup, WorkflowType, ComputedDef } from './modules';
import type { OrgCrossCompany } from './cross-company';

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
  profile: UserProfile;
  companies: CompanyScope;
}

/** Account details for the header user menu. */
export interface UserProfile {
  email: string | null;
  roles: Array<{ code: string; name: string }>;
}

export interface CompanyOption {
  id: number;
  code: string;
  name: string;
}

/**
 * Companies the user may use as the active company context.
 * all  = organisation-wide data access (employees.all): every active company, plus "all companies"
 * own  = only the company of the user's linked employee record
 * none = no organisation-wide access and no linked employee
 */
export interface CompanyScope {
  scope: 'all' | 'own' | 'none';
  items: CompanyOption[];
  /** company of the user's own employee record, when linked */
  ownCompanyId: number | null;
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
  /** server date (Asia/Bangkok, YYYY-MM-DD) that date-relative values such as tenure are counted to */
  asOf?: string;
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
  /** false when the figure is organisation-wide and ignores the selected company */
  companyScoped?: boolean;
}

export interface DashboardResponse {
  kpis: DashboardWidgetLink[];
  headcountByDepartment: Array<{ department: string; count: number }>;
  nineBox: Array<{ box: number; title: string; count: number; href: string | null }> | null;
  pendingApprovals: number;
  notifications: NotificationItem[];
  /** company the figures are limited to (null = every company the user may see) */
  company: CompanyOption | null;
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
  /** user who calculated the period (maker-checker: they do not approve it, except a Super Admin with a note) */
  calculated_by?: number | null;
  code: string;
  name: string;
  start_date: string;
  end_date: string;
  pay_date: string;
  status: 'draft' | 'calculated' | 'approved' | 'published';
  /** monthly: normal cycle · mid_month: probation advance round (26th – 10th) */
  kind: 'monthly' | 'mid_month';
  /** company whose employees the period pays; null = every company */
  company_id: number | null;
  company: string | null;
  calc_version: number;
  employees: number;
  total_net: number;
  /** EWF employer contributions of the period (company cost, not deducted from employees) */
  total_ewf_employer: number;
  /** payslips calculated before migration 0005 (calc_version 0): recalculation needs explicit confirmation */
  legacy_slips: number;
  approved_at?: string | null;
  published_at?: string | null;
  /** set while a Super Admin has reopened a closed (approved / published) period; cleared when approved again */
  reopened_from?: 'approved' | 'published' | null;
}

/** What a Super Admin period action would touch (shown before confirmation; blockers refuse the action). */
export interface PeriodImpact {
  period: PayrollPeriod;
  payslips: { count: number; gross: number; net: number; published: number; withAdvance: number; advance: number };
  archive: { count: number; versions: number; lastArchivedAt: string | null };
  attendance: { active: number; locked: number; total: number };
  approval: { status: PayrollPeriod['status']; calculatedAt: string | null; approvedAt: string | null; publishedAt: string | null; everPublished: boolean };
  /** monthly: its mid-month rounds · mid_month: the month-end that deducts it */
  dependencies: Array<{ id: number; code: string; kind: PayrollPeriod['kind']; status: PayrollPeriod['status']; relation: 'mid_month_round' | 'month_end'; advance: number }>;
  blockers: { reopen: string[]; delete: string[]; editCalculation: string[] };
}

export interface DeletedPeriod {
  id: number;
  code: string;
  name: string;
  kind: PayrollPeriod['kind'];
  company: string | null;
  start_date: string;
  end_date: string;
  pay_date: string;
  deleted_at: string;
  deleted_by: string | null;
  delete_reason: string | null;
  archived: number;
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
  ewf_employee: number;
  ewf_employee_rate: number | null;
  ewf_status: string | null;
  /** present only for payroll staff (payroll.view); omitted from the employee's own payslip */
  ewf_employer?: number;
  ewf_employer_rate?: number | null;
  lines: Array<{ code: string; name: string; kind: 'earning' | 'deduction'; amount: number; category?: string }>;
  department: string | null;
  position: string | null;
  period_kind: 'monthly' | 'mid_month';
  company: string | null;
  advance: number;
  /** calculation snapshot (wage segments, probation, attendance used); null for slips calculated before 0005 */
  calc: PayslipCalc | null;
  /** year-to-date totals from published monthly payslips; present with payslip_ytd.view */
  ytd?: PayslipYtd;
}

export interface WageSegmentView {
  status: 'probation' | 'passed';
  start: string;
  end: string;
  days: number;
  paidDays: number;
  rate: number;
  amount: number;
}

export interface PayslipCalc {
  segments: WageSegmentView[];
  probationEnd: string;
  probationStatus: 'probation' | 'passed' | 'passed_in_period';
  eligibleDays: number;
  fullPeriod: boolean;
  department: string | null;
  position: string | null;
  attendance: {
    source: 'feishu' | 'requests';
    importId: number | null;
    importVersion: number | null;
    workDays: number | null;
    expectedWorkDays: number | null;
    actualWorkHours: number | null;
    otHours: number;
    unpaidLeaveDays: number;
    unpaidLeaveHours: number | null;
  };
  /** holiday work paid by this payslip (present only when there was approved holiday work): frozen inputs and rates */
  holiday?: HolidayPaySnapshot;
}

export interface HolidayPaySnapshot {
  /** System Settings at calculation time: hourly wage = monthly rate on the work date ÷ divisorDays ÷ hoursPerDay */
  divisorDays: number;
  hoursPerDay: number;
  /** the monthly salary already pays an entitled employee for the holiday itself (entitlement A): nothing extra */
  items: Array<{
    /** salary in force on the work date (salary history), and the hourly wage derived from it */
    monthlyRate: number;
    hourlyRate: number;
    /** employees.employment_type used to pick the pay rule */
    employmentType: string;
    recordId: number;
    holidayId: number;
    holidayName: string;
    holidayType: string;
    date: string;
    normalHours: number;
    otHours: number;
    ruleId: number;
    entitled: boolean;
    workMultiplier: number;
    otMultiplier: number;
    workAmount: number;
    otAmount: number;
  }>;
  workAmount: number;
  otAmount: number;
}

export interface YtdTotals {
  gross: number;
  sso: number;
  tax: number;
  ewf_employee: number;
  slips: number;
}

export interface PayslipYtd {
  year: number;
  /** false when the slip being viewed is not published yet (unpublished payroll is never counted) */
  includesCurrent: boolean;
  company: YtdTotals & { company_id: number | null; company: string | null };
  employee: YtdTotals & { companies: number; records: number };
  byCompany: Array<YtdTotals & { company_id: number | null; company: string | null }>;
}

export interface PreviewIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
  count: number;
}

export interface PayrollPreviewResponse {
  period: PayrollPeriod;
  company: CompanyOption | null;
  /** snapshot: stored payslips (calculated / approved / published) · live: draft period computed without saving */
  source: 'snapshot' | 'live';
  columns: Array<{ key: string; label: string; group: string; type: string }>;
  layout: Array<{ key: string; visible: boolean }>;
  layoutSaved: boolean;
  canManageLayout: boolean;
  rows: Array<Record<string, string | number | null>>;
  totals: Record<string, number>;
  issues: PreviewIssue[];
  exportable: boolean;
}

export interface AttendanceImportSummary {
  id: number;
  company_id: number;
  company: string;
  payroll_period_id: number;
  period: string;
  version: number;
  file_name: string;
  format: 'days' | 'hours';
  layout: 'summary' | 'daily';
  source_start: string | null;
  source_end: string | null;
  row_count: number;
  imported_count: number;
  excluded_count: number;
  status: 'active' | 'superseded' | 'rolled_back';
  locked: number;
  created_at: string;
  created_by_name: string | null;
  rollback_reason: string | null;
  ot_pending: number;
}

export interface AttendancePreviewRow {
  rowNo: number;
  employee_code: string | null;
  employee_name: string | null;
  employee_id: number | null;
  values: Record<string, string | number | null>;
  issues: Array<{ code: string; level: 'error' | 'warning'; message: string }>;
  included: boolean;
}

export interface AttendanceAnalysis {
  fileName: string;
  sha256: string;
  format: 'days' | 'hours' | null;
  layout: 'summary' | 'daily';
  headerRow: number;
  headers: string[];
  mapping: Record<string, number | null>;
  sourceStart: string | null;
  sourceEnd: string | null;
  fileIssues: Array<{ code: string; message: string; level: 'error' | 'warning' }>;
  rows: AttendancePreviewRow[];
  stats: {
    total: number;
    matched: number;
    unknown: number;
    wrongCompany: number;
    duplicates: number;
    invalidDates: number;
    invalidNumbers: number;
    otPending: number;
    leaveAbnormal: number;
    errors: number;
    warnings: number;
    importable: number;
  };
  reconciliation: {
    activeEmployees: number;
    inFile: number;
    missingInFile: Array<{ id: number; emp_code: string; name: string }>;
    totals: Record<string, number>;
    previous: { id: number; version: number; rows: number; totals: Record<string, number> } | null;
  };
  duplicateFile: { id: number; version: number; company: string; period: string; status: string } | null;
  canImport: boolean;
  nextVersion: number;
  locked: boolean;
}

export interface OtReviewRow {
  id: number;
  import_id: number;
  version: number;
  company: string;
  period: string;
  employee_id: number | null;
  employee_code: string;
  employee_name: string | null;
  feishu_overtime_hours: number | null;
  ot_status: 'pending' | 'confirmed' | 'rejected' | 'revised';
  ot_confirmed_hours: number | null;
  ot_rate: number | null;
  ot_reason: string | null;
  reviewer: string | null;
  ot_reviewed_at: string | null;
  locked: number;
}

export interface OrgEmployeeNode {
  id: number;
  emp_code: string;
  name: string;
  company_id: number;
  department_id: number | null;
  position_id: number | null;
  manager_id: number | null;
  status: string;
  hire_date: string;
  email: string | null;
  /** photo version (changes with every upload), null = no photo; bytes come from /api/employees/:id/avatar */
  avatar: string | null;
}

export interface OrgPositionRow {
  id: number;
  code: string;
  title: string;
  department_id: number | null;
  job_grade: string | null;
  approved: number;
  occupied: number;
  vacant: number;
  over: number;
}

export interface OrgDepartmentRow {
  id: number;
  code: string;
  name: string;
  company_id: number;
  parent_id: number | null;
  level: number;
  employees: number;
}

export interface OrgManagerReference {
  id: number;
  emp_code: string;
  name: string;
  company_id: number;
  company_code: string;
  position_title: string | null;
}

export interface OrgDesignResponse {
  company: CompanyOption | null;
  companies: CompanyOption[];
  departments: OrgDepartmentRow[];
  positions: OrgPositionRow[];
  employees: OrgEmployeeNode[];
  /** Actual managers referenced by manager_id outside the selected company; context only, never headcount. */
  managerReferences: OrgManagerReference[];
  stats: { employees: number; departments: number; levels: number; positions: number; occupiedPositions: number; approved: number; occupied: number; vacant: number; over: number };
  canUpdate: boolean;
  canImport: boolean;
  canExport: boolean;
  /** cross company assignments in effect today (functional relationships; never the primary reporting line) */
  crossCompany: OrgCrossCompany;
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
