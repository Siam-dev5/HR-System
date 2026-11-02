import type { AuthPolicy, Me, MetaResponse, NotificationItem } from '../shared/types';
import { MENU_GROUPS } from '../shared/modules';
import { get, post, setAuthLostHandler } from './api';
import { h, mount, toast, fmtDate, errorBox } from './dom';
import { state, currentPath, link, moduleByPath, navigate, setRouteRenderer, setTitle } from './app';
import { renderLogin, renderRegister, renderForcedMfa, renderForcedPassword } from './pages/auth';
import { renderCrud } from './pages/crud';
import { PAGES, renderPayslipView } from './pages/registry';

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

function renderShell(): void {
  const meta = state.meta as MetaResponse;
  const nav = h('nav', { class: 'sidebar', 'aria-label': 'เมนูหลัก' },
    h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, 'HR'), h('span', null, meta.appName)),
    MENU_GROUPS.map((g) => {
      const items = meta.menu.filter((m) => m.group === g.key);
      if (!items.length) return null;
      return h('div', { class: 'nav-group' }, h('div', { class: 'nav-group-title' }, g.title), items.map((i) => link(i.path, i.title, { class: 'nav-item', 'data-path': i.path })));
    }),
  );
  const bell = h('button', { class: 'icon-btn bell', 'aria-label': 'การแจ้งเตือน', onclick: () => void openNotifications() }, '🔔', h('span', { class: 'badge', id: 'bell-count', hidden: true }));
  const userMenu = h('div', { class: 'user-menu' },
    h('span', { class: 'user-name' }, meta.me.displayName, h('small', null, meta.me.roles.join(', '))),
    link('/security', 'ความปลอดภัย', { class: 'btn small' }),
    h('button', { class: 'btn small', onclick: () => void logout() }, 'ออกจากระบบ'),
  );
  const menuToggle = h('button', { class: 'icon-btn menu-toggle', 'aria-label': 'เปิด/ปิดเมนู', onclick: () => document.body.classList.toggle('nav-open') }, '☰');
  const main = h('main', { id: 'main', tabindex: '-1' });
  // mobile: the open menu covers the toggle, so a scrim (tap outside) and Escape close it
  const scrim = h('div', { class: 'nav-scrim', 'aria-hidden': 'true', onclick: () => document.body.classList.remove('nav-open') });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.body.classList.remove('nav-open');
  });
  mount(root, h('div', { class: 'shell' }, nav, scrim, h('div', { class: 'content' }, h('header', { class: 'topbar' }, menuToggle, h('h1', { id: 'page-title' }, ''), h('div', { class: 'topbar-actions' }, bell, userMenu)), main)));
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
  history.replaceState(null, '', '/');
  void boot();
}

function renderRoute(main: HTMLElement): void {
  document.body.classList.remove('nav-open');
  document.getElementById('notif-panel')?.remove();
  const path = currentPath();
  const params = new URLSearchParams(location.search);
  for (const a of document.querySelectorAll<HTMLAnchorElement>('.nav-item')) a.classList.toggle('active', a.dataset.path === path);

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
    if (mod.kind === 'crud') void renderCrud(main, mod, params);
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
