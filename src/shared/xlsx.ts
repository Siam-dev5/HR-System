// Minimal, dependency-free XLSX reader/writer (Office Open XML spreadsheet).
// Runs unchanged in the Worker, the browser and Node 20+: it only needs DecompressionStream for deflated entries.
// Reading returns every sheet as a grid of raw cell values (strings / numbers / booleans / null); callers decide
// what a cell means (e.g. Excel date serials). Writing produces an uncompressed ("stored") workbook.

export type Cell = string | number | boolean | null;
export interface Sheet {
  name: string;
  rows: Cell[][];
}

const td = new TextDecoder();
const te = new TextEncoder();

// ---- zip -----------------------------------------------------------------------------------
interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  offset: number;
}

function u16(b: Uint8Array, o: number): number {
  return (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
}
function u32(b: Uint8Array, o: number): number {
  return (u16(b, o) | (u16(b, o + 2) << 16)) >>> 0;
}

function zipEntries(b: Uint8Array): ZipEntry[] {
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--) {
    if (u32(b, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ไฟล์ไม่ใช่ XLSX ที่ถูกต้อง');
  const count = u16(b, eocd + 10);
  let p = u32(b, eocd + 16);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (u32(b, p) !== 0x02014b50) throw new Error('ไฟล์ XLSX เสียหาย');
    const nameLen = u16(b, p + 28);
    out.push({
      method: u16(b, p + 10),
      compressedSize: u32(b, p + 20),
      name: td.decode(b.subarray(p + 46, p + 46 + nameLen)),
      offset: u32(b, p + 42),
    });
    p += 46 + nameLen + u16(b, p + 30) + u16(b, p + 32);
  }
  return out;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as unknown as ArrayBuffer]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readEntry(b: Uint8Array, e: ZipEntry): Promise<string> {
  const start = e.offset + 30 + u16(b, e.offset + 26) + u16(b, e.offset + 28);
  const raw = b.subarray(start, start + e.compressedSize);
  if (e.method === 0) return td.decode(raw);
  if (e.method === 8) return td.decode(await inflate(raw));
  throw new Error('รูปแบบการบีบอัดใน XLSX ไม่รองรับ');
}

// ---- xml helpers ---------------------------------------------------------------------------
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? '';
  });
}
function escapeXml(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? unescapeXml(m[1] as string) : null;
}
/** Concatenated text of every <t> in a shared/inline string (rich text runs included, phonetic runs excluded). */
function textOf(xml: string): string {
  const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let s = '';
  for (const m of clean.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)) s += unescapeXml(m[1] ?? '');
  return s;
}

/** Column letters ("A", "AB") to a 0-based index. */
export function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
export function colName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// ---- reader --------------------------------------------------------------------------------
export async function readXlsx(input: ArrayBuffer | Uint8Array): Promise<Sheet[]> {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  const entries = zipEntries(b);
  const get = async (name: string): Promise<string | null> => {
    const e = entries.find((x) => x.name === name || x.name === name.replace(/^\//, ''));
    return e ? readEntry(b, e) : null;
  };
  const workbook = await get('xl/workbook.xml');
  if (!workbook) throw new Error('ไม่พบข้อมูล Workbook ในไฟล์ XLSX');
  const rels = (await get('xl/_rels/workbook.xml.rels')) ?? '';
  const target = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    const t = attr(m[0], 'Target');
    if (id && t) target.set(id, t.startsWith('/') ? t.slice(1) : `xl/${t.replace(/^\.\//, '')}`);
  }
  const sharedXml = (await get('xl/sharedStrings.xml')) ?? '';
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map((m) => textOf(m[1] ?? ''));

  const sheets: Sheet[] = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], 'name') ?? `Sheet${sheets.length + 1}`;
    const rid = attr(m[0], 'r:id');
    const path = rid ? target.get(rid) : undefined;
    const xml = path ? await get(path) : null;
    sheets.push({ name, rows: xml ? parseSheet(xml, shared) : [] });
  }
  return sheets;
}

function parseSheet(xml: string, shared: string[]): Cell[][] {
  const rows: Cell[][] = [];
  const merges: Array<[number, number, number, number]> = [];
  for (const m of xml.matchAll(/<mergeCell\b[^>]*ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/g)) {
    merges.push([Number(m[2]) - 1, colIndex(m[1] as string), Number(m[4]) - 1, colIndex(m[3] as string)]);
  }
  let rowIdx = -1;
  for (const r of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rAttr = attr(r[0].slice(0, r[0].indexOf('>') + 1), 'r');
    rowIdx = rAttr ? Number(rAttr) - 1 : rowIdx + 1;
    const row: Cell[] = [];
    let colIdx = -1;
    for (const c of (r[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const open = `<c${c[1]}>`;
      const ref = attr(open, 'r');
      colIdx = ref ? colIndex(ref) : colIdx + 1;
      const type = attr(open, 't');
      const body = c[2] ?? '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value: Cell = null;
      if (type === 's') value = v !== undefined ? (shared[Number(v)] ?? '') : null;
      else if (type === 'inlineStr') value = textOf(body);
      else if (type === 'str' || type === 'e') value = v !== undefined ? unescapeXml(v) : null;
      else if (type === 'b') value = v === '1';
      else if (v !== undefined && v !== '') value = Number(v);
      row[colIdx] = value;
    }
    for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = null;
    rows[rowIdx] = row;
  }
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  // merged ranges: copy the top-left value across (header bands such as "Basic Info" span many columns)
  for (const [r1, c1, r2, c2] of merges) {
    const v = rows[r1]?.[c1] ?? null;
    for (let r = r1; r <= r2; r++) {
      const row = (rows[r] ??= []);
      for (let c = c1; c <= c2; c++) if (row[c] === null || row[c] === undefined) row[c] = v;
    }
  }
  for (const row of rows) for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = null;
  return rows;
}

/** Excel serial date (1900 system) to YYYY-MM-DD, timezone independent. */
export function excelDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86_400_000);
  return new Date(ms).toISOString().slice(0, 10);
}

// ---- writer --------------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = (CRC_TABLE[(c ^ x) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = te.encode(f.name);
    const crc = crc32(f.data);
    const local = new Uint8Array(30 + name.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x0800, true); // UTF-8 names
    dv.setUint32(14, crc, true);
    dv.setUint32(18, f.data.length, true);
    dv.setUint32(22, f.data.length, true);
    dv.setUint16(26, name.length, true);
    local.set(name, 30);
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.data.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    chunks.push(local, f.data);
    central.push(cd);
    offset += local.length + f.data.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const all = [...chunks, ...central, end];
  const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
  let p = 0;
  for (const c of all) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

/** Builds a single-sheet workbook. Strings are written inline, numbers as numbers; the first row is bold. */
export function writeXlsx(sheetName: string, rows: Cell[][]): Uint8Array {
  const body = rows
    .map((row, r) => {
      const cells = row
        .map((v, c) => {
          const ref = `${colName(c)}${r + 1}`;
          const s = r === 0 ? ' s="1"' : '';
          if (v === null || v === undefined || v === '') return '';
          if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${s}><v>${v}</v></c>`;
          if (typeof v === 'boolean') return `<c r="${ref}" t="b"${s}><v>${v ? 1 : 0}</v></c>`;
          return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${escapeXml(String(v))}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');
  const safeName = escapeXml(sheetName.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || 'Sheet1');
  const files: Record<string, string> = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${safeName}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Tahoma"/></font><font><b/><sz val="11"/><name val="Tahoma"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf fontId="0"/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`,
  };
  return zip(Object.entries(files).map(([name, s]) => ({ name, data: te.encode(s) })));
}

// ---- CSV -----------------------------------------------------------------------------------
/** RFC 4180 CSV parser (quoted fields, embedded newlines, UTF-8 BOM tolerated). */
export function parseCsv(text: string): Cell[][] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: Cell[][] = [];
  let row: Cell[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.map((r) => r.map((v) => (v === '' ? null : v)));
}
