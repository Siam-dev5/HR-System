// Payroll Preview columns: the single catalogue used by the preview table, the Super Admin layout editor,
// the layout API validation and the CSV / Excel export (so an export always matches what was previewed).

export type PreviewColumnType = 'text' | 'date' | 'money' | 'number';
export type PreviewGroup = 'employee' | 'attendance' | 'income' | 'deduction' | 'employer' | 'summary';

export interface PreviewColumn {
  key: string;
  label: string;
  group: PreviewGroup;
  type: PreviewColumnType;
  /** hidden in the standard layout (the preview table and the export); a Super Admin can still show it per company */
  defaultHidden?: boolean;
}

export const PREVIEW_GROUPS: Record<PreviewGroup, string> = {
  employee: 'ข้อมูลพนักงาน',
  attendance: 'เวลาทำงาน',
  income: 'เงินได้',
  deduction: 'เงินหัก',
  employer: 'นายจ้างสมทบ',
  summary: 'สรุป',
};

export const PREVIEW_COLUMNS: readonly PreviewColumn[] = [
  { key: 'emp_code', label: 'รหัสพนักงาน', group: 'employee', type: 'text' },
  { key: 'employee_name', label: 'ชื่อ-นามสกุล', group: 'employee', type: 'text' },
  { key: 'company', label: 'บริษัท', group: 'employee', type: 'text' },
  { key: 'department', label: 'หน่วยงาน', group: 'employee', type: 'text' },
  { key: 'position', label: 'ตำแหน่ง', group: 'employee', type: 'text' },
  { key: 'hire_date', label: 'วันเริ่มงาน', group: 'employee', type: 'date' },
  { key: 'probation_status', label: 'สถานะทดลองงาน', group: 'employee', type: 'text' },
  // hidden by default (HR decision 2026-11-17): next to "วันมีสิทธิ์เงินเดือน (ฐาน 30)" they read as the days paid and
  // confused the review. The figures stay in the rows (and in the attendance review); no amount reads them.
  { key: 'work_days', label: 'วันทำงาน', group: 'attendance', type: 'number', defaultHidden: true },
  { key: 'expected_work_days', label: 'วันทำงานที่กำหนด (Expected)', group: 'attendance', type: 'number', defaultHidden: true },
  { key: 'actual_work_hours', label: 'ชั่วโมงทำงานจริง', group: 'attendance', type: 'number' },
  { key: 'ot_hours', label: 'ชั่วโมง OT (ยืนยันแล้ว)', group: 'attendance', type: 'number' },
  { key: 'unpaid_leave_days', label: 'วันลาไม่รับค่าจ้าง', group: 'attendance', type: 'number' },
  { key: 'unpaid_leave_hours', label: 'ชั่วโมงลาไม่รับค่าจ้าง', group: 'attendance', type: 'number' },
  { key: 'absence_days', label: 'วันขาดงาน (HR ยืนยัน)', group: 'attendance', type: 'number' },
  { key: 'entitlement_days', label: 'วันมีสิทธิ์เงินเดือน (ฐาน 30)', group: 'attendance', type: 'number' },
  { key: 'payable_days', label: 'วันจ่ายจริง (หลังหักลา/ขาด)', group: 'attendance', type: 'number' },
  { key: 'attendance_review', label: 'สถานะตรวจสอบเวลาทำงาน', group: 'attendance', type: 'text' },
  { key: 'base_salary', label: 'เงินเดือน (ตามวันมีสิทธิ์)', group: 'income', type: 'money' },
  { key: 'unpaid_leave_amount', label: 'หักลาไม่รับค่าจ้าง', group: 'income', type: 'money' },
  { key: 'absence_amount', label: 'หักขาดงาน', group: 'income', type: 'money' },
  { key: 'ot_pay', label: 'ค่าล่วงเวลา (OT)', group: 'income', type: 'money' },
  { key: 'holiday_pay', label: 'ค่าทำงาน / OT ในวันหยุด', group: 'income', type: 'money' },
  { key: 'allowance', label: 'ค่าตอบแทน / Allowance', group: 'income', type: 'money' },
  { key: 'commission', label: 'Commission', group: 'income', type: 'money' },
  { key: 'bonus', label: 'Bonus', group: 'income', type: 'money' },
  { key: 'other_income', label: 'เงินได้อื่น', group: 'income', type: 'money' },
  { key: 'total_income', label: 'รวมเงินได้', group: 'income', type: 'money' },
  { key: 'sso', label: 'ประกันสังคม', group: 'deduction', type: 'money' },
  { key: 'tax', label: 'ภาษีหัก ณ ที่จ่าย', group: 'deduction', type: 'money' },
  { key: 'ewf_employee', label: 'กองทุนสงเคราะห์ลูกจ้าง (พนักงาน)', group: 'deduction', type: 'money' },
  { key: 'provident_fund', label: 'กองทุนสำรองเลี้ยงชีพ', group: 'deduction', type: 'money' },
  { key: 'mid_month_advance', label: 'หักเงินจ่ายกลางเดือน (Advance)', group: 'deduction', type: 'money' },
  { key: 'other_deduction', label: 'เงินหักอื่น', group: 'deduction', type: 'money' },
  { key: 'total_deduction', label: 'รวมเงินหัก', group: 'deduction', type: 'money' },
  { key: 'ewf_employer', label: 'กองทุนสงเคราะห์ลูกจ้าง (นายจ้างสมทบ)', group: 'employer', type: 'money' },
  { key: 'net_pay', label: 'เงินได้สุทธิ', group: 'summary', type: 'money' },
];

export const PREVIEW_KEYS = PREVIEW_COLUMNS.map((c) => c.key);

export interface LayoutColumn {
  key: string;
  visible: boolean;
}

export const DEFAULT_LAYOUT: readonly LayoutColumn[] = PREVIEW_COLUMNS.map((c) => ({ key: c.key, visible: !c.defaultHidden }));

const defaultVisible = (key: string): boolean => !PREVIEW_COLUMNS.find((c) => c.key === key)?.defaultHidden;

/**
 * Validates a submitted layout: every known column exactly once (missing ones are appended with their standard
 * visibility), unknown keys
 * rejected, at least one visible column. Returns null when the payload is invalid.
 */
export function normalizeLayout(input: unknown): LayoutColumn[] | null {
  if (!Array.isArray(input) || input.length > PREVIEW_COLUMNS.length) return null;
  const seen = new Set<string>();
  const out: LayoutColumn[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') return null;
    const { key, visible } = item as Record<string, unknown>;
    if (typeof key !== 'string' || !PREVIEW_KEYS.includes(key) || seen.has(key) || typeof visible !== 'boolean') return null;
    seen.add(key);
    out.push({ key, visible });
  }
  for (const k of PREVIEW_KEYS) if (!seen.has(k)) out.push({ key: k, visible: defaultVisible(k) });
  return out.some((c) => c.visible) ? out : null;
}

export const PROBATION_LABEL: Record<string, string> = {
  probation: 'ทดลองงาน',
  passed: 'ผ่านทดลองงาน',
  passed_in_period: 'ผ่านทดลองงานระหว่างงวด',
};
