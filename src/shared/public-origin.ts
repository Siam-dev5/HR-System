/** The only public address. The *.workers.dev URL stays enabled at Cloudflare (turning it off there also stopped the
 * custom domain from serving, 2026-11-18), so the Worker sends every request on it to this host instead. */
export const PUBLIC_ORIGIN = 'https://hr-systems.siamhrbp.com';

/** 301 to the custom domain (same path and query) for a request on *.workers.dev; null for any other host. */
export function workersDevRedirect(req: Request): Response | null {
  const url = new URL(req.url);
  if (!url.hostname.endsWith('.workers.dev')) return null;
  return new Response(null, { status: 301, headers: { location: PUBLIC_ORIGIN + url.pathname + url.search, 'cache-control': 'no-store' } });
}
