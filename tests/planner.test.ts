/** AC-W2-7 planner: deterministic, mock by default, no fetch, output passes the validator. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateA2ui } from '@/lib/a2ui/validate';
import { assistantMode, testHooksEnabled } from '@/lib/assistant/mode';
import { plan } from '@/lib/assistant/planner';
import { EMPTY_CART } from '@/lib/assistant/types';
import { POST } from '@/app/api/assistant/route';
import { jreq } from './route-helpers';

const CART = { items: [{ productId: 'unga-2kg', qty: 1 }], itemCount: 1, subtotalKES: 175 };
const CTX = { cart: CART, latestOrderId: 'ord_AAAAAAAAAAAAAAAA' };
const TEXTS: Array<[string, string]> = [
  ['search tea', 'search'],
  ['show flour', 'category'],
  ['tea', 'category'],
  ['compare ketepa and kericho gold', 'compare'],
  ['show cart', 'show_cart'],
  ['set unga to 3', 'set_quantity'],
  ['add 2 sukuma', 'add'],
  ['remove unga', 'remove'],
  ['checkout', 'checkout'],
  ['order status', 'order_status'],
  ['pay now', 'refuse_pay'],
  ['help', 'help'],
  ['xyzzy', 'search'],
];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('AC-W2-7 planner', () => {
  it.each(TEXTS)('"%s" maps to %s, deterministically, with valid A2UI', (text, intent) => {
    const a = plan(text, CTX, 7);
    const b = plan(text, CTX, 7);
    expect(a.intent).toBe(intent);
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(validateA2ui(a.messages).ok).toBe(true);
  });

  it('cart changes come out as allowlisted actions; the planner never navigates or pays', () => {
    expect(plan('set unga to 3', CTX, 1).actions).toEqual([{ name: 'set_quantity', payload: { productId: 'unga-2kg', qty: 3 } }]);
    expect(plan('add 2 sukuma', CTX, 1).actions).toEqual([{ name: 'add_to_cart', payload: { productId: 'sukuma-bunch', qty: 2 } }]);
    for (const [t] of TEXTS) for (const a of plan(t, CTX, 1).actions) expect(['add_to_cart', 'set_quantity', 'remove_from_cart']).toContain(a.name);
  });

  it('checkout with an empty cart shows no handoff', () => {
    expect(JSON.stringify(plan('checkout', { cart: EMPTY_CART }, 1).messages)).not.toContain('CheckoutHandoff');
  });

  it('default mode is mock; model is reserved; anything else is refused', () => {
    expect(assistantMode(undefined)).toBe('mock');
    expect(assistantMode('')).toBe('mock');
    expect(assistantMode('model')).toBe('model');
    expect(() => assistantMode('openai')).toThrow();
  });

  // Claude planner migration: DUKA_ASSISTANT_MODE=model no longer answers 501. It is a legacy alias of
  // DUKA_PLANNER=claude; with no live gate and no mock client that falls back to the regex planner.
  it('legacy model mode runs the claude planner, which falls back to regex here (no live call)', async () => {
    vi.stubEnv('DUKA_ASSISTANT_MODE', 'model');
    vi.stubEnv('DUKA_PLANNER', '');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const res = await POST(jreq('/api/assistant', { text: 'search tea' }));
    expect(res.status).toBe(200);
    expect((await res.json()).reply).toEqual({ key: 'search_found' });
  });

  it('the raw-message test hook needs NODE_ENV test/development, DUKA_ASSISTANT_TEST_HOOKS=1 and the regex planner', () => {
    const T = { NODE_ENV: 'test' };
    expect(testHooksEnabled({})).toBe(false);
    expect(testHooksEnabled({ DUKA_ASSISTANT_TEST_HOOKS: '1' })).toBe(false); // NODE_ENV unset: off
    expect(testHooksEnabled({ ...T, DUKA_ASSISTANT_TEST_HOOKS: '1' })).toBe(true);
    expect(testHooksEnabled({ ...T, DUKA_ASSISTANT_MODE: 'mock', DUKA_ASSISTANT_TEST_HOOKS: '1' })).toBe(true);
    expect(testHooksEnabled({ ...T, DUKA_ASSISTANT_MODE: 'model', DUKA_ASSISTANT_TEST_HOOKS: '1' })).toBe(false);
    expect(testHooksEnabled({ ...T, DUKA_ASSISTANT_MODE: 'bogus', DUKA_ASSISTANT_TEST_HOOKS: '1' })).toBe(false);
    expect(testHooksEnabled({ NODE_ENV: 'production', DUKA_ASSISTANT_TEST_HOOKS: '1' })).toBe(false);
  });

  it('no network: fetch is never called by the planner or the assistant route', async () => {
    const f = vi.spyOn(globalThis, 'fetch');
    for (const [t] of TEXTS) {
      plan(t, CTX, 1);
      expect((await POST(jreq('/api/assistant', { text: t, turn: 1 }, { sid: 'sidPLANNERxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' }))).status).toBe(200);
    }
    expect(f).not.toHaveBeenCalled();
  });
});
