/** The only public address. */
export const PUBLIC_ORIGIN = 'https://hr-systems.siamhrbp.com';

/** Zone whose proxied hostname forwards to this Worker's *.workers.dev URL (Cloudflare adds `cf-worker: <zone>`). */
export const FORWARDING_ZONE = 'siamhrbp.com';

/**
 * 301 to the custom domain (same path and query) for a request made directly on *.workers.dev; null otherwise.
 *
 * hr-systems.siamhrbp.com reaches this Worker through a proxied record in the siamhrbp.com zone that points at the
 * workers.dev URL: those requests arrive with the workers.dev host and `cf-worker: siamhrbp.com` (seen with
 * `wrangler tail`, 2026-11-18). They must be served, never redirected (that was a redirect loop), and workers.dev must
 * stay enabled at Cloudflare (turning it off took the main domain down).
 */
export function workersDevRedirect(req: Request): Response | null {
  const url = new URL(req.url);
  if (!url.hostname.endsWith('.workers.dev')) return null;
  if (req.headers.get('cf-worker') === FORWARDING_ZONE) return null;
  return new Response(null, { status: 301, headers: { location: PUBLIC_ORIGIN + url.pathname + url.search, 'cache-control': 'no-store' } });
}
