import type { ListResponse, LookupOption, SettingItem } from '../../shared/types';
import { get, post, put, qs, ApiFailure } from '../api';
import { h, mount, loading, errorBox, fmtDate, modal, toast, confirmDialog } from '../dom';
import { basePath, can, crudMeta, link } from '../app';
import { cell, lookup, clearLookups } from './crud';

interface Dataset {
  key: string;
  title: string;
  canExport: boolean;
  columns: Array<{ name: string; label: string; ref: boolean }>;
}

export async function renderReports(main: HTMLElement): Promise<void> {
  mount(main, loading());
  try {
    const sets = await get<Dataset[]>('/api/reports/datasets');
    const preview = h('div', { class: 'table-wrap' });
    const colsBox = h('div', { class: 'checks' });
    const exportBtn = h('a', { class: 'btn primary', download: true }, 'Export CSV');
    const ds = h('select', { onchange: () => pick() }, sets.map((s) => h('option', { value: s.key }, s.title)));
    const selected = () => [...colsBox.querySelectorAll<HTMLInputElement>('input:checked')].map((i) => i.value);
    const refresh = async () => {
      const s = sets.find((x) => x.key === ds.value);
      if (!s) return;
      const cols = selected();
      exportBtn.hidden = !s.canExport || !cols.length;
      exportBtn.setAttribute('href', `${basePath()}/api/m/${s.key}/export.csv${qs({ columns: cols.join(',') })}`);
      try {
        const data = await get<ListResponse>(`/api/m/${s.key}${qs({ pageSize: 20 })}`);
        const meta = crudMeta(s.key);
        const shown = s.columns.filter((c) => cols.includes(c.name));
        mount(preview, h('p', { class: 'muted' }, `ตัวอย่าง ${data.rows.length} จาก ${data.total} แถว`),
          h('table', { class: 'table' }, h('thead', null, h('tr', null, shown.map((c) => h('th', null, c.label)))),
            h('tbody', null, data.rows.map((r) => h('tr', null, shown.map((c) => h('td', null, cell(meta?.fields.find((f) => f.name === c.name), r, c.name))))))));
      } catch (e) {
        mount(preview, errorBox(e));
      }
    };
    const pick = () => {
      const s = sets.find((x) => x.key === ds.value);
      mount(colsBox, (s?.columns ?? []).map((c) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: c.name, checked: true, onchange: () => void refresh() }), c.label)));
      void refresh();
    };
    mount(main,
      h('p', { class: 'muted lead' }, 'เลือกชุดข้อมูลและคอลัมน์ ดูตัวอย่าง แล้ว Export เป็น CSV (UTF-8 BOM เปิดใน Excel ได้) — ทุกการ Export ถูกบันทึกใน Audit Log'),
      sets.length ? [h('div', { class: 'toolbar' }, h('label', { class: 'field inline' }, h('span', null, 'ชุดข้อมูล'), ds), h('div', { class: 'spacer' }), exportBtn), h('section', { class: 'card' }, h('h3', null, 'คอลัมน์'), colsBox), preview]
        : h('div', { class: 'empty' }, 'ไม่มีชุดข้อมูลที่คุณมีสิทธิ์ดู'));
    if (sets.length) pick();
  } catch (e) {
    mount(main, errorBox(e));
  }
}

export async function renderAudit(main: HTMLElement): Promise<void> {
  let q = '';
  let page = 1;
  const box = h('div', { class: 'table-wrap' }, loading());
  const pager = h('div', { class: 'pager' });
  const search = h('input', { type: 'search', placeholder: 'ค้นหา action / โมดูล / ผู้ใช้', 'aria-label': 'ค้นหา' });
  search.addEventListener('change', () => { q = search.value; page = 1; void load(); });
  mount(main, h('div', { class: 'toolbar' }, search), box, pager);
  async function load() {
    try {
      const d = await get<{ rows: Array<Record<string, string | null>>; total: number; page: number; pageSize: number }>(`/api/audit${qs({ q, page })}`);
      mount(box, h('table', { class: 'table' }, h('thead', null, h('tr', null, ['เวลา (UTC)', 'ผู้ใช้', 'Action', 'โมดูล', 'ID', 'รายละเอียด', 'IP'].map((t) => h('th', null, t)))),
        h('tbody', null, d.rows.map((r) => h('tr', null, h('td', null, r.at), h('td', null, r.username ?? '-'), h('td', null, h('code', null, r.action)), h('td', null, r.entity ?? '-'), h('td', null, r.entity_id ?? '-'), h('td', { class: 'truncate' }, r.details ?? ''), h('td', null, r.ip ?? '-'))))));
      const pages = Math.max(1, Math.ceil(d.total / d.pageSize));
      mount(pager, h('span', { class: 'muted' }, `ทั้งหมด ${d.total} รายการ`), h('button', { class: 'btn small', disabled: page <= 1, onclick: () => { page--; void load(); } }, '‹'), h('span', null, `${page} / ${pages}`), h('button', { class: 'btn small', disabled: page >= pages, onclick: () => { page++; void load(); } }, '›'));
    } catch (e) {
      mount(box, errorBox(e));
    }
  }
  await load();
}

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  email: string | null;
  active: number;
  mfa_enabled: number;
  must_change_password: number;
  last_login_at: string | null;
  locked_until: string | null;
  roles: string[];
  employee_id: number | null;
  employee: string | null;
  approval_status: 'approved' | 'pending' | 'rejected';
  requested_employee_code: string | null;
  created_at: string;
}

export function showTempPassword(username: string, password: string): void {
  modal('รหัสผ่านชั่วคราว', [
    h('p', null, `รหัสผ่านชั่วคราวของ ${username} (แสดงครั้งเดียว — ระบบไม่เก็บรหัสนี้ไว้):`),
    h('p', null, h('code', { class: 'secret' }, password)),
    h('p', { class: 'muted' }, 'ส่งให้ผู้ใช้ทางช่องทางที่ปลอดภัย ผู้ใช้ต้องเปลี่ยนรหัสผ่านเมื่อเข้าระบบครั้งแรก'),
  ]);
}

async function userForm(u: UserRow | null, roles: LookupOption[], onDone: () => void): Promise<void> {
  const username = h('input', { value: u?.username ?? '', disabled: !!u, required: true, maxlength: 50 });
  const display = h('input', { value: u?.display_name ?? '', required: true, maxlength: 100 });
  const email = h('input', { type: 'email', value: u?.email ?? '' });
  const emps = await lookup('employees').catch(() => [] as LookupOption[]);
  const emp = h('select', null, h('option', { value: '' }, '— ไม่ผูก —'), emps.map((e) => h('option', { value: String(e.value), selected: e.value === u?.employee_id }, e.label)));
  const roleChecks = roles.map((r) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: r.code ?? '', checked: !!u?.roles.includes(r.code ?? '') }), r.label));
  const active = h('input', { type: 'checkbox', checked: u ? u.active === 1 : true });
  const msg = h('div', { class: 'form-msg', role: 'alert' });
  const dlg = modal(u ? `แก้ไขผู้ใช้ ${u.username}` : 'เพิ่มผู้ใช้', h('div', { class: 'grid-form' },
    h('label', { class: 'field' }, h('span', null, 'ชื่อผู้ใช้ *'), username), h('label', { class: 'field' }, h('span', null, 'ชื่อที่แสดง *'), display),
    h('label', { class: 'field' }, h('span', null, 'อีเมล'), email), h('label', { class: 'field' }, h('span', null, 'ผูกกับพนักงาน (สำหรับ ESS / สลิป)'), emp),
    h('div', { class: 'field span2' }, h('span', null, 'บทบาท'), h('div', { class: 'checks' }, roleChecks)),
    u ? h('label', { class: 'field check' }, h('span', null, 'ใช้งาน'), active) : null, msg), [
    h('button', { class: 'btn', onclick: () => dlg.close() }, 'ยกเลิก'),
    h('button', { class: 'btn primary', onclick: async () => {
      const body = {
        username: username.value, displayName: display.value, email: email.value || null, employeeId: emp.value ? Number(emp.value) : null,
        roles: roleChecks.map((l) => l.querySelector('input') as HTMLInputElement).filter((i) => i.checked).map((i) => i.value),
        ...(u ? { active: active.checked } : {}),
      };
      try {
        if (u) await put(`/api/admin/users/${u.id}`, body);
        else {
          const r = await post<{ username: string; temporaryPassword: string }>('/api/admin/users', body);
          showTempPassword(r.username, r.temporaryPassword);
        }
        clearLookups();
        dlg.close();
        toast('บันทึกแล้ว');
        onDone();
      } catch (e) {
        msg.textContent = e instanceof Error ? e.message : String(e);
      }
    } }, 'บันทึก'),
  ]);
}

async function approveForm(u: UserRow, roles: LookupOption[], onDone: () => void): Promise<void> {
  const emps = await lookup('employees').catch(() => [] as LookupOption[]);
  const suggested = emps.find((e) => !!u.requested_employee_code && e.code === u.requested_employee_code);
  const emp = h('select', null, h('option', { value: '' }, '— ไม่ผูก —'), emps.map((e) => h('option', { value: String(e.value), selected: e.value === suggested?.value }, e.label)));
  // default to the least-privileged role; the Super Admin chooses deliberately
  const roleChecks = roles.map((r) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: r.code ?? '', checked: r.code === 'employee' }), r.label));
  const msg = h('div', { class: 'form-msg', role: 'alert' });
  const dlg = modal(`อนุมัติคำขอของ ${u.username}`, h('div', { class: 'grid-form' },
    h('p', { class: 'span2' }, `${u.display_name}${u.email ? ` · ${u.email}` : ''}${u.requested_employee_code ? ` · แจ้งรหัสพนักงาน ${u.requested_employee_code}` : ''}`),
    h('div', { class: 'field span2' }, h('span', null, 'บทบาทที่จะให้'), h('div', { class: 'checks' }, roleChecks)),
    h('label', { class: 'field span2' }, h('span', null, 'ผูกกับพนักงาน'), emp), msg), [
    h('button', { class: 'btn', onclick: () => dlg.close() }, 'ยกเลิก'),
    h('button', { class: 'btn primary', onclick: async () => {
      try {
        await post(`/api/admin/users/${u.id}/approve`, {
          roles: roleChecks.map((l) => l.querySelector('input') as HTMLInputElement).filter((i) => i.checked).map((i) => i.value),
          employeeId: emp.value ? Number(emp.value) : null,
        });
        clearLookups();
        dlg.close();
        toast('อนุมัติแล้ว');
        onDone();
      } catch (e) {
        msg.textContent = e instanceof Error ? e.message : String(e);
      }
    } }, 'อนุมัติ'),
  ]);
}

export async function renderUsers(main: HTMLElement): Promise<void> {
  mount(main, loading());
  try {
    const [users, roles] = await Promise.all([get<UserRow[]>('/api/admin/users'), lookup('roles')]);
    const reload = () => void renderUsers(main);
    const action = async (u: UserRow, path: string, label: string) => {
      if (!(await confirmDialog(label, `${label} ของ ${u.username}?`, label))) return;
      try {
        const r = await post<{ temporaryPassword?: string }>(`/api/admin/users/${u.id}/${path}`);
        if (r.temporaryPassword) showTempPassword(u.username, r.temporaryPassword);
        else toast('ดำเนินการแล้ว');
        reload();
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), 'error');
      }
    };
    const pending = users.filter((u) => u.approval_status === 'pending');
    const accounts = users.filter((u) => u.approval_status !== 'pending');
    mount(main,
      h('div', { class: 'toolbar' }, h('p', { class: 'muted' }, 'เฉพาะ Super Admin เท่านั้นที่จัดการผู้ใช้ บทบาท และสิทธิ์ได้'), h('div', { class: 'spacer' }), h('button', { class: 'btn primary', onclick: () => void userForm(null, roles, reload) }, '+ เพิ่มผู้ใช้')),
      pending.length ? h('section', { class: 'card pending-card' }, h('h2', null, `คำขอลงทะเบียนรออนุมัติ (${pending.length})`),
        h('table', { class: 'table' }, h('thead', null, h('tr', null, ['ผู้ใช้', 'ชื่อ', 'อีเมล', 'รหัสพนักงานที่แจ้ง', 'วันที่ขอ', ''].map((t) => h('th', null, t)))),
          h('tbody', null, pending.map((u) => h('tr', null, h('td', null, u.username), h('td', null, u.display_name), h('td', null, u.email ?? '-'), h('td', null, u.requested_employee_code ?? '-'), h('td', null, fmtDate(u.created_at)),
            h('td', { class: 'actions' },
              h('button', { class: 'btn small primary', onclick: () => void approveForm(u, roles, reload) }, 'อนุมัติ'),
              h('button', { class: 'btn small danger', onclick: () => void action(u, 'reject', 'ปฏิเสธคำขอ') }, 'ปฏิเสธ'))))))) : null,
      h('table', { class: 'table' }, h('thead', null, h('tr', null, ['ผู้ใช้', 'ชื่อ', 'บทบาท', 'พนักงาน', 'MFA', 'สถานะ', 'เข้าระบบล่าสุด', ''].map((t) => h('th', null, t)))),
        h('tbody', null, accounts.map((u) => h('tr', null, h('td', null, u.username), h('td', null, u.display_name), h('td', null, u.roles.join(', ') || '-'), h('td', null, u.employee ?? '-'),
          h('td', null, u.mfa_enabled ? 'เปิด' : 'ปิด'),
          h('td', null, u.approval_status === 'rejected' ? 'ปฏิเสธคำขอ' : !u.active ? 'ปิดใช้งาน' : u.locked_until ? `ล็อกถึง ${fmtDate(u.locked_until)}` : u.must_change_password ? 'รอเปลี่ยนรหัสผ่าน' : 'ใช้งาน'),
          h('td', null, u.last_login_at ? fmtDate(u.last_login_at) : '-'),
          h('td', { class: 'actions' },
            h('button', { class: 'btn small', onclick: () => void userForm(u, roles, reload) }, 'แก้ไข'),
            h('button', { class: 'btn small', onclick: () => void action(u, 'reset-password', 'รีเซ็ตรหัสผ่าน') }, 'รีเซ็ตรหัส'),
            u.locked_until ? h('button', { class: 'btn small', onclick: () => void action(u, 'unlock', 'ปลดล็อก') }, 'ปลดล็อก') : null,
            u.mfa_enabled ? h('button', { class: 'btn small', onclick: () => void action(u, 'reset-mfa', 'รีเซ็ต MFA') }, 'รีเซ็ต MFA') : null))))),
    );
  } catch (e) {
    mount(main, errorBox(e));
  }
}

interface RoleRow {
  id: number;
  code: string;
  name: string;
  description: string | null;
  privileged: number;
  system: number;
  permissions: string[];
  users: number;
}

export async function renderRoles(main: HTMLElement): Promise<void> {
  mount(main, loading());
  try {
    const d = await get<{ roles: RoleRow[]; catalogue: string[] }>('/api/admin/roles');
    const edit = (r: RoleRow | null) => {
      const code = h('input', { value: r?.code ?? '', disabled: !!r, maxlength: 50 });
      const name = h('input', { value: r?.name ?? '', maxlength: 100 });
      const privileged = h('input', { type: 'checkbox', checked: r?.privileged === 1 });
      const perms = h('textarea', { rows: 10, value: (r?.permissions ?? []).join('\n') });
      const msg = h('div', { class: 'form-msg', role: 'alert' });
      const dlg = modal(r ? `บทบาท ${r.name}` : 'เพิ่มบทบาท', h('div', { class: 'grid-form' },
        h('label', { class: 'field' }, h('span', null, 'รหัส'), code), h('label', { class: 'field' }, h('span', null, 'ชื่อ'), name),
        h('label', { class: 'field check' }, h('span', null, 'สิทธิ์สูง (นโยบาย MFA จะบังคับใช้)'), privileged),
        h('label', { class: 'field span2' }, h('span', null, 'สิทธิ์ (บรรทัดละ 1 รายการ รองรับ module.* และ *.action)'), perms),
        h('details', { class: 'span2' }, h('summary', null, `รายการสิทธิ์ทั้งหมด (${d.catalogue.length})`), h('div', { class: 'catalogue' }, d.catalogue.map((p) => h('code', null, p)))), msg), [
        h('button', { class: 'btn', onclick: () => dlg.close() }, 'ยกเลิก'),
        h('button', { class: 'btn primary', onclick: async () => {
          const permissions = perms.value.split(/\s+/).map((s) => s.trim()).filter(Boolean);
          try {
            if (r) await put(`/api/admin/roles/${r.id}`, { name: name.value, privileged: privileged.checked, permissions });
            else await post('/api/admin/roles', { code: code.value, name: name.value, privileged: privileged.checked, permissions });
            clearLookups();
            dlg.close();
            toast('บันทึกแล้ว — ผู้ใช้จะได้รับสิทธิ์ใหม่ในคำขอถัดไป');
            void renderRoles(main);
          } catch (e) {
            msg.textContent = e instanceof Error ? e.message : String(e);
          }
        } }, 'บันทึก'),
      ]);
    };
    mount(main,
      h('div', { class: 'toolbar' }, h('div', { class: 'spacer' }), h('button', { class: 'btn primary', onclick: () => edit(null) }, '+ เพิ่มบทบาท')),
      h('table', { class: 'table' }, h('thead', null, h('tr', null, ['รหัส', 'ชื่อ', 'สิทธิ์สูง', 'ผู้ใช้', 'สิทธิ์', ''].map((t) => h('th', null, t)))),
        h('tbody', null, d.roles.map((r) => h('tr', null, h('td', null, r.code), h('td', null, r.name), h('td', null, r.privileged ? 'ใช่' : '-'), h('td', null, String(r.users)),
          h('td', { class: 'truncate' }, r.permissions.join(', ')),
          h('td', null, r.code === 'super_admin' ? h('span', { class: 'muted small' }, 'ทุกสิทธิ์ (แก้ไขไม่ได้)') : h('button', { class: 'btn small', onclick: () => edit(r) }, 'แก้ไข')))))),
    );
  } catch (e) {
    mount(main, errorBox(e));
  }
}

const SETTING_GROUPS: Array<{ title: string; match: (key: string) => boolean; note?: string }> = [
  { title: 'ความปลอดภัย', match: (k) => k.startsWith('security.') },
  { title: 'เงินเดือน & ประกันสังคม', match: (k) => k.startsWith('payroll.') && !k.startsWith('payroll.ewf_') },
  { title: 'เวลาทำงาน', match: (k) => k.startsWith('attendance.') },
  { title: 'องค์กร', match: (k) => k.startsWith('org.') },
  { title: 'ทดลองงาน (แจ้งเตือนวันที่ 90 · เปลี่ยนสถานะวันที่ 120)', match: (k) => k.startsWith('probation.') },
];

function settingInput(s: SettingItem, inputs: Map<string, HTMLInputElement>, suffix?: string): HTMLElement {
  const el =
    s.type === 'bool'
      ? h('input', { type: 'checkbox', name: s.key, checked: s.value === 'true' })
      : s.key.endsWith('_date')
        ? h('input', { type: 'date', name: s.key, value: s.value })
        : h('input', { type: s.type === 'number' ? 'number' : 'text', name: s.key, step: 'any', min: s.type === 'number' ? 0 : undefined, max: suffix === '%' ? 100 : undefined, value: s.value });
  inputs.set(s.key, el);
  const control = suffix ? h('div', { class: 'input-suffix' }, el, h('span', null, suffix)) : el;
  if (s.type === 'bool') {
    // checkbox first, then its description; the setting key stays underneath like other fields
    return h('label', { class: 'field check-row' }, h('span', { class: 'check-line' }, el, h('span', null, s.description)), h('small', { class: 'muted' }, s.key));
  }
  return h('label', { class: 'field' }, h('span', null, s.description), control, h('small', { class: 'muted' }, s.key));
}

/** Employee Welfare Fund card: status, dated rates and eligibility — every value is a System Setting. */
function ewfCard(items: SettingItem[], inputs: Map<string, HTMLInputElement>): HTMLElement | null {
  const by = (k: string) => items.find((s) => s.key === `payroll.ewf_${k}`);
  const enabled = by('enabled');
  if (!enabled) return null;
  const on = h('input', { type: 'radio', name: 'ewf-status', value: 'true', checked: enabled.value === 'true' });
  const off = h('input', { type: 'radio', name: 'ewf-status', value: 'false', checked: enabled.value !== 'true' });
  // the radio pair is submitted through a hidden checkbox so the generic save keeps working
  const hidden = h('input', { type: 'checkbox', name: enabled.key, checked: enabled.value === 'true', hidden: true });
  inputs.set(enabled.key, hidden);
  const sync = () => {
    hidden.checked = on.checked;
    card.classList.toggle('is-off', !on.checked);
  };
  on.addEventListener('change', sync);
  off.addEventListener('change', sync);
  const field = (k: string, suffix?: string) => {
    const s = by(k);
    return s ? settingInput(s, inputs, suffix) : null;
  };
  const card = h('section', { class: `card ewf-card ${enabled.value === 'true' ? '' : 'is-off'}`, id: 'ewf-settings' },
    h('div', { class: 'card-head' },
      h('div', null, h('h2', null, 'กองทุนสงเคราะห์ลูกจ้าง'), h('p', { class: 'muted small' }, 'Employee Welfare Fund (EWF)')),
      h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'สถานะกองทุนสงเคราะห์ลูกจ้าง' },
        h('label', null, on, h('span', null, 'เปิดใช้งาน')),
        h('label', null, off, h('span', null, 'ปิดใช้งาน')))),
    hidden,
    h('div', { class: 'alert ewf-note' }, 'ขอบเขตการคำนวณ: การคำนวณกองทุนสงเคราะห์ลูกจ้างต้องอ้างอิงค่าจ้างและเงื่อนไขตามกฎหมายที่มีผลบังคับใช้ — ระบบคำนวณจากค่าจ้าง (เงินเดือนหลังหักลาไม่รับค่าจ้าง) และเลือกอัตราตาม "วันจ่าย" ของงวดเงินเดือน'),
    h('h3', null, 'อัตราปัจจุบัน'),
    h('div', { class: 'grid-form' }, field('effective_date'), h('div'), field('employee_rate', '%'), field('employer_rate', '%')),
    h('h3', null, 'การเปลี่ยนอัตราครั้งถัดไป'),
    h('div', { class: 'grid-form' }, field('next_rate_date'), h('div'), field('next_employee_rate', '%'), field('next_employer_rate', '%')),
    h('h3', null, 'ฐานค่าจ้างและการเข้าเกณฑ์'),
    h('div', { class: 'grid-form' }, field('wage_cap', 'บาท'), field('min_employee_count', 'คน'), field('exempt_provident_fund'), field('provident_fund_component'), field('exempt_equivalent_welfare')),
    h('p', { class: 'muted small' }, 'เงินสะสมของพนักงานแสดงเป็นรายการหักในสลิป ส่วนเงินสมทบของนายจ้างบันทึกแยกและไม่หักจากเงินสุทธิของพนักงาน การเปลี่ยนค่าตั้งไม่กระทบงวดที่อนุมัติหรือเผยแพร่แล้ว'));
  return card;
}

interface JobRun {
  id: number;
  run_date: string;
  trigger: 'scheduled' | 'manual';
  status: 'running' | 'ok' | 'partial' | 'error';
  started_at: string;
  finished_at: string | null;
  summary: Record<string, number> | null;
  error: string | null;
  failures: Array<{ employeeId: number; kind: string; attempts: number; error?: string }> | null;
}

interface JobInfo {
  today: string;
  nextRun: string;
  settings: { notifications: boolean; reminderIntervalDays: number; autoActivate: boolean };
  runs: JobRun[];
}

interface JobResult {
  runId: number | null;
  status: string;
  summary: Record<string, number>;
  items: Array<{ employeeId: number; empCode: string; kind: string; due: string; result: string; notified?: number }>;
}

const RUN_STATUS: Record<string, string> = { running: 'กำลังทำงาน', ok: 'สำเร็จ', partial: 'สำเร็จบางส่วน', error: 'ล้มเหลว' };
const RUN_TRIGGER: Record<string, string> = { scheduled: 'ตามเวลา (Cron)', manual: 'สั่งรันเอง' };
const JOB_ACTION: Record<string, string> = { day90_notice: 'แจ้งครบ 90 วัน', reminder: 'แจ้งเตือนติดตาม', activate: 'เปลี่ยนเป็นปฏิบัติงาน', activate_due: 'แจ้งให้เปลี่ยนสถานะ' };
const JOB_RESULT: Record<string, string> = { done: 'ทำแล้ว', would_do: 'จะทำ', skipped: 'ทำไปแล้วก่อนหน้า', suppressed: 'บันทึกโดยไม่แจ้งซ้ำ', failed: 'ผิดพลาด' };

const runBadge = (status: string) => h('span', { class: `badge-status s-${status}` }, RUN_STATUS[status] ?? status);
const count = (v: number | undefined) => String(v ?? 0);

/**
 * Run log of the daily probation job (Super Admin only, as is the whole settings page): last and next run, what the
 * last run did, errors and retries, a dry run that writes nothing, and a manual run of the same idempotent job.
 * `initial` is fetched together with the settings, so the page renders once (no layout shift above the Save button).
 */
function probationJobCard(initial: JobInfo | Error): HTMLElement {
  const body = h('div');
  const preview = h('div', { class: 'job-preview', 'aria-live': 'polite' });
  const card = h('section', { class: 'card', id: 'probation-job' },
    h('h2', null, 'งานอัตโนมัติ: ทดลองงาน'),
    h('p', { class: 'muted small' }, 'Job Run Log · ทำงานทุกวันเวลา 00:05 และ 08:05 (เวลาไทย) รอบที่สองเป็นการลองซ้ำของรอบแรก'),
    body);
  const run = async (dryRun: boolean, btn: HTMLButtonElement) => {
    if (!dryRun && !(await confirmDialog('รันงานทดลองงานทันที', 'ระบบจะส่งแจ้งเตือนและเปลี่ยนสถานะพนักงานที่ครบ 120 วันตามค่าตั้งปัจจุบัน งานที่ทำไปแล้วจะไม่ทำซ้ำ', 'รันทันที'))) return;
    btn.disabled = true;
    try {
      const r = await post<JobResult>('/api/admin/jobs/probation/run', { dryRun });
      if (dryRun) {
        const todo = r.items.filter((i) => i.result !== 'skipped');
        mount(preview,
          h('div', { class: 'alert' }, h('strong', null, 'ผลทดลองรัน (ยังไม่บันทึกหรือแจ้งเตือนใด ๆ): '),
            `ประมวลผล ${count(r.summary.processed)} คน · แจ้งเตือน ${count(r.summary.notifications)} รายการ · เปลี่ยนสถานะ ${count(r.summary.activated)} คน`),
          todo.length
            ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
                h('thead', null, h('tr', null, ['รหัสพนักงาน', 'การดำเนินการ', 'ครบกำหนด', 'ผล', 'ผู้รับแจ้ง'].map((t) => h('th', null, t)))),
                h('tbody', null, todo.map((i) => h('tr', null, h('td', null, i.empCode), h('td', null, JOB_ACTION[i.kind] ?? i.kind), h('td', null, fmtDate(i.due)),
                  h('td', null, JOB_RESULT[i.result] ?? i.result), h('td', null, count(i.notified)))))))
            : h('p', { class: 'muted' }, 'วันนี้ไม่มีรายการที่ต้องทำ'));
      } else {
        toast(`รันแล้ว: ${RUN_STATUS[r.status] ?? r.status}`, r.status === 'ok' ? 'ok' : 'error');
        mount(preview);
        await load();
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      btn.disabled = false;
    }
  };
  const show = (d: JobInfo | Error) => {
    if (d instanceof Error) {
      mount(body, errorBox(d));
      return;
    }
    const last = d.runs[0];
    const s = last?.summary ?? {};
    const kpi = (label: string, value: HTMLElement | string, cls = '') => h('div', { class: `card kpi ${cls}` }, h('div', { class: 'kpi-label' }, label), h('div', { class: 'kpi-value' }, value));
    const dry: HTMLButtonElement = h('button', { class: 'btn', type: 'button', onclick: () => void run(true, dry) }, 'ทดลองรัน (Dry Run)') as HTMLButtonElement;
    const now: HTMLButtonElement = h('button', { class: 'btn primary', type: 'button', onclick: () => void run(false, now) }, 'รันทันที') as HTMLButtonElement;
    mount(body,
      h('p', { class: 'muted small' },
        `แจ้งเตือน: ${d.settings.notifications ? 'เปิด' : 'ปิด'} · แจ้งเตือนซ้ำทุก ${d.settings.reminderIntervalDays} วัน · เปลี่ยนสถานะอัตโนมัติวันที่ 120: ${d.settings.autoActivate ? 'เปิด' : 'ปิด'} · ผู้รับแจ้ง: HR ที่แก้ไขข้อมูลพนักงานได้ทุกบริษัท และ Super Admin`),
      h('div', { class: 'kpis' },
        kpi('ทำงานล่าสุด', last ? h('span', null, fmtDate(last.started_at), ' ', runBadge(last.status)) : '-', 'kpi-sm'),
        kpi('รอบถัดไป', fmtDate(d.nextRun), 'kpi-sm'),
        kpi('พนักงานที่ประมวลผล', count(s.processed)),
        kpi('แจ้งเตือนที่ส่ง', count(s.notifications)),
        kpi('เปลี่ยนสถานะอัตโนมัติ', count(s.activated)),
        kpi('ผิดพลาด / ลองซ้ำ', `${count(s.failed)} / ${count(s.retries)}`, s.failed ? 'kpi-bad' : s.retries ? 'kpi-warn' : '')),
      h('div', { class: 'toolbar' }, h('div', { class: 'spacer' }), dry, now),
      preview,
      d.runs.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
            h('thead', null, h('tr', null, ['วันที่ประมวลผล', 'การเรียก', 'สถานะ', 'เริ่ม', 'เสร็จ', 'ประมวลผล', 'แจ้งเตือน', 'เปลี่ยนสถานะ', 'ลองซ้ำ', 'ผิดพลาด', 'รายละเอียด'].map((t) => h('th', null, t)))),
            h('tbody', null, d.runs.map((r) => h('tr', null,
              h('td', null, fmtDate(r.run_date)), h('td', null, RUN_TRIGGER[r.trigger] ?? r.trigger), h('td', null, runBadge(r.status)),
              h('td', null, fmtDate(r.started_at)), h('td', null, fmtDate(r.finished_at)),
              h('td', null, count(r.summary?.processed)), h('td', null, count(r.summary?.notifications)), h('td', null, count(r.summary?.activated)),
              h('td', null, count(r.summary?.retries)), h('td', null, count(r.summary?.failed)),
              h('td', { class: 'small' }, r.failures?.length
                ? r.failures.map((f) => h('div', null, `พนักงาน #${f.employeeId} · ${JOB_ACTION[f.kind] ?? f.kind} · ลอง ${f.attempts} ครั้ง · ${f.error ?? ''}`))
                : r.status === 'error' ? (r.error ?? '') : '-'))))))
        : h('p', { class: 'muted' }, 'ยังไม่มีประวัติการทำงาน'));
  };
  const load = async () => show(await get<JobInfo>('/api/admin/jobs/probation').catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))));
  show(initial);
  return card;
}

export async function renderSettings(main: HTMLElement): Promise<void> {
  mount(main, loading());
  try {
    const [items, jobs] = await Promise.all([
      get<SettingItem[]>('/api/admin/settings'),
      get<JobInfo>('/api/admin/jobs/probation').catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
    ]);
    const inputs = new Map<string, HTMLInputElement>();
    const known = new Set<string>();
    const cards = SETTING_GROUPS.map((g) => {
      const list = items.filter((s) => g.match(s.key));
      list.forEach((s) => known.add(s.key));
      if (!list.length) return null;
      const card = h('section', { class: 'card' }, h('h2', null, g.title), h('div', { class: 'grid-form' }, list.map((s) => settingInput(s, inputs))));
      return g.title.startsWith('เงินเดือน') ? [card, ewfCard(items, inputs)] : card;
    });
    for (const s of items) if (s.key.startsWith('payroll.ewf_')) known.add(s.key);
    const other = items.filter((s) => !known.has(s.key));
    const msg = h('div', { class: 'form-msg', role: 'alert' });
    mount(main,
      h('p', { class: 'muted lead' }, 'เฉพาะ Super Admin เท่านั้นที่ดูและแก้ไขค่าตั้งระบบได้ ทุกการเปลี่ยนแปลงถูกบันทึกใน Audit Log'),
      // the run log comes first: the settings form ends with its Save button, the last thing on the page
      probationJobCard(jobs),
      h('form', { class: 'stack', onsubmit: async (e: Event) => {
        e.preventDefault();
        msg.textContent = '';
        const body: Record<string, unknown> = {};
        for (const [k, el] of inputs) body[k] = el.type === 'checkbox' ? el.checked : el.value;
        try {
          const r = await put<{ changed: number }>('/api/admin/settings', body);
          toast(r.changed ? `บันทึก ${r.changed} รายการแล้ว` : 'ไม่มีการเปลี่ยนแปลง');
        } catch (err) {
          msg.textContent = err instanceof Error ? err.message : String(err);
          const field = err instanceof ApiFailure ? (err.details as { field?: string } | undefined)?.field : undefined;
          if (field) main.querySelector<HTMLInputElement>(`[name="${field}"]`)?.focus();
          toast(msg.textContent, 'error');
        }
      } },
      cards,
      other.length ? h('section', { class: 'card' }, h('h2', null, 'อื่น ๆ'), h('div', { class: 'grid-form' }, other.map((s) => settingInput(s, inputs)))) : null,
      msg,
      h('div', { class: 'form-actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'บันทึกการตั้งค่า'))),
    );
  } catch (e) {
    mount(main, errorBox(e));
  }
}

export async function renderHelp(main: HTMLElement): Promise<void> {
  mount(main, loading());
  try {
    const d = await get<{ modules: Array<{ title: string; path: string; permission: string; allowed: boolean }> }>('/api/help');
    mount(main,
      h('section', { class: 'card prose' }, h('h2', null, 'เริ่มต้นใช้งาน'),
        h('ol', null,
          h('li', null, 'ผู้ดูแลระบบสร้างผู้ใช้ที่เมนู ผู้ใช้ระบบ กำหนดบทบาท และผูกกับข้อมูลพนักงาน (จำเป็นสำหรับ ESS, การยื่นคำขอ และสลิปเงินเดือน)'),
          h('li', null, 'ผู้ใช้ใหม่เข้าระบบด้วยรหัสผ่านชั่วคราวและต้องเปลี่ยนรหัสผ่านทันที บทบาทสิทธิ์สูงต้องตั้งค่า MFA ตามนโยบายในหน้า ตั้งค่าระบบ'),
          h('li', null, 'คำขอลา / OT / แก้ไขเวลา เข้าสู่ Workflow อนุมัติตามบทบาทที่กำหนดใน Workflow Engine ผู้ยื่นอนุมัติคำขอของตนเองไม่ได้'),
          h('li', null, 'เงินเดือน: สร้างงวด → คำนวณ → อนุมัติ (คนละคนกับผู้คำนวณ) → เผยแพร่ พนักงานดูสลิปได้ที่ สลิปเงินเดือนของฉัน'),
          h('li', null, 'การสร้าง แก้ไข ลบ อนุมัติ Export และการเข้าสู่ระบบทั้งหมดถูกบันทึกใน Audit Log'))),
      h('section', { class: 'card' }, h('h2', null, 'เมนูและสิทธิ์ที่ต้องใช้'),
        h('div', { class: 'table-scroll' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', null, 'เมนู'), h('th', null, 'สิทธิ์'), h('th', null, 'บัญชีของคุณ'))),
          h('tbody', null, d.modules.map((m) => h('tr', null, h('td', null, m.allowed ? link(m.path, m.title) : m.title), h('td', null, h('code', null, m.permission)), h('td', null, m.allowed ? '✓ เข้าถึงได้' : '—'))))))),
      can('settings.manage') ? h('p', { class: 'muted' }, 'ผู้ดูแลระบบ: ดูวิธีติดตั้ง/ย้ายฐานข้อมูลได้ใน README ของโปรเจกต์') : null,
    );
  } catch (e) {
    mount(main, errorBox(e));
  }
}
