/** Cart API. Server computes totals; the client only sends product id and quantity. */
import { NextResponse, type NextRequest } from 'next/server';
import { addItem, CartError, removeItem, setQty, viewCart } from '@/lib/shop/cart';
import { newSid, SID_COOKIE, SID_COOKIE_OPTIONS, sidFromCookieHeader } from '@/lib/shop/session';

export const dynamic = 'force-dynamic';

function toJson(sid: string | undefined) {
  const v = viewCart(sid);
  return {
    items: v.lines.map((l) => ({ productId: l.product.id, name: l.product.name, unitPriceKES: l.product.priceKES, qty: l.qty, lineTotalKES: l.lineTotalKES })),
    itemCount: v.itemCount,
    subtotalKES: v.subtotalKES,
  };
}

async function body(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const b = (await req.json()) as unknown;
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function sameOriginOk(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true; // non-browser clients; the cart cannot move money
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest) {
  return NextResponse.json(toJson(sidFromCookieHeader(req.headers.get('cookie'))));
}

async function mutate(req: NextRequest, fn: (sid: string, b: Record<string, unknown>) => void) {
  if (!sameOriginOk(req)) return NextResponse.json({ error: 'Cross-origin request refused.' }, { status: 403 });
  const existing = sidFromCookieHeader(req.headers.get('cookie'));
  const sid = existing ?? newSid();
  try {
    fn(sid, await body(req));
  } catch (e) {
    if (e instanceof CartError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
  const res = NextResponse.json(toJson(sid));
  if (!existing) res.cookies.set(SID_COOKIE, sid, SID_COOKIE_OPTIONS);
  return res;
}

export function POST(req: NextRequest) {
  return mutate(req, (sid, b) => addItem(sid, b.productId, b.qty ?? 1));
}

export function PATCH(req: NextRequest) {
  return mutate(req, (sid, b) => setQty(sid, b.productId, b.qty));
}

export function DELETE(req: NextRequest) {
  return mutate(req, (sid, b) => removeItem(sid, b.productId));
}
