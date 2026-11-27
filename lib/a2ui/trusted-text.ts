/**
 * Trusted display text. The agent (planner today, a model later) never
 * supplies display text: not in component props, not in reply bubbles. It picks
 * a label KEY from a fixed set, with typed parameters (catalog ids and enums
 * only), and this module turns the key into words. So agent output cannot carry
 * an amount, a URL or any other free text ("Unga now 1/- only", "one bob", ...).
 * This is an allowlist on purpose; blocklisting currency spellings failed twice
 * (Codex week 2 review 1; REVIEW.md).
 *
 * Isomorphic: used by the validator, the server routes and the panel.
 */
import { z } from 'zod';
import { getProduct } from '@/lib/catalog';
import { CategorySchema, ProductIdSchema } from './ids';

// ---------- headings (ProductGrid.heading) ----------

export const HeadingSchema = z.discriminatedUnion('key', [
  z.object({ key: z.literal('search_results') }).strict(),
  z.object({ key: z.literal('all_products') }).strict(),
  z.object({ key: z.literal('category'), category: CategorySchema }).strict(),
]);
export type Heading = z.infer<typeof HeadingSchema>;

export function headingText(h: Heading): string {
  switch (h.key) {
    case 'search_results':
      return 'Search results';
    case 'all_products':
      return 'On the shelves today';
    case 'category':
      return h.category;
  }
}

// ---------- reply bubbles ----------

const none = <K extends string>(key: K) => z.object({ key: z.literal(key) }).strict();
const withProduct = <K extends string>(key: K) => z.object({ key: z.literal(key), productId: ProductIdSchema }).strict();

export const ReplySchema = z.discriminatedUnion('key', [
  none('help'),
  none('refuse_pay'),
  none('refuse_pay_empty'),
  none('checkout_ready'),
  none('basket_empty'),
  none('cart_shown'),
  none('no_orders'),
  none('order_shown'),
  none('order_not_found'),
  none('compare_need_two'),
  none('compare_shown'),
  none('product_not_found'),
  none('qty_too_high'),
  none('qty_invalid'),
  none('search_found'),
  none('search_none'),
  none('price_filtered'),
  none('opening_checkout'),
  none('could_not_show'),
  none('cart_change_refused'),
  withProduct('not_in_cart'),
  withProduct('qty_set'),
  withProduct('removed'),
  withProduct('added'),
  z.object({ key: z.literal('category_shown'), category: CategorySchema }).strict(),
]);
export type Reply = z.infer<typeof ReplySchema>;

export const HELP_TEXT =
  'Try "search tea", "show flour", "compare ketepa and kericho gold", "add 2 unga", "set unga to 3", "show cart", "checkout" or "order status". I never pay for you: you tap Pay on the checkout page.';

const pname = (id: string) => getProduct(id)?.name ?? 'That product';

export function replyText(r: Reply): string {
  switch (r.key) {
    case 'help':
      return HELP_TEXT;
    case 'refuse_pay':
      return 'I cannot pay for you. Open checkout below, check the total, and tap Pay there yourself.';
    case 'refuse_pay_empty':
      return 'I cannot pay for you, and your basket is empty. Add something first.';
    case 'checkout_ready':
      return 'Here is your checkout. Tap the button to open it, then tap Pay there.';
    case 'basket_empty':
      return 'Your basket is empty. Add something first.';
    case 'cart_shown':
      return 'Here is your basket. Change quantities right on the card.';
    case 'no_orders':
      return 'You have no orders yet in this session.';
    case 'order_shown':
      return 'Here is your latest order.';
    case 'order_not_found':
      return 'I could not find that order in this session.';
    case 'compare_need_two':
      return 'Name two products, like "compare ketepa and kericho gold".';
    case 'compare_shown':
      return 'Here they are side by side. Prices come from the shop catalog.';
    case 'product_not_found':
      return 'I could not find that product.';
    case 'qty_too_high':
      return 'That is more than you can buy of one product.';
    case 'qty_invalid':
      return 'Use a whole number, like "add 2 unga".';
    case 'search_found':
      return 'Here is what I found.';
    case 'search_none':
      return 'No products match that. Pick a category instead.';
    case 'price_filtered':
      return 'Here is what fits your budget. Prices come from the shop catalog.';
    case 'opening_checkout':
      return 'Opening checkout. Check the total and tap Pay there yourself.';
    case 'could_not_show':
      return 'I could not show that.';
    case 'cart_change_refused':
      return 'That basket change was not possible.';
    case 'not_in_cart':
      return `${pname(r.productId)} is not in your basket yet.`;
    case 'qty_set':
      return `Updated ${pname(r.productId)}.`;
    case 'removed':
      return `Removed ${pname(r.productId)}.`;
    case 'added':
      return `Added ${pname(r.productId)} to your basket.`;
    case 'category_shown':
      return `Here is ${r.category}.`;
  }
}
