import type { CrudMeta, MetaResponse, PageMeta } from '../shared/types';
import { hasPermission } from '../shared/permissions';
import { isSuperAdmin as isSuperAdminRole } from '../shared/modules';
import { resolveLink } from '../shared/links';
import { h, type Child } from './dom';

/** companyId: active company context (null = every company the user may access). */
export const state: { meta: MetaResponse | null; companyId: number | null } = { meta: null, companyId: null };

let renderRoute: () => void = () => undefined;
export function setRouteRenderer(fn: () => void): void {
  renderRoute = fn;
}

/** Re-renders the current page, e.g. after the active company changes. */
export function refreshRoute(): void {
  renderRoute();
}

export function basePath(): string {
  return (state.meta?.basePath ?? '').replace(/\/+$/, '');
}

/** Current app path without the base path. */
export function currentPath(): string {
  const base = basePath();
  const p = location.pathname;
  return (base && p.startsWith(base) ? p.slice(base.length) : p) || '/';
}

export function navigate(path: string, replace = false): void {
  const target = resolveLink(path, basePath());
  if (!target) return;
  if (target.external) {
    window.open(target.href, '_blank', 'noopener,noreferrer');
    return;
  }
  if (replace) history.replaceState(null, '', target.href);
  else history.pushState(null, '', target.href);
  renderRoute();
}

/** Anchor for an app path or absolute URL. Internal links use client-side navigation. */
export function link(path: string, children: Child, attrs: Record<string, unknown> = {}): HTMLElement {
  const target = resolveLink(path, basePath());
  if (!target) return h('span', attrs, children);
  if (target.external) return h('a', { ...attrs, href: target.href, target: '_blank', rel: 'noopener noreferrer' }, children);
  return h('a', {
    ...attrs,
    href: target.href,
    onclick: (e: MouseEvent) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      navigate(path);
    },
  }, children);
}

/** User / role / permission management is restricted to the super_admin role (mirrors the API guard). */
export function isSuperAdmin(): boolean {
  return !!state.meta && isSuperAdminRole(state.meta.me.roles);
}

export function can(permission: string): boolean {
  return !!state.meta && hasPermission(state.meta.me.permissions, permission);
}

export function crudMeta(key: string): CrudMeta | undefined {
  return state.meta?.modules.find((m): m is CrudMeta => m.kind === 'crud' && m.key === key);
}

export function moduleByPath(path: string): CrudMeta | PageMeta | undefined {
  return state.meta?.modules.find((m) => m.path === path);
}

export function setTitle(title: string): void {
  document.title = `${title} · ${state.meta?.appName ?? 'HR System'}`;
  const el = document.getElementById('page-title');
  if (el) el.textContent = title;
}
