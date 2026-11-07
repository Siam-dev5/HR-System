// Single source of truth for modules: database table, fields, menu placement and permissions.
// The API (generic CRUD, lookups, menu) and the SPA (forms, tables, router) are both driven from here,
// and an integration test checks every table/column below exists in the D1 schema.
import { PERIOD_ADMIN, hasPermission } from './permissions';

export type MenuGroup = 'overview' | 'hrm' | 'hrd' | 'hrod' | 'payroll' | 'system';

export const MENU_GROUPS: ReadonlyArray<{ key: MenuGroup; title: string }> = [
  { key: 'overview', title: 'ภาพรวม' },
  { key: 'hrm', title: 'HRM · บริหารบุคคล' },
  { key: 'hrd', title: 'HRD · พัฒนาบุคลากร' },
  { key: 'hrod', title: 'HROD · พัฒนาองค์กร' },
  { key: 'payroll', title: 'Payroll · เงินเดือน' },
  { key: 'system', title: 'System · ระบบ' },
];

export type FieldType = 'text' | 'textarea' | 'number' | 'money' | 'date' | 'time' | 'select' | 'ref' | 'bool' | 'email' | 'url';
export type WorkflowType = 'leave' | 'overtime' | 'time_correction';

export interface FieldDef {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: readonly string[];
  /** lookup key (a crud module key) for ref fields */
  ref?: string;
  /** shown as a column in list views */
  list?: boolean;
  min?: number;
  max?: number;
  /** set by the system (status of workflow records); never accepted from clients */
  readonly?: boolean;
  /** masked unless the user holds "<perm>.sensitive" */
  sensitive?: boolean;
  /** "unique" constraint is enforced by the schema; label used for the 409 message */
  unique?: boolean;
}

export interface ComputedDef {
  name: string;
  label: string;
  /** trusted SQL expression over the module's own columns */
  expr: string;
}

export interface CrudModule {
  kind: 'crud';
  key: string;
  path: string;
  title: string;
  group: MenuGroup;
  table: string;
  description: string;
  fields: readonly FieldDef[];
  /** trusted SQL expression producing the human label used in lookups/ref columns */
  labelExpr: string;
  codeField?: string;
  tree?: { parentField: string };
  /** records belong to an employee; users without "<key>.all" only see/create their own */
  ownerField?: string;
  /** rows matching this trusted SQL condition are visible to every user who may view the module */
  publicWhere?: string;
  workflow?: WorkflowType;
  computed?: readonly ComputedDef[];
  defaultSort: string;
  searchFields: readonly string[];
}

export interface PageModule {
  kind: 'page';
  key: string;
  path: string;
  title: string;
  group: MenuGroup;
  /** permission required to open the page and its API */
  perm: string;
  /** GET endpoint backing the page (used by the route/permission consistency test) */
  api: string;
  /** hidden pages are reachable (e.g. from links) but not listed in the sidebar */
  hidden?: boolean;
  /** only users holding the super_admin role may open it, whatever permissions other roles carry */
  superAdminOnly?: boolean;
}

export type ModuleDef = CrudModule | PageModule;

// ---- field helpers -------------------------------------------------------------------------
type Extra = Partial<Omit<FieldDef, 'name' | 'label' | 'type'>>;
const text = (name: string, label: string, x: Extra = {}): FieldDef => ({ name, label, type: 'text', ...x });
const area = (name: string, label: string, x: Extra = {}): FieldDef => ({ name, label, type: 'textarea', ...x });
const num = (name: string, label: string, x: Extra = {}): FieldDef => ({ name, label, type: 'number', ...x });
const money = (name: string, label: string, x: Extra = {}): FieldDef => ({ name, label, type: 'money', min: 0, ...x });
const date = (name: string, label: string, x: Extra = {}): FieldDef => ({ name, label, type: 'date', ...x });
const time = (name: string, label: string, x: Extra = {}): FieldDef => ({ name, label, type: 'time', ...x });
const sel = (name: string, label: string, options: readonly string[], x: Extra = {}): FieldDef => ({ name, label, type: 'select', options, ...x });
const ref = (name: string, label: string, target: string, x: Extra = {}): FieldDef => ({ name, label, type: 'ref', ref: target, ...x });
const bool = (name: string, label: string, x: Extra = {}): FieldDef => ({ name, label, type: 'bool', ...x });
const email = (name: string, label: string, x: Extra = {}): FieldDef => ({ name, label, type: 'email', ...x });
const url = (name: string, label: string, x: Extra = {}): FieldDef => ({ name, label, type: 'url', ...x });

const L = { list: true } as const;
const RL = { required: true, list: true } as const;
const codeName = "name || ' (' || code || ')'";
const empLabel = "emp_code || ' ' || first_name || ' ' || last_name";
const workflowStatus = sel('status', 'สถานะ', ['pending', 'approved', 'rejected', 'cancelled'], { list: true, readonly: true });

function crud(m: Omit<CrudModule, 'kind' | 'defaultSort' | 'searchFields' | 'labelExpr'> & Partial<Pick<CrudModule, 'defaultSort' | 'searchFields' | 'labelExpr'>>): CrudModule {
  return {
    kind: 'crud',
    defaultSort: 'id DESC',
    labelExpr: 'name',
    searchFields: m.fields.filter((f) => f.type === 'text' || f.type === 'email').map((f) => f.name),
    ...m,
  };
}

const page = (key: string, path: string, title: string, group: MenuGroup, perm: string, api: string, hidden = false): PageModule => ({
  kind: 'page', key, path, title, group, perm, api, hidden,
});

// ---- registry (sidebar order) ---------------------------------------------------------------
export const MODULES: readonly ModuleDef[] = [
  // Overview
  page('dashboard', '/dashboard', 'Executive Dashboard', 'overview', 'dashboard.view', '/api/dashboard'),
  page('ess', '/ess', 'ESS · ข้อมูลของฉัน', 'overview', 'ess.view', '/api/ess'),
  page('my_payslips', '/my/payslips', 'สลิปเงินเดือนของฉัน', 'overview', 'payslip.own', '/api/my/payslips'),
  page('analytics', '/analytics', 'HR Analytics', 'overview', 'analytics.view', '/api/analytics'),
  page('workflow_inbox', '/workflow/inbox', 'คำขอ & อนุมัติ', 'overview', 'workflow.view', '/api/workflow/inbox'),

  // HRM
  page('organization', '/organization', 'ผังองค์กร', 'hrm', 'departments.view', '/api/organization'),
  crud({
    key: 'departments', path: '/departments', title: 'หน่วยงาน', group: 'hrm', table: 'departments',
    description: 'โครงสร้างหน่วยงานแบบลำดับชั้น', labelExpr: codeName, codeField: 'code', tree: { parentField: 'parent_id' }, defaultSort: 'code',
    fields: [text('code', 'รหัส', { ...RL, unique: true }), text('name', 'ชื่อหน่วยงาน', RL), ref('company_id', 'บริษัท', 'companies', RL), ref('parent_id', 'หน่วยงานแม่', 'departments', L), ref('cost_center_id', 'Cost Center', 'cost_centers'), bool('active', 'ใช้งาน', L)],
  }),
  crud({
    key: 'positions', path: '/positions', title: 'Job & Position', group: 'hrm', table: 'positions',
    description: 'ตำแหน่งงาน ระดับ และอัตรา', labelExpr: "title || ' (' || code || ')'", codeField: 'code', defaultSort: 'code',
    fields: [text('code', 'รหัสตำแหน่ง', { ...RL, unique: true }), text('title', 'ชื่อตำแหน่ง', RL), ref('department_id', 'หน่วยงาน', 'departments', L), text('job_grade', 'ระดับ (Grade)', L), num('headcount', 'อัตรา', { list: true, min: 0 }), area('description', 'รายละเอียดงาน'), bool('active', 'ใช้งาน', L)],
  }),
  crud({
    key: 'employees', path: '/employees', title: 'พนักงาน', group: 'hrm', table: 'employees',
    description: 'ทะเบียนประวัติพนักงาน', labelExpr: empLabel, codeField: 'emp_code', defaultSort: 'emp_code', ownerField: 'id',
    searchFields: ['emp_code', 'first_name', 'last_name', 'email'],
    fields: [
      text('emp_code', 'รหัสพนักงาน', { ...RL, unique: true }), text('first_name', 'ชื่อ', RL), text('last_name', 'นามสกุล', RL), email('email', 'อีเมล', L), text('phone', 'โทรศัพท์'),
      ref('company_id', 'บริษัท', 'companies', { required: true, list: true }), ref('branch_id', 'สาขา', 'branches'), ref('department_id', 'หน่วยงาน', 'departments', L), ref('position_id', 'ตำแหน่ง', 'positions', L), ref('manager_id', 'หัวหน้า', 'employees'),
      date('hire_date', 'วันเริ่มงาน', { required: true }), date('probation_end', 'ครบทดลองงาน'), sel('employment_type', 'ประเภทการจ้าง', ['permanent', 'contract', 'probation', 'intern'], { required: true }),
      sel('status', 'สถานะ', ['active', 'probation', 'resigned', 'terminated'], RL),
      date('termination_date', 'วันพ้นสภาพ (วันทำงานวันสุดท้าย)'), ref('person_id', 'ตัวตนเดียวกับพนักงาน (กรณีโอนย้ายบริษัท)', 'employees'),
      money('base_salary', 'เงินเดือนฐาน', { sensitive: true }), bool('ewf_equivalent_welfare', 'มีสวัสดิการเทียบเท่า (ยกเว้นกองทุนสงเคราะห์ลูกจ้าง)'), text('bank_name', 'ธนาคาร', { sensitive: true }), text('bank_account', 'เลขบัญชี', { sensitive: true }), text('tax_id', 'เลขประจำตัวผู้เสียภาษี', { sensitive: true }),
    ],
  }),
  crud({
    key: 'onboarding', path: '/onboarding', title: 'Onboarding', group: 'hrm', table: 'onboarding_cases', description: 'ติดตามการรับพนักงานใหม่', labelExpr: "'ONB-' || id",
    fields: [ref('employee_id', 'พนักงาน', 'employees', RL), date('start_date', 'วันเริ่มงาน', RL), ref('buddy_employee_id', 'Buddy', 'employees'), area('checklist', 'Checklist'), sel('status', 'สถานะ', ['open', 'in_progress', 'done'], RL)],
  }),
  crud({
    key: 'offboarding', path: '/offboarding', title: 'Offboarding', group: 'hrm', table: 'offboarding_cases', description: 'การพ้นสภาพและเคลียร์ทรัพย์สิน', labelExpr: "'OFB-' || id",
    fields: [ref('employee_id', 'พนักงาน', 'employees', RL), date('last_day', 'วันทำงานวันสุดท้าย', RL), sel('reason', 'เหตุผล', ['resign', 'retire', 'terminate', 'contract_end'], RL), area('exit_interview', 'Exit interview'), sel('clearance_status', 'เคลียร์ทรัพย์สิน', ['pending', 'cleared'], L), sel('status', 'สถานะ', ['open', 'in_progress', 'done'], RL)],
  }),
  crud({
    key: 'manpower', path: '/manpower', title: 'อัตรากำลัง', group: 'hrm', table: 'manpower_plans', description: 'อัตรากำลังที่อนุมัติเทียบปัจจุบัน', labelExpr: "'MP-' || year || '-' || id",
    computed: [{ name: 'vacancy', label: 'อัตราว่าง', expr: 'approved_headcount - current_headcount' }],
    fields: [num('year', 'ปี', { ...RL, min: 2000, max: 2600 }), ref('department_id', 'หน่วยงาน', 'departments', RL), ref('position_id', 'ตำแหน่ง', 'positions', L), num('approved_headcount', 'อัตราอนุมัติ', { ...RL, min: 0 }), num('current_headcount', 'อัตราปัจจุบัน', { ...RL, min: 0 }), area('note', 'หมายเหตุ')],
  }),
  crud({
    key: 'requisitions', path: '/recruitment', title: 'สรรหา (ATS)', group: 'hrm', table: 'requisitions', description: 'ใบขอสรรหา', labelExpr: "code || ' ' || title", codeField: 'code',
    fields: [text('code', 'เลขที่', { ...RL, unique: true }), text('title', 'ตำแหน่งที่ต้องการ', RL), ref('position_id', 'ตำแหน่ง', 'positions'), ref('department_id', 'หน่วยงาน', 'departments', L), num('openings', 'จำนวน', { ...RL, min: 1 }), date('opened_date', 'วันที่เปิด', L), sel('status', 'สถานะ', ['open', 'on_hold', 'filled', 'cancelled'], RL), ref('recruiter_employee_id', 'ผู้สรรหา', 'employees')],
  }),
  crud({
    key: 'candidates', path: '/recruitment/candidates', title: 'ผู้สมัคร', group: 'hrm', table: 'candidates', description: 'ผู้สมัครและสถานะ pipeline', labelExpr: 'full_name',
    fields: [ref('requisition_id', 'ใบขอสรรหา', 'requisitions', RL), text('full_name', 'ชื่อ-นามสกุล', RL), email('email', 'อีเมล', L), text('phone', 'โทรศัพท์'), sel('source', 'แหล่งที่มา', ['website', 'referral', 'jobboard', 'agency', 'other'], L), sel('stage', 'ขั้นตอน', ['applied', 'screening', 'interview', 'offer', 'hired', 'rejected'], RL), date('pdpa_consent_until', 'เก็บข้อมูลถึง (PDPA)', L), area('note', 'หมายเหตุ')],
  }),
  crud({
    key: 'attendance', path: '/attendance', title: 'บันทึกเวลาทำงาน', group: 'hrm', table: 'attendance_records', description: 'บันทึกเวลาเข้า-ออก', labelExpr: "work_date || ' #' || employee_id", ownerField: 'employee_id', defaultSort: 'work_date DESC, id DESC',
    fields: [ref('employee_id', 'พนักงาน', 'employees', RL), date('work_date', 'วันที่', RL), time('clock_in', 'เวลาเข้า', L), time('clock_out', 'เวลาออก', L), sel('status', 'สถานะ', ['present', 'late', 'absent', 'leave'], RL), sel('source', 'ที่มา', ['web', 'device', 'manual', 'import'], L), text('note', 'หมายเหตุ')],
  }),
  page('attendance_file_import', '/attendance/file-import', 'นำเข้าไฟล์เวลาทำงาน', 'hrm', 'attendance_file.import', '/api/attendance-files/fields'),
  page('attendance_file_history', '/attendance/file-imports', 'ประวัติการนำเข้าเวลา', 'hrm', 'attendance_file.view', '/api/attendance-files'),
  page('shift_groups', '/shifts/groups', 'กลุ่มกะ', 'hrm', 'shift_groups.view', '/api/shifts/groups'),
  page('shift_schedule', '/shifts/schedule', 'ตารางกะกลุ่ม', 'hrm', 'shift_schedule.view', '/api/shifts/schedule'),
  crud({
    key: 'shifts', path: '/shifts', title: 'กะการทำงาน', group: 'hrm', table: 'shifts', description: 'กำหนดกะและเวลาเข้างาน', labelExpr: codeName, codeField: 'code', defaultSort: 'code',
    fields: [text('code', 'รหัสกะ', { ...RL, unique: true }), text('name', 'ชื่อกะ', RL), time('start_time', 'เวลาเข้า', RL), time('end_time', 'เวลาออก', RL), num('break_minutes', 'พัก (นาที)', { list: true, min: 0 }), bool('active', 'ใช้งาน', L)],
  }),
  crud({
    key: 'shift_assignments', path: '/shifts/assignments', title: 'ตารางกะพนักงาน', group: 'hrm', table: 'shift_assignments', description: 'มอบหมายกะให้พนักงาน', labelExpr: "'SA-' || id",
    fields: [ref('employee_id', 'พนักงาน', 'employees', RL), ref('shift_id', 'กะ', 'shifts', RL), date('start_date', 'ตั้งแต่', RL), date('end_date', 'ถึง', L)],
  }),
  crud({
    key: 'time_corrections', path: '/time-corrections', title: 'แก้ไขเวลา', group: 'hrm', table: 'time_corrections', description: 'คำขอแก้ไขเวลา (ผ่าน Workflow)', labelExpr: "'TC-' || id", ownerField: 'employee_id', workflow: 'time_correction',
    fields: [ref('employee_id', 'พนักงาน', 'employees', RL), date('work_date', 'วันที่', RL), time('clock_in', 'เวลาเข้าที่ถูกต้อง', L), time('clock_out', 'เวลาออกที่ถูกต้อง', L), text('reason', 'เหตุผล', RL), workflowStatus],
  }),
  crud({
    key: 'overtime', path: '/overtime', title: 'คำขอ OT', group: 'hrm', table: 'overtime_requests', description: 'คำขอทำงานล่วงเวลา (ผ่าน Workflow)', labelExpr: "'OT-' || id", ownerField: 'employee_id', workflow: 'overtime',
    fields: [ref('employee_id', 'พนักงาน', 'employees', RL), date('work_date', 'วันที่', RL), num('hours', 'ชั่วโมง', { ...RL, min: 0.5, max: 12 }), sel('rate', 'อัตรา (เท่า)', ['1.5', '2', '3'], RL), text('reason', 'เหตุผล', RL), workflowStatus],
  }),
  // Feishu OT export: kept in overtime_import_records (never overtime_requests, which payroll reads)
  page('overtime_import', '/overtime/import', 'นำเข้าข้อมูล OT', 'hrm', 'overtime_import.import', '/api/overtime-imports/fields'),
  page('overtime_import_history', '/overtime/imports', 'ประวัติการนำเข้า OT', 'hrm', 'overtime_import.view', '/api/overtime-imports'),
  crud({
    key: 'leave', path: '/leave', title: 'การลา', group: 'hrm', table: 'leave_requests', description: 'คำขอลา (ผ่าน Workflow)', labelExpr: "'LV-' || id", ownerField: 'employee_id', workflow: 'leave', defaultSort: 'start_date DESC',
    fields: [ref('employee_id', 'พนักงาน', 'employees', RL), ref('leave_type_id', 'ประเภทการลา', 'leave_types', RL), date('start_date', 'ตั้งแต่', RL), date('end_date', 'ถึง', RL), num('days', 'จำนวนวัน', { ...RL, min: 0.5, max: 365 }), text('reason', 'เหตุผล', L), workflowStatus],
  }),
  // Feishu leave export: kept in leave_import_records (never leave_requests, which payroll reads)
  page('leave_import', '/leave/import', 'นำเข้าข้อมูลการลา', 'hrm', 'leave_import.import', '/api/leave-imports/fields'),
  page('leave_import_history', '/leave/imports', 'ประวัติการนำเข้าการลา', 'hrm', 'leave_import.view', '/api/leave-imports'),
  crud({
    key: 'performance_cycles', path: '/performance/cycles', title: 'รอบประเมิน', group: 'hrm', table: 'performance_cycles', description: 'รอบการประเมิน KPI/OKR', labelExpr: codeName, codeField: 'code',
    fields: [text('code', 'รหัส', { ...RL, unique: true }), text('name', 'ชื่อรอบ', RL), date('start_date', 'เริ่ม', RL), date('end_date', 'สิ้นสุด', RL), sel('status', 'สถานะ', ['planning', 'active', 'closed'], RL)],
  }),
  crud({
    key: 'performance', path: '/performance', title: 'ประเมินผล (KPI/OKR)', group: 'hrm', table: 'performance_reviews', description: 'ผลประเมินรายบุคคล', labelExpr: "'PR-' || id", ownerField: 'employee_id',
    fields: [ref('cycle_id', 'รอบประเมิน', 'performance_cycles', RL), ref('employee_id', 'พนักงาน', 'employees', RL), ref('reviewer_employee_id', 'ผู้ประเมิน', 'employees'), num('kpi_score', 'คะแนน KPI (0-5)', { list: true, min: 0, max: 5 }), num('okr_progress', 'ความคืบหน้า OKR (%)', { list: true, min: 0, max: 100 }), sel('rating', 'เกรด', ['1', '2', '3', '4', '5'], L), area('comment', 'ความเห็น'), sel('status', 'สถานะ', ['draft', 'submitted', 'calibrated'], RL)],
  }),
  page('holiday_calendar', '/holidays', 'ปฏิทินวันหยุด', 'hrm', 'holiday_calendar.view', '/api/holidays'),
  page('attendance_import', '/attendance/import', 'นำเข้าเวลาทำงาน (Feishu)', 'hrm', 'attendance_import.view', '/api/attendance/imports'),
  page('ot_review', '/attendance/ot-review', 'ตรวจสอบ OT (Feishu)', 'hrm', 'ot_review.view', '/api/attendance/ot'),
  page('talent', '/talent', 'Talent 9-Box', 'hrm', 'talent.view', '/api/talent/ninebox'),
  crud({
    key: 'talent_assessments', path: '/talent/assessments', title: 'ประเมิน Talent', group: 'hrm', table: 'talent_assessments', description: 'ผลงาน × ศักยภาพ (1-3)', labelExpr: "'TA-' || id",
    fields: [ref('cycle_id', 'รอบประเมิน', 'performance_cycles', RL), ref('employee_id', 'พนักงาน', 'employees', RL), num('performance', 'ผลงาน (1-3)', { ...RL, min: 1, max: 3 }), num('potential', 'ศักยภาพ (1-3)', { ...RL, min: 1, max: 3 }), area('note', 'หมายเหตุ')],
  }),

  // HRD
  crud({
    key: 'competencies', path: '/competencies', title: 'Competency', group: 'hrd', table: 'competencies', description: 'พจนานุกรมสมรรถนะ', labelExpr: codeName, codeField: 'code', defaultSort: 'code',
    fields: [text('code', 'รหัส', { ...RL, unique: true }), text('name', 'ชื่อสมรรถนะ', RL), sel('category', 'กลุ่ม', ['core', 'managerial', 'functional'], RL), num('max_level', 'ระดับสูงสุด', { list: true, min: 1, max: 10 }), area('description', 'คำอธิบาย')],
  }),
  crud({
    key: 'skills', path: '/skills', title: 'ทักษะ', group: 'hrd', table: 'skills', description: 'รายการทักษะ', labelExpr: codeName, codeField: 'code', defaultSort: 'code',
    fields: [text('code', 'รหัส', { ...RL, unique: true }), text('name', 'ชื่อทักษะ', RL), text('category', 'หมวด', L)],
  }),
  crud({
    key: 'employee_skills', path: '/skills/matrix', title: 'Skill Matrix & Gap', group: 'hrd', table: 'employee_skills', description: 'ระดับทักษะปัจจุบันเทียบที่ต้องการ', labelExpr: "'ES-' || id", ownerField: 'employee_id',
    computed: [{ name: 'gap', label: 'Gap', expr: 'MAX(required_level - current_level, 0)' }],
    fields: [ref('employee_id', 'พนักงาน', 'employees', RL), ref('skill_id', 'ทักษะ', 'skills', RL), num('current_level', 'ระดับปัจจุบัน (0-5)', { ...RL, min: 0, max: 5 }), num('required_level', 'ระดับที่ต้องการ (0-5)', { ...RL, min: 0, max: 5 })],
  }),
  crud({
    key: 'training_needs', path: '/tna', title: 'Training Need (TNA)', group: 'hrd', table: 'training_needs', description: 'วิเคราะห์ความจำเป็นในการฝึกอบรม', labelExpr: "'TNA-' || id",
    fields: [ref('employee_id', 'พนักงาน', 'employees', RL), ref('competency_id', 'สมรรถนะ', 'competencies', L), ref('course_id', 'หลักสูตรที่เสนอ', 'courses', L), num('year', 'ปี', { ...RL, min: 2000, max: 2600 }), sel('priority', 'ความสำคัญ', ['high', 'medium', 'low'], RL), sel('status', 'สถานะ', ['identified', 'planned', 'done'], RL)],
  }),
  crud({
    key: 'courses', path: '/training/courses', title: 'หลักสูตร', group: 'hrd', table: 'courses', description: 'แคตตาล็อกหลักสูตร', labelExpr: codeName, codeField: 'code', defaultSort: 'code',
    fields: [text('code', 'รหัส', { ...RL, unique: true }), text('name', 'ชื่อหลักสูตร', RL), text('provider', 'ผู้จัด', L), num('hours', 'ชั่วโมง', { list: true, min: 0 }), money('cost', 'ค่าใช้จ่าย/คน', L), sel('mode', 'รูปแบบ', ['classroom', 'online', 'blended'], L)],
  }),
  crud({
    key: 'training', path: '/training', title: 'อบรม / LMS', group: 'hrd', table: 'training_sessions', description: 'รอบอบรม', labelExpr: "'TS-' || id || ' ' || start_date",
    fields: [ref('course_id', 'หลักสูตร', 'courses', RL), date('start_date', 'เริ่ม', RL), date('end_date', 'สิ้นสุด', L), text('location', 'สถานที่', L), num('capacity', 'จำนวนรับ', { min: 0 }), sel('status', 'สถานะ', ['planned', 'open', 'completed', 'cancelled'], RL)],
  }),
  crud({
    key: 'training_enrollments', path: '/training/enrollments', title: 'ผู้เข้าอบรม', group: 'hrd', table: 'training_enrollments', description: 'การลงทะเบียนและผลอบรม', labelExpr: "'EN-' || id", ownerField: 'employee_id',
    fields: [ref('session_id', 'รอบอบรม', 'training', RL), ref('employee_id', 'พนักงาน', 'employees', RL), sel('status', 'สถานะ', ['enrolled', 'attended', 'completed', 'no_show'], RL), num('score', 'คะแนน', { list: true, min: 0, max: 100 })],
  }),
  crud({
    key: 'ojt', path: '/ojt', title: 'OJT', group: 'hrd', table: 'ojt_assignments', description: 'การฝึกปฏิบัติหน้างาน', labelExpr: "'OJT-' || id || ' ' || topic", ownerField: 'employee_id',
    fields: [ref('employee_id', 'พนักงาน', 'employees', RL), ref('mentor_employee_id', 'พี่เลี้ยง', 'employees', L), text('topic', 'หัวข้อ', RL), date('start_date', 'เริ่ม', L), date('end_date', 'สิ้นสุด'), num('progress', 'ความคืบหน้า (%)', { list: true, min: 0, max: 100 }), sel('status', 'สถานะ', ['planned', 'in_progress', 'completed'], RL)],
  }),
  crud({
    key: 'idp', path: '/idp', title: 'IDP', group: 'hrd', table: 'idps', description: 'แผนพัฒนารายบุคคล', labelExpr: "'IDP-' || id", ownerField: 'employee_id',
    fields: [ref('employee_id', 'พนักงาน', 'employees', RL), num('year', 'ปี', { ...RL, min: 2000, max: 2600 }), area('goal', 'เป้าหมาย', { required: true }), area('actions', 'กิจกรรมพัฒนา'), date('target_date', 'กำหนดเสร็จ', L), num('progress', 'ความคืบหน้า (%)', { list: true, min: 0, max: 100 }), sel('status', 'สถานะ', ['draft', 'active', 'completed'], RL)],
  }),
  crud({
    key: 'career_paths', path: '/career-paths', title: 'Career Path', group: 'hrd', table: 'career_paths', description: 'เส้นทางความก้าวหน้า', labelExpr: 'name',
    fields: [text('name', 'ชื่อเส้นทาง', RL), ref('from_position_id', 'จากตำแหน่ง', 'positions', RL), ref('to_position_id', 'ไปตำแหน่ง', 'positions', RL), num('min_years', 'อายุงานขั้นต่ำ (ปี)', { list: true, min: 0 }), area('requirements', 'คุณสมบัติ')],
  }),

  // HROD
  page('org_chart', '/org-chart', 'Organization Design · ผังองค์กร', 'hrod', 'org_chart.view', '/api/org-design'),
  crud({
    key: 'org_design', path: '/org-design', title: 'Org Design Scenario', group: 'hrod', table: 'org_design_scenarios', description: 'Scenario การออกแบบโครงสร้าง', labelExpr: codeName, codeField: 'code',
    fields: [text('code', 'รหัส', { ...RL, unique: true }), text('name', 'ชื่อ Scenario', RL), area('description', 'รายละเอียด'), date('effective_date', 'มีผล', L), sel('status', 'สถานะ', ['draft', 'review', 'approved', 'rejected'], RL)],
  }),
  crud({
    key: 'workforce_plans', path: '/workforce-planning', title: 'Workforce Planning', group: 'hrod', table: 'workforce_plans', description: 'Demand / Supply กำลังคน', labelExpr: "'WP-' || year || '-' || id",
    computed: [{ name: 'gap', label: 'Gap', expr: 'demand - supply' }],
    fields: [num('year', 'ปี', { ...RL, min: 2000, max: 2600 }), ref('department_id', 'หน่วยงาน', 'departments', RL), ref('position_id', 'ตำแหน่ง', 'positions', L), num('demand', 'ความต้องการ', { ...RL, min: 0 }), num('supply', 'ที่มีอยู่', { ...RL, min: 0 }), area('action', 'แผนปิด Gap')],
  }),
  crud({
    key: 'surveys', path: '/engagement', title: 'Engagement & eNPS', group: 'hrod', table: 'surveys', description: 'แบบสำรวจความผูกพัน', labelExpr: "code || ' ' || title", codeField: 'code',
    fields: [text('code', 'รหัส', { ...RL, unique: true }), text('title', 'ชื่อแบบสำรวจ', RL), sel('type', 'ประเภท', ['engagement', 'enps', 'pulse'], RL), date('open_date', 'เปิด', L), date('close_date', 'ปิด', L), sel('status', 'สถานะ', ['draft', 'open', 'closed'], RL)],
  }),
  crud({
    key: 'survey_responses', path: '/engagement/responses', title: 'คำตอบแบบสำรวจ', group: 'hrod', table: 'survey_responses', description: 'คำตอบ (ไม่ระบุตัวตน)', labelExpr: "'R-' || id",
    fields: [ref('survey_id', 'แบบสำรวจ', 'surveys', RL), num('score', 'คะแนน (0-10)', { ...RL, min: 0, max: 10 }), area('comment', 'ข้อเสนอแนะ')],
  }),
  crud({
    key: 'od_projects', path: '/od-projects', title: 'OD Projects', group: 'hrod', table: 'od_projects', description: 'โครงการพัฒนาองค์กร', labelExpr: codeName, codeField: 'code',
    fields: [text('code', 'รหัส', { ...RL, unique: true }), text('name', 'ชื่อโครงการ', RL), ref('owner_employee_id', 'เจ้าของโครงการ', 'employees', L), date('start_date', 'เริ่ม', L), date('end_date', 'สิ้นสุด'), money('budget', 'งบประมาณ', L), num('progress', 'ความคืบหน้า (%)', { list: true, min: 0, max: 100 }), sel('status', 'สถานะ', ['planned', 'active', 'completed', 'on_hold'], RL)],
  }),

  // Payroll
  page('payroll', '/payroll', 'งวดเงินเดือน', 'payroll', 'payroll.view', '/api/payroll/periods'),
  page('payroll_preview', '/payroll/preview', 'Payroll Preview', 'payroll', 'payroll_preview.view', '/api/payroll/periods'),
  page('payslips', '/payroll/payslips', 'สลิปเงินเดือน (HR)', 'payroll', 'payroll.view', '/api/payroll/payslips'),
  crud({
    key: 'pay_components', path: '/payroll/components', title: 'รายการเงินได้/เงินหัก', group: 'payroll', table: 'pay_components', description: 'Master รายการเงินได้และเงินหัก', labelExpr: codeName, codeField: 'code', defaultSort: 'code',
    fields: [text('code', 'รหัส', { ...RL, unique: true }), text('name', 'ชื่อรายการ', RL), sel('kind', 'ประเภท', ['earning', 'deduction'], RL), sel('category', 'กลุ่มใน Payroll Preview', ['allowance', 'commission', 'bonus', 'provident_fund', 'other'], RL), bool('taxable', 'คิดภาษี', L), bool('active', 'ใช้งาน', L)],
  }),
  crud({
    key: 'salary_history', path: '/payroll/salary-history', title: 'ประวัติอัตราเงินเดือน', group: 'payroll', table: 'employee_salary_history',
    description: 'อัตราเงินเดือนที่อนุมัติพร้อมวันที่มีผล (ใช้คำนวณแยกช่วงก่อน/หลังผ่านทดลองงาน) — บันทึกอัตราเดิมตั้งแต่วันเริ่มงานด้วย', labelExpr: "'SH-' || id", defaultSort: 'effective_date DESC',
    fields: [ref('employee_id', 'พนักงาน', 'employees', RL), date('effective_date', 'มีผลตั้งแต่', RL), money('base_salary', 'อัตราเงินเดือน', { ...RL, sensitive: true }), text('reason', 'เหตุผล / เลขที่อนุมัติ', L)],
  }),
  crud({
    key: 'employee_pay_items', path: '/payroll/items', title: 'เงินได้/เงินหักประจำ', group: 'payroll', table: 'employee_pay_items', description: 'รายการประจำรายพนักงาน', labelExpr: "'PI-' || id",
    fields: [ref('employee_id', 'พนักงาน', 'employees', RL), ref('component_id', 'รายการ', 'pay_components', RL), money('amount', 'จำนวนเงิน', { ...RL, sensitive: true }), date('start_date', 'ตั้งแต่', L), date('end_date', 'ถึง', L)],
  }),

  // System
  crud({
    key: 'companies', path: '/setup/companies', title: 'บริษัท', group: 'system', table: 'companies', description: 'กำหนดค่าเริ่มต้น · บริษัท', labelExpr: codeName, codeField: 'code', defaultSort: 'code',
    fields: [text('code', 'รหัส', { ...RL, unique: true }), text('name', 'ชื่อบริษัท', RL), text('tax_id', 'เลขผู้เสียภาษี', L), area('address', 'ที่อยู่'), text('phone', 'โทรศัพท์'), bool('active', 'ใช้งาน', L)],
  }),
  crud({
    key: 'branches', path: '/setup/branches', title: 'สาขา', group: 'system', table: 'branches', description: 'กำหนดค่าเริ่มต้น · สาขา', labelExpr: codeName, codeField: 'code', defaultSort: 'code',
    fields: [ref('company_id', 'บริษัท', 'companies', RL), text('code', 'รหัส', { ...RL, unique: true }), text('name', 'ชื่อสาขา', RL), area('address', 'ที่อยู่'), bool('active', 'ใช้งาน', L)],
  }),
  crud({
    key: 'cost_centers', path: '/setup/cost-centers', title: 'Cost Center', group: 'system', table: 'cost_centers', description: 'ศูนย์ต้นทุน', labelExpr: codeName, codeField: 'code', defaultSort: 'code',
    fields: [ref('company_id', 'บริษัท', 'companies', RL), text('code', 'รหัส', { ...RL, unique: true }), text('name', 'ชื่อ', RL), bool('active', 'ใช้งาน', L)],
  }),
  crud({
    key: 'leave_types', path: '/setup/leave-types', title: 'ประเภทการลา', group: 'system', table: 'leave_types', description: 'สิทธิ์ลาต่อปี', labelExpr: codeName, codeField: 'code', defaultSort: 'code',
    fields: [text('code', 'รหัส', { ...RL, unique: true }), text('name', 'ชื่อ', RL), num('days_per_year', 'สิทธิ์ (วัน/ปี)', { ...RL, min: 0 }), bool('paid', 'ได้รับค่าจ้าง', L)],
  }),
  crud({
    key: 'workflow_definitions', path: '/settings/workflows', title: 'Workflow Engine', group: 'system', table: 'workflow_definitions', description: 'ลำดับขั้นอนุมัติตามบทบาท', labelExpr: "type || ' #' || step", defaultSort: 'type, step',
    fields: [sel('type', 'ประเภทคำขอ', ['leave', 'overtime', 'time_correction'], RL), num('step', 'ลำดับขั้น', { ...RL, min: 1, max: 10 }), text('name', 'ชื่อขั้น', RL), ref('approver_role_id', 'บทบาทผู้อนุมัติ', 'roles', RL)],
  }),
  crud({
    key: 'documents', path: '/documents', title: 'เอกสาร', group: 'system', table: 'documents', description: 'ทะเบียนเอกสาร (ลิงก์ไปยังที่จัดเก็บ)', labelExpr: 'title', ownerField: 'employee_id', publicWhere: 'employee_id IS NULL AND confidential = 0',
    fields: [text('title', 'ชื่อเอกสาร', RL), sel('category', 'หมวด', ['policy', 'contract', 'form', 'certificate', 'other'], RL), ref('employee_id', 'พนักงาน (ถ้าเป็นเอกสารส่วนบุคคล)', 'employees', L), url('url', 'ลิงก์ไฟล์', L), date('effective_date', 'มีผล', L), bool('confidential', 'ลับ', L)],
  }),
  page('reports', '/reports', 'รายงาน & Export', 'system', 'reports.view', '/api/reports/datasets'),
  crud({
    key: 'pdpa', path: '/pdpa', title: 'PDPA', group: 'system', table: 'pdpa_requests', description: 'คำขอใช้สิทธิ์เจ้าของข้อมูล', labelExpr: "'DSR-' || id",
    fields: [text('requester_name', 'ผู้ยื่นคำขอ', RL), ref('employee_id', 'พนักงานที่เกี่ยวข้อง', 'employees'), sel('type', 'ประเภท', ['access', 'rectify', 'erase', 'object', 'portability'], RL), date('received_date', 'วันที่รับ', RL), date('due_date', 'ครบกำหนด', RL), sel('status', 'สถานะ', ['received', 'in_progress', 'completed', 'rejected'], RL), area('note', 'บันทึก')],
  }),
  page('audit', '/audit', 'Audit Log', 'system', 'audit.view', '/api/audit'),
  { ...page('users', '/admin/users', 'ผู้ใช้ระบบ', 'system', 'users.manage', '/api/admin/users'), superAdminOnly: true },
  { ...page('roles', '/admin/roles', 'บทบาท & สิทธิ์', 'system', 'roles.manage', '/api/admin/roles'), superAdminOnly: true },
  { ...page('settings', '/admin/settings', 'ตั้งค่าระบบ', 'system', 'settings.manage', '/api/admin/settings'), superAdminOnly: true },
  page('security', '/security', 'ความปลอดภัย & MFA', 'system', 'security.self', '/api/security/status'),
  page('help', '/help', 'คู่มือการใช้งาน', 'system', 'help.view', '/api/help'),
];

export const CRUD_MODULES: readonly CrudModule[] = MODULES.filter((m): m is CrudModule => m.kind === 'crud');
export const PAGE_MODULES: readonly PageModule[] = MODULES.filter((m): m is PageModule => m.kind === 'page');

export function crudModule(key: string): CrudModule | undefined {
  return CRUD_MODULES.find((m) => m.key === key);
}

/** Permission needed to open a module's main view. */
export function viewPermission(m: ModuleDef): string {
  return m.kind === 'crud' ? `${m.key}.view` : m.perm;
}

/**
 * User / role / permission management and system settings belong to the super_admin role only. These permissions are
 * never grantable through the role editor, and the API checks the role itself, not just the permission.
 */
export const SUPER_ADMIN_ROLE = 'super_admin';
export const RESERVED_PERMISSIONS: readonly string[] = ['users.manage', 'roles.manage', 'settings.manage', 'payroll_layout.manage', ...Object.values(PERIOD_ADMIN)];

export function isSuperAdmin(roles: readonly string[]): boolean {
  return roles.includes(SUPER_ADMIN_ROLE);
}

/** Whether a user may open a module — the single rule used by the menu, links and API guards. */
export function canOpenModule(m: ModuleDef, permissions: readonly string[], roles: readonly string[]): boolean {
  if (m.kind === 'page' && m.superAdminOnly) return isSuperAdmin(roles);
  return hasPermission(permissions, viewPermission(m));
}

/** Every grantable permission (for the role editor); reserved Super Admin permissions are excluded. */
export function permissionCatalogue(): string[] {
  const perms = new Set<string>();
  for (const m of CRUD_MODULES) {
    for (const a of ['view', 'create', 'update', 'delete', 'export']) perms.add(`${m.key}.${a}`);
    if (m.ownerField) perms.add(`${m.key}.all`);
    if (m.fields.some((f) => f.sensitive)) perms.add(`${m.key}.sensitive`);
  }
  for (const p of PAGE_MODULES) perms.add(p.perm);
  for (const extra of ['payroll.calculate', 'payroll.approve', 'payroll.publish', 'payroll.export', 'workflow.approve', 'workflow.approve_any', 'reports.export',
    'attendance_import.create', 'attendance_import.update', 'ot_review.update', 'attendance_file.import', 'shift_groups.manage', 'shift_schedule.manage', 'payroll_preview.export', 'org_chart.update', 'org_chart.import', 'org_chart.export', 'payslip_ytd.view',
    'holiday_calendar.create', 'holiday_calendar.update', 'holiday_calendar.delete', 'holiday_calendar.approve', 'holiday_calendar.import', 'holiday_calendar.export', 'attendance_exemption.view', 'attendance_exemption.manage']) perms.add(extra);
  for (const r of RESERVED_PERMISSIONS) perms.delete(r);
  return [...perms].sort();
}
