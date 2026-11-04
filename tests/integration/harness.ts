// Starts `wrangler dev` (workerd + local D1) against a throw-away database for integration tests.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { totpCode } from '../../src/shared/totp';

const ROOT = resolve(__dirname, '../..');
const WRANGLER = join('node_modules', 'wrangler', 'bin', 'wrangler.js');

// wrangler runs through node directly (no shell), so paths containing spaces are passed safely.
function wrangler(args: string[]): string {
  return execFileSync(process.execPath, [WRANGLER, ...args], {
    cwd: ROOT,
    env: { ...process.env, CI: '1' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

export interface Harness {
  baseUrl: string;
  dir: string;
  passwords: Record<(typeof USERS)[number]['username'], string>;
  sql: (command: string) => Array<Record<string, unknown>>;
  /** results per statement (one array per SQL statement in the command) */
  sqlEach: (command: string) => Array<Array<Record<string, unknown>>>;
  /** whether the local (simulated) R2 bucket holds this object key */
  r2Has: (key: string) => boolean;
  stop: () => Promise<void>;
}

export const USERS = [
  { username: 'it_admin', roles: ['super_admin'], employee: null },
  { username: 'it_payroll', roles: ['payroll_officer'], employee: 'E003' },
  { username: 'it_manager', roles: ['hr_manager', 'employee'], employee: 'E002' },
  { username: 'it_employee', roles: ['employee'], employee: 'E007' },
  { username: 'it_locktest', roles: ['employee'], employee: null },
  { username: 'it_staff', roles: ['hr_staff'], employee: 'E005' },
] as const;

export async function startHarness(): Promise<Harness> {
  const dir = join('.tmp', `it-${Date.now()}`); // relative to ROOT, the cwd of every child process
  mkdirSync(join(ROOT, dir), { recursive: true });
  const persist = join(dir, 'state');
  wrangler(['d1', 'migrations', 'apply', 'hr-system-db', '--local', '--persist-to', persist]);
  wrangler(['d1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', 'seeds/demo.sql']);

  const passwords = {} as Harness['passwords'];
  for (const u of USERS) {
    const pw = `It-${randomBytes(9).toString('base64url')}-9a`;
    passwords[u.username] = pw;
    const out = join(dir, `${u.username}.sql`);
    const args = ['scripts/create-user.mjs', '--username', u.username, '--display', u.username, '--out', out, '--cred-file', join(dir, 'credentials.txt')];
    for (const r of u.roles) args.push('--role', r);
    if (u.employee) args.push('--employee', u.employee);
    execFileSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, NEW_USER_PASSWORD: pw }, stdio: 'ignore' });
    wrangler(['d1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', out]);
  }

  const sqlEach = (command: string) => {
    const file = join(dir, `q-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`);
    writeFileSync(join(ROOT, file), command);
    const raw = wrangler(['d1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', file, '--json']);
    const parsed = JSON.parse(raw.slice(raw.indexOf('['))) as Array<{ results: Array<Record<string, unknown>> }>;
    return parsed.map((p) => p.results ?? []);
  };
  const sql = (command: string) => sqlEach(command).flat();

  // a port the OS reports free: parallel test files must never share (or probe) another file's server
  const port = await new Promise<number>((res, rej) => {
    const srv = createServer().once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as { port: number }).port;
      srv.close(() => res(p));
    });
  });
  const key = randomBytes(32).toString('base64');
  const child: ChildProcess = spawn(
    process.execPath,
    [WRANGLER, 'dev', '--local', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persist, '--var', `MFA_ENCRYPTION_KEY:${key}`, '--show-interactive-dev-session=false', '--log-level', 'warn'],
    { cwd: ROOT, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  child.stdout?.on('data', (d) => (log += String(d)));
  child.stderr?.on('data', (d) => (log += String(d)));
  // diagnostics only: if the dev server dies or logs an error mid-run, the reason reaches the test output
  let stopping = false;
  child.on('exit', (code) => {
    if (!stopping) process.stderr.write(`[harness] wrangler dev (port ${port}) exited unexpectedly, code ${code}:
${log.slice(-4000)}
`);
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const started = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${baseUrl}/api/health`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() - started > 120_000 || child.exitCode !== null) throw new Error(`wrangler dev did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 500));
  }

  const r2Has = (key: string) => {
    try {
      wrangler(['r2', 'object', 'get', `hr-system-employee-assets/${key}`, '--local', '--persist-to', persist, '--file', join(dir, 'r2-probe.bin')]);
      return true;
    } catch {
      return false;
    }
  };

  return {
    baseUrl,
    dir,
    passwords,
    sql,
    sqlEach,
    r2Has,
    stop: async () => {
      stopping = true;
      if (/error|exception|crash/i.test(log)) process.stderr.write(`[harness] wrangler dev (port ${port}) logged:
${log.slice(-4000)}
`);
      if (child.pid) {
        if (process.platform === 'win32') {
          try {
            execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
          } catch {
            /* already gone */
          }
        } else child.kill('SIGTERM');
      }
      await new Promise((r) => setTimeout(r, 1000));
      try {
        rmSync(join(ROOT, dir), { recursive: true, force: true });
      } catch {
        /* files may still be locked on Windows */
      }
    },
  };
}

export interface Res<T = any> {
  status: number;
  body: T;
  text: string;
  headers: Headers;
}

/** Minimal cookie-keeping API client. */
export class Client {
  cookie = '';
  totpSecret: string | null = null;
  constructor(private readonly baseUrl: string) {}

  async req<T = any>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<Res<T>> {
    const headers: Record<string, string> = { ...extraHeaders };
    if (this.cookie) headers.cookie = this.cookie;
    if (method !== 'GET' && !('x-hr-requested' in extraHeaders)) headers['x-hr-requested'] = '1';
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(this.baseUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) {
      const m = /hr_session=([^;]*)/.exec(set);
      if (m) this.cookie = m[1] ? `hr_session=${m[1]}` : '';
    }
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, body: parsed as T, text, headers: res.headers };
  }
  get<T = any>(path: string) {
    return this.req<T>('GET', path);
  }
  post<T = any>(path: string, body?: unknown) {
    return this.req<T>('POST', path, body ?? {});
  }
  put<T = any>(path: string, body: unknown) {
    return this.req<T>('PUT', path, body);
  }
  del<T = any>(path: string) {
    return this.req<T>('DELETE', path);
  }
  /** raw binary request (e.g. an image upload); returns the bytes too */
  async bytes(method: string, path: string, data?: Uint8Array, contentType?: string, extraHeaders: Record<string, string> = {}): Promise<Res & { raw: Uint8Array }> {
    const headers: Record<string, string> = { ...extraHeaders };
    if (this.cookie) headers.cookie = this.cookie;
    if (method !== 'GET' && !('x-hr-requested' in extraHeaders)) headers['x-hr-requested'] = '1';
    if (contentType) headers['content-type'] = contentType;
    const res = await fetch(this.baseUrl + path, { method, headers, body: data?.slice(), redirect: 'manual' });
    const raw = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder().decode(raw);
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* binary */
    }
    return { status: res.status, body, text, headers: res.headers, raw };
  }

  /** Logs in; enrols MFA when the policy requires it, then uses TOTP on later logins. */
  async login(username: string, password: string): Promise<Res> {
    let r = await this.post('/api/auth/login', { username, password });
    if (r.body?.status === 'mfa_required') {
      r = await this.post('/api/auth/login', { username, password, totp: await totpCode(this.totpSecret as string) });
    }
    if (r.body?.status === 'mfa_enroll_required') {
      const setup = await this.post('/api/security/mfa/setup');
      this.totpSecret = setup.body.secret;
      const enable = await this.post('/api/security/mfa/enable', { code: await totpCode(this.totpSecret as string) });
      if (enable.status !== 200) throw new Error(`MFA enable failed: ${enable.text}`);
    }
    return r;
  }
}

export function readCreds(dir: string): string {
  return readFileSync(join(ROOT, dir, 'credentials.txt'), 'utf8');
}
