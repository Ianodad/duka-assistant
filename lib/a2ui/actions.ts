/**
 * The fixed A2UI action allowlist. Shared by the client (before sending) and
 * the server route (before running a handler). There is no payment action:
 * the shopper pays only by tapping Pay on /checkout.
 */
import { z } from 'zod';
import { CategorySchema, OrderIdSchema, ProductIdSchema } from './ids';

const Qty = z.number().int().min(1).max(20);

export const ACTION_PAYLOADS = {
  add_to_cart: z.object({ productId: ProductIdSchema, qty: Qty.optional() }).strict(),
  set_quantity: z.object({ productId: ProductIdSchema, qty: Qty }).strict(),
  remove_from_cart: z.object({ productId: ProductIdSchema }).strict(),
  apply_filter: z.object({ category: CategorySchema }).strict(),
  compare: z.object({ productIds: z.array(ProductIdSchema).min(2).max(3) }).strict(),
  show_cart: z.object({}).strict(),
  go_to_checkout: z.object({}).strict(),
  show_order: z.object({ orderId: OrderIdSchema.optional() }).strict(),
} as const;

export type ActionName = keyof typeof ACTION_PAYLOADS;
export const ACTION_NAMES = Object.keys(ACTION_PAYLOADS) as ActionName[];
export type ActionCall = { [K in ActionName]: { name: K; payload: z.infer<(typeof ACTION_PAYLOADS)[K]> } }[ActionName];

/** The one place the client may navigate to because of an action. */
export const CHECKOUT_PATH = '/checkout';

/** Names that look like money movement. Never allowlisted; reported with their own code. */
export const PAY_LIKE = /(pay|stk|mpesa|m_pesa|charge|purchase|confirm_?payment|place_?order|submit_?order|buy_?now|checkout_?submit|initiat)/i;

export function isAllowedActionName(name: unknown): name is ActionName {
  return typeof name === 'string' && Object.hasOwn(ACTION_PAYLOADS, name);
}

export type ParsedAction = { ok: true; call: ActionCall } | { ok: false; code: 'PAY_ACTION_REJECTED' | 'UNKNOWN_ACTION' | 'BAD_ACTION_PAYLOAD' };

export function parseAction(name: unknown, payload: unknown = {}): ParsedAction {
  if (!isAllowedActionName(name)) {
    return { ok: false, code: typeof name === 'string' && PAY_LIKE.test(name) ? 'PAY_ACTION_REJECTED' : 'UNKNOWN_ACTION' };
  }
  const r = ACTION_PAYLOADS[name].safeParse(payload ?? {});
  if (!r.success) return { ok: false, code: 'BAD_ACTION_PAYLOAD' };
  return { ok: true, call: { name, payload: r.data } as ActionCall };
}

/**
 * Where an agent may wire an action in a message, and which one. Everything
 * else (stepper, chips, compare buttons) is built into the component and
 * dispatches a fixed action with ids taken from validated props.
 */
export const AGENT_ACTION_SLOTS: Record<string, Record<string, ActionName>> = {
  ProductCard: { onAdd: 'add_to_cart' },
  CheckoutHandoff: { onContinue: 'go_to_checkout' },
};
