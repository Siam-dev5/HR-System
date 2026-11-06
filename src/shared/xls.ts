// Minimal, dependency-free reader for legacy Excel .xls files (BIFF8 in an OLE2 compound file, Excel 97–2003).
// Returns every worksheet as a grid of raw cell values like readXlsx: strings, numbers (dates and times stay Excel
// serials), booleans and null. Formulas give their cached result. Encrypted and pre-97 (BIFF5) files are rejected.
import type { Cell, Sheet } from './xlsx';

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const END_OF_CHAIN = 0xfffffffe;
const FREE = 0xffffffff;
const MAX_CELLS = 2_000_000;

class Bytes {
  constructor(readonly b: Uint8Array) {}
  u8(o: number): number {
    return this.b[o] ?? 0;
  }
  u16(o: number): number {
    return this.u8(o) | (this.u8(o + 1) << 8);
  }
  u32(o: number): number {
    return (this.u16(o) | (this.u16(o + 2) << 16)) >>> 0;
  }
  i32(o: number): number {
    return this.u32(o) | 0;
  }
  f64(o: number): number {
    return new DataView(this.b.buffer, this.b.byteOffset + o, 8).getFloat64(0, true);
  }
}

// ---- OLE2 compound file ------------------------------------------------------------------------
function readCompoundStream(data: Uint8Array, names: readonly string[]): Uint8Array {
  if (data.length < 512 || !SIGNATURE.every((x, i) => data[i] === x)) throw new Error('ไฟล์ไม่ใช่ Excel .xls ที่ถูกต้อง');
  const r = new Bytes(data);
  const sectorSize = 1 << r.u16(0x1e);
  const miniSize = 1 << r.u16(0x20);
  if (sectorSize !== 512 && sectorSize !== 4096) throw new Error('ไฟล์ .xls เสียหาย (sector size)');
  const sectorAt = (sid: number) => (sid + 1) * sectorSize;
  const sector = (sid: number) => {
    const o = sectorAt(sid);
    if (o + sectorSize > data.length) throw new Error('ไฟล์ .xls เสียหาย (sector นอกไฟล์)');
    return data.subarray(o, o + sectorSize);
  };
  // FAT sector ids: 109 in the header, the rest in the DIFAT chain
  const fatIds: number[] = [];
  for (let i = 0; i < 109; i++) {
    const id = r.u32(0x4c + i * 4);
    if (id !== FREE && id !== END_OF_CHAIN) fatIds.push(id);
  }
  let difat = r.u32(0x44);
  for (let n = 0; difat !== END_OF_CHAIN && difat !== FREE && n < 10_000; n++) {
    const s = new Bytes(sector(difat));
    const per = sectorSize / 4 - 1;
    for (let i = 0; i < per; i++) {
      const id = s.u32(i * 4);
      if (id !== FREE && id !== END_OF_CHAIN) fatIds.push(id);
    }
    difat = s.u32(per * 4);
  }
  const fat: number[] = [];
  for (const id of fatIds) {
    const s = new Bytes(sector(id));
    for (let i = 0; i < sectorSize / 4; i++) fat.push(s.u32(i * 4));
  }
  const chain = (start: number, table: readonly number[]): number[] => {
    const out: number[] = [];
    const seen = new Set<number>();
    for (let s = start; s !== END_OF_CHAIN && s !== FREE; s = table[s] ?? END_OF_CHAIN) {
      if (seen.has(s) || s >= table.length) throw new Error('ไฟล์ .xls เสียหาย (sector chain)');
      seen.add(s);
      out.push(s);
    }
    return out;
  };
  const readChain = (start: number, size: number): Uint8Array => {
    const ids = chain(start, fat);
    const out = new Uint8Array(ids.length * sectorSize);
    ids.forEach((id, i) => out.set(sector(id), i * sectorSize));
    return out.subarray(0, Math.min(size, out.length));
  };
  // directory
  const dirBytes = readChain(r.u32(0x30), Number.MAX_SAFE_INTEGER);
  const dir = new Bytes(dirBytes);
  interface Entry { name: string; type: number; start: number; size: number }
  const entries: Entry[] = [];
  for (let o = 0; o + 128 <= dirBytes.length; o += 128) {
    const len = Math.min(64, dir.u16(o + 0x40));
    let name = '';
    for (let i = 0; i + 2 < len; i += 2) name += String.fromCharCode(dir.u16(o + i));
    entries.push({ name, type: dir.u8(o + 0x42), start: dir.u32(o + 0x74), size: dir.u32(o + 0x78) });
  }
  const root = entries.find((e) => e.type === 5);
  const want = names.map((n) => n.toLowerCase());
  const entry = entries.find((e) => e.type === 2 && want.includes(e.name.toLowerCase()));
  if (!entry || !root) throw new Error('ไม่พบข้อมูล Workbook ในไฟล์ .xls');
  if (entry.size >= r.u32(0x38)) return readChain(entry.start, entry.size);
  // small stream: stored in the mini stream (64-byte sectors) of the root entry
  const miniStream = readChain(root.start, root.size);
  const miniFatBytes = readChain(r.u32(0x3c), r.u32(0x40) * sectorSize);
  const mf = new Bytes(miniFatBytes);
  const miniFat = Array.from({ length: miniFatBytes.length / 4 }, (_, i) => mf.u32(i * 4));
  const ids = chain(entry.start, miniFat);
  const out = new Uint8Array(ids.length * miniSize);
  ids.forEach((id, i) => out.set(miniStream.subarray(id * miniSize, (id + 1) * miniSize), i * miniSize));
  return out.subarray(0, entry.size);
}

// ---- BIFF8 -------------------------------------------------------------------------------------
interface Rec {
  type: number;
  data: Uint8Array;
  /** CONTINUE records that follow (their data, in order) */
  more: Uint8Array[];
}

function records(stream: Uint8Array, from: number): { list: Rec[]; end: number } {
  const r = new Bytes(stream);
  const list: Rec[] = [];
  let o = from;
  while (o + 4 <= stream.length) {
    const type = r.u16(o);
    const len = r.u16(o + 2);
    const data = stream.subarray(o + 4, o + 4 + len);
    o += 4 + len;
    if (type === 0x003c && list.length) list[list.length - 1]!.more.push(data);
    else list.push({ type, data, more: [] });
    if (type === 0x000a) break; // EOF of this substream
  }
  return { list, end: o };
}

/** Reads strings that may continue across CONTINUE records (each continuation restarts with an options byte). */
class SegmentReader {
  private seg = 0;
  private pos = 0;
  constructor(private readonly segs: Uint8Array[]) {}
  private get cur(): Uint8Array {
    return this.segs[this.seg] ?? new Uint8Array(0);
  }
  private next(): void {
    this.seg++;
    this.pos = 0;
  }
  u8(): number {
    if (this.pos >= this.cur.length) this.next();
    return this.cur[this.pos++] ?? 0;
  }
  u16(): number {
    return this.u8() | (this.u8() << 8);
  }
  u32(): number {
    return (this.u16() | (this.u16() << 16)) >>> 0;
  }
  skip(n: number): void {
    for (let i = 0; i < n; i++) this.u8();
  }
  /** XLUnicodeRichExtendedString (SST entry) */
  richString(): string {
    const cch = this.u16();
    let flags = this.u8();
    const runs = flags & 0x08 ? this.u16() : 0;
    const ext = flags & 0x04 ? this.u32() : 0;
    let s = '';
    for (let i = 0; i < cch; i++) {
      if (this.pos >= this.cur.length) {
        this.next();
        flags = (flags & ~1) | (this.u8() & 1); // a continuation restarts with its own high-byte flag
      }
      s += String.fromCharCode(flags & 1 ? this.u16() : this.u8());
    }
    this.skip(runs * 4 + ext);
    return s;
  }
}

function shortString(r: Bytes, o: number, wide16: boolean): string {
  const cch = wide16 ? r.u16(o) : r.u8(o);
  const p = o + (wide16 ? 2 : 1);
  const flags = r.u8(p);
  let s = '';
  for (let i = 0; i < cch; i++) s += String.fromCharCode(flags & 1 ? r.u16(p + 1 + i * 2) : r.u8(p + 1 + i));
  return s;
}

function rk(v: number): number {
  let n: number;
  if (v & 2) n = v >> 2;
  else {
    const buf = new DataView(new ArrayBuffer(8));
    buf.setUint32(4, v & 0xfffffffc, true);
    n = buf.getFloat64(0, true);
  }
  return v & 1 ? n / 100 : n;
}

export async function readXls(input: ArrayBuffer | Uint8Array): Promise<Sheet[]> {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input);
  const stream = readCompoundStream(data, ['Workbook', 'Book']);
  const { list: globals } = records(stream, 0);
  const bof = globals[0];
  if (!bof || bof.type !== 0x0809) throw new Error('ไฟล์ .xls เสียหาย (BOF)');
  if (new Bytes(bof.data).u16(0) !== 0x0600) throw new Error('รองรับเฉพาะไฟล์ Excel 97–2003 (.xls) ขึ้นไป กรุณาบันทึกเป็น .xlsx');
  if (globals.some((x) => x.type === 0x002f)) throw new Error('ไฟล์ .xls ถูกเข้ารหัสด้วยรหัสผ่าน กรุณาเอารหัสผ่านออกก่อนนำเข้า');
  let sst: string[] = [];
  const sheets: Array<{ name: string; offset: number }> = [];
  for (const rec of globals) {
    const r = new Bytes(rec.data);
    if (rec.type === 0x00fc) {
      const reader = new SegmentReader([rec.data, ...rec.more]);
      reader.skip(4);
      const unique = reader.u32();
      sst = [];
      for (let i = 0; i < unique; i++) sst.push(reader.richString());
    } else if (rec.type === 0x0085 && r.u8(5) === 0) {
      sheets.push({ offset: r.u32(0), name: shortString(r, 6, false) });
    }
  }
  const out: Sheet[] = [];
  let cells = 0;
  for (const sh of sheets) {
    const rows: Cell[][] = [];
    const set = (row: number, col: number, v: Cell) => {
      if (++cells > MAX_CELLS) throw new Error('ไฟล์ .xls มีข้อมูลมากเกินไป');
      (rows[row] ??= [])[col] = v;
    };
    const { list } = records(stream, sh.offset);
    for (let i = 0; i < list.length; i++) {
      const rec = list[i]!;
      const r = new Bytes(rec.data);
      const row = r.u16(0);
      const col = r.u16(2);
      switch (rec.type) {
        case 0x00fd: set(row, col, sst[r.u32(6)] ?? null); break; // LABELSST
        case 0x0204: set(row, col, shortString(r, 6, true)); break; // LABEL
        case 0x0203: set(row, col, r.f64(6)); break; // NUMBER
        case 0x027e: set(row, col, rk(r.i32(6))); break; // RK
        case 0x00bd: { // MULRK
          const last = r.u16(rec.data.length - 2);
          for (let c = col, o = 4; c <= last; c++, o += 6) set(row, c, rk(r.i32(o + 2)));
          break;
        }
        case 0x0205: set(row, col, r.u8(7) ? null : r.u8(6) !== 0); break; // BOOLERR (errors → empty)
        case 0x0006: { // FORMULA: cached result
          if (r.u16(12) !== 0xffff) set(row, col, r.f64(6));
          else if (r.u8(6) === 0) {
            const next = list[i + 1];
            if (next?.type === 0x0207) set(row, col, shortString(new Bytes(next.data), 0, true));
          } else if (r.u8(6) === 1) set(row, col, r.u8(8) !== 0);
          break;
        }
        default: break;
      }
    }
    for (const rr of rows) if (rr) for (let c = 0; c < rr.length; c++) if (rr[c] === undefined) rr[c] = null;
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    out.push({ name: sh.name, rows });
  }
  return out;
}
