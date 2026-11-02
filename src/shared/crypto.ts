// WebCrypto helpers shared by the Worker and the tests (Node 20+ exposes the same globals).

const enc = new TextEncoder();
export const PBKDF2_ITERATIONS = 100_000; // Workers' PBKDF2 limit

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function base64url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export async function sha256Hex(value: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(value)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256);
  return new Uint8Array(bits);
}

/** Format: pbkdf2$<iterations>$<salt b64>$<hash b64> */
export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2$${iterations}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'pbkdf2' || !iter || !saltB64 || !hashB64) return false;
  const expected = fromBase64(hashB64);
  const actual = await pbkdf2(password, fromBase64(saltB64), Number(iter));
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= (actual[i] ?? 0) ^ (expected[i] ?? 0);
  return diff === 0;
}

async function aesKey(keyB64: string): Promise<CryptoKey> {
  const raw = fromBase64(keyB64);
  if (raw.length < 32) throw new Error('MFA_ENCRYPTION_KEY must be at least 32 bytes (base64)');
  const digest = await crypto.subtle.digest('SHA-256', raw as BufferSource);
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptString(plain: string, keyB64: string): Promise<string> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, await aesKey(keyB64), enc.encode(plain)));
  return `${toBase64(iv)}.${toBase64(ct)}`;
}

export async function decryptString(payload: string, keyB64: string): Promise<string> {
  const [ivB64, ctB64] = payload.split('.');
  if (!ivB64 || !ctB64) throw new Error('Invalid encrypted payload');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(ivB64) as BufferSource }, await aesKey(keyB64), fromBase64(ctB64) as BufferSource);
  return new TextDecoder().decode(pt);
}

/** Random password that satisfies the default policy (upper, lower, digit, symbol). */
export function generatePassword(length = 16): string {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%*-_+='];
  const all = sets.join('');
  const bytes = randomBytes(length);
  const chars = [...bytes].map((b, i) => {
    const set = i < sets.length ? (sets[i] as string) : all;
    return set[b % set.length] as string;
  });
  // shuffle so the guaranteed classes are not always first
  const shuffle = randomBytes(length);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = (shuffle[i] ?? 0) % (i + 1);
    [chars[i], chars[j]] = [chars[j] as string, chars[i] as string];
  }
  return chars.join('');
}
