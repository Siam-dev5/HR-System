// Re-orders a `wrangler d1 export` dump so it can be executed into an EMPTY database.
// The export writes INSERTs of a table (e.g. payslips) before the CREATE TABLE of its foreign-key parent
// (employees), which fails with "no such table: main.employees". Output order:
//   PRAGMA → every CREATE TABLE → every INSERT (sqlite_sequence last) → every CREATE INDEX → every CREATE TRIGGER
//   (triggers last, so none fires while the rows are restored; a trigger body's own ";" stays inside its statement).
// SQL comments are skipped while looking for quotes and ";" (an apostrophe in "-- the employee's …" is not a quote).
// INSERTs are ordered so that every foreign-key parent row comes first: tables in dependency order (parents before
// children) and, inside a table that references itself (employees.manager_id, departments.parent_id), parent rows
// before their children. A remote D1 import checks foreign keys as it goes (PRAGMA defer_foreign_keys does not hold
// across its batches), so a dump in export order fails there with "FOREIGN KEY constraint failed".
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
    } else if (ch === '-' && sql[i + 1] === '-') {
      // a line comment (e.g. inside a CREATE TABLE): its apostrophes ("employee's") are not quotes; the comment stays in
      // the statement text, only skipped while looking for quotes and ";"
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl;
    } else if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 1;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === ';') {
      const s = sql.slice(start, i + 1).trim();
      // a trigger body holds its own ";" — the statement ends at the ";" after its END
      if (/^CREATE TRIGGER /i.test(s) && !/(^|[^A-Za-z0-9_])END\s*;$/i.test(s)) continue;
      if (s !== ';') out.push(s);
      start = i + 1;
    }
  }
  if (quote) throw new Error('unterminated quoted string in dump');
  if (sql.slice(start).trim()) throw new Error('trailing text after the last statement');
  return out;
}

// split a parenthesised list on top-level commas (outside quotes and nested parentheses, e.g. replace(...))
function topLevel(list) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (quote) {
      if (ch === quote) {
        if (list[i + 1] === quote) i++;
        else quote = null;
      }
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(list.slice(start).trim());
  return parts;
}
const unquote = (s) => s.replace(/^"|"$/g, '');

/** { table, columns, values } of `INSERT INTO "t" ("a","b") VALUES(1,'x');` */
function parseInsert(stmt) {
  const m = /^INSERT INTO "?(\w+)"?\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]*)\);$/i.exec(stmt);
  if (!m) throw new Error(`unexpected INSERT form: ${stmt.slice(0, 80)}`);
  return { table: m[1], columns: topLevel(m[2]).map(unquote), values: topLevel(m[3]) };
}

/** foreign keys per table from the CREATE TABLE statements: [{ column, parent }] */
function foreignKeys(createStmt) {
  const body = createStmt.slice(createStmt.indexOf('(') + 1, createStmt.lastIndexOf(')'));
  const fks = [];
  for (const def of topLevel(body)) {
    const table = /^FOREIGN KEY\s*\(\s*"?(\w+)"?\s*\)\s*REFERENCES\s+"?(\w+)"?/i.exec(def);
    if (table) fks.push({ column: table[1], parent: table[2] });
    else {
      const col = /^"?(\w+)"?\s[\s\S]*?\bREFERENCES\s+"?(\w+)"?/i.exec(def);
      if (col) fks.push({ column: col[1], parent: col[2] });
    }
  }
  return fks;
}

const lines = statements(readFileSync(src, 'utf8'));
const groups = { pragma: [], table: [], insert: [], sequence: [], index: [], trigger: [] };
for (const l of lines) {
  if (/^PRAGMA /i.test(l)) groups.pragma.push(l);
  else if (/^CREATE TABLE /i.test(l)) groups.table.push(l);
  else if (/^CREATE (UNIQUE )?INDEX /i.test(l)) groups.index.push(l);
  else if (/^CREATE TRIGGER /i.test(l)) groups.trigger.push(l);
  else if (/^(DELETE FROM sqlite_sequence|INSERT INTO "?sqlite_sequence"?)/i.test(l)) groups.sequence.push(l);
  else if (/^INSERT INTO /i.test(l)) groups.insert.push(l);
  else {
    console.error(`unsupported statement: ${l.slice(0, 80)}`);
    process.exit(1);
  }
}

// tables in dependency order (parents first); ties keep the export order
const fkOf = new Map(groups.table.map((t) => [/^CREATE TABLE "?(\w+)"?/i.exec(t)[1], foreignKeys(t)]));
const tableOrder = [];
const state = new Map();
const visit = (t, path) => {
  if (state.get(t) === 'done') return;
  if (state.get(t) === 'visiting') throw new Error(`foreign-key cycle between tables: ${[...path, t].join(' -> ')}`);
  state.set(t, 'visiting');
  for (const fk of fkOf.get(t) ?? []) if (fk.parent !== t && fkOf.has(fk.parent)) visit(fk.parent, [...path, t]);
  state.set(t, 'done');
  tableOrder.push(t);
};
for (const t of fkOf.keys()) visit(t, []);

// rows per table; a self-referencing table is ordered parents-first
const rowsOf = new Map();
for (const stmt of groups.insert) {
  const row = parseInsert(stmt);
  if (!rowsOf.has(row.table)) rowsOf.set(row.table, []);
  rowsOf.get(row.table).push({ stmt, row });
}
let selfOrdered = 0;
for (const [table, rows] of rowsOf) {
  const self = (fkOf.get(table) ?? []).filter((fk) => fk.parent === table);
  if (!self.length) continue;
  const idAt = rows[0].row.columns.indexOf('id');
  if (idAt < 0) throw new Error(`${table} references itself but has no id column`);
  const byId = new Map(rows.map((r) => [r.row.values[idAt], r]));
  const placed = new Set();
  const ordered = [];
  const place = (r, path) => {
    const id = r.row.values[idAt];
    if (placed.has(id)) return;
    if (path.includes(id)) throw new Error(`${table}: rows reference each other in a cycle (${[...path, id].join(' -> ')})`);
    for (const fk of self) {
      const ref = r.row.values[r.row.columns.indexOf(fk.column)];
      if (ref !== undefined && ref !== 'NULL' && ref !== id && byId.has(ref)) place(byId.get(ref), [...path, id]);
    }
    placed.add(id);
    ordered.push(r);
  };
  for (const r of rows) place(r, []);
  if (ordered.some((r, i) => r !== rows[i])) selfOrdered++;
  rowsOf.set(table, ordered);
}
const inserts = [];
for (const t of tableOrder) for (const r of rowsOf.get(t) ?? []) inserts.push(r.stmt);
for (const [t, rows] of rowsOf) if (!fkOf.has(t)) for (const r of rows) inserts.push(r.stmt); // no CREATE TABLE seen (kept, at the end)

const ordered = [...groups.pragma, ...groups.table, ...inserts, ...groups.sequence, ...groups.index, ...groups.trigger];
if (ordered.length !== lines.length) throw new Error('statement count changed');
const sorted = (a) => createHash('sha256').update([...a].sort().join('\n')).digest('hex');
if (sorted(ordered) !== sorted(lines)) throw new Error('statement content changed');
writeFileSync(out, ordered.join('\n') + '\n');
console.log(`ok: ${ordered.length} statements (${groups.table.length} tables, ${groups.insert.length} inserts, ${groups.index.length} indexes, ${groups.trigger.length} triggers; parents before children, ${selfOrdered} self-referencing table(s) re-ordered) → ${out}`);
