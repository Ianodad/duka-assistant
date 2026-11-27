/**
 * MOCK MODE ONLY test control: resolves a pending mock order as paid, failed
 * or cancelled by feeding a synthetic STK callback through the same apply path
 * as /api/daraja/callback. Returns 404 in sandbox mode. It never starts an STK push.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { darajaMode } from '@/lib/daraja';
import { getOrderForSession } from '@/lib/shop/orders';
import { applyResult } from '@/lib/shop/reconcile';
import { sidFromCookieHeader } from '@/lib/shop/session';

export const dynamic = 'force-dynamic';

const CODES = { paid: 0, failed: 1, cancelled: 1032 } as const;

export async function POST(req: NextRequest) {
  let mode: string;
  try {
    mode = darajaMode();
  } catch {
    mode = 'invalid';
  }
  if (mode !== 'mock') return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  let b: Record<string, unknown> = {};
  try {
    const raw = (await req.json()) as unknown;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) b = raw as Record<string, unknown>;
  } catch {
    /* empty */
  }
  const outcome = b.outcome;
  if (outcome !== 'paid' && outcome !== 'failed' && outcome !== 'cancelled') return NextResponse.json({ error: 'outcome must be paid, failed or cancelled.' }, { status: 400 });
  const order = typeof b.orderId === 'string' ? getOrderForSession(b.orderId, sidFromCookieHeader(req.headers.get('cookie'))) : undefined;
  if (!order || !order.checkoutRequestId) return NextResponse.json({ error: 'Order not found.' }, { status: 404 });
  const r = applyResult({ checkoutRequestId: order.checkoutRequestId, resultCode: CODES[outcome], resultDesc: `Mock ${outcome}` });
  return NextResponse.json({ ok: true, changed: r.matched && r.changed });
}
