/** Next.js can normalize nextUrl's loopback hostname. Compare Origin against
 * the actual HTTP Host authority instead; never trust forwarded-host headers. */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    const source=new URL(origin);
    const targetHost=request.headers.get('host')||new URL(request.url).host;
    return ['http:','https:'].includes(source.protocol) && source.host.toLowerCase()===targetHost.toLowerCase();
  } catch { return false; }
}
