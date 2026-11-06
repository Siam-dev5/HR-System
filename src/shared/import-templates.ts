// Which import a worksheet belongs to. One import reads exactly one worksheet of one data domain: the attendance
// wizard accepts a time-clock export or a Feishu daily report, the leave and overtime wizards accept only their own
// Feishu approval export. Used in the browser (to stop a wrong worksheet early) and again in the Worker.
import { hasClockHeader } from './clock-import';
import { FEISHU_DAILY_TEMPLATE, findDailyHeaderRow } from './feishu-daily';
import { REQUEST_TEMPLATES, detectRequestSheet } from './feishu-requests';
import type { Cell } from './xlsx';

export type ImportType = 'attendance' | 'leave' | 'overtime';
export const CLOCK_TEMPLATE = 'CLOCK_FILE_V1';
export const IMPORT_TYPE_LABEL: Record<ImportType, string> = { attendance: 'บันทึกเวลาทำงาน', leave: 'ข้อมูลการลา', overtime: 'ข้อมูล OT' };
export const TEMPLATE_LABEL: Record<string, string> = {
  [CLOCK_TEMPLATE]: 'ไฟล์เวลาจากเครื่องสแกน / ระบบอื่น',
  [FEISHU_DAILY_TEMPLATE]: 'Feishu Daily Attendance (FEISHU_DAILY_ATTENDANCE_V1)',
  [REQUEST_TEMPLATES.leave]: 'Feishu Leave (FEISHU_LEAVE_V1)',
  [REQUEST_TEMPLATES.overtime]: 'Feishu Overtime (FEISHU_OVERTIME_V1)',
};
/** menu where a worksheet of each type is imported */
export const IMPORT_MENU: Record<ImportType, string> = {
  attendance: 'บันทึกเวลาทำงาน › นำเข้าไฟล์เวลาทำงาน',
  leave: 'การลา › นำเข้าข้อมูลการลา',
  overtime: 'คำขอ OT › นำเข้าข้อมูล OT',
};

export interface SheetKind {
  type: ImportType | null;
  template: string | null;
}

/** The import type and template a worksheet matches (null when it matches none). */
export function detectSheet(grid: readonly Cell[][]): SheetKind {
  if (findDailyHeaderRow(grid) >= 0) return { type: 'attendance', template: FEISHU_DAILY_TEMPLATE };
  const req = detectRequestSheet(grid);
  if (req.type) return { type: req.type, template: REQUEST_TEMPLATES[req.type] };
  if (req.headerRow < 0 && hasClockHeader(grid)) return { type: 'attendance', template: CLOCK_TEMPLATE };
  return { type: null, template: null };
}

/** Message for a worksheet of another data domain, or null when it may be imported here. */
export function wrongSheetMessage(expected: ImportType, kind: SheetKind, sheetName: string | null): string | null {
  if (!kind.type || kind.type === expected) return null;
  return `Worksheet${sheetName ? ` "${sheetName}"` : ''} เป็น${IMPORT_TYPE_LABEL[kind.type]} ไม่ใช่${IMPORT_TYPE_LABEL[expected]} กรุณาเลือก Worksheet ที่ถูกต้อง หรือนำเข้าที่เมนู ${IMPORT_MENU[kind.type]}`;
}
