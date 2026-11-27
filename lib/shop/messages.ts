/**
 * Shopper-facing text for terminal and unconfirmed orders. Provider text
 * (Daraja ResultDesc) is never shown to the shopper; it may contain anything.
 */
import type { OrderState } from '@/lib/shop/order-state';

export const UNCONFIRMED_MESSAGE =
  'We could not confirm whether the M-Pesa prompt reached your phone. Please do not pay again. If you approved a payment, contact the shop with this order number so it can be matched by hand.';
export const PROMPT_NOT_SENT_MESSAGE = 'We could not send the M-Pesa prompt. Nothing was charged and your cart is unchanged; please try again.';

export function shopperReason(state: OrderState, resultCode?: number, initiation?: 'sent' | 'rejected' | 'unconfirmed'): string | undefined {
  if (initiation === 'unconfirmed' && state === 'pending') return UNCONFIRMED_MESSAGE;
  if (initiation === 'rejected') return PROMPT_NOT_SENT_MESSAGE;
  if (state === 'cancelled') return 'The prompt was cancelled on the phone. Nothing was charged.';
  if (state !== 'failed') return undefined;
  switch (resultCode) {
    case 1:
      return 'The M-Pesa balance was not enough for this payment.';
    case 1037:
      return 'The phone could not be reached in time. Nothing was charged.';
    case 2001:
      return 'The M-Pesa PIN was not accepted. Nothing was charged.';
    default:
      return 'M-Pesa did not complete the payment. Nothing was charged.';
  }
}
