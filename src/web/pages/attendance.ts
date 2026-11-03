// Feishu attendance import wizard (upload → company / period → detect → mapping → validation → preview →
// reconciliation → confirm), import history with rollback, and the HR OT review queue.
import type { AttendanceAnalysis, AttendanceImportSummary, CompanyOption, OtReviewRow } from '../../shared/types';
import { ATTENDANCE_FIELDS, findHeaderRow } from '../../shared/feishu';
import { parseCsv, readXlsx, type Cell } from '../../shared/xlsx';
import { get, post, qs } from '../api';
import { h, mount, loading, errorBox, fmtDate, fmtNum, modal, toast, confirmDialog, promptDialog } from '../dom';
import { optionLabel } from '../labels';
import { can, isSuperAdmin, link, state } from '../app';

interface PeriodOption {
  id: number;
  code: string;
  name: string;
  start_date: string;
  end_date: string;
  status: string;
  kind: string;
  company_id: number | null;
}
interface Profile {
  id: number;
  name: string;
  company_id: number | null;
  mapping: Record<string, string>;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function companies(): CompanyOption[] {
  return state.meta?.companies.items ?? [];
}

export function noCompanies(): HTMLElement {
  return h('div', { class: 'card' },
    h('p', null, 'ยังไม่มีข้อมูลบริษัทที่คุณเข้าถึงได้ จึงยังนำเข้าหรือตรวจสอบข้อมูลรายบริษัทไม่ได้'),
    isSuperAdmin() ? link('/setup/companies', 'ไปที่ ตั้งค่า → บริษัท', { class: 'btn primary' }) : h('p', { class: 'muted' }, 'กรุณาติดต่อผู้ดูแลระบบเพื่อเพิ่มบริษัท'));
}

function companySelect(selected: number | null, allowAll: boolean, onChange?: () => void): HTMLSelectElement {
  const list = companies();
  return h('select', { onchange: onChange },
    allowAll && state.meta?.companies.scope === 'all' ? h('option', { value: '' }, 'ทุกบริษัท') : null,
    list.map((c) => h('option', { value: String(c.id), selected: c.id === selected }, `${c.name} (${c.code})`)));
}

function periodSelect(periods: PeriodOption[], selected: string | null, onChange?: () => void): HTMLSelectElement {
  return h('select', { onchange: onChange }, periods.map((p) => h('option', { value: String(p.id), selected: String(p.id) === selected }, `${p.code} · ${p.name} (${fmtDate(p.start_date)} – ${fmtDate(p.end_date)}) · ${optionLabel(p.status)}`)));
}

async function sha256(buf: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Reads an uploaded XLSX / CSV into a cell grid (the first sheet that has an Employee ID header). */
export async function readGridFile(file: File): Promise<{ grid: Cell[][]; sheet: string | null; buf: ArrayBuffer }> {
  const buf = await file.arrayBuffer();
  if (/\.csv$/i.test(file.name)) {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      text = new TextDecoder('windows-874').decode(buf); // Thai Excel "CSV" saved as TIS-620
    }
    return { grid: parseCsv(text), sheet: null, buf };
  }
  if (!/\.xlsx$/i.test(file.name)) throw new Error('รองรับเฉพาะไฟล์ .xlsx และ .csv');
  const sheets = await readXlsx(buf);
  const s = sheets.find((x) => findHeaderRow(x.rows) >= 0) ?? sheets[0];
  if (!s) throw new Error('ไฟล์ไม่มี Sheet');
  return { grid: s.rows, sheet: s.name, buf };
}

const FIELD_COLS: Array<[string, string]> = [
  ['expected_work_days', 'Expected Days'], ['expected_work_hours', 'Expected Hrs'], ['actual_work_days', 'วันทำงาน'], ['actual_work_hours', 'ชม.ทำงาน'],
  ['feishu_overtime_hours', 'OT (ชม.)'], ['absence_days', 'ขาด (วัน)'], ['absence_minutes', 'ขาด (นาที)'], ['unpaid_sick_leave_hours', 'ลาป่วยไม่รับค่าจ้าง (ชม.)'], ['unpaid_personal_leave_hours', 'ลากิจไม่รับค่าจ้าง (ชม.)'],
];

export async function renderAttendanceImport(main: HTMLElement, params: URLSearchParams): Promise<void> {
  mount(main, loading());
  try {
    const list = companies();
    if (!list.length) return mount(main, noCompanies());
    const [periods, profiles, history] = await Promise.all([
      get<PeriodOption[]>('/api/attendance/periods'),
      get<Profile[]>('/api/attendance/profiles'),
      get<AttendanceImportSummary[]>(`/api/attendance/imports${qs({ company: state.companyId })}`),
    ]);
    const canCreate = can('attendance_import.create');
    const forCompany = (id: string) => periods.filter((p) => p.company_id === null || String(p.company_id) === id);
    const company = companySelect(state.companyId ?? list[0]?.id ?? null, false, () => {
      const keep = period.value;
      period.replaceChildren(...periodSelect(forCompany(company.value), keep).children);
    });
    const period = periodSelect(forCompany(company.value), params.get('period_id') ?? (periods[0] ? String(periods[0].id) : null));
    const profile = h('select', null, h('option', { value: '' }, 'ตรวจจับอัตโนมัติ'), profiles.map((p) => h('option', { value: String(p.id) }, p.name)));
    const file = h('input', { type: 'file', accept: '.xlsx,.csv', 'aria-label': 'ไฟล์ Attendance จาก Feishu' });
    const result = h('div', { class: 'stack' });
    let grid: Cell[][] = [];
    let hash = '';
    let fileName = '';
    let mapping: Record<string, number | null> | null = null;

    const analyze = async () => {
      if (!file.files?.[0] && !grid.length) return toast('กรุณาเลือกไฟล์', 'error');
      if (!period.value) return toast('ยังไม่มีงวดเงินเดือน กรุณาให้ฝ่ายเงินเดือนสร้างงวดก่อน', 'error');
      mount(result, loading());
      try {
        if (file.files?.[0] && file.files[0].name !== fileName) {
          const f = file.files[0];
          if (f.size > 15 * 1024 * 1024) throw new Error('ไฟล์ใหญ่เกิน 15 MB');
          const r = await readGridFile(f);
          grid = r.grid;
          hash = await sha256(r.buf);
          fileName = f.name;
          mapping = null;
        }
        const body = { company_id: Number(company.value), period_id: Number(period.value), file_name: fileName, sha256: hash, grid, mapping, profile_id: profile.value || null };
        const a = await post<AttendanceAnalysis>('/api/attendance/imports/analyze', body);
        mapping = a.mapping;
        renderAnalysis(a, body);
      } catch (e) {
        mount(result, errorBox(e));
      }
    };

    const renderAnalysis = (a: AttendanceAnalysis, body: Record<string, unknown>) => {
      const headerOptions = (sel: number | null) => [h('option', { value: '' }, '— ไม่ใช้ —'), a.headers.map((hd, i) => (hd ? h('option', { value: String(i), selected: sel === i }, hd) : null))];
      const selects = new Map<string, HTMLSelectElement>();
      const mapTable = h('table', { class: 'table compact' },
        h('thead', null, h('tr', null, h('th', null, 'ข้อมูลในระบบ HR'), h('th', null, 'คอลัมน์ในไฟล์ Feishu'))),
        h('tbody', null, ATTENDANCE_FIELDS.map((f) => {
          const s = h('select', { 'aria-label': f.label }, headerOptions(a.mapping[f.key] ?? null));
          selects.set(f.key, s);
          return h('tr', null, h('td', null, f.label, f.required ? ' *' : ''), h('td', null, s));
        })));
      const readMapping = () => Object.fromEntries([...selects].map(([k, s]) => [k, s.value === '' ? null : Number(s.value)]));
      const saveProfile = async () => {
        const name = await promptDialog('บันทึก Mapping Profile', 'ชื่อ Profile (เช่น "Feishu For Payroll System")', 'บันทึก');
        if (!name) return;
        const m = readMapping();
        const labels = Object.fromEntries(Object.entries(m).filter(([, v]) => v !== null).map(([k, v]) => [k, a.headers[v as number] as string]));
        try {
          await post('/api/attendance/profiles', { name, company_id: Number(company.value), mapping: labels });
          toast('บันทึก Mapping Profile แล้ว');
        } catch (e) {
          toast(msg(e), 'error');
        }
      };
      const st = a.stats;
      const kpi = (label: string, value: number, cls = '') => h('div', { class: `card kpi ${cls}` }, h('div', { class: 'kpi-label' }, label), h('div', { class: 'kpi-value' }, String(value)));
      const filter = h('select', { 'aria-label': 'กรองรายการ', onchange: () => drawRows() }, h('option', { value: 'all' }, 'ทุกแถว'), h('option', { value: 'error' }, 'เฉพาะที่ผิดพลาด'), h('option', { value: 'warning' }, 'เฉพาะที่มีคำเตือน'));
      const rowsBox = h('div', { class: 'table-wrap' });
      const drawRows = () => {
        const rows = a.rows.filter((r) => filter.value === 'all' || r.issues.some((i) => i.level === filter.value)).slice(0, 500);
        mount(rowsBox, rows.length
          ? h('table', { class: 'table compact' },
              h('thead', null, h('tr', null, h('th', null, 'แถว'), h('th', null, 'Employee ID'), h('th', null, 'ชื่อ'), FIELD_COLS.map(([, l]) => h('th', { class: 'num' }, l)), h('th', null, 'ผลตรวจสอบ'))),
              h('tbody', null, rows.map((r) => h('tr', { class: r.included ? '' : 'row-error' },
                h('td', null, String(r.rowNo)), h('td', null, r.employee_code ?? '-'), h('td', null, r.employee_name ?? '-'),
                FIELD_COLS.map(([k]) => h('td', { class: 'num' }, fmtNum(r.values[k]))),
                h('td', null, r.issues.length ? h('ul', { class: 'issues' }, r.issues.map((i) => h('li', { class: `issue-${i.level}` }, i.message))) : h('span', { class: 'ok-text' }, '✓ ถูกต้อง'))))))
          : h('div', { class: 'empty' }, 'ไม่มีแถวตามเงื่อนไข'));
      };
      drawRows();
      const rec = a.reconciliation;
      const skip = h('input', { type: 'checkbox' });
      const doImport = async () => {
        if (st.errors && !skip.checked) return toast('มีรายการผิดพลาด ต้องเลือก "นำเข้าเฉพาะรายการที่ถูกต้อง" ก่อน', 'error');
        if (!(await confirmDialog('ยืนยันนำเข้า', `นำเข้า ${st.importable} รายการ เป็นเวอร์ชัน ${a.nextVersion}${rec.previous ? ` (แทนที่เวอร์ชัน ${rec.previous.version})` : ''}?`, 'ยืนยันนำเข้า'))) return;
        try {
          const r = await post<{ version: number; imported: number; excluded: number; otPending: number }>('/api/attendance/imports', { ...body, mapping: readMapping(), skip_invalid: skip.checked });
          toast(`นำเข้าเวอร์ชัน ${r.version} แล้ว: ${r.imported} รายการ${r.otPending ? ` · OT รอตรวจสอบ ${r.otPending}` : ''}`);
          grid = [];
          fileName = '';
          void renderAttendanceImport(main, new URLSearchParams({ period_id: period.value }));
        } catch (e) {
          toast(msg(e), 'error');
        }
      };
      mount(result,
        h('section', { class: 'card' }, h('h3', null, '③ ตรวจจับรูปแบบไฟล์'),
          h('dl', { class: 'dl' },
            h('dt', null, 'ไฟล์'), h('dd', null, a.fileName),
            h('dt', null, 'รูปแบบ'), h('dd', null, a.format ? `Format ${a.format === 'days' ? 'A' : 'B'} · ${optionLabel(a.format)}` : 'ไม่สามารถระบุได้'),
            h('dt', null, 'ลักษณะรายงาน'), h('dd', null, optionLabel(a.layout)),
            h('dt', null, 'ช่วงวันที่ในไฟล์'), h('dd', null, a.sourceStart ? `${fmtDate(a.sourceStart)} – ${fmtDate(a.sourceEnd)}` : '-'),
            h('dt', null, 'แถวหัวตาราง'), h('dd', null, a.headerRow >= 0 ? `แถวที่ ${a.headerRow + 1}` : '-')),
          a.fileIssues.map((i) => h('div', { class: `alert ${i.level === 'error' ? 'alert-error' : ''}`, role: i.level === 'error' ? 'alert' : null }, i.message))),
        h('section', { class: 'card' }, h('h3', null, '④ Column Mapping'),
          h('p', { class: 'muted' }, 'ระบบจับคู่ตามชื่อคอลัมน์ของรายงาน Feishu ให้อัตโนมัติ ปรับได้ถ้าไฟล์ใช้ชื่อคอลัมน์ต่างออกไป'),
          h('div', { class: 'table-wrap' }, mapTable),
          h('div', { class: 'toolbar' },
            h('button', { class: 'btn', onclick: () => { mapping = readMapping(); void analyze(); } }, 'ตรวจสอบใหม่ตาม Mapping นี้'),
            canCreate ? h('button', { class: 'btn', onclick: () => void saveProfile() }, 'บันทึกเป็น Mapping Profile') : null)),
        h('section', null, h('h3', null, '⑤ ผลการตรวจสอบข้อมูล'),
          h('div', { class: 'kpis' },
            kpi('รายการทั้งหมด', st.total), kpi('จับคู่พนักงานได้', st.matched), kpi('Employee ID ไม่พบ', st.unknown, st.unknown ? 'kpi-bad' : ''),
            kpi('บริษัทไม่ตรงกัน', st.wrongCompany, st.wrongCompany ? 'kpi-bad' : ''), kpi('ข้อมูลซ้ำ', st.duplicates, st.duplicates ? 'kpi-bad' : ''),
            kpi('วันที่ผิดรูปแบบ', st.invalidDates, st.invalidDates ? 'kpi-bad' : ''), kpi('ตัวเลขผิดรูปแบบ', st.invalidNumbers, st.invalidNumbers ? 'kpi-bad' : ''),
            kpi('OT รอยืนยัน', st.otPending, st.otPending ? 'kpi-warn' : ''), kpi('การลาผิดปกติ', st.leaveAbnormal, st.leaveAbnormal ? 'kpi-warn' : ''), kpi('นำเข้าได้', st.importable))),
        h('section', null, h('div', { class: 'toolbar' }, h('h3', null, '⑥ Preview'), h('div', { class: 'spacer' }), filter), rowsBox, a.rows.length > 500 ? h('p', { class: 'muted' }, `แสดง 500 จาก ${a.rows.length} แถว`) : null),
        h('section', { class: 'card' }, h('h3', null, '⑦ Reconciliation'),
          h('dl', { class: 'dl' },
            h('dt', null, 'พนักงานปัจจุบันของบริษัท'), h('dd', null, String(rec.activeEmployees)),
            h('dt', null, 'พบในไฟล์'), h('dd', null, String(rec.inFile)),
            h('dt', null, 'ไม่มีในไฟล์'), h('dd', null, String(rec.missingInFile.length))),
          rec.missingInFile.length ? h('details', null, h('summary', null, 'รายชื่อพนักงานที่ไม่มีในไฟล์'), h('ul', null, rec.missingInFile.map((m) => h('li', null, `${m.emp_code} ${m.name}`)))) : null,
          h('div', { class: 'table-wrap' }, h('table', { class: 'table compact' },
            h('thead', null, h('tr', null, h('th', null, 'ยอดรวม'), h('th', { class: 'num' }, 'ไฟล์นี้'), h('th', { class: 'num' }, rec.previous ? `เวอร์ชัน ${rec.previous.version} (ปัจจุบัน)` : 'เวอร์ชันก่อนหน้า'))),
            h('tbody', null, FIELD_COLS.map(([k, l]) => h('tr', null, h('td', null, l), h('td', { class: 'num' }, fmtNum(rec.totals[k])), h('td', { class: 'num' }, rec.previous ? fmtNum(rec.previous.totals[k]) : '-'))))))),
        h('section', { class: 'card' }, h('h3', null, '⑧ ยืนยันการนำเข้า'),
          a.locked ? h('div', { class: 'alert alert-error' }, 'งวดนี้ถูกล็อกเพราะนำข้อมูลไปคำนวณเงินเดือนแล้ว') : null,
          st.errors ? h('label', { class: 'check' }, skip, ` นำเข้าเฉพาะรายการที่ถูกต้อง (ข้าม ${st.errors} แถวที่ผิดพลาด — ไม่ถูกนำเข้า Payroll)`) : null,
          h('p', { class: 'muted' }, 'OT ที่นำเข้าจะมีสถานะ "รอตรวจสอบ" และยังไม่ถูกนำไปคำนวณเงินเดือนจนกว่า HR จะยืนยัน'),
          canCreate ? h('button', { class: 'btn primary', disabled: !a.canImport, onclick: () => void doImport() }, `ยืนยันนำเข้า (เวอร์ชัน ${a.nextVersion})`) : h('p', { class: 'muted' }, 'บทบาทของคุณดูได้อย่างเดียว')),
      );
    };

    const rollback = async (imp: AttendanceImportSummary) => {
      const reason = await promptDialog(`ย้อนกลับเวอร์ชัน ${imp.version}`, 'เหตุผลการย้อนกลับ (บังคับ)', 'ย้อนกลับ');
      if (!reason) return;
      try {
        const r = await post<{ restoredVersion: number | null }>(`/api/attendance/imports/${imp.id}/rollback`, { reason });
        toast(r.restoredVersion ? `ย้อนกลับแล้ว ใช้เวอร์ชัน ${r.restoredVersion} แทน` : 'ย้อนกลับแล้ว');
        void renderAttendanceImport(main, params);
      } catch (e) {
        toast(msg(e), 'error');
      }
    };
    const viewRows = async (imp: AttendanceImportSummary) => {
      try {
        const d = await get<{ rows: Array<Record<string, unknown> & { issues: Array<{ level: string; message: string }> }> }>(`/api/attendance/imports/${imp.id}`);
        modal(`${imp.file_name} · เวอร์ชัน ${imp.version}`, h('div', { class: 'table-wrap' }, h('table', { class: 'table compact' },
          h('thead', null, h('tr', null, h('th', null, 'Employee ID'), h('th', null, 'ชื่อ'), FIELD_COLS.map(([, l]) => h('th', { class: 'num' }, l)), h('th', null, 'สถานะ OT'), h('th', null, 'นำเข้า'))),
          h('tbody', null, d.rows.map((r) => h('tr', null, h('td', null, String(r.employee_code)), h('td', null, String(r.employee_name ?? '-')),
            FIELD_COLS.map(([k]) => h('td', { class: 'num' }, fmtNum(r[k]))), h('td', null, optionLabel(r.ot_status as string)),
            h('td', null, r.included ? '✓' : h('span', { class: 'issue-error', title: r.issues.map((i) => i.message).join(', ') }, 'ข้าม'))))))));
      } catch (e) {
        toast(msg(e), 'error');
      }
    };

    mount(main,
      h('p', { class: 'muted lead' }, 'นำเข้ารายงาน Attendance จาก Feishu (รองรับ Expected Working Days และ Expected Working Hours, ไฟล์ .xlsx / .csv) ข้อมูลที่ผิดพลาดจะไม่ถูกนำเข้า Payroll และ OT ต้องผ่านการยืนยันของ HR ก่อนเสมอ'),
      canCreate
        ? h('section', { class: 'card' }, h('h3', null, '① อัปโหลดไฟล์ · ② เลือกบริษัทและงวด'),
            h('div', { class: 'grid-form' },
              h('label', { class: 'field' }, h('span', null, 'บริษัท *'), company),
              h('label', { class: 'field' }, h('span', null, 'งวด (Attendance Period) *'), period),
              h('label', { class: 'field' }, h('span', null, 'Mapping Profile'), profile),
              h('label', { class: 'field' }, h('span', null, 'ไฟล์ *'), file)),
            periods.length ? null : h('div', { class: 'alert' }, 'ยังไม่มีงวดเงินเดือน ต้องสร้างงวดในเมนู "งวดเงินเดือน" ก่อน'),
            h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', onclick: () => { mapping = null; void analyze(); } }, 'วิเคราะห์ไฟล์')))
        : null,
      result,
      h('section', null, h('h3', null, '⑨ ประวัติการนำเข้า (Import History)'),
        history.length
          ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
              h('thead', null, h('tr', null, ['วันที่', 'บริษัท', 'งวด', 'เวอร์ชัน', 'ไฟล์', 'รูปแบบ', 'นำเข้า/ข้าม', 'OT รอตรวจ', 'สถานะ', 'โดย', ''].map((t) => h('th', null, t)))),
              h('tbody', null, history.map((i) => h('tr', null,
                h('td', null, fmtDate(i.created_at)), h('td', null, i.company), h('td', null, i.period), h('td', null, `v${i.version}`), h('td', { class: 'truncate' }, i.file_name),
                h('td', null, i.format === 'days' ? 'A · Days' : 'B · Hours'), h('td', null, `${i.imported_count} / ${i.excluded_count}`), h('td', null, String(i.ot_pending)),
                h('td', null, h('span', { class: `badge-status s-${i.status}` }, optionLabel(i.status)), i.locked ? ' 🔒' : '', i.rollback_reason ? h('div', { class: 'muted small' }, i.rollback_reason) : null),
                h('td', null, i.created_by_name ?? '-'),
                h('td', { class: 'actions' },
                  h('button', { class: 'btn small', onclick: () => void viewRows(i) }, 'ดูข้อมูล'),
                  i.ot_pending && can('ot_review.view') ? link(`/attendance/ot-review?period_id=${i.payroll_period_id}`, 'ตรวจ OT', { class: 'btn small' }) : null,
                  i.status === 'active' && !i.locked && can('attendance_import.update') ? h('button', { class: 'btn small danger', onclick: () => void rollback(i) }, 'ย้อนกลับ') : null))))))
          : h('div', { class: 'empty' }, 'ยังไม่มีการนำเข้า')),
    );
  } catch (e) {
    mount(main, errorBox(e));
  }
}

export async function renderOtReview(main: HTMLElement, params: URLSearchParams): Promise<void> {
  mount(main, loading());
  try {
    if (!companies().length) return mount(main, noCompanies());
    const periods = await get<PeriodOption[]>('/api/attendance/periods');
    const status = params.get('status') ?? 'pending';
    const pid = params.get('period_id') ?? '';
    const rows = await get<OtReviewRow[]>(`/api/attendance/ot${qs({ company: state.companyId, period_id: pid, status })}`);
    const canUpdate = can('ot_review.update');
    const reload = (p: Record<string, string>) => {
      const next = new URLSearchParams({ status, period_id: pid, ...p });
      history.replaceState(null, '', `?${next}`);
      void renderOtReview(main, next);
    };
    const statusSel = h('select', { 'aria-label': 'สถานะ', onchange: () => reload({ status: statusSel.value }) },
      ['pending', 'confirmed', 'revised', 'rejected', ''].map((s) => h('option', { value: s, selected: s === status }, s ? optionLabel(s) : 'ทุกสถานะ')));
    const periodSel = h('select', { 'aria-label': 'งวด', onchange: () => reload({ period_id: periodSel.value }) },
      h('option', { value: '' }, 'ทุกงวด'), periods.map((p) => h('option', { value: String(p.id), selected: String(p.id) === pid }, `${p.code} · ${p.name}`)));

    const act = async (r: OtReviewRow, action: 'confirm' | 'revise' | 'reject') => {
      const rate = h('select', null, ['1', '1.5', '2', '3'].map((v) => h('option', { value: v, selected: Number(v) === (r.ot_rate ?? 1.5) }, `${v} เท่า`)));
      const hours = h('input', { type: 'number', min: 0, max: 400, step: 0.25, value: String(r.ot_confirmed_hours ?? r.feishu_overtime_hours ?? 0) });
      const reason = h('textarea', { rows: 2, maxlength: 500 });
      const err = h('div', { class: 'form-msg', role: 'alert' });
      const title = action === 'confirm' ? 'ยืนยัน OT' : action === 'revise' ? 'ปรับชั่วโมง OT' : 'ปฏิเสธ OT';
      const dlg = modal(`${title} · ${r.employee_code} ${r.employee_name ?? ''}`, h('div', { class: 'grid-form' },
        h('p', { class: 'span2' }, `ชั่วโมง OT จาก Feishu (ค่าเดิม): ${fmtNum(r.feishu_overtime_hours)} ชม.`),
        action === 'revise' ? h('label', { class: 'field' }, h('span', null, 'ชั่วโมงที่ยืนยัน *'), hours) : null,
        action !== 'reject' ? h('label', { class: 'field' }, h('span', null, 'อัตรา OT'), rate) : null,
        h('label', { class: 'field span2' }, h('span', null, action === 'confirm' ? 'หมายเหตุ' : 'เหตุผล *'), reason), err), [
        h('button', { class: 'btn', onclick: () => dlg.close() }, 'ยกเลิก'),
        h('button', { class: `btn ${action === 'reject' ? 'danger' : 'primary'}`, onclick: async () => {
          try {
            await post(`/api/attendance/ot/${r.id}`, { action, hours: action === 'revise' ? Number(hours.value) : undefined, rate: action === 'reject' ? undefined : Number(rate.value), reason: reason.value.trim() || undefined });
            dlg.close();
            toast(`${title}แล้ว`);
            reload({});
          } catch (e) {
            err.textContent = msg(e);
          }
        } }, title),
      ]);
    };
    const imports = [...new Map(rows.filter((r) => r.ot_status === 'pending' && !r.locked).map((r) => [r.import_id, r])).values()];
    const confirmAll = async (r: OtReviewRow) => {
      if (!(await confirmDialog('ยืนยัน OT ทั้งหมด', `ยืนยัน OT ที่รอตรวจสอบทั้งหมดของ ${r.company} งวด ${r.period} (เวอร์ชัน ${r.version}) ตามชั่วโมงจาก Feishu ที่อัตรา 1.5 เท่า?`, 'ยืนยันทั้งหมด'))) return;
      try {
        const res = await post<{ confirmed: number }>('/api/attendance/ot/confirm-all', { import_id: r.import_id });
        toast(`ยืนยันแล้ว ${res.confirmed} รายการ`);
        reload({});
      } catch (e) {
        toast(msg(e), 'error');
      }
    };
    mount(main,
      h('p', { class: 'muted lead' }, 'Feishu Import → รอตรวจสอบ → HR ตรวจสอบ → HR ยืนยัน → เข้า Payroll ได้ (OT ที่ยังไม่ยืนยันจะไม่ถูกนำไปคำนวณ) ค่าเดิมจาก Feishu ถูกเก็บไว้เสมอ'),
      h('div', { class: 'toolbar' }, h('label', { class: 'field inline' }, h('span', null, 'งวด'), periodSel), h('label', { class: 'field inline' }, h('span', null, 'สถานะ'), statusSel), h('div', { class: 'spacer' }),
        canUpdate ? imports.map((r) => h('button', { class: 'btn', onclick: () => void confirmAll(r) }, `ยืนยันทั้งหมด · ${r.company} ${r.period}`)) : null),
      rows.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
            h('thead', null, h('tr', null, ['บริษัท / งวด', 'พนักงาน', 'OT จาก Feishu (ชม.)', 'ชั่วโมงที่ยืนยัน', 'อัตรา', 'สถานะ', 'เหตุผล', 'ผู้ตรวจสอบ', ''].map((t) => h('th', null, t)))),
            h('tbody', null, rows.map((r) => h('tr', null,
              h('td', null, `${r.company} · ${r.period} (v${r.version})`), h('td', null, `${r.employee_code} ${r.employee_name ?? ''}`),
              h('td', { class: 'num' }, fmtNum(r.feishu_overtime_hours)), h('td', { class: 'num' }, fmtNum(r.ot_confirmed_hours)), h('td', null, r.ot_rate ? `${r.ot_rate} เท่า` : '-'),
              h('td', null, h('span', { class: `badge-status s-${r.ot_status}` }, optionLabel(r.ot_status)), r.locked ? ' 🔒' : ''),
              h('td', null, r.ot_reason ?? '-'), h('td', null, r.reviewer ? `${r.reviewer} · ${fmtDate(r.ot_reviewed_at)}` : '-'),
              h('td', { class: 'actions' }, canUpdate && !r.locked
                ? [h('button', { class: 'btn small primary', onclick: () => void act(r, 'confirm') }, 'ยืนยัน'), h('button', { class: 'btn small', onclick: () => void act(r, 'revise') }, 'ปรับชั่วโมง'), h('button', { class: 'btn small danger', onclick: () => void act(r, 'reject') }, 'ปฏิเสธ')]
                : null))))))
        : h('div', { class: 'empty' }, status === 'pending' ? 'ไม่มี OT ที่รอตรวจสอบ' : 'ไม่มีรายการ'),
    );
  } catch (e) {
    mount(main, errorBox(e));
  }
}

