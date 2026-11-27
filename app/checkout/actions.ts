'use server';
/**
 * THE ONLY place in the app that starts an M-Pesa STK Push.
 * Called only by the Pay button form on /checkout. Requires:
 *   1. same-origin request (scheme, host and port; see lib/shop/origin.ts),
 *   2. a valid server-issued, single-use checkout token bound to this session and cart,
 *   3. a valid Kenyan phone number,
 *   4. a non-empty server-side cart (amount is computed here, never from the client).
 * The cart is reserved (cleared, all session tokens revoked) synchronously before
 * Daraja is called, so a second tab or a replay cannot send a second prompt.
 * tests/guard-stk.test.ts fails if any other app file references initiateStk.
 */
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAdapter } from '@/lib/daraja';
import { dlog } from '@/lib/daraja/redact';
import { DarajaError, STK_UNCONFIRMED } from '@/lib/daraja/types';
import { cartSignature, clearCart, getItems, restoreItems, viewCart } from '@/lib/shop/cart';
import { checkCheckoutToken, consumeCheckoutToken, revokeSessionTokens } from '@/lib/shop/checkout-token';
import { PROMPT_NOT_SENT_MESSAGE } from '@/lib/shop/messages';
import { attachCheckout, createOrder, markInitiation, transitionOrder } from '@/lib/shop/orders';
import { isSameOrigin } from '@/lib/shop/origin';
import { normalizeKenyanPhone } from '@/lib/shop/phone';
import { SID_COOKIE, validSid } from '@/lib/shop/session';

/** `phone` echoes the shopper's own input back so the field keeps its value after a validation error. */
export type PayState = { error?: string; field?: 'phone'; phone?: string; attempt?: number };

export async function payAction(_prev: PayState, formData: FormData): Promise<PayState> {
  const h = await headers();
  if (!isSameOrigin(h)) return { error: 'This payment request did not come from the Duka checkout page.' };

  const sid = validSid((await cookies()).get(SID_COOKIE)?.value);
  if (!sid) return { error: 'Your session has expired. Add items to your cart again.' };

  // From here to the reservation below there is no await: check, consume and reserve are atomic.
  const items = getItems(sid);
  const cart = viewCart(sid);
  if (cart.lines.length === 0 || cart.subtotalKES < 1) return { error: 'Your cart is empty.' };
  const sig = cartSignature(items);
  const token = formData.get('checkoutToken');

  const pre = checkCheckoutToken(token, sid, sig);
  if (!pre.ok) {
    return {
      error:
        pre.reason === 'cart-changed'
          ? 'Your cart changed. Reload the checkout page to review the new total, then tap Pay.'
          : 'This checkout has expired or was already used. Reload the checkout page and tap Pay again.',
    };
  }

  const phone = normalizeKenyanPhone(formData.get('phone'));
  if (!phone.ok) {
    const raw = formData.get('phone');
    return { error: phone.error, field: 'phone', phone: typeof raw === 'string' ? raw.slice(0, 20) : '', attempt: Date.now() };
  }

  if (!consumeCheckoutToken(token as string, sid, sig).ok) {
    return { error: 'This checkout was already submitted. Reload the checkout page to try again.' };
  }

  // Reserve: the order owns these items now. Other tabs see an empty cart and dead tokens.
  const order = createOrder({ sid, lines: cart.lines, phone: phone.msisdn });
  clearCart(sid);
  revokeSessionTokens(sid);

  try {
    const res = await getAdapter().initiateStk({
      amountKES: order.amountKES,
      phone: phone.msisdn,
      accountReference: 'Duka',
      description: 'Duka order',
    });
    attachCheckout(order.id, res.checkoutRequestId, res.merchantRequestId);
  } catch (e) {
    const unconfirmed = !(e instanceof DarajaError) || e.code === STK_UNCONFIRMED;
    dlog('pay.initiate_error', { orderId: order.id, unconfirmed, error: e });
    if (unconfirmed) {
      // The shopper may still receive and approve the prompt. Keep the order pending and the cart reserved; no retry.
      markInitiation(order.id, 'unconfirmed');
    } else {
      // Definitively not sent: fail the order and give the items back.
      markInitiation(order.id, 'rejected');
      transitionOrder(order.id, 'failed', { reason: PROMPT_NOT_SENT_MESSAGE });
      restoreItems(sid, items);
    }
  }
  redirect(`/orders/${order.id}`);
}
