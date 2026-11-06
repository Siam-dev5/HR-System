// Test-only writer of legacy Excel .xls files (BIFF8 in an OLE2 compound file) for the reader in src/shared/xls.ts.
// Strings go to the shared string table (split across CONTINUE records like Excel does when it grows past one
// record), integers are written as RK, other numbers as NUMBER. `mini: true` keeps a small workbook in the
// compound file's mini stream (the other storage path of the reader).
type Cell = string | number | boolean | null;

const u16 = (n: number) => [n & 255, (n >> 8) & 255];
const u32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const rec = (type: number, data: number[]) => [...u16(type), ...u16(data.length), ...data];
const f64 = (v: number) => [...new Uint8Array(new Float64Array([v]).buffer)];
const MAX_REC = 8224;

function sstRecords(strings: readonly string[]): number[] {
  const out: number[] = [];
  let cur: number[] = [...u32(strings.length), ...u32(strings.length)];
  let first = true;
  const flush = () => {
    out.push(...rec(first ? 0x00fc : 0x003c, cur));
    first = false;
    cur = [];
  };
  for (const s of strings) {
    const wide = [...s].some((ch) => ch.charCodeAt(0) > 255);
    if (cur.length + 3 > MAX_REC) flush();
    cur.push(...u16(s.length), wide ? 1 : 0);
    for (const ch of s) {
      const bytes = wide ? u16(ch.charCodeAt(0)) : [ch.charCodeAt(0)];
      if (cur.length + bytes.length > MAX_REC) {
        flush();
        cur.push(wide ? 1 : 0); // a continuation of character data restarts with its options byte
      }
      cur.push(...bytes);
    }
  }
  flush();
  return out;
}

function workbookStream(sheets: Array<{ name: string; rows: Cell[][] }>): Uint8Array {
  const strings: string[] = [];
  const sIndex = new Map<string, number>();
  const sheetBodies = sheets.map((sh) => {
    const body: number[] = [...rec(0x0809, [...u16(0x0600), ...u16(0x0010), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])];
    sh.rows.forEach((row, r) => row.forEach((v, c) => {
      if (v === null || v === '') return;
      if (typeof v === 'string') {
        if (!sIndex.has(v)) { sIndex.set(v, strings.length); strings.push(v); }
        body.push(...rec(0x00fd, [...u16(r), ...u16(c), ...u16(0), ...u32(sIndex.get(v)!)]));
      } else if (typeof v === 'boolean') body.push(...rec(0x0205, [...u16(r), ...u16(c), ...u16(0), v ? 1 : 0, 0]));
      else if (Number.isInteger(v) && Math.abs(v) < 2 ** 29) body.push(...rec(0x027e, [...u16(r), ...u16(c), ...u16(0), ...u32(((v << 2) | 2) >>> 0)]));
      else body.push(...rec(0x0203, [...u16(r), ...u16(c), ...u16(0), ...f64(v)]));
    }));
    body.push(...rec(0x000a, []));
    return body;
  });
  const bof = rec(0x0809, [...u16(0x0600), ...u16(0x0005), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const sst = sstRecords(strings);
  const eof = rec(0x000a, []);
  const boundsheet = (name: string, offset: number) => rec(0x0085, [...u32(offset), 0, 0, name.length, 0, ...[...name].map((ch) => ch.charCodeAt(0))]);
  const globalsLen = bof.length + sheets.reduce((s, sh) => s + boundsheet(sh.name, 0).length, 0) + sst.length + eof.length;
  let offset = globalsLen;
  const bounds = sheets.map((sh, i) => {
    const b = boundsheet(sh.name, offset);
    offset += sheetBodies[i]!.length;
    return b;
  });
  return new Uint8Array([...bof, ...bounds.flat(), ...sst, ...eof, ...sheetBodies.flat()]);
}

const END = 0xfffffffe;
const FREE = 0xffffffff;
const FATSECT = 0xfffffffd;

function dirEntry(name: string, type: number, start: number, size: number, child = FREE): number[] {
  const e = new Array(128).fill(0);
  [...name].forEach((ch, i) => { e[i * 2] = ch.charCodeAt(0); });
  e.splice(0x40, 2, ...u16((name.length + 1) * 2));
  e[0x42] = type;
  e[0x43] = 1;
  e.splice(0x44, 4, ...u32(FREE));
  e.splice(0x48, 4, ...u32(FREE));
  e.splice(0x4c, 4, ...u32(child));
  e.splice(0x74, 4, ...u32(start));
  e.splice(0x78, 4, ...u32(size));
  return e;
}

export function writeXls(sheets: Array<{ name: string; rows: Cell[][] }>, opts: { mini?: boolean } = {}): Uint8Array {
  let stream = workbookStream(sheets);
  const mini = !!opts.mini && stream.length < 4096;
  if (!opts.mini && stream.length < 4096) stream = new Uint8Array([...stream, ...new Array(4096 - stream.length).fill(0)]);
  const sectors: number[][] = [];
  const fat: number[] = [];
  const chainOf = (bytes: number[] | Uint8Array): number => {
    const start = sectors.length;
    const n = Math.max(1, Math.ceil(bytes.length / 512));
    for (let i = 0; i < n; i++) {
      const s = Array.from(bytes.slice(i * 512, i * 512 + 512));
      while (s.length < 512) s.push(0);
      sectors.push(s);
      fat.push(i === n - 1 ? END : start + i + 1);
    }
    return start;
  };
  let rootStart = END;
  let rootSize = 0;
  let wbStart: number;
  let miniFatStart = END;
  let miniFatCount = 0;
  if (mini) {
    const n = Math.ceil(stream.length / 64);
    const data = new Array(n * 64).fill(0);
    stream.forEach((b, i) => { data[i] = b; });
    rootStart = chainOf(data);
    rootSize = data.length;
    const miniFat: number[] = [];
    for (let i = 0; i < n; i++) miniFat.push(...u32(i === n - 1 ? END : i + 1));
    miniFatStart = chainOf(miniFat);
    miniFatCount = 1;
    wbStart = 0;
  } else wbStart = chainOf(stream);
  const dirStart = chainOf([...dirEntry('Root Entry', 5, rootStart, rootSize, 1), ...dirEntry('Workbook', 2, wbStart, stream.length), ...new Array(256).fill(0)]);
  const fatSectors = Math.ceil((sectors.length + 1) / 127) || 1;
  const fatStart = sectors.length;
  for (let i = 0; i < fatSectors; i++) fat.push(FATSECT);
  const fatBytes: number[] = [];
  for (let i = 0; i < fatSectors * 128; i++) fatBytes.push(...u32(fat[i] ?? FREE));
  for (let i = 0; i < fatSectors; i++) sectors.push(fatBytes.slice(i * 512, i * 512 + 512));
  const header = new Array(512).fill(0);
  [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].forEach((b, i) => { header[i] = b; });
  header.splice(0x18, 2, ...u16(0x3e));
  header.splice(0x1a, 2, ...u16(3));
  header.splice(0x1c, 2, ...u16(0xfffe));
  header.splice(0x1e, 2, ...u16(9));
  header.splice(0x20, 2, ...u16(6));
  header.splice(0x2c, 4, ...u32(fatSectors));
  header.splice(0x30, 4, ...u32(dirStart));
  header.splice(0x38, 4, ...u32(4096));
  header.splice(0x3c, 4, ...u32(miniFatStart));
  header.splice(0x40, 4, ...u32(miniFatCount));
  header.splice(0x44, 4, ...u32(END));
  for (let i = 0; i < 109; i++) header.splice(0x4c + i * 4, 4, ...u32(i < fatSectors ? fatStart + i : FREE));
  return new Uint8Array([...header, ...sectors.flat()]);
}
