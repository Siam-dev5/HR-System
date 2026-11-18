// The *.workers.dev URL is not a public address: every request on it is sent (301) to the custom domain.
import { describe, expect, it } from 'vitest';
import { PUBLIC_ORIGIN, workersDevRedirect } from '../../src/shared/public-origin';

describe('workers.dev redirect', () => {
  it('redirects any path and query on *.workers.dev to the custom domain', () => {
    const r = workersDevRedirect(new Request('https://hr-system.siamhrbp.workers.dev/payroll/preview?period_id=12&company=3'));
    expect(r?.status).toBe(301);
    expect(r?.headers.get('location')).toBe(`${PUBLIC_ORIGIN}/payroll/preview?period_id=12&company=3`);
    const preview = workersDevRedirect(new Request('https://abc123-hr-system.siamhrbp.workers.dev/api/health'));
    expect(preview?.headers.get('location')).toBe(`${PUBLIC_ORIGIN}/api/health`);
  });
  it('leaves the custom domain and local development alone', () => {
    expect(workersDevRedirect(new Request('https://hr-systems.siamhrbp.com/'))).toBeNull();
    expect(workersDevRedirect(new Request('http://127.0.0.1:8787/api/health'))).toBeNull();
  });
});
