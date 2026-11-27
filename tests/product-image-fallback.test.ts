/** Week 2b: a product without a photo renders the emoji tile placeholder (unit render). */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/catalog', async (orig) => {
  const m = await orig<typeof import('@/lib/catalog')>();
  const PRODUCTS = [...m.PRODUCTS, { id: 'no-photo', name: 'No Photo Beans', category: 'Snacks', priceKES: 10, unit: '1 kg', image: '🫘', stock: 3, description: 'x' }];
  return { ...m, PRODUCTS, getProduct: (id: string) => PRODUCTS.find((p) => p.id === id) };
});

const { default: ProductImage } = await import('@/components/ProductImage');
const { ProductCardView } = await import('@/components/assistant/views');

describe('missing image placeholder', () => {
  it('ProductImage shows the emoji tile and no <img> when the product has no imageSrc', () => {
    const m = renderToStaticMarkup(createElement(ProductImage, { productId: 'no-photo' }));
    expect(m).not.toContain('<img');
    expect(m).toContain('🫘');
    expect(m).toContain('aria-hidden="true"');
  });

  it('a ProductCard for such a product still renders, with the placeholder', () => {
    const m = renderToStaticMarkup(createElement(ProductCardView, { productId: 'no-photo', inCart: 0 }));
    expect(m).not.toContain('<img');
    expect(m).toContain('🫘');
    expect(m).toContain('No Photo Beans');
  });

  it('products with a photo still render the img (control)', () => {
    expect(renderToStaticMarkup(createElement(ProductImage, { productId: 'unga-2kg' }))).toContain('src="/products/unga-2kg.webp"');
  });
});
