/** AC-W2-2 trusted catalog and AC-W2-3 message validation (W2-9 caps included). */
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { COMPONENT_SCHEMAS, DUKA_COMPONENT_NAMES } from '@/lib/a2ui/catalog-api';
import { LIMITS, validateA2ui } from '@/lib/a2ui/validate';
import { FallbackCard } from '@/components/assistant/views';
import { cartSurface, chipsSurface, compareSurface, handoffSurface, orderSurface, productsSurface, stepperSurface } from '@/lib/assistant/surfaces';
import { PRODUCTS } from '@/lib/catalog';
import { codes, create, dataModel, html, one, update } from './a2ui-fixtures';

const VALID_PROPS: Record<string, Record<string, unknown>> = {
  ProductGrid: { heading: { key: 'category', category: 'Tea' }, children: [] },
  ProductCard: { productId: 'unga-2kg' },
  CompareTable: { productIds: ['ketepa-100', 'kericho-gold-50'] },
  CartSummary: {},
  QuantityStepper: { productId: 'unga-2kg' },
  FilterChips: { categories: ['Tea'] },
  CheckoutHandoff: {},
  OrderStatusCard: { orderId: 'ord_AAAAAAAAAAAAAAAA' },
};

describe('AC-W2-2 registry', () => {
  it('has exactly 8 trusted components (6 to 8 allowed)', () => {
    expect(DUKA_COMPONENT_NAMES).toHaveLength(8);
    expect([...DUKA_COMPONENT_NAMES].sort()).toEqual(Object.keys(VALID_PROPS).sort());
  });

  it.each(Object.keys(VALID_PROPS))('%s schema accepts valid props and rejects any extra prop (strict)', (name) => {
    const s = COMPONENT_SCHEMAS[name];
    expect(s.safeParse(VALID_PROPS[name]).success).toBe(true);
    for (const extra of ['price', 'priceKES', 'name', 'html', 'className', 'style', 'href', 'onClick']) {
      expect(s.safeParse({ ...VALID_PROPS[name], [extra]: 'x' }).success, `${name}.${extra}`).toBe(false);
    }
  });

  it('product ids must be catalog ids; categories must be catalog categories', () => {
    expect(COMPONENT_SCHEMAS.ProductCard.safeParse({ productId: 'free-phone' }).success).toBe(false);
    expect(COMPONENT_SCHEMAS.FilterChips.safeParse({ categories: ['Phones'] }).success).toBe(false);
    expect(COMPONENT_SCHEMAS.OrderStatusCard.safeParse({ orderId: '../admin' }).success).toBe(false);
  });
});

describe('AC-W2-3 validator: every surface we emit is accepted', () => {
  const cases: Array<[string, unknown[]]> = [
    ['products', productsSurface('t1-products', { key: 'all_products' }, PRODUCTS)],
    ['chips', chipsSurface('t1-chips', 'Tea')],
    ['compare', compareSurface('t1-compare', ['ketepa-100', 'kericho-gold-50', 'unga-2kg'])],
    ['cart', cartSurface('t1-cart')],
    ['stepper', stepperSurface('t1-stepper', 'unga-2kg')],
    ['handoff', handoffSurface('t1-handoff')],
    ['order', orderSurface('t1-order', 'ord_AAAAAAAAAAAAAAAA')],
  ];
  it.each(cases)('%s surface passes our gate and the library strict processor', (_n, msgs) => {
    expect(validateA2ui(msgs)).toMatchObject({ ok: true });
  });
});

describe('AC-W2-3 / AC-W2-9 validator rejections', () => {
  it('unknown component', () => {
    expect(codes(one({ component: 'EvilIframe', title: 'x' }))).toContain('UNKNOWN_COMPONENT');
    expect(codes(one({ component: 'Button', child: 'x' }))).toContain('UNKNOWN_COMPONENT');
  });

  it('unknown or invalid props', () => {
    expect(codes(one({ component: 'ProductCard', productId: 'unga-2kg', price: 1 }))).toContain('BAD_PROPS');
    expect(codes(one({ component: 'ProductCard', productId: 42 }))).toContain('BAD_PROPS');
    expect(codes(one({ component: 'CompareTable', productIds: ['unga-2kg'] }))).toContain('BAD_PROPS');
    expect(codes(one({ component: 'ProductCard', productId: { path: '/p' } }))).toContain('PATH_IN_TEXT'); // path strings are refused before prop checks
  });

  it('oversized batch', () => {
    const big = [create(), dataModel({ pad: Array.from({ length: 200 }, () => 'x'.repeat(90)) })];
    expect(JSON.stringify(big).length).toBeGreaterThan(LIMITS.maxBytes);
    expect(codes(big)).toEqual(['OVERSIZE']);
  });

  it('too many messages and too many components', () => {
    expect(codes(Array.from({ length: LIMITS.maxMessages + 1 }, (_, i) => create(`s${i}`)))).toEqual(['TOO_MANY_MESSAGES']);
    const many = Array.from({ length: LIMITS.maxComponents + 1 }, (_, i) => ({ id: `c${i}`, component: 'CartSummary' }));
    expect(codes([create(), update(many)])).toContain('TOO_MANY_COMPONENTS');
  });

  it('too-deep component tree (grid in grid in grid in grid)', () => {
    const ok = [
      { id: 'root', component: 'ProductGrid', children: ['g2'] },
      { id: 'g2', component: 'ProductGrid', children: ['c'] },
      { id: 'c', component: 'ProductCard', productId: 'unga-2kg' },
    ];
    expect(validateA2ui([create(), update(ok)]).ok).toBe(true);
    const deep = [
      { id: 'root', component: 'ProductGrid', children: ['g2'] },
      { id: 'g2', component: 'ProductGrid', children: ['g3'] },
      { id: 'g3', component: 'ProductGrid', children: ['c'] },
      { id: 'c', component: 'ProductCard', productId: 'unga-2kg' },
    ];
    expect(codes([create(), update(deep)])).toContain('TREE_TOO_DEEP');
  });

  it('cycles, missing root, dangling children, deep JSON', () => {
    expect(codes([create(), update([{ id: 'root', component: 'ProductGrid', children: ['root'] }])])).toContain('TREE_TOO_DEEP');
    expect(codes([create(), update([{ id: 'x', component: 'CartSummary' }])])).toContain('MISSING_ROOT');
    expect(codes([create(), update([{ id: 'root', component: 'ProductGrid', children: ['ghost'] }])])).toContain('BAD_CHILD');
    let v: unknown = 'x';
    for (let i = 0; i < 15; i++) v = { v };
    expect(codes([create(), dataModel(v)])).toContain('JSON_TOO_DEEP');
  });

  it('envelope: wrong version, wrong catalog, update before create, not an array', () => {
    expect(codes([{ version: '0.9', createSurface: { surfaceId: 's1', catalogId: 'x' } }])).toContain('BAD_ENVELOPE');
    expect(codes([{ version: '1.0', createSurface: { surfaceId: 's1', catalogId: 'https://evil.example/catalog' } }])).toContain('URL_IN_TEXT');
    expect(codes([{ version: '1.0', createSurface: { surfaceId: 's1', catalogId: 'other' } }])).toContain('WRONG_CATALOG');
    expect(codes([update([{ id: 'root', component: 'CartSummary' }])])).toContain('SURFACE_NOT_CREATED');
    expect(codes({ not: 'array' })).toEqual(['NOT_AN_ARRAY']);
  });

  it('security review fixes: fan-out tree is rejected fast, duplicate children and foreign deleteSurface are rejected', () => {
    const comps: Record<string, unknown>[] = Array.from({ length: 39 }, (_, i) => ({ id: i === 0 ? 'root' : `g${i}`, component: 'ProductGrid', children: Array(24).fill(`g${i + 1}`) }));
    comps.push({ id: 'g39', component: 'ProductCard', productId: 'unga-2kg' });
    const t = Date.now();
    expect(codes([create(), update(comps)])).toContain('BAD_CHILD');
    const distinct = Array.from({ length: 6 }, (_, i) => ({ id: i === 0 ? 'root' : `g${i}`, component: 'ProductGrid', children: [`g${i + 1}`] }));
    distinct.push({ id: 'g6', component: 'ProductCard', productId: 'unga-2kg' } as never);
    expect(codes([create(), update(distinct)])).toContain('TREE_TOO_DEEP');
    expect(Date.now() - t).toBeLessThan(500);
    expect(codes([{ version: '1.0', deleteSurface: { surfaceId: 't1-cart' } }])).toContain('SURFACE_NOT_CREATED');
    expect(validateA2ui([create('s9'), update([{ id: 'root', component: 'CartSummary' }], 's9'), { version: '1.0', deleteSurface: { surfaceId: 's9' } }]).ok).toBe(true);
  });

  it('diagnostics are redacted: codes and structural paths only, never raw values or attacker keys', () => {
    const secret = 'AKIA_FAKE_SECRET_VALUE_123';
    const r = validateA2ui([create(), update([{ id: 'root', component: 'ProductCard', productId: 'unga-2kg', [secret]: secret }])]);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(secret);
    const r2 = validateA2ui([create(), update([{ id: 'root', component: secret }])]);
    expect(JSON.stringify(r2)).not.toContain(secret);
  });

  it('fallback card says "I could not show that"', () => {
    expect(html(createElement(FallbackCard))).toContain('I could not show that.');
  });
});
