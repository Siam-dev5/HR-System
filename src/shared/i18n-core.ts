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
  weak: boolean;
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
    let s = norm(src);
    if (!/\{\d+\}/.test(s)) {
      exact.set(s, target);
      continue;
    }
    // adjacent placeholders ("{0}{1}") cannot be told apart in rendered text: one capture fills the first, the
    // second becomes empty in the translation
    let tgt = target;
    for (let m = /\{(\d+)\}\{(\d+)\}/.exec(s); m; m = /\{(\d+)\}\{(\d+)\}/.exec(s)) {
      s = s.replace(m[0], `{${m[1]}}`);
      tgt = tgt.replace(`{${m[2]}}`, '');
    }
    const parts = s.split(/\{\d+\}/);
    const order = [...s.matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1]));
    // a pattern made only of placeholders (and spaces / punctuation) would match anything: skip it
    if (!parts.some((p) => hasThai(p))) continue;
    const re = new RegExp('^' + parts.map(escapeRe).reduce((acc, p, i) => (i === 0 ? p : `${acc}(?<s${order[i - 1]}>[\\s\\S]+?)${p}`), '') + '$');
    const key = parts.reduce((a, p) => (p.trim().length > a.length ? p.trim() : a), '');
    // a short label word directly before data ("บริษัท {0}") must not rewrite a Thai name that only starts with it
    // ("บริษัท สยาม จำกัด"): such a pattern is used only when every Thai value it captures is itself known
    const weak = parts.join('').replace(/\s/g, '').length <= 8 && !/[:：·()#/\d]/.test(parts.join(''));
    patterns.push({ re, key, target: tgt, slots: order.length, weak });
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
        const values = Object.values(m.groups ?? {});
        if (p.weak && values.some((v) => hasThai(v) && lookup(v, depth + 1) === null)) continue;
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
    // several lines (a tooltip built with "\n"): each line on its own; unknown lines (data) stay as they are
    if (out === null && depth < 3 && /\n/.test(raw)) {
      const lines = raw.split('\n');
      const tr = lines.map((x) => (hasThai(x) ? lookup(x, depth + 1) : null));
      if (tr.some((x) => x !== null)) out = lines.map((x, i) => tr[i] ?? x).join('\n');
    }
    // a list of short labels joined with spaces (e.g. weekday abbreviations): only when every word is known
    if (out === null && depth === 0 && / /.test(text) && text.length <= 80) {
      const words = text.split(' ');
      const tr = words.map((x) => (hasThai(x) ? (exact.get(x) ?? null) : x));
      if (words.length > 1 && tr.every((x) => x !== null)) out = tr.join(' ');
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
