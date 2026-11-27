/** Opaque cart session id in an httpOnly cookie. The server store holds the cart. */
import { randomBytes } from 'node:crypto';

export const SID_COOKIE = 'duka_sid';
const SID_RE = /^[A-Za-z0-9_-]{32,64}$/;

export function newSid(): string {
  return randomBytes(24).toString('base64url');
}

export function validSid(v: string | undefined | null): string | undefined {
  return v && SID_RE.test(v) ? v : undefined;
}

export function sidFromCookieHeader(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k !== SID_COOKIE) continue;
    try {
      return validSid(decodeURIComponent(rest.join('=')));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export const SID_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
  secure: process.env.NODE_ENV === 'production' && process.env.DUKA_INSECURE_COOKIES !== '1',
  maxAge: 60 * 60 * 24 * 7,
};
