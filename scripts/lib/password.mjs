// Node-side mirror of src/shared/crypto.ts (hash format: pbkdf2$<iter>$<salt b64>$<hash b64>).
// tests/unit/scripts.test.ts verifies hashes produced here are accepted by the Worker's verifyPassword.
import { webcrypto, randomBytes } from 'node:crypto';

export const PBKDF2_ITERATIONS = 100_000;

export async function hashPassword(password, iterations = PBKDF2_ITERATIONS) {
  const salt = randomBytes(16);
  const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await webcrypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return `pbkdf2$${iterations}$${salt.toString('base64')}$${Buffer.from(bits).toString('base64')}`;
}

export function generatePassword(length = 20) {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%*-_+='];
  const all = sets.join('');
  const bytes = randomBytes(length * 2);
  const chars = Array.from({ length }, (_, i) => {
    const set = i < sets.length ? sets[i] : all;
    return set[bytes[i] % set.length];
  });
  for (let i = chars.length - 1; i > 0; i--) {
    const j = bytes[length + i] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

export function sqlString(v) {
  return v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
}
