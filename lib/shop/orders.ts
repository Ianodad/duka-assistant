/** In-memory order store (week 1). Amounts are computed server side from the cart. */
import { randomBytes } from 'node:crypto';
import type { CartLine } from '@/lib/shop/cart';
import { canTransition, isTerminal, type OrderState } from '@/lib/shop/order-state';

export type OrderLine = { productId: string; name: string; unitPriceKES: number; qty: number; lineTotalKES: number };

export type Order = {
  id: string;
  sid: string;
  lines: OrderLine[];
  amountKES: number;
  phone: string;
  state: OrderState;
  stateReason?: string;
  resultCode?: number;
  checkoutRequestId?: string;
  merchantRequestId?: string;
  /** sent: Daraja accepted the push; rejected: definitively not sent; unconfirmed: outcome unknown (timeout). */
  initiation?: 'sent' | 'rejected' | 'unconfirmed';
  mpesaReceipt?: string;
  createdAt: number;
  updatedAt: number;
  lastQueryAt?: number;
};

type Store = { byId: Map<string, Order>; byCheckout: Map<string, string> };
const g = globalThis as unknown as { __dukaOrders?: Store };
const store: Store = (g.__dukaOrders ??= { byId: new Map(), byCheckout: new Map() });

export function createOrder(input: { sid: string; lines: CartLine[]; phone: string; now?: number }): Order {
  const now = input.now ?? Date.now();
  const lines: OrderLine[] = input.lines.map((l) => ({
    productId: l.product.id,
    name: l.product.name,
    unitPriceKES: l.product.priceKES,
    qty: l.qty,
    lineTotalKES: l.product.priceKES * l.qty,
  }));
  const amountKES = lines.reduce((n, l) => n + l.lineTotalKES, 0);
  if (!Number.isInteger(amountKES) || amountKES < 1) throw new Error('Order amount must be a positive whole number of shillings.');
  const order: Order = {
    id: `ord_${randomBytes(12).toString('base64url')}`,
    sid: input.sid,
    lines,
    amountKES,
    phone: input.phone,
    state: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  store.byId.set(order.id, order);
  return { ...order };
}

export function getOrder(id: string): Order | undefined {
  const o = store.byId.get(id);
  return o ? { ...o, lines: o.lines.map((l) => ({ ...l })) } : undefined;
}

/** Only the session that created an order can read it. */
export function getOrderForSession(id: string, sid: string | undefined): Order | undefined {
  const o = getOrder(id);
  return o && sid && o.sid === sid ? o : undefined;
}

export function findByCheckoutRequestId(checkoutRequestId: string): Order | undefined {
  const id = store.byCheckout.get(checkoutRequestId);
  return id ? getOrder(id) : undefined;
}

export function attachCheckout(id: string, checkoutRequestId: string, merchantRequestId: string): void {
  const o = store.byId.get(id);
  if (!o) throw new Error('Unknown order.');
  if (o.checkoutRequestId) throw new Error('Order already has a checkout request.');
  o.checkoutRequestId = checkoutRequestId;
  o.merchantRequestId = merchantRequestId;
  o.initiation = 'sent';
  o.updatedAt = Date.now();
  store.byCheckout.set(checkoutRequestId, id);
}

export function markQueried(id: string, at: number): void {
  const o = store.byId.get(id);
  if (o) o.lastQueryAt = at;
}

export type TransitionResult = { changed: boolean; order: Order };

/**
 * Apply a state change. Idempotent: a terminal order is returned unchanged,
 * and only pending -> paid | failed | cancelled is allowed.
 */
export function transitionOrder(
  id: string,
  to: OrderState,
  detail: { reason?: string; resultCode?: number; receipt?: string } = {},
): TransitionResult {
  const o = store.byId.get(id);
  if (!o) throw new Error('Unknown order.');
  if (isTerminal(o.state) || !canTransition(o.state, to)) return { changed: false, order: { ...o } };
  o.state = to;
  o.stateReason = detail.reason;
  o.resultCode = detail.resultCode;
  if (detail.receipt) o.mpesaReceipt = detail.receipt;
  o.updatedAt = Date.now();
  return { changed: true, order: { ...o } };
}

export function markInitiation(id: string, initiation: 'rejected' | 'unconfirmed'): void {
  const o = store.byId.get(id);
  if (o && !o.initiation) {
    o.initiation = initiation;
    o.updatedAt = Date.now();
  }
}

/** Test helper: wipe the in-memory store. */
export function _resetOrdersForTests(): void {
  store.byId.clear();
  store.byCheckout.clear();
}

/** Newest first, this session only (week 2 assistant: order status card). Read only. */
export function ordersForSession(sid: string | undefined, limit = 3): Order[] {
  if (!sid) return [];
  return [...store.byId.values()]
    .filter((o) => o.sid === sid)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
    .map((o) => ({ ...o, lines: o.lines.map((l) => ({ ...l })) }));
}
