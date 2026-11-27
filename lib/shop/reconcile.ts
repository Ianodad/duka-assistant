/**
 * Read and reconcile only. Applies callbacks and status queries to orders.
 * Uses the adapter's queryStk; it has no way to start an STK push.
 */
import 'server-only';
import { getAdapter, mapResultCode } from '@/lib/daraja';
import { findByCheckoutRequestId, getOrder, markQueried, transitionOrder, type Order } from '@/lib/shop/orders';
import { dlog } from '@/lib/daraja/redact';

export const MIN_QUERY_INTERVAL_MS = 2000;

export type ParsedCallbackLike = { checkoutRequestId: string; merchantRequestId?: string; resultCode: number; resultDesc: string; receipt?: string; amount?: number };

export type ApplyResult = { matched: false } | { matched: true; changed: boolean; order: Order };

export function applyResult(input: ParsedCallbackLike): ApplyResult {
  const order = findByCheckoutRequestId(input.checkoutRequestId);
  if (!order) return { matched: false };
  // Callbacks carry both ids; they must both match what Daraja returned at initiation.
  if (input.merchantRequestId !== undefined && input.merchantRequestId !== order.merchantRequestId) {
    dlog('order.merchant_mismatch', { orderId: order.id });
    return { matched: false };
  }
  const to = mapResultCode(input.resultCode);
  // A success that reports a different amount than the order is not trusted; the order stays pending.
  if (to === 'paid' && input.amount !== undefined && input.amount !== order.amountKES) {
    dlog('order.amount_mismatch', { orderId: order.id });
    return { matched: true, changed: false, order };
  }
  const r = transitionOrder(order.id, to, { reason: input.resultDesc, resultCode: input.resultCode, receipt: input.receipt });
  dlog('order.result', { orderId: order.id, to, changed: r.changed, resultCode: input.resultCode });
  return { matched: true, changed: r.changed, order: r.order };
}

/** For a pending order, ask Daraja (or the mock) for the latest state. Throttled per order. */
export async function reconcileOrder(orderId: string, now = Date.now()): Promise<Order | undefined> {
  const order = getOrder(orderId);
  if (!order) return undefined;
  if (order.state !== 'pending' || !order.checkoutRequestId) return order;
  if (order.lastQueryAt && now - order.lastQueryAt < MIN_QUERY_INTERVAL_MS) return order;
  markQueried(order.id, now);
  try {
    const q = await getAdapter().queryStk(order.checkoutRequestId);
    if (q.state === 'final') {
      applyResult({ checkoutRequestId: order.checkoutRequestId, resultCode: q.resultCode, resultDesc: q.resultDesc });
    }
  } catch (e) {
    dlog('order.query_error', { orderId: order.id, error: e });
  }
  return getOrder(order.id);
}
