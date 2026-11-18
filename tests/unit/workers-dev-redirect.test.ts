// The *.workers.dev URL is not a public address: a request made on it directly is sent (301) to the custom domain.
// The custom domain itself reaches the Worker on the workers.dev host with `cf-worker: siamhrbp.com` and is served.
import { describe, expect, it } from 'vitest';
import { PUBLIC_ORIGIN, workersDevRedirect } from '../../src/shared/public-origin';

describe('workers.dev redirect', () => {
  it('redirects a direct request on *.workers.dev (any path and query) to the custom domain', () => {
    const r = workersDevRedirect(new Request('https://hr-system.siamhrbp.workers.dev/payroll/preview?period_id=12&company=3'));
    expect(r?.status).toBe(301);
    expect(r?.headers.get('location')).toBe(`${PUBLIC_ORIGIN}/payroll/preview?period_id=12&company=3`);
    const preview = workersDevRedirect(new Request('https://abc123-hr-system.siamhrbp.workers.dev/api/health'));
    expect(preview?.headers.get('location')).toBe(`${PUBLIC_ORIGIN}/api/health`);
  });
  it('serves the custom domain forwarded through the siamhrbp.com zone (no redirect loop)', () => {
    const forwarded = new Request('https://hr-system.siamhrbp.workers.dev/', { headers: { 'cf-worker': 'siamhrbp.com' } });
    expect(workersDevRedirect(forwarded)).toBeNull();
    const otherZone = new Request('https://hr-system.siamhrbp.workers.dev/', { headers: { 'cf-worker': 'example.com' } });
    expect(workersDevRedirect(otherZone)?.status).toBe(301);
  });
  it('leaves the custom domain host and local development alone', () => {
    expect(workersDevRedirect(new Request('https://hr-systems.siamhrbp.com/'))).toBeNull();
    expect(workersDevRedirect(new Request('http://127.0.0.1:8787/api/health'))).toBeNull();
  });
});
