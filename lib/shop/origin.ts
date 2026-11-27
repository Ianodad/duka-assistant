/**
 * Same-origin check for the pay action. Compares scheme, host and port.
 * DUKA_PUBLIC_ORIGIN (for example https://shop.example) wins when set.
 * Otherwise the scheme comes from x-forwarded-proto, or http only for
 * localhost / 127.0.0.1, and https for anything else. A plain-http origin is
 * only ever accepted for a local host.
 */
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function httpsOrLocal(origin: string): string | null {
  const u = new URL(origin);
  if (u.protocol === 'https:') return u.origin;
  if (u.protocol === 'http:' && LOCAL.test(u.host)) return u.origin;
  return null;
}

export function expectedOrigin(h: Headers, publicOrigin = process.env.DUKA_PUBLIC_ORIGIN): string | null {
  if (publicOrigin) {
    try {
      return httpsOrLocal(publicOrigin);
    } catch {
      return null;
    }
  }
  const host = h.get('x-forwarded-host') ?? h.get('host');
  if (!host) return null;
  const fwd = h.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const proto = fwd === 'http' || fwd === 'https' ? fwd : LOCAL.test(host) ? 'http' : 'https';
  try {
    return httpsOrLocal(`${proto}://${host}`);
  } catch {
    return null;
  }
}

export function isSameOrigin(h: Headers, publicOrigin?: string): boolean {
  const origin = h.get('origin');
  const expected = expectedOrigin(h, publicOrigin);
  if (!origin || !expected) return false;
  try {
    return new URL(origin).origin === expected;
  } catch {
    return false;
  }
}
