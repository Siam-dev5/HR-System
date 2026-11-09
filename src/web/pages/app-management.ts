// App Management (Super Admin): users, roles, permission matrix, company scope, security & MFA, security audit.
// The page only renders what the API returns; every action is authorised again on the server. All text goes through
// the DOM builder (textContent), never innerHTML.
import type { AppAuditRow, AppOverview, AppRole, AppUserDetail, AppUserRow, MatrixGroup, MatrixAction, UserScope } from '../../shared/app-management';
import { MATRIX_ACTION_LABELS } from '../../shared/app-management';
import { hasPermission } from '../../shared/permissions';
import type { LookupOption, Row } from '../../shared/types';
import { del, get, post, put, qs } from '../api';
import { confirmDialog, errorBox, fmtDate, h, loading, modal, mount, toast, type Child } from '../dom';
import { state } from '../app';
import { clearLookups, lookup } from './crud';
import { showTempPassword } from './system';

type Tab = 'overview' | 'users' | 'roles' | 'matrix' | 'scope' | 'security' | 'audit';
const TABS: Array<[Tab, string]> = [
  ['overview', 'ภาพรวม'], ['users', 'ผู้ใช้'], ['roles', 'บทบาท'], ['matrix', 'Permission Matrix'], ['scope', 'Company Scope'], ['security', 'Security & MFA'], ['audit', 'Audit Log'],
];
const API = '/api/admin/app';

interface PermissionsResponse {
  actions: MatrixAction[];
  groups: MatrixGroup[];
  catalogue: string[];
  reserved: string[];
  roles: AppRole[];
}
interface ScopeResponse {
  companies: Array<{ id: number; code: string; name: string; active: number }>;
  users: AppUserRow[];
  allCompanyRoles: Array<{ code: string; name: string }>;
}
type SecurityUser = AppUserRow & { failed_attempts: number; password_changed_at: string | null; active_sessions: number; mfa_required: boolean };
interface SecurityResponse {
  policy: AppOverview['policy'];
  mfaAvailable: boolean;
  users: SecurityUser[];
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const badge = (text: string, kind = '') => h('span', { class: `badge-status ${kind}` }, text);
const selectOf = (options: Array<[string, string]>, value: string, attrs: Record<string, unknown> = {}) =>
  h('select', attrs, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));

function scopeBadge(s: UserScope): HTMLElement {
  if (s.scope === 'all') return badge('ทุกบริษัท', 's-approved');
  if (s.scope === 'own') return badge(`บริษัทของตนเอง${s.company ? ` · ${s.company}` : ''}`, 's-pending');
  return badge('ไม่มี', 's-rejected');
}

function statusBadge(u: AppUserRow): HTMLElement {
  if (u.approval_status === 'pending') return badge('รออนุมัติ', 's-pending');
  if (u.approval_status === 'rejected') return badge('ปฏิเสธคำขอ', 's-rejected');
  if (!u.active) return badge('ปิดใช้งาน', 's-rejected');
  if (u.locked_until) return badge(`ล็อกถึง ${fmtDate(u.locked_until)}`, 's-rejected');
  if (u.must_change_password) return badge('รอเปลี่ยนรหัสผ่าน', 's-pending');
  return badge('ใช้งาน', 's-active');
}

const mfaBadge = (u: AppUserRow) => (u.mfa_enabled ? badge('MFA เปิด', 's-approved') : u.privileged ? badge('ต้องตั้ง MFA', 's-rejected') : badge('MFA ปิด'));
const roleTags = (roles: string[]) => (roles.length ? h('span', { class: 'am-tags' }, roles.map((r) => h('code', null, r))) : h('span', { class: 'muted' }, '-'));

function emptyRow(cols: number, text: string): HTMLElement {
  return h('tr', null, h('td', { colspan: cols, class: 'empty' }, text));
}

function table(head: string[], rows: Child[], emptyText = 'ไม่มีข้อมูล'): HTMLElement {
  const body = (rows as unknown[]).length ? rows : [emptyRow(head.length, emptyText)];
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, head.map((t) => h('th', null, t)))), h('tbody', null, body)));
}

/** Runs an account action, reporting success or the server's refusal. */
async function act(label: string, fn: () => Promise<unknown>, done: () => void): Promise<void> {
  try {
    await fn();
    toast(label);
    done();
  } catch (e) {
    toast(errText(e), 'error');
  }
}

// ---- Page shell ----------------------------------------------------------------------------------------------------
export async function renderAppManagement(main: HTMLElement, params: URLSearchParams): Promise<void> {
  const tab = (TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'overview') as Tab;
  const go = (next: Record<string, string | null>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ tab, ...next })) if (v) p.set(k, v);
    history.replaceState(null, '', `${location.pathname}?${p.toString()}`);
    void renderAppManagement(main, p);
  };
  const body = h('div', { class: 'am-body' }, loading());
  mount(main,
    h('p', { class: 'muted lead' }, 'จัดการผู้ใช้ บทบาท สิทธิ์ ขอบเขตบริษัท และความปลอดภัยของบัญชี — เฉพาะ Super Admin ทุกการเปลี่ยนแปลงถูกตรวจสิทธิ์ที่เซิร์ฟเวอร์และบันทึกใน Audit Log'),
    h('nav', { class: 'segmented am-tabs', role: 'tablist', 'aria-label': 'App Management' },
      TABS.map(([k, l]) => h('button', { class: `btn small ${tab === k ? 'primary' : ''}`, role: 'tab', 'aria-selected': tab === k ? 'true' : 'false', 'data-tab': k, onclick: () => go({ tab: k, user: null, role: null }) }, l))),
    body,
  );
  try {
    if (tab === 'overview') await renderOverview(body, go);
    else if (tab === 'users') await renderUserTab(body, params, go);
    else if (tab === 'roles') await renderRoleTab(body, go);
    else if (tab === 'matrix') await renderMatrix(body, params, go);
    else if (tab === 'scope') await renderScope(body);
    else if (tab === 'security') await renderSecurityTab(body);
    else await renderAuditTab(body, params, go);
  } catch (e) {
    mount(body, errorBox(e));
  }
}

type Go = (next: Record<string, string | null>) => void;

// ---- Overview ------------------------------------------------------------------------------------------------------
async function renderOverview(body: HTMLElement, go: Go): Promise<void> {
  const d = await get<AppOverview>(`${API}/overview`);
  const kpi = (label: string, value: number | string, sub: string | null, warn = false, onclick?: () => void) =>
    h(onclick ? 'button' : 'div', { class: `kpi card ${warn ? 'kpi-warn' : ''} ${onclick ? 'link-card' : ''}`, onclick }, h('div', { class: 'kpi-label' }, label), h('div', { class: 'kpi-value' }, String(value)), sub ? h('div', { class: 'muted small' }, sub) : null);
  mount(body,
    h('div', { class: 'kpis' },
      kpi('ผู้ใช้ทั้งหมด', d.users.total, `ใช้งาน ${d.users.active} · ปิด ${d.users.inactive}`, false, () => go({ tab: 'users' })),
      kpi('รออนุมัติ', d.users.pending, 'คำขอลงทะเบียน', d.users.pending > 0, () => go({ tab: 'users', status: 'pending' })),
      kpi('บัญชีถูกล็อก', d.users.locked, null, d.users.locked > 0, () => go({ tab: 'users', status: 'locked' })),
      kpi('สิทธิ์สูงที่ยังไม่ตั้ง MFA', d.users.privilegedWithoutMfa, d.policy.mfaEnforcedForPrivileged ? 'นโยบายบังคับ MFA' : 'นโยบายไม่บังคับ MFA', d.users.privilegedWithoutMfa > 0, () => go({ tab: 'security' })),
      kpi('Super Admin ที่ใช้งาน', d.users.superAdmins, d.users.superAdmins < 2 ? 'ควรมีอย่างน้อย 2 บัญชี' : null, d.users.superAdmins < 2),
      kpi('บทบาท', d.roles.total, `ระบบ ${d.roles.system} · กำหนดเอง ${d.roles.custom}`, false, () => go({ tab: 'roles' })),
      kpi('สิทธิ์ในระบบ', d.permissions.catalogue, `สงวนไว้ Super Admin ${d.permissions.reserved}`, false, () => go({ tab: 'matrix' })),
      kpi('บริษัทที่ใช้งาน', d.companies, null, false, () => go({ tab: 'scope' })),
    ),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'นโยบายความปลอดภัย'), h('span', { class: 'muted small' }, 'แก้ไขได้ที่ ตั้งค่าระบบ › ความปลอดภัย')),
      h('ul', { class: 'am-list' },
        h('li', null, `บังคับ MFA สำหรับบทบาทสิทธิ์สูง: ${d.policy.mfaEnforcedForPrivileged ? 'เปิด' : 'ปิด'}${d.mfaAvailable ? '' : ' (ยังไม่ได้ตั้งค่า MFA_ENCRYPTION_KEY)'}`),
        h('li', null, `รหัสผ่านอย่างน้อย ${d.policy.passwordMinLength} ตัวอักษร · ล็อกบัญชีเมื่อผิด ${d.policy.lockoutThreshold} ครั้ง นาน ${d.policy.lockoutMinutes} นาที`),
        h('li', null, `ลงทะเบียนด้วยตนเอง: ${d.policy.selfRegistration ? 'เปิด' : 'ปิด'} · รอเปลี่ยนรหัสผ่าน ${d.users.mustChange} บัญชี · เปิด MFA แล้ว ${d.users.mfaEnabled} บัญชี`))),
    h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'การเปลี่ยนแปลงด้านความปลอดภัยล่าสุด'), h('button', { class: 'btn small', onclick: () => go({ tab: 'audit' }) }, 'ดูทั้งหมด')),
      auditTable(d.recent)),
  );
}

// ---- Users ---------------------------------------------------------------------------------------------------------
async function renderUserTab(body: HTMLElement, params: URLSearchParams, go: Go): Promise<void> {
  const filters = { q: params.get('q') ?? '', role: params.get('role') ?? '', status: params.get('status') ?? '', mfa: params.get('mfa') ?? '' };
  const [users, roles] = await Promise.all([get<AppUserRow[]>(`${API}/users${qs(filters)}`), lookup('roles')]);
  const reload = () => go(filters);
  const search = h('input', { type: 'search', value: filters.q, placeholder: 'ชื่อผู้ใช้ ชื่อ อีเมล รหัสพนักงาน', 'aria-label': 'ค้นหาผู้ใช้', maxlength: 100 });
  search.addEventListener('change', () => go({ ...filters, q: search.value.trim() }));
  const roleSel = selectOf([['', 'ทุกบทบาท'], ...roles.map((r): [string, string] => [r.code ?? '', r.label])], filters.role, { 'aria-label': 'บทบาท', onchange: (e: Event) => go({ ...filters, role: (e.target as HTMLSelectElement).value }) });
  const statusSel = selectOf([['', 'ทุกสถานะ'], ['active', 'ใช้งาน'], ['inactive', 'ปิดใช้งาน'], ['pending', 'รออนุมัติ'], ['rejected', 'ปฏิเสธ'], ['locked', 'ถูกล็อก'], ['must_change', 'รอเปลี่ยนรหัสผ่าน']], filters.status,
    { 'aria-label': 'สถานะ', onchange: (e: Event) => go({ ...filters, status: (e.target as HTMLSelectElement).value }) });
  const mfaSel = selectOf([['', 'MFA ทั้งหมด'], ['on', 'เปิด MFA'], ['off', 'ยังไม่เปิด MFA']], filters.mfa, { 'aria-label': 'MFA', onchange: (e: Event) => go({ ...filters, mfa: (e.target as HTMLSelectElement).value }) });
  const me = state.meta?.me.id;
  mount(body,
    h('div', { class: 'toolbar' }, search, roleSel, statusSel, mfaSel, h('div', { class: 'spacer' }), h('button', { class: 'btn primary', 'data-action': 'add-user', onclick: () => void userForm(null, roles, reload) }, '+ เพิ่มผู้ใช้')),
    h('p', { class: 'muted small' }, `พบ ${users.length} บัญชี`),
    table(['ผู้ใช้', 'บทบาท', 'พนักงาน', 'ขอบเขตบริษัท', 'MFA', 'สถานะ', 'เข้าระบบล่าสุด', ''], users.map((u) => h('tr', { 'data-user': u.username },
      h('td', null, h('strong', null, u.username), h('div', { class: 'muted small' }, u.display_name, u.email ? ` · ${u.email}` : '')),
      h('td', null, roleTags(u.roles)),
      h('td', null, u.employee ? `${u.employee.emp_code} ${u.employee.name}` : h('span', { class: 'muted' }, 'ไม่ผูก')),
      h('td', null, scopeBadge(u.scope)),
      h('td', null, mfaBadge(u)),
      h('td', null, statusBadge(u)),
      h('td', null, u.last_login_at ? fmtDate(u.last_login_at) : '-'),
      h('td', { class: 'actions' },
        h('button', { class: 'btn small', onclick: () => void userDetail(u.id) }, 'รายละเอียด'),
        u.approval_status === 'pending'
          ? [h('button', { class: 'btn small primary', onclick: () => void approveForm(u, roles, reload) }, 'อนุมัติ'),
            h('button', { class: 'btn small danger', onclick: async () => (await confirmDialog('ปฏิเสธคำขอ', `ปฏิเสธคำขอของ ${u.username}?`, 'ปฏิเสธ', true)) && act('ปฏิเสธคำขอแล้ว', () => post(`/api/admin/users/${u.id}/reject`), reload) }, 'ปฏิเสธ')]
          : [h('button', { class: 'btn small', onclick: () => void userForm(u, roles, reload) }, 'แก้ไข'),
            u.id === me ? null : h('button', {
              class: `btn small ${u.active ? 'danger' : ''}`,
              onclick: async () => (await confirmDialog(u.active ? 'ปิดใช้งานบัญชี' : 'เปิดใช้งานบัญชี', `${u.active ? 'ปิด' : 'เปิด'}ใช้งานบัญชี ${u.username}?${u.active ? ' ผู้ใช้จะถูกออกจากระบบทันที' : ''}`, 'ยืนยัน', !!u.active))
                && act(u.active ? 'ปิดใช้งานแล้ว' : 'เปิดใช้งานแล้ว', () => put(`/api/admin/users/${u.id}`, { active: !u.active }), reload),
            }, u.active ? 'ปิดใช้งาน' : 'เปิดใช้งาน')],
      ))), 'ไม่พบผู้ใช้ตามเงื่อนไข'),
  );
}

async function employeeOptions(): Promise<LookupOption[]> {
  return lookup('employees').catch(() => [] as LookupOption[]);
}

async function userForm(u: AppUserRow | null, roles: LookupOption[], onDone: () => void): Promise<void> {
  const self = !!u && u.id === state.meta?.me.id;
  const username = h('input', { value: u?.username ?? '', disabled: !!u, required: true, maxlength: 50, autocomplete: 'off' });
  const display = h('input', { value: u?.display_name ?? '', required: true, maxlength: 100 });
  const email = h('input', { type: 'email', value: u?.email ?? '', maxlength: 200 });
  const emps = await employeeOptions();
  const emp = h('select', null, h('option', { value: '' }, '— ไม่ผูก —'), emps.map((e) => h('option', { value: String(e.value), selected: e.value === u?.employee?.id }, e.label)));
  const roleChecks = roles.map((r) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: r.code ?? '', checked: !!u?.roles.includes(r.code ?? ''), disabled: self }), r.label));
  const msg = h('div', { class: 'form-msg', role: 'alert' });
  const dlg = modal(u ? `แก้ไขผู้ใช้ ${u.username}` : 'เพิ่มผู้ใช้', h('div', { class: 'grid-form' },
    h('label', { class: 'field' }, h('span', null, 'ชื่อผู้ใช้ *'), username), h('label', { class: 'field' }, h('span', null, 'ชื่อที่แสดง *'), display),
    h('label', { class: 'field' }, h('span', null, 'อีเมล'), email), h('label', { class: 'field' }, h('span', null, 'ผูกกับพนักงาน (กำหนดบริษัทของตนเอง)'), emp),
    h('div', { class: 'field span2' }, h('span', null, 'บทบาท'), self ? h('p', { class: 'muted small' }, 'เปลี่ยนบทบาทของตนเองไม่ได้ ต้องให้ Super Admin คนอื่นดำเนินการ') : null, h('div', { class: 'checks' }, roleChecks)),
    u ? null : h('p', { class: 'muted small span2' }, 'ระบบสร้างรหัสผ่านชั่วคราวแบบสุ่มและแสดงครั้งเดียว ผู้ใช้ต้องเปลี่ยนรหัสผ่านเมื่อเข้าระบบครั้งแรก (บทบาทสิทธิ์สูงต้องตั้ง MFA)'),
    msg), [
    h('button', { class: 'btn', onclick: () => dlg.close() }, 'ยกเลิก'),
    h('button', { class: 'btn primary', 'data-action': 'save-user', onclick: async () => {
      const chosen = roleChecks.map((l) => l.querySelector('input') as HTMLInputElement).filter((i) => i.checked).map((i) => i.value);
      const body: Record<string, unknown> = { displayName: display.value, email: email.value || null, employeeId: emp.value ? Number(emp.value) : null };
      if (!self) body.roles = chosen;
      try {
        if (u) await put(`/api/admin/users/${u.id}`, body);
        else {
          const r = await post<{ username: string; temporaryPassword: string }>('/api/admin/users', { ...body, username: username.value });
          showTempPassword(r.username, r.temporaryPassword);
        }
        clearLookups();
        dlg.close();
        toast('บันทึกแล้ว');
        onDone();
      } catch (e) {
        msg.textContent = errText(e);
      }
    } }, 'บันทึก'),
  ]);
}

async function approveForm(u: AppUserRow, roles: LookupOption[], onDone: () => void): Promise<void> {
  const emps = await employeeOptions();
  const emp = h('select', null, h('option', { value: '' }, '— ไม่ผูก —'), emps.map((e) => h('option', { value: String(e.value) }, e.label)));
  const roleChecks = roles.map((r) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: r.code ?? '', checked: r.code === 'employee' }), r.label));
  const msg = h('div', { class: 'form-msg', role: 'alert' });
  const dlg = modal(`อนุมัติคำขอของ ${u.username}`, h('div', { class: 'grid-form' },
    h('div', { class: 'field span2' }, h('span', null, 'บทบาทที่จะให้'), h('div', { class: 'checks' }, roleChecks)),
    h('label', { class: 'field span2' }, h('span', null, 'ผูกกับพนักงาน'), emp), msg), [
    h('button', { class: 'btn', onclick: () => dlg.close() }, 'ยกเลิก'),
    h('button', { class: 'btn primary', onclick: async () => {
      try {
        await post(`/api/admin/users/${u.id}/approve`, { roles: roleChecks.map((l) => l.querySelector('input') as HTMLInputElement).filter((i) => i.checked).map((i) => i.value), employeeId: emp.value ? Number(emp.value) : null });
        clearLookups();
        dlg.close();
        toast('อนุมัติแล้ว');
        onDone();
      } catch (e) {
        msg.textContent = errText(e);
      }
    } }, 'อนุมัติ'),
  ]);
}

async function userDetail(id: number): Promise<void> {
  const box = h('div', { class: 'am-detail' }, loading());
  modal('รายละเอียดผู้ใช้', box);
  try {
    const u = await get<AppUserDetail>(`${API}/users/${id}`);
    mount(box,
      h('dl', { class: 'am-dl' },
        h('dt', null, 'ผู้ใช้'), h('dd', null, `${u.username} · ${u.display_name}`),
        h('dt', null, 'อีเมล'), h('dd', null, u.email ?? '-'),
        h('dt', null, 'สถานะ'), h('dd', null, statusBadge(u), ' ', mfaBadge(u)),
        h('dt', null, 'บทบาท'), h('dd', null, roleTags(u.roles)),
        h('dt', null, 'พนักงาน'), h('dd', null, u.employee ? `${u.employee.emp_code} ${u.employee.name}${u.employee.company ? ` (${u.employee.company})` : ''}` : 'ไม่ผูก'),
        h('dt', null, 'ขอบเขตบริษัท'), h('dd', null, scopeBadge(u.scope), u.scope.via.length ? h('span', { class: 'muted small' }, ` จากบทบาท ${u.scope.via.join(', ')}`) : null),
        h('dt', null, 'เข้าระบบล่าสุด'), h('dd', null, u.last_login_at ? fmtDate(u.last_login_at) : '-'),
        h('dt', null, 'เปลี่ยนรหัสผ่านล่าสุด'), h('dd', null, u.password_changed_at ? fmtDate(u.password_changed_at) : '-'),
        h('dt', null, 'ใส่รหัสผิดติดกัน / Session'), h('dd', null, `${u.failed_attempts} ครั้ง · ${u.active_sessions} session`),
        h('dt', null, 'สร้างเมื่อ'), h('dd', null, fmtDate(u.created_at))),
      h('details', null, h('summary', null, `สิทธิ์ที่มีผลจริง (${u.effective_permissions.length})`), h('div', { class: 'catalogue' }, u.effective_permissions.map((p) => h('code', null, p)))),
      h('h3', null, 'ประวัติด้านความปลอดภัย'), auditTable(u.audit),
    );
  } catch (e) {
    mount(box, errorBox(e));
  }
}

// ---- Roles ---------------------------------------------------------------------------------------------------------
async function renderRoleTab(body: HTMLElement, go: Go): Promise<void> {
  const d = await get<PermissionsResponse>(`${API}/permissions`);
  const reload = () => go({});
  mount(body,
    h('div', { class: 'toolbar' }, h('p', { class: 'muted small' }, 'บทบาทของระบบ (ระบบ) ลบไม่ได้ · สิทธิ์ของ Super Admin แก้ไขไม่ได้ · กำหนดสิทธิ์รายการได้ที่ Permission Matrix'), h('div', { class: 'spacer' }),
      h('button', { class: 'btn primary', 'data-action': 'add-role', onclick: () => roleForm(null, reload) }, '+ เพิ่มบทบาท')),
    table(['บทบาท', 'ประเภท', 'สิทธิ์สูง (MFA)', 'ผู้ใช้', 'สิทธิ์', ''], d.roles.map((r) => h('tr', { 'data-role': r.code },
      h('td', null, h('strong', null, r.name), h('div', { class: 'muted small' }, h('code', null, r.code), r.description ? ` · ${r.description}` : '')),
      h('td', null, r.system ? badge('ระบบ') : badge('กำหนดเอง', 's-pending')),
      h('td', null, r.privileged ? 'ใช่' : '-'),
      h('td', null, String(r.users)),
      h('td', null, r.code === 'super_admin' ? 'ทุกสิทธิ์' : `${r.permissions.length} รายการ`),
      h('td', { class: 'actions' },
        r.code === 'super_admin' ? h('span', { class: 'muted small' }, 'ป้องกัน') : [
          h('button', { class: 'btn small', onclick: () => roleForm(r, reload) }, 'แก้ไข'),
          h('button', { class: 'btn small', onclick: () => go({ tab: 'matrix', role: r.code }) }, 'สิทธิ์'),
          r.system || r.users > 0 ? null : h('button', { class: 'btn small danger', onclick: async () => (await confirmDialog('ลบบทบาท', `ลบบทบาท ${r.name}?`, 'ลบ', true)) && act('ลบบทบาทแล้ว', () => del(`/api/admin/roles/${r.id}`), reload) }, 'ลบ'),
        ])))),
  );
}

function roleForm(r: AppRole | null, onDone: () => void): void {
  const code = h('input', { value: r?.code ?? '', disabled: !!r, maxlength: 50, placeholder: 'เช่น acc_auditor' });
  const name = h('input', { value: r?.name ?? '', maxlength: 100 });
  const description = h('textarea', { rows: 2, maxlength: 300, value: r?.description ?? '' });
  const privileged = h('input', { type: 'checkbox', checked: r ? r.privileged === 1 : true });
  const msg = h('div', { class: 'form-msg', role: 'alert' });
  const dlg = modal(r ? `แก้ไขบทบาท ${r.name}` : 'เพิ่มบทบาท', h('div', { class: 'grid-form' },
    h('label', { class: 'field' }, h('span', null, 'รหัส (a-z 0-9 _)'), code), h('label', { class: 'field' }, h('span', null, 'ชื่อ *'), name),
    h('label', { class: 'field span2' }, h('span', null, 'คำอธิบาย'), description),
    h('label', { class: 'field check' }, h('span', null, 'สิทธิ์สูง (นโยบาย MFA จะบังคับใช้)'), privileged),
    r ? null : h('p', { class: 'muted small span2' }, 'บทบาทใหม่เริ่มโดยไม่มีสิทธิ์ กำหนดสิทธิ์ต่อที่ Permission Matrix'),
    msg), [
    h('button', { class: 'btn', onclick: () => dlg.close() }, 'ยกเลิก'),
    h('button', { class: 'btn primary', onclick: async () => {
      try {
        const payload = { name: name.value, description: description.value, privileged: privileged.checked };
        if (r) await put(`/api/admin/roles/${r.id}`, { ...payload, permissions: r.permissions });
        else await post('/api/admin/roles', { ...payload, code: code.value, permissions: [] });
        clearLookups();
        dlg.close();
        toast('บันทึกแล้ว');
        onDone();
      } catch (e) {
        msg.textContent = errText(e);
      }
    } }, 'บันทึก'),
  ]);
}

// ---- Permission matrix ---------------------------------------------------------------------------------------------
async function renderMatrix(body: HTMLElement, params: URLSearchParams, go: Go): Promise<void> {
  const d = await get<PermissionsResponse>(`${API}/permissions`);
  const role = d.roles.find((r) => r.code === params.get('role')) ?? d.roles.find((r) => r.code !== 'super_admin') ?? d.roles[0];
  if (!role) {
    mount(body, h('div', { class: 'empty' }, 'ยังไม่มีบทบาท'));
    return;
  }
  const locked = role.code === 'super_admin';
  const catalogue = new Set(d.catalogue);
  // patterns that are not exact catalogue keys (wildcards) are kept as they are; exact keys are edited by checkbox
  const patterns = role.permissions.filter((p) => !catalogue.has(p));
  const exact = new Set(role.permissions.filter((p) => catalogue.has(p)));
  const status = h('span', { class: 'muted small', 'aria-live': 'polite' });
  const saveBtn = h('button', { class: 'btn primary', disabled: true, 'data-action': 'save-matrix' }, 'บันทึกสิทธิ์');
  const changed = () => {
    const now = [...checks.values()].filter((c) => c.checked && !c.disabled).map((c) => c.value);
    const diff = now.filter((p) => !exact.has(p)).length + [...exact].filter((p) => !now.includes(p)).length;
    saveBtn.disabled = locked || diff === 0;
    status.textContent = diff ? `เปลี่ยนแปลง ${diff} รายการ (ยังไม่บันทึก)` : '';
  };
  const checks = new Map<string, HTMLInputElement>();
  const cell = (perm: string | undefined): HTMLElement => {
    if (!perm) return h('td', { class: 'am-c muted', 'aria-label': 'ไม่มี' }, '–');
    const viaPattern = !exact.has(perm) && hasPermission(patterns, perm);
    const granted = locked || exact.has(perm) || viaPattern;
    const box = h('input', { type: 'checkbox', value: perm, checked: granted, disabled: locked || viaPattern, title: viaPattern ? `ได้จาก pattern ${patterns.filter((p) => hasPermission([p], perm)).join(', ')}` : perm, 'aria-label': perm, onchange: changed });
    checks.set(perm, box);
    return h('td', { class: 'am-c' }, box);
  };
  saveBtn.addEventListener('click', async () => {
    const chosen = [...checks.values()].filter((c) => c.checked && !c.disabled).map((c) => c.value);
    if (!(await confirmDialog('บันทึกสิทธิ์', `บันทึกสิทธิ์ของบทบาท ${role.name}? ผู้ใช้ในบทบาทนี้ (${role.users}) จะต้องเข้าสู่ระบบใหม่`, 'บันทึก'))) return;
    await act('บันทึกสิทธิ์แล้ว', () => put(`/api/admin/roles/${role.id}`, { permissions: [...patterns, ...chosen] }), () => go({ role: role.code }));
  });
  const actions = d.actions;
  mount(body,
    h('div', { class: 'toolbar' },
      h('label', { class: 'field inline' }, h('span', null, 'บทบาท'), selectOf(d.roles.map((r): [string, string] => [r.code, `${r.name} (${r.code})`]), role.code, { 'aria-label': 'บทบาท', onchange: (e: Event) => go({ role: (e.target as HTMLSelectElement).value }) })),
      h('div', { class: 'spacer' }), status, saveBtn),
    locked ? h('div', { class: 'alert' }, 'Super Admin มีทุกสิทธิ์ (*) และแก้ไขไม่ได้') : null,
    patterns.length && !locked ? h('p', { class: 'muted small' }, 'Pattern ของบทบาทนี้ (คงไว้ตามเดิม แก้ได้ทีละรายการเท่านั้น): ', patterns.map((p) => h('code', null, p))) : null,
    h('p', { class: 'muted small' }, 'แสดงเฉพาะสิทธิ์ที่มีอยู่จริงในระบบ · ช่องที่เป็น – คือไม่มีสิทธิ์นั้นในโมดูล · 🔒 สงวนไว้สำหรับ Super Admin'),
    d.groups.map((g) => h('section', { class: 'card am-matrix-card' },
      h('h2', null, g.title),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table am-matrix' },
        h('thead', null, h('tr', null, h('th', null, 'โมดูล'), actions.map((a) => h('th', { class: 'am-c' }, MATRIX_ACTION_LABELS[a])), h('th', null, 'อื่น ๆ'))),
        h('tbody', null, g.rows.map((r) => h('tr', { 'data-resource': r.resource },
          h('th', { scope: 'row' }, r.title, h('div', { class: 'muted small' }, h('code', null, r.resource))),
          actions.map((a) => (r.reserved.includes(`${r.resource}.${a}`) ? h('td', { class: 'am-c', title: 'Super Admin เท่านั้น' }, '🔒') : cell(r.cells[a]))),
          h('td', null, r.extras.map((p) => {
            const c = cell(p).firstChild;
            return c ? h('label', { class: 'check small' }, c, p.split('.').slice(1).join('.')) : null;
          }), r.reserved.filter((p) => !actions.some((a) => p === `${r.resource}.${a}`)).map((p) => h('span', { class: 'check small', title: 'Super Admin เท่านั้น' }, '🔒 ', p.split('.').slice(1).join('.'))))))))))),
  );
}

// ---- Company scope -------------------------------------------------------------------------------------------------
async function renderScope(body: HTMLElement): Promise<void> {
  const d = await get<ScopeResponse>(`${API}/company-scope`);
  const reload = () => void renderScope(body).catch((e) => mount(body, errorBox(e)));
  mount(body,
    h('section', { class: 'card' },
      h('h2', null, 'รูปแบบขอบเขตบริษัทของระบบ'),
      h('ul', { class: 'am-list' },
        h('li', null, h('strong', null, 'ทุกบริษัท: '), 'ได้จากบทบาทที่มีสิทธิ์ ', h('code', null, 'employees.all'), ' — ', d.allCompanyRoles.map((r) => h('code', null, r.code))),
        h('li', null, h('strong', null, 'บริษัทของตนเอง: '), 'บริษัทของพนักงานที่ผูกกับบัญชี (เปลี่ยนได้ที่นี่ ระบบตรวจสอบบริษัทและพนักงานที่เซิร์ฟเวอร์)'),
        h('li', null, h('strong', null, 'ไม่มี: '), 'ไม่ผูกพนักงานและไม่มีบทบาททุกบริษัท'))),
    table(['ผู้ใช้', 'บทบาท', 'ขอบเขต', 'บริษัทของตนเอง', 'ทุกบริษัทจากบทบาท', ''], d.users.map((u) => h('tr', { 'data-user': u.username },
      h('td', null, h('strong', null, u.username), h('div', { class: 'muted small' }, u.display_name)),
      h('td', null, roleTags(u.roles)),
      h('td', null, scopeBadge(u.scope)),
      h('td', null, u.employee ? `${u.employee.company ?? '-'} · ${u.employee.emp_code}` : '-'),
      h('td', null, u.scope.via.length ? u.scope.via.join(', ') : '-'),
      h('td', { class: 'actions' }, h('button', { class: 'btn small', onclick: () => void scopeForm(u, d.companies, reload) }, 'เปลี่ยนการผูกพนักงาน'))))),
  );
}

async function scopeForm(u: AppUserRow, companies: ScopeResponse['companies'], onDone: () => void): Promise<void> {
  const company = selectOf([['', '— ไม่ผูกพนักงาน —'], ...companies.filter((c) => c.active).map((c): [string, string] => [String(c.id), `${c.code} ${c.name}`])], String(u.employee?.company_id ?? ''), { 'aria-label': 'บริษัท' });
  const emp = h('select', { 'aria-label': 'พนักงาน' });
  const msg = h('div', { class: 'form-msg', role: 'alert' });
  const loadEmployees = async () => {
    if (!company.value) {
      mount(emp, h('option', { value: '' }, '—'));
      return;
    }
    mount(emp, h('option', { value: '' }, 'กำลังโหลด…'));
    try {
      const r = await get<{ rows: Row[] }>(`/api/m/employees${qs({ 'f.company_id': company.value, pageSize: 200 })}`);
      mount(emp, h('option', { value: '' }, '— เลือกพนักงาน —'), r.rows.map((e) => h('option', { value: String(e.id), selected: e.id === u.employee?.id }, `${String(e.emp_code)} ${String(e.first_name)} ${String(e.last_name)}`)));
    } catch (e) {
      msg.textContent = errText(e);
    }
  };
  company.addEventListener('change', () => void loadEmployees());
  const dlg = modal(`ขอบเขตบริษัทของ ${u.username}`, h('div', { class: 'grid-form' },
    h('p', { class: 'span2 muted small' }, u.scope.via.length ? `บัญชีนี้เห็นทุกบริษัทจากบทบาท ${u.scope.via.join(', ')} การผูกพนักงานกำหนดเฉพาะบริษัทของตนเอง (ESS / สลิป)` : 'การผูกพนักงานกำหนดบริษัทที่บัญชีนี้เข้าถึงได้'),
    h('label', { class: 'field' }, h('span', null, 'บริษัท'), company), h('label', { class: 'field' }, h('span', null, 'พนักงาน'), emp), msg), [
    h('button', { class: 'btn', onclick: () => dlg.close() }, 'ยกเลิก'),
    h('button', { class: 'btn primary', onclick: async () => {
      if (company.value && !emp.value) {
        msg.textContent = 'กรุณาเลือกพนักงาน';
        return;
      }
      try {
        await put(`${API}/users/${u.id}/company-scope`, { employeeId: emp.value ? Number(emp.value) : null, companyId: company.value ? Number(company.value) : null });
        clearLookups();
        dlg.close();
        toast('บันทึกขอบเขตบริษัทแล้ว');
        onDone();
      } catch (e) {
        msg.textContent = errText(e);
      }
    } }, 'บันทึก'),
  ]);
  await loadEmployees();
}

// ---- Security & MFA ------------------------------------------------------------------------------------------------
async function renderSecurityTab(body: HTMLElement): Promise<void> {
  const d = await get<SecurityResponse>(`${API}/security`);
  const reload = () => void renderSecurityTab(body).catch((e) => mount(body, errorBox(e)));
  const me = state.meta?.me.id;
  const confirmAct = async (u: SecurityUser, title: string, text: string, fn: () => Promise<unknown>) => {
    if (await confirmDialog(title, text, 'ยืนยัน', true)) await act('ดำเนินการแล้ว', fn, reload);
  };
  mount(body,
    h('section', { class: 'card' }, h('h2', null, 'นโยบาย'),
      h('p', null, `บังคับ MFA สำหรับบทบาทสิทธิ์สูง: ${d.policy.mfaEnforcedForPrivileged ? 'เปิด' : 'ปิด'} · รหัสผ่านอย่างน้อย ${d.policy.passwordMinLength} ตัว · ล็อกเมื่อผิด ${d.policy.lockoutThreshold} ครั้ง`),
      d.mfaAvailable ? null : h('div', { class: 'alert alert-error' }, 'ยังไม่ได้ตั้งค่า MFA_ENCRYPTION_KEY ผู้ใช้จึงตั้ง MFA ไม่ได้'),
      h('p', { class: 'muted small' }, 'ผู้ดูแลไม่สามารถดูรหัสผ่านหรือ secret ของ MFA ได้ — ทำได้เพียงบังคับเปลี่ยนรหัส รีเซ็ตรหัสชั่วคราว (แสดงครั้งเดียว) หรือรีเซ็ต MFA ให้ผู้ใช้ตั้งใหม่')),
    table(['ผู้ใช้', 'บทบาท', 'MFA', 'รหัสผ่าน', 'ล็อก / ผิดติดกัน', 'Session', ''], d.users.map((u) => h('tr', { 'data-user': u.username },
      h('td', null, h('strong', null, u.username), h('div', { class: 'muted small' }, u.active ? 'ใช้งาน' : 'ปิดใช้งาน')),
      h('td', null, roleTags(u.roles)),
      h('td', null, mfaBadge(u), u.mfa_required && !u.mfa_enabled ? h('div', { class: 'muted small' }, 'นโยบายบังคับ') : null),
      h('td', null, u.must_change_password ? badge('ต้องเปลี่ยน', 's-pending') : badge('ปกติ'), h('div', { class: 'muted small' }, u.password_changed_at ? `เปลี่ยนเมื่อ ${fmtDate(u.password_changed_at)}` : 'ยังไม่เคยเปลี่ยน')),
      h('td', null, u.locked_until ? badge(`ล็อกถึง ${fmtDate(u.locked_until)}`, 's-rejected') : '-', u.failed_attempts ? h('div', { class: 'muted small' }, `ผิด ${u.failed_attempts} ครั้ง`) : null),
      h('td', null, String(u.active_sessions)),
      h('td', { class: 'actions' }, u.id === me ? h('span', { class: 'muted small' }, 'บัญชีของคุณ') : [
        u.must_change_password ? null : h('button', { class: 'btn small', 'data-action': 'require-change', onclick: () => void confirmAct(u, 'บังคับเปลี่ยนรหัสผ่าน', `ให้ ${u.username} เปลี่ยนรหัสผ่านก่อนใช้งานครั้งถัดไป?`, () => post(`${API}/users/${u.id}/require-password-change`)) }, 'บังคับเปลี่ยนรหัส'),
        h('button', { class: 'btn small', onclick: async () => {
          if (!(await confirmDialog('รีเซ็ตรหัสผ่าน', `สร้างรหัสผ่านชั่วคราวใหม่ให้ ${u.username}? รหัสเดิมจะใช้ไม่ได้และผู้ใช้จะออกจากระบบ`, 'รีเซ็ต', true))) return;
          try {
            const r = await post<{ temporaryPassword: string }>(`/api/admin/users/${u.id}/reset-password`);
            showTempPassword(u.username, r.temporaryPassword);
            reload();
          } catch (e) {
            toast(errText(e), 'error');
          }
        } }, 'รีเซ็ตรหัส'),
        u.locked_until ? h('button', { class: 'btn small', onclick: () => void act('ปลดล็อกแล้ว', () => post(`/api/admin/users/${u.id}/unlock`), reload) }, 'ปลดล็อก') : null,
        u.mfa_enabled ? h('button', { class: 'btn small danger', onclick: () => void confirmAct(u, 'รีเซ็ต MFA', `ยกเลิก MFA ของ ${u.username} ให้ตั้งใหม่ในการเข้าระบบครั้งถัดไป?`, () => post(`/api/admin/users/${u.id}/reset-mfa`)) }, 'รีเซ็ต MFA') : null,
      ])))),
  );
}

// ---- Audit ---------------------------------------------------------------------------------------------------------
function auditTable(rows: AppAuditRow[]): HTMLElement {
  return table(['เวลา (UTC)', 'ผู้ดำเนินการ', 'Action', 'เป้าหมาย', 'รายละเอียด'], rows.map((r) => h('tr', null,
    h('td', null, r.at), h('td', null, r.username ?? '-'), h('td', null, h('code', null, r.action)), h('td', null, `${r.entity ?? '-'}${r.entity_id ? ` #${r.entity_id}` : ''}`),
    h('td', null, r.details ? h('details', null, h('summary', { class: 'truncate' }, r.details), h('pre', { class: 'am-json' }, pretty(r.details))) : '-'))), 'ยังไม่มีรายการ');
}

function pretty(details: string): string {
  try {
    return JSON.stringify(JSON.parse(details), null, 2);
  } catch {
    return details;
  }
}

async function renderAuditTab(body: HTMLElement, params: URLSearchParams, go: Go): Promise<void> {
  const action = params.get('action') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const d = await get<{ rows: AppAuditRow[]; total: number; page: number; pageSize: number }>(`${API}/audit${qs({ action, page, userId: params.get('user') })}`);
  const pages = Math.max(1, Math.ceil(d.total / d.pageSize));
  mount(body,
    h('div', { class: 'toolbar' },
      h('label', { class: 'field inline' }, h('span', null, 'ประเภท'), selectOf([['', 'ทั้งหมด (ด้านความปลอดภัย)'], ['user.', 'ผู้ใช้'], ['role.', 'บทบาท / สิทธิ์'], ['settings.', 'ตั้งค่าระบบ'], ['auth.', 'การเข้าระบบ'], ['mfa.', 'MFA']], action,
        { 'aria-label': 'ประเภท', onchange: (e: Event) => go({ action: (e.target as HTMLSelectElement).value, user: params.get('user') }) }))),
    auditTable(d.rows),
    h('div', { class: 'pager' }, h('span', null, `ทั้งหมด ${d.total} รายการ`),
      h('button', { class: 'btn small', disabled: page <= 1, onclick: () => go({ action, page: String(page - 1) }) }, '‹'), h('span', null, `${page} / ${pages}`),
      h('button', { class: 'btn small', disabled: page >= pages, onclick: () => go({ action, page: String(page + 1) }) }, '›')),
  );
}
