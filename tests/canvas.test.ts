/**
 * SPEC-LIVE AC-L23 to AC-L28: the main-area assistant canvas.
 * Title row copy, pointer copy, the stray stepper drop, the canvas meta the
 * server sends and the panel re-checks, and the store/canvas state (new render
 * replaces, follow-up updates in place, back to shop). Mocks only, zero network.
 */
import { createElement } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { createStrictProcessor, dukaApiCatalog } from '@/lib/a2ui/catalog-api';
import { gateResponse } from '@/lib/a2ui/panel-gate';
import { AssistantTurn } from '@/components/assistant/AssistantTurn';
import { CanvasView } from '@/components/assistant/CanvasView';
import { CANVAS_POINTER_KEYS, CANVAS_TITLE_KEYS, canvasMetaFrom, canvasPointerText, canvasTitleText, parseCanvasMeta, type CanvasMeta } from '@/lib/assistant/canvas';
import { dropCartSteppers, mapRender } from '@/lib/assistant/claude/loop';
import { _resetMemoryForTests } from '@/lib/assistant/claude/memory';
import { createMockClient } from '@/lib/assistant/claude/mock-client';
import { planWithClaude } from '@/lib/assistant/claude/planner';
import { assistantStore } from '@/lib/assistant/client-store';
import { respond } from '@/lib/assistant/http';
import { cartSurface, chipsSurface, gridCardIds, compareSurface, handoffSurface, orderSurface, productsSurface, stepperSurface } from '@/lib/assistant/surfaces';
import { PRODUCTS } from '@/lib/catalog';
import { clearCart } from '@/lib/shop/cart';
import { html } from './a2ui-fixtures';
import { SID_A } from './helpers';
import { stubSurface } from './panel-render';

const MOCK_ENV = { DUKA_PLANNER: 'claude', DUKA_PLANNER_CLIENT: 'mock' };
const log = () => {};
const p4 = PRODUCTS.slice(0, 4);

beforeEach(() => {
  _resetMemoryForTests();
  clearCart(SID_A);
  assistantStore._resetForTests();
});

describe('title row copy (AC-L24)', () => {
  it.each<[CanvasMeta['title'], string]>([
    [{ key: 'results' }, 'Results'],
    [{ key: 'results_budget', budgetKES: 100 }, 'Results: under KES 100'],
    [{ key: 'results_budget', budgetKES: 1500 }, 'Results: under KES 1,500'],
    [{ key: 'results_category', category: 'Tea' }, 'Results: Tea'],
    [{ key: 'compare', n: 2 }, 'Compare: 2 products'],
    [{ key: 'basket' }, 'Your basket'],
    [{ key: 'checkout' }, 'Checkout'],
    [{ key: 'order' }, 'Your order'],
    [{ key: 'categories' }, 'Shop by category'],
  ])('%o -> %s', (t, text) => expect(canvasTitleText(t)).toBe(text));

  it('every title and pointer key has copy, no em dash', () => {
    for (const key of CANVAS_TITLE_KEYS) expect(canvasTitleText({ key, n: 2, budgetKES: 100, category: 'Tea' })).not.toMatch(/\u2014|undefined/);
    for (const key of CANVAS_POINTER_KEYS) expect(canvasPointerText({ key, n: 2 })).toMatch(/in the main view$/);
  });
});

describe('pointer copy (AC-L25)', () => {
  it.each<[CanvasMeta['pointer'], string]>([
    [{ key: 'results', n: 4 }, 'Showing 4 results in the main view'],
    [{ key: 'results', n: 1 }, 'Showing 1 result in the main view'],
    [{ key: 'compare' }, 'Showing the comparison in the main view'],
    [{ key: 'basket' }, 'Showing your basket in the main view'],
    [{ key: 'checkout' }, 'Checkout is ready in the main view'],
    [{ key: 'order' }, 'Showing your order in the main view'],
  ])('%o -> %s', (p, text) => expect(canvasPointerText(p)).toBe(text));
});

describe('canvas meta from server data only', () => {
  it.each<[string, unknown[], CanvasMeta | undefined]>([
    ['grid of 4', productsSurface('s1', { key: 'search_results' }, p4), { title: { key: 'results' }, pointer: { key: 'results', n: 4 } }],
    ['category grid + chips', [...chipsSurface('s0', 'Tea'), ...productsSurface('s1', { key: 'category', category: 'Tea' }, p4.slice(0, 2))], { title: { key: 'results_category', category: 'Tea' }, pointer: { key: 'results', n: 2 } }],
    ['compare of 2', compareSurface('s1', ['ketepa-100', 'kericho-gold-50']), { title: { key: 'compare', n: 2 }, pointer: { key: 'compare' } }],
    ['cart', cartSurface('s1'), { title: { key: 'basket' }, pointer: { key: 'basket' } }],
    ['stepper alone', stepperSurface('s1', 'unga-2kg'), { title: { key: 'basket' }, pointer: { key: 'basket' } }],
    ['cart + handoff: checkout wins', [...cartSurface('s1'), ...handoffSurface('s2')], { title: { key: 'checkout' }, pointer: { key: 'checkout' } }],
    ['order', orderSurface('s1', 'ord_abc'), { title: { key: 'order' }, pointer: { key: 'order' } }],
    ['chips alone', chipsSurface('s1'), { title: { key: 'categories' }, pointer: { key: 'categories' } }],
    ['nothing', [], undefined],
  ])('%s', (_n, messages, want) => expect(canvasMetaFrom(messages)).toEqual(want));

  it('a server budget turns the grid title into "under KES n"', () => {
    const m = canvasMetaFrom(productsSurface('s1', { key: 'search_results' }, p4), { budgetKES: 200 });
    expect(m?.title).toEqual({ key: 'results_budget', budgetKES: 200 });
    expect(canvasTitleText(m!.title)).toBe('Results: under KES 200');
  });

  it('respond() sends canvas meta with accepted cards only', async () => {
    const ok = await respond(SID_A, false, { reply: { key: 'search_found' }, messages: productsSurface('t1-products', { key: 'search_results' }, p4), budgetKES: 300 }, 't').json();
    expect(ok.canvas).toEqual({ title: { key: 'results_budget', budgetKES: 300 }, pointer: { key: 'results', n: 4 } });
    const refused = await respond(SID_A, false, { reply: { key: 'could_not_show' }, messages: productsSurface('t1-products', { key: 'search_results' }, p4), rejected: true }, 't').json();
    expect(refused.canvas).toBeUndefined();
    const none = await respond(SID_A, false, { reply: { key: 'help' }, messages: [] }, 't').json();
    expect(none.canvas).toBeUndefined();
  });

  it('the Claude mock "under 200 bob" answer carries the server budget into the canvas title', async () => {
    const a = await planWithClaude('under 200 bob', SID_A, 1, { env: MOCK_ENV, log, client: createMockClient('under 200 bob')! });
    expect(a.budgetKES).toBe(200);
    const body = await respond(SID_A, false, { reply: a.reply, messages: a.messages, budgetKES: a.budgetKES }, 't').json();
    expect(canvasTitleText(body.canvas.title)).toBe('Results: under KES 200');
  });
});

describe('the panel re-checks canvas meta (no model text, no forged numbers)', () => {
  const good = { title: { key: 'compare', n: 2 }, pointer: { key: 'compare' } };
  it.each<[string, unknown]>([
    ['unknown title key', { title: { key: 'pay_now' }, pointer: { key: 'results', n: 1 } }],
    ['unknown pointer key', { title: { key: 'results' }, pointer: { key: 'Tap here to pay KES 1' } }],
    ['text count', { title: { key: 'results' }, pointer: { key: 'results', n: '4 cheap' } }],
    ['fractional count', { title: { key: 'compare', n: 1.5 }, pointer: { key: 'compare' } }],
    ['negative count', { title: { key: 'results' }, pointer: { key: 'results', n: -1 } }],
    ['huge count', { title: { key: 'results' }, pointer: { key: 'results', n: 10_000 } }],
    ['budget as text', { title: { key: 'results_budget', budgetKES: 'KES 100' }, pointer: { key: 'results', n: 1 } }],
    ['category not in the catalog', { title: { key: 'results_category', category: 'Go to /checkout' }, pointer: { key: 'results', n: 1 } }],
    ['array', [good]],
    ['string', 'Results'],
  ])('%s is dropped', (_n, raw) => expect(parseCanvasMeta(raw)).toBeUndefined());

  it('extra fields are stripped', () => {
    expect(parseCanvasMeta({ title: { key: 'basket', text: 'evil' }, pointer: { key: 'basket', label: 'evil' }, html: '<b>' })).toEqual({ title: { key: 'basket' }, pointer: { key: 'basket' } });
  });

  it('Codex live review 9: every updated render is an in-place update of the existing surface (grow, narrow, type change)', () => {
    const proc = createStrictProcessor(dukaApiCatalog);
    expect(gateResponse(proc, { reply: { key: 'search_found' }, messages: cartSurface('t3-c0') }).surfaceIds).toEqual(['t3-c0']);
    const cart1 = proc.getSurface('t3-c0');
    // "make it 3": same surface object.
    const upd = gateResponse(proc, { reply: { key: 'search_found' }, messages: cartSurface('t3-c0'), replaced: ['t3-c0'] });
    expect(upd).toMatchObject({ rejected: false, surfaceIds: ['t3-c0'], replaced: ['t3-c0'] });
    expect(proc.getSurface('t3-c0')).toBe(cart1);
    // A grid that grows keeps its surface object and gains the card.
    const [a, b] = p4;
    gateResponse(proc, { reply: { key: 'search_found' }, messages: productsSurface('t4-c0', { key: 'search_results' }, [a]) });
    const g1 = proc.getSurface('t4-c0')!;
    const cardA = g1.componentsModel.get('p0');
    expect(gateResponse(proc, { reply: { key: 'search_found' }, messages: productsSurface('t4-c0', { key: 'search_results' }, [a, b]), replaced: ['t4-c0'] }).rejected).toBe(false);
    expect(proc.getSurface('t4-c0')).toBe(g1);
    expect([...g1.componentsModel.keys].sort()).toEqual(['p0', 'p1', 'root'].sort());
    expect(g1.componentsModel.get('p0')).toBe(cardA);
    // Card ids follow the catalog index (a = p0, b = p1). Narrowing ("only the cheaper one", here the SECOND card survives): same surface object, the surviving
    // card keeps its component model, the dropped card is gone, root lists only the survivor.
    const cardB = g1.componentsModel.get('p1');
    expect(gateResponse(proc, { reply: { key: 'search_found' }, messages: productsSurface('t4-c0', { key: 'search_results' }, [b]), replaced: ['t4-c0'] }).rejected).toBe(false);
    expect(proc.getSurface('t4-c0')).toBe(g1);
    expect([...g1.componentsModel.keys].sort()).toEqual(['p1', 'root']);
    expect(g1.componentsModel.get('p1')).toBe(cardB);
    expect(g1.componentsModel.get('p1')!.properties).toMatchObject({ productId: b.id });
    expect(g1.componentsModel.get('root')!.properties).toMatchObject({ children: ['p1'] });
    // A type change of root on the same id goes through in place (the library swaps the component).
    expect(gateResponse(proc, { reply: { key: 'search_found' }, messages: stepperSurface('t3-c0', 'unga-2kg'), replaced: ['t3-c0'] }).rejected).toBe(false);
    expect(proc.getSurface('t3-c0')).toBe(cart1);
    expect(proc.getSurface('t3-c0')!.componentsModel.get('root')?.type).toBe('QuantityStepper');
  });

  it('Codex live review 9: grid card ids follow the product (catalog index), so a narrowed grid keeps the survivor id', () => {
    const [a, b] = p4;
    expect(gridCardIds([a.id, b.id])).toEqual(['p0', 'p1']);
    expect(gridCardIds([b.id])).toEqual(['p1']);
    // Unknown ids and repeats fall back to the position (still valid UAX #31 ids, never a collision).
    expect(gridCardIds(['not-a-product', a.id, a.id])).toEqual(['q0', 'p0', 'q2']);
  });

  describe('Codex live review 9: the gate preflights the whole batch; a refused batch mutates nothing (checked by content)', () => {
    const qtyOf = (proc: ReturnType<typeof createStrictProcessor>, id: string) => proc.getSurface(id)?.componentsModel.get('root')?.properties.productId;
    const setup = () => {
      const proc = createStrictProcessor(dukaApiCatalog);
      expect(gateResponse(proc, { reply: { key: 'search_found' }, messages: stepperSurface('s-cart', 'unga-2kg') }).rejected).toBe(false);
      expect(gateResponse(proc, { reply: { key: 'search_found' }, messages: stepperSurface('s-other', 'unga-2kg') }).rejected).toBe(false);
      return proc;
    };
    const hostile = stepperSurface('s-cart', 'mandazi-mix-1kg');
    it.each<[string, unknown, string[]]>([
      ['duplicate createSurface + updateComponents, nothing listed (Codex probe)', hostile, []],
      ['a new surface first, then the duplicate', [...stepperSurface('s-new', 'ketepa-100'), ...hostile], []],
      ['the duplicate first, then a new surface', [...hostile, ...stepperSurface('s-new', 'ketepa-100')], []],
      ['listed s-other, but the batch also rewrites unlisted s-cart', [...stepperSurface('s-other', 'ketepa-100'), ...hostile], ['s-other']],
      ['listed s-cart, but the batch also deletes it', [...hostile, { version: '1.0', deleteSurface: { surfaceId: 's-cart' } }], ['s-cart']],
      ['duplicate createSurface + updateDataModel, nothing listed', [{ version: '1.0', createSurface: { surfaceId: 's-cart', catalogId: dukaApiCatalog.id } }, { version: '1.0', updateDataModel: { surfaceId: 's-cart', path: '/', value: { x: 1 } } }, { version: '1.0', updateComponents: { surfaceId: 's-cart', components: [{ id: 'root', component: 'QuantityStepper', productId: 'mandazi-mix-1kg' }] } }], []],
      ['listed id that does not exist yet does not unlock an existing one', [...stepperSurface('s-ghost', 'ketepa-100'), ...hostile], ['s-ghost']],
    ])('%s', (_n, batch, replaced) => {
      const proc = setup();
      const cart = proc.getSurface('s-cart')!;
      const root = cart.componentsModel.get('root')!;
      const out = gateResponse(proc, { reply: { key: 'search_found' }, messages: batch, replaced });
      expect(out.rejected).toBe(true);
      // Content, not identity: the existing cards still show what they showed before.
      expect(qtyOf(proc, 's-cart')).toBe('unga-2kg');
      expect(qtyOf(proc, 's-other')).toBe('unga-2kg');
      expect(root.properties).toMatchObject({ productId: 'unga-2kg' });
      expect([...cart.componentsModel.keys]).toEqual(['root']);
      expect(cart.dataModel.get('/')).toEqual({});
      expect(proc.getSurface('s-cart')).toBe(cart);
      // Zero mutation: no surface from the refused batch was created.
      expect(proc.getSurface('s-new')).toBeUndefined();
      expect(proc.getSurface('s-ghost')).toBeUndefined();
    });
    it('a listed id with no surface here (say after a reload) is a plain create and keeps its slot note', () => {
      const proc = createStrictProcessor(dukaApiCatalog);
      const out = gateResponse(proc, { reply: { key: 'search_found' }, messages: cartSurface('t9-c0'), replaced: ['t9-c0'] });
      expect(out).toMatchObject({ rejected: false, surfaceIds: ['t9-c0'], replaced: ['t9-c0'] });
      expect(proc.getSurface('t9-c0')!.componentsModel.get('root')?.type).toBe('CartSummary');
    });
    it('the same batch with s-cart listed is accepted and updates it in place (control)', () => {
      const proc = setup();
      const cart = proc.getSurface('s-cart')!;
      expect(gateResponse(proc, { reply: { key: 'search_found' }, messages: hostile, replaced: ['s-cart'] }).rejected).toBe(false);
      expect(proc.getSurface('s-cart')).toBe(cart);
      expect(qtyOf(proc, 's-cart')).toBe('mandazi-mix-1kg');
      expect(qtyOf(proc, 's-other')).toBe('unga-2kg');
    });
  });

  it('gateResponse keeps valid meta with accepted cards and drops it for a rejected turn', () => {
    const proc = createStrictProcessor(dukaApiCatalog);
    const ok = gateResponse(proc, { reply: { key: 'compare_shown' }, messages: compareSurface('t1-c', ['ketepa-100', 'kericho-gold-50']), canvas: good });
    expect(ok.canvas).toEqual(good);
    const bad = gateResponse(proc, { reply: { key: 'compare_shown' }, messages: [{ html: '<b>' }], canvas: good });
    expect(bad.rejected).toBe(true);
    expect(bad.canvas).toBeUndefined();
  });
});

describe('stray standalone QuantityStepper is dropped (AC-L26)', () => {
  it('with a CartSummary, a stepper for a product in the basket goes; one for a product not in the basket stays', () => {
    const input = [{ component: 'CartSummary' }, { component: 'QuantityStepper', productId: 'unga-2kg' }, { component: 'QuantityStepper', productId: 'kimbo-1kg' }];
    const frozen = JSON.stringify(input);
    expect(dropCartSteppers(input, ['unga-2kg'])).toEqual([{ component: 'CartSummary' }, { component: 'QuantityStepper', productId: 'kimbo-1kg' }]);
    expect(JSON.stringify(input)).toBe(frozen); // never mutates model input
  });

  it('a stepper alone (no CartSummary) stays', () => {
    const input = [{ component: 'QuantityStepper', productId: 'unga-2kg' }];
    expect(dropCartSteppers(input, ['unga-2kg'])).toEqual(input);
  });

  it('mapRender drops it before surface ids are assigned', () => {
    const r = mapRender({ reply: { key: 'qty_set', productId: 'unga-2kg' }, components: [{ component: 'CartSummary' }, { component: 'QuantityStepper', productId: 'unga-2kg' }] }, 4, { cartIds: ['unga-2kg'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const roots = r.messages.flatMap((m) => ('updateComponents' in m ? [m.updateComponents.components.find((c) => c.id === 'root')?.component] : []));
    expect(roots).toEqual(['CartSummary']);
    const alone = mapRender({ reply: { key: 'qty_too_high' }, components: [{ component: 'QuantityStepper', productId: 'unga-2kg' }] }, 5, { cartIds: ['unga-2kg'] });
    expect(alone.ok).toBe(true);
  });

  it('the Claude mock "make it 3" flow shows the basket without a stray stepper', async () => {
    const say = (text: string, turn: number) => planWithClaude(text, SID_A, turn, { env: MOCK_ENV, log, client: createMockClient(text)! });
    for (const [k, t] of ['show flour', 'only the cheaper one', 'add it'].entries()) expect((await say(t, k + 1)).source).toBe('claude');
    const a = await say('make it 3', 4);
    expect(a.source).toBe('claude');
    expect(JSON.stringify(a.messages)).toContain('CartSummary');
    expect(JSON.stringify(a.messages)).not.toContain('QuantityStepper');
  });
});

describe('store and canvas state (AC-L23, AC-L24)', () => {
  const title = { key: 'results' } as const;
  const add = (id: string, surfaceIds: string[], moved: string[] = [], notes: { id: string; key: 'updated' | 'moved_search' }[] = [], extra: { rejected?: boolean } = {}) =>
    assistantStore.addTurn({ id, role: 'assistant', text: 'x', surfaceIds, pointer: { key: 'results', n: surfaceIds.length }, ...extra }, moved, notes, title);

  it('hidden until the first render; a turn without cards does not show it', () => {
    expect(assistantStore.get().canvas).toBeNull();
    assistantStore.addTurn({ id: 'u1', role: 'user', text: 'hi', surfaceIds: [] });
    assistantStore.addTurn({ id: 'a0', role: 'assistant', text: 'x', surfaceIds: [] });
    expect(assistantStore.get().canvas).toBeNull();
    expect(html(createElement(CanvasView, { canvas: null, hidden: false, loading: false, renderSurface: stubSurface }))).toBe('');
  });

  it('a new render replaces the canvas (new rev, fade); a true follow-up updates in place (same rev, pulse)', () => {
    add('a1', ['s-grid']);
    const c1 = assistantStore.get().canvas!;
    expect(c1).toMatchObject({ turnId: 'a1', surfaceIds: ['s-grid'], rev: 1, pulse: 0, title });
    add('a2', ['s-grid'], ['s-grid'], [{ id: 's-grid', key: 'updated' }]);
    const c2 = assistantStore.get().canvas!;
    expect(c2).toMatchObject({ turnId: 'a2', surfaceIds: ['s-grid'], rev: 1, pulse: 1 });
    add('a3', ['s-grid'], ['s-grid'], [{ id: 's-grid', key: 'moved_search' }]);
    expect(assistantStore.get().canvas).toMatchObject({ turnId: 'a3', rev: 2, pulse: 0 });
    add('a4', ['s-cart']);
    expect(assistantStore.get().canvas).toMatchObject({ turnId: 'a4', surfaceIds: ['s-cart'], rev: 3 });
  });

  it('Codex live review 8: card wrappers are keyed by surface id only; a pulse remounts only the stateless overlay', () => {
    type El = { key: string | null; props: { children?: unknown; 'data-testid'?: string } };
    const kids = (e: El) => ([] as unknown[]).concat(e.props.children ?? []).flat().filter(Boolean) as El[];
    const body = (pulse: number) => {
      const sec = CanvasView({ canvas: { turnId: 'a1', surfaceIds: ['s-cart'], rev: 4, pulse }, hidden: false, loading: false, renderSurface: stubSurface }) as unknown as El;
      return kids(sec).find((k) => k.props['data-testid'] === 'canvas-body')!;
    };
    const [b0, b1, b2] = [body(0), body(1), body(2)];
    expect([b0.key, b1.key, b2.key]).toEqual(['4', '4', '4']);
    const wraps = [b0, b1, b2].map((b) => kids(b)[0]);
    expect(wraps.map((w) => w.key)).toEqual(['s-cart', 's-cart', 's-cart']);
    const overlays = wraps.map((w) => kids(w).find((k) => k.props['data-testid'] === 'canvas-pulse')?.key ?? null);
    expect(overlays).toEqual([null, 'pulse-1', 'pulse-2']);
    // The card itself is the first child of the wrapper in every case (same position, so React keeps it).
    expect(wraps.every((w) => kids(w)[0].props['data-testid'] !== 'canvas-pulse')).toBe(true);
  });

  it('a rejected render leaves the canvas as it is', () => {
    add('a1', ['s-grid']);
    add('a2', [], [], [], { rejected: true });
    expect(assistantStore.get().canvas?.turnId).toBe('a1');
  });

  it('back to shop hides the canvas and keeps the conversation; the next render shows it again', () => {
    add('a1', ['s-grid']);
    assistantStore.hideCanvas();
    const s = assistantStore.get();
    expect(s.canvasHidden).toBe(true);
    expect(s.turns).toHaveLength(1);
    expect(html(createElement(CanvasView, { canvas: s.canvas, hidden: true, loading: false, renderSurface: stubSurface }))).toBe('');
    add('a2', ['s-cart']);
    expect(assistantStore.get().canvasHidden).toBe(false);
  });

  it('CanvasView: title row, back button, surfaces in the canvas; skeleton while loading', () => {
    add('a1', ['s-grid']);
    const s = assistantStore.get();
    const out = html(createElement(CanvasView, { canvas: s.canvas, hidden: false, loading: false, renderSurface: stubSurface, onBack: () => {} }));
    expect(out).toContain('data-testid="assistant-canvas"');
    expect(out).toContain('data-title-key="results"');
    expect(out).toContain('>Results</span>');
    expect(out).toContain('Back to shop');
    expect(out).toContain('data-stub-surface="s-grid"');
    const busy = html(createElement(CanvasView, { canvas: s.canvas, hidden: false, loading: true, renderSurface: stubSurface }));
    expect(busy).toContain('data-testid="assistant-skeleton"');
    expect(busy).toContain('>Loading</span>');
    const first = html(createElement(CanvasView, { canvas: null, hidden: false, loading: true, renderSurface: stubSurface }));
    expect(first).toContain('data-testid="assistant-skeleton"');
  });

  it('the chat turn shows the pointer, never the cards; an older turn shows the slot or replaced copy', () => {
    add('a1', ['s-grid']);
    add('a2', ['s-cart']);
    const [t1, t2] = assistantStore.get().turns;
    const now = html(createElement(AssistantTurn, { turn: t2, current: true }));
    expect(now).toContain('data-testid="canvas-pointer"');
    expect(now).toContain('Showing 1 result in the main view');
    expect(now).not.toContain('data-surface-id');
    const old = html(createElement(AssistantTurn, { turn: t1, current: false }));
    expect(old).not.toContain('canvas-pointer');
    expect(old).toContain('data-slot-note="replaced"');
    expect(old).toContain('Replaced in the main view');
    add('a3', ['s-cart'], ['s-cart'], [{ id: 's-cart', key: 'updated' }]);
    const t2b = assistantStore.get().turns[1];
    const upd = html(createElement(AssistantTurn, { turn: t2b, current: false }));
    expect(upd).toContain('data-slot-note="updated"');
    expect(upd).toContain('Updated in the main view');
  });
});
