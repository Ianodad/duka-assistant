import { describe, expect, it } from 'vitest';
import { checkCheckoutToken, consumeCheckoutToken, issueCheckoutToken, TOKEN_TTL_MS } from '@/lib/shop/checkout-token';

describe('checkout token', () => {
  it('is single use, bound to session and cart, and expires', () => {
    const t = issueCheckoutToken('s1', 'a', 1000);
    expect(checkCheckoutToken(t, 's2', 'a', 1000)).toEqual({ ok: false, reason: 'session' });
    expect(checkCheckoutToken(t, 's1', 'b', 1000)).toEqual({ ok: false, reason: 'cart-changed' });
    expect(checkCheckoutToken(t, 's1', 'a', 1000 + TOKEN_TTL_MS)).toEqual({ ok: false, reason: 'expired' });
    expect(consumeCheckoutToken(t, 's1', 'a', 1001)).toEqual({ ok: true });
    expect(consumeCheckoutToken(t, 's1', 'a', 1002)).toEqual({ ok: false, reason: 'invalid' });
    expect(checkCheckoutToken(undefined, 's1', 'a')).toEqual({ ok: false, reason: 'missing' });
  });
});
