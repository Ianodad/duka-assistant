/**
 * Tool handlers for the Claude planner. Inputs are parsed with the strict zod
 * schemas in definitions.ts; bad input gets an error code, never an echo of the
 * input. Cart tools reuse the same allowlisted action handlers as the panel
 * buttons (lib/assistant/handlers.ts, week 1 cart store). Catalog data comes
 * from lib/catalog. Nothing here can pay: place_mock_order returns a checkout
 * handoff and changes nothing.
 */
import 'server-only';
import { CHECKOUT_PATH } from '@/lib/a2ui/actions';
import { PRODUCTS, getProduct, searchProducts, type Product } from '@/lib/catalog';
import { runAction } from '@/lib/assistant/handlers';
import { cartSnapshot, orderSnapshots } from '@/lib/assistant/http';
import { TOOL_INPUTS, type DataToolName } from './definitions';

export type ToolOutcome = { content: string; isError: boolean; handoff?: boolean };
/** onCartWrite runs after every successful cart change, so the planner knows the cart state its own tools left. */
type Ctx = { sid: string; turn: number; onCartWrite?: () => void; beforeCartWrite?: () => void };

const brief = (p: Product) => ({ id: p.id, name: p.name, category: p.category, priceKES: p.priceKES, unit: p.unit, inStock: p.stock > 0 });
/** Budget filter on shop prices (never on model numbers). */
const underBudget = (list: Product[], max?: number) => (max === undefined ? list : list.filter((p) => p.priceKES <= max));
const ok = (data: unknown, extra: Partial<ToolOutcome> = {}): ToolOutcome => ({ content: JSON.stringify(data), isError: false, ...extra });
const err = (code: string): ToolOutcome => ({ content: JSON.stringify({ error: code }), isError: true });

function cartChange(ctx: Ctx, call: Parameters<typeof runAction>[1]): ToolOutcome {
  ctx.beforeCartWrite?.(); // lets the planner notice a change made outside the loop before our write absorbs it
  const r = runAction(ctx.sid, call, ctx.turn);
  if (r.error) return err('cart_change_refused');
  ctx.onCartWrite?.();
  return ok({ done: true, cart: cartSnapshot(ctx.sid) });
}

const IMPL: { [K in DataToolName]: (input: never, ctx: Ctx) => ToolOutcome } = {
  search_products: (i: { query: string; maxPriceKES?: number }) => ok({ products: underBudget(searchProducts(i.query), i.maxPriceKES).slice(0, 12).map(brief) }),
  list_products: (i: { category?: string; maxPriceKES?: number }) => ok({ products: underBudget(PRODUCTS.filter((p) => !i.category || p.category === i.category), i.maxPriceKES).map(brief) }),
  get_product: (i: { productId: string }) => {
    const p = getProduct(i.productId);
    return p ? ok({ product: { ...brief(p), description: p.description } }) : err('product_not_found');
  },
  view_cart: (_i: object, ctx) => ok({ cart: cartSnapshot(ctx.sid) }),
  add_to_cart: (i: { productId: string; qty?: number }, ctx) => cartChange(ctx, { name: 'add_to_cart', payload: { productId: i.productId, qty: i.qty ?? 1 } }),
  update_cart_quantity: (i: { productId: string; qty: number }, ctx) => cartChange(ctx, { name: 'set_quantity', payload: { productId: i.productId, qty: i.qty } }),
  remove_from_cart: (i: { productId: string }, ctx) => cartChange(ctx, { name: 'remove_from_cart', payload: { productId: i.productId } }),
  place_mock_order: (_i: object, ctx) => {
    const cart = cartSnapshot(ctx.sid);
    if (cart.itemCount === 0) return err('basket_empty');
    // No order record and no payment: the shopper opens checkout and taps Pay.
    return ok({ handoff: CHECKOUT_PATH, paid: false, orderCreated: false, next: 'Render CheckoutHandoff. The shopper taps Pay on the checkout page.', cart }, { handoff: true });
  },
  list_orders: (_i: object, ctx) => ok({ orders: orderSnapshots(ctx.sid) }),
};

export function isDataTool(name: unknown): name is DataToolName {
  return typeof name === 'string' && Object.hasOwn(TOOL_INPUTS, name);
}

/** Runs one tool call. Unknown names (including any pay-like name) and invalid input are refused. */
export function runTool(name: unknown, input: unknown, ctx: Ctx): ToolOutcome {
  if (!isDataTool(name)) return err('unknown_tool');
  const parsed = TOOL_INPUTS[name].safeParse(input ?? {});
  if (!parsed.success) return err('invalid_input');
  return (IMPL[name] as (i: unknown, c: Ctx) => ToolOutcome)(parsed.data, ctx);
}
