/**
 * SPEC-LIVE AC-L15 to AC-L17 (Bazu QC of the live demo). Mock clients and fixtures only, zero network.
 *  - AC-L15: a reply that promises a checkout button needs a CheckoutHandoff; the handoff always renders its button;
 *    empty basket gets fixed copy and no button promise.
 *  - AC-L16: FilterChips derived server-side from the products shown in the same render; model chips ignored;
 *    no grid means no chips.
 *  - AC-L17: request shape env overrides (thinking off, max tokens lower-only, prompt cache), conservative cached
 *    estimate, latency numbers in the loop result and trace, same-turn cart write + render with rollback rules.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type Anthropic from '@anthropic-ai/sdk';
import { validateA2ui } from '@/lib/a2ui/validate';
import { BUTTON_PROMISE_REPLIES, buildRequest, deriveChips, mapRender, runToolLoop, SYSTEM_PROMPT } from '@/lib/assistant/claude/loop';
import { planWithClaude } from '@/lib/assistant/claude/planner';
import { CAPS, MIN_MAX_TOKENS, maxTokens, requestShape } from '@/lib/assistant/claude/config';
import { costFromUsage, estimateCostUSD, PRICES, traceRequest } from '@/lib/assistant/claude/spend';
import type { CreateParams, PlannerClient } from '@/lib/assistant/claude/client';
import { CheckoutHandoffView, FilterChipsView } from '@/components/assistant/views';
import { addItem, clearCart, getItems } from '@/lib/shop/cart';
import { EMPTY_CART } from '@/lib/assistant/types';
import { SID_A } from './helpers';

const MODEL = 'claude-sonnet-5-5';
const MOCK_ENV = { DUKA_PLANNER: 'claude', DUKA_PLANNER_CLIENT: 'mock', ANTHROPIC_API_KEY: '' };

type Block = { type: 'tool_use'; id: string; name: string; input: unknown } | { type: 'text'; text: string };
const message = (content: Block[], stop = 'tool_use'): Anthropic.Message =>
  ({ id: 'msg_x', type: 'message', role: 'assistant', model: MODEL, content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }) as unknown as Anthropic.Message;
const use = (id: string, name: string, input: unknown): Block => ({ type: 'tool_use', id, name, input });

/** A scripted mock: response N for request N (the last repeats). Records every request. */
function scripted(responses: Anthropic.Message[]) {
  const reqs: CreateParams[] = [];
  const client: PlannerClient = {
    kind: 'mock',
    async create(params) {
      reqs.push(structuredClone(params));
      return responses[Math.min(reqs.length, responses.length) - 1];
    },
  };
  return { client, reqs };
}

/** Components of every updateComponents message, in order. */
const comps = (messages: unknown[]) => (messages as Array<{ updateComponents?: { components: Array<Record<string, unknown>> } }>).flatMap((m) => m.updateComponents?.components ?? []);
const chipsOf = (messages: unknown[]) => comps(messages).find((c) => c.component === 'FilterChips');

beforeEach(() => clearCart(SID_A));

describe('AC-L15 checkout button promise', () => {
  it('checkout_ready and refuse_pay are rejected without a CheckoutHandoff in the same render', () => {
    for (const key of Object.keys(BUTTON_PROMISE_REPLIES)) {
      const r = mapRender({ reply: { key }, components: [{ component: 'CartSummary' }] }, 1, { cartEmpty: false });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.codes).toContain('REPLY_NEEDS_HANDOFF');
    }
  });

  it('checkout_ready with a CheckoutHandoff is accepted and always wires the go_to_checkout button', () => {
    const r = mapRender({ reply: { key: 'checkout_ready' }, components: [{ component: 'CheckoutHandoff' }] }, 1, { cartEmpty: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reply).toEqual({ key: 'checkout_ready' });
    expect(comps(r.messages)[0]).toMatchObject({ component: 'CheckoutHandoff', onContinue: { event: { name: 'go_to_checkout', context: {} } } });
  });

  it('empty basket: the reply becomes fixed empty-basket copy (no button promise), the card stays', () => {
    const a = mapRender({ reply: { key: 'checkout_ready' }, components: [{ component: 'CheckoutHandoff' }] }, 1, { cartEmpty: true });
    const b = mapRender({ reply: { key: 'refuse_pay' }, components: [{ component: 'CheckoutHandoff' }] }, 1, { cartEmpty: true });
    expect(a.ok && a.reply).toEqual({ key: 'basket_empty' });
    expect(b.ok && b.reply).toEqual({ key: 'refuse_pay_empty' });
  });

  it('the CheckoutHandoff view never omits its button; empty basket shows a disabled button plus fixed copy', () => {
    const full = renderToStaticMarkup(createElement(CheckoutHandoffView, { cart: { items: [{ productId: 'unga-2kg', qty: 1 }], itemCount: 1, subtotalKES: 175 }, onContinue: () => {} }));
    expect(full).toContain('data-testid="a2ui-go-checkout"');
    expect(full).not.toContain('a2ui-handoff-empty');
    const empty = renderToStaticMarkup(createElement(CheckoutHandoffView, { cart: EMPTY_CART, onContinue: () => {} }));
    expect(empty).toMatch(/data-testid="a2ui-go-checkout"[^>]*disabled|disabled[^>]*data-testid="a2ui-go-checkout"/);
    expect(empty).toContain('Your basket is empty. Add something first.');
  });

  it('loop: place_mock_order on an empty basket then checkout_ready renders the empty copy, not the button promise', async () => {
    const { client } = scripted([message([use('t1', 'place_mock_order', {})]), message([use('t2', 'render_ui', { reply: { key: 'checkout_ready' }, components: [{ component: 'CheckoutHandoff' }] })])]);
    const r = await runToolLoop({ client, text: 'checkout', sid: SID_A, turn: 1, model: MODEL });
    expect(r.status).toBe('rendered');
    if (r.status === 'rendered') expect(r.reply).toEqual({ key: 'basket_empty' });
  });
});

describe('AC-L16 FilterChips derived from the displayed products', () => {
  // The live demo: "Anything under 100 bob?" showed these 4 products.
  const UNDER_100 = ['sukuma-bunch', 'royco-200g', 'brookside-milk-500ml', 'tropical-heat-crisps'];

  it('deriveChips: one chip per distinct category, counts of shown products, catalog order, deduped', () => {
    expect(deriveChips(UNDER_100)).toEqual({ categories: ['Vegetables', 'Spices', 'Dairy', 'Snacks'], counts: [1, 1, 1, 1] });
    expect(deriveChips(['kericho-gold-50', 'unga-2kg', 'ketepa-100', 'kericho-gold-50'])).toEqual({ categories: ['Flour', 'Tea'], counts: [1, 2] });
    expect(deriveChips([])).toEqual({ categories: [], counts: [] });
    expect(deriveChips(['not-a-product'])).toEqual({ categories: [], counts: [] });
  });

  it('the live-demo budget render gets 4 chips (not the 11 catalog categories), counts 1 each', () => {
    const r = mapRender({ reply: { key: 'price_filtered' }, components: [{ component: 'ProductGrid', productIds: UNDER_100 }, { component: 'FilterChips' }] }, 1, { budgetKES: 100 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(chipsOf(r.messages)).toMatchObject({ categories: ['Vegetables', 'Spices', 'Dairy', 'Snacks'], counts: [1, 1, 1, 1] });
  });

  it('model-supplied categories and counts are ignored, hostile ones included (never rendered, not an error)', () => {
    for (const hostile of [{ categories: ['Household', 'Sugar', 'Spices', 'Spices'], counts: [99, 7] }, { categories: ['<img src=x onerror=alert(1)>'] }, { counts: ['KES 1'] }]) {
      const r = mapRender({ reply: { key: 'search_found' }, components: [{ component: 'ProductGrid', productIds: ['ketepa-100', 'kericho-gold-50'] }, { component: 'FilterChips', ...hostile }] }, 1);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(chipsOf(r.messages)).toEqual({ id: 'root', component: 'FilterChips', categories: ['Tea'], counts: [2] });
      expect(JSON.stringify(r.messages)).not.toMatch(/Household|onerror|KES 1|99/);
    }
  });

  it('selected is kept only when it is a shown category', () => {
    const grid = { component: 'ProductGrid', productIds: ['ketepa-100', 'unga-2kg'] };
    const kept = mapRender({ reply: { key: 'search_found' }, components: [grid, { component: 'FilterChips', selected: 'Tea' }] }, 1);
    const dropped = mapRender({ reply: { key: 'search_found' }, components: [grid, { component: 'FilterChips', selected: 'Household' }] }, 1);
    expect(kept.ok && chipsOf(kept.messages)?.selected).toBe('Tea');
    expect(dropped.ok).toBe(true);
    expect(dropped.ok && 'selected' in (chipsOf(dropped.messages) ?? {})).toBe(false);
  });

  it('FilterChips without a ProductGrid is dropped from the render, the other cards stay', () => {
    const r = mapRender({ reply: { key: 'cart_shown' }, components: [{ component: 'CartSummary' }, { component: 'FilterChips' }] }, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(comps(r.messages).map((c) => c.component)).toEqual(['CartSummary']);
    expect((r.messages as Array<{ createSurface?: unknown }>).filter((m) => m.createSurface)).toHaveLength(1);
  });

  it('a render of only FilterChips (nothing left after the drop) is an empty render, never a blank card', () => {
    const r = mapRender({ reply: { key: 'help' }, components: [{ component: 'FilterChips' }] }, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codes).toContain('RENDER_EMPTY');
  });

  it('the A2UI gate refuses duplicate chips, misaligned counts and a selected chip that is not shown', () => {
    const batch = (props: Record<string, unknown>) => [
      { version: '1.0', createSurface: { surfaceId: 's1', catalogId: 'https://duka.local/a2ui/catalog/v2' } },
      { version: '1.0', updateComponents: { surfaceId: 's1', components: [{ id: 'root', component: 'FilterChips', ...props }] } },
    ];
    expect(validateA2ui(batch({ categories: ['Tea', 'Flour'], counts: [2, 1] })).ok).toBe(true);
    expect(validateA2ui(batch({ categories: ['Tea'] })).ok).toBe(true);
    for (const bad of [{ categories: ['Spices', 'Spices'] }, { categories: ['Tea', 'Flour'], counts: [2] }, { categories: ['Tea'], selected: 'Flour' }, { categories: ['Tea'], counts: [0] }]) {
      const v = validateA2ui(batch(bad));
      expect(v.ok).toBe(false);
    }
  });

  it('the view shows the server counts when given, whole-catalog counts otherwise (regex browse chips)', () => {
    const withCounts = renderToStaticMarkup(createElement(FilterChipsView, { categories: ['Tea'], counts: [1], onPick: () => {} }));
    expect(withCounts).toContain('data-chip-count="1"');
    const browse = renderToStaticMarkup(createElement(FilterChipsView, { categories: ['Tea'], onPick: () => {} }));
    expect(browse).toContain('data-chip-count="2"');
  });
});

describe('AC-L17 request shape env overrides (config.ts, one place)', () => {
  it('DUKA_CLAUDE_THINKING=off omits the thinking field; between_tools stays the default', () => {
    expect('thinking' in buildRequest(MODEL, [], requestShape({ DUKA_CLAUDE_THINKING: 'off' }))).toBe(false);
    expect(buildRequest(MODEL, [], requestShape({ DUKA_CLAUDE_THINKING: 'between_tools' })).thinking).toEqual({ type: 'between_tools' });
    expect(buildRequest(MODEL, [], requestShape({})).thinking).toEqual({ type: 'between_tools' });
  });

  it('DUKA_CLAUDE_MAX_TOKENS only lowers, floor 256, junk keeps the default', () => {
    expect(maxTokens({})).toBe(CAPS.maxTokens);
    expect(maxTokens({ DUKA_CLAUDE_MAX_TOKENS: '600' })).toBe(600);
    expect(maxTokens({ DUKA_CLAUDE_MAX_TOKENS: '100' })).toBe(MIN_MAX_TOKENS);
    expect(maxTokens({ DUKA_CLAUDE_MAX_TOKENS: '99999' })).toBe(CAPS.maxTokens);
    for (const junk of ['-5', '1e9', 'abc', '600.5', ' ']) expect(maxTokens({ DUKA_CLAUDE_MAX_TOKENS: junk })).toBe(CAPS.maxTokens);
    expect(buildRequest(MODEL, [], requestShape({ DUKA_CLAUDE_MAX_TOKENS: '512' })).max_tokens).toBe(512);
    expect(buildRequest(MODEL, [], { ...requestShape({}), max_tokens: 5000 }).max_tokens).toBe(CAPS.maxTokens);
  });

  it('DUKA_CLAUDE_CACHE=1 marks the system prompt block and the LAST tool only; off by default', () => {
    const off = buildRequest(MODEL, [], requestShape({}));
    expect(off.system).toBe(SYSTEM_PROMPT);
    expect(JSON.stringify(off)).not.toContain('cache_control');
    const on = buildRequest(MODEL, [], requestShape({ DUKA_CLAUDE_CACHE: '1' }));
    expect(on.system).toEqual([{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }]);
    const tools = on.tools as Array<{ name: string; cache_control?: unknown }>;
    expect(tools.filter((t) => t.cache_control)).toEqual([expect.objectContaining({ name: 'render_ui', cache_control: { type: 'ephemeral' } })]);
    // The spend guard prices cache writes at the 5-minute rate: a ttl (1h costs more) must never appear unpriced.
    expect(JSON.stringify(on)).not.toContain('ttl');
    expect(traceRequest(on)).toMatch(/ cache=on$/);
    expect(traceRequest(off)).toMatch(/ cache=off$/);
  });

  it('the cached pre-call estimate stays conservative (input priced at cache write) and actual cost comes from usage', () => {
    const msgs: Anthropic.MessageParam[] = [{ role: 'user', content: 'x'.repeat(3000) }];
    const off = buildRequest(MODEL, msgs, requestShape({}));
    const on = buildRequest(MODEL, msgs, requestShape({ DUKA_CLAUDE_CACHE: '1' }));
    const p = PRICES[MODEL];
    expect(estimateCostUSD(on)!).toBeGreaterThan(estimateCostUSD(off)!);
    // Worst case of any real cached call: every input token written to cache, every output token used. Tokens are at most
    // the UTF-8 bytes of the request (the estimator's own bound is tested independently in claude-live6.test.ts).
    const bytes = Buffer.byteLength(JSON.stringify({ system: on.system, tools: on.tools, messages: on.messages }), 'utf8');
    expect(estimateCostUSD(on)!).toBeGreaterThanOrEqual((bytes * p.cacheWrite + on.max_tokens * p.output) / 1e6 - 1e-6);
    // Settled cost prices cache write and read separately from usage.
    expect(costFromUsage(MODEL, { input: 100, output: 10, cacheCreation: 4000, cacheRead: 0 })).toBeCloseTo((100 * 2 + 10 * 10 + 4000 * 2.5) / 1e6, 6);
    expect(costFromUsage(MODEL, { input: 100, output: 10, cacheCreation: 0, cacheRead: 4000 })).toBeCloseTo((100 * 2 + 10 * 10 + 4000 * 0.2) / 1e6, 6);
  });

  it('the system prompt asks for same-turn tool + render_ui for basket answers, chips only with a grid, button keys only with a handoff', () => {
    expect(SYSTEM_PROMPT).toMatch(/SAME response/);
    expect(SYSTEM_PROMPT).toMatch(/FilterChips only go with a ProductGrid/);
    expect(SYSTEM_PROMPT).toMatch(/checkout_ready and refuse_pay promise a checkout button/);
  });
});

describe('AC-L17 latency numbers', () => {
  it('runToolLoop reports ms per model request, tool ms and total ms', async () => {
    const { client } = scripted([message([use('t1', 'search_products', { query: 'tea' })]), message([use('t2', 'render_ui', { reply: { key: 'search_found' }, components: [{ component: 'ProductGrid', productIds: ['ketepa-100'] }] })])]);
    const r = await runToolLoop({ client, text: 'tea', sid: SID_A, turn: 1, model: MODEL });
    expect(r.status).toBe('rendered');
    expect(r.timing.modelMs).toHaveLength(2);
    expect(r.timing.toolMs).toBeGreaterThanOrEqual(0);
    expect(r.timing.totalMs).toBeGreaterThanOrEqual(r.timing.modelMs[0]);
  });

  it('planner outcome line carries total_ms; DUKA_LIVE_TRACE=1 adds a numbers-only prompt line', async () => {
    const lines: string[] = [];
    const { client } = scripted([message([use('t1', 'render_ui', { reply: { key: 'cart_shown' }, components: [{ component: 'CartSummary' }] })])]);
    await planWithClaude('show my basket please', SID_A, 1, { env: { ...MOCK_ENV, DUKA_LIVE_TRACE: '1' }, client, log: (l) => lines.push(l) });
    const outcome = lines.find((l) => l.startsWith('[claude-planner]'))!;
    expect(outcome).toMatch(/outcome=rendered .* total_ms=\d+ client=/);
    const trace = lines.find((l) => l.startsWith('[claude-trace] prompt'))!;
    expect(trace).toMatch(/^\[claude-trace\] prompt model_ms=\d+ tool_ms=\d+ total_ms=\d+ requests=1$/);
    expect(lines.join('\n')).not.toContain('basket please');
    const quiet: string[] = [];
    await planWithClaude('show my basket please', SID_A, 2, { env: MOCK_ENV, client: scripted([message([use('t1', 'render_ui', { reply: { key: 'cart_shown' }, components: [{ component: 'CartSummary' }] })])]).client, log: (l) => quiet.push(l) });
    expect(quiet.some((l) => l.startsWith('[claude-trace]'))).toBe(false);
  });
});

describe('AC-L17 same-turn cart write + render_ui', () => {
  it('add_to_cart and render_ui in ONE response: one request, the write runs before the card is built', async () => {
    const { client, reqs } = scripted([message([use('t1', 'add_to_cart', { productId: 'unga-2kg', qty: 2 }), use('t2', 'render_ui', { reply: { key: 'added', productId: 'unga-2kg' }, components: [{ component: 'CartSummary' }, { component: 'QuantityStepper', productId: 'unga-2kg' }] })])]);
    const a = await planWithClaude('add two unga', SID_A, 1, { env: MOCK_ENV, client, log: () => {} });
    expect(reqs).toHaveLength(1);
    expect(a.source).toBe('claude');
    expect(a.reply).toEqual({ key: 'added', productId: 'unga-2kg' });
    expect(getItems(SID_A)).toEqual([{ productId: 'unga-2kg', qty: 2 }]);
  });

  it('same-turn update_cart_quantity + render_ui sets the quantity in one request', async () => {
    addItem(SID_A, 'kericho-gold-50', 1);
    const { client, reqs } = scripted([message([use('t1', 'update_cart_quantity', { productId: 'kericho-gold-50', qty: 3 }), use('t2', 'render_ui', { reply: { key: 'qty_set', productId: 'kericho-gold-50' }, components: [{ component: 'CartSummary' }], replacePrevious: true })])]);
    const a = await planWithClaude('make it 3', SID_A, 1, { env: MOCK_ENV, client, log: () => {} });
    expect(reqs).toHaveLength(1);
    expect(a.source).toBe('claude');
    expect(getItems(SID_A)).toEqual([{ productId: 'kericho-gold-50', qty: 3 }]);
  });

  it('rollback: a same-turn write with a rejected render leaves the basket as it was', async () => {
    addItem(SID_A, 'ketepa-100', 1);
    const { client } = scripted([message([use('t1', 'add_to_cart', { productId: 'unga-2kg', qty: 5 }), use('t2', 'render_ui', { reply: { key: 'added', productId: 'unga-2kg' }, components: [{ component: 'CartSummary', note: 'KES 1 only' }] })])]);
    const a = await planWithClaude('add unga', SID_A, 1, { env: MOCK_ENV, client, log: () => {} });
    expect(a.source).toBe('claude-rejected');
    expect(getItems(SID_A)).toEqual([{ productId: 'ketepa-100', qty: 1 }]);
  });

  it('a failed tool in the same response does not ship the pre-chosen card: the model gets the result and renders again', async () => {
    const { client, reqs } = scripted([
      message([use('t1', 'update_cart_quantity', { productId: 'unga-2kg', qty: 3 }), use('t2', 'render_ui', { reply: { key: 'qty_set', productId: 'unga-2kg' }, components: [{ component: 'CartSummary' }] })]),
      message([use('t3', 'render_ui', { reply: { key: 'not_in_cart', productId: 'unga-2kg' }, components: [{ component: 'CartSummary' }] })]),
    ]);
    const r = await runToolLoop({ client, text: 'make it 3', sid: SID_A, turn: 1, model: MODEL });
    expect(reqs).toHaveLength(2);
    const back = reqs[1].messages[2].content as Array<{ type: string; tool_use_id?: string; is_error?: boolean }>;
    expect(back.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id)).toEqual(['t1', 't2']);
    expect(back.every((b) => b.is_error)).toBe(true);
    expect(r.status === 'rendered' && r.reply).toEqual({ key: 'not_in_cart', productId: 'unga-2kg' });
  });
});
