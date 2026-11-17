// UI language: ไทย (source) / English / 中文. The whole UI is written in Thai; for another language this module loads
// /assets/i18n/<lang>.json once, translates the page, then keeps translating every text node and the user-facing
// attributes added later (a MutationObserver), so every page, menu, dialog, toast and API message is covered without
// each page knowing about it. Data (names, departments, numbers…) is not in the dictionary and stays as it is.
// The choice is kept per browser (like the theme); switching reloads the page so nothing is left half translated.
import { compile, hasThai, LOCALE, type Lang, type Translator } from '../shared/i18n-core';

export const LANG_KEY = 'hr.lang';

export interface LangInfo {
  code: Lang;
  /** native name, never translated */
  name: string;
  short: string;
  /** search words in every UI language */
  search: string[];
}

export const LANGUAGES: readonly LangInfo[] = [
  { code: 'th', name: 'ไทย', short: 'TH', search: ['ไทย', 'thai', 'th', '泰语', '泰文'] },
  { code: 'en', name: 'English', short: 'EN', search: ['english', 'อังกฤษ', 'en', '英语', '英文'] },
  { code: 'zh', name: '中文', short: '中文', search: ['中文', 'chinese', 'จีน', 'zh', '汉语', '简体'] },
];

export function currentLang(): Lang {
  try {
    const v = localStorage.getItem(LANG_KEY);
    return v === 'en' || v === 'zh' ? v : 'th';
  } catch {
    return 'th';
  }
}

export const locale = (): string => LOCALE[currentLang()];

let translator: Translator | null = null;
const written = new WeakMap<Node, string>();
const ATTRS = ['placeholder', 'title', 'aria-label', 'alt', 'data-label'];
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'NOSCRIPT', 'CODE', 'PRE']);

function skipped(el: Element | null): boolean {
  for (let e = el; e; e = e.parentElement) {
    if (SKIP.has(e.tagName) || e.getAttribute('translate') === 'no' || (e as HTMLElement).isContentEditable) return true;
  }
  return false;
}

function translateText(node: Text): void {
  const t = translator;
  if (!t) return;
  const v = node.data;
  if (!hasThai(v) || written.get(node) === v || skipped(node.parentElement)) return;
  const out = t(v);
  written.set(node, out);
  if (out !== v) node.data = out;
}

function translateAttrs(el: Element): void {
  const t = translator;
  if (!t || skipped(el)) return;
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (v && hasThai(v)) {
      const out = t(v);
      if (out !== v) el.setAttribute(a, out);
    }
  }
  if (el instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(el.type) && hasThai(el.value)) el.value = t(el.value);
}

function translateTree(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) return translateText(root as Text);
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
  if (root.nodeType === Node.ELEMENT_NODE) {
    if (skipped(root as Element)) return;
    translateAttrs(root as Element);
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => (n.nodeType === Node.ELEMENT_NODE && (SKIP.has((n as Element).tagName) || (n as Element).getAttribute('translate') === 'no') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) translateText(n as Text);
    else translateAttrs(n as Element);
  }
}

/** Translates a string in code (e.g. a confirm text); the Thai source when the language is Thai or it is unknown. */
export const tr = (text: string): string => (translator ? translator(text) : text);

/** Loads the dictionary of the chosen language and starts translating the page. Thai: does nothing. */
export async function initI18n(): Promise<void> {
  const lang = currentLang();
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
  if (lang === 'th') return;
  try {
    const res = await fetch(`/assets/i18n/${lang}.json`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(String(res.status));
    translator = compile((await res.json()) as Record<string, string>);
  } catch {
    // dictionary unavailable: the UI stays in Thai rather than failing to start
    translator = null;
    return;
  }
  translateTree(document);
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') translateText(r.target as Text);
      else if (r.type === 'attributes') translateAttrs(r.target as Element);
      else r.addedNodes.forEach(translateTree);
    }
  }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRS, 'value'] });
}

export function setLang(lang: Lang): void {
  try {
    if (lang === 'th') localStorage.removeItem(LANG_KEY);
    else localStorage.setItem(LANG_KEY, lang);
  } catch {
    /* storage blocked: nothing to persist */
  }
  location.reload();
}

// ---- flags (inline SVG: emoji flags do not render on Windows) ---------------------------------------------------
const SVG = 'http://www.w3.org/2000/svg';
function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}
function star(cx: number, cy: number, r: number, rot = 0): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = ((i * 36 - 90 + rot) * Math.PI) / 180;
    const rr = i % 2 ? r * 0.382 : r;
    pts.push(`${(cx + rr * Math.cos(a)).toFixed(2)},${(cy + rr * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(' ');
}
export function flag(code: Lang): SVGSVGElement {
  const s = svgEl('svg', { viewBox: '0 0 60 40', width: 60, height: 40, class: 'flag', 'aria-hidden': 'true' }) as SVGSVGElement;
  const add = (tag: string, a: Record<string, string | number>) => s.appendChild(svgEl(tag, a));
  if (code === 'th') {
    add('rect', { width: 60, height: 40, fill: '#A51931' });
    add('rect', { y: 6.67, width: 60, height: 26.67, fill: '#F4F5F8' });
    add('rect', { y: 13.33, width: 60, height: 13.33, fill: '#2D2A4A' });
  } else if (code === 'en') {
    add('rect', { width: 60, height: 40, fill: '#012169' });
    add('path', { d: 'M0,0 L60,40 M60,0 L0,40', stroke: '#FFF', 'stroke-width': 8 });
    add('path', { d: 'M0,0 L60,40 M60,0 L0,40', stroke: '#C8102E', 'stroke-width': 3 });
    add('path', { d: 'M30,0 V40 M0,20 H60', stroke: '#FFF', 'stroke-width': 12 });
    add('path', { d: 'M30,0 V40 M0,20 H60', stroke: '#C8102E', 'stroke-width': 7 });
  } else {
    add('rect', { width: 60, height: 40, fill: '#EE1C25' });
    add('polygon', { points: star(10, 10, 6), fill: '#FFFF00' });
    for (const [x, y] of [[20, 4], [24, 8], [24, 14], [20, 18]] as const) add('polygon', { points: star(x, y, 2, 20), fill: '#FFFF00' });
  }
  return s;
}

// ---- language picker: search, close, one card per language (flag + native name) ---------------------------------
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Array<Node | string>): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
}

export function openLanguagePicker(): void {
  document.getElementById('lang-picker')?.remove();
  const cur = currentLang();
  const search = el('input', { type: 'search', class: 'lang-search', placeholder: 'ค้นหา', 'aria-label': 'ค้นหาภาษา', autocomplete: 'off' });
  const close = el('button', { type: 'button', class: 'lang-close', 'aria-label': 'ปิด' }, '×');
  const empty = el('p', { class: 'lang-empty', hidden: '' }, 'ไม่พบภาษาที่ค้นหา');
  const cards = LANGUAGES.map((l) => {
    const b = el('button', { type: 'button', class: 'lang-card', 'data-lang': l.code, 'aria-pressed': String(l.code === cur), lang: l.code === 'zh' ? 'zh-CN' : l.code },
      flag(l.code), el('span', { class: 'lang-name', translate: 'no' }, l.name));
    b.addEventListener('click', () => (l.code === cur ? done() : setLang(l.code)));
    return { b, l };
  });
  const grid = el('div', { class: 'lang-grid', role: 'group', 'aria-label': 'ภาษา' }, ...cards.map((c) => c.b));
  const dialog = el('div', { class: 'lang-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'เลือกภาษา' },
    el('div', { class: 'lang-head' }, search, close), el('div', { class: 'lang-body' }, grid, empty));
  const backdrop = el('div', { class: 'lang-backdrop', id: 'lang-picker' }, dialog);
  const prev = document.activeElement as HTMLElement | null;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') done();
  };
  function done(): void {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    prev?.focus?.();
  }
  close.addEventListener('click', done);
  backdrop.addEventListener('click', (e) => e.target === backdrop && done());
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    for (const { b, l } of cards) {
      const hit = !q || l.search.some((w) => w.toLowerCase().includes(q)) || l.name.toLowerCase().includes(q);
      b.hidden = !hit;
      if (hit) shown++;
    }
    empty.hidden = shown > 0;
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(backdrop);
  search.focus();
}

/** The header / sign-in button that opens the picker: globe + the short name of the current language. */
export function languageButton(extraClass = ''): HTMLButtonElement {
  const cur = LANGUAGES.find((l) => l.code === currentLang()) ?? LANGUAGES[0]!;
  const ns = 'http://www.w3.org/2000/svg';
  const g = document.createElementNS(ns, 'svg');
  g.setAttribute('viewBox', '0 0 24 24');
  g.setAttribute('class', 'ico');
  g.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z');
  g.appendChild(p);
  const b = el('button', { type: 'button', class: `hdr-btn lang-btn ${extraClass}`.trim(), 'aria-haspopup': 'dialog', 'aria-label': 'ภาษา', title: 'ภาษา' },
    g, el('span', { class: 'lang-short', translate: 'no' }, cur.short));
  b.addEventListener('click', openLanguagePicker);
  return b;
}
