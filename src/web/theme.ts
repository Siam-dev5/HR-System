// Theme preference (light / dark / auto). Stored per browser: the system has no server-side user preferences.
// public/assets/theme-init.js applies the same logic before first paint; keep the storage key in sync.

export type ThemePref = 'light' | 'dark' | 'auto';
export const THEME_KEY = 'hr.theme';

const media = window.matchMedia('(prefers-color-scheme: dark)');

export function themePref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function resolvedTheme(pref: ThemePref = themePref()): 'light' | 'dark' {
  return pref === 'auto' ? (media.matches ? 'dark' : 'light') : pref;
}

export function applyTheme(): void {
  const pref = themePref();
  document.documentElement.dataset.theme = resolvedTheme(pref);
  document.documentElement.dataset.themePref = pref;
}

export function setThemePref(pref: ThemePref): void {
  try {
    if (pref === 'auto') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* storage blocked: the choice still applies to this page */
  }
  document.documentElement.dataset.theme = resolvedTheme(pref);
  document.documentElement.dataset.themePref = pref;
}

/** Auto mode follows the operating system while the page is open. */
export function watchSystemTheme(): void {
  media.addEventListener('change', () => {
    if (document.documentElement.dataset.themePref === 'auto') document.documentElement.dataset.theme = resolvedTheme('auto');
  });
}
