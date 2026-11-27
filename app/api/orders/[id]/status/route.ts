/** Order status: read and reconcile only. It can never start an STK push. */
import { NextResponse, type NextRequest } from 'next/server';
import { getOrderForSession } from '@/lib/shop/orders';
import { reconcileOrder } from '@/lib/shop/reconcile';
import { shopperReason } from '@/lib/shop/messages';
import { sidFromCookieHeader } from '@/lib/shop/session';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const sid = sidFromCookieHeader(req.headers.get('cookie'));
  if (!getOrderForSession(id, sid)) return NextResponse.json({ error: 'Order not found.' }, { status: 404 });
  const o = await reconcileOrder(id);
  if (!o) return NextResponse.json({ error: 'Order not found.' }, { status: 404 });
  return NextResponse.json(
    { id: o.id, state: o.state, amountKES: o.amountKES, reason: shopperReason(o.state, o.resultCode, o.initiation) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
