// Payroll Preview table: frozen left columns (selection checkbox, employee code, employee name), a client-side
// search that never drops the selection, select-all of the rows shown (with the indeterminate state), clear, the
// selected count, and — where the server offers the employee selection API (P4) — the eligibility of each employee and
// "take out of the period" for the selected rows (per-employee results). The figures are the server's: selecting a row
// never changes an amount, and eligibility is shown as the API returns it.
import type { PayrollPreviewResponse } from '../../shared/types';
import { PREVIEW_GROUPS, type PreviewGroup } from '../../shared/payroll-columns';
import { ApiFailure, get, post } from '../api';
import { h, fmtDate, fmtMoney, fmtNum, modal, toast } from '../dom';
import { can } from '../app';

type Col = PayrollPreviewResponse['columns'][number];
type Row = PayrollPreviewResponse['rows'][number];

/** Frozen on the left, always, whatever the company layout (the layout still orders the other columns and the export). */
const FROZEN = ['emp_code', 'employee_name'] as const;

/** Selection per period, kept while the page re-renders (search, company filter, reload after an action). */
const picked = new Map<string, Set<number>>();

const isNum = (c: Col) => c.type === 'money' || c.type === 'number';
function cellText(v: string | number | null | undefined, type: string): string {
  if (v === null || v === undefined || v === '') return '-';
  if (type === 'money') return fmtMoney(v);
  if (type === 'number') return fmtNum(v);
  if (type === 'date') return fmtDate(v);
  return String(v);
}

interface Eligibility {
  eligibility: string;
  decision: 'pay' | 'review' | 'block';
  labels: string[];
}
type Support = { state: 'ready'; canManage: boolean; status: Map<number, Eligibility> } | { state: 'unavailable'; reason: string };

/** Whether this server offers the employee selection API for the period, and the eligibility it reports. */
async function selectionSupport(pid: string): Promise<Support> {
  // the server answers: 404 = this system has no employee selection yet, 403 = this account may not use it
  try {
    const l = await get<{ selected: Array<{ employee_id: number } & Eligibility> }>(`/api/payroll-selection/periods/${pid}`);
    return { state: 'ready', canManage: can('payroll_selection.manage'), status: new Map(l.selected.map((x) => [x.employee_id, { eligibility: x.eligibility, decision: x.decision, labels: x.labels }])) };
  } catch (e) {
    if (e instanceof ApiFailure && e.status === 404) return { state: 'unavailable', reason: 'ระบบนี้ยังไม่เปิดใช้การเลือกพนักงานรายงวด (Employee Selection) จึงเลือกได้เพื่อดูเท่านั้น' };
    if (e instanceof ApiFailure && e.status === 403) return { state: 'unavailable', reason: 'บัญชีนี้ไม่มีสิทธิ์จัดการรายชื่อพนักงานของงวด จึงเลือกได้เพื่อดูเท่านั้น' };
    return { state: 'unavailable', reason: e instanceof Error ? e.message : String(e) };
  }
}

const DECISION_LABEL: Record<Eligibility['decision'], string> = { pay: 'มีสิทธิ์', review: 'รอ HR ตรวจสอบ', block: 'ไม่มีสิทธิ์/ระงับ' };
const RESULT_LABEL: Record<string, string> = { deselected: 'นำออกแล้ว', selected: 'เลือกแล้ว', unchanged: 'ไม่เปลี่ยนแปลง', not_found: 'ไม่พบ (นอกสิทธิ์บริษัท)', cross_company: 'คนละบริษัทกับงวด' };

export async function previewTable(d: PayrollPreviewResponse, pid: string, visible: Col[], reload: () => void): Promise<HTMLElement> {
  const set = picked.get(pid) ?? new Set<number>();
  picked.set(pid, set);
  const support = await selectionSupport(pid);
  const frozen = FROZEN.map((k) => d.columns.find((c) => c.key === k)).filter((c): c is Col => !!c);
  const rest = visible.filter((c) => !(FROZEN as readonly string[]).includes(c.key));
  const groups: Array<{ group: string; span: number }> = [];
  if (support.state === 'ready') groups.push({ group: 'eligibility', span: 1 });
  for (const c of rest) {
    const last = groups[groups.length - 1];
    if (last && last.group === c.group) last.span++;
    else groups.push({ group: c.group, span: 1 });
  }
  const idOf = (r: Row) => (typeof r.employee_id === 'number' ? r.employee_id : null);
  let query = '';
  const shown = () => {
    const q = query.trim().toLowerCase();
    return q ? d.rows.filter((r) => `${r.emp_code ?? ''} ${r.employee_name ?? ''}`.toLowerCase().includes(q)) : d.rows;
  };

  const headCheck = h('input', { type: 'checkbox', class: 'pick-all', 'aria-label': 'เลือกทั้งหมดที่แสดงอยู่' }) as HTMLInputElement;
  const count = h('span', { class: 'pick-count', 'aria-live': 'polite' });
  const tbody = h('tbody');
  const clearBtn = h('button', { class: 'btn', type: 'button', onclick: () => { set.clear(); paint(); } }, 'ล้างการเลือกทั้งหมด') as HTMLButtonElement;
  const actionBtn = support.state === 'ready' && support.canManage
    ? (h('button', { class: 'btn danger', type: 'button', onclick: () => deselectDialog() }, 'นำออกจากงวด') as HTMLButtonElement)
    : null;

  const statusCell = (r: Row) => {
    if (support.state !== 'ready') return null;
    const id = idOf(r);
    const s = id !== null ? support.status.get(id) : undefined;
    return h('td', { class: 'elig' }, s ? h('span', { class: `badge-status elig-${s.decision}`, title: s.labels.join(' · ') || null }, DECISION_LABEL[s.decision]) : '-');
  };

  const paint = () => {
    const rows = shown();
    const ids = rows.map(idOf).filter((x): x is number => x !== null);
    const on = ids.filter((id) => set.has(id)).length;
    headCheck.checked = ids.length > 0 && on === ids.length;
    headCheck.indeterminate = on > 0 && on < ids.length;
    headCheck.disabled = ids.length === 0;
    headCheck.setAttribute('aria-label', `เลือกทั้งหมดที่แสดงอยู่ (${ids.length} คน)`);
    count.textContent = `เลือกแล้ว ${set.size} คน · แสดง ${rows.length} จาก ${d.rows.length} คน`;
    clearBtn.disabled = set.size === 0;
    if (actionBtn) {
      actionBtn.disabled = set.size === 0;
      actionBtn.textContent = `นำออกจากงวด (${set.size})`;
    }
    tbody.replaceChildren(...(rows.length
      ? rows.map((r) => {
          const id = idOf(r);
          const isOn = id !== null && set.has(id);
          const box = h('input', {
            type: 'checkbox', checked: isOn, disabled: id === null, 'aria-label': `เลือก ${r.emp_code ?? ''} ${r.employee_name ?? ''}`,
            onchange: (e: Event) => {
              if (id === null) return;
              if ((e.target as HTMLInputElement).checked) set.add(id);
              else set.delete(id);
              paint();
            },
          });
          return h('tr', { class: isOn ? 'is-picked' : null, 'data-employee-id': id === null ? null : String(id) },
            h('td', { class: 'fz fz-check' }, box),
            frozen.map((c, i) => h('td', { class: `fz ${i === 0 ? 'fz-code' : 'fz-name'}`, title: String(r[c.key] ?? '') }, cellText(r[c.key], c.type))),
            statusCell(r),
            rest.map((c) => h('td', { class: isNum(c) ? 'num' : null }, cellText(r[c.key], c.type))));
        })
      : [h('tr', null, h('td', { class: 'empty-row', colspan: 1 + frozen.length + rest.length + (support.state === 'ready' ? 1 : 0) }, 'ไม่พบพนักงานที่ตรงกับคำค้น'))]));
  };

  headCheck.onchange = () => {
    const ids = shown().map(idOf).filter((x): x is number => x !== null);
    if (headCheck.checked) ids.forEach((id) => set.add(id));
    else ids.forEach((id) => set.delete(id));
    paint();
  };

  /** Take the selected employees out of the period (P4 deselect): reason required, one request, per-employee results. */
  const deselectDialog = () => {
    const chosen = [...set];
    const reason = h('textarea', { rows: 3, maxlength: 500, 'aria-label': 'เหตุผล', placeholder: 'เหตุผล (อย่างน้อย 5 ตัวอักษร)' }) as HTMLTextAreaElement;
    const msg = h('div', { class: 'form-msg', role: 'alert' });
    const out = h('div');
    let busy = false;
    let done = false;
    const submit = h('button', { class: 'btn danger', type: 'button', onclick: async () => {
      if (busy) return;
      if (reason.value.trim().length < 5) {
        msg.textContent = 'กรุณาระบุเหตุผลอย่างน้อย 5 ตัวอักษร';
        return;
      }
      busy = true;
      submit.disabled = true;
      submit.textContent = 'กำลังบันทึก…';
      msg.textContent = '';
      try {
        const r = await post<{ counts: Record<string, number>; results: Array<{ employee_id: number; result: string }> }>(`/api/payroll-selection/periods/${pid}/deselect`, { employee_ids: chosen, reason: reason.value.trim() });
        const code = new Map(d.rows.map((x) => [idOf(x), String(x.emp_code ?? '')]));
        out.replaceChildren(h('ul', { class: 'result-list' }, r.results.map((x) => h('li', { class: `res-${x.result}` }, `${code.get(x.employee_id) || `#${x.employee_id}`}: ${RESULT_LABEL[x.result] ?? x.result}`))));
        for (const x of r.results) if (x.result === 'deselected' || x.result === 'unchanged') set.delete(x.employee_id);
        toast(`นำออกจากงวด ${r.counts.deselected ?? 0} คน`);
        submit.textContent = 'เสร็จแล้ว';
        done = true;
      } catch (e) {
        msg.textContent = e instanceof Error ? e.message : String(e);
        busy = false;
        submit.disabled = false;
        submit.textContent = 'ยืนยันนำออกจากงวด';
      }
    } }, 'ยืนยันนำออกจากงวด') as HTMLButtonElement;
    const dlg = modal(`นำพนักงาน ${chosen.length} คนออกจากงวด`, h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'พนักงานที่นำออกจะไม่ถูกคำนวณในงวดนี้ (ต้องคำนวณงวดใหม่) · ระบบตรวจสิทธิ์และขอบเขตบริษัทของแต่ละคนอีกครั้ง'),
      reason, msg, out), [h('button', { class: 'btn', type: 'button', onclick: () => { dlg.close(); if (done) reload(); } }, 'ปิด'), submit]);
  };

  const search = h('input', { type: 'search', class: 'pick-search', placeholder: 'ค้นหารหัสหรือชื่อพนักงาน', 'aria-label': 'ค้นหาพนักงานในตาราง', oninput: (e: Event) => { query = (e.target as HTMLInputElement).value; paint(); } });
  const table = h('table', { class: 'table compact preview-table' },
    h('thead', null,
      h('tr', { class: 'group-row' },
        h('th', { class: 'fz fz-group', colspan: 1 + frozen.length }, PREVIEW_GROUPS.employee),
        groups.map((g) => h('th', { colspan: g.span, class: `g-${g.group}` }, g.group === 'eligibility' ? 'สิทธิ์รับเงิน' : (PREVIEW_GROUPS[g.group as PreviewGroup] ?? g.group)))),
      h('tr', null,
        h('th', { class: 'fz fz-check' }, headCheck),
        frozen.map((c, i) => h('th', { class: `fz ${i === 0 ? 'fz-code' : 'fz-name'}` }, c.label)),
        support.state === 'ready' ? h('th', null, 'สถานะ') : null,
        rest.map((c) => h('th', { class: isNum(c) ? 'num' : null }, c.label)))),
    tbody,
    h('tfoot', null, h('tr', { class: 'total' },
      h('td', { class: 'fz fz-check' }),
      h('td', { class: 'fz fz-code' }, 'รวม'),
      frozen.length > 1 ? h('td', { class: 'fz fz-name' }) : null,
      support.state === 'ready' ? h('td') : null,
      rest.map((c) => h('td', { class: isNum(c) ? 'num' : null }, isNum(c) ? cellText(d.totals[c.key], c.type) : '')))));
  paint();

  const wrap = h('div', { class: 'table-wrap preview-wrap' }, table);
  // the second header row sits under the group row: its offset follows the group row's real height (it can wrap)
  const groupRow = table.querySelector('thead tr') as HTMLElement;
  const syncHeader = () => table.style.setProperty('--group-h', `${groupRow.getBoundingClientRect().height}px`);
  new ResizeObserver(syncHeader).observe(groupRow);
  requestAnimationFrame(syncHeader);

  return h('div', { class: 'stack preview-pick' },
    h('div', { class: 'toolbar pick-bar' }, search, count, h('div', { class: 'spacer' }), clearBtn, actionBtn),
    support.state === 'unavailable' ? h('p', { class: 'muted small pick-note' }, `ℹ ${support.reason}`) : null,
    wrap);
}
