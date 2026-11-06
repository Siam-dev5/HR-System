// Leave and overtime import wizards (Feishu approval exports, one worksheet per import) and their own import history.
// Same five steps as the attendance file import; the parser, mapping, validation and history are per data domain.
// Imported rows are kept as imported leave / OT records: no leave request, OT request, OT pay or payroll item is made.
import type { CompanyOption } from '../../shared/types';
import { APPROVAL_LABEL, REQUEST_TEMPLATES, type ApprovalStatus, type RequestImportType, type RequestRowStatus } from '../../shared/feishu-requests';
import { CLOCK_STATUS_LABEL } from '../../shared/clock-import';
import { IMPORT_TYPE_LABEL, detectSheet, wrongSheetMessage } from '../../shared/import-templates';
import { get, post, qs } from '../api';
import { h, mount, loading, errorBox, fmtDate, fmtNum, toast, confirmDialog } from '../dom';
import { can, link, state } from '../app';
import { companies, noCompanies } from './attendance';
import {
  BATCH_STATUS, STATUS_CLASS, dataRows, defaultSheet, fmtSize, issueList, kpi, loadClockFile, reportLinks, sheetBadge, sheetPicker, stepper, type LoadedFile,
} from './attendance-files';

interface Domain {
  type: RequestImportType;
  api: string;
  importPath: string;
  historyPath: string;
  importPerm: string;
  noun: string;
}
const DOMAINS: Record<RequestImportType, Domain> = {
  leave: { type: 'leave', api: '/api/leave-imports', importPath: '/leave/import', historyPath: '/leave/imports', importPerm: 'leave_import.import', noun: 'ข้อมูลการลา' },
  overtime: { type: 'overtime', api: '/api/overtime-imports', importPath: '/overtime/import', historyPath: '/overtime/imports', importPerm: 'overtime_import.import', noun: 'ข้อมูล OT' },
};

interface Issue {
  code: string;
  level: 'error' | 'warning' | 'info';
  message: string;
}
interface Row {
  row_no: number;
  request_no: string | null;
  detail_no: number;
  employee_code: string | null;
  employee_name: string | null;
  approval_status: ApprovalStatus | null;
  status_text: string | null;
  approver: string | null;
  type_label: string | null;
  start_at: string | null;
  end_at: string | null;
  amount: number | null;
  unit: string | null;
  work_date: string | null;
  detail_hours: number | null;
  overnight: boolean | number;
  status: RequestRowStatus;
  issues: Issue[];
}
interface Preview {
  import_type: RequestImportType;
  template: string;
  sheet_name: string | null;
  company: CompanyOption;
  header_row: number;
  headers: string[];
  mapping: Record<string, number | null | undefined>;
  remembered: boolean;
  mapping_problems: string[];
  fields: Array<{ key: string; label: string; required: boolean }>;
  previous: Array<{ id: number; created_at: string; file_name: string }>;
  summary: { total: number; valid: number; warning: number; duplicate: number; invalid: number; importable: number; approval: Record<ApprovalStatus, number> };
  rows: Row[];
}
interface Batch {
  id: number;
  import_type: RequestImportType;
  company: string;
  template_code: string;
  file_name: string;
  sheet_name: string | null;
  total_rows: number;
  imported_count: number;
  duplicate_count: number;
  warning_count: number;
  invalid_count: number;
  status: 'completed' | 'partial' | 'failed';
  created_at: string;
  created_by_name: string | null;
  repeated?: boolean;
}

const unitText = (u: string | null) => (u === 'day' ? 'วัน' : u === 'minute' ? 'นาที' : u === 'hour' ? 'ชม.' : (u ?? ''));
const approval = (r: Pick<Row, 'approval_status' | 'status_text'>) =>
  r.approval_status ? h('span', { class: `badge-status appr-${r.approval_status}` }, APPROVAL_LABEL[r.approval_status]) : (r.status_text ?? '-');
const statusBadge = (s: RequestRowStatus) => h('span', { class: `badge-status ${STATUS_CLASS[s]}` }, CLOCK_STATUS_LABEL[s]);

function rowTable(d: Domain, rows: readonly Row[]): HTMLElement {
  const head = d.type === 'leave'
    ? ['แถว', 'เลขที่คำขอ', 'รหัส', 'ชื่อพนักงาน', 'ประเภทการลา', 'เริ่ม', 'สิ้นสุด', 'จำนวน', 'การอนุมัติ', 'ผู้อนุมัติ', 'สถานะ', 'รายละเอียด']
    : ['แถว', 'เลขที่คำขอ', 'รายการย่อย', 'รหัส', 'ชื่อพนักงาน', 'วันที่ทำ OT', 'เริ่ม', 'สิ้นสุด', 'ชม. คำขอ', 'ชม. วันนี้', 'การอนุมัติ', 'ผู้อนุมัติ', 'สถานะ', 'รายละเอียด'];
  return h('table', { class: `table compact request-rows ${d.type}-rows` },
    h('thead', null, h('tr', null, head.map((t) => h('th', null, t)))),
    h('tbody', null, rows.map((r) => h('tr', { 'data-status': r.status, 'data-request': r.request_no ?? '' },
      d.type === 'leave'
        ? [h('td', null, String(r.row_no)), h('td', null, r.request_no ?? '-'), h('td', null, r.employee_code ?? '-'), h('td', null, r.employee_name ?? '-'), h('td', null, r.type_label ?? '-'),
            h('td', null, r.start_at ?? '-'), h('td', null, r.end_at ?? '-'), h('td', null, r.amount !== null ? `${fmtNum(r.amount)} ${unitText(r.unit)}` : '-'), h('td', null, approval(r)),
            h('td', { class: 'truncate' }, r.approver ?? '-'), h('td', null, statusBadge(r.status)), h('td', null, issueList(r.issues))]
        : [h('td', null, String(r.row_no)), h('td', null, r.request_no ?? '-'), h('td', null, String(r.detail_no)), h('td', null, r.employee_code ?? '-'), h('td', null, r.employee_name ?? '-'),
            h('td', null, r.work_date ? fmtDate(r.work_date) : '-'), h('td', null, r.start_at ?? '-'), h('td', null, `${r.end_at ?? '-'}${r.overnight ? ' (ข้ามวัน)' : ''}`),
            h('td', null, r.amount !== null ? fmtNum(r.amount) : '-'), h('td', null, r.detail_hours !== null ? fmtNum(r.detail_hours) : '-'), h('td', null, approval(r)),
            h('td', { class: 'truncate' }, r.approver ?? '-'), h('td', null, statusBadge(r.status)), h('td', null, issueList(r.issues))]))));
}

function approvalKpis(a: Record<ApprovalStatus, number>): HTMLElement {
  return h('div', { class: 'kpis approval-kpis' }, kpi('อนุมัติ (Approved)', a.approved), kpi('รออนุมัติ (Pending)', a.pending), kpi('ไม่อนุมัติ (Rejected)', a.rejected), kpi('ยกเลิก (Cancelled)', a.cancelled));
}

async function renderImport(main: HTMLElement, d: Domain): Promise<void> {
  const list = companies();
  if (!list.length) return mount(main, noCompanies());
  const page = h('div', { class: `stack clock-import ${d.type}-import` });
  mount(main, page);
  let step = 0;
  let file: LoadedFile | null = null;
  let sheetIdx = 0;
  let companyId = state.companyId ?? list[0]!.id;
  let headerRow: number | null = null;
  let mapping: Record<string, number | null | undefined> | null = null;
  let preview: Preview | null = null;
  let result: Batch | null = null;
  let filter: RequestRowStatus | 'all' = 'all';
  let pageNo = 0;
  const key = crypto.randomUUID();

  const grid = () => file?.sheets[sheetIdx]?.rows ?? [];
  const sheetName = () => file?.sheets[sheetIdx]?.name ?? null;
  // only the selected worksheet is sent
  const request = (withMapping: boolean) => ({
    company_id: companyId, file_name: file!.name, file_type: file!.type, file_size: file!.size, sha256: file!.sha, sheet_name: sheetName(),
    grid: grid(), header_row: headerRow, mapping: withMapping ? mapping : null,
  });
  const runPreview = async (withMapping: boolean, next: number) => {
    mount(page, stepper(step), h('div', null, loading()));
    try {
      preview = await post<Preview>(`${d.api}/preview`, request(withMapping));
      headerRow = preview.header_row;
      mapping = preview.mapping;
      step = preview.mapping_problems.length && next > 1 ? 1 : next;
      render();
    } catch (e) {
      mount(page, stepper(step), errorBox(e), h('div', { class: 'form-actions' }, h('button', { class: 'btn', onclick: () => render() }, 'ย้อนกลับ')));
    }
  };
  const render = () => {
    const views = [uploadStep, mappingStep, previewStep, confirmStep, resultStep];
    mount(page, stepper(step), views[step]!());
    page.querySelector<HTMLElement>('.wizard-step h2')?.focus();
  };

  function uploadStep(): HTMLElement {
    const id = `${d.type}-file`;
    const input = h('input', { type: 'file', accept: '.xlsx,.xls,.csv', 'aria-label': `เลือกไฟล์${d.noun}`, class: 'visually-hidden', id });
    const info = h('div', { class: 'file-info', 'aria-live': 'polite' });
    const nextBtn = h('button', { class: 'btn primary', disabled: !file, onclick: () => void runPreview(false, 1) }, 'ถัดไป: จับคู่คอลัมน์');
    const showInfo = () => {
      if (!file) return mount(info, h('span', { class: 'muted' }, 'ยังไม่ได้เลือกไฟล์'));
      const kind = detectSheet(grid());
      const wrong = wrongSheetMessage(d.type, kind, sheetName());
      nextBtn.disabled = !!wrong;
      mount(info, h('dl', { class: 'dl' },
        h('dt', null, 'ชื่อไฟล์'), h('dd', { class: 'file-name' }, file.name),
        h('dt', null, 'ขนาด'), h('dd', null, fmtSize(file.size)),
        h('dt', null, 'ชนิดไฟล์'), h('dd', null, file.type.toUpperCase()),
        h('dt', null, 'Worksheet ที่เลือก'), h('dd', { class: 'file-sheet' }, sheetName() ?? '-'),
        h('dt', null, 'จำนวนแถวข้อมูล'), h('dd', { class: 'file-rows' }, fmtNum(dataRows(grid())))),
        file.sheets.length > 1 ? sheetPicker(file, sheetIdx, d.type, (i) => { sheetIdx = i; headerRow = null; mapping = null; showInfo(); }) : null,
        wrong ? h('div', { class: 'alert alert-error', role: 'alert' }, wrong)
          : kind.type !== d.type ? h('div', { class: 'alert', role: 'status' }, `ไม่พบหัวตารางรูปแบบ ${REQUEST_TEMPLATES[d.type]} ใน Worksheet นี้ ต้องจับคู่คอลัมน์เอง`) : null);
    };
    const pick = async (f: File | undefined) => {
      if (!f) return;
      mount(info, loading());
      try {
        file = await loadClockFile(f);
        sheetIdx = defaultSheet(file, d.type);
        headerRow = null;
        mapping = null;
        preview = null;
        showInfo();
      } catch (e) {
        file = null;
        nextBtn.disabled = true;
        mount(info, errorBox(e));
      }
    };
    input.addEventListener('change', () => void pick(input.files?.[0]));
    const drop = h('label', { class: 'dropzone', for: id, tabindex: '0', onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } } },
      h('strong', null, 'ลากไฟล์มาวางที่นี่ หรือคลิกเพื่อเลือกไฟล์'), h('span', { class: 'muted small' }, `ไฟล์ Export จาก Feishu (${REQUEST_TEMPLATES[d.type]}) .xlsx .xls .csv ขนาดไม่เกิน 15 MB ไม่เกิน 10,000 แถว`));
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('drag'); void pick(e.dataTransfer?.files?.[0]); });
    const company = h('select', { 'aria-label': 'บริษัท', onchange: (e: Event) => { companyId = Number((e.target as HTMLSelectElement).value); } }, list.map((c) => h('option', { value: String(c.id), selected: c.id === companyId }, `${c.name} (${c.code})`)));
    showInfo();
    return h('section', { class: 'card wizard-step' },
      h('h2', { tabindex: '-1' }, `1. อัปโหลดไฟล์${d.noun}`),
      h('p', { class: 'muted import-type-note' }, `ประเภทข้อมูล: ${IMPORT_TYPE_LABEL[d.type]} · ${d.type === 'leave' ? 'ไม่สร้างใบลาและไม่แก้ไขบันทึกเวลาทำงาน' : 'ไม่คำนวณค่า OT ไม่สร้างคำขอ OT และไม่สร้างรายการเงินเดือน'}`),
      h('div', { class: 'grid-form' }, h('label', { class: 'field' }, h('span', null, 'บริษัท *'), company)),
      input, drop, info,
      h('div', { class: 'form-actions' }, link(d.historyPath, 'ประวัติการนำเข้า', { class: 'btn' }), nextBtn));
  }

  function mappingStep(): HTMLElement {
    const p = preview!;
    const selects = new Map<string, HTMLSelectElement>();
    const opts = (sel: number | null | undefined) => [h('option', { value: '' }, '— ไม่ใช้ —'), p.headers.map((hd, i) => h('option', { value: String(i), selected: sel === i }, hd || `คอลัมน์ ${i + 1}`))];
    const rows = p.fields.map((f) => {
      const s = h('select', { 'aria-label': f.label, 'data-field': f.key }, opts(p.mapping[f.key]));
      selects.set(f.key, s);
      return h('tr', null, h('td', null, f.label, f.required ? h('span', { class: 'req' }, ' *') : h('span', { class: 'muted small' }, ' (ไม่บังคับ)')), h('td', null, s));
    });
    const hr = h('input', { type: 'number', min: 1, max: 50, value: String(p.header_row + 1), 'aria-label': 'แถวหัวตาราง', style: 'max-width:6rem' });
    const read = () => Object.fromEntries([...selects].map(([k, s]) => [k, s.value === '' ? null : Number(s.value)]));
    const sample = grid().slice(p.header_row + 1, p.header_row + 6);
    return h('section', { class: 'card wizard-step' },
      h('h2', { tabindex: '-1' }, '2. จับคู่คอลัมน์'),
      sheetBadge(p.sheet_name, p.template),
      p.remembered ? h('div', { class: 'alert', role: 'status' }, `ใช้ Mapping Template ที่บันทึกไว้ของบริษัทนี้ (${p.template})`) : null,
      p.mapping_problems.length ? h('div', { class: 'alert alert-error', role: 'alert' }, h('ul', { class: 'issues' }, p.mapping_problems.map((m) => h('li', null, m)))) : null,
      h('label', { class: 'field inline-form' }, h('span', null, 'หัวตารางอยู่แถวที่'), hr,
        h('button', { class: 'btn small', onclick: () => { headerRow = Math.max(0, Number(hr.value) - 1); void runPreview(false, 1); } }, 'อ่านหัวตารางใหม่')),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table compact mapping-table' }, h('thead', null, h('tr', null, h('th', null, 'ข้อมูลในระบบ'), h('th', null, 'คอลัมน์ในไฟล์'))), h('tbody', null, rows))),
      h('p', { class: 'muted small' }, 'Mapping ที่ใช้นำเข้าจะถูกบันทึกเป็น Template ของบริษัทและประเภทข้อมูลนี้ และใช้ซ้ำกับไฟล์รูปแบบเดียวกันครั้งต่อไป'),
      h('h3', null, 'ตัวอย่างข้อมูล 5 แถวแรก'),
      h('div', { class: 'table-wrap table-scroll' }, h('table', { class: 'table compact preview-table' },
        h('thead', null, h('tr', null, p.headers.map((hd, i) => h('th', null, hd || `คอลัมน์ ${i + 1}`)))),
        h('tbody', null, sample.map((r) => h('tr', null, p.headers.map((_, i) => h('td', null, r[i] === null || r[i] === undefined ? '' : String(r[i])))))))),
      h('div', { class: 'form-actions' },
        h('button', { class: 'btn', onclick: () => { step = 0; render(); } }, 'ย้อนกลับ'),
        h('button', { class: 'btn primary', onclick: () => { mapping = read(); void runPreview(true, 2); } }, 'ถัดไป: ตรวจสอบข้อมูล')));
  }

  function previewStep(): HTMLElement {
    const p = preview!;
    const s = p.summary;
    const shown = p.rows.filter((r) => filter === 'all' || r.status === filter);
    const per = 100;
    const pages = Math.max(1, Math.ceil(shown.length / per));
    pageNo = Math.min(pageNo, pages - 1);
    const seg = h('div', { class: 'segmented', role: 'group', 'aria-label': 'กรองตามผลการตรวจสอบ' },
      (['all', 'valid', 'warning', 'duplicate', 'invalid'] as const).map((k) => h('label', null,
        h('input', { type: 'radio', name: `${d.type}-filter`, value: k, checked: filter === k, onchange: () => { filter = k; pageNo = 0; render(); } }),
        h('span', null, k === 'all' ? `ทั้งหมด ${fmtNum(s.total)}` : `${k === 'warning' ? 'Warning' : k === 'valid' ? 'Valid' : k === 'duplicate' ? 'Duplicate' : 'Invalid'} ${fmtNum(s[k])}`))));
    return h('section', { class: 'card wizard-step' },
      h('h2', { tabindex: '-1' }, '3. ตรวจสอบข้อมูล'),
      sheetBadge(p.sheet_name, p.template),
      p.previous.length ? h('div', { class: 'alert', role: 'status' }, `Worksheet นี้ของไฟล์นี้เคยนำเข้าแล้ว (#${p.previous.map((x) => `${x.id} เมื่อ ${fmtDate(x.created_at)}`).join(', ')}) คำขอที่นำเข้าไว้แล้วจะนับเป็นรายการซ้ำ`) : null,
      h('p', { class: 'muted rows-before-after' }, `ก่อนตรวจสอบ: ${fmtNum(s.total)} แถว · หลังตรวจสอบ: นำเข้าได้ ${fmtNum(s.importable)} แถว (ซ้ำ ${fmtNum(s.duplicate)} · ผิดพลาด ${fmtNum(s.invalid)})`),
      h('div', { class: 'kpis' }, kpi('ทั้งหมด', s.total), kpi('Valid (ผ่าน)', s.valid), kpi('Warning (ผ่าน มีคำเตือน)', s.warning, s.warning ? 'kpi-warn' : ''), kpi('Duplicate (ซ้ำ)', s.duplicate, s.duplicate ? 'kpi-warn' : ''), kpi('Invalid (ไม่ถูกต้อง)', s.invalid, s.invalid ? 'kpi-bad' : '')),
      h('h3', null, 'สถานะการอนุมัติของแถวที่นำเข้าได้ (ตามไฟล์ ไม่เปลี่ยนแปลง)'),
      approvalKpis(s.approval),
      h('div', { class: 'toolbar' }, seg),
      shown.length ? h('div', { class: 'table-wrap table-scroll' }, rowTable(d, shown.slice(pageNo * per, pageNo * per + per))) : h('div', { class: 'empty' }, 'ไม่มีรายการในกลุ่มนี้'),
      pages > 1 ? h('div', { class: 'pager' },
        h('button', { class: 'btn small', disabled: pageNo === 0, onclick: () => { pageNo--; render(); } }, '‹'),
        h('span', null, `หน้า ${pageNo + 1} / ${pages}`),
        h('button', { class: 'btn small', disabled: pageNo >= pages - 1, onclick: () => { pageNo++; render(); } }, '›')) : null,
      h('div', { class: 'form-actions' },
        h('button', { class: 'btn', onclick: () => { step = 1; render(); } }, 'ย้อนกลับ'),
        h('button', { class: 'btn primary', disabled: !s.total, onclick: () => { step = 3; render(); } }, 'ถัดไป: ยืนยันการนำเข้า')));
  }

  function confirmStep(): HTMLElement {
    const p = preview!;
    const s = p.summary;
    const go = async () => {
      if (!(await confirmDialog('ยืนยันการนำเข้า', `นำเข้า${d.noun} ${fmtNum(s.importable)} แถว จาก Worksheet "${p.sheet_name ?? '-'}" ของไฟล์ ${file!.name} เข้าสู่บริษัท ${p.company.name}? รายการซ้ำและไม่ถูกต้องจะไม่ถูกนำเข้า`, 'ยืนยันนำเข้า'))) return;
      mount(page, stepper(3), h('div', { class: 'card' }, loading()));
      try {
        result = await post<Batch>(d.api, { ...request(true), idempotency_key: key, confirm: true });
        step = 4;
        toast(`นำเข้าแล้ว ${fmtNum(result.imported_count)} รายการ`);
        render();
      } catch (e) {
        mount(page, stepper(3), errorBox(e), h('div', { class: 'form-actions' }, h('button', { class: 'btn', onclick: () => render() }, 'ย้อนกลับ')));
      }
    };
    return h('section', { class: 'card wizard-step' },
      h('h2', { tabindex: '-1' }, '4. ยืนยันการนำเข้า'),
      sheetBadge(p.sheet_name, p.template),
      h('dl', { class: 'dl' },
        h('dt', null, 'ประเภทข้อมูล'), h('dd', null, IMPORT_TYPE_LABEL[d.type]),
        h('dt', null, 'บริษัท'), h('dd', null, p.company.name),
        h('dt', null, 'ไฟล์'), h('dd', null, `${file!.name} (${fmtSize(file!.size)})`),
        h('dt', null, 'Worksheet'), h('dd', null, p.sheet_name ?? '-')),
      h('div', { class: 'kpis' }, kpi('จำนวนทั้งหมด', s.total), kpi('จำนวนผ่าน', s.valid + s.warning), kpi('จำนวนซ้ำ', s.duplicate, s.duplicate ? 'kpi-warn' : ''), kpi('จำนวนผิดพลาด', s.invalid, s.invalid ? 'kpi-bad' : ''), kpi('จำนวนที่จะนำเข้า', s.importable)),
      approvalKpis(s.approval),
      h('p', { class: 'muted' }, d.type === 'leave'
        ? 'สถานะการอนุมัติเก็บตามไฟล์ (รออนุมัติยังคงเป็นรออนุมัติ) ข้อมูลต้นฉบับทุกแถวถูกเก็บไว้ตรวจสอบย้อนหลัง ไม่สร้างใบลา ไม่แก้ไขบันทึกเวลาทำงาน และไม่กระทบเงินเดือน'
        : 'สถานะการอนุมัติเก็บตามไฟล์ ข้อมูลต้นฉบับทุกแถวถูกเก็บไว้ตรวจสอบย้อนหลัง ไม่คำนวณค่า OT ไม่สร้างคำขอ OT และไม่สร้างรายการเงินเดือน'),
      h('div', { class: 'form-actions' },
        h('button', { class: 'btn', onclick: () => { step = 2; render(); } }, 'ย้อนกลับ'),
        can(d.importPerm) ? h('button', { class: 'btn primary', disabled: !s.importable, onclick: () => void go() }, `ยืนยันนำเข้า ${fmtNum(s.importable)} รายการ`) : null));
  }

  function resultStep(): HTMLElement {
    const b = result!;
    return h('section', { class: 'card wizard-step' },
      h('h2', { tabindex: '-1' }, '5. ผลการนำเข้า'),
      h('div', { class: 'alert', role: 'status' }, `${BATCH_STATUS[b.status]} · Import #${b.id}${b.repeated ? ' (ยืนยันซ้ำ แสดงผลการนำเข้าเดิม)' : ''}`),
      sheetBadge(b.sheet_name, b.template_code),
      h('div', { class: 'kpis' }, kpi('สำเร็จ', b.imported_count), kpi('ซ้ำ', b.duplicate_count, b.duplicate_count ? 'kpi-warn' : ''), kpi('ผิดพลาด', b.invalid_count, b.invalid_count ? 'kpi-bad' : ''), kpi('มีคำเตือน', b.warning_count)),
      h('dl', { class: 'dl' },
        h('dt', null, 'วันที่และเวลานำเข้า'), h('dd', null, fmtDate(b.created_at)),
        h('dt', null, 'ผู้ดำเนินการ'), h('dd', null, b.created_by_name ?? '-'),
        h('dt', null, 'ไฟล์ต้นทาง'), h('dd', null, b.file_name),
        h('dt', null, 'บริษัท'), h('dd', null, b.company)),
      h('div', { class: 'form-actions' }, reportLinks(b.id, d.api), link(`${d.historyPath}?id=${b.id}`, 'ดูรายละเอียด', { class: 'btn' }),
        h('button', { class: 'btn primary', onclick: () => void renderImport(main, d) }, 'นำเข้าไฟล์ใหม่')));
  }

  render();
}

async function renderHistory(main: HTMLElement, params: URLSearchParams, d: Domain): Promise<void> {
  mount(main, loading());
  try {
    const id = params.get('id');
    if (id) return await renderBatch(main, d, Number(id));
    const rows = await get<Batch[]>(`${d.api}${qs({ company: state.companyId })}`);
    mount(main, h('div', { class: 'stack' },
      h('p', { class: 'muted lead' }, `ประวัติการนำเข้า${d.noun}จาก Feishu (${REQUEST_TEMPLATES[d.type]}) เฉพาะประเภทนี้`),
      h('div', { class: 'toolbar' }, h('div', { class: 'spacer' }), can(d.importPerm) ? link(d.importPath, `+ นำเข้า${d.noun}`, { class: 'btn primary' }) : null),
      rows.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'table import-history' },
            h('thead', null, h('tr', null, ['Import ID', 'ไฟล์', 'Worksheet', 'บริษัท', 'ผู้นำเข้า', 'วันที่นำเข้า', 'ทั้งหมด', 'สำเร็จ', 'ซ้ำ', 'ผิดพลาด', 'สถานะ', 'Report'].map((t) => h('th', null, t)))),
            h('tbody', null, rows.map((b) => h('tr', null,
              h('td', null, link(`${d.historyPath}?id=${b.id}`, `#${b.id}`)), h('td', { class: 'truncate' }, b.file_name), h('td', null, b.sheet_name ?? '-'), h('td', null, b.company), h('td', null, b.created_by_name ?? '-'),
              h('td', null, fmtDate(b.created_at)), h('td', null, fmtNum(b.total_rows)), h('td', null, fmtNum(b.imported_count)), h('td', null, fmtNum(b.duplicate_count)), h('td', null, fmtNum(b.invalid_count)),
              h('td', null, h('span', { class: `badge-status s-${b.status === 'failed' ? 'error' : b.status}` }, BATCH_STATUS[b.status])), h('td', null, reportLinks(b.id, d.api)))))))
        : h('div', { class: 'card' }, h('div', { class: 'empty' }, `ยังไม่มีประวัติการนำเข้า${d.noun}`)),
    ));
  } catch (e) {
    mount(main, errorBox(e));
  }
}

async function renderBatch(main: HTMLElement, d: Domain, id: number): Promise<void> {
  const b = await get<Batch & { rows: Row[] }>(`${d.api}/${id}`);
  mount(main, h('div', { class: 'stack' },
    h('div', { class: 'toolbar' }, link(d.historyPath, '‹ ประวัติการนำเข้า', { class: 'btn' }), h('div', { class: 'spacer' }), reportLinks(b.id, d.api)),
    h('div', { class: 'card' },
      h('h2', null, `Import #${b.id} · ${b.file_name}`),
      sheetBadge(b.sheet_name, b.template_code),
      h('dl', { class: 'dl' }, h('dt', null, 'ประเภทข้อมูล'), h('dd', null, IMPORT_TYPE_LABEL[d.type]), h('dt', null, 'บริษัท'), h('dd', null, b.company), h('dt', null, 'ผู้นำเข้า'), h('dd', null, b.created_by_name ?? '-'),
        h('dt', null, 'วันที่นำเข้า'), h('dd', null, fmtDate(b.created_at)), h('dt', null, 'สถานะ'), h('dd', null, BATCH_STATUS[b.status])),
      h('div', { class: 'kpis' }, kpi('ทั้งหมด', b.total_rows), kpi('สำเร็จ', b.imported_count), kpi('ซ้ำ', b.duplicate_count, b.duplicate_count ? 'kpi-warn' : ''), kpi('ผิดพลาด', b.invalid_count, b.invalid_count ? 'kpi-bad' : ''))),
    h('div', { class: 'table-wrap table-scroll' }, rowTable(d, b.rows))));
}

export const renderLeaveImport = (main: HTMLElement): Promise<void> => renderImport(main, DOMAINS.leave);
export const renderLeaveImportHistory = (main: HTMLElement, params: URLSearchParams): Promise<void> => renderHistory(main, params, DOMAINS.leave);
export const renderOvertimeImport = (main: HTMLElement): Promise<void> => renderImport(main, DOMAINS.overtime);
export const renderOvertimeImportHistory = (main: HTMLElement, params: URLSearchParams): Promise<void> => renderHistory(main, params, DOMAINS.overtime);
