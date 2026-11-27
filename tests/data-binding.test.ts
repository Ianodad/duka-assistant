/** AC-W2-4: products are referenced by id; the renderer shows the catalog price, never an agent-supplied one. */
import { describe, expect, it } from 'vitest';
import { codes, create, dataModel, renderAcceptedCard, update } from './a2ui-fixtures';

describe('AC-W2-4 data binding by product id', () => {
  it('a fake price and name in the data model are ignored: the server catalog price renders', () => {
    const msgs = [
      create(),
      update([{ id: 'root', component: 'ProductCard', productId: 'unga-2kg' }]),
      dataModel({ products: [{ productId: 'unga-2kg', priceKES: 1, price: 1, name: 'FREE UNGA', priceLabel: 'almost nothing' }] }),
    ];
    const out = renderAcceptedCard(msgs, 'root');
    expect(out).toContain('KES 175');
    expect(out).toContain('Jogoo Maize Flour (Unga)');
    expect(out).not.toContain('FREE UNGA');
    expect(out).not.toContain('almost nothing');
  });

  it('a price or name prop on a component is rejected outright', () => {
    for (const extra of [{ price: 1 }, { priceKES: 1 }, { priceLabel: 'x' }, { name: 'FREE' }])
      expect(codes([create(), update([{ id: 'root', component: 'ProductCard', productId: 'unga-2kg', ...extra }])])).toContain('BAD_PROPS');
  });

  it('agent text cannot carry a price: components have no free-text props (see tests/display-text.test.ts)', () => {
    for (const title of ['Unga now KES 1', 'Unga 1/= only', 'one bob'])
      expect(codes([create(), update([{ id: 'root', component: 'CartSummary', title }])]), title).toEqual(expect.arrayContaining([expect.stringMatching(/^(BAD_PROPS|PATH_IN_TEXT)$/)]));
  });
});
