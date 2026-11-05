// Holiday Calendar: month / year calendar and list (Thai Buddhist year shown, Gregorian stored), filters, add / edit /
// verify source / approve / deactivate, substitute days, Excel / CSV import with preview (drafts only), Excel export,
// verified holiday-work records and holiday pay rules. Every button mirrors an API permission; the API decides.
import type { CompanyOption, LookupOption } from '../../shared/types';
import {
  EMPLOYMENT_TYPES, HOLIDAY_TYPES, HOLIDAY_TYPE_LABEL, IMPORT_COLUMNS, IMPORT_HEADERS, THAI_MONTHS_FULL, THAI_WEEKDAYS, buddhistYear, isIsoDate, parseWeeklyRest, thaiDate, weekday,
  type HolidayListResponse, type HolidayPayRuleRow, type HolidayRow, type HolidayType, type HolidayWorkRow, type ImportRow,
} from '../../shared/holidays';
import { parseCsv, readXlsx, type Cell } from '../../shared/xlsx';
import { get, post, put, del, qs } from '../api';
import { h, mount, loading, errorBox, fmtDate, fmtNum, modal, toast, confirmDialog, promptDialog, type Child } from '../dom';
import { optionLabel } from '../labels';
import { state } from '../app';

type Tab = 'calendar' | 'list' | 'work' | 'rules';
type View = 'month' | 'year';

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const typeLabel = (t: string) => HOLIDAY_TYPE_LABEL[t as HolidayType] ?? t;
const yearLabel = (y: number) => `${buddhistYear(y)} (${y})`;
const statusBadge = (s: string) => h('span', { class: `badge-status s-${s === 'inactive' ? 'cancelled' : s}` }, s === 'inactive' ? 'ปิดใช้งาน' : optionLabel(s));
const verifyBadge = (v: string) => h('span', { class: `badge-status s-${v === 'verified' ? 'confirmed' : 'pending'}` }, v === 'verified' ? 'ตรวจสอบแหล่งที่มาแล้ว' : 'ยังไม่ตรวจสอบแหล่งที่มา');

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h('label', { class: 'field' }, h('span', null, label), control, hint ? h('small', { class: 'muted' }, hint) : null);
}

function select(options: Array<[string, string]>, value: string | null, attrs: Record<string, unknown> = {}): HTMLSelectElement {
  return h('select', attrs, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
}

function companies(): CompanyOption[] {
  return state.meta?.companies.items ?? [];
}

export async function renderHolidays(main: HTMLElement, params: URLSearchParams): Promise<void> {
  mount(main, loading());
  const tab = (params.get('tab') as Tab | null) ?? 'calendar';
  const view = (params.get('view') as View | null) ?? 'month';
  const go = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    history.replaceState(null, '', `${location.pathname}?${p.toString()}`);
    void renderHolidays(main, p);
  };
  try {
    const nowYear = Number(new Date().toISOString().slice(0, 4));
    const year = Number(params.get('year') ?? nowYear);
    const company = params.get('company') ?? (state.companyId ? String(state.companyId) : '');
    const filters = { year, company, type: params.get('type') ?? '', status: params.get('status') ?? '', country: params.get('country') ?? '', q: params.get('q') ?? '' };
    const data = await get<HolidayListResponse>(`/api/holidays${qs(filters)}`);
    const years: number[] = [];
    for (let y = Math.min(data.window.from, year); y <= Math.max(data.window.to, year); y++) years.push(y);

    const toolbar = h('div', { class: 'toolbar holiday-toolbar' },
      h('div', { class: 'segmented', role: 'group', 'aria-label': 'มุมมอง' },
        ([['calendar', 'ปฏิทิน'], ['list', 'รายการ'], ['work', 'ทำงานวันหยุด'], ['rules', 'กฎค่าจ้างวันหยุด']] as Array<[Tab, string]>).map(([k, l]) =>
          h('button', { class: `btn small ${tab === k ? 'primary' : ''}`, 'aria-pressed': tab === k ? 'true' : 'false', onclick: () => go({ tab: k }) }, l))),
      h('label', { class: 'field inline' }, h('span', null, 'ปี พ.ศ.'), select(years.map((y) => [String(y), yearLabel(y)]), String(year), { 'aria-label': 'ปี', onchange: (e: Event) => go({ year: (e.target as HTMLSelectElement).value }) })),
      companies().length > 1 || data.can.allCompanies
        ? h('label', { class: 'field inline' }, h('span', null, 'บริษัท'), select([['', 'ทุกบริษัท (ปฏิทินกลาง + บริษัท)'], ...companies().map((c): [string, string] => [String(c.id), c.name])], company, { 'aria-label': 'บริษัท', onchange: (e: Event) => go({ company: (e.target as HTMLSelectElement).value || null }) }))
        : null,
      h('div', { class: 'spacer' }),
      data.can.export ? h('a', { class: 'btn small', href: `/api/holidays/export.xlsx${qs(filters)}`, download: '' }, 'Export Excel') : null,
      data.can.import ? h('button', { class: 'btn small', onclick: () => importDialog(data, () => go({})) }, 'นำเข้า Excel/CSV') : null,
      data.can.create ? h('button', { class: 'btn small primary', onclick: () => holidayForm(data, null, () => go({})) }, '+ เพิ่มวันหยุด') : null);

    const note = h('p', { class: 'muted small' },
      `เปิดรับข้อมูลปี ${yearLabel(data.window.from)} – ${yearLabel(data.window.to)} · วันที่บันทึกเป็นปี ค.ศ. แสดงผลเป็น พ.ศ. · วันหยุดที่นำเข้าเป็น "ร่าง" จนกว่าจะตรวจสอบแหล่งที่มาและอนุมัติ`);

    let body: HTMLElement;
    if (tab === 'calendar' || tab === 'list') {
      const filterBar = h('div', { class: 'toolbar' },
        h('input', { type: 'search', placeholder: 'ค้นหาชื่อวันหยุด / แหล่งที่มา', value: filters.q, 'aria-label': 'ค้นหาวันหยุด', onchange: (e: Event) => go({ q: (e.target as HTMLInputElement).value || null }) }),
        select([['', 'ทุกประเภท'], ...HOLIDAY_TYPES.map((t): [string, string] => [t, typeLabel(t)])], filters.type, { 'aria-label': 'ประเภท', onchange: (e: Event) => go({ type: (e.target as HTMLSelectElement).value || null }) }),
        select([['', 'ทุกสถานะ'], ['draft', 'ร่าง'], ['approved', 'อนุมัติ'], ['inactive', 'ปิดใช้งาน']], filters.status, { 'aria-label': 'สถานะ', onchange: (e: Event) => go({ status: (e.target as HTMLSelectElement).value || null }) }),
        select([['', 'ทุกประเทศ'], ...[...new Set(data.calendars.map((c) => c.country_code))].map((c): [string, string] => [c, c])], filters.country, { 'aria-label': 'ประเทศ', onchange: (e: Event) => go({ country: (e.target as HTMLSelectElement).value || null }) }));
      const reload = () => go({});
      body = h('div', null, filterBar,
        tab === 'calendar' ? calendarView(data, year, view, Number(params.get('month') ?? new Date().getMonth() + 1), go, reload) : listView(data, reload));
    } else if (tab === 'work') body = await workView(data, year, () => go({}));
    else body = await rulesView(data, () => go({}));
    mount(main, toolbar, note, body);
  } catch (e) {
    mount(main, errorBox(e));
  }
}

// ---- calendar ------------------------------------------------------------------------------------
function calendarView(data: HolidayListResponse, year: number, view: View, month: number, go: (n: Record<string, string | null>) => void, reload: () => void): HTMLElement {
  const byDate = new Map<string, HolidayRow[]>();
  for (const x of data.holidays) if (x.status !== 'inactive') byDate.set(x.holiday_date, [...(byDate.get(x.holiday_date) ?? []), x]);
  const rest = parseWeeklyRest(data.calendars.find((c) => c.company_id !== null)?.weekly_rest_days ?? data.calendars[0]?.weekly_rest_days ?? '0,6') ?? [0, 6];
  const monthGrid = (m: number, compact: boolean) => {
    const first = `${year}-${String(m).padStart(2, '0')}-01`;
    const days = new Date(Date.UTC(year, m, 0)).getUTCDate();
    const cells: Child[] = [];
    for (let i = 0; i < weekday(first); i++) cells.push(h('div', { class: 'hol-day is-pad', 'aria-hidden': 'true' }));
    for (let d = 1; d <= days; d++) {
      const date = `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const list = byDate.get(date) ?? [];
      const cls = ['hol-day', list.length ? 'is-holiday' : '', list.some((x) => x.status === 'draft') && !list.some((x) => x.status === 'approved') ? 'is-draft' : '', rest.includes(weekday(date)) ? 'is-rest' : ''].filter(Boolean).join(' ');
      cells.push(h('div', { class: cls, title: list.map((x) => `${x.name} (${typeLabel(x.holiday_type)} · ${optionLabel(x.status)})`).join('\n') || undefined },
        h('span', { class: 'hol-num' }, String(d)),
        compact ? null : list.map((x) => h('button', { class: `hol-chip t-${x.holiday_type} st-${x.status}`, onclick: () => detailDialog(data, x.id, reload) }, x.name))));
    }
    return h('div', { class: `hol-month${compact ? ' compact' : ''}` },
      h('div', { class: 'hol-month-title' }, compact ? h('button', { class: 'linklike', onclick: () => go({ view: 'month', month: String(m) }) }, `${THAI_MONTHS_FULL[m - 1]}`) : `${THAI_MONTHS_FULL[m - 1]} ${buddhistYear(year)}`),
      h('div', { class: 'hol-grid', role: 'grid', 'aria-label': `${THAI_MONTHS_FULL[m - 1]} ${buddhistYear(year)}` }, THAI_WEEKDAYS.map((w) => h('div', { class: 'hol-wd', role: 'columnheader' }, w)), cells));
  };
  const switcher = h('div', { class: 'toolbar' },
    h('div', { class: 'segmented', role: 'group', 'aria-label': 'รูปแบบปฏิทิน' },
      h('button', { class: `btn small ${view === 'month' ? 'primary' : ''}`, 'aria-pressed': view === 'month' ? 'true' : 'false', onclick: () => go({ view: 'month' }) }, 'รายเดือน'),
      h('button', { class: `btn small ${view === 'year' ? 'primary' : ''}`, 'aria-pressed': view === 'year' ? 'true' : 'false', onclick: () => go({ view: 'year' }) }, 'รายปี')),
    view === 'month'
      ? [h('button', { class: 'btn small', 'aria-label': 'เดือนก่อนหน้า', disabled: month <= 1, onclick: () => go({ month: String(month - 1) }) }, '‹'),
         h('button', { class: 'btn small', 'aria-label': 'เดือนถัดไป', disabled: month >= 12, onclick: () => go({ month: String(month + 1) }) }, '›')]
      : null,
    h('span', { class: 'muted small' }, h('span', { class: 'hol-key is-holiday' }), ' วันหยุด ', h('span', { class: 'hol-key is-draft' }), ' ร่าง ', h('span', { class: 'hol-key is-rest' }), ' วันหยุดประจำสัปดาห์'));
  const m = Math.min(12, Math.max(1, month));
  const monthList = data.holidays.filter((x) => Number(x.holiday_date.slice(5, 7)) === m);
  return h('div', null, switcher,
    view === 'year'
      ? h('div', { class: 'hol-year' }, Array.from({ length: 12 }, (_, i) => monthGrid(i + 1, true)))
      : h('div', { class: 'stack' }, monthGrid(m, false), monthList.length ? listTable(data, monthList, reload) : h('div', { class: 'card empty' }, 'ไม่มีวันหยุดในเดือนนี้')));
}

function listView(data: HolidayListResponse, reload: () => void): HTMLElement {
  const missing = data.holidays.filter((x) => x.needs_substitute).length;
  return h('div', { class: 'stack' },
    h('div', { class: 'kpis' },
      kpi('วันหยุดทั้งหมด', data.holidays.filter((x) => x.status !== 'inactive').length),
      kpi('อนุมัติแล้ว', data.holidays.filter((x) => x.status === 'approved').length),
      kpi('ร่าง (รอตรวจสอบ/อนุมัติ)', data.holidays.filter((x) => x.status === 'draft').length, data.holidays.some((x) => x.status === 'draft') ? 'kpi-warn' : ''),
      kpi('ตรงวันหยุดประจำสัปดาห์ ยังไม่มีวันชดเชย', missing, missing ? 'kpi-warn' : '')),
    data.holidays.length ? listTable(data, data.holidays, reload) : h('div', { class: 'card empty' }, 'ยังไม่มีวันหยุดตามเงื่อนไข'));
}

function kpi(label: string, value: number, cls = ''): HTMLElement {
  return h('div', { class: `card kpi ${cls}` }, h('div', { class: 'kpi-label' }, label), h('div', { class: 'kpi-value' }, String(value)));
}

function listTable(data: HolidayListResponse, rows: HolidayRow[], reload: () => void): HTMLElement {
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table clickable' },
    h('thead', null, h('tr', null, ['วันที่', 'วัน', 'ชื่อวันหยุด', 'ประเภท', 'ปฏิทิน', 'สถานะ', 'แหล่งที่มา'].map((x) => h('th', null, x)))),
    h('tbody', null, rows.map((x) => h('tr', { tabindex: '0', onclick: () => detailDialog(data, x.id, reload), onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && detailDialog(data, x.id, reload) },
      h('td', null, thaiDate(x.holiday_date)),
      h('td', null, THAI_WEEKDAYS[weekday(x.holiday_date)]),
      h('td', null, x.name, x.needs_substitute ? h('div', { class: 'issue-warning small' }, 'ตรงวันหยุดประจำสัปดาห์ ยังไม่มีวันหยุดชดเชย') : null, x.payroll_locked ? h('div', { class: 'muted small' }, '🔒 ใช้คำนวณเงินเดือนแล้ว') : null),
      h('td', null, typeLabel(x.holiday_type)),
      h('td', null, x.company ?? `ส่วนกลาง (${x.country_code})`),
      h('td', null, statusBadge(x.status), ' ', x.status === 'draft' ? verifyBadge(x.verification) : null, x.origin === 'import' ? h('div', { class: 'muted small' }, 'นำเข้าจากไฟล์') : null),
      h('td', null, x.source_reference ?? '-'))))));
}

// ---- holiday detail / form -----------------------------------------------------------------------
async function detailDialog(data: HolidayListResponse, id: number, reload: () => void): Promise<void> {
  let d: HolidayRow & { on_weekly_rest: boolean; substitutes: Array<{ id: number; holiday_date: string; name: string; status: string; reason: string | null }> };
  try {
    d = await get(`/api/holidays/${id}`);
  } catch (e) {
    return toast(msg(e), 'error');
  }
  const act = (fn: () => Promise<unknown>, done: string) => async () => {
    try {
      await fn();
      toast(done);
      m.close();
      reload();
    } catch (e) {
      toast(msg(e), 'error');
    }
  };
  const dl = h('dl', { class: 'dl' },
    h('dt', null, 'วันที่'), h('dd', null, `${thaiDate(d.holiday_date)} (${d.holiday_date}) · วัน${THAI_WEEKDAYS[weekday(d.holiday_date)]}`),
    h('dt', null, 'ประเภท'), h('dd', null, typeLabel(d.holiday_type)),
    h('dt', null, 'ปฏิทิน'), h('dd', null, d.company ?? `ส่วนกลาง (${d.country_code})`),
    h('dt', null, 'สถานะ'), h('dd', null, statusBadge(d.status), ' ', verifyBadge(d.verification)),
    h('dt', null, 'แหล่งที่มา'), h('dd', null, d.source_reference ?? '-', d.source_url ? [' · ', h('a', { href: d.source_url, target: '_blank', rel: 'noopener noreferrer' }, 'เปิดประกาศ')] : null),
    d.name_en ? [h('dt', null, 'ชื่อภาษาอังกฤษ'), h('dd', null, d.name_en)] : null,
    d.region ? [h('dt', null, 'พื้นที่'), h('dd', null, d.region)] : null,
    d.note ? [h('dt', null, 'หมายเหตุ'), h('dd', null, d.note)] : null,
    h('dt', null, 'ที่มา'), h('dd', null, d.origin === 'import' ? 'นำเข้าจากไฟล์' : 'บันทึกเอง'),
    d.approved_at ? [h('dt', null, 'อนุมัติโดย'), h('dd', null, `${d.approved_by_name ?? '-'} · ${fmtDate(d.approved_at)}`)] : null,
    h('dt', null, 'การทำงานวันหยุดที่อ้างอิง'), h('dd', null, `${d.work_records} รายการ${d.payroll_locked ? ` (ใช้คำนวณเงินเดือนแล้ว ${d.payroll_locked})` : ''}`),
    d.substitutes.length ? [h('dt', null, 'วันหยุดชดเชย'), h('dd', null, d.substitutes.map((s) => h('div', null, `${thaiDate(s.holiday_date)} · ${s.name} · ${optionLabel(s.status)}`)))] : null);
  const actions: Child[] = [];
  if (d.status === 'draft' && data.can.approve && d.verification !== 'verified') {
    actions.push(h('button', { class: 'btn', onclick: async () => {
      const ref = await promptDialog('ตรวจสอบแหล่งที่มา', 'แหล่งที่มา / เลขที่ประกาศอย่างเป็นทางการ (ตรวจสอบกับประกาศจริงแล้ว)', 'ยืนยันการตรวจสอบ');
      if (ref) await act(() => post(`/api/holidays/${id}/verify`, { source_reference: ref }), 'บันทึกการตรวจสอบแหล่งที่มาแล้ว')();
    } }, 'ตรวจสอบแหล่งที่มา'));
  }
  if (d.status === 'draft' && data.can.approve && d.verification === 'verified') actions.push(h('button', { class: 'btn primary', onclick: act(() => post(`/api/holidays/${id}/approve`), 'อนุมัติวันหยุดแล้ว') }, 'อนุมัติ'));
  if (d.status === 'approved' && data.can.create && d.holiday_type !== 'substitute' && !d.substitutes.length) actions.push(h('button', { class: 'btn', onclick: () => (m.close(), substituteForm(d, reload)) }, 'กำหนดวันหยุดชดเชย'));
  if (d.status !== 'inactive' && data.can.update) actions.push(h('button', { class: 'btn', onclick: () => (m.close(), holidayForm(data, d, reload)) }, 'แก้ไข'));
  if (d.status !== 'inactive' && data.can.delete && !d.payroll_locked) {
    actions.push(h('button', { class: 'btn danger', onclick: async () => {
      const reason = await promptDialog('ปิดใช้งานวันหยุด', 'เหตุผล (ประวัติยังคงอยู่)', 'ปิดใช้งาน');
      if (reason) await act(() => post(`/api/holidays/${id}/deactivate`, { reason }), 'ปิดใช้งานวันหยุดแล้ว')();
    } }, 'ปิดใช้งาน'));
  }
  if (d.status === 'draft' && data.can.delete && !d.work_records) {
    actions.push(h('button', { class: 'btn danger', onclick: async () => {
      if (await confirmDialog('ลบร่างวันหยุด', `ลบ "${d.name}" (${thaiDate(d.holiday_date)}) ที่ยังเป็นร่าง?`, 'ลบ', true)) await act(() => del(`/api/holidays/${id}`), 'ลบร่างแล้ว')();
    } }, 'ลบร่าง'));
  }
  const m = modal(d.name, h('div', null, d.on_weekly_rest ? h('div', { class: 'alert' }, 'วันหยุดนี้ตรงกับวันหยุดประจำสัปดาห์ ควรกำหนดวันหยุดชดเชย') : null, dl), actions.length ? actions : null);
}

function holidayForm(data: HolidayListResponse, cur: HolidayRow | null, reload: () => void): void {
  const writable = data.calendars.filter((c) => c.active && (data.can.allCompanies || c.company_id !== null));
  const cal = select(writable.map((c): [string, string] => [String(c.id), c.company ? `${c.name}` : `${c.name} (ส่วนกลาง)`]), cur ? String(cur.calendar_id) : null, { disabled: !!cur });
  const date = h('input', { type: 'date', value: cur?.holiday_date ?? '', required: true, min: `${data.window.from}-01-01`, max: `${data.window.to}-12-31` });
  const name = h('input', { value: cur?.name ?? '', maxlength: 200, required: true });
  const nameEn = h('input', { value: cur?.name_en ?? '', maxlength: 200 });
  const type = select(HOLIDAY_TYPES.filter((t) => t !== 'substitute').map((t): [string, string] => [t, typeLabel(t)]), cur?.holiday_type ?? 'traditional', { disabled: cur?.holiday_type === 'substitute' });
  const ref = h('input', { value: cur?.source_reference ?? '', maxlength: 500, placeholder: 'เช่น ประกาศสำนักนายกรัฐมนตรี / ประกาศบริษัท เลขที่ …' });
  const url = h('input', { type: 'url', value: cur?.source_url ?? '', maxlength: 500, placeholder: 'https://' });
  const region = h('input', { value: cur?.region ?? '', maxlength: 200 });
  const note = h('textarea', { rows: 2, maxlength: 500 }, cur?.note ?? '');
  const locked = !!cur?.payroll_locked;
  if (locked) for (const x of [date, type, ref, url]) x.setAttribute('disabled', '');
  const save = async () => {
    if (!isIsoDate(date.value)) return toast('กรุณาระบุวันที่', 'error');
    const body: Record<string, unknown> = { name: name.value, name_en: nameEn.value, region: region.value, note: (note as HTMLTextAreaElement).value };
    if (!locked) Object.assign(body, { holiday_date: date.value, holiday_type: type.value, source_reference: ref.value, source_url: url.value });
    try {
      if (cur) await put(`/api/holidays/${cur.id}`, body);
      else await post('/api/holidays', { ...body, calendar_id: Number(cal.value) });
      toast(cur ? 'บันทึกการแก้ไขแล้ว' : 'เพิ่มวันหยุดแล้ว (สถานะร่าง)');
      m.close();
      reload();
    } catch (e) {
      toast(msg(e), 'error');
    }
  };
  const m = modal(cur ? 'แก้ไขวันหยุด' : 'เพิ่มวันหยุด', h('div', null,
    locked ? h('div', { class: 'alert' }, 'ใช้คำนวณเงินเดือนแล้ว: แก้ได้เฉพาะชื่อ พื้นที่ และหมายเหตุ') : cur?.status === 'approved' ? h('div', { class: 'alert' }, 'การเปลี่ยนวันที่ ประเภท หรือแหล่งที่มา จะทำให้วันหยุดกลับเป็นร่างและต้องอนุมัติใหม่') : null,
    h('div', { class: 'grid-form' },
      field('ปฏิทิน', cal), field('วันที่', date, 'แสดงผลเป็น พ.ศ. ในปฏิทิน'), field('ชื่อวันหยุด', name), field('ชื่อภาษาอังกฤษ', nameEn), field('ประเภท', type),
      field('แหล่งที่มา / เลขที่ประกาศ', ref, 'ต้องมีก่อนตรวจสอบและอนุมัติ'), field('ลิงก์ประกาศ', url), field('พื้นที่ (วันหยุดท้องถิ่น)', region), field('หมายเหตุ', note))),
    [h('button', { class: 'btn', onclick: () => m.close() }, 'ยกเลิก'), h('button', { class: 'btn primary', onclick: () => void save() }, 'บันทึก')]);
}

function substituteForm(d: HolidayRow, reload: () => void): void {
  const date = h('input', { type: 'date', required: true, min: d.holiday_date });
  const name = h('input', { value: `ชดเชย${d.name}`, maxlength: 200 });
  const reason = h('input', { maxlength: 500, placeholder: 'เช่น วันหยุดตรงกับวันเสาร์' });
  const m = modal('กำหนดวันหยุดชดเชย', h('div', { class: 'grid-form' }, field('วันหยุดชดเชย', date, 'ต้องเป็นวันทำงานถัดจากวันหยุดเดิม'), field('ชื่อ', name), field('เหตุผล', reason)), [
    h('button', { class: 'btn', onclick: () => m.close() }, 'ยกเลิก'),
    h('button', { class: 'btn primary', onclick: async () => {
      try {
        await post(`/api/holidays/${d.id}/substitute`, { holiday_date: date.value, name: name.value, reason: reason.value });
        toast('สร้างวันหยุดชดเชยแล้ว (สถานะร่าง ต้องตรวจสอบและอนุมัติ)');
        m.close();
        reload();
      } catch (e) {
        toast(msg(e), 'error');
      }
    } }, 'บันทึก'),
  ]);
}

// ---- import --------------------------------------------------------------------------------------
async function readGrid(file: File): Promise<Cell[][]> {
  const buf = await file.arrayBuffer();
  if (/\.csv$/i.test(file.name)) {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      text = new TextDecoder('windows-874').decode(buf);
    }
    return parseCsv(text);
  }
  if (!/\.xlsx$/i.test(file.name)) throw new Error('รองรับเฉพาะไฟล์ .xlsx และ .csv');
  const sheets = await readXlsx(buf);
  if (!sheets[0]) throw new Error('ไฟล์ไม่มี Sheet');
  return sheets[0].rows;
}

function importDialog(data: HolidayListResponse, reload: () => void): void {
  const writable = data.calendars.filter((c) => c.active && (data.can.allCompanies || c.company_id !== null));
  const cal = select(writable.map((c): [string, string] => [String(c.id), c.company ? c.name : `${c.name} (ส่วนกลาง)`]), null, { 'aria-label': 'ปฏิทินปลายทาง' });
  const file = h('input', { type: 'file', accept: '.xlsx,.csv', 'aria-label': 'ไฟล์วันหยุด' });
  const skip = h('input', { type: 'checkbox' });
  const out = h('div', { class: 'stack' });
  let grid: Cell[][] = [];
  const preview = async () => {
    const f = file.files?.[0];
    if (!f) return toast('กรุณาเลือกไฟล์', 'error');
    if (f.size > 5 * 1024 * 1024) return toast('ไฟล์ใหญ่เกิน 5 MB', 'error');
    mount(out, loading());
    try {
      grid = await readGrid(f);
      const r = await post<{ rows: ImportRow[]; missingColumns: string[]; errors: number; importable: number }>('/api/holidays/import/preview', { calendar_id: Number(cal.value), grid });
      if (r.missingColumns.length) return mount(out, h('div', { class: 'alert alert-error', role: 'alert' }, `ไม่พบคอลัมน์: ${r.missingColumns.join(', ')}`));
      mount(out,
        h('div', { class: 'kpis' }, kpi('แถวทั้งหมด', r.rows.length), kpi('นำเข้าได้ (เป็นร่าง)', r.importable), kpi('ผิดพลาด', r.errors, r.errors ? 'kpi-bad' : '')),
        h('div', { class: 'table-wrap' }, h('table', { class: 'table compact' },
          h('thead', null, h('tr', null, ['แถว', 'วันที่', 'ชื่อ', 'ประเภท', 'แหล่งที่มา', 'ผลตรวจสอบ'].map((x) => h('th', null, x)))),
          h('tbody', null, r.rows.slice(0, 500).map((x) => h('tr', { class: x.issues.some((i) => i.level === 'error') ? 'row-error' : '' },
            h('td', null, String(x.rowNo)), h('td', null, x.date && isIsoDate(x.date) ? thaiDate(x.date) : (x.date ?? '-')), h('td', null, x.name ?? '-'), h('td', null, x.type ? typeLabel(x.type) : '-'), h('td', null, x.source_reference ?? '-'),
            h('td', null, x.issues.length ? h('ul', { class: 'issues' }, x.issues.map((i) => h('li', { class: `issue-${i.level}` }, i.message))) : h('span', { class: 'ok-text' }, '✓ ถูกต้อง'))))))),
        r.errors ? h('label', { class: 'field check' }, h('span', null, 'นำเข้าเฉพาะแถวที่ถูกต้อง'), skip) : null,
        h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', disabled: !r.importable, onclick: () => void doImport(f.name, r.importable) }, `นำเข้า ${r.importable} รายการเป็นร่าง`)));
    } catch (e) {
      mount(out, errorBox(e));
    }
  };
  const doImport = async (name: string, n: number) => {
    if (!(await confirmDialog('ยืนยันนำเข้า', `นำเข้า ${n} วันหยุดเป็น "ร่าง" (ยังไม่ใช้กับเวลาทำงานหรือเงินเดือนจนกว่าจะตรวจสอบและอนุมัติ)?`, 'นำเข้า'))) return;
    try {
      const r = await post<{ imported: number; skipped: number }>('/api/holidays/import', { calendar_id: Number(cal.value), grid, file_name: name, skip_invalid: skip.checked });
      toast(`นำเข้าแล้ว ${r.imported} รายการ (ร่าง)${r.skipped ? ` · ข้าม ${r.skipped}` : ''}`);
      m.close();
      reload();
    } catch (e) {
      toast(msg(e), 'error');
    }
  };
  const m = modal('นำเข้าวันหยุดจาก Excel / CSV', h('div', { class: 'stack' },
    h('p', { class: 'muted small' }, `คอลัมน์: ${IMPORT_COLUMNS.map((k) => IMPORT_HEADERS[k]).join(' · ')} (ประเภท: ${HOLIDAY_TYPES.join(', ')}) — ไฟล์ Export ใช้นำเข้ากลับได้`),
    h('div', { class: 'grid-form' }, field('ปฏิทินปลายทาง', cal), field('ไฟล์ (.xlsx / .csv)', file)),
    h('div', { class: 'toolbar' }, h('button', { class: 'btn', onclick: () => void preview() }, 'ตรวจสอบไฟล์ (Preview)')),
    out));
}

// ---- holiday work --------------------------------------------------------------------------------
async function workView(data: HolidayListResponse, year: number, reload: () => void): Promise<HTMLElement> {
  const rows = await get<HolidayWorkRow[]>(`/api/holidays/work${qs({ from: `${year}-01-01`, to: `${year}-12-31` })}`);
  const act = (fn: () => Promise<unknown>, done: string) => async () => {
    try {
      await fn();
      toast(done);
      reload();
    } catch (e) {
      toast(msg(e), 'error');
    }
  };
  const approved = data.holidays.filter((x) => x.status === 'approved');
  return h('div', { class: 'stack' },
    h('p', { class: 'muted small' }, 'บันทึกเฉพาะชั่วโมงที่ทำงานจริงในวันหยุด พร้อมหลักฐานเวลาทำงาน (บันทึกเวลา / Feishu / เอกสารอ้างอิง) ผู้อนุมัติต้องไม่ใช่ผู้บันทึก และต้องยืนยันว่าชั่วโมงนี้ไม่ซ้ำกับ OT ปกติ ระบบไม่ถือว่าพนักงานทำงานวันหยุดจากรายการวันหยุดเพียงอย่างเดียว'),
    data.can.create ? h('div', { class: 'toolbar' }, h('button', { class: 'btn small primary', disabled: !approved.length, onclick: () => workForm(approved, reload) }, '+ บันทึกการทำงานวันหยุด'), approved.length ? null : h('span', { class: 'muted small' }, 'ยังไม่มีวันหยุดที่อนุมัติในปีนี้')) : null,
    rows.length
      ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
          h('thead', null, h('tr', null, ['วันที่', 'พนักงาน', 'วันหยุด', 'ชม.ปกติ', 'ชม. OT', 'หลักฐาน', 'สถานะ', ''].map((x) => h('th', { class: x.startsWith('ชม') ? 'num' : null }, x)))),
          h('tbody', null, rows.map((r) => h('tr', null,
            h('td', null, thaiDate(r.work_date)), h('td', null, `${r.emp_code} ${r.employee}`), h('td', null, r.holiday_name, h('div', { class: 'muted small' }, typeLabel(r.holiday_type))),
            h('td', { class: 'num' }, fmtNum(r.normal_hours)), h('td', { class: 'num' }, fmtNum(r.ot_hours)),
            h('td', null, optionLabel(r.evidence_source), r.evidence_ref ? h('div', { class: 'muted small' }, r.evidence_ref) : null),
            h('td', null, h('span', { class: `badge-status s-${r.status}` }, optionLabel(r.status)), r.payroll_period ? h('div', { class: 'muted small' }, `🔒 งวด ${r.payroll_period}`) : null, r.review_reason ? h('div', { class: 'muted small' }, r.review_reason) : null),
            h('td', null,
              r.status === 'pending' && data.can.approve
                ? [h('button', { class: 'btn small primary', onclick: async () => {
                    if (await confirmDialog('อนุมัติการทำงานวันหยุด', `อนุมัติ ${r.normal_hours} ชม.ปกติ + ${r.ot_hours} ชม. OT ของ ${r.emp_code} วันที่ ${thaiDate(r.work_date)}? การอนุมัติถือเป็นการยืนยันว่าชั่วโมงนี้ไม่ได้รวมอยู่ใน OT ปกติที่ยืนยันแล้ว`, 'อนุมัติ')) {
                      await act(() => post(`/api/holidays/work/${r.id}/approve`, { excluded_from_regular_ot: true }), 'อนุมัติแล้ว')();
                    }
                  } }, 'อนุมัติ'),
                   h('button', { class: 'btn small', onclick: async () => {
                     const reason = await promptDialog('ไม่อนุมัติ', 'เหตุผล', 'ไม่อนุมัติ');
                     if (reason) await act(() => post(`/api/holidays/work/${r.id}/reject`, { reason }), 'บันทึกแล้ว')();
                   } }, 'ไม่อนุมัติ')]
                : null,
              (r.status === 'pending' || r.status === 'approved') && !r.payroll_period_id && data.can.update
                ? h('button', { class: 'btn small', onclick: async () => {
                    const reason = await promptDialog('ยกเลิกบันทึก', 'เหตุผล', 'ยกเลิกบันทึก');
                    if (reason) await act(() => post(`/api/holidays/work/${r.id}/cancel`, { reason }), 'ยกเลิกแล้ว')();
                  } }, 'ยกเลิก')
                : null))))))
      : h('div', { class: 'card empty' }, 'ยังไม่มีบันทึกการทำงานวันหยุดในปีนี้'));
}

async function workForm(holidays: HolidayRow[], reload: () => void): Promise<void> {
  let employees: LookupOption[];
  try {
    employees = await get<LookupOption[]>('/api/lookup/employees');
  } catch (e) {
    return toast(msg(e), 'error');
  }
  const emp = select(employees.map((e): [string, string] => [String(e.value), e.label]), null, { 'aria-label': 'พนักงาน' });
  const hol = select(holidays.map((x): [string, string] => [String(x.id), `${thaiDate(x.holiday_date)} · ${x.name}${x.company ? ` (${x.company})` : ''}`]), null, { 'aria-label': 'วันหยุด' });
  const normal = h('input', { type: 'number', min: 0, max: 24, step: 0.25, value: '8' });
  const ot = h('input', { type: 'number', min: 0, max: 24, step: 0.25, value: '0' });
  const source = select([['attendance', 'บันทึกเวลาเข้า-ออก (Attendance)'], ['feishu', 'ข้อมูลนำเข้า Feishu'], ['manual', 'เอกสารอ้างอิง (บันทึกเอง)']], 'attendance', { 'aria-label': 'หลักฐาน' });
  const refId = h('input', { type: 'number', min: 1, placeholder: 'เลขที่รายการ' });
  const evidence = h('input', { maxlength: 500, placeholder: 'เช่น เลขที่ใบอนุมัติทำงานวันหยุด / รายละเอียดจากรายงาน Feishu' });
  const note = h('input', { maxlength: 500 });
  const m = modal('บันทึกการทำงานวันหยุด', h('div', { class: 'grid-form' },
    field('พนักงาน', emp), field('วันหยุด (อนุมัติแล้ว)', hol), field('ชั่วโมงในเวลาปกติ', normal), field('ชั่วโมง OT วันหยุด', ot, 'นับได้เมื่อทำงานครบเวลาปกติแล้ว'),
    field('แหล่งหลักฐาน', source), field('เลขที่บันทึกเวลา / แถวข้อมูล Feishu', refId, 'สำหรับ Attendance / Feishu'), field('รายละเอียดหลักฐาน', evidence), field('หมายเหตุ', note)), [
    h('button', { class: 'btn', onclick: () => m.close() }, 'ยกเลิก'),
    h('button', { class: 'btn primary', onclick: async () => {
      const body: Record<string, unknown> = { employee_id: Number(emp.value), holiday_id: Number(hol.value), normal_hours: Number(normal.value), ot_hours: Number(ot.value), evidence_source: source.value, evidence_ref: evidence.value, note: note.value };
      if (source.value === 'attendance') body.attendance_record_id = Number(refId.value);
      if (source.value === 'feishu') body.attendance_import_row_id = Number(refId.value);
      try {
        await post('/api/holidays/work', body);
        toast('บันทึกแล้ว (รออนุมัติ)');
        m.close();
        reload();
      } catch (e) {
        toast(msg(e), 'error');
      }
    } }, 'บันทึก'),
  ]);
}

// ---- pay rules -----------------------------------------------------------------------------------
async function rulesView(data: HolidayListResponse, reload: () => void): Promise<HTMLElement> {
  const rules = await get<HolidayPayRuleRow[]>('/api/holidays/pay-rules');
  const act = (fn: () => Promise<unknown>, done: string) => async () => {
    try {
      await fn();
      toast(done);
      reload();
    } catch (e) {
      toast(msg(e), 'error');
    }
  };
  return h('div', { class: 'stack' },
    h('div', { class: 'card' },
      h('p', null, 'ค่าทำงานในวันหยุดคิดจากค่าจ้างรายชั่วโมง = เงินเดือน ÷ จำนวนวันหาร ÷ ชั่วโมงทำงานต่อวัน (ค่าตั้งเดียวกับ OT ปกติ)'),
      h('ul', { class: 'small' },
        h('li', null, 'ผู้มีสิทธิได้รับค่าจ้างในวันหยุด ทำงานในเวลาปกติ: เพิ่มไม่น้อยกว่า 1 เท่า (เงินเดือนรวมค่าจ้างของวันหยุดแล้ว)'),
        h('li', null, 'ผู้ไม่มีสิทธิได้รับค่าจ้างในวันหยุด ทำงานในเวลาปกติ: เพิ่มไม่น้อยกว่า 2 เท่า'),
        h('li', null, 'ล่วงเวลาในวันหยุด: ไม่น้อยกว่า 3 เท่า')),
      h('p', { class: 'muted small' }, 'สิทธิได้รับค่าจ้างในวันหยุดกำหนดตามประเภทการจ้างโดย HR/ฝ่ายกฎหมาย และต้องอนุมัติโดยผู้อื่นก่อนใช้ ถ้าพนักงานมีการทำงานวันหยุดที่อนุมัติแล้วแต่ไม่มีกฎที่อนุมัติ ระบบจะไม่คำนวณงวดนั้น')),
    data.can.create ? h('div', { class: 'toolbar' }, h('button', { class: 'btn small primary', onclick: () => ruleForm(data, reload) }, '+ เพิ่มกฎค่าจ้างวันหยุด')) : null,
    rules.length
      ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
          h('thead', null, h('tr', null, ['บริษัท', 'ประเภทการจ้าง', 'สิทธิค่าจ้างวันหยุด', 'ทำงานวันหยุด (เท่า)', 'OT วันหยุด (เท่า)', 'มีผล', 'หลักการ', 'สถานะ', ''].map((x) => h('th', null, x)))),
          h('tbody', null, rules.map((r) => h('tr', null,
            h('td', null, r.company ?? 'ทุกบริษัท'), h('td', null, optionLabel(r.employment_type)), h('td', null, r.holiday_pay_entitled ? 'มีสิทธิ' : 'ไม่มีสิทธิ'),
            h('td', { class: 'num' }, fmtNum(r.work_multiplier)), h('td', { class: 'num' }, fmtNum(r.ot_multiplier)),
            h('td', null, `${thaiDate(r.effective_from)} – ${r.effective_to ? thaiDate(r.effective_to) : 'ไม่กำหนด'}`), h('td', { class: 'small' }, r.legal_basis),
            h('td', null, statusBadge(r.status), r.approved_by_name ? h('div', { class: 'muted small' }, r.approved_by_name) : null),
            h('td', null,
              r.status === 'draft' && data.can.approve ? h('button', { class: 'btn small primary', onclick: act(() => post(`/api/holidays/pay-rules/${r.id}/approve`), 'อนุมัติกฎแล้ว') }, 'อนุมัติ') : null,
              r.status !== 'inactive' && data.can.delete
                ? h('button', { class: 'btn small', onclick: async () => {
                    const reason = await promptDialog('ปิดใช้งานกฎ', 'เหตุผล', 'ปิดใช้งาน');
                    if (reason) await act(() => post(`/api/holidays/pay-rules/${r.id}/deactivate`, { reason }), 'ปิดใช้งานแล้ว')();
                  } }, 'ปิดใช้งาน')
                : null))))))
      : h('div', { class: 'card empty' }, 'ยังไม่มีกฎค่าจ้างวันหยุด'));
}

function ruleForm(data: HolidayListResponse, reload: () => void): void {
  const co = select([...(data.can.allCompanies ? [['', 'ทุกบริษัท'] as [string, string]] : []), ...companies().map((c): [string, string] => [String(c.id), c.name])], null, { 'aria-label': 'บริษัท' });
  const type = select(EMPLOYMENT_TYPES.map((t): [string, string] => [t, optionLabel(t)]), 'permanent', { 'aria-label': 'ประเภทการจ้าง' });
  const entitled = select([['true', 'มีสิทธิได้รับค่าจ้างในวันหยุด'], ['false', 'ไม่มีสิทธิได้รับค่าจ้างในวันหยุด']], 'true', { 'aria-label': 'สิทธิ' });
  const work = h('input', { type: 'number', min: 1, max: 10, step: 0.25, value: '1' });
  const ot = h('input', { type: 'number', min: 3, max: 10, step: 0.25, value: '3' });
  entitled.addEventListener('change', () => {
    work.min = entitled.value === 'true' ? '1' : '2';
    if (Number(work.value) < Number(work.min)) work.value = work.min;
  });
  const from = h('input', { type: 'date', required: true });
  const to = h('input', { type: 'date' });
  const basis = h('textarea', { rows: 2, maxlength: 500, placeholder: 'เช่น พ.ร.บ.คุ้มครองแรงงาน มาตรา 56, 62, 63 · มติ/ประกาศบริษัท เลขที่ …' });
  const m = modal('เพิ่มกฎค่าจ้างวันหยุด', h('div', { class: 'grid-form' },
    field('บริษัท', co), field('ประเภทการจ้าง', type), field('สิทธิค่าจ้างวันหยุด', entitled), field('ทำงานวันหยุดในเวลาปกติ (เท่า)', work, 'ขั้นต่ำ 1 เท่า (มีสิทธิ) / 2 เท่า (ไม่มีสิทธิ)'),
    field('OT ในวันหยุด (เท่า)', ot, 'ขั้นต่ำ 3 เท่า'), field('มีผลตั้งแต่', from), field('ถึง (เว้นว่างได้)', to), field('หลักการ / อ้างอิง', basis)), [
    h('button', { class: 'btn', onclick: () => m.close() }, 'ยกเลิก'),
    h('button', { class: 'btn primary', onclick: async () => {
      try {
        await post('/api/holidays/pay-rules', {
          company_id: co.value ? Number(co.value) : null, employment_type: type.value, holiday_pay_entitled: entitled.value === 'true',
          work_multiplier: Number(work.value), ot_multiplier: Number(ot.value), effective_from: from.value, effective_to: to.value || null, legal_basis: (basis as HTMLTextAreaElement).value,
        });
        toast('บันทึกกฎแล้ว (ร่าง ต้องให้ผู้อื่นอนุมัติ)');
        m.close();
        reload();
      } catch (e) {
        toast(msg(e), 'error');
      }
    } }, 'บันทึก'),
  ]);
}

