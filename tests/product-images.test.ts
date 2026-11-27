/**
 * Week 2b product images. URLs come only from the typed allowlist in
 * lib/catalog.ts; no message, planner or shopper can supply an image URL.
 */
import { DUKA_CATALOG_ID as DUKA_CATALOG_URI } from '@/lib/a2ui/catalog-api';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { createStrictProcessor, dukaApiCatalog, DUKA_COMPONENT_NAMES } from '@/lib/a2ui/catalog-api';
import { gateInjected } from '@/lib/a2ui/panel-gate';
import { validateA2ui } from '@/lib/a2ui/validate';
import { IMAGE_IDS, PRODUCTS, productImageSrc } from '@/lib/catalog';
import ProductImage from '@/components/ProductImage';
import { panelRender } from './panel-render';
import { CartSummaryView, CompareTableView, OrderStatusCardView, ProductCardView } from '@/components/assistant/views';
import { create, html, update } from './a2ui-fixtures';

const PUBLIC = join(__dirname, '..', 'public');
const PATH_RE = /^\/products\/[a-z0-9-]+\.webp$/;
const srcs = (markup: string) => [...markup.matchAll(/\ssrc="([^"]*)"/g)].map((m) => m[1]);

describe('catalog image allowlist', () => {
  it('every product has an allowlisted path, matching the pattern, and the file exists', () => {
    expect(PRODUCTS).toHaveLength(12);
    for (const p of PRODUCTS) {
      expect(p.imageSrc, p.id).toBe(`/products/${p.id}.webp`);
      expect(p.imageSrc).toMatch(PATH_RE);
      const f = join(PUBLIC, p.imageSrc!);
      expect(existsSync(f), f).toBe(true);
      expect(statSync(f).size, f).toBeGreaterThan(1000);
      expect(p.image.length, 'emoji fallback kept').toBeGreaterThan(0);
    }
  });

  it('the allowlist is exactly the catalog ids, and public/products holds nothing else', () => {
    expect([...IMAGE_IDS].sort()).toEqual(PRODUCTS.map((p) => p.id).sort());
    expect(readdirSync(join(PUBLIC, 'products')).sort()).toEqual(IMAGE_IDS.map((id) => `${id}.webp`).sort());
  });

  it('paths are built only from known ids', () => {
    for (const bad of ['x', '../x', '../../etc/passwd', 'unga-2kg/../x', 'https://evil.example/a', '', 'UNGA-2KG']) expect(productImageSrc(bad), bad).toBeUndefined();
  });
});

const BAD_VALUES = ['/products/x.webp', '/products/unga-2kg.webp', '../x', 'data:image/png;base64,iVBORw0KGgo=', 'https://evil.example/x.webp', '//evil.example/x.webp'];
const BAD_KEYS = ['image', 'imageSrc', 'src', 'url', 'imageUrl', 'srcSet'];
const BASE: Record<string, Record<string, unknown>> = {
  ProductGrid: { children: ['c'] },
  ProductCard: { productId: 'unga-2kg' },
  CompareTable: { productIds: ['ketepa-100', 'kericho-gold-50'] },
  CartSummary: {},
  QuantityStepper: { productId: 'unga-2kg' },
  FilterChips: { categories: ['Tea'] },
  CheckoutHandoff: {},
  OrderStatusCard: { orderId: 'ord_AAAAAAAAAAAAAAAA' },
};
const card = { id: 'c', component: 'ProductCard', productId: 'unga-2kg' };
const batch = (component: string, props: Record<string, unknown>) => [create(), update([{ id: 'root', component, ...props }, ...(component === 'ProductGrid' ? [card] : [])])];

/** The panel's own gate + turn view (A2uiSurface stubbed). */
function panelShowsFallback(raw: unknown): boolean {
  const out = gateInjected(createStrictProcessor(dukaApiCatalog), raw);
  const { chat, canvas } = panelRender(out);
  return chat.includes('data-testid="a2ui-fallback"') && !canvas.includes('data-stub-surface');
}

describe('messages cannot supply image URLs', () => {
  it('base batches are valid (control)', () => {
    for (const name of DUKA_COMPONENT_NAMES) expect(validateA2ui(batch(name, BASE[name])).ok, name).toBe(true);
  });

  it.each(BAD_KEYS)('an "%s" key on any component is rejected and the panel shows the fallback', (key) => {
    for (const name of DUKA_COMPONENT_NAMES)
      for (const v of BAD_VALUES) {
        const raw = batch(name, { ...BASE[name], [key]: v });
        expect(validateA2ui(raw).ok, `${name}.${key}=${v}`).toBe(false);
        expect(panelShowsFallback(raw), `${name}.${key}=${v}`).toBe(true);
      }
  });

  it.each(BAD_VALUES)('"%s" in every id, enum and key slot is rejected', (v) => {
    const slots: Array<[string, Record<string, unknown>]> = [
      ['ProductCard', { productId: v }],
      ['ProductCard', { productId: 'unga-2kg', badge: v }],
      ['QuantityStepper', { productId: v }],
      ['CompareTable', { productIds: ['ketepa-100', v] }],
      ['FilterChips', { categories: [v] }],
      ['FilterChips', { categories: ['Tea'], selected: v }],
      ['OrderStatusCard', { orderId: v }],
      ['ProductGrid', { children: ['c'], heading: { key: 'category', category: v } }],
      ['ProductGrid', { children: ['c'], heading: v }],
      ['ProductGrid', { children: [v] }],
    ];
    for (const [name, props] of slots) {
      const raw = batch(name, props);
      expect(validateA2ui(raw).ok, `${name} ${JSON.stringify(props)}`).toBe(false);
      expect(panelShowsFallback(raw)).toBe(true);
    }
  });

  it('data model updates cannot carry paths: bare values, nested alternate keys, or a non-root envelope path', () => {
    const base = () => [create(), update([{ id: 'root', component: 'CartSummary' }])];
    const cases: unknown[] = [
      { surfaceId: 's1', value: '/products/unga-2kg.webp' },
      { surfaceId: 's1', value: { photo: '../x' } },
      { surfaceId: 's1', value: { a: { b: { pic: 'data:image/png;base64,AAAA' } } } },
      { surfaceId: 's1', path: '/products/unga-2kg.webp' },
      { surfaceId: 's1', path: '/', value: { x: { y: 'products/unga-2kg' } } },
      { surfaceId: 's1', path: '/x' },
      { surfaceId: 's1', value: { photo: '/' } },
      { surfaceId: 's1', path: '/', value: '/' },
      { surfaceId: 's1', path: '/', value: ['/'] },
      { surfaceId: 's1', value: DUKA_CATALOG_URI },
      { surfaceId: 's1', value: { photo: DUKA_CATALOG_URI } },
    ];
    for (const dm of cases) {
      const r = validateA2ui([...base(), { version: '1.0', updateDataModel: dm }]);
      expect(r.ok, JSON.stringify(dm)).toBe(false);
      if (!r.ok) expect(r.diagnostics.map((d) => d.code).some((c) => c === 'PATH_IN_TEXT' || c === 'URL_IN_TEXT' || c === 'BAD_ENVELOPE')).toBe(true);
      expect(panelShowsFallback([...base(), { version: '1.0', updateDataModel: dm }])).toBe(true);
    }
  });

  it('path-like strings are rejected in any slot (bare, nested, alternate keys)', () => {
    for (const v of ['/products/unga-2kg.webp', '../x', 'products\\x', 'unga-2kg.webp', 'x.png']) {
      const raw = batch('ProductCard', { productId: 'unga-2kg', note: { photo: v } });
      const r = validateA2ui(raw);
      expect(r.ok, v).toBe(false);
      expect(panelShowsFallback(raw)).toBe(true);
    }
    // The root data path and plain ids still pass.
    expect(validateA2ui([create(), update([{ id: 'root', component: 'CartSummary' }]), { version: '1.0', updateDataModel: { surfaceId: 's1', path: '/', value: { qty: 1 } } }]).ok).toBe(true);
    expect(validateA2ui(batch('ProductCard', { productId: 'unga-2kg' })).ok).toBe(true);
  });

  it('image URLs in the data model are rejected too', () => {
    expect(validateA2ui([create(), update([{ id: 'root', component: 'CartSummary' }]), { version: '1.0', updateDataModel: { surfaceId: 's1', value: { imageSrc: '/products/x.webp' } } }]).ok).toBe(false);
  });
});

describe('views render only the catalog image for the id', () => {
  it('a valid ProductCard renders exactly its catalog image, alt = product name', () => {
    const m = html(createElement(ProductCardView, { productId: 'unga-2kg', inCart: 0, onAdd: () => {} }));
    expect(srcs(m)).toEqual(['/products/unga-2kg.webp']);
    expect(m).toContain('alt="Jogoo Maize Flour (Unga)"');
    expect(m).toMatch(/width="640"/);
    expect(m).toMatch(/height="640"/);
  });

  it('CompareTable, CartSummary and OrderStatusCard render the catalog images of their ids only', () => {
    expect(srcs(html(createElement(CompareTableView, { productIds: ['ketepa-100', 'kericho-gold-50'], onAdd: () => {} })))).toEqual(['/products/ketepa-100.webp', '/products/kericho-gold-50.webp']);
    const cart = { items: [{ productId: 'unga-2kg', qty: 2 }, { productId: 'omo-1kg', qty: 1 }], itemCount: 3, subtotalKES: 680 };
    expect(srcs(html(createElement(CartSummaryView, { cart, stepper: () => null })))).toEqual(['/products/unga-2kg.webp', '/products/omo-1kg.webp']);
    const order = { id: 'ord_AAAAAAAAAAAAAAAA', state: 'pending' as const, amountKES: 175, itemCount: 1, productIds: ['unga-2kg'] };
    expect(srcs(html(createElement(OrderStatusCardView, { orderId: order.id, order })))).toEqual(['/products/unga-2kg.webp']);
  });

  it('every image in every view matches the allowlist pattern', () => {
    for (const p of PRODUCTS) for (const s of srcs(html(createElement(ProductImage, { productId: p.id })))) expect(s).toMatch(PATH_RE);
  });

  it('an unknown id renders nothing (no image, no URL)', () => {
    expect(html(createElement(ProductImage, { productId: '../x' }))).toBe('');
  });
});
