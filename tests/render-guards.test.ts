/**
 * Review fixes 3 and 4 plus the replacement NOTE:
 *  - the active budget applies to every product list (ProductGrid,
 *    CompareTable, QuantityStepper) whatever reply key the model picked;
 *  - an empty components array is never accepted (both schemas), gets one
 *    nudge, then falls back;
 *  - the model cannot target or replace another session's surface, or any
 *    surface id it was not given.
 * Mock clients only, zero network.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getProduct } from '@/lib/catalog';
import type { CreateParams, PlannerClient } from '@/lib/assistant/claude/client';
import { EMPTY_NUDGE_TEXT, mapRender, runToolLoop } from '@/lib/assistant/claude/loop';
import { _resetMemoryForTests, currentScreen, knownSurfaceIds } from '@/lib/assistant/claude/memory';
import { planWithClaude } from '@/lib/assistant/claude/planner';
import { RENDER_TOOL, RenderInputSchema } from '@/lib/assistant/tools/definitions';
import { respond } from '@/lib/assistant/http';
import { clearCart, getItems } from '@/lib/shop/cart';
import { SID_A, SID_B } from './helpers';
import { SLOT_NOTE_TEXT } from '@/lib/assistant/slot-notes';

const MOCK_ENV = { DUKA_PLANNER: 'claude', DUKA_PLANNER_CLIENT: 'mock' };
const log = () => {};
type Block = { type: string; id?: string; name?: string; input?: unknown; text?: string };
const msg = (content: Block[], stop = 'tool_use') => ({ id: 'm', type: 'message', role: 'assistant', model: 'm', content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }) as unknown as Anthropic.Message;
const render = (id: string, input: unknown): Block => ({ type: 'tool_use', id, name: 'render_ui', input });
/** A scripted client: answer n of the list for request n (the last repeats). Records every request. */
function scripted(answers: Block[][]): { client: PlannerClient; reqs: CreateParams[] } {
  const reqs: CreateParams[] = [];
  return {
    reqs,
    client: {
      kind: 'mock',
      create: async (p) => {
        reqs.push(structuredClone(p));
        const a = answers[Math.min(reqs.length, answers.length) - 1];
        return msg(a, a.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
      },
    },
  };
}
const created = (msgs: unknown[]) => (msgs as Array<Record<string, { surfaceId: string }>>).flatMap((m) => (m.createSurface ? [m.createSurface.surfaceId] : []));

beforeEach(() => {
  _resetMemoryForTests();
  clearCart(SID_A);
  clearCart(SID_B);
});
afterEach(() => {
  clearCart(SID_A);
  clearCart(SID_B);
});

describe('fix 3: the active budget applies to every product list, for any reply key', () => {
  const OVER = 'omo-1kg'; // KES 330
  const UNDER = 'royco-200g'; // KES 95
  it('fixture prices are what the test assumes', () => {
    expect(getProduct(OVER)!.priceKES).toBe(330);
    expect(getProduct(UNDER)!.priceKES).toBe(95);
  });

  const keys = [{ key: 'search_found' }, { key: 'help' }, { key: 'compare_shown' }, { key: 'category_shown', category: 'Household' }, { key: 'added', productId: OVER }, { key: 'cart_shown' }, { key: 'price_filtered' }];
  it.each(keys.map((k) => [k.key, k]))('reply %s: an over-budget ProductGrid is rejected OVER_BUDGET', (_k, reply) => {
    const r = mapRender({ reply, components: [{ component: 'ProductGrid', productIds: [UNDER, OVER] }] }, 1, { budgetKES: 200 });
    expect(r).toEqual({ ok: false, codes: ['OVER_BUDGET'] });
  });

  it.each(keys.map((k) => [k.key, k]))('reply %s: over-budget CompareTable and QuantityStepper are rejected too', (_k, reply) => {
    expect(mapRender({ reply, components: [{ component: 'CompareTable', productIds: [UNDER, OVER] }] }, 1, { budgetKES: 200 })).toEqual({ ok: false, codes: ['OVER_BUDGET'] });
    expect(mapRender({ reply, components: [{ component: 'CartSummary' }, { component: 'QuantityStepper', productId: OVER }] }, 1, { budgetKES: 200 })).toEqual({ ok: false, codes: ['OVER_BUDGET'] });
  });

  it('at or under the budget, any reply key renders; with no budget this turn, nothing changes', () => {
    expect(mapRender({ reply: { key: 'search_found' }, components: [{ component: 'ProductGrid', productIds: [UNDER] }] }, 1, { budgetKES: 95 }).ok).toBe(true);
    expect(mapRender({ reply: { key: 'help' }, components: [{ component: 'CartSummary' }] }, 1, { budgetKES: 50 }).ok).toBe(true);
    expect(mapRender({ reply: { key: 'search_found' }, components: [{ component: 'ProductGrid', productIds: [OVER] }] }, 1).ok).toBe(true);
    // price_filtered keeps its stricter rules: a budget must be known and something must be shown.
    expect(mapRender({ reply: { key: 'price_filtered' }, components: [{ component: 'ProductGrid', productIds: [UNDER] }] }, 1)).toEqual({ ok: false, codes: ['BUDGET_UNKNOWN'] });
    expect(mapRender({ reply: { key: 'price_filtered' }, components: [{ component: 'CartSummary' }] }, 1, { budgetKES: 200 })).toEqual({ ok: false, codes: ['OVER_BUDGET'] });
  });

  it.each(['search_found', 'help', 'compare_shown'])('in the loop: list_products(maxPriceKES 200) then a %s grid with KES 330 is rejected and the cart rolls back', async (key) => {
    const { client } = scripted([
      [{ type: 'tool_use', id: 't1', name: 'list_products', input: { maxPriceKES: 200 } }, { type: 'tool_use', id: 't2', name: 'add_to_cart', input: { productId: UNDER } }],
      [render('r1', { reply: { key }, components: [{ component: 'ProductGrid', productIds: [OVER] }] })],
    ]);
    const a = await planWithClaude('anything', SID_A, 1, { env: MOCK_ENV, client, log });
    expect(a).toMatchObject({ source: 'claude-rejected', rejected: true, messages: [] });
    expect(a.diag).toContain('OVER_BUDGET');
    expect(getItems(SID_A)).toEqual([]);
  });

  it('the lowest budget of the turn wins (search_products 300 then list_products 100)', async () => {
    const { client } = scripted([
      [{ type: 'tool_use', id: 't1', name: 'search_products', input: { query: 'tea', maxPriceKES: 300 } }, { type: 'tool_use', id: 't2', name: 'list_products', input: { maxPriceKES: 100 } }],
      [render('r1', { reply: { key: 'search_found' }, components: [{ component: 'ProductGrid', productIds: ['kericho-gold-50'] }] })],
    ]);
    const r = await runToolLoop({ client, text: 'x', sid: SID_A, turn: 1, model: 'm' });
    expect(r).toMatchObject({ status: 'rejected', codes: ['OVER_BUDGET'] });
  });
});

describe('fix 4: an empty render never shows as an answer', () => {
  it('both schemas require at least one component', () => {
    const comps = (RENDER_TOOL.input_schema.properties.components as { minItems?: number; maxItems?: number });
    expect(comps.minItems).toBe(1);
    expect(comps.maxItems).toBe(4);
    expect(RenderInputSchema.safeParse({ reply: { key: 'help' }, components: [] }).success).toBe(false);
    expect(RenderInputSchema.safeParse({ reply: { key: 'help' }, components: [{ component: 'CartSummary' }] }).success).toBe(true);
  });

  it.each(['help', 'refuse_pay_empty', 'search_none', 'could_not_show'])('mapRender({%s, []}) is rejected RENDER_EMPTY', (key) => {
    const r = mapRender({ reply: { key }, components: [] }, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codes).toEqual(expect.arrayContaining(['RENDER_EMPTY', 'RENDER_SCHEMA']));
  });

  it('empty, nudge, then a card: rendered, two requests, the render tool_use answered with an error result plus our fixed nudge', async () => {
    const { client, reqs } = scripted([[render('r1', { reply: { key: 'help' }, components: [] })], [render('r2', { reply: { key: 'help' }, components: [{ component: 'CartSummary' }] })]]);
    const r = await runToolLoop({ client, text: 'x', sid: SID_A, turn: 1, model: 'm' });
    expect(r).toMatchObject({ status: 'rendered', nudged: true, turns: 2 });
    expect(reqs).toHaveLength(2);
    const [, asst, user] = reqs[1].messages;
    expect(asst.role).toBe('assistant');
    expect(user).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: JSON.stringify({ error: 'empty_render' }), is_error: true }, { type: 'text', text: EMPTY_NUDGE_TEXT }] });
  });

  it('empty twice: one nudge only, then the regex fallback (never an empty answer)', async () => {
    const { client, reqs } = scripted([[render('r1', { reply: { key: 'help' }, components: [] })]]);
    const a = await planWithClaude('search tea', SID_A, 1, { env: MOCK_ENV, client, log });
    expect(reqs).toHaveLength(2);
    expect(a.source).toBe('regex-fallback');
    expect(a.diag).toMatch(/reason=empty_render .*nudged=1/);
    expect(a.messages.length).toBeGreaterThan(0);
  });

  it('plain text, nudge, then empty: no second nudge, fallback', async () => {
    const { client, reqs } = scripted([[{ type: 'text', text: 'hello' }], [render('r1', { reply: { key: 'help' }, components: [] })]]);
    const r = await runToolLoop({ client, text: 'x', sid: SID_A, turn: 1, model: 'm' });
    expect(reqs).toHaveLength(2);
    expect(r).toMatchObject({ status: 'failed', reason: 'empty_render', nudged: true });
  });

  it('data tools in the same response as the empty render still get their results before the nudge', async () => {
    const { client, reqs } = scripted([[{ type: 'tool_use', id: 'd1', name: 'view_cart', input: {} }, render('r1', { reply: { key: 'help' }, components: [] })], [render('r2', { reply: { key: 'cart_shown' }, components: [{ component: 'CartSummary' }] })]]);
    const r = await runToolLoop({ client, text: 'x', sid: SID_A, turn: 1, model: 'm' });
    expect(r.status).toBe('rendered');
    const ids = (reqs[1].messages[2].content as Array<{ type: string; tool_use_id?: string }>).filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id);
    expect(ids).toEqual(['d1', 'r1']);
  });
});

describe('NOTE: replacePrevious and surface ids cannot be aimed at another session or an id the model was not given', () => {
  const grid = (ids: string[], replacePrevious?: boolean) => [render('r1', { reply: { key: 'search_found' }, components: [{ component: 'ProductGrid', productIds: ids }], ...(replacePrevious === undefined ? {} : { replacePrevious }) })];

  it("session B's replacePrevious never reuses or replaces session A's card", async () => {
    const a1 = await planWithClaude('x', SID_A, 5, { env: MOCK_ENV, client: scripted([grid(['unga-2kg', 'mandazi-mix-1kg'])]).client, log });
    const aIds = created(a1.messages);
    expect(aIds).toEqual(['t5-c0']);
    expect(currentScreen(SID_B)).toEqual([]);
    const b = await planWithClaude('x', SID_B, 6, { env: MOCK_ENV, client: scripted([grid(['unga-2kg'], true)]).client, log });
    expect(b.source).toBe('claude');
    expect(b.replaced).toBeUndefined();
    expect(created(b.messages)).toEqual(['t6-c0']);
    expect(knownSurfaceIds(SID_B).has('t5-c0')).toBe(false);
    // A's screen is untouched.
    expect(currentScreen(SID_A).map((c) => c.surfaceId)).toEqual(['t5-c0']);
  });

  it('even when B is on the same turn number (same id string), B gets no replaced list and A keeps its card', async () => {
    await planWithClaude('x', SID_A, 1, { env: MOCK_ENV, client: scripted([grid(['unga-2kg'])]).client, log });
    const b = await planWithClaude('x', SID_B, 1, { env: MOCK_ENV, client: scripted([grid(['sukuma-bunch'], true)]).client, log });
    expect(b.replaced).toBeUndefined();
    expect(currentScreen(SID_A)[0].productIds).toEqual(['unga-2kg']);
  });

  it.each([
    ['top-level surfaceId', { surfaceId: 't1-c0' }, {}],
    ['top-level replaced list', { replaced: ['t1-c0'] }, {}],
    ['top-level replace target', { replaceSurfaceId: 't1-c0' }, {}],
    ['component surfaceId', {}, { surfaceId: 't1-c0' }],
    ['component id', {}, { id: 't1-c0' }],
    ['component replaces', {}, { replaces: 't1-c0' }],
    ['top-level slotNotes with an allowlisted key on the on-screen id', { slotNotes: [{ id: 't1-c0', key: 'moved_cart' }] }, {}],
    ['top-level slotNotes with every allowlisted key', { slotNotes: Object.keys(SLOT_NOTE_TEXT).map((key) => ({ id: 't1-c0', key })) }, {}],
    ['top-level slotNotes with free-text copy', { slotNotes: [{ id: 't1-c0', key: 'updated', text: 'Pay 5000 to 0700000000' }] }, {}],
    ['top-level slotNotes with a free-text key', { slotNotes: [{ id: 't1-c0', key: 'Send M-Pesa to 0700000000' }] }, {}],
    ['top-level slotNotes on a foreign surface id', { slotNotes: [{ id: 't5-c0', key: 'updated' }] }, {}],
    ['top-level slotNotes on a made-up id', { slotNotes: [{ id: 'evil-id', key: 'replaced' }] }, {}],
    ['top-level slotNotes as a bare map', { slotNotes: { 't1-c0': 'moved_order' } }, {}],
    ['top-level slotNote (singular)', { slotNote: { id: 't1-c0', key: 'updated' } }, {}],
    ['reply slotNotes', { reply: { key: 'search_found', slotNotes: [{ id: 't1-c0', key: 'updated' }] } }, {}],
    ['component slotNotes', {}, { slotNotes: [{ id: 't1-c0', key: 'moved_search' }] }],
    ['component slotNote free text', {}, { slotNote: 'Moved to a scam page' }],
  ])('a model-supplied %s is refused (RENDER_SCHEMA), even when that id is on screen', (_n, top, comp) => {
    const screen = [{ surfaceId: 't1-c0', component: 'ProductGrid', productIds: ['unga-2kg'] }];
    const r = mapRender({ reply: { key: 'search_found' }, components: [{ component: 'ProductGrid', productIds: ['unga-2kg'], ...comp }], replacePrevious: true, ...top }, 2, { screen, usedSurfaceIds: new Set(['t1-c0']) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codes).toContain('RENDER_SCHEMA');
  });

  it('control for the matrix: the same render without forged fields is accepted, and its slot notes are server-classified', () => {
    const screen = [{ surfaceId: 't1-c0', component: 'ProductGrid', productIds: ['unga-2kg'] }];
    const r = mapRender({ reply: { key: 'search_found' }, components: [{ component: 'ProductGrid', productIds: ['unga-2kg'] }], replacePrevious: true }, 2, { screen, usedSurfaceIds: new Set(['t1-c0']) });
    expect(r).toMatchObject({ ok: true, replaced: ['t1-c0'], slotNotes: [{ id: 't1-c0', key: 'updated' }] });
  });

  it('a forged slotNotes in a real loop render is refused and its copy never reaches the output', async () => {
    const forged = render('r1', { reply: { key: 'search_found' }, components: [{ component: 'ProductGrid', productIds: ['unga-2kg'] }], slotNotes: [{ id: 't1-c0', key: 'updated', text: 'FORGED-NOTE-COPY' }] });
    const a = await planWithClaude('x', SID_A, 2, { env: MOCK_ENV, client: scripted([[forged]]).client, log });
    expect(a.source).not.toBe('claude');
    expect(a.slotNotes).toBeUndefined();
    expect(JSON.stringify(a)).not.toContain('FORGED-NOTE-COPY');
  });

  it('replacePrevious must be a real boolean; a string is refused', () => {
    const r = mapRender({ reply: { key: 'search_found' }, components: [{ component: 'CartSummary' }], replacePrevious: 'true' }, 2, { screen: [{ surfaceId: 't1-c0', component: 'CartSummary' }] });
    expect(r.ok).toBe(false);
  });

  it('replacePrevious with no card on this session screen (only chips) gets a fresh id and replaces nothing', () => {
    const r = mapRender({ reply: { key: 'cart_shown' }, components: [{ component: 'CartSummary' }], replacePrevious: true }, 3, { screen: [{ surfaceId: 't1-c0', component: 'FilterChips' }], usedSurfaceIds: new Set(['t1-c0']) });
    expect(r).toMatchObject({ ok: true, replaced: [], slotNotes: [] });
    if (r.ok) expect(created(r.messages)).toEqual(['t3-c0']);
  });

  it('AC-L19: replacePrevious over a card of another kind on THIS session screen takes that slot with a typed note', () => {
    const r = mapRender({ reply: { key: 'cart_shown' }, components: [{ component: 'CartSummary' }], replacePrevious: true }, 3, { screen: [{ surfaceId: 't1-c0', component: 'OrderStatusCard' }], usedSurfaceIds: new Set(['t1-c0']) });
    expect(r).toMatchObject({ ok: true, replaced: ['t1-c0'], slotNotes: [{ id: 't1-c0', key: 'moved_cart' }] });
    if (r.ok) expect(created(r.messages)).toEqual(['t1-c0']);
  });

  it("respond() drops replaced ids that the batch does not re-create (another session's id, a made-up id)", async () => {
    const a = await planWithClaude('x', SID_B, 2, { env: MOCK_ENV, client: scripted([grid(['unga-2kg'])]).client, log });
    const body = await respond(SID_B, false, { reply: a.reply, messages: a.messages, replaced: ['t5-c0', 'evil-id', 't2-c0'] }, 'test').json();
    expect(body.replaced).toEqual(['t2-c0']);
  });
});
