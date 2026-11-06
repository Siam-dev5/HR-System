import type { AuthPolicy, Me, MetaResponse, NotificationItem } from '../shared/types';
import { MENU_GROUPS } from '../shared/modules';
import { get, post, setAuthLostHandler } from './api';
import { h, mount, toast, fmtDate, errorBox } from './dom';
import { state, currentPath, link, moduleByPath, navigate, setRouteRenderer, setTitle } from './app';
import { renderLogin, renderRegister, renderForcedMfa, renderForcedPassword } from './pages/auth';
import { renderCrud } from './pages/crud';
import { CRUD_SCREENS, PAGES, renderPayslipView } from './pages/registry';
import { closeMenus, closeNotifications, headerMenus } from './header';
import { icon, menuIcon } from './icons';
import { applyTheme, watchSystemTheme } from './theme';

applyTheme();
watchSystemTheme();

const root = document.getElementById('app') as HTMLElement;

// The fixed site footer (index.html) reports its real height so every layout reserves that space (--footer-h).
const siteFooter = document.getElementById('site-footer');
if (siteFooter) {
  const setFooterHeight = () => document.documentElement.style.setProperty('--footer-h', `${Math.ceil(siteFooter.getBoundingClientRect().height)}px`);
  setFooterHeight();
  new ResizeObserver(setFooterHeight).observe(siteFooter);
}

async function boot(): Promise<void> {
  setAuthLostHandler(() => {
    // only react when a signed-in session expires; signed-out screens handle their own errors
    if (!state.meta) return;
    state.meta = null;
    toast('Session หมดอายุ กรุณาเข้าสู่ระบบใหม่', 'error');
    void boot();
  });
  const policy = await get<AuthPolicy>('/api/auth/policy');
  const { me } = await get<{ me: Me | null }>('/api/auth/session');
  if (!me) {
    renderSignedOut(policy);
    return;
  }
  window.onpopstate = null;
  if (me.mfaPending) return renderForcedMfa(root, me, () => void boot());
  if (me.mustChangePassword) return renderForcedPassword(root, policy, () => void boot());
  state.meta = await get<MetaResponse>('/api/meta');
  renderShell();
}

/** Signed-out screens: /register shows registration, every other path shows the login page. */
function renderSignedOut(policy: AuthPolicy): void {
  const go = (path: string) => {
    history.pushState(null, '', path);
    renderSignedOut(policy);
  };
  window.onpopstate = () => renderSignedOut(policy);
  if (currentPath() === '/register') renderRegister(root, policy, go);
  else renderLogin(root, policy, () => void boot(), go);
}

// Desktop sidebar: expanded (260px) or collapsed to icons; the choice is per browser. The mobile drawer ignores it.
const SIDEBAR_KEY = 'hr.sidebar.collapsed';
const DRAWER_QUERY = '(max-width: 900px)';

function savedSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === '1';
  } catch {
    return false;
  }
}

// Menu groups the user closed (expanded sidebar and drawer). Icon-only mode always shows every item: it has no
// group header to reopen them with. The saved set is applied again when the sidebar expands.
const GROUPS_KEY = 'hr.sidebar.groups';

function savedClosedGroups(): Set<string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(GROUPS_KEY) ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

/** One menu group: a header button that shows / hides the group's items, remembered per group. */
function navGroup(key: string, title: string, items: HTMLElement[], closed: Set<string>): HTMLElement {
  const listId = `nav-group-${key}`;
  const list = h('div', { class: 'nav-group-items', id: listId }, items);
  const group = h('div', { class: 'nav-group', role: 'group', 'aria-labelledby': `${listId}-title`, 'data-group': key });
  const toggle = h('button', { type: 'button', class: 'nav-group-title nav-group-toggle', id: `${listId}-title`, 'aria-controls': listId },
    h('span', { class: 'nav-group-label' }, title), icon('chevronDown', 'ico nav-group-chevron'));
  const apply = (open: boolean) => {
    group.classList.toggle('is-closed', !open);
    toggle.setAttribute('aria-expanded', String(open));
  };
  apply(!closed.has(key));
  toggle.addEventListener('click', () => {
    const open = group.classList.contains('is-closed');
    apply(open);
    const now = savedClosedGroups();
    if (open) now.delete(key);
    else now.add(key);
    try {
      localStorage.setItem(GROUPS_KEY, JSON.stringify([...now]));
    } catch {
      /* storage unavailable: the choice lasts until reload */
    }
  });
  group.append(toggle, list);
  return group;
}

/** Collapse toggle + the collapsed-mode tooltip; returns the toggle button for the brand header. */
function sidebarCollapse(shell: HTMLElement, nav: HTMLElement, menu: HTMLElement): HTMLElement {
  // collapsed links show only an icon: one floating tooltip (outside the scrolling menu, so it is never clipped)
  // names the link on hover and on keyboard focus. Decorative: each link already carries aria-label.
  const tip = h('div', { class: 'nav-tooltip', 'aria-hidden': 'true', hidden: true });
  const hideTip = () => { tip.hidden = true; };
  const showTip = (e: Event) => {
    const a = (e.target as Element).closest<HTMLElement>('.nav-item');
    if (!a || !shell.classList.contains('sidebar-collapsed') || matchMedia(DRAWER_QUERY).matches) return hideTip();
    const r = a.getBoundingClientRect();
    tip.textContent = a.title;
    tip.style.top = `${Math.round(r.top + r.height / 2)}px`;
    tip.style.left = `${Math.round(r.right + 10)}px`;
    tip.hidden = false;
  };
  nav.addEventListener('pointerover', showTip);
  nav.addEventListener('focusin', showTip);
  nav.addEventListener('pointerleave', hideTip);
  nav.addEventListener('focusout', hideTip);
  menu.addEventListener('scroll', hideTip, { passive: true });
  nav.appendChild(tip);

  const toggle = h('button', { type: 'button', class: 'sidebar-collapse-toggle', 'aria-controls': menu.id }, icon('chevronDown'));
  const apply = (collapsed: boolean) => {
    shell.classList.toggle('sidebar-collapsed', collapsed);
    const label = collapsed ? 'ขยายเมนูด้านข้าง' : 'ย่อเมนูด้านข้าง';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
  };
  apply(savedSidebarCollapsed());
  toggle.addEventListener('click', () => {
    const collapsed = !shell.classList.contains('sidebar-collapsed');
    apply(collapsed);
    hideTip();
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
    } catch {
      /* storage unavailable: the choice lasts until reload */
    }
  });
  return toggle;
}

function renderShell(): void {
  const meta = state.meta as MetaResponse;
  // only the menu list scrolls; the brand header (logo + collapse toggle) stays at the top
  const closedGroups = savedClosedGroups();
  const menu = h('div', { class: 'sidebar-menu-scroll', id: 'sidebar-menu' },
    MENU_GROUPS.map((g) => {
      const items = meta.menu.filter((m) => m.group === g.key);
      if (!items.length) return null;
      return navGroup(g.key, g.title,
        items.map((i) => link(i.path, [menuIcon(i.key), h('span', { class: 'nav-label' }, i.title)], { class: 'nav-item', 'data-path': i.path, title: i.title, 'aria-label': i.title })),
        closedGroups);
    }),
  );
  const nav = h('nav', { class: 'sidebar', 'aria-label': 'เมนูหลัก' });
  const shell = h('div', { class: 'shell' });
  nav.append(
    h('div', { class: 'sidebar-brand-header' },
      h('div', { class: 'brand' },
        h('img', { class: 'brand-logo', src: '/assets/siamhrbp-logo.png', srcset: '/assets/siamhrbp-logo.png 1x, /assets/siamhrbp-logo@2x.png 2x', width: 254, height: 128, alt: 'โลโก้ SIAM HRBP' }),
        h('span', { class: 'brand-name' }, meta.appName)),
      sidebarCollapse(shell, nav, menu)),
    menu,
  );
  const bell = h('button', { class: 'icon-btn bell', 'aria-label': 'การแจ้งเตือน', onclick: () => void openNotifications() }, icon('bell'), h('span', { class: 'badge', id: 'bell-count', hidden: true }));
  const menuToggle = h('button', { class: 'icon-btn menu-toggle', 'aria-label': 'เปิด/ปิดเมนู', onclick: () => { closeMenus(); closeNotifications(); document.body.classList.toggle('nav-open'); } }, icon('menu'));
  const main = h('main', { id: 'main', tabindex: '-1' });
  // keyboard users jump past the menu; focus moves directly (a #main hash would trigger the router's popstate)
  const skip = h('a', { class: 'skip-link no-print', href: '#main', onclick: (e: Event) => { e.preventDefault(); main.focus(); } }, 'ข้ามไปยังเนื้อหาหลัก');
  // mobile: the open menu covers the toggle, so a scrim (tap outside) and Escape close it
  const scrim = h('div', { class: 'nav-scrim', 'aria-hidden': 'true', onclick: () => document.body.classList.remove('nav-open') });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.body.classList.remove('nav-open');
  });
  shell.append(nav, scrim, h('div', { class: 'content' }, h('header', { class: 'topbar' }, menuToggle, h('h1', { id: 'page-title' }, ''), h('div', { class: 'topbar-actions' }, headerMenus(meta, bell, () => void logout()))), main));
  mount(root, skip, shell);
  setRouteRenderer(() => renderRoute(main));
  window.onpopstate = () => renderRoute(main);
  if (['/', '/login', '/register'].includes(currentPath())) navigate(meta.menu[0]?.path ?? '/help', true);
  else renderRoute(main);
  void refreshBell();
}

async function refreshBell(): Promise<void> {
  try {
    const n = await get<{ unread: number }>('/api/notifications');
    const badge = document.getElementById('bell-count');
    if (badge) {
      badge.textContent = String(n.unread);
      badge.hidden = n.unread === 0;
    }
  } catch {
    /* non-critical */
  }
}

async function openNotifications(): Promise<void> {
  const existing = document.getElementById('notif-panel');
  if (existing) return existing.remove();
  closeMenus();
  const data = await get<{ unread: number; items: NotificationItem[] }>('/api/notifications');
  const panel = h('div', { class: 'notif-panel', id: 'notif-panel' },
    h('div', { class: 'notif-head' }, h('strong', null, 'การแจ้งเตือน'), h('button', { class: 'btn small', onclick: async () => { await post('/api/notifications/read-all'); panel.remove(); void refreshBell(); } }, 'อ่านทั้งหมด')),
    data.items.length ? data.items.map((n) => {
      const content = [h('div', { class: 'notif-title' }, n.title, n.external ? ' ↗' : ''), n.body ? h('div', { class: 'muted' }, n.body) : null, h('small', { class: 'muted' }, fmtDate(n.createdAt))];
      const markRead = () => { void post(`/api/notifications/${n.id}/read`).then(refreshBell); panel.remove(); };
      // href is null when the target is not accessible to this user: render as plain text, never a dead link
      if (!n.href) return h('div', { class: `notif-item ${n.read ? '' : 'unread'}`, onclick: markRead }, content);
      if (n.external) return h('a', { class: `notif-item ${n.read ? '' : 'unread'}`, href: n.href, target: '_blank', rel: 'noopener noreferrer', onclick: markRead }, content);
      return h('a', { class: `notif-item ${n.read ? '' : 'unread'}`, href: n.href, onclick: (e: Event) => { e.preventDefault(); markRead(); history.pushState(null, '', n.href as string); window.dispatchEvent(new PopStateEvent('popstate')); } }, content);
    }) : h('div', { class: 'empty' }, 'ไม่มีการแจ้งเตือน'),
  );
  document.querySelector('.topbar-actions')?.appendChild(panel);
}

async function logout(): Promise<void> {
  await post('/api/auth/logout');
  state.meta = null;
  state.companyId = null;
  history.replaceState(null, '', '/');
  void boot();
}

function renderRoute(main: HTMLElement): void {
  document.body.classList.remove('nav-open');
  closeMenus();
  closeNotifications();
  const path = currentPath();
  const params = new URLSearchParams(location.search);
  for (const a of document.querySelectorAll<HTMLAnchorElement>('.nav-item')) {
    const active = a.dataset.path === path;
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }

  const slip = /^\/(my\/payslips|payroll\/payslips)\/(\d+)$/.exec(path);
  if (slip) {
    setTitle('สลิปเงินเดือน');
    void renderPayslipView(main, Number(slip[2]), slip[1] === 'my/payslips' ? '/my/payslips' : '/payroll/payslips');
    return;
  }
  const mod = moduleByPath(path);
  if (!mod) {
    setTitle('ไม่พบหน้า');
    mount(main, h('div', { class: 'state-page' }, h('h2', null, '404 · ไม่พบหน้าที่ต้องการ'), h('p', null, `ไม่มีหน้า ${path} ในระบบ`), link(state.meta?.menu[0]?.path ?? '/help', 'กลับหน้าหลัก', { class: 'btn primary' })));
    return;
  }
  setTitle(mod.title);
  const allowed = mod.kind === 'crud' ? mod.perms.view : mod.allowed;
  if (!allowed) {
    const perm = mod.kind === 'crud' ? `${mod.key}.view` : mod.perm;
    mount(main, h('div', { class: 'state-page' }, h('h2', null, '403 · ไม่มีสิทธิ์เข้าถึง'), h('p', null, `หน้านี้ต้องใช้สิทธิ์ "${perm}" ซึ่งบทบาทของคุณยังไม่มี กรุณาติดต่อผู้ดูแลระบบ`)));
    return;
  }
  try {
    if (mod.kind === 'crud') void (CRUD_SCREENS[mod.key] ? CRUD_SCREENS[mod.key]!(main, params) : renderCrud(main, mod, params));
    else {
      const page = PAGES[mod.key];
      if (!page) throw new Error(`ยังไม่มีหน้าจอสำหรับ ${mod.key}`);
      void page(main, params);
    }
  } catch (e) {
    mount(main, errorBox(e));
  }
  main.focus();
}

boot().catch((e) => {
  mount(root, h('div', { class: 'state-page' }, h('h2', null, 'ไม่สามารถเริ่มระบบได้'), errorBox(e)));
  toast(e instanceof Error ? e.message : String(e), 'error');
});
