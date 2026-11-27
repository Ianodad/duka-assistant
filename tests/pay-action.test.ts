/** AC-5: payAction requires same origin, a valid single-use token, a valid phone, and computes the amount server side. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SID_A, SID_B, spyAdapter } from './helpers';

const spy = spyAdapter();
vi.mock('@/lib/daraja', async (orig) => ({ ...(await orig<typeof import('@/lib/daraja')>()), getAdapter: () => spy.adapter }));

let sid: string | undefined = SID_A;
let hdrs: Record<string, string> = {};
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'duka_sid' && sid ? { name: n, value: sid } : undefined) }),
  headers: async () => new Headers(hdrs),
}));
vi.mock('next/navigation', () => ({
  redirect: (u: string) => {
    throw new Error(`NEXT_REDIRECT ${u}`);
  },
}));

const { payAction } = await import('@/app/checkout/actions');
const { addItem, clearCart, viewCart, cartSignature, getItems } = await import('@/lib/shop/cart');
const { issueCheckoutToken } = await import('@/lib/shop/checkout-token');
const { getOrder } = await import('@/lib/shop/orders');

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
const freshToken = (s = SID_A) => issueCheckoutToken(s, cartSignature(getItems(s)));

beforeEach(() => {
  spy.initiateStk.mockClear();
  sid = SID_A;
  hdrs = { host: 'localhost:3200', origin: 'http://localhost:3200' };
  clearCart(SID_A);
  clearCart(SID_B);
  addItem(SID_A, 'unga-2kg', 2);
  addItem(SID_A, 'ketepa-100', 1);
});

describe('payAction', () => {
  it('happy path: one STK push with the server-computed amount, then redirect to the order', async () => {
    const token = freshToken();
    const err = await payAction({}, fd({ checkoutToken: token, phone: '0712 345 678', amount: '1', amountKES: '1' })).catch((e: Error) => e);
    expect(String(err)).toMatch(/NEXT_REDIRECT \/orders\/ord_/);
    expect(spy.initiateStk).toHaveBeenCalledTimes(1);
    expect(spy.initiateStk.mock.calls[0]).toEqual([{ amountKES: 590, phone: '254712345678', accountReference: 'Duka', description: 'Duka order' }]);
    const orderId = String(err).split('/orders/')[1];
    expect(getOrder(orderId)).toMatchObject({ state: 'pending', amountKES: 590 });
    expect(viewCart(SID_A).lines).toHaveLength(0);
  });

  it('replaying the same token (double tap) does not push again', async () => {
    const token = freshToken();
    await payAction({}, fd({ checkoutToken: token, phone: '0712345678' })).catch(() => {});
    addItem(SID_A, 'unga-2kg', 1);
    const r = await payAction({}, fd({ checkoutToken: token, phone: '0712345678' }));
    expect(r.error).toMatch(/expired or was already used/);
    expect(spy.initiateStk).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing origin', { host: 'localhost:3200' }],
    ['cross origin', { host: 'localhost:3200', origin: 'https://evil.example' }],
    ['malformed origin', { host: 'localhost:3200', origin: 'null' }],
  ])('refuses %s', async (_n, h) => {
    hdrs = h as Record<string, string>;
    const r = await payAction({}, fd({ checkoutToken: freshToken(), phone: '0712345678' }));
    expect(r.error).toMatch(/did not come from the Duka checkout/);
    expect(spy.initiateStk).not.toHaveBeenCalled();
  });

  it('refuses without a token, with a forged token, or a token from another session', async () => {
    expect((await payAction({}, fd({ phone: '0712345678' }))).error).toBeTruthy();
    expect((await payAction({}, fd({ checkoutToken: 'forged', phone: '0712345678' }))).error).toBeTruthy();
    addItem(SID_B, 'unga-2kg', 2);
    addItem(SID_B, 'ketepa-100', 1);
    const other = freshToken(SID_B);
    expect((await payAction({}, fd({ checkoutToken: other, phone: '0712345678' }))).error).toBeTruthy();
    expect(spy.initiateStk).not.toHaveBeenCalled();
  });

  it('refuses when the cart changed after the token was issued', async () => {
    const token = freshToken();
    addItem(SID_A, 'sukuma-bunch', 1);
    const r = await payAction({}, fd({ checkoutToken: token, phone: '0712345678' }));
    expect(r.error).toMatch(/cart changed/);
    expect(spy.initiateStk).not.toHaveBeenCalled();
  });

  it('invalid phone: clear field error, token not consumed, no push', async () => {
    const token = freshToken();
    const r = await payAction({}, fd({ checkoutToken: token, phone: '0812 345' }));
    expect(r).toMatchObject({ error: expect.stringMatching(/Safaricom number/), field: 'phone', phone: '0812 345' });
    expect(spy.initiateStk).not.toHaveBeenCalled();
    await payAction({}, fd({ checkoutToken: token, phone: '0712345678' })).catch(() => {});
    expect(spy.initiateStk).toHaveBeenCalledTimes(1);
  });

  it('refuses with no session or an empty cart', async () => {
    sid = undefined;
    expect((await payAction({}, fd({ checkoutToken: 'x', phone: '0712345678' }))).error).toMatch(/session/);
    sid = SID_B;
    expect((await payAction({}, fd({ checkoutToken: 'x', phone: '0712345678' }))).error).toMatch(/empty/);
    expect(spy.initiateStk).not.toHaveBeenCalled();
  });

  it('unknown outcome (non-Daraja error or timeout): order stays pending, cart stays reserved, no retry invited', async () => {
    spy.initiateStk.mockRejectedValueOnce(new Error('socket hang up'));
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const err = await payAction({}, fd({ checkoutToken: freshToken(), phone: '0712345678' })).catch((e: Error) => e);
    const orderId = String(err).split('/orders/')[1];
    expect(getOrder(orderId)).toMatchObject({ state: 'pending', initiation: 'unconfirmed' });
    expect(viewCart(SID_A).lines).toHaveLength(0);
    const { DarajaError, STK_UNCONFIRMED } = await import('@/lib/daraja/types');
    addItem(SID_A, 'unga-2kg', 1);
    spy.initiateStk.mockRejectedValueOnce(new DarajaError('timeout', STK_UNCONFIRMED));
    const err2 = await payAction({}, fd({ checkoutToken: freshToken(), phone: '0712345678' })).catch((e: Error) => e);
    expect(getOrder(String(err2).split('/orders/')[1])).toMatchObject({ state: 'pending', initiation: 'unconfirmed' });
  });

  it('definitive rejection: order failed and the items go back into the cart', async () => {
    const { DarajaError } = await import('@/lib/daraja/types');
    spy.initiateStk.mockRejectedValueOnce(new DarajaError('rejected', 'stk_rejected'));
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const err = await payAction({}, fd({ checkoutToken: freshToken(), phone: '0712345678' })).catch((e: Error) => e);
    const orderId = String(err).split('/orders/')[1];
    expect(getOrder(orderId)).toMatchObject({ state: 'failed', initiation: 'rejected' });
    expect(viewCart(SID_A).subtotalKES).toBe(590);
  });

  it('two tabs submitting at once: only one STK push (cart reserved before awaiting Daraja)', async () => {
    const t1 = freshToken();
    const t2 = freshToken();
    let release!: () => void;
    spy.initiateStk.mockImplementationOnce(
      () => new Promise((res) => (release = () => res({ checkoutRequestId: 'ws_CO_SLOW', merchantRequestId: 'm' }))),
    );
    const first = payAction({}, fd({ checkoutToken: t1, phone: '0712345678' })).catch((e: Error) => e);
    const second = await payAction({}, fd({ checkoutToken: t2, phone: '0712345678' }));
    expect(second.error).toBeTruthy();
    release();
    expect(String(await first)).toMatch(/NEXT_REDIRECT/);
    expect(spy.initiateStk).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['http origin for a non-local host (scheme mismatch)', { host: 'shop.example', origin: 'http://shop.example' }, undefined, false],
    ['https origin for a non-local host', { host: 'shop.example', origin: 'https://shop.example' }, undefined, true],
    ['forwarded proto http but https origin', { host: 'shop.example', 'x-forwarded-proto': 'http', origin: 'https://shop.example' }, undefined, false],
    ['other port', { host: 'localhost:3200', origin: 'http://localhost:3201' }, undefined, false],
    ['public origin set, matching', { host: 'internal:3200', origin: 'https://duka.example' }, 'https://duka.example', true],
    ['public origin set, mismatching', { host: 'internal:3200', origin: 'http://internal:3200' }, 'https://duka.example', false],
    ['remote http with x-forwarded-proto http', { host: 'shop.example', 'x-forwarded-proto': 'http', origin: 'http://shop.example' }, undefined, false],
    ['remote http public origin', { host: 'shop.example', origin: 'http://shop.example' }, 'http://shop.example', false],
    ['local http is allowed', { host: 'localhost:3200', origin: 'http://localhost:3200' }, undefined, true],
  ])('origin check: %s', async (_n, h, pub, ok) => {
    hdrs = h as Record<string, string>;
    if (pub) vi.stubEnv('DUKA_PUBLIC_ORIGIN', pub);
    const r = await payAction({}, fd({ checkoutToken: freshToken(), phone: '0712345678' })).catch((e: Error) => ({ error: String(e) }));
    vi.unstubAllEnvs();
    expect(/NEXT_REDIRECT/.test(String(r.error))).toBe(ok);
    expect(spy.initiateStk).toHaveBeenCalledTimes(ok ? 1 : 0);
  });
});
