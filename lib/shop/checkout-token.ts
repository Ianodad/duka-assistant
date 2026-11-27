/**
 * Per-checkout tokens. Issued when /checkout renders, bound to the session
 * and the cart signature, single use, short lived. payAction consumes one.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const TOKEN_TTL_MS = 15 * 60 * 1000;

type Entry = { sid: string; cartSig: string; expiresAt: number };
const g = globalThis as unknown as { __dukaTokens?: Map<string, Entry> };
const tokens: Map<string, Entry> = (g.__dukaTokens ??= new Map());

export function issueCheckoutToken(sid: string, cartSig: string, now = Date.now()): string {
  for (const [k, v] of tokens) if (v.expiresAt <= now) tokens.delete(k);
  const token = randomBytes(24).toString('base64url');
  tokens.set(token, { sid, cartSig, expiresAt: now + TOKEN_TTL_MS });
  return token;
}

export type TokenCheck = { ok: true } | { ok: false; reason: 'missing' | 'invalid' | 'expired' | 'session' | 'cart-changed' };

function eq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function checkCheckoutToken(token: unknown, sid: string, cartSig: string, now = Date.now()): TokenCheck {
  if (typeof token !== 'string' || !token) return { ok: false, reason: 'missing' };
  const e = tokens.get(token);
  if (!e) return { ok: false, reason: 'invalid' };
  if (e.expiresAt <= now) return { ok: false, reason: 'expired' };
  if (!eq(e.sid, sid)) return { ok: false, reason: 'session' };
  if (e.cartSig !== cartSig) return { ok: false, reason: 'cart-changed' };
  return { ok: true };
}

/** Atomically check and consume. Returns false if it was already used. */
export function consumeCheckoutToken(token: string, sid: string, cartSig: string, now = Date.now()): TokenCheck {
  const c = checkCheckoutToken(token, sid, cartSig, now);
  if (c.ok) tokens.delete(token);
  return c;
}

/** Revoke every outstanding token for a session (used when the cart is reserved for payment). */
export function revokeSessionTokens(sid: string): void {
  for (const [k, v] of tokens) if (v.sid === sid) tokens.delete(k);
}
