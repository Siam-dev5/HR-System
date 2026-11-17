// Collects every Thai UI string in src/ (string literals and template literals) into src/web/i18n/catalog.json.
// A template literal becomes a pattern with {0}, {1}, … in place of its ${…} parts; the browser matches rendered text
// against these patterns (src/web/i18n.ts). Run after changing UI text, then add the translations to
// src/web/i18n/en.json and zh.json; `npm test` (tests/unit/i18n.test.ts) fails while a string has no translation.
//
// Usage: node scripts/i18n-extract.mjs [--check]   (--check: exit 1 if catalog.json is out of date, write nothing)
import ts from 'typescript';
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const THAI = /[฀-๿]/;
const OUT = join(ROOT, 'src/web/i18n/catalog.json');

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) files.push(p);
  }
};
walk(join(ROOT, 'src'));

const strings = new Map(); // text -> first file
const add = (text, file) => {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t || !THAI.test(t)) return;
  if (!strings.has(t)) strings.set(t, relative(ROOT, file).replace(/\\/g, '/'));
};

for (const file of files) {
  const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      // a literal used as a SQL text or an object key is still collected: harmless (never rendered → never matched)
      add(node.text, file);
    } else if (ts.isTemplateExpression(node)) {
      let pattern = node.head.text;
      node.templateSpans.forEach((span, i) => {
        pattern += `{${i}}` + span.literal.text;
      });
      add(pattern, file);
      // the static parts alone also appear as text when a span is an element (rare) — collect the longer ones
      for (const part of [node.head.text, ...node.templateSpans.map((s) => s.literal.text)]) if (part.trim().length > 3) add(part, file);
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
}

// static text of public/index.html (loading text, footer, noscript)
const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
for (const m of html.matchAll(/>([^<>]+)</g)) add(m[1], join(ROOT, 'public/index.html'));

const catalog = Object.fromEntries([...strings.keys()].sort((a, b) => a.localeCompare(b, 'th')).map((k) => [k, strings.get(k)]));
const json = JSON.stringify(catalog, null, 1) + '\n';
if (process.argv.includes('--check')) {
  const cur = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (cur !== json) {
    console.error('src/web/i18n/catalog.json is out of date: run node scripts/i18n-extract.mjs');
    process.exit(1);
  }
  console.log(`catalog up to date: ${strings.size} strings`);
} else {
  mkdirSync(join(ROOT, 'src/web/i18n'), { recursive: true });
  writeFileSync(OUT, json);
  console.log(`${strings.size} strings → ${relative(ROOT, OUT)}`);
}
