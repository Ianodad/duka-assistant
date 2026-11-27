/**
 * Daraja STK callback. Parses and validates the body, matches by
 * CheckoutRequestID, applies the result once (idempotent). Unknown ids change
 * nothing. Optional shared secret via ?secret= when DUKA_CALLBACK_SECRET is set.
 */
import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { parseCallback } from '@/lib/daraja';
import { dlog } from '@/lib/daraja/redact';
import { applyResult } from '@/lib/shop/reconcile';

export const dynamic = 'force-dynamic';

const ACK = { ResultCode: 0, ResultDesc: 'Accepted' };

function secretOk(req: NextRequest): boolean {
  const expected = process.env.DUKA_CALLBACK_SECRET;
  if (!expected) return true;
  const got = req.nextUrl.searchParams.get('secret') ?? '';
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  if (!secretOk(req)) return NextResponse.json({ ResultCode: 1, ResultDesc: 'Forbidden' }, { status: 403 });
  const text = await req.text();
  if (text.length > 16_384) return NextResponse.json({ ResultCode: 1, ResultDesc: 'Too large' }, { status: 413 });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return NextResponse.json({ ResultCode: 1, ResultDesc: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = parseCallback(raw);
  if (!parsed.ok) return NextResponse.json({ ResultCode: 1, ResultDesc: parsed.error }, { status: 400 });
  const r = applyResult(parsed.value);
  if (!r.matched) {
    dlog('callback.unknown_checkout', { checkoutRequestId: parsed.value.checkoutRequestId });
    return NextResponse.json({ ...ACK, ResultDesc: 'Accepted (unknown CheckoutRequestID ignored)' });
  }
  return NextResponse.json(ACK);
}
