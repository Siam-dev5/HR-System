import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AVATAR_MAX_BYTES, AvatarError, avatarKey, avatarVersion, deleteAvatar, initialsOf, saveAvatar, sniffImage, validateAvatar,
  type AvatarObjects, type AvatarRecord, type AvatarRecords,
} from '../../src/shared/avatar';

const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, '..', 'fixtures', 'avatar', name)));
const JPG = fixture('sample.jpg');
const PNG = fixture('sample.png');
const WEBP = fixture('sample.webp');

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof AvatarError ? `${e.status}:${e.code}` : String(e);
  }
  return 'ok';
};

describe('avatar validation', () => {
  it('accepts real JPEG, PNG and WebP files with a matching content type', () => {
    expect(validateAvatar(JPG, 'image/jpeg')).toBe('image/jpeg');
    expect(validateAvatar(PNG, 'image/png')).toBe('image/png');
    expect(validateAvatar(WEBP, 'image/webp; charset=binary')).toBe('image/webp');
  });

  it('detects the type from the signature', () => {
    expect(sniffImage(JPG)).toBe('image/jpeg');
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(WEBP)).toBe('image/webp');
    expect(sniffImage(new TextEncoder().encode('GIF89a......'))).toBeNull();
  });

  it('rejects unsupported declared types', () => {
    expect(code(() => validateAvatar(PNG, 'image/gif'))).toBe('415:unsupported_type');
    expect(code(() => validateAvatar(PNG, 'image/svg+xml'))).toBe('415:unsupported_type');
    expect(code(() => validateAvatar(PNG, null))).toBe('415:unsupported_type');
  });

  it('rejects a forged signature and a type that does not match the bytes', () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
    expect(code(() => validateAvatar(svg, 'image/png'))).toBe('415:bad_signature');
    expect(code(() => validateAvatar(PNG, 'image/jpeg'))).toBe('415:type_mismatch');
    expect(code(() => validateAvatar(JPG, 'image/webp'))).toBe('415:type_mismatch');
  });

  it('rejects truncated or malformed files that carry a valid signature', () => {
    expect(code(() => validateAvatar(PNG.subarray(0, PNG.length - 20), 'image/png'))).toBe('400:malformed');
    expect(code(() => validateAvatar(JPG.subarray(0, JPG.length - 2), 'image/jpeg'))).toBe('400:malformed');
    expect(code(() => validateAvatar(WEBP.subarray(0, WEBP.length - 10), 'image/webp'))).toBe('400:malformed');
    const sigOnly = new Uint8Array(200);
    sigOnly.set([0xff, 0xd8, 0xff]);
    expect(code(() => validateAvatar(sigOnly, 'image/jpeg'))).toBe('400:malformed');
  });

  it('enforces the 5 MB limit and rejects empty bodies', () => {
    const big = new Uint8Array(AVATAR_MAX_BYTES + 1);
    big.set(PNG.subarray(0, 8));
    expect(code(() => validateAvatar(big, 'image/png'))).toBe('413:too_large');
    expect(code(() => validateAvatar(new Uint8Array(0), 'image/png'))).toBe('400:empty');
  });

  it('builds versioned keys and exposes only the uuid as version', () => {
    const key = avatarKey(1, 42, 'image/webp', 'a1b2c3');
    expect(key).toBe('employees/1/42/avatar/a1b2c3.webp');
    expect(avatarVersion(key)).toBe('a1b2c3');
  });
});

/** in-memory R2 + D1 with failure switches */
function fakes() {
  const objects = new Map<string, Uint8Array>();
  const rows = new Map<number, AvatarRecord>();
  const fail = { put: false, delete: false, write: false };
  const o: AvatarObjects = {
    put: async (k, b) => {
      if (fail.put) throw new Error('r2 put down');
      objects.set(k, b);
    },
    delete: async (k) => {
      if (fail.delete) throw new Error('r2 delete down');
      objects.delete(k);
    },
  };
  const now = () => new Date().toISOString();
  const r: AvatarRecords = {
    get: async (id) => rows.get(id) ?? null,
    insert: async (rec) => {
      if (fail.write) throw new Error('d1 down');
      if (rows.has(rec.employee_id)) return false;
      rows.set(rec.employee_id, { ...rec, updated_at: now() });
      return true;
    },
    swap: async (old, rec) => {
      if (fail.write) throw new Error('d1 down');
      if (rows.get(rec.employee_id)?.object_key !== old) return false;
      rows.set(rec.employee_id, { ...rec, updated_at: now() });
      return true;
    },
    remove: async (id, key) => {
      if (fail.write) throw new Error('d1 down');
      if (rows.get(id)?.object_key !== key) return false;
      rows.delete(id);
      return true;
    },
  };
  return { objects, rows, fail, o, r };
}
const input = (uuid: string, bytes = PNG) => ({ employeeId: 7, companyId: 1, userId: 3, bytes, type: 'image/png' as const, uuid });

describe('avatar storage protocol', () => {
  it('upload → replace → delete keeps metadata and objects consistent', async () => {
    const f = fakes();
    const first = await saveAvatar(f.o, f.r, input('u1'));
    expect(first.previousKey).toBeNull();
    expect([...f.objects.keys()]).toEqual(['employees/1/7/avatar/u1.png']);
    const second = await saveAvatar(f.o, f.r, input('u2', PNG));
    expect(second.previousKey).toBe('employees/1/7/avatar/u1.png');
    expect(second.orphanKey).toBeNull();
    expect([...f.objects.keys()]).toEqual(['employees/1/7/avatar/u2.png']);
    expect(f.rows.get(7)?.object_key).toBe('employees/1/7/avatar/u2.png');
    const gone = await deleteAvatar(f.o, f.r, 7);
    expect(gone.removed?.object_key).toBe('employees/1/7/avatar/u2.png');
    expect(f.objects.size).toBe(0);
    expect(f.rows.size).toBe(0);
    expect((await deleteAvatar(f.o, f.r, 7)).removed).toBeNull();
  });

  it('R2 write failure: nothing changes, the previous photo stays', async () => {
    const f = fakes();
    await saveAvatar(f.o, f.r, input('u1'));
    f.fail.put = true;
    await expect(saveAvatar(f.o, f.r, input('u2'))).rejects.toMatchObject({ status: 502, code: 'storage_failed' });
    expect(f.rows.get(7)?.object_key).toBe('employees/1/7/avatar/u1.png');
    expect([...f.objects.keys()]).toEqual(['employees/1/7/avatar/u1.png']);
  });

  it('D1 failure after the new object was written: the new object is cleaned up, the old one stays', async () => {
    const f = fakes();
    await saveAvatar(f.o, f.r, input('u1'));
    f.fail.write = true;
    await expect(saveAvatar(f.o, f.r, input('u2'))).rejects.toMatchObject({ status: 502, code: 'metadata_failed' });
    expect(f.rows.get(7)?.object_key).toBe('employees/1/7/avatar/u1.png');
    expect([...f.objects.keys()]).toEqual(['employees/1/7/avatar/u1.png']);
  });

  it('old object cannot be deleted after a replacement: new photo is live, the old key is reported as orphan', async () => {
    const f = fakes();
    await saveAvatar(f.o, f.r, input('u1'));
    f.fail.delete = true;
    const res = await saveAvatar(f.o, f.r, input('u2'));
    expect(res.record.object_key).toBe('employees/1/7/avatar/u2.png');
    expect(res.orphanKey).toBe('employees/1/7/avatar/u1.png');
  });

  it('a concurrent change wins: the losing upload removes its own object and reports 409', async () => {
    const f = fakes();
    await saveAvatar(f.o, f.r, input('u1'));
    const origGet = f.r.get;
    let first = true;
    f.r.get = async (id) => {
      const row = await origGet(id);
      if (first && row) {
        first = false;
        // another request replaces the photo between our read and our swap
        f.rows.set(7, { ...row, object_key: 'employees/1/7/avatar/other.png' });
        f.objects.set('employees/1/7/avatar/other.png', PNG);
      }
      return row;
    };
    await expect(saveAvatar(f.o, f.r, input('u2'))).rejects.toMatchObject({ status: 409 });
    expect(f.objects.has('employees/1/7/avatar/u2.png')).toBe(false);
    expect(f.rows.get(7)?.object_key).toBe('employees/1/7/avatar/other.png');
  });

  it('delete: D1 failure keeps everything; R2 failure leaves no metadata (object reported as orphan)', async () => {
    const f = fakes();
    await saveAvatar(f.o, f.r, input('u1'));
    f.fail.write = true;
    await expect(deleteAvatar(f.o, f.r, 7)).rejects.toMatchObject({ status: 502 });
    expect(f.rows.has(7)).toBe(true);
    f.fail.write = false;
    f.fail.delete = true;
    const res = await deleteAvatar(f.o, f.r, 7);
    expect(f.rows.has(7)).toBe(false);
    expect(res.orphanKey).toBe('employees/1/7/avatar/u1.png');
  });
});

describe('initials fallback', () => {
  it('uses the first letter of the first and last name', () => {
    expect(initialsOf('สมชาย ตัวอย่าง')).toBe('สต');
    expect(initialsOf('somchai  example')).toBe('SE');
    expect(initialsOf('Madonna')).toBe('M');
  });
  it('skips Thai leading vowels and marks', () => {
    expect(initialsOf('เกียรติ ใจดี')).toBe('กจ');
    expect(initialsOf('ไพโรจน์ โชติ')).toBe('พช');
  });
  it('never returns an empty string', () => {
    expect(initialsOf('')).toBe('?');
    expect(initialsOf('   ')).toBe('?');
  });
});
