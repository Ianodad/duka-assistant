/** AC-6/7/8 at the route level: callback mapping, unknown id, duplicates, secret, status endpoint read-only. */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SID_A, spyAdapter } from './helpers';
import type { StkQueryResult } from '@/lib/daraja/types';

const spy = spyAdapter();
vi.mock('@/lib/daraja', async (orig) => ({ ...(await orig<typeof import('@/lib/daraja')>()), getAdapter: () => spy.adapter }));

const callback = await import('@/app/api/daraja/callback/route');
const status = await import('@/app/api/orders/[id]/status/route');
const { createOrder, attachCheckout, getOrder, _resetOrdersForTests } = await import('@/lib/shop/orders');
const { computeCart } = await import('@/lib/shop/cart');

const body = (id: string, rc: number) => ({ Body: { stkCallback: { MerchantRequestID: 'm', CheckoutRequestID: id, ResultCode: rc, ResultDesc: `code ${rc}` } } });
const post = (b: unknown, qs = '') =>
  callback.POST(new NextRequest(`http://localhost:3200/api/daraja/callback${qs}`, { method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } }));
let n = 0;
function pendingOrder() {
  const o = createOrder({ sid: SID_A, lines: computeCart([{ productId: 'unga-2kg', qty: 1 }]).lines, phone: '254712345678' });
  const id = `ws_CO_T${++n}`;
  attachCheckout(o.id, id, 'm');
  return { orderId: o.id, cid: id };
}

beforeEach(() => {
  _resetOrdersForTests();
  vi.unstubAllEnvs();
  spy.initiateStk.mockClear();
  spy.queryStk.mockReset();
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('callback route', () => {
  it.each([
    [0, 'paid'],
    [1032, 'cancelled'],
    [1, 'failed'],
    [2001, 'failed'],
    [1037, 'failed'],
  ])('ResultCode %i -> %s with 200 JSON ack', async (rc, state) => {
    const { orderId, cid } = pendingOrder();
    const res = await post(body(cid, rc));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ResultCode: 0 });
    expect(getOrder(orderId)?.state).toBe(state);
  });

  it('unknown CheckoutRequestID changes nothing and still acks', async () => {
    const { orderId } = pendingOrder();
    const res = await post(body('ws_CO_UNKNOWN', 0));
    expect(res.status).toBe(200);
    expect(getOrder(orderId)?.state).toBe('pending');
  });

  it('duplicate and conflicting callbacks do not change a terminal order', async () => {
    const { orderId, cid } = pendingOrder();
    await post(body(cid, 0));
    const before = getOrder(orderId);
    await post(body(cid, 0));
    await post(body(cid, 1032));
    await post(body(cid, 1));
    expect(getOrder(orderId)).toEqual(before);
  });

  it('a success callback with a different Amount does not mark the order paid', async () => {
    const { orderId, cid } = pendingOrder();
    const b = body(cid, 0);
    (b.Body.stkCallback as Record<string, unknown>).CallbackMetadata = { Item: [{ Name: 'Amount', Value: 1 }] };
    expect((await post(b)).status).toBe(200);
    expect(getOrder(orderId)?.state).toBe('pending');
    (b.Body.stkCallback as Record<string, unknown>).CallbackMetadata = { Item: [{ Name: 'Amount', Value: 175 }] };
    await post(b);
    expect(getOrder(orderId)?.state).toBe('paid');
  });

  it('a callback whose MerchantRequestID does not match is ignored', async () => {
    const { orderId, cid } = pendingOrder();
    const b = body(cid, 0);
    b.Body.stkCallback.MerchantRequestID = 'other-merchant';
    expect((await post(b)).status).toBe(200);
    expect(getOrder(orderId)?.state).toBe('pending');
  });

  it('malformed CallbackMetadata (string Amount, bad receipt) is rejected', async () => {
    const { orderId, cid } = pendingOrder();
    for (const items of [
      [{ Name: 'Amount', Value: '175' }],
      [{ Name: 'MpesaReceiptNumber', Value: 12 }],
      [{ Value: 175 }],
      [{ Name: 'Amount', Value: 1 }, { Name: 'Amount', Value: 175 }],
      [{ Name: 'MpesaReceiptNumber', Value: 'ABC123XYZ' }, { Name: 'MpesaReceiptNumber', Value: 'ABC123XYZ' }],
      'x',
    ]) {
      const b = body(cid, 0);
      (b.Body.stkCallback as Record<string, unknown>).CallbackMetadata = typeof items === 'string' ? items : { Item: items };
      expect((await post(b)).status).toBe(400);
    }
    expect(getOrder(orderId)?.state).toBe('pending');
  });

  it('bad shapes are rejected without changes', async () => {
    const { orderId, cid } = pendingOrder();
    for (const b of [{}, { Body: { stkCallback: { CheckoutRequestID: cid } } }, body(cid, 'x' as unknown as number)]) expect((await post(b)).status).toBe(400);
    expect(getOrder(orderId)?.state).toBe('pending');
  });

  it('shared secret enforced when configured', async () => {
    vi.stubEnv('DUKA_CALLBACK_SECRET', 'test-shared-secret');
    const { orderId, cid } = pendingOrder();
    expect((await post(body(cid, 0))).status).toBe(403);
    expect((await post(body(cid, 0), '?secret=wrong')).status).toBe(403);
    expect(getOrder(orderId)?.state).toBe('pending');
    expect((await post(body(cid, 0), '?secret=test-shared-secret')).status).toBe(200);
    expect(getOrder(orderId)?.state).toBe('paid');
  });
});

describe('status endpoint', () => {
  const get = (orderId: string, sid = SID_A) =>
    status.GET(new NextRequest(`http://localhost:3200/api/orders/${orderId}/status`, { headers: { cookie: `duka_sid=${sid}` } }), { params: Promise.resolve({ id: orderId }) });

  it('pending -> queries, reconciles; terminal orders are never re-queried; never initiates', async () => {
    const { orderId } = pendingOrder();
    spy.queryStk.mockResolvedValueOnce({ state: 'pending' } as StkQueryResult);
    expect(await (await get(orderId)).json()).toMatchObject({ state: 'pending' });
    expect(spy.queryStk).toHaveBeenCalledTimes(1);
    // throttled within 2s
    await get(orderId);
    expect(spy.queryStk).toHaveBeenCalledTimes(1);
  });

  it('final query result is applied once, and later queries do not change it', async () => {
    const { orderId } = pendingOrder();
    spy.queryStk.mockResolvedValue({ state: 'final', resultCode: 1032, resultDesc: 'Request cancelled by user' });
    const j = (await (await get(orderId)).json()) as { state: string; reason: string };
    expect(j).toMatchObject({ state: 'cancelled', reason: 'The prompt was cancelled on the phone. Nothing was charged.' });
    await get(orderId);
    expect(spy.queryStk).toHaveBeenCalledTimes(1);
    expect(spy.initiateStk).not.toHaveBeenCalled();
  });

  it('provider ResultDesc is never echoed to the shopper', async () => {
    const { orderId } = pendingOrder();
    spy.queryStk.mockResolvedValue({ state: 'final', resultCode: 1, resultDesc: 'leak https://x.test/cb?secret=ZZZ access_token=abc' });
    const text = await (await get(orderId)).text();
    expect(text).not.toContain('secret');
    expect(text).not.toContain('access_token');
    expect(JSON.parse(text)).toMatchObject({ state: 'failed', reason: 'The M-Pesa balance was not enough for this payment.' });
  });

  it('a query error leaves the order pending', async () => {
    const { orderId } = pendingOrder();
    spy.queryStk.mockRejectedValueOnce(new Error('network'));
    expect(await (await get(orderId)).json()).toMatchObject({ state: 'pending' });
  });
});
