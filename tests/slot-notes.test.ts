/**
 * SPEC-LIVE AC-L19 / AC-L20: the slot note left where a card used to be is a
 * trusted key classified server-side from the old screen card and the new card
 * on the same surface. Mocks only, zero network.
 */
import { createElement } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { createStrictProcessor, dukaApiCatalog } from '@/lib/a2ui/catalog-api';
import { gateResponse } from '@/lib/a2ui/panel-gate';
import { AssistantTurn } from '@/components/assistant/AssistantTurn';
import { assignSurfaceIds, mapRender } from '@/lib/assistant/claude/loop';
import { _resetMemoryForTests } from '@/lib/assistant/claude/memory';
import { createMockClient } from '@/lib/assistant/claude/mock-client';
import { planWithClaude } from '@/lib/assistant/claude/planner';
import { assistantStore } from '@/lib/assistant/client-store';
import { respond } from '@/lib/assistant/http';
import { classifySlot, SLOT_NOTE_TEXT, slotNotesFor, type SlotNoteKey } from '@/lib/assistant/slot-notes';
import { cartSurface, productsSurface } from '@/lib/assistant/surfaces';
import { PRODUCTS } from '@/lib/catalog';
import { clearCart } from '@/lib/shop/cart';
import { html } from './a2ui-fixtures';
import { SID_A } from './helpers';

const MOCK_ENV = { DUKA_PLANNER: 'claude', DUKA_PLANNER_CLIENT: 'mock' };
const log = () => {};
const grid = (...productIds: string[]) => ({ component: 'ProductGrid', productIds });
const compare = (...productIds: string[]) => ({ component: 'CompareTable', productIds });
const card = (component: string, extra: Record<string, unknown> = {}) => ({ component, ...extra });

beforeEach(() => {
  _resetMemoryForTests();
  clearCart(SID_A);
});

describe('classifySlot (AC-L19 rules)', () => {
  it.each<[string, ReturnType<typeof card> | undefined, ReturnType<typeof card> | undefined, SlotNoteKey]>([
    ['grid -> grid subset', grid('a', 'b'), grid('a'), 'updated'],
    ['grid -> grid equal ids', grid('a', 'b'), grid('b', 'a'), 'updated'],
    ['grid -> grid disjoint (new search)', grid('a', 'b'), grid('c'), 'moved_search'],
    ['grid -> grid overlapping but not a subset', grid('a', 'b'), grid('a', 'c'), 'moved_search'],
    ['grid -> compare of a subset', grid('a', 'b', 'c'), compare('a', 'b'), 'updated'],
    ['compare -> grid of a subset', compare('a', 'b'), grid('b'), 'updated'],
    ['grid -> compare of different products', grid('a', 'b'), compare('c', 'd'), 'moved_search'],
    ['grid -> empty grid ids', grid('a'), grid(), 'moved_search'],
    ['grid -> cart', grid('a'), card('CartSummary'), 'moved_cart'],
    ['grid -> stepper', grid('a'), card('QuantityStepper', { productIds: ['a'] }), 'moved_cart'],
    ['cart -> cart (qty)', card('CartSummary'), card('CartSummary'), 'updated'],
    ['cart -> stepper', card('CartSummary'), card('QuantityStepper', { productIds: ['a'] }), 'updated'],
    ['stepper -> cart', card('QuantityStepper', { productIds: ['a'] }), card('CartSummary'), 'updated'],
    ['cart -> grid (new search after a basket)', card('CartSummary'), grid('a'), 'moved_search'],
    ['checkout -> compare', card('CheckoutHandoff'), compare('a', 'b'), 'moved_search'],
    ['order -> grid', card('OrderStatusCard', { orderId: 'ord_x' }), grid('a'), 'moved_search'],
    ['cart -> checkout', card('CartSummary'), card('CheckoutHandoff'), 'moved_checkout'],
    ['checkout -> checkout', card('CheckoutHandoff'), card('CheckoutHandoff'), 'updated'],
    ['checkout -> order', card('CheckoutHandoff'), card('OrderStatusCard', { orderId: 'ord_x' }), 'moved_order'],
    ['order -> same order', card('OrderStatusCard', { orderId: 'ord_x' }), card('OrderStatusCard', { orderId: 'ord_x' }), 'updated'],
    ['order -> other order', card('OrderStatusCard', { orderId: 'ord_x' }), card('OrderStatusCard', { orderId: 'ord_y' }), 'moved_order'],
    ['order -> cart', card('OrderStatusCard', { orderId: 'ord_x' }), card('CartSummary'), 'moved_cart'],
    ['chips -> chips', card('FilterChips'), card('FilterChips'), 'updated'],
    ['grid -> chips (other type change)', grid('a'), card('FilterChips'), 'replaced'],
    ['unknown old component', card('Banner'), grid('a'), 'replaced'],
    ['unknown new component', grid('a'), card('Banner'), 'replaced'],
    ['missing old card', undefined, grid('a'), 'replaced'],
    ['missing new card', grid('a'), undefined, 'replaced'],
  ])('%s -> %s', (_n, prev, next, key) => {
    expect(classifySlot(prev, next)).toBe(key);
  });

  it('every key has short fixed copy, no digits, no em dash', () => {
    // AC-L25: canvas wording (the cards moved to the main view).
    expect(SLOT_NOTE_TEXT.updated).toBe('Updated in the main view');
    expect(SLOT_NOTE_TEXT.replaced).toBe('Replaced in the main view');
    expect(SLOT_NOTE_TEXT.moved_search).toBe('Moved to your search results');
    for (const t of Object.values(SLOT_NOTE_TEXT)) {
      expect(t.length).toBeLessThanOrEqual(40);
      expect(t).not.toMatch(/[0-9\u2014]/);
    }
  });

  it('slotNotesFor: one note per allowed id, unknown keys and ids dropped, missing becomes replaced', () => {
    const raw = [{ id: 'a', key: 'moved_cart' }, { id: 'evil', key: 'updated' }, { id: 'b', key: 'Card updated below.' }, { id: 'a', key: 'updated' }, 'x', null];
    expect(slotNotesFor(['a', 'b', 'a'], raw)).toEqual([{ id: 'a', key: 'moved_cart' }, { id: 'b', key: 'replaced' }]);
    expect(slotNotesFor(['c'], 'nope')).toEqual([{ id: 'c', key: 'replaced' }]);
  });
});

describe('server: mapRender and the planner send one key per replaced surface', () => {
  it('replacePrevious off: nothing reused, nothing noted', () => {
    const r = mapRender({ reply: { key: 'search_found' }, components: [grid('unga-2kg')] }, 2, { screen: [{ surfaceId: 't1-c0', ...grid('unga-2kg', 'sukuma-bunch') }], usedSurfaceIds: new Set(['t1-c0']) });
    expect(r).toMatchObject({ ok: true, replaced: [], slotNotes: [] });
  });

  it('replacePrevious on with an empty screen: nothing reused, nothing noted', () => {
    const r = mapRender({ reply: { key: 'search_found' }, components: [grid('unga-2kg')], replacePrevious: true }, 2, { screen: [] });
    expect(r).toMatchObject({ ok: true, replaced: [], slotNotes: [] });
  });

  it('a grid narrowed to a subset is `updated`; a different search on the same surface is `moved_search`', () => {
    const screen = [{ surfaceId: 't1-c0', ...grid('unga-2kg', 'mandazi-mix-1kg') }];
    expect(mapRender({ reply: { key: 'search_found' }, components: [grid('unga-2kg')], replacePrevious: true }, 2, { screen })).toMatchObject({ ok: true, slotNotes: [{ id: 't1-c0', key: 'updated' }] });
    expect(mapRender({ reply: { key: 'search_found' }, components: [compare('unga-2kg', 'mandazi-mix-1kg')], replacePrevious: true }, 2, { screen })).toMatchObject({ ok: true, slotNotes: [{ id: 't1-c0', key: 'updated' }] });
    expect(mapRender({ reply: { key: 'search_found' }, components: [grid('sukuma-bunch')], replacePrevious: true }, 2, { screen })).toMatchObject({ ok: true, slotNotes: [{ id: 't1-c0', key: 'moved_search' }] });
  });

  it('a grid with chips after a basket: the grid takes the cart slot (moved_search), chips get a fresh id', () => {
    const screen = [
      { surfaceId: 't3-c0', component: 'CartSummary' },
      { surfaceId: 't4-c1', component: 'QuantityStepper', productIds: ['unga-2kg'] },
    ];
    const r = mapRender({ reply: { key: 'search_found' }, components: [grid('unga-2kg', 'royco-200g'), { component: 'FilterChips' }], replacePrevious: true }, 5, { screen, usedSurfaceIds: new Set(['t3-c0', 't4-c1']) });
    expect(r).toMatchObject({ ok: true, replaced: ['t3-c0'], slotNotes: [{ id: 't3-c0', key: 'moved_search' }] });
  });

  it('assignSurfaceIds: cross-kind takeover only on replacePrevious, FilterChips never take or lose a slot that way', () => {
    const screen = [
      { surfaceId: 't1-c0', component: 'FilterChips' },
      { surfaceId: 't1-c1', component: 'CartSummary' },
    ];
    expect(assignSurfaceIds(['CheckoutHandoff'], 2, false, screen)).toEqual({ ids: ['t2-c0'], replaced: [] });
    expect(assignSurfaceIds(['CheckoutHandoff'], 2, true, screen)).toEqual({ ids: ['t1-c1'], replaced: ['t1-c1'] });
    expect(assignSurfaceIds(['FilterChips', 'OrderStatusCard'], 2, true, [screen[1]])).toEqual({ ids: ['t2-c0', 't1-c1'], replaced: ['t1-c1'] });
  });

  it('mock planner flow: cheaper -> updated, make it 3 -> updated, under 200 bob after the basket -> moved_search', async () => {
    const say = async (text: string, turn: number) => planWithClaude(text, SID_A, turn, { env: MOCK_ENV, log, client: createMockClient(text)! });
    const t1 = await say('show flour', 1);
    expect(t1.replaced).toBeUndefined();
    const t2 = await say('only the cheaper one', 2);
    expect(t2.slotNotes).toEqual([{ id: 't1-c0', key: 'updated' }]);
    const t3 = await say('add it', 3);
    expect(t3.slotNotes).toBeUndefined();
    const t4 = await say('make it 3', 4);
    expect(t4.slotNotes).toEqual([{ id: 't3-c0', key: 'updated' }]);
    const t5 = await say('under 200 bob', 5);
    expect(t5.replaced).toEqual(['t3-c0']);
    expect(t5.slotNotes).toEqual([{ id: 't3-c0', key: 'moved_search' }]);
    // respond() keeps one note per replaced id it passes on.
    const body = await respond(SID_A, false, { reply: t5.reply, messages: t5.messages, replaced: t5.replaced, slotNotes: t5.slotNotes }, 'test').json();
    expect(body.replaced).toEqual(['t3-c0']);
    expect(body.slotNotes).toEqual([{ id: 't3-c0', key: 'moved_search' }]);
    expect(JSON.stringify(body.slotNotes)).not.toMatch(/below|Moved/);
  });

  it('respond() drops notes for ids it does not pass on and coerces bad keys to `replaced`', async () => {
    const msgs = productsSurface('t1-c0', { key: 'search_results' }, PRODUCTS.slice(0, 1));
    const body = await respond(SID_A, false, { reply: { key: 'search_found' }, messages: msgs, replaced: ['t1-c0', 't0-old'], slotNotes: [{ id: 't1-c0', key: 'Card updated below.' }, { id: 't0-old', key: 'updated' }] }, 'test').json();
    expect(body.slotNotes).toEqual([{ id: 't1-c0', key: 'replaced' }]);
    const none = await respond(SID_A, false, { reply: { key: 'search_found' }, messages: msgs, slotNotes: [{ id: 't1-c0', key: 'updated' }] }, 'test').json();
    expect(none.slotNotes).toBeUndefined();
    expect(none.replaced).toBeUndefined();
  });
});

describe('panel: gate, store and AssistantTurn render the trusted copy per surface', () => {
  const p = () => createStrictProcessor(dukaApiCatalog);

  it('gateResponse passes notes only for ids it honoured', () => {
    const proc = p();
    gateResponse(proc, { reply: { key: 'search_found' }, messages: cartSurface('t1-c0') });
    const out = gateResponse(proc, { reply: { key: 'search_found' }, messages: productsSurface('t1-c0', { key: 'search_results' }, PRODUCTS.slice(0, 1)), replaced: ['t1-c0', 'zz'], slotNotes: [{ id: 't1-c0', key: 'moved_search' }, { id: 'zz', key: 'updated' }] });
    expect(out).toMatchObject({ rejected: false, replaced: ['t1-c0'], slotNotes: [{ id: 't1-c0', key: 'moved_search' }] });
  });

  it('the store records one key per moved surface on the old turn', () => {
    const base = assistantStore.get().turns.length;
    assistantStore.addTurn({ id: 'b1', role: 'assistant', text: 'x', surfaceIds: ['s-a', 's-b', 's-c'] });
    assistantStore.addTurn({ id: 'b2', role: 'assistant', text: 'y', surfaceIds: ['s-a', 's-b'] }, ['s-a', 's-b'], [{ id: 's-a', key: 'moved_search' }]);
    const [old, now] = assistantStore.get().turns.slice(base);
    expect(old).toMatchObject({ surfaceIds: ['s-c'], slotNotes: [{ id: 's-a', key: 'moved_search' }, { id: 's-b', key: 'replaced' }] });
    expect(now.slotNotes).toBeUndefined();
    // No moved ids: nothing is marked.
    assistantStore.addTurn({ id: 'b3', role: 'assistant', text: 'z', surfaceIds: ['s-d'] }, [], [{ id: 's-c', key: 'updated' }]);
    expect(assistantStore.get().turns.slice(base)[0].surfaceIds).toEqual(['s-c']);
  });

  it.each(Object.entries(SLOT_NOTE_TEXT))('AssistantTurn renders %s as card-slot-note with its fixed text', (key, text) => {
    const out = html(createElement(AssistantTurn, { turn: { id: 'a1', text: '', surfaceIds: [], slotNotes: [{ id: 't1-c0', key: key as SlotNoteKey }] } }));
    expect(out).toContain('data-testid="card-slot-note"');
    expect(out).toContain(`data-slot-note="${key}"`);
    expect(out).toContain(`${text}</button>`);
    expect(out).not.toContain('Card updated below.');
  });

  it('AssistantTurn renders nothing for a key outside the allowlist', () => {
    const out = html(createElement(AssistantTurn, { turn: { id: 'a1', text: '', surfaceIds: [], slotNotes: [{ id: 't1-c0', key: 'KES 999 off' as SlotNoteKey }] } }));
    expect(out).not.toContain('card-slot-note');
    expect(out).not.toContain('KES 999');
  });
});
