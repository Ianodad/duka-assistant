/**
 * Deterministic mock planner (DUKA_ASSISTANT_MODE=mock, the default).
 * Pure function: shopper text plus a context snapshot in, a reply, cart
 * actions to run and A2UI messages out. No network, no model, no randomness:
 * the same input always gives the same output.
 *
 * It can never pay. Money words ("pay", "mpesa", "stk") get a checkout
 * handoff card at most, and the shopper still taps Pay on /checkout.
 * Its output is validated by lib/a2ui/validate.ts like any other message.
 */
import type { ActionCall } from '@/lib/a2ui/actions';
import type { A2uiMessage } from '@/lib/a2ui/validate';
import { CATEGORIES, PRODUCTS, searchProducts, type Product } from '@/lib/catalog';
import type { Reply } from '@/lib/a2ui/trusted-text';
import type { CartSnapshot } from '@/lib/assistant/types';
import { cartSurface, chipsSurface, compareSurface, handoffSurface, orderSurface, productsSurface, stepperSurface } from '@/lib/assistant/surfaces';

export type PlannerContext = { cart: CartSnapshot; latestOrderId?: string };
export type PlannerOutput = {
  intent: string;
  /** A trusted reply key; the words are produced by replyText(), never by the planner. */
  reply: Reply;
  /** Cart changes the route runs through the same allowlisted handlers as panel buttons. */
  actions: ActionCall[];
  messages: A2uiMessage[];
};

const MONEY = /\b(pay|paying|payment|mpesa|m-pesa|stk|lipa|confirm payment|charge)\b/;

function clean(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/["'“”‘’]/g, '')
    .replace(/[?!.]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

const ALIASES: Record<string, string> = {
  unga: 'unga-2kg',
  flour: 'unga-2kg',
  sukuma: 'sukuma-bunch',
  ketepa: 'ketepa-100',
  kericho: 'kericho-gold-50',
  kimbo: 'kimbo-1kg',
  mandazi: 'mandazi-mix-1kg',
  blueband: 'blueband-500g',
  'blue band': 'blueband-500g',
  royco: 'royco-200g',
  omo: 'omo-1kg',
  sugar: 'mumias-sugar-10kg',
  mumias: 'mumias-sugar-10kg',
  milk: 'brookside-milk-500ml',
  brookside: 'brookside-milk-500ml',
  crisps: 'tropical-heat-crisps',
};

export function findProduct(name: string): Product | undefined {
  const q = name.replace(/^(the|a|an|some)\s+/, '').trim();
  if (!q) return undefined;
  for (const [alias, id] of Object.entries(ALIASES)) if (q === alias || q.startsWith(`${alias} `)) return PRODUCTS.find((p) => p.id === id);
  return PRODUCTS.find((p) => p.id === q || p.name.toLowerCase().includes(q));
}

function findCategory(word: string): string | undefined {
  const q = word.trim();
  return CATEGORIES.find((c) => c.toLowerCase() === q || `${c.toLowerCase()}s` === q);
}

function qtyIn(cart: CartSnapshot, id: string): number {
  return cart.items.find((i) => i.productId === id)?.qty ?? 0;
}

export function plan(rawText: string, ctx: PlannerContext, turn: number): PlannerOutput {
  const text = clean(rawText);
  const sid = (kind: string) => `t${turn}-${kind}`;
  const none = { actions: [] as ActionCall[] };

  if (!text || /^(help|hi|hello|habari|jambo|menu|what can you do)\b/.test(text)) {
    return { intent: 'help', reply: { key: 'help' }, ...none, messages: chipsSurface(sid('chips')) };
  }

  // Never pay. Offer the handoff; the shopper taps Pay on /checkout.
  if (MONEY.test(text)) {
    const reply: Reply = { key: ctx.cart.itemCount > 0 ? 'refuse_pay' : 'refuse_pay_empty' };
    return { intent: 'refuse_pay', reply, ...none, messages: ctx.cart.itemCount > 0 ? handoffSurface(sid('handoff')) : [] };
  }

  if (/^(checkout|check out|go to checkout|start checkout|proceed to checkout|i am done|done)$/.test(text)) {
    if (ctx.cart.itemCount === 0) return { intent: 'checkout', reply: { key: 'basket_empty' }, ...none, messages: chipsSurface(sid('chips')) };
    return { intent: 'checkout', reply: { key: 'checkout_ready' }, ...none, messages: handoffSurface(sid('handoff')) };
  }

  if (/^((show|view|see|open)( me)?( my| the)? )?(cart|basket)$|^my (cart|basket)$/.test(text)) {
    return { intent: 'show_cart', reply: { key: ctx.cart.itemCount ? 'cart_shown' : 'basket_empty' }, ...none, messages: cartSurface(sid('cart')) };
  }

  if (/^(order status|my order|track( my)? order|where is my order|show( my)? order)$/.test(text)) {
    if (!ctx.latestOrderId) return { intent: 'order_status', reply: { key: 'no_orders' }, ...none, messages: [] };
    return { intent: 'order_status', reply: { key: 'order_shown' }, ...none, messages: orderSurface(sid('order'), ctx.latestOrderId) };
  }

  const cmp = text.match(/^compare\s+(?:between\s+)?(.+)$/);
  if (cmp) {
    const names = cmp[1].split(/\s+(?:and|vs|versus|with)\s+|\s*,\s*/).filter(Boolean);
    const ids: string[] = [];
    for (const n of names) {
      const p = findProduct(n);
      if (p && !ids.includes(p.id)) ids.push(p.id);
    }
    if (ids.length < 2) return { intent: 'compare', reply: { key: 'compare_need_two' }, ...none, messages: [] };
    return { intent: 'compare', reply: { key: 'compare_shown' }, ...none, messages: compareSurface(sid('compare'), ids) };
  }

  const set = text.match(/^(?:set|change|make|update)\s+(.+?)\s+(?:qty |quantity )?to\s+(\d{1,3})$/);
  if (set) {
    const p = findProduct(set[1]);
    if (!p) return { intent: 'set_quantity', reply: { key: 'product_not_found' }, ...none, messages: [] };
    if (qtyIn(ctx.cart, p.id) === 0) return { intent: 'set_quantity', reply: { key: 'not_in_cart', productId: p.id }, ...none, messages: [] };
    const qty = Number(set[2]);
    if (qty === 0) return { intent: 'remove', reply: { key: 'removed', productId: p.id }, actions: [{ name: 'remove_from_cart', payload: { productId: p.id } }], messages: cartSurface(sid('cart')) };
    if (qty > 20) return { intent: 'set_quantity', reply: { key: 'qty_too_high' }, ...none, messages: stepperSurface(sid('stepper'), p.id) };
    return { intent: 'set_quantity', reply: { key: 'qty_set', productId: p.id }, actions: [{ name: 'set_quantity', payload: { productId: p.id, qty } }], messages: cartSurface(sid('cart')) };
  }

  const rm = text.match(/^(?:remove|delete|take out)\s+(.+?)(?:\s+from\s+(?:my\s+|the\s+)?(?:cart|basket))?$/);
  if (rm) {
    const p = findProduct(rm[1]);
    if (!p || qtyIn(ctx.cart, p.id) === 0) return { intent: 'remove', reply: { key: 'product_not_found' }, ...none, messages: [] };
    return { intent: 'remove', reply: { key: 'removed', productId: p.id }, actions: [{ name: 'remove_from_cart', payload: { productId: p.id } }], messages: cartSurface(sid('cart')) };
  }

  const add = text.match(/^(?:add|put)\s+(?:(\d{1,3})\s*(?:x\s+)?)?(.+?)(?:\s+(?:to|in|into)\s+(?:my\s+|the\s+)?(?:cart|basket))?$/);
  if (add) {
    const p = findProduct(add[2]);
    const qty = add[1] === undefined ? 1 : Number(add[1]);
    if (!p) return { intent: 'add', reply: { key: 'product_not_found' }, ...none, messages: [] };
    if (qty < 1 || qty > 20) return { intent: 'add', reply: { key: 'qty_invalid' }, ...none, messages: [] };
    return { intent: 'add', reply: { key: 'added', productId: p.id }, actions: [{ name: 'add_to_cart', payload: { productId: p.id, qty } }], messages: cartSurface(sid('cart')) };
  }

  const cat = text.match(/^(?:show|browse|category|show me|list)\s+(?:the\s+)?(?:category\s+)?(.+)$/);
  const catName = findCategory(cat ? cat[1] : text);
  if (catName) {
    const items = PRODUCTS.filter((p) => p.category === catName);
    return {
      intent: 'category',
      reply: { key: 'category_shown', category: catName },
      ...none,
      messages: [...chipsSurface(sid('chips'), catName), ...productsSurface(sid('products'), { key: 'category', category: catName }, items)],
    };
  }

  const search = text.match(/^(?:search(?: for)?|find|look for|do you have|i want|i need|show)\s+(?:some\s+)?(.+)$/);
  const query = (search ? search[1] : text).slice(0, 60);
  const found = searchProducts(query);
  const single = found.length === 0 ? findProduct(query) : undefined;
  const results = single ? [single] : found;
  if (results.length === 0) {
    return { intent: 'search', reply: { key: 'search_none' }, ...none, messages: chipsSurface(sid('chips')) };
  }
  // The heading never echoes the shopper's words: it is a trusted label key.
  return { intent: 'search', reply: { key: 'search_found' }, ...none, messages: productsSurface(sid('products'), { key: 'search_results' }, results) };
}
