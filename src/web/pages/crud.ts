import type { FieldDef } from '../../shared/modules';
import type { CrudMeta, ListResponse, LookupOption, Row } from '../../shared/types';
import { del, get, post, put, qs, ApiFailure } from '../api';
import { h, mount, modal, toast, confirmDialog, loading, errorBox, fmtDate, fmtMoney, fmtNum } from '../dom';
import { optionLabel } from '../labels';
import { basePath, state } from '../app';
import { avatarPanel } from '../avatar';
import { formatTenure, probationTimeline, tenure, tenureEnd } from '../../shared/probation';

const lookupCache = new Map<string, Promise<LookupOption[]>>();
export function lookup(key: string): Promise<LookupOption[]> {
  let p = lookupCache.get(key);
  if (!p) {
    p = get<LookupOption[]>(`/api/lookup/${key}`);
    lookupCache.set(key, p);
    p.catch(() => lookupCache.delete(key));
  }
  return p;
}
export function clearLookups(): void {
  lookupCache.clear();
}

/** Indented label for hierarchical options; label is guaranteed non-empty by the API contract. */
export function optionText(o: LookupOption): string {
  return o.depth > 0 ? `${'  '.repeat(o.depth - 1)}└ ${o.label}` : o.label;
}

export function cell(f: FieldDef | undefined, row: Row, name: string): string {
  const v = row[name];
  if (!f) return fmtNum(v);
  if (f.type === 'ref') return String(row[`${name}__label`] ?? (v === null ? '-' : `#${v}`));
  if (f.type === 'select') return optionLabel(v);
  if (f.type === 'bool') return v ? '✓' : '—';
  if (f.type === 'date') return fmtDate(v);
  if (f.type === 'money') return fmtMoney(v);
  if (f.type === 'number') return fmtNum(v);
  return v === null || v === undefined || v === '' ? '-' : String(v);
}

function statusBadge(v: unknown): HTMLElement {
  return h('span', { class: `badge-status s-${String(v)}` }, optionLabel(v as string));
}

/** Employee list page size (25 / 50 / 100), kept while the app is open; every other module lists 25. */
let employeePageSize = 25;
const EMPLOYEE_PAGE_SIZES = [25, 50, 100];

/** Tenure of an employee row up to the server date (or the last working day of a leaver). */
function tenureText(row: Row, asOf: string | undefined): string {
  const hire = typeof row.hire_date === 'string' ? row.hire_date : '';
  if (!asOf || !hire) return '-';
  return formatTenure(tenure(hire, tenureEnd(asOf, typeof row.termination_date === 'string' ? row.termination_date : null)));
}

export async function renderCrud(main: HTMLElement, m: CrudMeta, params: URLSearchParams): Promise<void> {
  const filters: Record<string, string> = {};
  for (const [k, v] of params) if (k.startsWith('f.')) filters[k] = v;
  let q = params.get('q') ?? '';
  let page = 1;
  const isEmployees = m.key === 'employees';
  let pageSize = isEmployees ? employeePageSize : 25;
  /** server date of the last list response (tenure and probation days are counted to it, never to the device clock) */
  let asOf: string | undefined;
  // employees follow the active company of the header unless the link names one
  if (isEmployees && !('f.company_id' in filters) && state.companyId !== null) filters['f.company_id'] = String(state.companyId);

  const listFields = m.fields.filter((f) => f.list && !(f.name === m.ownerField && !m.perms.all));
  const filterable = m.fields.filter((f) => f.type === 'select' && f.list);
  const tableBox = h('div', { class: 'table-wrap' }, loading());
  const pager = h('div', { class: 'pager' });

  const search = h('input', { type: 'search', placeholder: 'ค้นหา…', value: q, 'aria-label': 'ค้นหา' });
  let timer: number | undefined;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => { q = search.value; page = 1; void load(); }, 300);
  });
  const selects = filterable.map((f) => {
    const s = h('select', { 'aria-label': f.label, onchange: () => { filters[`f.${f.name}`] = s.value; page = 1; void load(); } },
      h('option', { value: '' }, `${f.label}: ทั้งหมด`),
      (f.options ?? []).map((o) => h('option', { value: o, selected: filters[`f.${f.name}`] === o }, optionLabel(o))));
    return s;
  });
  const companies = state.meta?.companies;
  const companySelect = isEmployees && companies && companies.items.length
    ? h('select', { 'aria-label': 'บริษัท', onchange: (e: Event) => { filters['f.company_id'] = (e.target as HTMLSelectElement).value; page = 1; void load(); } },
        companies.scope === 'all' ? h('option', { value: '' }, 'บริษัท: ทุกบริษัท') : null,
        companies.items.map((c) => h('option', { value: String(c.id), selected: filters['f.company_id'] === String(c.id) }, c.name)))
    : null;
  const sizeSelect = isEmployees
    ? h('select', { 'aria-label': 'จำนวนรายการต่อหน้า', onchange: (e: Event) => { pageSize = employeePageSize = Number((e.target as HTMLSelectElement).value); page = 1; void load(); } },
        EMPLOYEE_PAGE_SIZES.map((n) => h('option', { value: String(n), selected: n === pageSize }, `${n} รายการ/หน้า`)))
    : null;
  const exportLink = (): string => `${basePath()}/api/m/${m.key}/export.csv${qs({ q, ...filters })}`;
  const exportBtn = m.perms.export ? h('a', { class: 'btn', href: exportLink(), download: true }, 'Export CSV') : null;

  const toolbar = h('div', { class: 'toolbar' }, search, companySelect, selects, sizeSelect, h('div', { class: 'spacer' }), exportBtn,
    m.perms.create ? h('button', { class: 'btn primary', onclick: () => void openForm(m, null, () => void load(), asOf) }, m.workflow ? '+ ยื่นคำขอ' : '+ เพิ่ม') : null);

  mount(main,
    h('p', { class: 'muted lead' }, m.description, m.workflow ? ' · คำขอใหม่จะเข้าสู่ Workflow อนุมัติอัตโนมัติ' : '', !m.perms.all && m.ownerField ? ' · แสดงเฉพาะข้อมูลของคุณ' : ''),
    toolbar, tableBox, pager);

  async function load(): Promise<void> {
    if (exportBtn) exportBtn.setAttribute('href', exportLink());
    try {
      const data = await get<ListResponse>(`/api/m/${m.key}${qs({ q, page, pageSize, ...filters })}`);
      asOf = data.asOf;
      const cols = [...listFields.map((f) => ({ name: f.name, label: f.label, f: f as FieldDef | undefined })), ...m.computed.map((x) => ({ name: x.name, label: x.label, f: undefined })),
        ...(isEmployees ? [{ name: '__tenure', label: 'อายุงาน', f: undefined }] : [])];
      mount(tableBox, data.rows.length
        ? h('table', { class: 'table clickable' },
            h('thead', null, h('tr', null, cols.map((c) => h('th', null, c.label)))),
            h('tbody', null, data.rows.map((r) => h('tr', { tabindex: 0, onclick: () => void openForm(m, r, () => void load(), asOf), onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && void openForm(m, r, () => void load(), asOf) },
              cols.map((c) => h('td', null, c.name === 'status' ? statusBadge(r.status) : c.name === '__tenure' ? tenureText(r, asOf) : cell(c.f, r, c.name)))))))
        : h('div', { class: 'empty' }, q || Object.values(filters).some(Boolean) ? 'ไม่พบข้อมูลตามเงื่อนไข' : 'ยังไม่มีข้อมูล'));
      const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
      mount(pager, h('span', { class: 'muted' }, `ทั้งหมด ${data.total} รายการ`),
        pages > 1 ? [
          h('button', { class: 'btn small', disabled: page <= 1, onclick: () => { page--; void load(); } }, '‹'),
          h('span', null, `${page} / ${pages}`),
          h('button', { class: 'btn small', disabled: page >= pages, onclick: () => { page++; void load(); } }, '›'),
        ] : null);
    } catch (e) {
      mount(tableBox, errorBox(e));
    }
  }
  await load();
  // a notification links to "/employees?open=<id>": open that record (only if the API lets this user see it)
  const open = Number(params.get('open'));
  if (Number.isInteger(open) && open > 0) {
    try {
      await openForm(m, await get<Row>(`/api/m/${m.key}/${open}`), () => void load(), asOf);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  }
}

/**
 * Tenure, probation day count and pay-round note in the employee form, recomputed whenever the hire date, the
 * termination date or the status input changes (nothing is saved from it: the values are derived, never stored).
 */
function employeeTimeline(inputs: Map<string, HTMLElement>, asOf: string | undefined): HTMLElement | null {
  if (!asOf) return null;
  const box = h('div', { class: 'alert span2 tenure-box', 'aria-live': 'polite' });
  const val = (k: string) => (inputs.get(k) as HTMLInputElement | undefined)?.value ?? '';
  const render = () => {
    const hire = val('hire_date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(hire)) {
      mount(box, h('span', { class: 'muted' }, 'อายุงานจะแสดงเมื่อระบุวันเริ่มงาน'));
      return;
    }
    const t = probationTimeline(hire, asOf);
    const inProbation = val('status') === 'probation' || (t.day > 0 && t.day < 120);
    const cycle = t.day <= 90
      ? `จ่าย 2 งวด (กลางเดือน + สิ้นเดือน): รอบกลางเดือนจ่ายถึงวันที่ ${fmtDate(t.day90)} · รอบกลางเดือนที่เริ่มหลังวันนั้นไม่รวมพนักงานนี้ จึงเป็น 1 งวดตั้งแต่เดือนถัดไป`
      : `จ่าย 1 งวดตามรอบปกติ (ผ่าน 90 วันเมื่อ ${fmtDate(t.day90)})`;
    mount(box,
      h('div', null, h('strong', null, 'อายุงาน '), formatTenure(tenure(hire, tenureEnd(asOf, val('termination_date') || null))), h('span', { class: 'muted' }, ` (ณ ${fmtDate(asOf)})`)),
      inProbation ? h('div', null, h('strong', null, 'ทดลองงาน '), t.day > 0 ? `วันที่ ${t.day} · ` : 'ยังไม่เริ่มงาน · ', `ครบ 90 วัน ${fmtDate(t.day90)} · ครบ 120 วัน (เปลี่ยนเป็นปฏิบัติงาน) ${fmtDate(t.day120)}`) : null,
      inProbation ? h('div', { class: 'muted small' }, cycle) : null);
  };
  for (const k of ['hire_date', 'termination_date', 'status']) {
    inputs.get(k)?.addEventListener('input', render);
    inputs.get(k)?.addEventListener('change', render);
  }
  render();
  return box;
}

async function input(f: FieldDef, value: unknown, disabled: boolean): Promise<HTMLElement> {
  const common = { name: f.name, disabled, required: f.required && !disabled };
  const v = value === null || value === undefined ? '' : String(value);
  switch (f.type) {
    case 'textarea':
      return h('textarea', { ...common, rows: 3, value: v });
    case 'select':
      return h('select', common, h('option', { value: '' }, '— เลือก —'), (f.options ?? []).map((o) => h('option', { value: o, selected: o === v }, optionLabel(o))));
    case 'ref': {
      const sel = h('select', common, h('option', { value: '' }, 'กำลังโหลด…'));
      try {
        const opts = await lookup(f.ref as string);
        mount(sel, h('option', { value: '' }, '— เลือก —'), opts.map((o) => h('option', { value: String(o.value), selected: String(o.value) === v }, optionText(o))));
        // keep a value that is not in the active list (e.g. an inactive department) visible
        if (v && !opts.some((o) => String(o.value) === v)) sel.appendChild(h('option', { value: v, selected: true }, `#${v}`));
      } catch {
        mount(sel, h('option', { value: v }, v ? `#${v}` : '— ไม่มีสิทธิ์ดูรายการ —'));
      }
      return sel;
    }
    case 'bool':
      return h('input', { ...common, type: 'checkbox', checked: value === 1 || value === true || (value === undefined && f.name === 'active'), required: false });
    case 'number':
    case 'money':
      return h('input', { ...common, type: 'number', step: f.type === 'money' ? '0.01' : 'any', min: f.min, max: f.max, value: v });
    case 'date':
      return h('input', { ...common, type: 'date', value: v });
    case 'time':
      return h('input', { ...common, type: 'time', value: v });
    case 'email':
      return h('input', { ...common, type: 'email', value: v, maxlength: 200 });
    case 'url':
      return h('input', { ...common, type: 'url', value: v, placeholder: 'https://…' });
    default:
      return h('input', { ...common, type: 'text', value: v, maxlength: 300 });
  }
}

async function openForm(m: CrudMeta, row: Row | null, onSaved: () => void, asOf?: string): Promise<void> {
  const editable = row ? m.perms.update && (!m.workflow || row.status === 'pending') : m.perms.create;
  const inputs = new Map<string, HTMLElement>();
  const fields: HTMLElement[] = [];
  for (const f of m.fields) {
    if (!row && f.readonly) continue;
    if (f.name === m.ownerField && !m.perms.all && m.ownerField !== 'id') continue; // the server fills in the current employee
    const masked = !!f.sensitive && !m.perms.sensitive;
    const el = await input(f, masked ? '' : row?.[f.name], !editable || !!f.readonly || masked);
    if (masked && row) el.setAttribute('placeholder', 'ซ่อน (ต้องมีสิทธิ์ดูข้อมูลอ่อนไหว)');
    inputs.set(f.name, el);
    fields.push(h('label', { class: `field ${f.type === 'textarea' ? 'span2' : ''} ${f.type === 'bool' ? 'check' : ''}` }, h('span', null, f.label, f.required ? ' *' : ''), el));
  }
  // employee photo: its own API (R2 + D1), outside collect(), so saving the form never touches the photo and vice versa
  if (m.key === 'employees') {
    const timeline = employeeTimeline(inputs, asOf);
    if (timeline) fields.unshift(timeline);
  }
  if (m.key === 'employees' && row) fields.unshift(avatarPanel({ id: Number(row.id), name: `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim() }));
  const msg = h('div', { class: 'form-msg', role: 'alert' });
  const collect = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const f of m.fields) {
      const el = inputs.get(f.name) as (HTMLInputElement & HTMLSelectElement) | undefined;
      if (!el || el.disabled) continue;
      out[f.name] = f.type === 'bool' ? el.checked : el.value === '' ? null : f.type === 'number' || f.type === 'money' || f.type === 'ref' ? Number(el.value) : el.value;
    }
    return out;
  };
  const save = async () => {
    msg.textContent = '';
    try {
      if (row) await put(`/api/m/${m.key}/${row.id}`, collect());
      else await post(`/api/m/${m.key}`, collect());
      clearLookups();
      toast(row ? 'บันทึกการแก้ไขแล้ว' : m.workflow ? 'ส่งคำขอเข้าสู่ Workflow แล้ว' : 'เพิ่มข้อมูลแล้ว');
      dlg.close();
      onSaved();
    } catch (e) {
      msg.textContent = e instanceof Error ? e.message : String(e);
      const field = e instanceof ApiFailure ? (e.details as { field?: string } | undefined)?.field : undefined;
      if (field) inputs.get(field)?.focus();
    }
  };
  const canRemove = row && (m.workflow ? row.status === 'pending' && (m.perms.delete || m.perms.create) : m.perms.delete);
  const remove = async () => {
    if (!row) return;
    const ok = await confirmDialog(m.workflow ? 'ยกเลิกคำขอ' : 'ลบข้อมูล', m.workflow ? 'ต้องการยกเลิกคำขอนี้หรือไม่?' : 'ต้องการลบรายการนี้หรือไม่? การลบไม่สามารถย้อนกลับได้', m.workflow ? 'ยกเลิกคำขอ' : 'ลบ', true);
    if (!ok) return;
    try {
      await del(`/api/m/${m.key}/${row.id}`);
      clearLookups();
      toast(m.workflow ? 'ยกเลิกคำขอแล้ว' : 'ลบแล้ว');
      dlg.close();
      onSaved();
    } catch (e) {
      msg.textContent = e instanceof Error ? e.message : String(e);
    }
  };
  const form = h('form', { class: 'grid-form', onsubmit: (e: Event) => { e.preventDefault(); if (editable) void save(); } }, fields,
    row?.status && m.workflow && row.status !== 'pending' ? h('div', { class: 'alert span2' }, 'คำขอนี้ดำเนินการแล้ว จึงแก้ไขไม่ได้') : null,
    row ? h('div', { class: 'muted span2 small' }, `แก้ไขล่าสุด ${fmtDate(row.updated_at)}`) : null, msg);
  const dlg = modal(row ? `${m.title} #${row.id}` : m.workflow ? `ยื่นคำขอ: ${m.title}` : `เพิ่ม ${m.title}`, form, [
    canRemove ? h('button', { class: 'btn danger', type: 'button', onclick: () => void remove() }, m.workflow ? 'ยกเลิกคำขอ' : 'ลบ') : null,
    h('div', { class: 'spacer' }),
    h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'ปิด'),
    editable ? h('button', { class: 'btn primary', type: 'button', onclick: () => void save() }, 'บันทึก') : null,
  ]);
}

