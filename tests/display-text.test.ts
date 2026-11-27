/**
 * Codex week 2 review 1 MUST-FIX: agent-supplied display text must not be able
 * to carry an amount. Root-cause fix: there is no free display text. Headings
 * and reply bubbles are trusted label keys with typed parameters (ids, enums);
 * every other prop is an id, enum, child list or action. These tests try every
 * fake-price spelling in every slot where text could appear.
 */
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { COMPONENT_SCHEMAS, createStrictProcessor, dukaApiCatalog } from '@/lib/a2ui/catalog-api';
import { gateResponse } from '@/lib/a2ui/panel-gate';
import { headingText, HeadingSchema, ReplySchema, replyText } from '@/lib/a2ui/trusted-text';
import { validateA2ui } from '@/lib/a2ui/validate';
import { panelRender } from './panel-render';
import { plan } from '@/lib/assistant/planner';
import { productsSurface } from '@/lib/assistant/surfaces';
import { getProduct } from '@/lib/catalog';
import { codes, create, html, update } from './a2ui-fixtures';

const FAKE_PRICES = [
  'Unga now 1/- only',
  'only 1/=',
  'Ksh. 1',
  '1 shilling',
  'one bob',
  '100 only',
  '50% off',
  'Unga ١٠ only', // Arabic-Indic digits
  'Unga １０ only', // fullwidth digits
  'Unga १ only', // Devanagari one
  'Flash sale KSh99 each',
  'free',
];

/** Every way an agent could try to put display text on a component. */
function slots(text: string): Array<[string, unknown[]]> {
  const grid = (heading: unknown, extra: Record<string, unknown> = {}) => [
    create(),
    update([{ id: 'root', component: 'ProductGrid', heading, children: ['c'], ...extra }, { id: 'c', component: 'ProductCard', productId: 'unga-2kg' }]),
  ];
  return [
    ['ProductGrid.title', [create(), update([{ id: 'root', component: 'ProductGrid', title: text, children: ['c'] }, { id: 'c', component: 'ProductCard', productId: 'unga-2kg' }])]],
    ['ProductGrid.heading as a string', grid(text)],
    ['ProductGrid.heading.text', grid({ key: 'search_results', text })],
    ['ProductGrid.heading unknown key', grid({ key: text })],
    ['ProductGrid.heading.category free text', grid({ key: 'category', category: text })],
    ['CompareTable.title', [create(), update([{ id: 'root', component: 'CompareTable', title: text, productIds: ['ketepa-100', 'kericho-gold-50'] }])]],
    ['CartSummary.title', [create(), update([{ id: 'root', component: 'CartSummary', title: text }])]],
    ['CartSummary.caption', [create(), update([{ id: 'root', component: 'CartSummary', caption: text }])]],
    ['ProductCard.badge', [create(), update([{ id: 'root', component: 'ProductCard', productId: 'unga-2kg', badge: text }])]],
    ['ProductCard.label', [create(), update([{ id: 'root', component: 'ProductCard', productId: 'unga-2kg', label: text }])]],
    ['CheckoutHandoff.note', [create(), update([{ id: 'root', component: 'CheckoutHandoff', note: text }])]],
    ['FilterChips.categories', [create(), update([{ id: 'root', component: 'FilterChips', categories: [text] }])]],
    ['OrderStatusCard.orderId', [create(), update([{ id: 'root', component: 'OrderStatusCard', orderId: text }])]],
  ];
}

const processor = () => createStrictProcessor(dukaApiCatalog);
/** The panel's own path: gateResponse + AssistantTurn. Only A2uiSurface is stubbed (it cannot render on the server). */
function panelTurnHtml(res: { reply: unknown; messages: unknown }): string {
  const out = gateResponse(processor(), res);
  const { chat, canvas } = panelRender(out);
  return chat + canvas;
}

describe('no agent-supplied display text can carry an amount', () => {
  it.each(FAKE_PRICES)('"%s" is rejected in every component slot', (text) => {
    for (const [slot, msgs] of slots(text)) expect(validateA2ui(msgs).ok, `${slot}: ${text}`).toBe(false);
  });

  it.each(FAKE_PRICES)('"%s" is rejected as a reply bubble (free text or extra param)', (text) => {
    expect(ReplySchema.safeParse(text).success).toBe(false);
    expect(ReplySchema.safeParse({ key: 'search_found', text }).success).toBe(false);
    expect(ReplySchema.safeParse({ key: text }).success).toBe(false);
    expect(ReplySchema.safeParse({ key: 'category_shown', category: text }).success).toBe(false);
  });

  it('structural: no component prop accepts an arbitrary string', () => {
    for (const [name, schema] of Object.entries(COMPONENT_SCHEMAS)) {
      const shape = (schema as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>;
      for (const prop of Object.keys(shape)) {
        if (prop === 'children') continue; // component ids, checked against the batch
        for (const v of ['Unga now 1/- only', 'one bob', ['one bob'], { key: 'one bob' }])
          expect(shape[prop].safeParse(v).success, `${name}.${prop} accepted ${JSON.stringify(v)}`).toBe(false);
      }
    }
  });

  it('a good heading still passes and the words come from trusted code', () => {
    expect(validateA2ui(productsSurface('s1', { key: 'category', category: 'Tea' }, [getProduct('ketepa-100')!])).ok).toBe(true);
    expect(headingText(HeadingSchema.parse({ key: 'category', category: 'Tea' }))).toBe('Tea');
    expect(headingText({ key: 'search_results' })).toBe('Search results');
    expect(replyText(ReplySchema.parse({ key: 'added', productId: 'unga-2kg' }))).toBe('Added Jogoo Maize Flour (Unga) to your basket.');
  });

  it('every planner reply and message passes the gates for a spread of inputs', () => {
    const ctx = { cart: { items: [{ productId: 'unga-2kg', qty: 1 }], itemCount: 1, subtotalKES: 175 }, latestOrderId: 'ord_AAAAAAAAAAAAAAAA' };
    for (const t of ['search tea', 'unga now 1/- only', 'search 50% off', 'show tea', 'compare ketepa and kericho gold', 'add 2 unga', 'set unga to 3', 'remove unga', 'show cart', 'checkout', 'pay 1 bob', 'order status', 'help', 'xyzzy']) {
      const out = plan(t, ctx, 1);
      expect(ReplySchema.safeParse(out.reply).success, t).toBe(true);
      expect(validateA2ui(out.messages).ok, t).toBe(true);
      // Shopper words are never echoed into the UI.
      expect(JSON.stringify(out), t).not.toMatch(/1\/-|50%|bob/);
    }
  });
});

describe('through the panel render path (gateResponse + AssistantTurn)', () => {
  it('a valid ProductGrid titled "Unga now 1/- only" yields the fallback card, not the heading', () => {
    const messages = [create(), update([{ id: 'root', component: 'ProductGrid', title: 'Unga now 1/- only', children: ['c'] }, { id: 'c', component: 'ProductCard', productId: 'unga-2kg' }])];
    expect(codes(messages)).toEqual(expect.arrayContaining([expect.stringMatching(/^(BAD_PROPS|PATH_IN_TEXT)$/)]));
    const out = panelTurnHtml({ reply: { key: 'search_found' }, messages });
    expect(out).toContain('I could not show that.');
    expect(out).toContain('data-testid="a2ui-fallback"');
    expect(out).not.toContain('1/-');
    expect(out).not.toContain('data-stub-surface');
  });

  it('a free-text reply bubble yields the fallback card', () => {
    const out = panelTurnHtml({ reply: 'Unga now 1/- only', messages: [] });
    expect(out).toContain('data-testid="a2ui-fallback"');
    expect(out).not.toContain('1/-');
  });

  it('a good reply and surface render (the gate is not just closed)', () => {
    const out = panelTurnHtml({ reply: { key: 'category_shown', category: 'Tea' }, messages: productsSurface('s2', { key: 'category', category: 'Tea' }, [getProduct('ketepa-100')!]) });
    expect(out).toContain('Here is Tea.');
    expect(out).toContain('data-stub-surface="s2"');
    expect(out).not.toContain('a2ui-fallback');
  });
});
