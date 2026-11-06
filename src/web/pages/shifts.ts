// Shift settings, shift groups (members, default shift history, transfer, sync) and the group schedule calendar
// (month / week, daily and bulk assignment, rotation, copy day / week / month, day off, holiday, clear, conflict
// check and confirmation before saving). All data comes from /api/shifts; the API enforces every rule again.
import type { CompanyOption } from '../../shared/types';
import { SHIFT_TYPE_LABEL, WEEKDAY_SHORT, dateRange, formatDuration, monthEnd, netWorkMinutes, rotate, shiftProblems, shiftSpan, type BreakPeriod, type ShiftType } from '../../shared/shifts';
import { THAI_MONTHS_FULL, buddhistYear, weekday } from '../../shared/holidays';
import { addDays } from '../../shared/payroll';
import { get, post, put, qs } from '../api';
import { h, mount, loading, errorBox, fmtDate, fmtNum, modal, toast, type Child } from '../dom';
import { can, link, navigate, state } from '../app';
import { companies, noCompanies } from './attendance';

interface Shift {
  id: number;
  code: string;
  name: string;
  company_id: number | null;
  company: string | null;
  shift_type: ShiftType;
  start_time: string;
  end_time: string;
  breaks: BreakPeriod[];
  work_day_list: number[];
  net_minutes: number;
  color: string | null;
  clock_in_before_minutes: number;
  clock_out_after_minutes: number;
  late_grace_minutes: number;
  early_leave_grace_minutes: number;
  ot_eligible: number;
  active: number;
  used_by_groups?: number;
  used_in_schedule?: number;
}
interface Group {
  id: number;
  code: string;
  name: string;
  company_id: number;
  company: string;
  department_id: number | null;
  department: string | null;
  owner_employee_id: number | null;
  owner: string | null;
  membership: 'manual' | 'department' | 'company';
  shift_type: ShiftType;
  status: 'active' | 'inactive';
  description: string | null;
  members: number;
  default_shift_id: number | null;
  default_shift: string | null;
  default_effective_date: string | null;
}
interface Person {
  id: number;
  emp_code: string;
  name: string;
  department_id: number | null;
  department: string | null;
  group_id: number | null;
  group_code: string | null;
}
interface People {
  company: CompanyOption;
  departments: Array<{ id: number; code: string; name: string }>;
  employees: Person[];
}

const MEMBERSHIP_LABEL: Record<Group['membership'], string> = { manual: 'เลือกพนักงานเอง (Manual)', department: 'ตามหน่วยงาน (Department)', company: 'ทั้งบริษัท (Company)' };
const METHOD_LABEL: Record<string, string> = { manual: 'เพิ่มเอง', department: 'Sync หน่วยงาน', company: 'Sync บริษัท', transfer: 'ย้ายกลุ่ม' };
const today = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const companySel = (selected: number, onChange: (id: number) => void, label = 'บริษัท') =>
  h('select', { 'aria-label': label, onchange: (e: Event) => onChange(Number((e.target as HTMLSelectElement).value)) }, companies().map((c) => h('option', { value: String(c.id), selected: c.id === selected }, `${c.name} (${c.code})`)));
const field = (label: string, control: Child, extra = '') => h('label', { class: `field ${extra}` }, h('span', null, label), control);
const shiftLabel = (s: Pick<Shift, 'code' | 'name' | 'start_time' | 'end_time'>) => `${s.code} ${s.name} (${s.start_time}–${s.end_time})`;

// ===== Shift settings ===========================================================================
export async function renderShiftSettings(main: HTMLElement): Promise<void> {
  mount(main, loading());
  try {
    const shifts = await get<Shift[]>('/api/shifts/settings');
    const reload = () => void renderShiftSettings(main);
    mount(main, h('div', { class: 'stack' },
      h('div', { class: 'toolbar' }, h('p', { class: 'muted' }, 'กำหนดเวลาเข้า–เลิกงาน ช่วงพักหลายช่วง วันทำงาน และกฎการมาสาย/ออกก่อน (กะข้ามวันรองรับ เช่น 22:00–07:00)'), h('div', { class: 'spacer' }),
        can('shifts.create') ? h('button', { class: 'btn primary', onclick: () => shiftEditor(null, reload) }, '+ เพิ่มกะ') : null),
      shifts.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'table shift-table' },
            h('thead', null, h('tr', null, ['รหัส', 'ชื่อกะ', 'บริษัท', 'ประเภท', 'เวลาทำงาน', 'เวลาพัก', 'ชั่วโมงสุทธิ', 'วันทำงาน', 'สาย / ออกก่อน (ผ่อนผัน)', 'OT', 'สถานะ', ''].map((t) => h('th', null, t)))),
            h('tbody', null, shifts.map((s) => h('tr', { 'data-code': s.code },
              h('td', null, h('span', { class: 'shift-swatch', style: `--shift-color:${s.color ?? '#94a3b8'}` }), s.code), h('td', null, s.name), h('td', null, s.company ?? 'ทุกบริษัท'), h('td', null, SHIFT_TYPE_LABEL[s.shift_type]),
              h('td', null, `${s.start_time}–${s.end_time}`, shiftSpan(s).overnight ? h('span', { class: 'badge-status s-pending', title: 'กะข้ามวัน' }, ' ข้ามวัน') : null),
              h('td', null, s.breaks.length ? s.breaks.map((b) => `${b.start}–${b.end}`).join(', ') : '-'),
              h('td', null, formatDuration(s.net_minutes)), h('td', null, s.work_day_list.map((d) => WEEKDAY_SHORT[d]).join(' ')),
              h('td', null, `${s.late_grace_minutes} / ${s.early_leave_grace_minutes} นาที`), h('td', null, s.ot_eligible ? 'มีสิทธิ์' : '-'),
              h('td', null, h('span', { class: `badge-status ${s.active ? 's-active' : ''}` }, s.active ? 'ใช้งาน' : 'ปิดใช้งาน')),
              h('td', null, can('shifts.update') ? h('button', { class: 'btn small', onclick: () => shiftEditor(s, reload) }, 'แก้ไข') : null))))))
        : h('div', { class: 'card' }, h('div', { class: 'empty' }, 'ยังไม่มีกะการทำงาน')),
    ));
  } catch (e) {
    mount(main, errorBox(e));
  }
}

function shiftEditor(s: Shift | null, done: () => void): void {
  const scopeAll = state.meta?.companies.scope === 'all';
  const v = (name: string, value: string | number, attrs: Record<string, unknown> = {}) => h('input', { name, value: String(value), ...attrs });
  const code = v('code', s?.code ?? '', { maxlength: 20, required: true, autocomplete: 'off' });
  const name = v('name', s?.name ?? '', { maxlength: 100, required: true });
  const company = h('select', { name: 'company_id' }, scopeAll ? h('option', { value: '' }, 'ทุกบริษัท') : null,
    companies().map((c) => h('option', { value: String(c.id), selected: s?.company_id === c.id || (!s && !scopeAll && c.id === state.companyId) }, c.name)));
  const type = h('select', { name: 'shift_type' }, (['fixed', 'scheduled'] as const).map((t) => h('option', { value: t, selected: (s?.shift_type ?? 'fixed') === t }, SHIFT_TYPE_LABEL[t])));
  const start = v('start_time', s?.start_time ?? '08:00', { type: 'time', required: true });
  const end = v('end_time', s?.end_time === '24:00' ? '00:00' : (s?.end_time ?? '17:00'), { type: 'time', required: true });
  const color = v('color', s?.color ?? '#2563eb', { type: 'color' });
  const breaks = h('div', { class: 'break-list' });
  const addBreak = (b: BreakPeriod) => {
    const row = h('div', { class: 'break-row' },
      h('input', { type: 'time', value: b.start, 'aria-label': 'เริ่มพัก', class: 'b-start', oninput: () => refresh() }), h('span', null, '–'),
      h('input', { type: 'time', value: b.end, 'aria-label': 'สิ้นสุดพัก', class: 'b-end', oninput: () => refresh() }),
      h('button', { type: 'button', class: 'btn small', 'aria-label': 'ลบช่วงพัก', onclick: () => { row.remove(); refresh(); } }, 'ลบ'));
    breaks.append(row);
  };
  (s ? s.breaks : [{ start: '12:00', end: '13:00' }]).forEach(addBreak);
  const days = h('div', { class: 'checks weekday-checks' }, [1, 2, 3, 4, 5, 6, 0].map((d) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', value: String(d), checked: (s?.work_day_list ?? [1, 2, 3, 4, 5]).includes(d), onchange: () => refresh() }), WEEKDAY_SHORT[d])));
  const num = (n: string, val: number, max: number) => v(n, val, { type: 'number', min: 0, max, step: 1 });
  const inBefore = num('clock_in_before_minutes', s?.clock_in_before_minutes ?? 120, 720);
  const outAfter = num('clock_out_after_minutes', s?.clock_out_after_minutes ?? 240, 720);
  const lateGrace = num('late_grace_minutes', s?.late_grace_minutes ?? 0, 240);
  const earlyGrace = num('early_leave_grace_minutes', s?.early_leave_grace_minutes ?? 0, 240);
  const ot = h('input', { type: 'checkbox', name: 'ot_eligible', checked: !!s?.ot_eligible });
  const active = h('input', { type: 'checkbox', name: 'active', checked: s ? !!s.active : true });
  const summary = h('div', { class: 'alert shift-summary', 'aria-live': 'polite' });
  const readBreaks = (): BreakPeriod[] => [...breaks.querySelectorAll('.break-row')].map((r) => ({ start: (r.querySelector('.b-start') as HTMLInputElement).value, end: (r.querySelector('.b-end') as HTMLInputElement).value }));
  const readDays = () => [...days.querySelectorAll('input:checked')].map((i) => Number((i as HTMLInputElement).value));
  const endValue = () => (end.value === '00:00' ? '24:00' : end.value);
  const refresh = () => {
    const probs = shiftProblems({ start_time: start.value, end_time: endValue(), breaks: readBreaks(), work_days: readDays() });
    if (probs.length) return mount(summary, h('ul', { class: 'issues' }, probs.map((p) => h('li', { class: 'issue-error' }, p))));
    const t = { start_time: start.value, end_time: endValue(), breaks: readBreaks() };
    const span = shiftSpan(t);
    mount(summary, `เวลาทำงานสุทธิ ${formatDuration(netWorkMinutes(t))} (ช่วงกะ ${formatDuration(span.end - span.start)} หักพัก ${formatDuration(span.end - span.start - netWorkMinutes(t))})${span.overnight ? ' · กะข้ามวัน: เลิกงานวันถัดไป' : ''}`);
  };
  [start, end].forEach((x) => x.addEventListener('input', refresh));
  refresh();
  const errorArea = h('div');
  const save = async () => {
    const body = {
      code: code.value, name: name.value, company_id: company.value ? Number(company.value) : null, shift_type: type.value, start_time: start.value, end_time: endValue(), breaks: readBreaks(),
      work_days: readDays(), color: color.value, clock_in_before_minutes: Number(inBefore.value), clock_out_after_minutes: Number(outAfter.value), late_grace_minutes: Number(lateGrace.value),
      early_leave_grace_minutes: Number(earlyGrace.value), ot_eligible: ot.checked, active: active.checked,
    };
    try {
      if (s) await put(`/api/shifts/settings/${s.id}`, body);
      else await post('/api/shifts/settings', body);
      m.close();
      toast('บันทึกกะแล้ว');
      done();
    } catch (e) {
      mount(errorArea, errorBox(e));
    }
  };
  const m = modal(s ? `แก้ไขกะ ${s.code}` : 'เพิ่มกะการทำงาน', h('div', { class: 'stack shift-form' },
    h('div', { class: 'grid-form' }, field('รหัสกะ *', code), field('ชื่อกะ *', name), field('บริษัท', company), field('ประเภทกะ', type), field('เวลาเข้างาน *', start), field('เวลาเลิกงาน *', end), field('สีประจำกะ', color)),
    h('fieldset', { class: 'plain' }, h('legend', null, 'ช่วงเวลาพัก'), breaks, h('button', { type: 'button', class: 'btn small', onclick: () => { addBreak({ start: '15:00', end: '15:15' }); refresh(); } }, '+ เพิ่มช่วงพัก')),
    h('fieldset', { class: 'plain' }, h('legend', null, 'วันทำงาน'), days),
    h('fieldset', { class: 'plain' }, h('legend', null, 'กฎการลงเวลา'), h('div', { class: 'grid-form' },
      field('ลงเวลาเข้าได้ก่อนเริ่มกะ (นาที)', inBefore), field('ลงเวลาออกได้หลังเลิกกะ (นาที)', outAfter),
      field('ผ่อนผันมาสาย (นาที)', lateGrace), field('ผ่อนผันออกก่อน (นาที)', earlyGrace))),
    h('label', { class: 'check' }, ot, ' มีสิทธิ์ทำ OT (ข้อมูลประกอบ การคิด OT ยังใช้คำขอ OT ตามระบบเดิม)'),
    h('label', { class: 'check' }, active, ' ใช้งาน'),
    summary, errorArea),
  [h('button', { class: 'btn', onclick: () => m.close() }, 'ยกเลิก'), h('button', { class: 'btn primary', onclick: () => void save() }, 'บันทึก')]);
}

// ===== Shift groups =============================================================================
export async function renderShiftGroups(main: HTMLElement, params: URLSearchParams): Promise<void> {
  if (!companies().length) return mount(main, noCompanies());
  mount(main, loading());
  try {
    if (params.get('id')) return await renderGroupDetail(main, Number(params.get('id')));
    const groups = await get<Group[]>(`/api/shifts/groups${qs({ company: state.companyId })}`);
    const reload = () => void renderShiftGroups(main, params);
    mount(main, h('div', { class: 'stack' },
      h('div', { class: 'toolbar' }, h('p', { class: 'muted' }, 'จัดพนักงานเป็นกลุ่มเพื่อใช้กะประจำหรือจัดตารางกะร่วมกัน พนักงานหนึ่งคนอยู่ได้หนึ่งกลุ่มในแต่ละวัน'), h('div', { class: 'spacer' }),
        link('/shifts/schedule', 'ตารางกะกลุ่ม', { class: 'btn' }), can('shift_groups.manage') ? h('button', { class: 'btn primary', onclick: () => void groupEditor(null, reload) }, '+ สร้างกลุ่ม') : null),
      groups.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'table group-table' },
            h('thead', null, h('tr', null, ['รหัส', 'ชื่อกลุ่ม', 'บริษัท', 'หน่วยงาน', 'วิธีเลือกสมาชิก', 'ประเภทกะ', 'กะประจำ', 'สมาชิก', 'สถานะ'].map((t) => h('th', null, t)))),
            h('tbody', null, groups.map((g) => h('tr', { 'data-code': g.code },
              h('td', null, link(`/shifts/groups?id=${g.id}`, g.code)), h('td', null, g.name), h('td', null, g.company), h('td', null, g.department ?? '-'), h('td', null, MEMBERSHIP_LABEL[g.membership]),
              h('td', null, SHIFT_TYPE_LABEL[g.shift_type]), h('td', null, g.default_shift ?? '-'), h('td', null, fmtNum(g.members)),
              h('td', null, h('span', { class: `badge-status ${g.status === 'active' ? 's-active' : ''}` }, g.status === 'active' ? 'ใช้งาน' : 'ปิดใช้งาน')))))))
        : h('div', { class: 'card' }, h('div', { class: 'empty' }, 'ยังไม่มีกลุ่มกะ')),
    ));
  } catch (e) {
    mount(main, errorBox(e));
  }
}

async function groupEditor(g: Group | null, done: (id?: number) => void): Promise<void> {
  let companyId = g?.company_id ?? state.companyId ?? companies()[0]!.id;
  const [shifts, people] = await Promise.all([get<Shift[]>('/api/shifts/settings'), get<People>(`/api/shifts/people${qs({ company: companyId })}`)]);
  const code = h('input', { value: g?.code ?? '', maxlength: 20, required: true });
  const name = h('input', { value: g?.name ?? '', maxlength: 100, required: true });
  const dept = h('select', { name: 'department_id' });
  const owner = h('select', { name: 'owner_employee_id' });
  const def = h('select', { name: 'default_shift_id' });
  const fillCompany = (p: People) => {
    dept.replaceChildren(h('option', { value: '' }, '— ไม่ระบุ —'), ...p.departments.map((d) => h('option', { value: String(d.id), selected: g?.department_id === d.id }, `${d.name} (${d.code})`)));
    owner.replaceChildren(h('option', { value: '' }, '— ไม่ระบุ —'), ...p.employees.map((e) => h('option', { value: String(e.id), selected: g?.owner_employee_id === e.id }, `${e.emp_code} ${e.name}`)));
    def.replaceChildren(h('option', { value: '' }, '— เลือกกะ —'), ...shifts.filter((s) => s.active && (s.company_id === null || s.company_id === companyId)).map((s) => h('option', { value: String(s.id) }, shiftLabel(s))));
  };
  fillCompany(people);
  const company = g ? h('input', { value: g.company, disabled: true }) : companySel(companyId, async (id) => { companyId = id; fillCompany(await get<People>(`/api/shifts/people${qs({ company: id })}`)); });
  const membership = h('select', null, (['manual', 'department', 'company'] as const).map((k) => h('option', { value: k, selected: (g?.membership ?? 'manual') === k }, MEMBERSHIP_LABEL[k])));
  const type = h('select', null, (['fixed', 'scheduled'] as const).map((t) => h('option', { value: t, selected: (g?.shift_type ?? 'fixed') === t }, SHIFT_TYPE_LABEL[t])));
  const effective = h('input', { type: 'date', value: today() });
  const status = h('select', null, h('option', { value: 'active', selected: g?.status !== 'inactive' }, 'ใช้งาน'), h('option', { value: 'inactive', selected: g?.status === 'inactive' }, 'ปิดใช้งาน'));
  const desc = h('textarea', { rows: 2, maxlength: 500 }, g?.description ?? '');
  const errorArea = h('div');
  const save = async () => {
    const body: Record<string, unknown> = {
      code: code.value, name: name.value, company_id: companyId, department_id: dept.value ? Number(dept.value) : null, owner_employee_id: owner.value ? Number(owner.value) : null,
      membership: membership.value, shift_type: type.value, status: status.value, description: desc.value,
    };
    if (!g) Object.assign(body, { default_shift_id: def.value ? Number(def.value) : null, default_effective_date: effective.value });
    try {
      const r = g ? await put<Group>(`/api/shifts/groups/${g.id}`, body) : await post<Group>('/api/shifts/groups', body);
      m.close();
      toast('บันทึกกลุ่มแล้ว');
      done(r.id);
    } catch (e) {
      mount(errorArea, errorBox(e));
    }
  };
  const m = modal(g ? `แก้ไขกลุ่ม ${g.code}` : 'สร้างกลุ่มกะ', h('div', { class: 'stack' },
    h('div', { class: 'grid-form' }, field('รหัสกลุ่ม *', code), field('ชื่อกลุ่ม *', name), field('บริษัท *', company), field('หน่วยงาน', dept), field('ผู้รับผิดชอบกลุ่ม', owner),
      field('วิธีเลือกสมาชิก (Group Type)', membership), field('ประเภทกะ (Shift Type)', type), g ? null : field('กะประจำของกลุ่ม (กลุ่มกะประจำต้องเลือก)', def), g ? null : field('กะประจำมีผลตั้งแต่', effective), field('สถานะ', status),
      field('คำอธิบาย', desc, 'span2')),
    g ? h('p', { class: 'muted small' }, 'การเปลี่ยนกะประจำทำที่หน้ารายละเอียดกลุ่ม (มีผลตามวันที่กำหนด ไม่เปลี่ยนข้อมูลย้อนหลัง)') : null, errorArea),
  [h('button', { class: 'btn', onclick: () => m.close() }, 'ยกเลิก'), h('button', { class: 'btn primary', onclick: () => void save() }, 'บันทึก')]);
}

interface GroupDetail {
  group: Group;
  today: string;
  defaults: Array<{ id: number; shift_id: number; shift: string; effective_date: string; created_at: string; created_by: string | null }>;
  members: Array<{ id: number; employee_id: number; emp_code: string; name: string; department: string | null; start_date: string; end_date: string | null; method: string; note: string | null; created_by: string | null; ended_by: string | null }>;
  history: Array<{ id: number; at: string; username: string | null; action: string; details: string | null }>;
}
const ACTION_LABEL: Record<string, string> = {
  'shift_group.created': 'สร้างกลุ่ม', 'shift_group.updated': 'แก้ไขกลุ่ม', 'shift_group.default_changed': 'เปลี่ยนกะประจำ', 'shift_group.members_added': 'เพิ่มสมาชิก',
  'shift_group.members_removed': 'นำสมาชิกออก', 'shift_group.members_transferred': 'ย้ายสมาชิกเข้ากลุ่ม', 'shift_group.synced': 'Sync สมาชิก', 'shift_group.deleted': 'ลบกลุ่ม',
};

/** A reason field shown when the chosen date is in the past (the API requires one then). */
function reasonField(dateInput: HTMLInputElement): { el: HTMLElement; value: () => string | null } {
  const input = h('input', { type: 'text', maxlength: 500, placeholder: 'เหตุผลการแก้ไขย้อนหลัง' });
  const wrap = h('label', { class: 'field', hidden: true }, h('span', null, 'เหตุผล (จำเป็นเมื่อเป็นวันที่ย้อนหลัง)'), input);
  const sync = () => { wrap.hidden = !(dateInput.value && dateInput.value < today()); };
  dateInput.addEventListener('input', sync);
  sync();
  return { el: wrap, value: () => input.value.trim() || null };
}

async function renderGroupDetail(main: HTMLElement, id: number): Promise<void> {
  const d = await get<GroupDetail>(`/api/shifts/groups/${id}`);
  const g = d.group;
  const manage = can('shift_groups.manage');
  const reload = () => void renderGroupDetail(main, id);
  const current = d.members.filter((m) => m.end_date === null || m.end_date >= d.today);
  const past = d.members.filter((m) => !(m.end_date === null || m.end_date >= d.today));
  const checks = new Map<number, HTMLInputElement>();
  const selected = () => [...checks].filter(([, c]) => c.checked).map(([emp]) => emp);
  let tab: 'members' | 'history' = 'members';

  const addMembers = async () => {
    const people = await get<People>(`/api/shifts/people${qs({ company: g.company_id })}`);
    const free = people.employees.filter((e) => e.group_id === null);
    const search = h('input', { type: 'search', placeholder: 'ค้นหารหัส / ชื่อ / หน่วยงาน', 'aria-label': 'ค้นหาพนักงาน' });
    const box = h('div', { class: 'pick-list' });
    const picks = new Map<number, HTMLInputElement>();
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      box.replaceChildren(...free.filter((e) => !q || `${e.emp_code} ${e.name} ${e.department ?? ''}`.toLowerCase().includes(q)).map((e) => {
        const c = picks.get(e.id) ?? h('input', { type: 'checkbox', value: String(e.id) });
        picks.set(e.id, c);
        return h('label', { class: 'check' }, c, ` ${e.emp_code} ${e.name}`, e.department ? h('span', { class: 'muted small' }, ` · ${e.department}`) : null);
      }));
      if (!box.childElementCount) box.append(h('p', { class: 'muted' }, 'ไม่มีพนักงานที่ยังไม่อยู่ในกลุ่ม'));
    };
    search.addEventListener('input', draw);
    draw();
    const start = h('input', { type: 'date', value: d.today });
    const reason = reasonField(start);
    const out = h('div');
    const go = async () => {
      const ids = [...picks].filter(([, c]) => c.checked).map(([k]) => k);
      if (!ids.length) return toast('กรุณาเลือกพนักงาน', 'error');
      try {
        const r = await post<{ add: unknown[]; conflicts: Array<{ emp_code: string | null; message: string }> }>(`/api/shifts/groups/${g.id}/members`, { employee_ids: ids, start_date: start.value, reason: reason.value() });
        m.close();
        toast(`เพิ่มสมาชิก ${r.add.length} คน${r.conflicts.length ? ` (ข้าม ${r.conflicts.length} คน)` : ''}`);
        reload();
      } catch (e) {
        mount(out, errorBox(e));
      }
    };
    const m = modal(`เพิ่มสมาชิก (Bulk Add) · ${g.code}`, h('div', { class: 'stack' },
      h('p', { class: 'muted small' }, 'แสดงเฉพาะพนักงานของบริษัทเดียวกันที่ยังไม่อยู่ในกลุ่มใด (ผู้ที่อยู่กลุ่มอื่นให้ใช้ "ย้ายกลุ่ม")'),
      search, h('div', { class: 'toolbar' }, h('button', { class: 'btn small', onclick: () => box.querySelectorAll('input').forEach((c) => { (c as HTMLInputElement).checked = true; }) }, 'เลือกทั้งหมดที่แสดง')),
      box, field('เริ่มเป็นสมาชิกตั้งแต่', start), reason.el, out),
    [h('button', { class: 'btn', onclick: () => m.close() }, 'ยกเลิก'), h('button', { class: 'btn primary', onclick: () => void go() }, 'เพิ่มสมาชิก')]);
  };

  const removeMembers = async () => {
    const ids = selected();
    if (!ids.length) return toast('กรุณาเลือกสมาชิก', 'error');
    const end = h('input', { type: 'date', value: d.today });
    const reason = reasonField(end);
    const out = h('div');
    const m = modal(`นำสมาชิกออก ${ids.length} คน`, h('div', { class: 'stack' }, h('p', null, 'สมาชิกจะอยู่ในกลุ่มถึงวันที่เลือก (ประวัติการเป็นสมาชิกยังเก็บไว้)'), field('วันสุดท้ายในกลุ่ม', end), reason.el, out),
      [h('button', { class: 'btn', onclick: () => m.close() }, 'ยกเลิก'), h('button', { class: 'btn danger', onclick: async () => {
        try {
          await post(`/api/shifts/groups/${g.id}/members/remove`, { employee_ids: ids, end_date: end.value, reason: reason.value() });
          m.close();
          toast('นำสมาชิกออกแล้ว');
          reload();
        } catch (e) {
          mount(out, errorBox(e));
        }
      } }, 'นำออก')]);
  };

  const transfer = async () => {
    const ids = selected();
    if (!ids.length) return toast('กรุณาเลือกสมาชิกที่จะย้าย', 'error');
    const groups = (await get<Group[]>(`/api/shifts/groups${qs({ company: g.company_id })}`)).filter((x) => x.id !== g.id && x.status === 'active');
    if (!groups.length) return toast('ยังไม่มีกลุ่มอื่นในบริษัทนี้', 'error');
    const target = h('select', null, groups.map((x) => h('option', { value: String(x.id) }, `${x.code} ${x.name} · ${SHIFT_TYPE_LABEL[x.shift_type]}`)));
    const date = h('input', { type: 'date', value: d.today });
    const reason = reasonField(date);
    const impact = h('div', { 'aria-live': 'polite' });
    const body = () => ({ employee_ids: ids, date: date.value, reason: reason.value() });
    type Move = { emp_code: string; from_group: string | null; group_entries: number; overrides: number };
    const check = async () => {
      mount(impact, loading());
      try {
        const r = await post<{ moves: Move[]; conflicts: Array<{ emp_code: string | null; message: string }> }>(`/api/shifts/groups/${target.value}/transfer`, { ...body(), dry_run: true });
        mount(impact, h('div', { class: 'stack' },
          h('h3', null, 'ผลกระทบต่อตารางกะเดิม'),
          r.moves.length ? h('table', { class: 'table compact' }, h('thead', null, h('tr', null, ['พนักงาน', 'จากกลุ่ม', 'ตารางกะของกลุ่มเดิมที่จะถูกล้าง (ตั้งแต่วันที่ย้าย)', 'ปรับรายบุคคลที่ยังคงอยู่'].map((t) => h('th', null, t)))),
            h('tbody', null, r.moves.map((x) => h('tr', null, h('td', null, x.emp_code), h('td', null, x.from_group ?? '-'), h('td', null, `${x.group_entries} วัน`), h('td', null, `${x.overrides} วัน`))))) : null,
          r.conflicts.length ? h('ul', { class: 'issues' }, r.conflicts.map((x) => h('li', { class: 'issue-error' }, `${x.emp_code ?? ''} ${x.message}`))) : null));
        apply.disabled = !r.moves.length;
      } catch (e) {
        mount(impact, errorBox(e));
      }
    };
    const apply = h('button', { class: 'btn primary', disabled: true, onclick: async () => {
      try {
        const r = await post<{ moves: unknown[] }>(`/api/shifts/groups/${target.value}/transfer`, { ...body(), dry_run: false });
        m.close();
        toast(`ย้ายกลุ่มแล้ว ${r.moves.length} คน`);
        reload();
      } catch (e) {
        mount(impact, errorBox(e));
      }
    } }, 'ยืนยันย้ายกลุ่ม');
    [target, date].forEach((x) => x.addEventListener('change', () => { apply.disabled = true; void check(); }));
    const m = modal(`ย้ายกลุ่ม (Transfer) ${ids.length} คน`, h('div', { class: 'stack' }, field('ย้ายไปกลุ่ม', target), field('มีผลตั้งแต่', date), reason.el, impact),
      [h('button', { class: 'btn', onclick: () => m.close() }, 'ยกเลิก'), apply]);
    void check();
  };

  const sync = async () => {
    const start = h('input', { type: 'date', value: d.today });
    const reason = reasonField(start);
    const out = h('div', { 'aria-live': 'polite' });
    type Plan = { add: Array<{ emp_code: string; name: string }>; remove: Array<{ emp_code: string; name: string }>; conflicts: Array<{ emp_code: string | null; message: string }> };
    const show = (p: Plan) => mount(out, h('div', { class: 'stack' },
      h('p', null, `จะเพิ่ม ${p.add.length} คน · นำออก ${p.remove.length} คน · ข้าม ${p.conflicts.length} คน`),
      p.add.length ? h('p', { class: 'small' }, 'เพิ่ม: ', p.add.map((x) => x.emp_code).join(', ')) : null,
      p.remove.length ? h('p', { class: 'small' }, 'นำออก: ', p.remove.map((x) => x.emp_code).join(', ')) : null,
      p.conflicts.length ? h('ul', { class: 'issues' }, p.conflicts.map((x) => h('li', { class: 'issue-warning' }, `${x.emp_code ?? ''} ${x.message}`))) : null));
    const preview = async () => {
      try {
        show(await post<Plan>(`/api/shifts/groups/${g.id}/sync`, { start_date: start.value, reason: reason.value(), dry_run: true }));
      } catch (e) {
        mount(out, errorBox(e));
      }
    };
    start.addEventListener('change', () => void preview());
    const m = modal(`Sync สมาชิกตาม${g.membership === 'department' ? 'หน่วยงาน' : 'บริษัท'}`, h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'ตรวจสอบรายชื่อก่อนบันทึก ผู้ที่อยู่กลุ่มอื่นจะไม่ถูกย้ายอัตโนมัติ'), field('มีผลตั้งแต่', start), reason.el, out),
      [h('button', { class: 'btn', onclick: () => m.close() }, 'ยกเลิก'), h('button', { class: 'btn primary', onclick: async () => {
        try {
          const r = await post<Plan>(`/api/shifts/groups/${g.id}/sync`, { start_date: start.value, reason: reason.value(), dry_run: false });
          m.close();
          toast(`Sync แล้ว เพิ่ม ${r.add.length} คน นำออก ${r.remove.length} คน`);
          reload();
        } catch (e) {
          mount(out, errorBox(e));
        }
      } }, 'ยืนยัน Sync')]);
    void preview();
  };

  const changeDefault = async () => {
    const shifts = (await get<Shift[]>('/api/shifts/settings')).filter((s) => s.active && (s.company_id === null || s.company_id === g.company_id));
    const sel = h('select', null, shifts.map((s) => h('option', { value: String(s.id), selected: s.id === g.default_shift_id }, shiftLabel(s))));
    const date = h('input', { type: 'date', value: addDays(d.today, 1), min: d.today });
    const out = h('div');
    const m = modal('เปลี่ยนกะประจำของกลุ่ม', h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'มีผลตั้งแต่วันที่กำหนด วันก่อนหน้ายังใช้กะเดิม (ไม่เปลี่ยนข้อมูลย้อนหลัง)'), field('กะประจำใหม่', sel), field('มีผลตั้งแต่', date), out),
      [h('button', { class: 'btn', onclick: () => m.close() }, 'ยกเลิก'), h('button', { class: 'btn primary', onclick: async () => {
        try {
          await post(`/api/shifts/groups/${g.id}/default`, { shift_id: Number(sel.value), effective_date: date.value });
          m.close();
          toast('บันทึกกะประจำแล้ว');
          reload();
        } catch (e) {
          mount(out, errorBox(e));
        }
      } }, 'บันทึก')]);
  };

  const memberTable = (rows: GroupDetail['members'], selectable: boolean) => rows.length
    ? h('div', { class: 'table-wrap' }, h('table', { class: 'table compact member-table' },
        h('thead', null, h('tr', null, selectable && manage ? h('th', null, h('input', { type: 'checkbox', 'aria-label': 'เลือกทั้งหมด', onchange: (e: Event) => checks.forEach((c) => { c.checked = (e.target as HTMLInputElement).checked; }) })) : null,
          ['รหัส', 'ชื่อ', 'หน่วยงาน', 'เริ่ม', 'สิ้นสุด', 'วิธี', 'หมายเหตุ', 'โดย'].map((t) => h('th', null, t)))),
        h('tbody', null, rows.map((r) => {
          let box: HTMLInputElement | null = null;
          if (selectable && manage) {
            box = h('input', { type: 'checkbox', 'aria-label': `เลือก ${r.emp_code}` });
            checks.set(r.employee_id, box);
          }
          return h('tr', { 'data-emp': r.emp_code }, box ? h('td', null, box) : null, h('td', null, r.emp_code), h('td', null, r.name), h('td', null, r.department ?? '-'), h('td', null, fmtDate(r.start_date)),
            h('td', null, r.end_date ? fmtDate(r.end_date) : '-'), h('td', null, METHOD_LABEL[r.method] ?? r.method), h('td', { class: 'truncate' }, r.note ?? ''), h('td', null, r.ended_by ?? r.created_by ?? '-'));
        }))))
    : h('div', { class: 'empty' }, 'ไม่มีข้อมูล');

  const body = h('div');
  const draw = () => {
    checks.clear();
    mount(body, tab === 'members'
      ? h('div', { class: 'stack' },
          manage ? h('div', { class: 'toolbar' },
            g.membership === 'manual' ? h('button', { class: 'btn primary', onclick: () => void addMembers() }, '+ เพิ่มสมาชิก') : h('button', { class: 'btn primary', onclick: () => void sync() }, 'Sync สมาชิก'),
            g.membership !== 'manual' ? h('button', { class: 'btn', onclick: () => void addMembers() }, '+ เพิ่มรายคน') : null,
            h('button', { class: 'btn', onclick: () => void removeMembers() }, 'นำออก (Bulk Remove)'), h('button', { class: 'btn', onclick: () => void transfer() }, 'ย้ายกลุ่ม (Transfer)')) : null,
          memberTable(current, true))
      : h('div', { class: 'stack' },
          h('h3', null, 'สมาชิกในอดีต'), memberTable(past, false),
          h('h3', null, 'ประวัติการเปลี่ยนแปลง'),
          d.history.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table compact' }, h('thead', null, h('tr', null, ['เวลา', 'ผู้ดำเนินการ', 'รายการ', 'รายละเอียด'].map((t) => h('th', null, t)))),
            h('tbody', null, d.history.map((x) => h('tr', null, h('td', null, fmtDate(x.at)), h('td', null, x.username ?? '-'), h('td', null, ACTION_LABEL[x.action] ?? x.action), h('td', { class: 'truncate small' }, x.details ?? '')))))) : h('div', { class: 'empty' }, 'ไม่มีประวัติ')));
  };
  const tabs = h('div', { class: 'segmented', role: 'group', 'aria-label': 'ส่วนของกลุ่ม' },
    h('button', { class: 'btn small primary', 'aria-pressed': 'true', onclick: (e: Event) => setTab('members', e) }, `สมาชิกปัจจุบัน (${current.length})`),
    h('button', { class: 'btn small', 'aria-pressed': 'false', onclick: (e: Event) => setTab('history', e) }, 'ประวัติสมาชิก'));
  const setTab = (t: typeof tab, e: Event) => {
    tab = t;
    tabs.querySelectorAll('button').forEach((b) => { b.classList.toggle('primary', b === e.currentTarget); b.setAttribute('aria-pressed', b === e.currentTarget ? 'true' : 'false'); });
    draw();
  };
  draw();
  mount(main, h('div', { class: 'stack' },
    h('div', { class: 'toolbar' }, link('/shifts/groups', '‹ กลุ่มกะทั้งหมด', { class: 'btn' }), h('div', { class: 'spacer' }),
      link(`/shifts/schedule?group=${g.id}&company=${g.company_id}`, 'เปิดตารางกะของกลุ่ม', { class: 'btn' }),
      manage ? h('button', { class: 'btn', onclick: () => void groupEditor(g, reload) }, 'แก้ไขกลุ่ม') : null),
    h('div', { class: 'card' },
      h('h2', null, `${g.code} · ${g.name}`),
      h('dl', { class: 'dl' },
        h('dt', null, 'บริษัท'), h('dd', null, g.company), h('dt', null, 'หน่วยงาน'), h('dd', null, g.department ?? '-'), h('dt', null, 'ผู้รับผิดชอบ'), h('dd', null, g.owner ?? '-'),
        h('dt', null, 'วิธีเลือกสมาชิก'), h('dd', null, MEMBERSHIP_LABEL[g.membership]), h('dt', null, 'ประเภทกะ'), h('dd', null, SHIFT_TYPE_LABEL[g.shift_type]),
        h('dt', null, 'สถานะ'), h('dd', null, g.status === 'active' ? 'ใช้งาน' : 'ปิดใช้งาน'), h('dt', null, 'คำอธิบาย'), h('dd', null, g.description ?? '-'))),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', null, 'กะประจำของกลุ่ม (Group Default)'), manage ? h('button', { class: 'btn small', onclick: () => void changeDefault() }, 'เปลี่ยนกะประจำ') : null),
      d.defaults.length ? h('table', { class: 'table compact' }, h('thead', null, h('tr', null, ['มีผลตั้งแต่', 'กะ', 'บันทึกเมื่อ', 'โดย'].map((t) => h('th', null, t)))),
        h('tbody', null, d.defaults.map((x) => h('tr', { class: x.effective_date > d.today ? 'is-future' : '' }, h('td', null, fmtDate(x.effective_date), x.effective_date > d.today ? ' (อนาคต)' : ''), h('td', null, x.shift), h('td', null, fmtDate(x.created_at)), h('td', null, x.created_by ?? '-')))))
        : h('p', { class: 'muted' }, g.shift_type === 'scheduled' ? 'กลุ่มกะตามตาราง: กำหนดกะรายวันที่หน้าตารางกะกลุ่ม' : 'ยังไม่ได้กำหนดกะประจำ')),
    h('div', { class: 'card' }, tabs, body)));
}

// ===== Group schedule calendar ==================================================================
interface Cell {
  kind: 'shift' | 'day_off' | 'holiday' | 'none';
  shift_id: number | null;
  source: 'individual' | 'group' | 'group_default' | 'assignment' | 'none';
  group_id: number | null;
}
interface ScheduleData {
  company: CompanyOption;
  from: string;
  to: string;
  today: string;
  group: Group | null;
  groups: Array<Pick<Group, 'id' | 'code' | 'name' | 'shift_type'>>;
  employees: Array<{ id: number; emp_code: string; name: string; department: string | null }>;
  cells: Record<string, Record<string, Cell>>;
  memberships: Array<{ employee_id: number; group_id: number; code: string; name: string; shift_type: ShiftType; start_date: string; end_date: string | null }>;
  shifts: Array<Pick<Shift, 'id' | 'code' | 'name' | 'start_time' | 'end_time' | 'color' | 'active' | 'shift_type'>>;
  holidays: Array<{ date: string; name: string }>;
  weekly_rest: number[];
  leaves: Array<{ employee_id: number; start_date: string; end_date: string; type: string }>;
  locked: Array<{ code: string; status: string; start_date: string; end_date: string }>;
}
type Pending = { kind: 'shift' | 'day_off' | 'holiday' | 'clear'; shift_id: number | null };
interface SaveResult {
  applied: boolean;
  repeated?: boolean;
  errors: Array<{ employee_id: number; date: string; message: string }>;
  warnings: Array<{ employee_id: number; date: string; message: string }>;
  summary: { changes: number; shift: number; day_off: number; holiday: number; clear: number };
}
const SOURCE_LABEL: Record<Cell['source'], string> = { individual: 'ปรับรายบุคคล (Individual Override)', group: 'ตารางกะของกลุ่ม (Group Schedule)', group_default: 'กะประจำกลุ่ม (Group Default)', assignment: 'ตารางกะเดิม (Shift Assignment)', none: '' };

export async function renderShiftSchedule(main: HTMLElement, params: URLSearchParams): Promise<void> {
  if (!companies().length) return mount(main, noCompanies());
  const companyId = Number(params.get('company')) || state.companyId || companies()[0]!.id;
  const view = params.get('view') === 'week' ? 'week' : 'month';
  const t = today();
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') ?? '') ? (params.get('date') as string) : t;
  const monday = addDays(anchor, -((weekday(anchor) + 6) % 7));
  const from = view === 'week' ? monday : `${anchor.slice(0, 7)}-01`;
  const to = view === 'week' ? addDays(monday, 6) : monthEnd(anchor);
  const go = (p: Record<string, string | number | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(p)) if (v === null || v === '') next.delete(k); else next.set(k, String(v));
    navigate(`/shifts/schedule?${next.toString()}`);
  };
  mount(main, loading());
  try {
    const [people, d] = await Promise.all([
      get<People>(`/api/shifts/people${qs({ company: companyId })}`),
      get<ScheduleData>(`/api/shifts/schedule${qs({ company: companyId, from, to, group: params.get('group'), department: params.get('department'), q: params.get('q') })}`),
    ]);
    const manage = can('shift_schedule.manage');
    const days = dateRange(d.from, d.to);
    const shiftById = new Map(d.shifts.map((s) => [s.id, s]));
    const holidayAt = new Map(d.holidays.map((x) => [x.date, x.name]));
    const pending = new Map<string, Pending>();
    const selected = new Set<string>();
    const cellEls = new Map<string, HTMLTableCellElement>();
    const lockedAt = (date: string) => d.locked.find((l) => l.start_date <= date && l.end_date >= date);
    const leaveOf = (emp: number, date: string) => d.leaves.find((l) => l.employee_id === emp && l.start_date <= date && l.end_date >= date);

    const filters = h('div', { class: 'toolbar schedule-filters' },
      field('บริษัท', companySel(companyId, (id) => go({ company: id, group: null, department: null }))),
      field('กลุ่มกะ', h('select', { 'aria-label': 'กลุ่มกะ', onchange: (e: Event) => go({ group: (e.target as HTMLSelectElement).value }) }, h('option', { value: '' }, 'ทุกพนักงานของบริษัท'),
        d.groups.map((g) => h('option', { value: String(g.id), selected: String(g.id) === params.get('group') }, `${g.code} ${g.name}`)))),
      field('หน่วยงาน', h('select', { 'aria-label': 'หน่วยงาน', onchange: (e: Event) => go({ department: (e.target as HTMLSelectElement).value }) }, h('option', { value: '' }, 'ทุกหน่วยงาน'),
        people.departments.map((x) => h('option', { value: String(x.id), selected: String(x.id) === params.get('department') }, x.name)))),
      field('ค้นหาพนักงาน', h('input', { type: 'search', value: params.get('q') ?? '', placeholder: 'รหัส / ชื่อ', 'aria-label': 'ค้นหาพนักงาน', onchange: (e: Event) => go({ q: (e.target as HTMLInputElement).value.trim() }) })),
      field('เดือน / ปี', h('input', { type: 'month', value: anchor.slice(0, 7), 'aria-label': 'เดือน', onchange: (e: Event) => { const v = (e.target as HTMLInputElement).value; if (v) go({ date: `${v}-01` }); } })),
      h('div', { class: 'segmented', role: 'group', 'aria-label': 'มุมมอง' },
        h('button', { class: `btn small ${view === 'month' ? 'primary' : ''}`, 'aria-pressed': String(view === 'month'), onclick: () => go({ view: 'month' }) }, 'รายเดือน'),
        h('button', { class: `btn small ${view === 'week' ? 'primary' : ''}`, 'aria-pressed': String(view === 'week'), onclick: () => go({ view: 'week' }) }, 'รายสัปดาห์')),
      h('button', { class: 'btn small', 'aria-label': view === 'week' ? 'สัปดาห์ก่อนหน้า' : 'เดือนก่อนหน้า', onclick: () => go({ date: view === 'week' ? addDays(monday, -7) : addDays(from, -1) }) }, '‹'),
      h('button', { class: 'btn small', onclick: () => go({ date: t }) }, 'วันนี้'),
      h('button', { class: 'btn small', 'aria-label': view === 'week' ? 'สัปดาห์ถัดไป' : 'เดือนถัดไป', onclick: () => go({ date: view === 'week' ? addDays(monday, 7) : addDays(to, 1) }) }, '›'));

    const title = view === 'week' ? `สัปดาห์ ${fmtDate(d.from)} – ${fmtDate(d.to)}` : `${THAI_MONTHS_FULL[Number(anchor.slice(5, 7)) - 1]} ${buddhistYear(Number(anchor.slice(0, 4)))}`;
    const effective = (emp: number, date: string): { kind: Pending['kind'] | 'none'; shift_id: number | null; source: Cell['source']; pending: boolean } => {
      const p = pending.get(`${emp}|${date}`);
      // a change made in a scheduled group's calendar is saved as the group's schedule, elsewhere as an override
      if (p) return { ...p, source: d.group?.shift_type === 'scheduled' && d.memberships.some((m) => m.employee_id === emp && m.group_id === d.group?.id && m.start_date <= date && (m.end_date === null || m.end_date >= date)) ? 'group' : 'individual', pending: true };
      const c = d.cells[String(emp)]?.[date];
      return c ? { ...c, pending: false } : { kind: 'none', shift_id: null, source: 'none', pending: false };
    };
    const paint = (emp: number, date: string) => {
      const td = cellEls.get(`${emp}|${date}`);
      if (!td) return;
      const e = effective(emp, date);
      const s = e.shift_id ? shiftById.get(e.shift_id) : undefined;
      const leave = leaveOf(emp, date);
      td.className = ['sch-cell', `k-${e.kind}`, e.pending ? 'is-pending' : '', selected.has(`${emp}|${date}`) ? 'is-selected' : '', holidayAt.has(date) ? 'is-holiday' : '', lockedAt(date) ? 'is-locked' : '', date === d.today ? 'is-today' : ''].filter(Boolean).join(' ');
      td.style.setProperty('--shift-color', s?.color ?? '#94a3b8');
      const tag = e.source === 'individual' ? 'I' : e.source === 'group' || e.source === 'group_default' ? 'G' : '';
      td.replaceChildren(
        e.kind === 'shift' && s ? h('span', { class: 'sch-shift' }, h('b', null, s.code), h('small', null, `${s.start_time}–${s.end_time}`))
          : e.kind === 'day_off' ? h('span', { class: 'sch-off' }, 'หยุด')
          : e.kind === 'holiday' ? h('span', { class: 'sch-hol' }, 'นักขัตฯ')
          : e.kind === 'clear' ? h('span', { class: 'muted' }, 'ล้าง') : '',
        leave ? h('span', { class: 'sch-leave', title: leave.type }, 'ลา') : '',
        tag ? h('span', { class: `sch-src src-${tag}`, 'aria-hidden': 'true' }, tag) : '');
      td.title = [`${d.employees.find((x) => x.id === emp)?.emp_code ?? ''} ${fmtDate(date)}`, s ? `${s.name} ${s.start_time}–${s.end_time}` : e.kind === 'day_off' ? 'วันหยุด (Day Off)' : e.kind === 'holiday' ? 'วันหยุดนักขัตฤกษ์ (Holiday)' : 'ยังไม่จัดกะ',
        SOURCE_LABEL[e.source], e.pending ? 'ยังไม่บันทึก' : '', holidayAt.get(date) ? `วันหยุด: ${holidayAt.get(date)}` : '', leave ? `ลา: ${leave.type}` : '', lockedAt(date) ? `งวด ${lockedAt(date)!.code} คำนวณแล้ว (แก้ไขไม่ได้)` : ''].filter(Boolean).join('\n');
      td.setAttribute('aria-selected', String(selected.has(`${emp}|${date}`)));
    };
    const repaintAll = () => {
      for (const e of d.employees) for (const x of days) paint(e.id, x);
      selInfo.textContent = selected.size ? `เลือก ${selected.size} ช่อง` : 'คลิกช่องเพื่อเลือก (Shift+คลิก เลือกช่วง, คลิกชื่อพนักงานเลือกทั้งแถว, คลิกหัววันที่เลือกทั้งคอลัมน์)';
      saveBtn.textContent = `บันทึก (${pending.size})`;
      saveBtn.disabled = !pending.size;
      discardBtn.disabled = !pending.size;
    };
    let lastClick: { emp: number; date: string } | null = null;
    const toggle = (emp: number, date: string, range: boolean) => {
      if (range && lastClick && lastClick.emp === emp) {
        const [a, b] = [lastClick.date, date].sort() as [string, string];
        for (const x of dateRange(a, b)) selected.add(`${emp}|${x}`);
      } else {
        const k = `${emp}|${date}`;
        if (selected.has(k)) selected.delete(k); else selected.add(k);
      }
      lastClick = { emp, date };
      repaintAll();
    };
    const grid = h('table', { class: 'schedule-grid', role: 'grid', 'aria-label': `ตารางกะ ${title}` },
      h('thead', null, h('tr', null, h('th', { class: 'sch-emp', scope: 'col' }, 'พนักงาน'), days.map((x) => h('th', {
        scope: 'col', class: [holidayAt.has(x) ? 'is-holiday' : '', d.weekly_rest.includes(weekday(x)) ? 'is-rest' : '', x === d.today ? 'is-today' : ''].filter(Boolean).join(' '), title: holidayAt.get(x) ?? undefined,
        onclick: manage ? () => { const all = d.employees.every((e) => selected.has(`${e.id}|${x}`)); d.employees.forEach((e) => (all ? selected.delete(`${e.id}|${x}`) : selected.add(`${e.id}|${x}`))); repaintAll(); } : undefined,
      }, h('span', { class: 'sch-d' }, String(Number(x.slice(8)))), h('span', { class: 'sch-wd' }, WEEKDAY_SHORT[weekday(x)]!))))),
      h('tbody', null, d.employees.map((e) => {
        const membership = d.memberships.find((m) => m.employee_id === e.id);
        return h('tr', { 'data-emp': e.emp_code },
          h('th', { class: 'sch-emp', scope: 'row', onclick: manage ? () => { const all = days.every((x) => selected.has(`${e.id}|${x}`)); days.forEach((x) => (all ? selected.delete(`${e.id}|${x}`) : selected.add(`${e.id}|${x}`))); repaintAll(); } : undefined },
            h('span', { class: 'sch-code' }, e.emp_code), h('span', { class: 'sch-name' }, e.name), h('span', { class: 'muted small' }, [e.department, membership?.code].filter(Boolean).join(' · '))),
          days.map((x) => {
            const td = h('td', { role: 'gridcell', tabindex: manage ? '0' : undefined, 'data-date': x,
              onclick: manage ? (ev: MouseEvent) => toggle(e.id, x, ev.shiftKey) : undefined,
              onkeydown: manage ? (ev: KeyboardEvent) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(e.id, x, ev.shiftKey); } } : undefined });
            cellEls.set(`${e.id}|${x}`, td);
            return td;
          }));
      })));

    const shiftPick = h('select', { 'aria-label': 'เลือกกะ' }, d.shifts.filter((s) => s.active).map((s) => h('option', { value: String(s.id) }, shiftLabel(s))));
    const setSelected = (p: Pending) => {
      if (!selected.size) return toast('กรุณาเลือกช่องในตารางก่อน', 'error');
      for (const k of selected) {
        if (lockedAt(k.split('|')[1]!)) continue;
        pending.set(k, p);
      }
      selected.clear();
      repaintAll();
    };
    const rotation = () => {
      if (!selected.size) return toast('กรุณาเลือกช่วงวันที่ของพนักงานที่จะหมุนเวียนกะ', 'error');
      const steps = h('div', { class: 'stack rotation-steps' });
      const addStep = (val = '') => steps.append(h('div', { class: 'inline-form' }, h('select', { class: 'rot' }, h('option', { value: 'off', selected: val === 'off' }, 'วันหยุด (Day Off)'),
        d.shifts.filter((s) => s.active).map((s) => h('option', { value: String(s.id), selected: val === String(s.id) }, shiftLabel(s)))), h('button', { class: 'btn small', onclick: (ev: Event) => (ev.currentTarget as HTMLElement).parentElement?.remove() }, 'ลบ')));
      d.shifts.filter((s) => s.active).slice(0, 2).forEach((s) => { addStep(String(s.id)); addStep(String(s.id)); });
      addStep('off');
      const m = modal('หมุนเวียนกะ (Rotation)', h('div', { class: 'stack' },
        h('p', { class: 'muted small' }, 'กำหนดลำดับกะที่วนซ้ำ ระบบจะเติมช่องที่เลือกของแต่ละคนตามลำดับวันที่ เริ่มจากลำดับแรก'), steps,
        h('button', { class: 'btn small', onclick: () => addStep() }, '+ เพิ่มลำดับ')),
      [h('button', { class: 'btn', onclick: () => m.close() }, 'ยกเลิก'), h('button', { class: 'btn primary', onclick: () => {
        const pattern: Pending[] = [...steps.querySelectorAll('select.rot')].map((s) => ((s as HTMLSelectElement).value === 'off' ? { kind: 'day_off', shift_id: null } : { kind: 'shift', shift_id: Number((s as HTMLSelectElement).value) }));
        if (!pattern.length) return;
        const byEmp = new Map<number, string[]>();
        for (const k of selected) { const [e, x] = k.split('|'); byEmp.set(Number(e), [...(byEmp.get(Number(e)) ?? []), x!]); }
        for (const [e, list] of byEmp) {
          const sorted = list.sort();
          const seq = rotate(pattern, dateRange(sorted[0]!, sorted[sorted.length - 1]!).length);
          dateRange(sorted[0]!, sorted[sorted.length - 1]!).forEach((x, i) => { if (selected.has(`${e}|${x}`) && !lockedAt(x)) pending.set(`${e}|${x}`, seq[i]!); });
        }
        selected.clear();
        m.close();
        repaintAll();
      } }, 'เติมตามลำดับ')]);
    };
    const selectedEmployees = () => {
      const ids = new Set([...selected].map((k) => Number(k.split('|')[0])));
      return ids.size ? [...ids] : d.employees.map((e) => e.id);
    };
    const save = async () => {
      const changes = [...pending].map(([k, p]) => ({ employee_id: Number(k.split('|')[0]), date: k.split('|')[1], kind: p.kind, shift_id: p.shift_id }));
      await confirmSave('บันทึกตารางกะ', '/api/shifts/schedule/changes', { company_id: companyId, group_id: params.get('group') ? Number(params.get('group')) : null, changes }, changes.map((x) => x.date as string));
    };
    const confirmSave = async (title: string, url: string, body: Record<string, unknown>, dates: string[]) => {
      let r: SaveResult;
      try {
        r = await post<SaveResult>(url, { ...body, dry_run: true });
      } catch (e) {
        return toast(msg(e), 'error');
      }
      const past = dates.some((x) => x < d.today);
      const reason = h('input', { type: 'text', maxlength: 500, placeholder: 'เหตุผลการแก้ไขย้อนหลัง', 'aria-label': 'เหตุผล' });
      const name = (id: number) => d.employees.find((e) => e.id === id)?.emp_code ?? String(id);
      const out = h('div');
      const pastErrors = r.errors.filter((x) => x.message.includes('ต้องระบุเหตุผล'));
      const otherErrors = r.errors.filter((x) => !x.message.includes('ต้องระบุเหตุผล'));
      const m = modal(title, h('div', { class: 'stack' },
        h('p', null, `รายการทั้งหมด ${r.summary.changes} ช่อง: กำหนดกะ ${r.summary.shift} · วันหยุด ${r.summary.day_off} · วันหยุดนักขัตฯ ${r.summary.holiday} · ล้าง ${r.summary.clear}`),
        otherErrors.length ? h('div', { class: 'alert alert-error', role: 'alert' }, h('strong', null, `พบข้อขัดแย้ง ${otherErrors.length} รายการ (บันทึกไม่ได้)`), h('ul', { class: 'issues' }, otherErrors.slice(0, 30).map((x) => h('li', null, `${name(x.employee_id)} ${fmtDate(x.date)}: ${x.message}`)))) : null,
        r.warnings.length ? h('div', { class: 'alert', role: 'status' }, h('strong', null, `คำเตือน ${r.warnings.length} รายการ`), h('ul', { class: 'issues' }, r.warnings.slice(0, 30).map((x) => h('li', { class: 'issue-warning' }, x.message)))) : null,
        past || pastErrors.length ? field('เหตุผลการแก้ไขย้อนหลัง (จำเป็น)', reason) : null, out),
      [h('button', { class: 'btn', onclick: () => m.close() }, 'ยกเลิก'), h('button', { class: 'btn primary', disabled: otherErrors.length > 0, onclick: async () => {
        try {
          const done = await post<SaveResult>(url, { ...body, reason: reason.value.trim() || null, change_token: crypto.randomUUID(), accept_warnings: true });
          if (!done.applied) return mount(out, errorBox(new Error(done.errors.map((x) => `${name(x.employee_id)} ${x.date}: ${x.message}`).slice(0, 5).join(' · ') || 'บันทึกไม่สำเร็จ')));
          m.close();
          toast('บันทึกตารางกะแล้ว');
          void renderShiftSchedule(main, params);
        } catch (e) {
          mount(out, errorBox(e));
        }
      } }, r.warnings.length ? 'ยืนยันบันทึก (รับทราบคำเตือน)' : 'ยืนยันบันทึก')]);
    };
    const copy = async (kind: 'day' | 'week' | 'month') => {
      if (pending.size) return toast('กรุณาบันทึกหรือยกเลิกการแก้ไขที่ค้างอยู่ก่อน', 'error');
      const ids = selectedEmployees();
      const sel = [...selected].map((k) => k.split('|')[1]!).sort();
      let body: Record<string, unknown>;
      let dates: string[];
      if (kind === 'day') {
        const target = sel[0] ?? (d.today >= d.from && d.today <= d.to ? d.today : d.from);
        body = { from_start: addDays(target, -1), from_end: addDays(target, -1), to_start: target };
        dates = [target];
      } else if (kind === 'week') {
        const start = view === 'week' ? d.from : addDays(sel[0] ?? d.from, -((weekday(sel[0] ?? d.from) + 6) % 7));
        body = { from_start: addDays(start, -7), from_end: addDays(start, -1), to_start: start };
        dates = dateRange(start, addDays(start, 6));
      } else {
        const prevEnd = addDays(`${anchor.slice(0, 7)}-01`, -1);
        body = { from_start: `${prevEnd.slice(0, 7)}-01`, from_end: prevEnd, to_start: `${anchor.slice(0, 7)}-01`, to_end: monthEnd(anchor), mode: 'month' };
        dates = dateRange(`${anchor.slice(0, 7)}-01`, monthEnd(anchor));
      }
      const label = kind === 'day' ? `คัดลอกจากวันก่อน (${fmtDate(body.from_start)} → ${fmtDate(body.to_start)})` : kind === 'week' ? `คัดลอกสัปดาห์ก่อน (${fmtDate(body.from_start)} – ${fmtDate(body.from_end)})` : `คัดลอกเดือนก่อน (${fmtDate(body.from_start)} – ${fmtDate(body.from_end)})`;
      await confirmSave(`${label} · ${ids.length} คน`, '/api/shifts/schedule/copy', { ...body, company_id: companyId, group_id: params.get('group') ? Number(params.get('group')) : null, employee_ids: ids }, dates);
    };
    const history = async () => {
      const emps = new Set([...selected].map((k) => Number(k.split('|')[0])));
      if (emps.size !== 1) return toast('เลือกช่องของพนักงาน 1 คนเพื่อดูประวัติ', 'error');
      const emp = [...emps][0]!;
      const rows = await get<Array<{ work_date: string; before_json: string | null; after_json: string | null; reason: string | null; created_at: string; created_by: string | null }>>(`/api/shifts/schedule/history${qs({ employee: emp, from: d.from, to: d.to })}`);
      const desc = (j: string | null) => {
        if (!j) return 'ไม่มี';
        const v = JSON.parse(j) as { kind: string; shift_id: number | null; origin: string };
        const s = v.shift_id ? shiftById.get(v.shift_id) : undefined;
        return `${v.kind === 'shift' ? (s ? s.code : `กะ #${v.shift_id}`) : v.kind === 'day_off' ? 'วันหยุด' : 'วันหยุดนักขัตฯ'} (${v.origin === 'group' ? 'กลุ่ม' : 'รายบุคคล'})`;
      };
      modal(`ประวัติการแก้ไขตารางกะ · ${d.employees.find((e) => e.id === emp)?.emp_code ?? ''}`, rows.length
        ? h('table', { class: 'table compact' }, h('thead', null, h('tr', null, ['วันที่', 'ก่อน', 'หลัง', 'เหตุผล', 'แก้ไขเมื่อ', 'โดย'].map((x) => h('th', null, x)))),
          h('tbody', null, rows.map((r) => h('tr', null, h('td', null, fmtDate(r.work_date)), h('td', null, desc(r.before_json)), h('td', null, desc(r.after_json)), h('td', null, r.reason ?? '-'), h('td', null, fmtDate(r.created_at)), h('td', null, r.created_by ?? '-')))))
        : h('p', { class: 'muted' }, 'ยังไม่มีการแก้ไขในช่วงนี้'));
    };
    const saveBtn = h('button', { class: 'btn primary', disabled: true, onclick: () => void save() }, 'บันทึก (0)');
    const discardBtn = h('button', { class: 'btn', disabled: true, onclick: () => { pending.clear(); repaintAll(); } }, 'ยกเลิกการแก้ไข');
    const selInfo = h('span', { class: 'muted small', 'aria-live': 'polite' });
    const actions = manage ? h('div', { class: 'toolbar schedule-actions' },
      shiftPick, h('button', { class: 'btn', onclick: () => setSelected({ kind: 'shift', shift_id: Number(shiftPick.value) }), disabled: !d.shifts.some((s) => s.active) }, 'กำหนดกะ'),
      h('button', { class: 'btn', onclick: () => setSelected({ kind: 'day_off', shift_id: null }) }, 'วันหยุด (Day Off)'),
      h('button', { class: 'btn', onclick: () => setSelected({ kind: 'holiday', shift_id: null }) }, 'วันหยุดนักขัตฯ (Holiday)'),
      h('button', { class: 'btn', onclick: () => setSelected({ kind: 'clear', shift_id: null }) }, 'ล้าง (Clear)'),
      h('button', { class: 'btn', onclick: rotation }, 'หมุนเวียนกะ'),
      h('details', { class: 'menu-details' }, h('summary', { class: 'btn' }, 'คัดลอก ▾'), h('div', { class: 'menu-pop' },
        h('button', { class: 'menu-link', onclick: () => void copy('day') }, 'คัดลอกจากวันก่อน'), h('button', { class: 'menu-link', onclick: () => void copy('week') }, 'คัดลอกสัปดาห์ก่อน'), h('button', { class: 'menu-link', onclick: () => void copy('month') }, 'คัดลอกเดือนก่อน'))),
      h('button', { class: 'btn', onclick: () => void history() }, 'ประวัติ'),
      h('div', { class: 'spacer' }), discardBtn, saveBtn) : null;
    const legend = h('div', { class: 'schedule-legend small' },
      d.shifts.filter((s) => s.active).map((s) => h('span', { class: 'legend-item' }, h('span', { class: 'shift-swatch', style: `--shift-color:${s.color ?? '#94a3b8'}` }), `${s.code} ${s.start_time}–${s.end_time}`)),
      h('span', { class: 'legend-item' }, h('span', { class: 'sch-off' }, 'หยุด'), ' Day Off'), h('span', { class: 'legend-item' }, h('span', { class: 'sch-hol' }, 'นักขัตฯ'), ' Holiday'), h('span', { class: 'legend-item' }, h('span', { class: 'sch-leave' }, 'ลา'), ' Leave'),
      h('span', { class: 'legend-item' }, h('span', { class: 'sch-src src-G' }, 'G'), ' Group Default / Group Schedule'), h('span', { class: 'legend-item' }, h('span', { class: 'sch-src src-I' }, 'I'), ' Individual Override'),
      d.locked.length ? h('span', { class: 'legend-item' }, h('span', { class: 'locked-key' }), ` งวดที่คำนวณแล้ว (${d.locked.map((l) => l.code).join(', ')}) แก้ไขไม่ได้`) : null);
    mount(main, h('div', { class: 'stack' },
      h('div', { class: 'card' }, filters),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, title), d.group ? h('span', { class: 'muted' }, `${d.group.code} · ${SHIFT_TYPE_LABEL[d.group.shift_type]}${d.group.default_shift ? ` · กะประจำ ${d.group.default_shift}` : ''}`) : null),
        actions, manage ? selInfo : null, legend,
        d.employees.length ? h('div', { class: 'schedule-wrap' }, grid) : h('div', { class: 'empty' }, d.group ? 'กลุ่มนี้ยังไม่มีสมาชิกในช่วงวันที่นี้' : 'ไม่พบพนักงานตามเงื่อนไข'),
        d.employees.length >= 500 ? h('p', { class: 'muted small' }, 'แสดงพนักงาน 500 คนแรก กรุณากรองตามกลุ่มหรือหน่วยงาน') : null)));
    repaintAll();
  } catch (e) {
    mount(main, errorBox(e));
  }
}

