import type { ApiError } from '../shared/types';

export class ApiFailure extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

let onAuthLost: (() => void) | null = null;
export function setAuthLostHandler(fn: () => void): void {
  onAuthLost = fn;
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET') {
    headers['x-hr-requested'] = '1';
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: init.body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(init.body),
  });
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err = (data as ApiError | null)?.error;
    if (res.status === 401 && onAuthLost && !path.startsWith('/api/auth/login')) onAuthLost();
    throw new ApiFailure(res.status, err?.code ?? 'http_error', err?.message ?? `เกิดข้อผิดพลาด (HTTP ${res.status})`, err?.details);
  }
  return data as T;
}

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body });
export const put = <T>(path: string, body?: unknown) => api<T>(path, { method: 'PUT', body });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });

export function qs(params: Record<string, string | number | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}
