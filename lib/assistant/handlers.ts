/**
 * Server-side handlers for the A2UI action allowlist. Cart actions reuse the
 * week 1 cart store (lib/shop/cart). There is no payment handler: the
 * go_to_checkout handler changes nothing and only returns the /checkout path.
 */
import 'server-only';
import { CHECKOUT_PATH, type ActionCall, type ActionName } from '@/lib/a2ui/actions';
import type { Reply } from '@/lib/a2ui/trusted-text';
import type { A2uiMessage } from '@/lib/a2ui/validate';
import { PRODUCTS } from '@/lib/catalog';
import { addItem, CartError, removeItem, setQty } from '@/lib/shop/cart';
import { ordersForSession } from '@/lib/shop/orders';
import { cartSurface, chipsSurface, compareSurface, orderSurface, productsSurface } from '@/lib/assistant/surfaces';

export type HandlerResult = { reply: Reply; messages: A2uiMessage[]; navigate?: typeof CHECKOUT_PATH; error?: boolean };

type Handlers = { [K in ActionName]: (sid: string, payload: Extract<ActionCall, { name: K }>['payload'], turn: number) => HandlerResult };

export const HANDLERS: Handlers = {
  add_to_cart: (sid, p) => {
    addItem(sid, p.productId, p.qty ?? 1);
    return { reply: { key: 'added', productId: p.productId }, messages: [] };
  },
  set_quantity: (sid, p) => {
    setQty(sid, p.productId, p.qty);
    return { reply: { key: 'qty_set', productId: p.productId }, messages: [] };
  },
  remove_from_cart: (sid, p) => {
    removeItem(sid, p.productId);
    return { reply: { key: 'removed', productId: p.productId }, messages: [] };
  },
  apply_filter: (_sid, p, turn) => {
    const items = PRODUCTS.filter((x) => x.category === p.category);
    return { reply: { key: 'category_shown', category: p.category }, messages: [...chipsSurface(`t${turn}-chips`, p.category), ...productsSurface(`t${turn}-products`, { key: 'category', category: p.category }, items)] };
  },
  compare: (_sid, p, turn) => ({ reply: { key: 'compare_shown' }, messages: compareSurface(`t${turn}-compare`, p.productIds) }),
  show_cart: (_sid, _p, turn) => ({ reply: { key: 'cart_shown' }, messages: cartSurface(`t${turn}-cart`) }),
  go_to_checkout: () => ({ reply: { key: 'opening_checkout' }, messages: [], navigate: CHECKOUT_PATH }),
  show_order: (sid, p, turn) => {
    const orders = ordersForSession(sid, 50);
    const o = p.orderId ? orders.find((x) => x.id === p.orderId) : orders[0];
    if (!o) return { reply: { key: 'order_not_found' }, messages: [] };
    return { reply: { key: 'order_shown' }, messages: orderSurface(`t${turn}-order`, o.id) };
  },
};

export function runAction(sid: string, call: ActionCall, turn: number): HandlerResult {
  try {
    const h = HANDLERS[call.name] as (sid: string, payload: unknown, turn: number) => HandlerResult;
    return h(sid, call.payload, turn);
  } catch (e) {
    // Cart error text is ours, but replies are keys only: map every cart error to one trusted key.
    if (e instanceof CartError) return { reply: { key: 'cart_change_refused' }, messages: [], error: true };
    throw e;
  }
}
