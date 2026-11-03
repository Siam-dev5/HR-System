import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export class HttpError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, 'bad_request', message, details);
export const unauthorized = (message = 'กรุณาเข้าสู่ระบบ') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'ไม่มีสิทธิ์ดำเนินการนี้') => new HttpError(403, 'forbidden', message);
export const notFound = (message = 'ไม่พบข้อมูล') => new HttpError(404, 'not_found', message);
export const conflict = (message: string) => new HttpError(409, 'conflict', message);

export async function readJson<T = Record<string, unknown>>(c: Context): Promise<T> {
  const type = c.req.header('content-type') ?? '';
  if (!type.includes('application/json')) throw badRequest('ต้องส่งข้อมูลแบบ application/json');
  try {
    const body = await c.req.json();
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return body as T;
  } catch {
    throw badRequest('รูปแบบ JSON ไม่ถูกต้อง');
  }
}

export function intParam(value: string | undefined, name = 'id'): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`${name} ไม่ถูกต้อง`);
  return n;
}

export function str(body: Record<string, unknown>, key: string, opts: { required?: boolean; max?: number } = {}): string | null {
  const v = body[key];
  if (v === undefined || v === null || v === '') {
    if (opts.required) throw badRequest(`กรุณาระบุ ${key}`);
    return null;
  }
  if (typeof v !== 'string') throw badRequest(`${key} ต้องเป็นข้อความ`);
  const t = v.trim();
  if (opts.max && t.length > opts.max) throw badRequest(`${key} ยาวเกิน ${opts.max} ตัวอักษร`);
  return t;
}

/** Download file names built from user-entered codes: keep them header-safe. */
export const safeName = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function csv(rows: Array<Array<string | number | null>>): string {
  const esc = (v: string | number | null) => {
    const s = v === null || v === undefined ? '' : String(v);
    // neutralise spreadsheet formula injection
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}
