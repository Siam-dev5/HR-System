// Attendance file import wizard (upload → column mapping → preview & validation → confirm → result) and the import
// history. The file is parsed in the browser (XLSX, XLS, CSV); the Worker validates every row again on confirmation.
import type { CompanyOption } from '../../shared/types';
import { CLOCK_STATUS_LABEL, MAX_CLOCK_FILE_BYTES, findClockHeaderRow, sniffFileType, type ClockFileType, type ClockIssue, type ClockRowStatus } from '../../shared/clock-import';
import { formatDuration } from '../../shared/shifts';
import { FEISHU_DAILY_TEMPLATE, PUNCH_LABEL, findDailyHeaderRow, type PunchResult } from '../../shared/feishu-daily';
import { detectRequestSheet } from '../../shared/feishu-requests';
import { columnValues, suggestCompany, type CompanyMode } from '../../shared/company-rules';
import { CLOCK_TEMPLATE, IMPORT_TYPE_LABEL, TEMPLATE_LABEL, detectSheet, wrongSheetMessage, type ImportType } from '../../shared/import-templates';
import { parseCsv, readXlsx, type Cell, type Sheet } from '../../shared/xlsx';
import { readXls } from '../../shared/xls';
import { get, post, qs } from '../api';
import { h, mount, loading, errorBox, fmtDate, fmtNum, toast, confirmDialog } from '../dom';
import { basePath, can, link, state } from '../app';
import { companies, noCompanies } from './attendance';

interface PunchView {
  label: string;
  result: PunchResult;
  time: string | null;
}
interface DayEventView {
  kind: string;
  label: string;
  amount: number | null;
  unit: string | null;
  ranges: string[] | string | null;
  all_day: boolean | number;
  overnight: boolean | number;
}
interface PreviewRow {
  row_no: number;
  /** Feishu daily report: sheet cell, punch results, the day's events */
  source_ref?: string;
  in_result?: PunchView | null;
  out_result?: PunchView | null;
  day_kind?: 'work' | 'rest';
  events?: DayEventView[];
  /** company of the row (combined files; null = not identified) */
  company_id?: number | null;
  company_value?: string | null;
  exempt?: boolean;
  employee_code: string | null;
  employee_name: string | null;
  work_date: string | null;
  clock_in: string | null;
  clock_out: string | null;
  out_next_day: boolean;
  device: string | null;
  status: ClockRowStatus;
  issues: ClockIssue[];
  attendance_status: 'present' | 'late' | null;
  shift_label: string | null;
  late_minutes: number | null;
  early_leave_minutes: number | null;
  worked_minutes: number | null;
}
interface PreviewResponse {
  template: string;
  sheet_name: string | null;
  company_mode: CompanyMode;
  company: CompanyOption | null;
  companies?: Array<{ id: number; code: string; name: string; total: number; valid: number; warning: number; duplicate: number; invalid: number; importable: number }>;
  header_row: number;
  headers: string[];
  mapping: Record<string, number | null | undefined>;
  remembered: boolean;
  mapping_problems: string[];
  fields: Array<{ key: string; label: string; required: boolean }>;
  previous: Array<{ id: number; created_at: string; file_name: string }>;
  day_columns?: Array<{ col: number; date: string }>;
  summary: { total: number; valid: number; warning: number; duplicate: number; invalid: number; importable: number; source_rows?: number; empty_days?: number; with_clock?: number; events?: number; unassigned?: number; exempt_days?: number };
  rows: PreviewRow[];
}
interface Batch {
  id: number;
  company_id: number;
  company: string;
  file_name: string;
  file_type: string;
  total_rows: number;
  imported_count: number;
  duplicate_count: number;
  warning_count: number;
  invalid_count: number;
  status: 'completed' | 'partial' | 'failed';
  created_at: string;
  created_by_name: string | null;
  template_code?: string;
  sheet_name?: string | null;
  source_rows?: number | null;
  record_count?: number;
  group_id?: number | null;
  repeated?: boolean;
}

const STEPS = ['อัปโหลดไฟล์', 'จับคู่คอลัมน์', 'ตรวจสอบข้อมูล', 'ยืนยันการนำเข้า', 'ผลการนำเข้า'];
export const BATCH_STATUS: Record<Batch['status'], string> = { completed: 'สำเร็จทั้งหมด', partial: 'สำเร็จบางส่วน', failed: 'ไม่มีรายการที่นำเข้า' };
export const STATUS_CLASS: Record<ClockRowStatus, string> = { valid: 's-ok', warning: 's-partial', duplicate: 's-superseded', invalid: 's-error' };
export const fmtSize = (n: number) => (n < 1024 * 1024 ? `${fmtNum(Math.round(n / 102.4) / 10)} KB` : `${fmtNum(Math.round(n / 104857.6) / 10)} MB`);

async function sha256(buf: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function decodeText(buf: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-874').decode(buf); // Thai Excel text saved as TIS-620
  }
}

/** Text exports: comma, semicolon or tab separated (time clocks often save tab-separated text as ".xls"). */
function parseText(text: string): Cell[][] {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const tabs = (first.match(/\t/g) ?? []).length;
  const semis = (first.match(/;/g) ?? []).length;
  const commas = (first.match(/,/g) ?? []).length;
  if (tabs > commas && tabs >= semis) return text.split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => l.split('\t').map((c) => (c.trim() === '' ? null : c.trim())));
  if (semis > commas) return parseCsv(text.replace(/;/g, ','));
  return parseCsv(text);
}

/** Some systems save an HTML table with an ".xls" name. */
function parseHtmlTable(text: string): Cell[][] {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const table = doc.querySelector('table');
  if (!table) throw new Error('ไม่พบตารางข้อมูลในไฟล์');
  return [...table.querySelectorAll('tr')].map((tr) => [...tr.querySelectorAll('th,td')].map((td) => (td.textContent ?? '').trim() || null));
}

export interface LoadedFile {
  name: string;
  size: number;
  type: ClockFileType;
  sha: string;
  sheets: Sheet[];
}

/** Reads an uploaded file after checking its extension, size and actual content type. */
export async function loadClockFile(file: File): Promise<LoadedFile> {
  const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
  if (ext !== 'xlsx' && ext !== 'xls' && ext !== 'csv') throw new Error('รองรับเฉพาะไฟล์ .xlsx .xls และ .csv');
  if (file.size === 0) throw new Error('ไฟล์ว่างเปล่า');
  if (file.size > MAX_CLOCK_FILE_BYTES) throw new Error('ไฟล์ใหญ่เกิน 15 MB');
  const buf = await file.arrayBuffer();
  const kind = sniffFileType(new Uint8Array(buf));
  let sheets: Sheet[];
  if (ext === 'xlsx') {
    if (kind !== 'xlsx') throw new Error('เนื้อหาไฟล์ไม่ใช่ Excel .xlsx (นามสกุลไฟล์ไม่ตรงกับข้อมูล)');
    sheets = await readXlsx(buf);
  } else if (ext === 'xls') {
    if (kind === 'xls') sheets = await readXls(buf);
    else if (kind === 'text') {
      const text = decodeText(buf);
      sheets = [{ name: file.name, rows: /<table[\s>]/i.test(text) ? parseHtmlTable(text) : parseText(text) }];
    } else throw new Error('เนื้อหาไฟล์ไม่ใช่ Excel .xls');
  } else {
    if (kind !== 'text') throw new Error('เนื้อหาไฟล์ไม่ใช่ข้อความ CSV');
    sheets = [{ name: file.name, rows: parseText(decodeText(buf)) }];
  }
  sheets = sheets.filter((s) => s.rows.some((r) => r.some((c) => c !== null && c !== '')));
  if (!sheets.length) throw new Error('ไม่พบข้อมูลในไฟล์');
  return { name: file.name, size: file.size, type: ext, sha: await sha256(buf), sheets };
}

/** Data rows of a worksheet: rows with content below its header (the header row depends on the format). */
export function dataRows(rows: Cell[][]): number {
  const daily = findDailyHeaderRow(rows);
  const req = detectRequestSheet(rows).headerRow;
  const hr = daily >= 0 ? daily : req >= 0 ? req : findClockHeaderRow(rows);
  return rows.slice(hr + 1).filter((r) => r.some((c) => c !== null && String(c).trim() !== '')).length;
}

/** The first worksheet of the expected data domain (or the first worksheet). */
export function defaultSheet(file: LoadedFile, expected: ImportType): number {
  const i = file.sheets.findIndex((s) => detectSheet(s.rows).type === expected);
  return i >= 0 ? i : 0;
}

/**
 * One worksheet per import: every worksheet of the file with its detected format; a worksheet of another data
 * domain is marked and cannot be imported here. Only the selected worksheet is ever sent to the server.
 */
export function sheetPicker(file: LoadedFile, selected: number, expected: ImportType, onPick: (i: number) => void): HTMLElement {
  return h('fieldset', { class: 'plain sheet-picker' },
    h('legend', null, `เลือก Worksheet ที่จะนำเข้า (ไฟล์นี้มี ${file.sheets.length} Worksheet · นำเข้าได้ครั้งละ 1 Worksheet)`),
    h('div', { class: 'sheet-options', role: 'radiogroup', 'aria-label': 'Worksheet' }, file.sheets.map((s, i) => {
      const kind = detectSheet(s.rows);
      const wrong = wrongSheetMessage(expected, kind, null);
      return h('label', { class: `sheet-option${i === selected ? ' is-selected' : ''}${wrong ? ' is-wrong' : ''}`, 'data-sheet': s.name },
        h('input', { type: 'radio', name: 'import-sheet', value: String(i), checked: i === selected, onchange: () => onPick(i) }),
        h('span', { class: 'sheet-name' }, s.name),
        h('span', { class: 'muted small' }, `${fmtNum(dataRows(s.rows))} แถว · ${kind.template ? TEMPLATE_LABEL[kind.template] : 'ไม่รู้จักรูปแบบ (จับคู่คอลัมน์เอง)'}`),
        wrong ? h('span', { class: 'issue-warning small' }, `เป็น${IMPORT_TYPE_LABEL[kind.type!]} — นำเข้าในเมนูนี้ไม่ได้`) : null);
    })));
}

export function stepper(current: number, steps: readonly string[] = STEPS): HTMLElement {
  return h('ol', { class: 'stepper', 'aria-label': 'ขั้นตอนการนำเข้า' },
    steps.map((t, i) => h('li', { class: i < current ? 'done' : i === current ? 'current' : '', 'aria-current': i === current ? 'step' : undefined }, h('span', { class: 'step-no' }, String(i + 1)), h('span', { class: 'step-label' }, t))));
}

export function issueList(issues: ReadonlyArray<{ level: string; message: string }>): HTMLElement | string {
  if (!issues.length) return '';
  return h('ul', { class: 'issues' }, issues.map((i) => h('li', { class: i.level === 'error' ? 'issue-error' : i.level === 'warning' ? 'issue-warning' : 'muted' }, i.message)));
}

export function kpi(label: string, value: number, cls = ''): HTMLElement {
  return h('div', { class: `kpi ${cls}` }, h('div', { class: 'kpi-label' }, label), h('div', { class: 'kpi-value' }, fmtNum(value)));
}

/** The worksheet and template of the import, shown on every step. */
export function sheetBadge(sheetName: string | null | undefined, template: string | null | undefined): HTMLElement {
  return h('div', { class: 'sheet-badge', role: 'note' },
    h('span', null, 'Worksheet: '), h('strong', { class: 'sheet-badge-name' }, sheetName || '-'),
    template ? h('span', { class: 'muted' }, ` · ${TEMPLATE_LABEL[template] ?? template}`) : null);
}

const punchText = (p: PunchView | null | undefined) => (p ? `${PUNCH_LABEL[p.result] ?? p.label}${p.time ? ` ${p.time}` : ''}` : '-');
const eventText = (e: DayEventView) => {
  const ranges = Array.isArray(e.ranges) ? e.ranges.join(', ') : (e.ranges ?? '');
  const amount = e.amount !== null ? ` ${fmtNum(e.amount)} ${e.unit === 'day' ? 'วัน' : e.unit === 'minute' ? 'นาที' : 'ชม.'}` : '';
  const kind = e.kind === 'overtime' ? 'OT' : e.kind === 'out_of_office' ? 'นอกสถานที่' : e.kind === 'break_punch' ? 'สแกนพัก' : e.label;
  return `${kind}${e.kind === 'leave' ? amount : ''}${e.all_day ? ' ทั้งวัน' : ''}${ranges ? ` (${ranges})` : ''}${e.overnight ? ' ข้ามวัน' : ''}`;
};
const eventList = (events: readonly DayEventView[] | undefined) =>
  events?.length ? h('ul', { class: 'issues day-events' }, events.map((e) => h('li', { 'data-kind': e.kind }, eventText(e)))) : '';

export function reportLinks(id: number, api = '/api/attendance-files'): HTMLElement {
  return h('span', { class: 'actions' },
    h('a', { class: 'btn small', href: `${basePath()}${api}/${id}/report${qs({ format: 'csv' })}`, download: '' }, 'Error Report (CSV)'),
    h('a', { class: 'btn small', href: `${basePath()}${api}/${id}/report${qs({ format: 'xlsx' })}`, download: '' }, 'Error Report (Excel)'));
}

/** Rows of a combined import that went to each company, and the rows without a company. */
interface Group {
  id: number;
  company_mode: 'combined';
  file_name: string;
  sheet_name: string | null;
  total_rows: number;
  company_count: number;
  unassigned_count: number;
  created_at: string;
  created_by_name: string | null;
  company_rule: { column: number | null; values: Record<string, number | null> } | null;
  batches: Batch[];
  unassigned_rows: Array<{ row_no: number; source_ref: string | null; employee_code: string | null; work_date: string | null; company_value: string | null; issues: Array<{ level: string; message: string }> }> | null;
  unassigned_visible?: boolean;
  repeated?: boolean;
}
const isGroup = (x: Batch | Group): x is Group => (x as Group).company_mode === 'combined';
const ATTENDANCE_STEPS = ['อัปโหลดไฟล์', 'Worksheet / บริษัท', 'จับคู่คอลัมน์', 'ตรวจสอบข้อมูล', 'ยืนยันการนำเข้า', 'ผลการนำเข้า'];
/** headers that name a company column, used only to preselect it (HR confirms every value) */
const COMPANY_HEADER = /^(company|company name|company code|legal entity|entity|บริษัท|ชื่อบริษัท|รหัสบริษัท|公司|所属公司)$/i;

function groupBatchesTable(batches: readonly Batch[]): HTMLElement {
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table compact group-batches' },
    h('thead', null, h('tr', null, ['บริษัท', 'Import ID', 'ทั้งหมด', 'สำเร็จ', 'ซ้ำ', 'ผิดพลาด', 'สร้างบันทึกเวลา', 'สถานะ', 'Report'].map((t) => h('th', null, t)))),
    h('tbody', null, batches.map((b) => h('tr', { 'data-company': String(b.company_id) },
      h('td', null, b.company), h('td', null, link(`/attendance/file-imports?id=${b.id}`, `#${b.id}`)), h('td', null, fmtNum(b.total_rows)), h('td', null, fmtNum(b.imported_count)),
      h('td', null, fmtNum(b.duplicate_count)), h('td', null, fmtNum(b.invalid_count)), h('td', null, fmtNum(b.record_count ?? 0)),
      h('td', null, h('span', { class: `badge-status s-${b.status === 'failed' ? 'error' : b.status}` }, BATCH_STATUS[b.status])), h('td', null, reportLinks(b.id)))))));
}

export async function renderAttendanceFileImport(main: HTMLElement): Promise<void> {
  const list = companies();
  if (!list.length) return mount(main, noCompanies());
  const page = h('div', { class: 'stack clock-import' });
  mount(main, page);
  let step = 0;
  let file: LoadedFile | null = null;
  let sheetIdx = 0;
  let companyId = state.companyId ?? list[0]!.id;
  let mode: CompanyMode = 'single';
  let ruleColumn: number | null = null;
  let ruleValues: Record<string, number | null> = {};
  let source = '';
  let headerRow: number | null = null;
  let mapping: Record<string, number | null | undefined> | null = null;
  let preview: PreviewResponse | null = null;
  let result: Batch | Group | null = null;
  let filter: ClockRowStatus | 'all' = 'all';
  let companyFilter = 'all';
  let pageNo = 0;
  const key = crypto.randomUUID();
  const stepper6 = (i: number) => stepper(i, ATTENDANCE_STEPS);

  const grid = () => file?.sheets[sheetIdx]?.rows ?? [];
  const sheetName = () => file?.sheets[sheetIdx]?.name ?? null;
  const kind = () => detectSheet(grid());
  const template = () => kind().template ?? CLOCK_TEMPLATE;
  const isDaily = () => template() === FEISHU_DAILY_TEMPLATE;
  const dailyHeader = () => findDailyHeaderRow(grid());
  const rule = () => (isDaily() && ruleColumn !== null ? { column: ruleColumn, values: Object.entries(ruleValues).map(([value, company_id]) => ({ value, company_id })) } : null);
  // only the selected worksheet is sent; the company of each row comes from the chosen company or the explicit rule
  const request = (withMapping: boolean) => ({
    company_mode: isDaily() ? mode : 'single', company_id: mode === 'single' || !isDaily() ? companyId : null, company_rule: rule(),
    file_name: file!.name, file_type: file!.type, file_size: file!.size, sha256: file!.sha, sheet_name: sheetName(), template: template(),
    source: source || null, grid: grid(), header_row: headerRow, mapping: withMapping ? mapping : null,
  });
  const runPreview = async (withMapping: boolean, next: number) => {
    mount(page, stepper6(step), h('div', null, loading()));
    try {
      preview = await post<PreviewResponse>('/api/attendance-files/preview', request(withMapping));
      headerRow = preview.header_row;
      mapping = preview.mapping;
      step = preview.mapping_problems.length && next > 2 ? 2 : next;
      render();
    } catch (e) {
      mount(page, stepper6(step), errorBox(e), h('div', { class: 'form-actions' }, h('button', { class: 'btn', onclick: () => render() }, 'ย้อนกลับ')));
    }
  };
  const render = () => {
    const views = [uploadStep, companyStep, mappingStep, previewStep, confirmStep, resultStep];
    mount(page, stepper6(step), views[step]!());
    page.querySelector<HTMLElement>('.wizard-step h2')?.focus();
  };
  const companyLabel = (id: number | null) => (id === null ? 'ไม่ระบุบริษัท' : (() => { const c = list.find((x) => x.id === id); return c ? `${c.name} (${c.code})` : `#${id}`; })());

  function uploadStep(): HTMLElement {
    const input = h('input', { type: 'file', accept: '.xlsx,.xls,.csv', 'aria-label': 'เลือกไฟล์เวลาทำงาน', class: 'visually-hidden', id: 'clock-file' });
    const info = h('div', { class: 'file-info', 'aria-live': 'polite' });
    const nextBtn = h('button', { class: 'btn primary', disabled: !file, onclick: () => { step = 1; render(); } }, 'ถัดไป: Worksheet / บริษัท');
    const showInfo = () => {
      if (!file) return mount(info, h('span', { class: 'muted' }, 'ยังไม่ได้เลือกไฟล์'));
      const wrong = wrongSheetMessage('attendance', kind(), sheetName());
      nextBtn.disabled = !!wrong;
      const picker = file.sheets.length > 1
        ? sheetPicker(file, sheetIdx, 'attendance', (i) => { sheetIdx = i; headerRow = null; mapping = null; ruleColumn = null; ruleValues = {}; showInfo(); })
        : null;
      mount(info, h('dl', { class: 'dl' },
        h('dt', null, 'ชื่อไฟล์'), h('dd', { class: 'file-name' }, file.name),
        h('dt', null, 'ขนาด'), h('dd', null, fmtSize(file.size)),
        h('dt', null, 'ชนิดไฟล์'), h('dd', null, file.type.toUpperCase()),
        h('dt', null, 'Worksheet ที่เลือก'), h('dd', { class: 'file-sheet' }, sheetName() ?? '-'),
        h('dt', null, 'รูปแบบไฟล์ (Template)'), h('dd', { class: 'file-template' }, TEMPLATE_LABEL[template()] ?? template()),
        h('dt', null, 'จำนวนแถวข้อมูล'), h('dd', { class: 'file-rows' }, fmtNum(dataRows(grid())))),
        picker, wrong ? h('div', { class: 'alert alert-error', role: 'alert' }, wrong) : null);
    };
    const pick = async (f: File | undefined) => {
      if (!f) return;
      mount(info, loading());
      try {
        file = await loadClockFile(f);
        sheetIdx = defaultSheet(file, 'attendance');
        headerRow = null;
        mapping = null;
        preview = null;
        ruleColumn = null;
        ruleValues = {};
        showInfo();
      } catch (e) {
        file = null;
        nextBtn.disabled = true;
        mount(info, errorBox(e));
      }
    };
    input.addEventListener('change', () => void pick(input.files?.[0]));
    const drop = h('label', { class: 'dropzone', for: 'clock-file', tabindex: '0', onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } } },
      h('strong', null, 'ลากไฟล์มาวางที่นี่ หรือคลิกเพื่อเลือกไฟล์'), h('span', { class: 'muted small' }, 'รองรับ .xlsx .xls .csv ขนาดไม่เกิน 15 MB ไม่เกิน 10,000 แถว'));
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('drag'); void pick(e.dataTransfer?.files?.[0]); });
    const src = h('input', { type: 'text', maxlength: 100, value: source, placeholder: 'เช่น เครื่องสแกนสำนักงานใหญ่', oninput: (e: Event) => { source = (e.target as HTMLInputElement).value; } });
    showInfo();
    return h('section', { class: 'card wizard-step' },
      h('h2', { tabindex: '-1' }, '1. อัปโหลดไฟล์'),
      h('div', { class: 'grid-form' }, h('label', { class: 'field' }, h('span', null, 'แหล่งข้อมูล (ไม่บังคับ)'), src)),
      input, drop, info,
      h('div', { class: 'form-actions' }, link('/attendance/file-imports', 'ประวัติการนำเข้า', { class: 'btn' }), nextBtn));
  }

  /** Step 2: the worksheet and where the company of each row comes from (chosen company, or an explicit rule). */
  function companyStep(): HTMLElement {
    const body = h('div', { class: 'company-step' });
    const nextBtn = h('button', { class: 'btn primary', onclick: () => void runPreview(false, 2) }, 'ถัดไป: จับคู่คอลัมน์');
    const hr = dailyHeader();
    const header = isDaily() && hr >= 0 ? (grid()[hr] ?? []).map((c) => String(c ?? '').trim()) : [];
    const columns = header.map((label, i) => ({ label, i })).filter((x) => x.label && !/^\d{4}-\d{2}-\d{2}\b/.test(x.label));
    if (isDaily() && ruleColumn === null && Object.keys(ruleValues).length === 0) {
      const auto = columns.find((x) => COMPANY_HEADER.test(x.label));
      if (auto) ruleColumn = auto.i;
    }
    const draw = () => {
      const values = ruleColumn !== null && hr >= 0 ? columnValues(grid(), hr, ruleColumn) : [];
      for (const v of values) if (!(v.key in ruleValues)) ruleValues[v.key] = v.key ? suggestCompany(v.value, list).id : null;
      const counts = new Map<number | null, number>();
      for (const v of values) {
        // single: an empty value keeps the chosen company; another or an unmatched company is a conflict (-1)
        const id = mode === 'single' ? (!v.key || ruleValues[v.key] === companyId ? companyId : -1) : (v.key ? ruleValues[v.key] ?? null : null);
        counts.set(id, (counts.get(id) ?? 0) + v.rows);
      }
      const rowsTotal = dataRows(grid());
      const detected = mode === 'combined'
        ? [...counts].sort((a, b) => (a[0] === null ? 1 : b[0] === null ? -1 : 0))
        : [[companyId, rowsTotal] as [number, number]];
      const companySelect = h('select', { 'aria-label': 'บริษัท', onchange: (e: Event) => { companyId = Number((e.target as HTMLSelectElement).value); draw(); } },
        list.map((c) => h('option', { value: String(c.id), selected: c.id === companyId }, `${c.name} (${c.code})`)));
      const columnSelect = h('select', { 'aria-label': 'คอลัมน์ที่ใช้ระบุบริษัท', onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; ruleColumn = v === '' ? null : Number(v); ruleValues = {}; draw(); } },
        h('option', { value: '' }, mode === 'combined' ? '— เลือกคอลัมน์ —' : '— ไม่มี (ใช้บริษัทที่เลือก) —'),
        columns.map((x) => h('option', { value: String(x.i), selected: x.i === ruleColumn }, x.label)));
      const valueTable = values.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'table compact company-values' },
            h('thead', null, h('tr', null, ['ค่าในไฟล์', 'จำนวนแถว', 'บริษัท'].map((t) => h('th', null, t)))),
            h('tbody', null, values.map((v) => h('tr', { 'data-value': v.value, class: (ruleValues[v.key] ?? null) === null ? 'is-unassigned' : '' },
              h('td', null, v.value || h('span', { class: 'muted' }, '(ว่าง)')), h('td', null, fmtNum(v.rows)),
              h('td', null, v.key
                ? h('select', { 'aria-label': `บริษัทของ ${v.value}`, onchange: (e: Event) => { const x = (e.target as HTMLSelectElement).value; ruleValues[v.key] = x === '' ? null : Number(x); draw(); } },
                    h('option', { value: '' }, '— ไม่ระบุ (ไม่นำเข้า) —'), list.map((c) => h('option', { value: String(c.id), selected: ruleValues[v.key] === c.id }, `${c.name} (${c.code})`)))
                : h('span', { class: 'issue-error' }, 'ไม่มีข้อมูลบริษัท (ไม่นำเข้า)')))))))
        : null;
      const unassigned = mode === 'combined' ? (counts.get(null) ?? 0) : (counts.get(-1) ?? 0);
      nextBtn.disabled = mode === 'combined' && ruleColumn === null;
      mount(body,
        isDaily()
          ? h('fieldset', { class: 'plain company-mode' }, h('legend', null, 'ไฟล์นี้เป็นของ'),
              h('label', { class: 'check' }, h('input', { type: 'radio', name: 'company-mode', value: 'single', checked: mode === 'single', onchange: () => { mode = 'single'; draw(); } }), ' บริษัทเดียว (แยกไฟล์ตามบริษัท)'),
              h('label', { class: 'check' }, h('input', { type: 'radio', name: 'company-mode', value: 'combined', checked: mode === 'combined', onchange: () => { mode = 'combined'; draw(); } }), ' หลายบริษัทในไฟล์เดียว (ระบุบริษัทจากคอลัมน์)'))
          : null,
        h('div', { class: 'grid-form' },
          mode === 'single' || !isDaily() ? h('label', { class: 'field' }, h('span', null, 'บริษัท *'), companySelect) : null,
          isDaily() ? h('label', { class: 'field' }, h('span', null, mode === 'combined' ? 'คอลัมน์ที่ใช้ระบุบริษัท *' : 'คอลัมน์บริษัทในไฟล์ (ไม่บังคับ ใช้ตรวจความขัดแย้ง)'), columnSelect) : null),
        mode === 'combined'
          ? h('p', { class: 'muted small' }, 'ระบบไม่เดาบริษัทจากรหัสพนักงาน: จับคู่ค่าของคอลัมน์ที่เลือกกับบริษัทให้ครบ ค่าที่ไม่จับคู่จะไม่ถูกนำเข้า (แนะนำค่าให้อัตโนมัติเฉพาะค่าที่ตรงกับรหัสหรือชื่อบริษัทเท่านั้น)')
          : ruleColumn !== null ? h('p', { class: 'muted small' }, 'แถวที่ค่าในคอลัมน์นี้เป็นบริษัทอื่น หรือยังไม่ได้จับคู่ จะถูกปฏิเสธ (ไม่จับคู่พนักงานข้ามบริษัท)') : null,
        valueTable,
        h('h3', null, 'บริษัทที่พบในไฟล์'),
        h('ul', { class: 'detected-companies' }, detected.map(([id, n]) => h('li', { 'data-company': id === null ? 'none' : String(id), class: id === null ? 'issue-error' : '' }, `${companyLabel(id)}: ${fmtNum(n)} แถวพนักงาน`)),
          mode === 'single' && unassigned ? h('li', { class: 'issue-error', 'data-company': 'conflict' }, `ค่าบริษัทที่ไม่ตรง / ไม่ได้จับคู่: ${fmtNum(unassigned)} แถว (จะไม่ถูกนำเข้า)`) : null),
        mode === 'combined' && unassigned ? h('div', { class: 'alert alert-error', role: 'alert' }, `${fmtNum(unassigned)} แถวพนักงานไม่มีบริษัท — จะไม่ถูกนำเข้า และเก็บเป็นข้อมูลต้นฉบับแยกไว้`) : null);
    };
    draw();
    return h('section', { class: 'card wizard-step' },
      h('h2', { tabindex: '-1' }, '2. Worksheet / บริษัท'),
      sheetBadge(sheetName(), template()),
      body,
      h('div', { class: 'form-actions' }, h('button', { class: 'btn', onclick: () => { step = 0; render(); } }, 'ย้อนกลับ'), nextBtn));
  }

  function mappingStep(): HTMLElement {
    const p = preview!;
    const selects = new Map<string, HTMLSelectElement>();
    const opts = (sel: number | null | undefined) => [h('option', { value: '' }, '— ไม่ใช้ —'), p.headers.map((hd, i) => h('option', { value: String(i), selected: sel === i }, hd || `คอลัมน์ ${i + 1}`))];
    const rows = p.fields.map((f) => {
      const s = h('select', { 'aria-label': f.label, 'data-field': f.key }, opts(p.mapping[f.key]));
      selects.set(f.key, s);
      return h('tr', null, h('td', null, f.label, f.required ? h('span', { class: 'req' }, ' *') : ''), h('td', null, s));
    });
    const hrInput = h('input', { type: 'number', min: 1, max: 50, value: String(p.header_row + 1), 'aria-label': 'แถวหัวตาราง', style: 'max-width:6rem' });
    const read = (): Record<string, number | null> => Object.fromEntries([...selects].map(([k, s]) => [k, s.value === '' ? null : Number(s.value)]));
    const sample = grid().slice(p.header_row + 1, p.header_row + 6);
    const days = p.day_columns ?? [];
    return h('section', { class: 'card wizard-step' },
      h('h2', { tabindex: '-1' }, '3. จับคู่คอลัมน์'),
      sheetBadge(p.sheet_name, p.template),
      p.remembered ? h('div', { class: 'alert', role: 'status' }, 'ใช้การจับคู่คอลัมน์ที่เคยใช้กับไฟล์รูปแบบเดียวกัน') : null,
      p.template === FEISHU_DAILY_TEMPLATE
        ? h('div', { class: 'alert', role: 'status', 'data-day-columns': String(days.length) },
            days.length ? `พบคอลัมน์วันที่ ${days.length} วัน (${fmtDate(days[0]!.date)} – ${fmtDate(days[days.length - 1]!.date)}) แต่ละช่องจะแปลงเป็น 1 รายการต่อพนักงานต่อวัน` : 'ไม่พบคอลัมน์วันที่')
        : null,
      p.mapping_problems.length ? h('div', { class: 'alert alert-error', role: 'alert' }, h('ul', { class: 'issues' }, p.mapping_problems.map((m) => h('li', null, m)))) : null,
      h('label', { class: 'field inline-form' }, h('span', null, 'หัวตารางอยู่แถวที่'), hrInput,
        h('button', { class: 'btn small', onclick: () => { headerRow = Math.max(0, Number(hrInput.value) - 1); void runPreview(false, 2); } }, 'อ่านหัวตารางใหม่')),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table compact mapping-table' }, h('thead', null, h('tr', null, h('th', null, 'ข้อมูลในระบบ'), h('th', null, 'คอลัมน์ในไฟล์'))), h('tbody', null, rows))),
      h('h3', null, 'ตัวอย่างข้อมูล 5 แถวแรก'),
      h('div', { class: 'table-wrap table-scroll' }, h('table', { class: 'table compact preview-table' },
        h('thead', null, h('tr', null, p.headers.map((hd, i) => h('th', null, hd || `คอลัมน์ ${i + 1}`)))),
        h('tbody', null, sample.map((r) => h('tr', null, p.headers.map((_, i) => h('td', null, r[i] === null || r[i] === undefined ? '' : String(r[i])))))))),
      h('div', { class: 'form-actions' },
        h('button', { class: 'btn', onclick: () => { step = 1; render(); } }, 'ย้อนกลับ'),
        h('button', { class: 'btn primary', onclick: () => { mapping = read(); void runPreview(true, 3); } }, 'ถัดไป: ตรวจสอบข้อมูล')));
  }

  function companySummary(p: PreviewResponse): HTMLElement | null {
    const cs = p.companies ?? [];
    if (p.company_mode !== 'combined' && cs.length <= 1) return null;
    return h('div', { class: 'table-wrap' }, h('table', { class: 'table compact company-summary' },
      h('thead', null, h('tr', null, ['บริษัท', 'ทั้งหมด', 'Valid', 'Warning', 'Duplicate', 'Invalid', 'จะนำเข้า'].map((t) => h('th', null, t)))),
      h('tbody', null, cs.map((c) => h('tr', { 'data-company': String(c.id) }, h('td', null, `${c.name} (${c.code})`), h('td', null, fmtNum(c.total)), h('td', null, fmtNum(c.valid)), h('td', null, fmtNum(c.warning)),
        h('td', null, fmtNum(c.duplicate)), h('td', null, fmtNum(c.invalid)), h('td', null, fmtNum(c.importable)))),
        p.summary.unassigned ? h('tr', { 'data-company': 'none', class: 'is-unassigned' }, h('td', { class: 'issue-error' }, 'ไม่ระบุบริษัท (ไม่นำเข้า)'), h('td', null, fmtNum(p.summary.unassigned)), h('td', null, '0'), h('td', null, '0'), h('td', null, '0'), h('td', null, fmtNum(p.summary.unassigned)), h('td', null, '0')) : null)));
  }

  function previewStep(): HTMLElement {
    const p = preview!;
    const s = p.summary;
    const byCompany = (r: PreviewRow) => companyFilter === 'all' || (companyFilter === 'none' ? r.company_id === null : String(r.company_id) === companyFilter);
    const shown = p.rows.filter((r) => (filter === 'all' || r.status === filter) && byCompany(r));
    const per = 100;
    const pages = Math.max(1, Math.ceil(shown.length / per));
    pageNo = Math.min(pageNo, pages - 1);
    const seg = h('div', { class: 'segmented', role: 'group', 'aria-label': 'กรองตามผลการตรวจสอบ' },
      (['all', 'valid', 'warning', 'duplicate', 'invalid'] as const).map((k) => h('label', null,
        h('input', { type: 'radio', name: 'clock-filter', value: k, checked: filter === k, onchange: () => { filter = k; pageNo = 0; render(); } }),
        h('span', null, k === 'all' ? `ทั้งหมด ${fmtNum(s.total)}` : `${k === 'warning' ? 'Warning' : k === 'valid' ? 'Valid' : k === 'duplicate' ? 'Duplicate' : 'Invalid'} ${fmtNum(s[k])}`))));
    const companyPick = (p.companies?.length ?? 0) > 1 || s.unassigned
      ? h('select', { 'aria-label': 'ดูเฉพาะบริษัท', onchange: (e: Event) => { companyFilter = (e.target as HTMLSelectElement).value; pageNo = 0; render(); } },
          h('option', { value: 'all', selected: companyFilter === 'all' }, 'ทุกบริษัท'),
          (p.companies ?? []).map((c) => h('option', { value: String(c.id), selected: companyFilter === String(c.id) }, `${c.name} (${c.code})`)),
          s.unassigned ? h('option', { value: 'none', selected: companyFilter === 'none' }, 'ไม่ระบุบริษัท') : null)
      : null;
    const result = (r: PreviewRow) => {
      if (r.attendance_status === null) return '-';
      const parts = [r.attendance_status === 'late' ? `สาย ${formatDuration(r.late_minutes ?? 0)}` : 'ตรงเวลา'];
      if (r.early_leave_minutes) parts.push(`ออกก่อน ${formatDuration(r.early_leave_minutes)}`);
      if (r.worked_minutes !== null) parts.push(`ทำงาน ${formatDuration(r.worked_minutes)}`);
      return parts.join(' · ');
    };
    const daily = p.template === FEISHU_DAILY_TEMPLATE;
    const code = (id: number | null | undefined) => (id === null || id === undefined ? h('span', { class: 'issue-error' }, 'ไม่ระบุ') : (list.find((x) => x.id === id)?.code ?? `#${id}`));
    const rowsOnPage = shown.slice(pageNo * per, pageNo * per + per);
    const badge = (r: PreviewRow) => h('span', { class: `badge-status ${STATUS_CLASS[r.status]}` }, CLOCK_STATUS_LABEL[r.status]);
    const table = daily
      ? h('table', { class: 'table compact clock-rows daily-rows' },
          h('thead', null, h('tr', null, ['รายการ', 'ช่อง', 'บริษัท', 'รหัส', 'ชื่อพนักงาน', 'วันที่ทำงาน', 'ผลลงเวลาเข้า', 'ผลลงเวลาออก', 'เวลาที่นำเข้า', 'เหตุการณ์ในวัน', 'สถานะ', 'รายละเอียด'].map((t) => h('th', null, t)))),
          h('tbody', null, rowsOnPage.map((r) => h('tr', { 'data-status': r.status, 'data-ref': r.source_ref ?? '', 'data-company': r.company_id === null || r.company_id === undefined ? 'none' : String(r.company_id) },
            h('td', null, String(r.row_no)), h('td', null, r.source_ref ?? '-'), h('td', null, code(r.company_id)), h('td', null, r.employee_code ?? '-'), h('td', null, r.employee_name ?? '-'), h('td', null, fmtDate(r.work_date!)),
            h('td', null, r.day_kind === 'rest' ? 'วันหยุด (Break)' : punchText(r.in_result)), h('td', null, r.day_kind === 'rest' ? '-' : punchText(r.out_result)),
            h('td', null, r.clock_in || r.clock_out ? `${r.clock_in ?? '-'} – ${r.clock_out ?? '-'}${r.out_next_day ? ' (+1)' : ''}` : h('span', { class: 'muted' }, r.exempt ? 'ไม่มี (ได้รับยกเว้น)' : 'ไม่มี')),
            h('td', null, eventList(r.events)), h('td', null, badge(r)), h('td', null, issueList(r.issues))))))
      : h('table', { class: 'table compact clock-rows' },
          h('thead', null, h('tr', null, ['แถว', 'รหัส', 'ชื่อพนักงาน', 'วันที่', 'เข้า', 'ออก', 'กะ', 'ผลเวลา', 'สถานะ', 'รายละเอียด'].map((t) => h('th', null, t)))),
          h('tbody', null, rowsOnPage.map((r) => h('tr', { 'data-status': r.status },
            h('td', null, String(r.row_no)), h('td', null, r.employee_code ?? '-'), h('td', null, r.employee_name ?? '-'), h('td', null, r.work_date ? fmtDate(r.work_date) : '-'),
            h('td', null, r.clock_in ?? '-'), h('td', null, r.clock_out ? `${r.clock_out}${r.out_next_day ? ' (+1)' : ''}` : '-'), h('td', null, r.shift_label ?? h('span', { class: 'muted' }, 'ไม่มีกะ')),
            h('td', null, result(r)), h('td', null, badge(r)), h('td', null, issueList(r.issues))))));
    return h('section', { class: 'card wizard-step' },
      h('h2', { tabindex: '-1' }, '4. ตรวจสอบข้อมูล'),
      sheetBadge(p.sheet_name, p.template),
      p.previous.length ? h('div', { class: 'alert', role: 'status' }, `ไฟล์นี้เคยนำเข้าแล้ว (#${p.previous.map((x) => `${x.id} เมื่อ ${fmtDate(x.created_at)}`).join(', ')}) รายการที่มีอยู่แล้วจะถูกนับเป็นรายการซ้ำและไม่ถูกนำเข้าอีก`) : null,
      daily ? h('p', { class: 'muted rows-before-after' },
        `ก่อนตรวจสอบ: ${fmtNum(s.source_rows ?? 0)} แถวพนักงานในไฟล์ → ${fmtNum(s.total)} รายการรายวัน (ข้ามช่องว่าง/“-” ${fmtNum(s.empty_days ?? 0)} ช่อง) · หลังตรวจสอบ: นำเข้าได้ ${fmtNum(s.importable)} รายการ ` +
        `(สร้างบันทึกเวลา ${fmtNum(s.with_clock ?? 0)} รายการ, เหตุการณ์ลา/OT/นอกสถานที่ ${fmtNum(s.events ?? 0)} รายการ เก็บเป็นข้อมูลประกอบ ไม่สร้างใบลา คำขอ OT หรือรายการเงินเดือน)`) : null,
      s.exempt_days ? h('p', { class: 'muted small exempt-note' }, `พนักงานที่ได้รับยกเว้นการบันทึกเวลา: ${fmtNum(s.exempt_days)} รายการรายวัน ไม่แจ้งเตือนการไม่มีเวลาเข้า-ออก (เวลาที่มีจริงยังนำเข้าตามปกติ)`) : null,
      h('div', { class: 'kpis' }, kpi('ทั้งหมด', s.total), kpi('Valid (ผ่าน)', s.valid), kpi('Warning (ผ่าน มีคำเตือน)', s.warning, s.warning ? 'kpi-warn' : ''), kpi('Duplicate (ซ้ำ)', s.duplicate, s.duplicate ? 'kpi-warn' : ''), kpi('Invalid (ไม่ถูกต้อง)', s.invalid, s.invalid ? 'kpi-bad' : '')),
      companySummary(p),
      h('div', { class: 'toolbar' }, seg, companyPick),
      shown.length ? h('div', { class: 'table-wrap table-scroll' }, table) : h('div', { class: 'empty' }, 'ไม่มีรายการในกลุ่มนี้'),
      pages > 1 ? h('div', { class: 'pager' },
        h('button', { class: 'btn small', disabled: pageNo === 0, onclick: () => { pageNo--; render(); } }, '‹'),
        h('span', null, `หน้า ${pageNo + 1} / ${pages}`),
        h('button', { class: 'btn small', disabled: pageNo >= pages - 1, onclick: () => { pageNo++; render(); } }, '›')) : null,
      h('div', { class: 'form-actions' },
        h('button', { class: 'btn', onclick: () => { step = 2; render(); } }, 'ย้อนกลับ'),
        h('button', { class: 'btn primary', disabled: !s.total, onclick: () => { step = 4; render(); } }, 'ถัดไป: ยืนยันการนำเข้า')));
  }

  function confirmStep(): HTMLElement {
    const p = preview!;
    const s = p.summary;
    const target = p.company_mode === 'combined' ? `${fmtNum(p.companies?.length ?? 0)} บริษัท (แยก Import Batch ตามบริษัท)` : `บริษัท ${p.company!.name}`;
    const go = async () => {
      if (!(await confirmDialog('ยืนยันการนำเข้า', `นำเข้าบันทึกเวลา ${fmtNum(s.importable)} รายการ จากไฟล์ ${file!.name} เข้าสู่${target}? รายการซ้ำ ไม่ถูกต้อง และไม่ระบุบริษัทจะไม่ถูกนำเข้า`, 'ยืนยันนำเข้า'))) return;
      mount(page, stepper6(4), h('div', { class: 'card' }, loading()));
      try {
        result = await post<Batch | Group>('/api/attendance-files', { ...request(true), idempotency_key: key, confirm: true });
        step = 5;
        toast(isGroup(result) ? `นำเข้าแล้ว ${fmtNum(result.batches.reduce((n, b) => n + b.imported_count, 0))} รายการ` : `นำเข้าแล้ว ${fmtNum(result.imported_count)} รายการ`);
        render();
      } catch (e) {
        mount(page, stepper6(4), errorBox(e), h('div', { class: 'form-actions' }, h('button', { class: 'btn', onclick: () => render() }, 'ย้อนกลับ')));
      }
    };
    return h('section', { class: 'card wizard-step' },
      h('h2', { tabindex: '-1' }, '5. ยืนยันการนำเข้า'),
      sheetBadge(p.sheet_name, p.template),
      h('dl', { class: 'dl' },
        h('dt', null, 'บริษัท'), h('dd', { class: 'confirm-target' }, p.company_mode === 'combined' ? (p.companies ?? []).map((c) => `${c.name} (${c.code})`).join(', ') || '-' : p.company!.name),
        h('dt', null, 'ไฟล์'), h('dd', null, `${file!.name} (${fmtSize(file!.size)})`),
        h('dt', null, 'Worksheet'), h('dd', null, p.sheet_name ?? '-'),
        h('dt', null, 'แหล่งข้อมูล'), h('dd', null, source || '-')),
      h('div', { class: 'kpis' }, kpi('จำนวนทั้งหมด', s.total), kpi('จำนวนผ่าน', s.valid + s.warning), kpi('จำนวนซ้ำ', s.duplicate, s.duplicate ? 'kpi-warn' : ''), kpi('จำนวนผิดพลาด', s.invalid, s.invalid ? 'kpi-bad' : ''), kpi('จำนวนที่จะนำเข้า', s.importable)),
      companySummary(p),
      h('p', { class: 'muted' }, 'ข้อมูลต้นฉบับทุกแถวจะถูกเก็บไว้ตรวจสอบย้อนหลัง บันทึกเวลาที่มีอยู่แล้วจะไม่ถูกเขียนทับ และการนำเข้าไม่แก้ไขข้อมูลเงินเดือน'),
      h('div', { class: 'form-actions' },
        h('button', { class: 'btn', onclick: () => { step = 3; render(); } }, 'ย้อนกลับ'),
        can('attendance_file.import') ? h('button', { class: 'btn primary', disabled: !s.importable, onclick: () => void go() }, `ยืนยันนำเข้า ${fmtNum(s.importable)} รายการ`) : null));
  }

  function resultStep(): HTMLElement {
    const r = result!;
    const again = h('button', { class: 'btn primary', onclick: () => void renderAttendanceFileImport(main) }, 'นำเข้าไฟล์ใหม่');
    if (isGroup(r)) {
      return h('section', { class: 'card wizard-step' },
        h('h2', { tabindex: '-1' }, '6. ผลการนำเข้า'),
        h('div', { class: 'alert', role: 'status' }, `นำเข้าไฟล์รวม ${fmtNum(r.company_count)} บริษัท · Import Group #${r.id}${r.repeated ? ' (ยืนยันซ้ำ แสดงผลการนำเข้าเดิม)' : ''}`),
        sheetBadge(r.sheet_name, FEISHU_DAILY_TEMPLATE),
        h('div', { class: 'kpis' }, kpi('สำเร็จ', r.batches.reduce((n, b) => n + b.imported_count, 0)), kpi('ซ้ำ', r.batches.reduce((n, b) => n + b.duplicate_count, 0)),
          kpi('ผิดพลาด', r.batches.reduce((n, b) => n + b.invalid_count, 0)), kpi('ไม่ระบุบริษัท', r.unassigned_count, r.unassigned_count ? 'kpi-bad' : '')),
        groupBatchesTable(r.batches),
        h('dl', { class: 'dl' }, h('dt', null, 'วันที่และเวลานำเข้า'), h('dd', null, fmtDate(r.created_at)), h('dt', null, 'ผู้ดำเนินการ'), h('dd', null, r.created_by_name ?? '-'), h('dt', null, 'ไฟล์ต้นทาง'), h('dd', null, r.file_name)),
        h('div', { class: 'form-actions' }, link(`/attendance/file-imports?group=${r.id}`, 'ดูรายละเอียด', { class: 'btn' }), link('/attendance', 'บันทึกเวลาทำงาน', { class: 'btn' }), again));
    }
    return h('section', { class: 'card wizard-step' },
      h('h2', { tabindex: '-1' }, '6. ผลการนำเข้า'),
      h('div', { class: 'alert', role: 'status' }, `${BATCH_STATUS[r.status]} · Import #${r.id}${r.repeated ? ' (ยืนยันซ้ำ แสดงผลการนำเข้าเดิม)' : ''}`),
      sheetBadge(r.sheet_name, r.template_code),
      h('div', { class: 'kpis' }, kpi('สำเร็จ', r.imported_count), kpi('ซ้ำ', r.duplicate_count, r.duplicate_count ? 'kpi-warn' : ''), kpi('ผิดพลาด', r.invalid_count, r.invalid_count ? 'kpi-bad' : ''), kpi('มีคำเตือน', r.warning_count),
        r.template_code === FEISHU_DAILY_TEMPLATE ? kpi('สร้างบันทึกเวลา', r.record_count ?? 0) : null),
      h('dl', { class: 'dl' },
        h('dt', null, 'วันที่และเวลานำเข้า'), h('dd', null, fmtDate(r.created_at)),
        h('dt', null, 'ผู้ดำเนินการ'), h('dd', null, r.created_by_name ?? '-'),
        h('dt', null, 'ไฟล์ต้นทาง'), h('dd', null, r.file_name),
        h('dt', null, 'Worksheet'), h('dd', null, r.sheet_name ?? '-'),
        h('dt', null, 'บริษัท'), h('dd', null, r.company)),
      h('div', { class: 'form-actions' }, reportLinks(r.id), link(`/attendance/file-imports?id=${r.id}`, 'ดูรายละเอียด', { class: 'btn' }), link('/attendance', 'บันทึกเวลาทำงาน', { class: 'btn' }), again));
  }

  render();
}

async function renderGroup(main: HTMLElement, id: number): Promise<void> {
  const g = await get<Group>(`/api/attendance-files/groups/${id}`);
  mount(main, h('div', { class: 'stack' },
    h('div', { class: 'toolbar' }, link('/attendance/file-imports', '‹ ประวัติการนำเข้า', { class: 'btn' })),
    h('div', { class: 'card' },
      h('h2', null, `Import Group #${g.id} · ${g.file_name}`),
      sheetBadge(g.sheet_name, FEISHU_DAILY_TEMPLATE),
      h('dl', { class: 'dl' }, h('dt', null, 'ประเภทไฟล์'), h('dd', null, 'หลายบริษัทในไฟล์เดียว'), h('dt', null, 'ผู้นำเข้า'), h('dd', null, g.created_by_name ?? '-'), h('dt', null, 'วันที่นำเข้า'), h('dd', null, fmtDate(g.created_at)),
        h('dt', null, 'รายการทั้งหมด'), h('dd', null, fmtNum(g.total_rows)), h('dt', null, 'ไม่ระบุบริษัท'), h('dd', null, fmtNum(g.unassigned_count)))),
    h('h3', null, 'Import Batch แยกตามบริษัท'),
    g.batches.length ? groupBatchesTable(g.batches) : h('div', { class: 'empty' }, 'ไม่มี Batch ของบริษัทที่คุณมีสิทธิ์ดู'),
    g.unassigned_rows
      ? [h('h3', null, `แถวที่ไม่ระบุบริษัท (${fmtNum(g.unassigned_rows.length)})`),
          g.unassigned_rows.length
            ? h('div', { class: 'table-wrap table-scroll' }, h('table', { class: 'table compact unassigned-rows' },
                h('thead', null, h('tr', null, ['รายการ', 'ช่อง', 'รหัส', 'วันที่', 'ค่าบริษัทในไฟล์', 'รายละเอียด'].map((t) => h('th', null, t)))),
                h('tbody', null, g.unassigned_rows.map((r) => h('tr', null, h('td', null, String(r.row_no)), h('td', null, r.source_ref ?? '-'), h('td', null, r.employee_code ?? '-'),
                  h('td', null, r.work_date ? fmtDate(r.work_date) : '-'), h('td', null, r.company_value ?? '(ว่าง)'), h('td', null, issueList(r.issues)))))))
            : h('div', { class: 'empty' }, 'ไม่มี')]
      : null));
}

export async function renderAttendanceFileHistory(main: HTMLElement, params: URLSearchParams): Promise<void> {
  mount(main, loading());
  try {
    const id = params.get('id');
    if (id) return await renderBatch(main, Number(id));
    const group = params.get('group');
    if (group) return await renderGroup(main, Number(group));
    const rows = await get<Batch[]>(`/api/attendance-files${qs({ company: state.companyId })}`);
    mount(main, h('div', { class: 'stack' },
      h('div', { class: 'toolbar' }, h('div', { class: 'spacer' }), can('attendance_file.import') ? link('/attendance/file-import', '+ นำเข้าไฟล์เวลาทำงาน', { class: 'btn primary' }) : null),
      rows.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'table import-history' },
            h('thead', null, h('tr', null, ['Import ID', 'ไฟล์', 'Worksheet', 'Template', 'บริษัท', 'ผู้นำเข้า', 'วันที่นำเข้า', 'ทั้งหมด', 'สำเร็จ', 'ซ้ำ', 'ผิดพลาด', 'สถานะ', 'Report'].map((t) => h('th', null, t)))),
            h('tbody', null, rows.map((b) => h('tr', null,
              h('td', null, link(`/attendance/file-imports?id=${b.id}`, `#${b.id}`), b.group_id ? h('div', { class: 'small' }, link(`/attendance/file-imports?group=${b.group_id}`, `กลุ่ม #${b.group_id}`)) : null), h('td', { class: 'truncate' }, b.file_name), h('td', null, b.sheet_name ?? '-'),
              h('td', null, b.template_code === FEISHU_DAILY_TEMPLATE ? 'Feishu Daily' : 'ไฟล์เวลา'), h('td', null, b.company), h('td', null, b.created_by_name ?? '-'), h('td', null, fmtDate(b.created_at)),
              h('td', null, fmtNum(b.total_rows)), h('td', null, fmtNum(b.imported_count)), h('td', null, fmtNum(b.duplicate_count)), h('td', null, fmtNum(b.invalid_count)),
              h('td', null, h('span', { class: `badge-status s-${b.status === 'failed' ? 'error' : b.status}` }, BATCH_STATUS[b.status])), h('td', null, reportLinks(b.id)))))))
        : h('div', { class: 'card' }, h('div', { class: 'empty' }, 'ยังไม่มีประวัติการนำเข้าไฟล์เวลาทำงาน')),
    ));
  } catch (e) {
    mount(main, errorBox(e));
  }
}

async function renderBatch(main: HTMLElement, id: number): Promise<void> {
  const b = await get<Batch & { rows: Array<Omit<PreviewRow, 'in_result' | 'out_result'> & { attendance_record_id: number | null; clock_out_next_day: number; in_result: string | null; out_result: string | null }> }>(`/api/attendance-files/${id}`);
  const isDaily = b.template_code === FEISHU_DAILY_TEMPLATE;
  const out = (r: (typeof b.rows)[number]) => (r.clock_out ? `${r.clock_out}${r.clock_out_next_day ? ' (+1)' : ''}` : '-');
  const badge = (r: (typeof b.rows)[number]) => h('span', { class: `badge-status ${STATUS_CLASS[r.status]}` }, CLOCK_STATUS_LABEL[r.status]);
  mount(main, h('div', { class: 'stack' },
    h('div', { class: 'toolbar' }, link('/attendance/file-imports', '‹ ประวัติการนำเข้า', { class: 'btn' }), h('div', { class: 'spacer' }), reportLinks(b.id)),
    h('div', { class: 'card' },
      h('h2', null, `Import #${b.id} · ${b.file_name}`),
      sheetBadge(b.sheet_name, b.template_code),
      h('dl', { class: 'dl' }, h('dt', null, 'บริษัท'), h('dd', null, b.company), h('dt', null, 'ผู้นำเข้า'), h('dd', null, b.created_by_name ?? '-'), h('dt', null, 'วันที่นำเข้า'), h('dd', null, fmtDate(b.created_at)),
        h('dt', null, 'สถานะ'), h('dd', null, BATCH_STATUS[b.status]),
        isDaily ? [h('dt', null, 'แถวในไฟล์ → รายการรายวัน'), h('dd', null, `${fmtNum(b.source_rows ?? 0)} → ${fmtNum(b.total_rows)}`)] : null),
      h('div', { class: 'kpis' }, kpi('ทั้งหมด', b.total_rows), kpi('สำเร็จ', b.imported_count), kpi('ซ้ำ', b.duplicate_count, b.duplicate_count ? 'kpi-warn' : ''), kpi('ผิดพลาด', b.invalid_count, b.invalid_count ? 'kpi-bad' : ''),
        isDaily ? kpi('สร้างบันทึกเวลา', b.record_count ?? 0) : null)),
    h('div', { class: 'table-wrap table-scroll' }, isDaily
      ? h('table', { class: 'table compact daily-rows' },
          h('thead', null, h('tr', null, ['รายการ', 'ช่อง', 'รหัส', 'ชื่อพนักงาน', 'วันที่', 'ผลเข้า', 'ผลออก', 'เข้า', 'ออก', 'เหตุการณ์ในวัน', 'สถานะ', 'บันทึกเวลา', 'รายละเอียด'].map((t) => h('th', null, t)))),
          h('tbody', null, b.rows.map((r) => h('tr', { 'data-status': r.status }, h('td', null, String(r.row_no)), h('td', null, r.source_ref ?? '-'), h('td', null, r.employee_code ?? '-'), h('td', null, r.employee_name ?? '-'),
            h('td', null, r.work_date ? fmtDate(r.work_date) : '-'), h('td', null, r.in_result ?? '-'), h('td', null, r.out_result ?? '-'), h('td', null, r.clock_in ?? '-'), h('td', null, out(r)),
            h('td', null, eventList(r.events)), h('td', null, badge(r)), h('td', null, r.attendance_record_id ? 'สร้างแล้ว' : '-'), h('td', null, issueList(r.issues))))))
      : h('table', { class: 'table compact' },
          h('thead', null, h('tr', null, ['แถว', 'รหัส', 'ชื่อพนักงาน', 'วันที่', 'เข้า', 'ออก', 'สถานะ', 'นำเข้า', 'รายละเอียด'].map((t) => h('th', null, t)))),
          h('tbody', null, b.rows.map((r) => h('tr', null, h('td', null, String(r.row_no)), h('td', null, r.employee_code ?? '-'), h('td', null, r.employee_name ?? '-'), h('td', null, r.work_date ? fmtDate(r.work_date) : '-'),
            h('td', null, r.clock_in ?? '-'), h('td', null, out(r)),
            h('td', null, badge(r)), h('td', null, r.attendance_record_id ? 'ใช่' : 'ไม่'), h('td', null, issueList(r.issues)))))))));
}
