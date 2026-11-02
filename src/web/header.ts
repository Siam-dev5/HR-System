// Top bar menus: company switcher, theme and the user account menu.
import type { CompanyOption, MetaResponse } from '../shared/types';
import { h, mount, toast, type Child } from './dom';
import { link, refreshRoute, state } from './app';
import { resolvedTheme, setThemePref, themePref, type ThemePref } from './theme';

// ---- dropdown primitive: one menu open at a time, outside click / Escape close, arrow-key navigation ----

interface OpenMenu {
  wrap: HTMLElement;
  close: (restoreFocus: boolean) => void;
}
let openMenu: OpenMenu | null = null;

const ITEM_SELECTOR = '[role="menuitem"], [role="menuitemradio"]';

export function closeMenus(): void {
  openMenu?.close(false);
}

export function closeNotifications(): void {
  document.getElementById('notif-panel')?.remove();
}

let listening = false;
function listenGlobally(): void {
  if (listening) return;
  listening = true;
  document.addEventListener('click', (e) => {
    const target = e.target as Node;
    if (openMenu && !openMenu.wrap.contains(target)) openMenu.close(false);
    const panel = document.getElementById('notif-panel');
    if (panel && !panel.contains(target) && !(target instanceof Element && target.closest('.bell'))) panel.remove();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeMenus();
    closeNotifications();
  });
}

function dropdown(opts: { id: string; label: () => string; className: string; button: () => Child; panel: (close: () => void) => Child }) {
  const btn = h('button', { type: 'button', class: `hdr-btn ${opts.className}`, 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': opts.id });
  const panel = h('div', { class: 'dd-panel', id: opts.id, role: 'menu', hidden: true });
  const wrap = h('div', { class: 'dd' }, btn, panel);
  const items = () => [...panel.querySelectorAll<HTMLElement>(ITEM_SELECTOR)];
  const api: OpenMenu = {
    wrap,
    close: (restoreFocus) => {
      if (panel.hidden) return;
      panel.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      if (openMenu === api) openMenu = null;
      if (restoreFocus) btn.focus();
    },
  };
  const refresh = () => {
    mount(btn, opts.button());
    btn.setAttribute('aria-label', opts.label());
    btn.title = opts.label();
    panel.setAttribute('aria-label', opts.label());
  };
  const open = () => {
    closeMenus();
    closeNotifications();
    document.body.classList.remove('nav-open');
    mount(panel, opts.panel(() => api.close(true)));
    panel.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    openMenu = api;
    const list = items();
    (list.find((i) => i.getAttribute('aria-checked') === 'true') ?? list[0])?.focus();
  };
  btn.addEventListener('click', () => (panel.hidden ? open() : api.close(false)));
  btn.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    if (panel.hidden) open();
  });
  panel.addEventListener('keydown', (e) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    if (e.key === 'ArrowDown') next = list[(i + 1) % list.length];
    else if (e.key === 'ArrowUp') next = list[(i - 1 + list.length) % list.length];
    else if (e.key === 'Home') next = list[0];
    else if (e.key === 'End') next = list[list.length - 1];
    else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      api.close(true);
      return;
    } else if (e.key === 'Tab') {
      api.close(false);
      return;
    } else return;
    e.preventDefault();
    next?.focus();
  });
  refresh();
  return { el: wrap, refresh };
}

const radio = (checked: boolean, icon: string, label: string, sub: string | null, onSelect: () => void) =>
  h('button', { type: 'button', role: 'menuitemradio', 'aria-checked': String(checked), tabindex: '-1', class: 'dd-item', onclick: onSelect },
    h('span', { class: 'dd-ico', 'aria-hidden': 'true' }, icon),
    h('span', { class: 'dd-text' }, h('span', null, label), sub ? h('small', null, sub) : null),
    h('span', { class: 'dd-check', 'aria-hidden': 'true' }, checked ? '✓' : ''));

const menuLink = (path: string, icon: string, label: string, sub: string | null) =>
  link(path, [h('span', { class: 'dd-ico', 'aria-hidden': 'true' }, icon), h('span', { class: 'dd-text' }, h('span', null, label), sub ? h('small', null, sub) : null)],
    { role: 'menuitem', tabindex: '-1', class: 'dd-item' });

const divider = () => h('div', { class: 'dd-sep', role: 'separator' });

// ---- company context -----------------------------------------------------------------------

const companyKey = (meta: MetaResponse) => `hr.company.${meta.me.id}`;

/** Restores the saved company if it is still in the user's scope; the API re-checks every request. */
function initialCompany(meta: MetaResponse): number | null {
  const { scope, items, ownCompanyId } = meta.companies;
  if (scope === 'own') return ownCompanyId;
  if (scope === 'none') return null;
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(companyKey(meta));
  } catch {
    /* storage blocked */
  }
  const id = Number(saved);
  return items.some((c) => c.id === id) ? id : null;
}

export function activeCompany(): CompanyOption | null {
  return state.meta?.companies.items.find((c) => c.id === state.companyId) ?? null;
}

function companyLabel(meta: MetaResponse): string {
  const current = activeCompany();
  if (current) return current.name;
  if (meta.companies.scope === 'all') return meta.companies.items.length ? 'ทุกบริษัท' : 'ยังไม่มีข้อมูลบริษัท';
  return 'ไม่ได้ผูกกับบริษัท';
}

function scopeSummary(meta: MetaResponse): string {
  const { scope, items } = meta.companies;
  if (scope === 'all') return items.length ? `เข้าถึงได้ทุกบริษัท (${items.length})` : 'เข้าถึงได้ทุกบริษัท · ยังไม่มีข้อมูลบริษัท';
  if (scope === 'own') return `เฉพาะ ${items[0]?.name ?? 'บริษัทต้นสังกัด'}`;
  return 'ไม่ได้ผูกกับบริษัท';
}

function companyMenu(meta: MetaResponse) {
  const { scope, items, ownCompanyId } = meta.companies;
  const canSetup = meta.menu.some((m) => m.path === '/setup/companies');
  const dd = dropdown({
    id: 'company-menu',
    className: 'company-btn',
    label: () => `บริษัท: ${companyLabel(meta)}`,
    button: () => [h('span', { class: 'hdr-ico', 'aria-hidden': 'true' }, '🏢'), h('span', { class: 'hdr-label' }, companyLabel(meta)), h('span', { class: 'caret', 'aria-hidden': 'true' }, '▾')],
    panel: (close) => {
      const select = (id: number | null) => {
        close();
        if (id === state.companyId) return;
        state.companyId = id;
        try {
          if (id === null) localStorage.removeItem(companyKey(meta));
          else localStorage.setItem(companyKey(meta), String(id));
        } catch {
          /* storage blocked: the choice lasts until reload */
        }
        dd.refresh();
        toast(`เปลี่ยนบริษัทเป็น ${companyLabel(meta)}`);
        refreshRoute();
      };
      const sub = (c: CompanyOption) => (c.id === ownCompanyId ? `${c.code} · บริษัทต้นสังกัด` : c.code);
      return [
        h('div', { class: 'dd-head' }, h('strong', null, 'เลือกบริษัท'), h('small', null, scopeSummary(meta))),
        scope === 'all' && items.length ? radio(state.companyId === null, '🌐', 'ทุกบริษัท', `${items.length} บริษัทที่เข้าถึงได้`, () => select(null)) : null,
        items.map((c) => radio(state.companyId === c.id, '🏢', c.name, sub(c), () => select(c.id))),
        !items.length ? h('div', { class: 'dd-note' }, scope === 'all' ? 'ยังไม่มีข้อมูลบริษัทในระบบ' : 'บัญชีนี้ยังไม่ได้ผูกกับข้อมูลพนักงาน จึงไม่มีบริษัทให้เลือก') : null,
        !items.length && canSetup ? menuLink('/setup/companies', '⚙️', 'ตั้งค่าข้อมูลบริษัท', null) : null,
        scope === 'own' ? h('div', { class: 'dd-note' }, 'บัญชีนี้เข้าถึงได้เฉพาะบริษัทต้นสังกัด') : null,
        items.length ? [divider(), h('div', { class: 'dd-note' }, 'บริษัทที่เลือกใช้กรองข้อมูลใน Executive Dashboard · หน้าอื่นแสดงข้อมูลตามสิทธิ์ของบทบาท')] : null,
      ];
    },
  });
  return dd.el;
}

// ---- theme ---------------------------------------------------------------------------------

const THEMES: Array<{ value: ThemePref; icon: string; label: string }> = [
  { value: 'light', icon: '☀️', label: 'สว่าง' },
  { value: 'dark', icon: '🌙', label: 'มืด' },
  { value: 'auto', icon: '◐', label: 'อัตโนมัติ' },
];

function themeMenu() {
  const dd = dropdown({
    id: 'theme-menu',
    className: 'icon-only',
    label: () => `ธีม: ${THEMES.find((t) => t.value === themePref())?.label ?? ''}`,
    button: () => h('span', { 'aria-hidden': 'true' }, '⚙️'),
    panel: (close) => [
      h('div', { class: 'dd-head' }, h('strong', null, 'ธีมการแสดงผล'), h('small', null, 'บันทึกไว้ในเบราว์เซอร์นี้')),
      THEMES.map((t) => radio(themePref() === t.value, t.icon, t.label, t.value === 'auto' ? `ตามระบบ (ตอนนี้: ${resolvedTheme('auto') === 'dark' ? 'มืด' : 'สว่าง'})` : null, () => {
        setThemePref(t.value);
        dd.refresh();
        close();
      })),
    ],
  });
  return dd.el;
}

// ---- user account --------------------------------------------------------------------------

function initial(name: string): string {
  return (Array.from(name.trim())[0] ?? '?').toUpperCase();
}

function userMenu(meta: MetaResponse, onLogout: () => void) {
  const { me, profile } = meta;
  const can = (path: string) => meta.menu.some((m) => m.path === path);
  return dropdown({
    id: 'user-menu',
    className: 'avatar-btn',
    label: () => `บัญชีผู้ใช้: ${me.displayName}`,
    button: () => [h('span', { class: 'avatar', 'aria-hidden': 'true' }, initial(me.displayName)), h('span', { class: 'caret', 'aria-hidden': 'true' }, '▾')],
    panel: () => [
      h('div', { class: 'dd-profile' },
        h('span', { class: 'avatar lg', 'aria-hidden': 'true' }, initial(me.displayName)),
        h('div', { class: 'dd-who' }, h('strong', null, me.displayName), h('small', null, profile.email ?? `@${me.username}`))),
      h('div', { class: 'dd-badges' },
        profile.roles.length ? profile.roles.map((r) => h('span', { class: 'role-badge' }, `Role: ${r.name}`)) : h('span', { class: 'role-badge muted' }, 'Role: -'),
        h('span', { class: 'scope-badge' }, `🏢 ${scopeSummary(meta)}`)),
      divider(),
      can('/ess') ? menuLink('/ess', '👤', 'โปรไฟล์ของฉัน', 'ข้อมูลพนักงาน · ESS') : null,
      can('/security') ? menuLink('/security', '🛡️', 'ความปลอดภัย & MFA', me.mfaEnabled ? 'MFA เปิดใช้งานแล้ว' : 'ยังไม่ได้เปิด MFA') : null,
      can('/help') ? menuLink('/help', '📘', 'คู่มือการใช้งาน', null) : null,
      divider(),
      h('button', { type: 'button', role: 'menuitem', tabindex: '-1', class: 'dd-item danger', onclick: onLogout },
        h('span', { class: 'dd-ico', 'aria-hidden': 'true' }, '🚪'), h('span', { class: 'dd-text' }, h('span', null, 'ออกจากระบบ'))),
    ],
  }).el;
}

/** Sets the active company from the saved choice and builds the header menus. */
export function headerMenus(meta: MetaResponse, bell: HTMLElement, onLogout: () => void): HTMLElement[] {
  listenGlobally();
  state.companyId = initialCompany(meta);
  return [companyMenu(meta), bell, themeMenu(), userMenu(meta, onLogout)];
}
