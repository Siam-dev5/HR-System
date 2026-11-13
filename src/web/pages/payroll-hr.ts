// HR operational screens for payroll (P4–P6): the employee list of a period (selection, eligibility, warnings, take
// out / add with per-employee results, HR confirmation of review cases, history), contract periods of contract
// employees, and pay frequency. Every figure and status comes from the API; nothing here computes pay or eligibility,
// and every action is checked again by the server (permission, company scope, period lock).
import type { PayrollPeriod, PayrollPreviewResponse } from '../../shared/types';
import { ApiFailure, get, post, put, qs } from '../api';
import { h, mount, loading, errorBox, fmtDate, modal, toast } from '../dom';
import { optionLabel } from '../labels';
import { can, state } from '../app';

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const DECISION: Record<string, { label: string; cls: string }> = {
  pay: { label: 'มีสิทธิ์', cls: 'elig-pay' },
  review: { label: 'รอ HR ตรวจสอบ', cls: 'elig-review' },
  block: { label: 'ไม่มีสิทธิ์/ระงับ', cls: 'elig-block' },
};
const ORIGIN: Record<string, string> = { standard: 'รายชื่อปกติ', added: 'เพิ่มโดย HR', deselected: 'นำออกแล้ว', outside: 'นอกรายชื่อ' };
const FREQ: Record<string, string> = { monthly: 'รายเดือน', semi_monthly: 'ครึ่งเดือน (มีรอบกลางเดือน)' };
const freqLabel = (v: string | null | undefined) => (v ? (FREQ[v] ?? v) : 'ไม่กำหนด (ตามเดิม)');
const RESULT: Record<string, string> = { selected: 'เพิ่มแล้ว', deselected: 'นำออกแล้ว', unchanged: 'ไม่เปลี่ยนแปลง', not_found: 'ไม่พบ (นอกสิทธิ์บริษัท)', cross_company: 'คนละบริษัทกับงวด' };

/** A reason dialog with a guarded submit (one request at a time) and an error line; resolves after success. */
function reasonDialog(title: string, intro: string, confirmLabel: string, submit: (reason: string) => Promise<HTMLElement | null>, opts: { required?: boolean; danger?: boolean; fields?: HTMLElement } = {}): void {
  const required = opts.required ?? true;
  const reason = h('textarea', { rows: 3, maxlength: 500, 'aria-label': 'เหตุผล', placeholder: required ? 'เหตุผล (อย่างน้อย 5 ตัวอักษร)' : 'เหตุผล (ถ้ามี)' }) as HTMLTextAreaElement;
  const err = h('div', { class: 'form-msg', role: 'alert' });
  const out = h('div');
  let busy = false;
  let done = false;
  const btn = h('button', { class: `btn ${opts.danger ? 'danger' : 'primary'}`, type: 'button', onclick: async () => {
    if (busy || done) return;
    const r = reason.value.trim();
    if (required && r.length < 5) {
      err.textContent = 'กรุณาระบุเหตุผลอย่างน้อย 5 ตัวอักษร';
      return;
    }
    busy = true;
    btn.disabled = true;
    btn.textContent = 'กำลังบันทึก…';
    err.textContent = '';
    try {
      const result = await submit(r);
      done = true;
      btn.textContent = 'เสร็จแล้ว';
      if (result) out.replaceChildren(result);
      else dlg.close();
    } catch (e) {
      err.textContent = msg(e);
      busy = false;
      btn.disabled = false;
      btn.textContent = confirmLabel;
    }
  } }, confirmLabel) as HTMLButtonElement;
  const dlg = modal(title, h('div', { class: 'stack' }, h('p', { class: 'muted' }, intro), opts.fields ?? null, reason, err, out), [h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'ปิด'), btn]);
}

function resultList(results: Array<{ employee_id: number; result: string }>, codeOf: (id: number) => string): HTMLElement {
  return h('ul', { class: 'result-list' }, results.map((x) => h('li', { class: `res-${x.result}` }, `${codeOf(x.employee_id)}: ${RESULT[x.result] ?? x.result}`)));
}

interface SelRow {
  employee_id: number;
  emp_code: string;
  name: string | null;
  company_id: number;
  origin: string;
  employment_type: string | null;
  pay_frequency: string | null;
  eligibility: string;
  decision: 'pay' | 'review' | 'block';
  labels: string[];
  notes: string[];
  note_labels: string[];
  paid_from: string | null;
  paid_to: string | null;
  confirmed: boolean;
  payable: boolean;
  selection_reason: string | null;
  review_reason: string | null;
}
interface SelResponse {
  period: { id: number; code: string; status: string; company_id: number | null; start_date: string; end_date: string };
  version: { version: number; calculated_version: number | null };
  summary: Record<string, number>;
  selected: SelRow[];
  deselected: SelRow[];
}

const picked = new Map<string, Set<number>>();

// ---- Employee list of a period ------------------------------------------------------------------------------------

export async function renderPayrollSelection(main: HTMLElement, params: URLSearchParams): Promise<void> {
  mount(main, loading());
  try {
    const periods = await get<PayrollPeriod[]>('/api/payroll/periods');
    if (!periods.length) return mount(main, h('div', { class: 'empty' }, 'ยังไม่มีงวดเงินเดือน'));
    const pid = params.get('period_id') ?? String(periods[0]!.id);
    const reload = () => void renderPayrollSelection(main, new URLSearchParams({ period_id: pid, ...(params.get('company') ? { company: params.get('company')! } : {}) }));
    let d: SelResponse;
    try {
      d = await get<SelResponse>(`/api/payroll-selection/periods/${pid}`);
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 404) return mount(main, h('div', { class: 'alert alert-error' }, 'ไม่พบงวดนี้ หรือระบบนี้ยังไม่เปิดใช้การเลือกพนักงานรายงวด'));
      throw e;
    }
    // the period's warnings (holds, attendance version, company, selection) come from the Preview checks
    let issues: PayrollPreviewResponse['issues'] = [];
    if (can('payroll_preview.view')) {
      try {
        issues = (await get<PayrollPreviewResponse>(`/api/payroll/periods/${pid}/preview`)).issues;
      } catch {
        issues = [];
      }
    }
    const companies = state.meta?.companies.items ?? [];
    const companyName = new Map(companies.map((c) => [c.id, c.name]));
    let companyFilter = params.get('company') ?? '';
    let query = '';
    let decision: '' | 'pay' | 'review' | 'block' = '';
    let showOut = false;
    const set = picked.get(pid) ?? new Set<number>();
    picked.set(pid, set);
    const all = [...d.selected, ...d.deselected];
    const codeOf = (id: number) => all.find((x) => x.employee_id === id)?.emp_code ?? `#${id}`;
    const open = d.period.status === 'draft' || d.period.status === 'calculated';
    const canManage = can('payroll_selection.manage') && open;
    const canOverride = can('payroll_selection.override') && open;

    const periodSel = h('select', { 'aria-label': 'งวด', onchange: () => void renderPayrollSelection(main, new URLSearchParams({ period_id: periodSel.value })) },
      periods.map((p) => h('option', { value: String(p.id), selected: String(p.id) === pid }, `${p.code} · ${p.name} · ${optionLabel(p.kind)} · ${optionLabel(p.status)}`)));
    const companySel = h('select', { 'aria-label': 'บริษัท', onchange: () => { companyFilter = companySel.value; paint(); } },
      h('option', { value: '' }, 'ทุกบริษัทในสิทธิ์'), companies.map((c) => h('option', { value: String(c.id), selected: String(c.id) === companyFilter }, c.name)));
    const search = h('input', { type: 'search', class: 'pick-search', placeholder: 'ค้นหารหัสหรือชื่อพนักงาน', 'aria-label': 'ค้นหาพนักงาน', oninput: (e: Event) => { query = (e.target as HTMLInputElement).value; paint(); } });
    const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'กรองตามสิทธิ์' });
    const outToggle = h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (e: Event) => { showOut = (e.target as HTMLInputElement).checked; paint(); } }), ' แสดงพนักงานที่นำออกแล้ว');
    const headCheck = h('input', { type: 'checkbox', class: 'pick-all', 'aria-label': 'เลือกทั้งหมดที่แสดงอยู่' }) as HTMLInputElement;
    const count = h('span', { class: 'pick-count', 'aria-live': 'polite' });
    const tbody = h('tbody');
    const clearBtn = h('button', { class: 'btn', type: 'button', onclick: () => { set.clear(); paint(); } }, 'ล้างการเลือก') as HTMLButtonElement;
    const outBtn = canManage ? (h('button', { class: 'btn danger', type: 'button', onclick: () => takeOut() }, 'นำออกจากงวด') as HTMLButtonElement) : null;
    const addBtn = canManage ? h('button', { class: 'btn primary', type: 'button', onclick: () => void addDialog() }, '+ เพิ่มพนักงานเข้างวด') : null;

    const shown = () => {
      const q = query.trim().toLowerCase();
      return (showOut ? all : d.selected).filter((r) => (!companyFilter || String(r.company_id) === companyFilter) && (!decision || r.decision === decision) && (!q || `${r.emp_code} ${r.name ?? ''}`.toLowerCase().includes(q)));
    };

    const paint = () => {
      const rows = shown();
      const ids = rows.map((r) => r.employee_id);
      const on = ids.filter((id) => set.has(id)).length;
      headCheck.checked = ids.length > 0 && on === ids.length;
      headCheck.indeterminate = on > 0 && on < ids.length;
      headCheck.disabled = ids.length === 0;
      headCheck.setAttribute('aria-label', `เลือกทั้งหมดที่แสดงอยู่ (${ids.length} คน)`);
      count.textContent = `เลือกแล้ว ${set.size} คน · แสดง ${rows.length} คน`;
      clearBtn.disabled = set.size === 0;
      if (outBtn) {
        outBtn.disabled = set.size === 0;
        outBtn.textContent = `นำออกจากงวด (${set.size})`;
      }
      chips.replaceChildren(...(['', 'pay', 'review', 'block'] as const).map((k) => h('button', {
        type: 'button', class: `chip${decision === k ? ' active' : ''}`, 'aria-pressed': String(decision === k),
        onclick: () => { decision = k; paint(); },
      }, `${k ? DECISION[k]!.label : 'ทั้งหมด'} (${(showOut ? all : d.selected).filter((r) => !k || r.decision === k).length})`)));
      tbody.replaceChildren(...(rows.length ? rows.map((r) => {
        const isOn = set.has(r.employee_id);
        const dec = DECISION[r.decision]!;
        return h('tr', { class: isOn ? 'is-picked' : null, 'data-employee-id': String(r.employee_id) },
          h('td', { class: 'fz fz-check' }, h('input', { type: 'checkbox', checked: isOn, 'aria-label': `เลือก ${r.emp_code}`, onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) set.add(r.employee_id); else set.delete(r.employee_id); paint(); } })),
          h('td', { class: 'fz fz-code' }, r.emp_code),
          h('td', { class: 'fz fz-name', title: r.name ?? '' }, r.name ?? '-'),
          h('td', null, companyName.get(r.company_id) ?? `#${r.company_id}`),
          h('td', null, r.employment_type === 'contract' ? h('span', { class: 'badge-status badge-contract' }, 'สัญญาจ้าง') : optionLabel(r.employment_type ?? '-')),
          h('td', null, freqLabel(r.pay_frequency)),
          h('td', null, h('span', { class: `badge-status ${dec.cls}` }, r.confirmed ? 'HR ยืนยันแล้ว' : dec.label)),
          h('td', { class: 'reasons' }, [...r.labels, ...r.note_labels].length ? h('ul', { class: 'plain' }, [...r.labels.map((l) => h('li', null, l)), ...r.note_labels.map((l) => h('li', { class: 'muted' }, `ℹ ${l}`))]) : '-'),
          h('td', null, r.paid_from ? `${fmtDate(r.paid_from)} – ${fmtDate(r.paid_to)}` : '-'),
          h('td', null, ORIGIN[r.origin] ?? r.origin, r.selection_reason ? h('div', { class: 'muted small' }, r.selection_reason) : null),
          h('td', null, r.decision === 'review' && !r.confirmed && canOverride && r.origin !== 'deselected'
            ? h('button', { class: 'btn small', type: 'button', onclick: () => confirm(r) }, 'ยืนยันจ่าย')
            : r.confirmed && r.review_reason ? h('span', { class: 'muted small', title: r.review_reason }, 'ยืนยันแล้ว') : null));
      }) : [h('tr', null, h('td', { class: 'empty-row', colspan: 11 }, d.selected.length ? 'ไม่พบพนักงานที่ตรงกับตัวกรอง' : 'ยังไม่มีพนักงานในงวดนี้'))]));
    };
    headCheck.onchange = () => {
      const ids = shown().map((r) => r.employee_id);
      if (headCheck.checked) ids.forEach((id) => set.add(id));
      else ids.forEach((id) => set.delete(id));
      paint();
    };

    const takeOut = () => {
      const chosen = [...set];
      reasonDialog(`นำพนักงาน ${chosen.length} คนออกจากงวด ${d.period.code}`, 'พนักงานที่นำออกจะไม่ถูกคำนวณในงวดนี้ ถ้างวดคำนวณแล้วต้องคำนวณใหม่ก่อนอนุมัติ', 'ยืนยันนำออก', async (reason) => {
        const r = await post<{ counts: Record<string, number>; results: Array<{ employee_id: number; result: string }> }>(`/api/payroll-selection/periods/${pid}/deselect`, { employee_ids: chosen, reason });
        for (const x of r.results) set.delete(x.employee_id);
        toast(`นำออก ${r.counts.deselected ?? 0} คน`);
        setTimeout(reload, 50);
        return resultList(r.results, codeOf);
      }, { danger: true });
    };

    const confirm = (r: SelRow) => {
      reasonDialog(`ยืนยันจ่าย ${r.emp_code} ในงวด ${d.period.code}`, `เหตุผลที่ต้องตรวจสอบ: ${r.labels.join(' · ')} — การยืนยันใช้กับเหตุผลชุดนี้เท่านั้น ถ้าข้อมูลเปลี่ยนต้องยืนยันใหม่`, 'ยืนยันจ่าย', async (reason) => {
        await post(`/api/payroll-selection/periods/${pid}/employees/${r.employee_id}/confirm`, { reason });
        toast(`ยืนยัน ${r.emp_code} แล้ว`);
        reload();
        return null;
      });
    };

    const addDialog = async () => {
      const list = h('div', { class: 'stack' }, loading());
      const chosen = new Set<number>();
      const err = h('div', { class: 'form-msg', role: 'alert' });
      const out = h('div');
      let busy = false;
      const load = async (q: string) => {
        try {
          const r = await get<{ employees: Array<{ employee_id: number; emp_code: string; name: string; company_id: number; outside_label: string; eligibility: string; decision: 'pay' | 'review' | 'block'; labels: string[] }> }>(`/api/payroll-selection/periods/${pid}/available${qs({ q })}`);
          list.replaceChildren(r.employees.length
            ? h('table', { class: 'table compact' }, h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'รหัส'), h('th', null, 'ชื่อ'), h('th', null, 'อยู่นอกรายชื่อเพราะ'), h('th', null, 'สิทธิ์ถ้าเลือก'))),
                h('tbody', null, r.employees.map((e) => h('tr', null,
                  h('td', null, h('input', { type: 'checkbox', 'aria-label': `เลือก ${e.emp_code}`, onchange: (ev: Event) => { if ((ev.target as HTMLInputElement).checked) chosen.add(e.employee_id); else chosen.delete(e.employee_id); } })),
                  h('td', null, e.emp_code), h('td', null, e.name), h('td', null, e.outside_label),
                  h('td', null, h('span', { class: `badge-status ${DECISION[e.decision]!.cls}` }, DECISION[e.decision]!.label), e.labels.length ? h('div', { class: 'muted small' }, e.labels.join(' · ')) : null)))))
            : h('div', { class: 'empty' }, 'ไม่พบพนักงานนอกรายชื่อที่ตรงกับคำค้น'));
        } catch (e) {
          list.replaceChildren(errorBox(e));
        }
      };
      const find = h('input', { type: 'search', placeholder: 'ค้นหารหัสหรือชื่อ', 'aria-label': 'ค้นหาพนักงานนอกรายชื่อ', oninput: (e: Event) => void load((e.target as HTMLInputElement).value) });
      const reason = h('input', { type: 'text', maxlength: 500, placeholder: 'เหตุผล (ถ้ามี)', 'aria-label': 'เหตุผล' }) as HTMLInputElement;
      const btn = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
        if (busy) return;
        if (!chosen.size) {
          err.textContent = 'ยังไม่ได้เลือกพนักงาน';
          return;
        }
        busy = true;
        btn.disabled = true;
        err.textContent = '';
        try {
          const r = await post<{ counts: Record<string, number>; results: Array<{ employee_id: number; result: string; decision?: string }> }>(`/api/payroll-selection/periods/${pid}/select`, { employee_ids: [...chosen], reason: reason.value.trim() || undefined });
          out.replaceChildren(h('p', null, 'การเลือกไม่ใช่การอนุมัติจ่าย: ผู้ที่ "รอ HR ตรวจสอบ" ต้องยืนยัน ผู้ที่ "ไม่มีสิทธิ์" ต้องแก้ข้อมูลหรือนำออก'), resultList(r.results, (id) => `#${id}`));
          toast(`เพิ่ม ${r.counts.selected ?? 0} คน`);
          btn.textContent = 'เสร็จแล้ว';
          dlg.close();
          reload();
        } catch (e) {
          err.textContent = msg(e);
          busy = false;
          btn.disabled = false;
        }
      } }, 'เพิ่มเข้างวด') as HTMLButtonElement;
      const dlg = modal(`เพิ่มพนักงานเข้างวด ${d.period.code}`, h('div', { class: 'stack' }, find, list, reason, err, out), [h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'ปิด'), btn]);
      await load('');
    };

    const events = can('payroll_selection.view') ? await get<{ events: Array<{ emp_code: string; action: string; previous_status: string | null; new_status: string; reason: string | null; created_at: string; actor: string | null }> }>(`/api/payroll-selection/periods/${pid}/events`).catch(() => ({ events: [] })) : { events: [] };
    const s = d.summary;
    const kpi = (label: string, value: number, cls = '') => h('div', { class: `card kpi ${cls}` }, h('div', { class: 'kpi-label' }, label), h('div', { class: 'kpi-value' }, String(value ?? 0)));
    const stale = d.version.version > 0 && d.period.status === 'calculated' && d.version.calculated_version !== d.version.version;

    mount(main,
      h('div', { class: 'toolbar' }, h('label', { class: 'field inline' }, h('span', null, 'งวด'), periodSel), companies.length > 1 ? h('label', { class: 'field inline' }, h('span', null, 'บริษัท'), companySel) : null),
      h('p', { class: 'muted' }, `${fmtDate(d.period.start_date)} – ${fmtDate(d.period.end_date)} · สถานะ ${optionLabel(d.period.status)}${open ? '' : ' · งวดอนุมัติแล้ว: เปลี่ยนรายชื่อไม่ได้'}`),
      stale ? h('div', { class: 'alert alert-error' }, '⛔ รายชื่อพนักงานเปลี่ยนหลังการคำนวณ ต้องคำนวณงวดใหม่ก่อนอนุมัติ') : null,
      issues.map((i) => h('div', { class: `alert ${i.level === 'error' ? 'alert-error' : ''}` }, `${i.level === 'error' ? '⛔' : '⚠'} ${i.message}${i.count > 1 ? ` (${i.count})` : ''}`)),
      h('div', { class: 'kpis' }, kpi('ในงวด', s.selected ?? 0), kpi('มีสิทธิ์', (s.eligible ?? 0) + (s.eligible_prorated ?? 0)), kpi('รอ HR ตรวจสอบ', s.review_required ?? 0, s.review_required ? 'kpi-warn' : ''), kpi('ไม่มีสิทธิ์/ระงับ', s.blocked ?? 0, s.blocked ? 'kpi-bad' : ''), kpi('HR ยืนยันแล้ว', s.review_confirmed ?? 0), kpi('นำออก', s.deselected ?? 0)),
      h('div', { class: 'toolbar pick-bar' }, search, chips, outToggle, h('div', { class: 'spacer' }), count, clearBtn, outBtn, addBtn),
      h('div', { class: 'table-wrap preview-wrap' }, h('table', { class: 'table compact preview-table sel-table' },
        h('thead', null,
          h('tr', { class: 'group-row' }, h('th', { class: 'fz fz-group', colspan: 3 }, 'พนักงาน'), h('th', { colspan: 8 }, 'สิทธิ์รับเงินและที่มา')),
          h('tr', null, h('th', { class: 'fz fz-check' }, headCheck), h('th', { class: 'fz fz-code' }, 'รหัสพนักงาน'), h('th', { class: 'fz fz-name' }, 'ชื่อ-นามสกุล'),
            ['บริษัท', 'ประเภทการจ้าง', 'รอบการจ่าย', 'สิทธิ์', 'เหตุผล / หมายเหตุ', 'ช่วงวันที่จ่าย', 'ที่มา', ''].map((t) => h('th', null, t)))),
        tbody)),
      h('details', { class: 'card history' }, h('summary', null, `ประวัติการเปลี่ยนรายชื่อ (${events.events.length})`),
        events.events.length
          ? h('div', { class: 'table-scroll' }, h('table', { class: 'table compact' }, h('thead', null, h('tr', null, ['เวลา', 'ผู้ดำเนินการ', 'พนักงาน', 'การดำเนินการ', 'สถานะเดิม → ใหม่', 'เหตุผล'].map((t) => h('th', null, t)))),
              h('tbody', null, events.events.map((e) => h('tr', null, h('td', null, fmtDate(e.created_at)), h('td', null, e.actor ?? '-'), h('td', null, e.emp_code), h('td', null, e.action), h('td', null, `${e.previous_status ?? '-'} → ${e.new_status}`), h('td', null, e.reason ?? '-'))))))
          : h('p', { class: 'muted' }, 'ยังไม่มีการเปลี่ยนแปลง (ใช้รายชื่อปกติของงวด)')));
    paint();
    const table = main.querySelector('.sel-table') as HTMLElement;
    const groupRow = table.querySelector('thead tr') as HTMLElement;
    const sync = () => table.style.setProperty('--group-h', `${groupRow.getBoundingClientRect().height}px`);
    new ResizeObserver(sync).observe(groupRow);
    requestAnimationFrame(sync);
  } catch (e) {
    mount(main, errorBox(e));
  }
}

// ---- Contract periods ----------------------------------------------------------------------------------------------

interface Contract {
  id: number;
  contract_no: string | null;
  start_date: string;
  end_date: string | null;
  status: 'active' | 'cancelled';
  reason: string | null;
  version: number;
}

export async function renderEmployeeContracts(main: HTMLElement, params: URLSearchParams): Promise<void> {
  mount(main, loading());
  try {
    const emps = await get<{ rows: Array<{ id: number; emp_code: string; first_name: string; last_name: string; company_id: number; status: string }> }>(`/api/m/employees${qs({ 'f.employment_type': 'contract', pageSize: 200, sort: 'emp_code' })}`);
    if (!emps.rows.length) return mount(main, h('div', { class: 'empty' }, 'ไม่มีพนักงานประเภทสัญญาจ้างในบริษัทที่มีสิทธิ์ดู'));
    const eid = params.get('employee_id') ?? String(emps.rows[0]!.id);
    const go = (id: string) => void renderEmployeeContracts(main, new URLSearchParams({ employee_id: id }));
    const d = await get<{ employee: { id: number; emp_code: string; hire_date: string; termination_date: string | null }; contracts: Contract[]; history: Array<{ action: string; reason: string | null; reference: string | null; created_at: string; actor: string | null; before: Record<string, unknown> | null; after: Record<string, unknown> }> }>(`/api/employee-contracts/employees/${eid}`);
    const manage = can('employee_contract.manage');
    const sel = h('select', { 'aria-label': 'พนักงาน', onchange: () => go(sel.value) }, emps.rows.map((e) => h('option', { value: String(e.id), selected: String(e.id) === eid }, `${e.emp_code} · ${e.first_name} ${e.last_name}`)));
    const addForm = () => {
      const start = h('input', { type: 'date', value: d.employee.hire_date, 'aria-label': 'วันเริ่มสัญญา' }) as HTMLInputElement;
      const end = h('input', { type: 'date', 'aria-label': 'วันสิ้นสุดสัญญา (เว้นว่าง = ไม่มีกำหนด)' }) as HTMLInputElement;
      const no = h('input', { type: 'text', maxlength: 100, placeholder: 'เลขที่สัญญา (ถ้ามี)', 'aria-label': 'เลขที่สัญญา' }) as HTMLInputElement;
      const ref = h('input', { type: 'text', maxlength: 200, placeholder: 'เอกสารอ้างอิง (ถ้ามี)', 'aria-label': 'เอกสารอ้างอิง' }) as HTMLInputElement;
      reasonDialog(`บันทึกสัญญาของ ${d.employee.emp_code}`, 'วันเริ่มต้องไม่ก่อนวันเริ่มงาน และช่วงวันต้องไม่ซ้อนกับสัญญาที่ใช้งานอยู่', 'บันทึกสัญญา', async (reason) => {
        await post(`/api/employee-contracts/employees/${eid}`, { start_date: start.value, end_date: end.value || null, contract_no: no.value || null, reference: ref.value || null, reason });
        toast('บันทึกสัญญาแล้ว');
        go(eid);
        return null;
      }, { fields: h('div', { class: 'form-grid' }, h('label', { class: 'field' }, h('span', null, 'วันเริ่มสัญญา'), start), h('label', { class: 'field' }, h('span', null, 'วันสิ้นสุด (ว่าง = ไม่มีกำหนด)'), end), h('label', { class: 'field' }, h('span', null, 'เลขที่สัญญา'), no), h('label', { class: 'field' }, h('span', null, 'เอกสารอ้างอิง'), ref)) });
    };
    const renew = (c: Contract) => {
      const end = h('input', { type: 'date', value: c.end_date ?? '', 'aria-label': 'วันสิ้นสุดใหม่' }) as HTMLInputElement;
      reasonDialog(`เปลี่ยนวันสิ้นสุดสัญญา ${c.contract_no ?? `#${c.id}`}`, 'ต่อสัญญาหรือสิ้นสุดก่อนกำหนด (เว้นว่าง = ไม่มีกำหนด)', 'บันทึก', async (reason) => {
        await put(`/api/employee-contracts/${c.id}`, { version: c.version, end_date: end.value || null, reason });
        toast('บันทึกแล้ว');
        go(eid);
        return null;
      }, { fields: h('label', { class: 'field' }, h('span', null, 'วันสิ้นสุดใหม่'), end) });
    };
    const cancel = (c: Contract) => reasonDialog(`ยกเลิกสัญญา ${c.contract_no ?? `#${c.id}`}`, 'ใช้เมื่อบันทึกผิด สัญญาที่ยกเลิกถูกเก็บไว้ในประวัติและไม่ถูกใช้ตรวจสิทธิ์', 'ยกเลิกสัญญา', async (reason) => {
      await post(`/api/employee-contracts/${c.id}/cancel`, { version: c.version, reason });
      toast('ยกเลิกแล้ว');
      go(eid);
      return null;
    }, { danger: true });
    mount(main,
      h('div', { class: 'toolbar' }, h('label', { class: 'field inline' }, h('span', null, 'พนักงานสัญญาจ้าง'), sel), h('div', { class: 'spacer' }), manage ? h('button', { class: 'btn primary', type: 'button', onclick: addForm }, '+ บันทึกสัญญา') : null),
      h('p', { class: 'muted' }, `เริ่มงาน ${fmtDate(d.employee.hire_date)}${d.employee.termination_date ? ` · สิ้นสุดการจ้าง ${fmtDate(d.employee.termination_date)}` : ''} · ถ้าสัญญาไม่ครอบคลุมทุกวันที่จ่าย งวดเงินเดือนจะให้ HR ตรวจสอบ (ไม่เปลี่ยนสูตรเงินเดือน)`),
      d.contracts.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, ['เลขที่', 'เริ่ม', 'สิ้นสุด', 'สถานะ', 'เหตุผลล่าสุด', ''].map((t) => h('th', null, t)))),
            h('tbody', null, d.contracts.map((c) => h('tr', null, h('td', null, c.contract_no ?? '-'), h('td', null, fmtDate(c.start_date)), h('td', null, c.end_date ? fmtDate(c.end_date) : 'ไม่มีกำหนด'),
              h('td', null, c.status === 'active' ? h('span', { class: 'badge-status elig-pay' }, 'ใช้งาน') : h('span', { class: 'badge-status' }, 'ยกเลิก')), h('td', null, c.reason ?? '-'),
              h('td', null, manage && c.status === 'active' ? [h('button', { class: 'btn small', type: 'button', onclick: () => renew(c) }, 'ต่อ/สิ้นสุด'), ' ', h('button', { class: 'btn small danger', type: 'button', onclick: () => cancel(c) }, 'ยกเลิก')] : null))))))
        : h('div', { class: 'alert' }, 'ℹ ยังไม่ได้บันทึกสัญญา: งวดเงินเดือนจ่ายตามเดิมพร้อมหมายเหตุ "ยังไม่ได้บันทึกระยะเวลาสัญญา"'),
      h('details', { class: 'card history' }, h('summary', null, `ประวัติ (${d.history.length})`),
        h('div', { class: 'table-scroll' }, h('table', { class: 'table compact' }, h('thead', null, h('tr', null, ['เวลา', 'ผู้ดำเนินการ', 'การดำเนินการ', 'เหตุผล', 'อ้างอิง'].map((t) => h('th', null, t)))),
          h('tbody', null, d.history.map((x) => h('tr', null, h('td', null, fmtDate(x.created_at)), h('td', null, x.actor ?? '-'), h('td', null, x.action), h('td', null, x.reason ?? '-'), h('td', null, x.reference ?? '-'))))))));
  } catch (e) {
    mount(main, errorBox(e));
  }
}

// ---- Pay frequency ---------------------------------------------------------------------------------------------------

export async function renderPayFrequency(main: HTMLElement): Promise<void> {
  mount(main, loading());
  try {
    const [cos, hist] = await Promise.all([
      get<{ companies: Array<{ id: number; code: string; name: string; pay_frequency: string | null }> }>('/api/pay-frequency/companies'),
      get<{ history: Array<{ entity: string; entity_id: number; before_value: string | null; after_value: string | null; reason: string; created_at: string; actor: string | null }> }>('/api/pay-frequency/history'),
    ]);
    const manage = can('pay_frequency.manage');
    const reload = () => void renderPayFrequency(main);
    const change = (title: string, current: string | null, path: string) => {
      const sel = h('select', { 'aria-label': 'รอบการจ่าย' }, ['', 'monthly', 'semi_monthly'].map((v) => h('option', { value: v, selected: (current ?? '') === v }, v ? FREQ[v]! : 'ไม่กำหนด (ตามเดิม / ตามบริษัท)'))) as HTMLSelectElement;
      reasonDialog(title, 'รายเดือน = ไม่อยู่ในรอบจ่ายกลางเดือน · ครึ่งเดือน = อยู่ในรอบกลางเดือน (จ่ายเฉพาะพนักงานทดลองงานตามกติกาเดิม) · ไม่เปลี่ยนสูตรหรือยอดเงิน', 'บันทึก', async (reason) => {
        await put(path, { pay_frequency: sel.value || null, reason });
        toast('บันทึกแล้ว');
        reload();
        return null;
      }, { fields: h('label', { class: 'field' }, h('span', null, 'รอบการจ่าย'), sel) });
    };
    const empCode = h('input', { type: 'search', placeholder: 'รหัสพนักงาน', 'aria-label': 'รหัสพนักงาน' }) as HTMLInputElement;
    const empOut = h('div');
    const lookup = async () => {
      empOut.replaceChildren(loading());
      try {
        const r = await get<{ rows: Array<{ id: number; emp_code: string }> }>(`/api/m/employees${qs({ q: empCode.value.trim(), pageSize: 5 })}`);
        const e = r.rows.find((x) => x.emp_code.toUpperCase() === empCode.value.trim().toUpperCase()) ?? r.rows[0];
        if (!e) return empOut.replaceChildren(h('p', { class: 'muted' }, 'ไม่พบพนักงานในบริษัทที่มีสิทธิ์'));
        const f = await get<{ id: number; emp_code: string; pay_frequency: string | null; company_frequency: string | null; effective: string | null }>(`/api/pay-frequency/employees/${e.id}`);
        empOut.replaceChildren(h('div', { class: 'card stack' },
          h('dl', { class: 'dl' }, h('dt', null, 'พนักงาน'), h('dd', null, f.emp_code), h('dt', null, 'ของพนักงาน'), h('dd', null, f.pay_frequency ? FREQ[f.pay_frequency]! : 'ไม่กำหนด (ใช้ของบริษัท)'), h('dt', null, 'ของบริษัท'), h('dd', null, freqLabel(f.company_frequency)), h('dt', null, 'ที่ใช้จริง'), h('dd', null, h('strong', null, freqLabel(f.effective)))),
          manage ? h('button', { class: 'btn', type: 'button', onclick: () => change(`รอบการจ่ายของ ${f.emp_code}`, f.pay_frequency, `/api/pay-frequency/employees/${f.id}`) }, 'เปลี่ยนรอบการจ่ายของพนักงาน') : null));
      } catch (e) {
        empOut.replaceChildren(errorBox(e));
      }
    };
    mount(main,
      h('p', { class: 'muted' }, 'รอบกลางเดือนเป็นเงินจ่ายล่วงหน้าสำหรับพนักงานทดลองงาน (นโยบาย HR ข้อ 3) แล้วหักคืนสิ้นเดือนครั้งเดียว · กติกาจ่ายกลางเดือนสำหรับพนักงานที่ผ่านทดลองงานยังไม่มี (รอ HR กำหนด)'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', null, 'บริษัท'), h('th', null, 'รอบการจ่าย'), h('th', null, ''))),
        h('tbody', null, cos.companies.map((c) => h('tr', null, h('td', null, `${c.code} · ${c.name}`), h('td', null, freqLabel(c.pay_frequency)),
          h('td', null, manage ? h('button', { class: 'btn small', type: 'button', onclick: () => change(`รอบการจ่ายของ ${c.name}`, c.pay_frequency, `/api/pay-frequency/companies/${c.id}`) }, 'เปลี่ยน') : null)))))),
      h('h3', null, 'รายพนักงาน (กำหนดแทนค่าของบริษัท)'),
      h('div', { class: 'toolbar' }, empCode, h('button', { class: 'btn', type: 'button', onclick: () => void lookup() }, 'ค้นหา')), empOut,
      h('details', { class: 'card history' }, h('summary', null, `ประวัติการเปลี่ยน (${hist.history.length})`),
        h('div', { class: 'table-scroll' }, h('table', { class: 'table compact' }, h('thead', null, h('tr', null, ['เวลา', 'ผู้ดำเนินการ', 'ระดับ', 'เดิม → ใหม่', 'เหตุผล'].map((t) => h('th', null, t)))),
          h('tbody', null, hist.history.map((x) => h('tr', null, h('td', null, fmtDate(x.created_at)), h('td', null, x.actor ?? '-'), h('td', null, x.entity === 'company' ? `บริษัท #${x.entity_id}` : `พนักงาน #${x.entity_id}`), h('td', null, `${freqLabel(x.before_value)} → ${freqLabel(x.after_value)}`), h('td', null, x.reason))))))));
  } catch (e) {
    mount(main, errorBox(e));
  }
}
