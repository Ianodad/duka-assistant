/** AC-W2-5 action allowlist, payloads, go_to_checkout navigation only; route input guards. */
import { describe, expect, it } from 'vitest';
import { ACTION_NAMES, CHECKOUT_PATH, parseAction } from '@/lib/a2ui/actions';
import { HANDLERS, runAction } from '@/lib/assistant/handlers';
import { getItems } from '@/lib/shop/cart';
import { POST as actionPOST } from '@/app/api/assistant/action/route';
import { POST as assistantPOST } from '@/app/api/assistant/route';
import { codes, one } from './a2ui-fixtures';
import { jreq } from './route-helpers';

const SID = 'sidACTIONSxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

describe('AC-W2-5 allowlist', () => {
  it('is exactly the 8 named actions, each with a server handler', () => {
    expect([...ACTION_NAMES].sort()).toEqual(['add_to_cart', 'apply_filter', 'compare', 'go_to_checkout', 'remove_from_cart', 'set_quantity', 'show_cart', 'show_order']);
    expect(Object.keys(HANDLERS).sort()).toEqual([...ACTION_NAMES].sort());
    for (const n of ACTION_NAMES) expect(n).not.toMatch(/pay|stk|mpesa|confirm/i);
  });

  it.each(['pay', 'pay_now', 'confirm_payment', 'stk_push', 'initiate_stk', 'mpesa_pay', 'place_order', 'buy_now', 'charge_card', 'Pay'])('pay-like action "%s" is rejected', (name) => {
    expect(parseAction(name, {})).toEqual({ ok: false, code: 'PAY_ACTION_REJECTED' });
  });

  it('unknown names and prototype keys are rejected', () => {
    for (const n of ['delete_all', '__proto__', 'constructor', 'toString', '', 42, null]) expect(parseAction(n, {}).ok).toBe(false);
  });

  it('payloads are validated strictly', () => {
    expect(parseAction('add_to_cart', { productId: 'unga-2kg' }).ok).toBe(true);
    expect(parseAction('add_to_cart', { productId: 'unga-2kg', qty: 3 }).ok).toBe(true);
    for (const bad of [{}, { productId: 'nope' }, { productId: 'unga-2kg', qty: 0 }, { productId: 'unga-2kg', qty: 21 }, { productId: 'unga-2kg', qty: 1.5 }, { productId: 'unga-2kg', amountKES: 1 }])
      expect(parseAction('add_to_cart', bad)).toEqual({ ok: false, code: 'BAD_ACTION_PAYLOAD' });
    expect(parseAction('apply_filter', { category: 'Phones' }).ok).toBe(false);
    expect(parseAction('compare', { productIds: ['unga-2kg'] }).ok).toBe(false);
    expect(parseAction('show_order', { orderId: 'https://evil.example' }).ok).toBe(false);
    expect(parseAction('go_to_checkout', { url: 'https://evil.example' }).ok).toBe(false);
    expect(parseAction('go_to_checkout', { path: '/admin' }).ok).toBe(false);
  });

  it('go_to_checkout only returns the /checkout path and changes nothing', () => {
    runAction(SID, { name: 'add_to_cart', payload: { productId: 'unga-2kg', qty: 2 } }, 1);
    const before = getItems(SID);
    const r = runAction(SID, { name: 'go_to_checkout', payload: {} }, 2);
    expect(r).toEqual({ reply: { key: 'opening_checkout' }, messages: [], navigate: '/checkout' });
    expect(CHECKOUT_PATH).toBe('/checkout');
    expect(getItems(SID)).toEqual(before);
  });

  it('agent-wired actions are limited per component slot', () => {
    const card = (onAdd: unknown) => one({ component: 'ProductCard', productId: 'unga-2kg', onAdd });
    expect(codes(card({ event: { name: 'add_to_cart', context: { productId: 'unga-2kg' } } }))).toEqual([]);
    expect(codes(card({ event: { name: 'go_to_checkout', context: {} } }))).toContain('ACTION_NOT_ALLOWED_HERE');
    expect(codes(card({ event: { name: 'add_to_cart', context: { productId: 'mumias-sugar-10kg' } } }))).toContain('BAD_ACTION_PAYLOAD');
    expect(codes(card({ event: { name: 'pay' } }))).toContain('PAY_ACTION_REJECTED');
    expect(codes(card({ functionCall: { call: 'openUrl', args: {} } }))).toContain('FUNCTION_CALL_REJECTED');
    expect(codes(one({ component: 'CartSummary', onCheckout: { event: { name: 'show_cart' } } }))).toContain('ACTION_NOT_ALLOWED_HERE');
    expect(codes(one({ component: 'CheckoutHandoff', onContinue: { event: { name: 'confirm_payment' } } }))).toContain('PAY_ACTION_REJECTED');
  });
});

describe('assistant routes: input guards', () => {
  it('action route: 400 for pay-like and unknown names, 200 with navigate for go_to_checkout', async () => {
    const pay = await actionPOST(jreq('/api/assistant/action', { name: 'pay', payload: {} }, { sid: SID }));
    expect(pay.status).toBe(400);
    expect(await pay.json()).toMatchObject({ code: 'PAY_ACTION_REJECTED' });
    expect((await actionPOST(jreq('/api/assistant/action', { name: 'nope' }, { sid: SID }))).status).toBe(400);
    const go = await actionPOST(jreq('/api/assistant/action', { name: 'go_to_checkout', payload: {} }, { sid: SID }));
    expect(go.status).toBe(200);
    expect(await go.json()).toMatchObject({ navigate: '/checkout', messages: [] });
  });

  it('non-JSON 415, oversized body 413, cross-origin 403, bad text 400', async () => {
    expect((await assistantPOST(jreq('/api/assistant', 'text=hi', { contentType: 'application/x-www-form-urlencoded' }))).status).toBe(415);
    expect((await assistantPOST(jreq('/api/assistant', { text: 'x'.repeat(5000) }))).status).toBe(413);
    expect((await assistantPOST(jreq('/api/assistant', { text: 'hi' }, { origin: 'https://evil.example' }))).status).toBe(403);
    expect((await assistantPOST(jreq('/api/assistant', { text: 42 }))).status).toBe(400);
    expect((await assistantPOST(jreq('/api/assistant', { text: 'x'.repeat(301) }))).status).toBe(400);
  });

  it('a new session gets the session cookie; cart snapshot is server computed', async () => {
    const r = await assistantPOST(jreq('/api/assistant', { text: 'add 2 unga', turn: 3 }));
    expect(r.headers.get('set-cookie')).toMatch(/duka_sid=/);
    const b = (await r.json()) as { cart: { subtotalKES: number; items: unknown[] } };
    expect(b.cart).toEqual({ items: [{ productId: 'unga-2kg', qty: 2 }], itemCount: 2, subtotalKES: 350 });
  });
});
