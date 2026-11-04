// Employee photographs: validation and the storage protocol, independent of Cloudflare types (unit-tested with fakes).
// Bytes live in a private R2 bucket, D1 keeps one metadata row per employee. A replacement writes the new object first,
// then swaps the metadata (compare-and-swap on the old key), and only then deletes the old object — so a failure at
// any step leaves the last valid photo readable and never leaves metadata pointing at a missing object.

export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AvatarType = (typeof AVATAR_TYPES)[number];
const EXT: Record<AvatarType, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** Metadata of a stored photo as the API returns it; `version` changes with every upload. */
export interface AvatarMeta {
  version: string;
  content_type: AvatarType;
  size_bytes: number;
  updated_at: string;
}

export interface AvatarRecord {
  employee_id: number;
  object_key: string;
  content_type: AvatarType;
  size_bytes: number;
  updated_at: string;
  updated_by: number | null;
}

export class AvatarError extends Error {
  constructor(readonly status: 400 | 409 | 413 | 415 | 502, readonly code: string, message: string) {
    super(message);
  }
}

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
const u32be = (b: Uint8Array, at: number) => ((b[at] as number) << 24 >>> 0) + ((b[at + 1] as number) << 16) + ((b[at + 2] as number) << 8) + (b[at + 3] as number);
const u32le = (b: Uint8Array, at: number) => (b[at] as number) + ((b[at + 1] as number) << 8) + ((b[at + 2] as number) << 16) + ((b[at + 3] as number) << 24 >>> 0);

/** Image type from the file signature (magic bytes), whatever the declared content type says. */
export function sniffImage(b: Uint8Array): AvatarType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return 'image/png';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Structural sanity beyond the signature: truncated or forged files are rejected. Returns a reason or null. */
function malformed(type: AvatarType, b: Uint8Array): string | null {
  if (type === 'image/png') {
    if (b.length < 45 || ascii(b, 12, 16) !== 'IHDR') return 'PNG ไม่มีส่วนหัว IHDR';
    const w = u32be(b, 16);
    const h = u32be(b, 20);
    if (!w || !h || w > 20000 || h > 20000) return 'ขนาดภาพ PNG ไม่ถูกต้อง';
    if (ascii(b, b.length - 8, b.length - 4) !== 'IEND') return 'ไฟล์ PNG ไม่สมบูรณ์';
    return null;
  }
  if (type === 'image/jpeg') {
    if (b.length < 125) return 'ไฟล์ JPEG สั้นผิดปกติ';
    const tail = b.subarray(Math.max(0, b.length - 1024));
    for (let i = tail.length - 2; i >= 0; i--) if (tail[i] === 0xff && tail[i + 1] === 0xd9) return null;
    return 'ไฟล์ JPEG ไม่สมบูรณ์';
  }
  const riff = u32le(b, 4) + 8;
  if (b.length < 30 || riff > b.length || b.length - riff > 1) return 'ไฟล์ WebP ไม่สมบูรณ์';
  if (!['VP8 ', 'VP8L', 'VP8X'].includes(ascii(b, 12, 16))) return 'ไฟล์ WebP ไม่ถูกต้อง';
  return null;
}

/** Validates an upload: size, declared type, signature, declared = detected, structure. */
export function validateAvatar(bytes: Uint8Array, declared: string | null | undefined): AvatarType {
  if (bytes.length === 0) throw new AvatarError(400, 'empty', 'ไม่มีข้อมูลรูปภาพ');
  if (bytes.length > AVATAR_MAX_BYTES) throw new AvatarError(413, 'too_large', 'รูปภาพต้องมีขนาดไม่เกิน 5 MB');
  const want = (declared ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!(AVATAR_TYPES as readonly string[]).includes(want)) throw new AvatarError(415, 'unsupported_type', 'รองรับเฉพาะ JPEG, PNG และ WebP');
  const got = sniffImage(bytes);
  if (!got) throw new AvatarError(415, 'bad_signature', 'เนื้อไฟล์ไม่ใช่รูปภาพ JPEG, PNG หรือ WebP');
  if (got !== want) throw new AvatarError(415, 'type_mismatch', 'ชนิดไฟล์ที่ระบุไม่ตรงกับเนื้อไฟล์');
  const bad = malformed(got, bytes);
  if (bad) throw new AvatarError(400, 'malformed', bad);
  return got;
}

/** Versioned, unguessable object key; the version shown to clients is the uuid part. */
export function avatarKey(companyId: number, employeeId: number, type: AvatarType, uuid: string): string {
  return `employees/${companyId}/${employeeId}/avatar/${uuid}.${EXT[type]}`;
}

export function avatarVersion(objectKey: string): string {
  return objectKey.slice(objectKey.lastIndexOf('/') + 1).replace(/\.[a-z]+$/, '');
}

export function toMeta(r: AvatarRecord): AvatarMeta {
  return { version: avatarVersion(r.object_key), content_type: r.content_type, size_bytes: r.size_bytes, updated_at: r.updated_at };
}

/** Byte storage (R2 in the Worker). */
export interface AvatarObjects {
  put(key: string, bytes: Uint8Array, contentType: AvatarType): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Metadata storage (D1 in the Worker); every write is conditional so concurrent requests cannot interleave. */
export interface AvatarRecords {
  get(employeeId: number): Promise<AvatarRecord | null>;
  /** insert when the employee has no photo yet; false if one appeared meanwhile */
  insert(rec: Omit<AvatarRecord, 'updated_at'>): Promise<boolean>;
  /** replace only if the current key is still `oldKey`; false otherwise */
  swap(oldKey: string, rec: Omit<AvatarRecord, 'updated_at'>): Promise<boolean>;
  /** delete only if the current key is still `key`; false otherwise */
  remove(employeeId: number, key: string): Promise<boolean>;
}

export interface SaveResult {
  record: AvatarRecord;
  previousKey: string | null;
  /** previous object could not be deleted (unreferenced; safe to remove later) */
  orphanKey: string | null;
}

/** Stores a new photo: object first, metadata second (conditional), old object last. */
export async function saveAvatar(objects: AvatarObjects, records: AvatarRecords, input: { employeeId: number; companyId: number; userId: number | null; bytes: Uint8Array; type: AvatarType; uuid: string }): Promise<SaveResult> {
  const key = avatarKey(input.companyId, input.employeeId, input.type, input.uuid);
  const current = await records.get(input.employeeId);
  try {
    await objects.put(key, input.bytes, input.type);
  } catch {
    throw new AvatarError(502, 'storage_failed', 'บันทึกรูปภาพไม่สำเร็จ (ที่เก็บไฟล์) รูปเดิมยังอยู่ กรุณาลองใหม่');
  }
  const rec = { employee_id: input.employeeId, object_key: key, content_type: input.type, size_bytes: input.bytes.length, updated_by: input.userId };
  let ok: boolean;
  try {
    ok = current ? await records.swap(current.object_key, rec) : await records.insert(rec);
  } catch {
    await objects.delete(key).catch(() => undefined);
    throw new AvatarError(502, 'metadata_failed', 'บันทึกข้อมูลรูปภาพไม่สำเร็จ รูปเดิมยังอยู่ กรุณาลองใหม่');
  }
  if (!ok) {
    await objects.delete(key).catch(() => undefined);
    throw new AvatarError(409, 'concurrent_change', 'รูปภาพถูกเปลี่ยนโดยผู้อื่นระหว่างนี้ กรุณาลองใหม่');
  }
  const saved = await records.get(input.employeeId);
  if (!saved || saved.object_key !== key) throw new AvatarError(409, 'concurrent_change', 'รูปภาพถูกเปลี่ยนโดยผู้อื่นระหว่างนี้ กรุณาลองใหม่');
  let orphanKey: string | null = null;
  if (current) {
    try {
      await objects.delete(current.object_key);
    } catch {
      orphanKey = current.object_key;
    }
  }
  return { record: saved, previousKey: current?.object_key ?? null, orphanKey };
}

/** Removes the photo: metadata first (so nothing points at a missing object), then the object. */
export async function deleteAvatar(objects: AvatarObjects, records: AvatarRecords, employeeId: number): Promise<{ removed: AvatarRecord | null; orphanKey: string | null }> {
  const current = await records.get(employeeId);
  if (!current) return { removed: null, orphanKey: null };
  let ok: boolean;
  try {
    ok = await records.remove(employeeId, current.object_key);
  } catch {
    throw new AvatarError(502, 'metadata_failed', 'ลบรูปภาพไม่สำเร็จ กรุณาลองใหม่');
  }
  if (!ok) throw new AvatarError(409, 'concurrent_change', 'รูปภาพถูกเปลี่ยนโดยผู้อื่นระหว่างนี้ กรุณาลองใหม่');
  try {
    await objects.delete(current.object_key);
    return { removed: current, orphanKey: null };
  } catch {
    return { removed: current, orphanKey: current.object_key };
  }
}

// Thai leading vowels (เ แ โ ใ ไ) and combining marks are never an initial: "เกียรติ" → "ก"
const skipped = (cp: number) => cp === 0x0e31 || (cp >= 0x0e34 && cp <= 0x0e3a) || (cp >= 0x0e40 && cp <= 0x0e44) || (cp >= 0x0e47 && cp <= 0x0e4e);
const initialOf = (word: string): string => {
  for (const ch of word) if (!skipped(ch.codePointAt(0) as number) && /\p{L}|\p{N}/u.test(ch)) return ch.toLocaleUpperCase('th-TH');
  return '';
};

/** Up to two initials (first + last name) for the photo fallback; "?" when the name has none. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = initialOf(words[0] ?? '');
  const last = words.length > 1 ? initialOf(words[words.length - 1] as string) : '';
  return `${first}${last}` || '?';
}
