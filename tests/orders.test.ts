import { beforeEach, describe, expect, it } from 'vitest';
import { canTransition, isTerminal, type OrderState } from '@/lib/shop/order-state';
import { _resetOrdersForTests, attachCheckout, createOrder, findByCheckoutRequestId, getOrder, getOrderForSession, transitionOrder } from '@/lib/shop/orders';
import { computeCart } from '@/lib/shop/cart';

const STATES: OrderState[] = ['pending', 'paid', 'failed', 'cancelled'];

describe('order state machine', () => {
  it('allows only pending -> paid | failed | cancelled', () => {
    for (const from of STATES)
      for (const to of STATES) {
        const allowed = from === 'pending' && to !== 'pending';
        expect(canTransition(from, to), `${from}->${to}`).toBe(allowed);
      }
  });
  it('terminal states', () => {
    expect(STATES.filter(isTerminal)).toEqual(['paid', 'failed', 'cancelled']);
  });
});

describe('order store', () => {
  beforeEach(() => _resetOrdersForTests());
  const lines = computeCart([{ productId: 'unga-2kg', qty: 2 }, { productId: 'ketepa-100', qty: 1 }]).lines;

  it('creates a pending order with a server-computed amount', () => {
    const o = createOrder({ sid: 's1', lines, phone: '254712345678' });
    expect(o.state).toBe('pending');
    expect(o.amountKES).toBe(590);
  });
  it('refuses an empty order', () => {
    expect(() => createOrder({ sid: 's1', lines: [], phone: '254712345678' })).toThrow();
  });
  it('terminal states never change and duplicates are idempotent', () => {
    const o = createOrder({ sid: 's1', lines, phone: '254712345678' });
    expect(transitionOrder(o.id, 'paid', { resultCode: 0 }).changed).toBe(true);
    expect(transitionOrder(o.id, 'paid', { resultCode: 0 }).changed).toBe(false);
    expect(transitionOrder(o.id, 'failed', { resultCode: 1 }).changed).toBe(false);
    expect(transitionOrder(o.id, 'cancelled').changed).toBe(false);
    expect(transitionOrder(o.id, 'pending').changed).toBe(false);
    expect(getOrder(o.id)?.state).toBe('paid');
  });
  it('indexes by CheckoutRequestID and refuses a second attach', () => {
    const o = createOrder({ sid: 's1', lines, phone: '254712345678' });
    attachCheckout(o.id, 'ws_CO_1', 'm1');
    expect(findByCheckoutRequestId('ws_CO_1')?.id).toBe(o.id);
    expect(() => attachCheckout(o.id, 'ws_CO_2', 'm2')).toThrow();
  });
  it('scopes reads to the owning session', () => {
    const o = createOrder({ sid: 's1', lines, phone: '254712345678' });
    expect(getOrderForSession(o.id, 's1')).toBeDefined();
    expect(getOrderForSession(o.id, 's2')).toBeUndefined();
    expect(getOrderForSession(o.id, undefined)).toBeUndefined();
  });
});
