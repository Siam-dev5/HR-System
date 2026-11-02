export interface ResolvedLink {
  href: string;
  external: boolean;
}

/**
 * Turns a stored link (notification, dashboard widget, document) into something safe to render.
 * - absolute http(s) URLs are returned unchanged and marked external (never prefixed with the base path)
 * - app paths ("/leave/12") are prefixed with the app base path once
 * - anything else (javascript:, data:, protocol-relative, relative paths) is rejected
 */
export function resolveLink(link: string | null | undefined, basePath = ''): ResolvedLink | null {
  if (!link) return null;
  const value = link.trim();
  if (/^https?:\/\//i.test(value)) {
    try {
      return { href: new URL(value).toString(), external: true };
    } catch {
      return null;
    }
  }
  if (value.startsWith('/') && !value.startsWith('//')) {
    const base = basePath.replace(/\/+$/, '');
    if (!base || value === base || value.startsWith(base + '/')) return { href: value, external: false };
    return { href: base + value, external: false };
  }
  return null;
}
