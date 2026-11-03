// Re-orders a `wrangler d1 export` dump so it can be executed into an EMPTY database.
// The export writes INSERTs of a table (e.g. payslips) before the CREATE TABLE of its foreign-key parent
// (employees), which fails with "no such table: main.employees". Output order:
//   PRAGMA → every CREATE TABLE → every INSERT (sqlite_sequence last) → every CREATE INDEX.
// Statements are split outside quoted strings; count and content are unchanged, only the order differs.
//
// Usage: node scripts/prepare-d1-restore.mjs <export.sql> <restore.sql>
// Then restore ONLY into a local or new database, e.g.:
//   npx wrangler d1 execute hr-system-db --local --persist-to .tmp/restore-<date> --file <restore.sql>
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error('usage: node scripts/prepare-d1-restore.mjs <export.sql> <restore.sql>');
  process.exit(2);
}
// split on ";" outside quoted strings / identifiers (values may contain new lines and semicolons)
function statements(sql) {
  const out = [];
  let start = 0;
  let quote = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      if (ch === quote) {
        if (sql[i + 1] === quote) i++; // doubled quote = escaped
        else quote = null;
      }
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === ';') {
      const s = sql.slice(start, i + 1).trim();
      if (s !== ';') out.push(s);
      start = i + 1;
    }
  }
  if (quote) throw new Error('unterminated quoted string in dump');
  if (sql.slice(start).trim()) throw new Error('trailing text after the last statement');
  return out;
}
const lines = statements(readFileSync(src, 'utf8'));
const groups = { pragma: [], table: [], insert: [], sequence: [], index: [] };
for (const l of lines) {
  if (/^PRAGMA /i.test(l)) groups.pragma.push(l);
  else if (/^CREATE TABLE /i.test(l)) groups.table.push(l);
  else if (/^CREATE (UNIQUE )?INDEX /i.test(l)) groups.index.push(l);
  else if (/^(DELETE FROM sqlite_sequence|INSERT INTO "?sqlite_sequence"?)/i.test(l)) groups.sequence.push(l);
  else if (/^INSERT INTO /i.test(l)) groups.insert.push(l);
  else {
    console.error(`unsupported statement: ${l.slice(0, 80)}`);
    process.exit(1);
  }
}
const ordered = [...groups.pragma, ...groups.table, ...groups.insert, ...groups.sequence, ...groups.index];
if (ordered.length !== lines.length) throw new Error('statement count changed');
const sorted = (a) => createHash('sha256').update([...a].sort().join('\n')).digest('hex');
if (sorted(ordered) !== sorted(lines)) throw new Error('statement content changed');
writeFileSync(out, ordered.join('\n') + '\n');
console.log(`ok: ${ordered.length} statements (${groups.table.length} tables, ${groups.insert.length} inserts, ${groups.index.length} indexes) → ${out}`);
