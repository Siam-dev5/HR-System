// UI translation core (no DOM): the source language of every UI string is Thai. A dictionary maps a Thai source
// string to its translation; a source string with {0}, {1}, … is a pattern made from a template literal
// (scripts/i18n-extract.mjs) and matches rendered text whose variable parts are anything. Variable parts are
// translated in turn (e.g. a status label inside a sentence) but kept as they are when unknown (names, numbers…).

export type Lang = 'th' | 'en' | 'zh';
export const LANGS: readonly Lang[] = ['th', 'en', 'zh'];
export type Dictionary = Record<string, string>;

const THAI = /[฀-๿]/;
export const hasThai = (s: string): boolean => THAI.test(s);

interface Pattern {
  re: RegExp;
  /** the longest static part: a cheap substring test before the regular expression */
  key: string;
  target: string;
  slots: number;
}

export interface Translator {
  (text: string): string;
  /** the translation of a text, or null when nothing in it is known (for coverage checks) */
  lookup: (text: string) => string | null;
  size: number;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

export function compile(dict: Dictionary): Translator {
  const exact = new Map<string, string>();
  const patterns: Pattern[] = [];
  for (const [src, target] of Object.entries(dict)) {
    if (!target) continue;
    const s = norm(src);
    if (!/\{\d+\}/.test(s)) {
      exact.set(s, target);
      continue;
    }
    const parts = s.split(/\{\d+\}/);
    const order = [...s.matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1]));
    // a pattern made only of placeholders (and spaces / punctuation) would match anything: skip it
    if (!parts.some((p) => hasThai(p))) continue;
    const re = new RegExp('^' + parts.map(escapeRe).reduce((acc, p, i) => (i === 0 ? p : `${acc}(?<s${order[i - 1]}>[\\s\\S]+?)${p}`), '') + '$');
    const key = parts.reduce((a, p) => (p.trim().length > a.length ? p.trim() : a), '');
    patterns.push({ re, key, target, slots: order.length });
  }
  // most specific first: longer static text wins over a shorter, more general pattern
  patterns.sort((a, b) => b.key.length - a.key.length || a.slots - b.slots);

  const cache = new Map<string, string | null>();
  const lookup = (raw: string, depth = 0): string | null => {
    const text = norm(raw);
    if (!text || !hasThai(text)) return null;
    if (depth === 0 && cache.has(text)) return cache.get(text) ?? null;
    let out: string | null = exact.get(text) ?? null;
    if (out === null && depth < 3) {
      for (const p of patterns) {
        if (!text.includes(p.key)) continue;
        const m = p.re.exec(text);
        if (!m) continue;
        out = p.target.replace(/\{(\d+)\}/g, (_, n: string) => {
          const v = m.groups?.[`s${n}`] ?? '';
          return lookup(v, depth + 1) ?? v;
        });
        break;
      }
    }
    // a sentence joined from known parts with " · " or a line break (common in hints and sub-titles)
    if (out === null && depth < 3 && / · /.test(text)) {
      const pieces = text.split(' · ');
      const tr = pieces.map((x) => (hasThai(x) ? lookup(x, depth + 1) : x));
      if (tr.every((x) => x !== null)) out = tr.join(' · ');
    }
    if (depth === 0) {
      if (cache.size > 20_000) cache.clear();
      cache.set(text, out);
    }
    return out;
  };
  const t = ((text: string) => {
    const out = lookup(text);
    if (out === null) return text;
    // keep the surrounding white space of the original text node
    const lead = /^\s*/.exec(text)?.[0] ?? '';
    const trail = /\s*$/.exec(text)?.[0] ?? '';
    return lead + out + trail;
  }) as Translator;
  t.lookup = (text: string) => lookup(text);
  t.size = exact.size + patterns.length;
  return t;
}

/** Placeholders of a source string and of its translation must be the same set ({0}, {1}, …). */
export function placeholdersMatch(src: string, target: string): boolean {
  const ph = (s: string) => [...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join(',');
  return ph(src) === ph(target);
}

export const LOCALE: Record<Lang, string> = { th: 'th-TH', en: 'en-GB', zh: 'zh-CN' };
