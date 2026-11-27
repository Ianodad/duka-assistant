// AC-L31: a key/category pairing-mismatch heading on a ProductGrid is dropped (the grid renders without a heading, no default
// heading exists), never fatal; every other bad heading and every other guard is unchanged.
import { describe, expect, it } from 'vitest';
import { dropBadHeadings, mapRender } from '@/lib/assistant/claude/loop';

const IDS = ['sukuma-bunch', 'royco-200g', 'brookside-milk-500ml', 'tropical-heat-crisps'];
const CTX = { budgetKES: 100 };
const render = (grid: Record<string, unknown>, extra: unknown[] = [{ component: 'FilterChips' }]) => ({
  reply: { key: 'price_filtered' },
  components: [{ component: 'ProductGrid', productIds: IDS, ...grid }, ...extra],
});
type Comp = Record<string, unknown>;
const comps = (messages: unknown[]) => (messages as Array<{ updateComponents?: { components: Comp[] } }>).flatMap((m) => m.updateComponents?.components ?? []);
const gridRoot = (messages: unknown[]) => comps(messages).find((c) => c.id === 'root' && c.component === 'ProductGrid');
const shownIds = (messages: unknown[]) => comps(messages).filter((c) => c.component === 'ProductCard').map((c) => c.productId);

const BAD: Array<[string, unknown]> = [
  ['category without category', { key: 'category' }],
  ['search_results with category', { key: 'search_results', category: 'Vegetables' }],
  ['all_products with category', { key: 'all_products', category: 'Vegetables' }],
];

describe('bad heading is dropped (AC-L31)', () => {
  for (const [label, heading] of BAD) {
    it(`renders without the heading: ${label}`, () => {
      const r = mapRender(render({ heading }), 1, CTX);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const root = gridRoot(r.messages)!;
      expect(root).toBeTruthy();
      expect(Object.hasOwn(root, 'heading')).toBe(false);
      expect(shownIds(r.messages)).toEqual(IDS);
    });
  }

  it('keeps a valid heading', () => {
    const r = mapRender(render({ heading: { key: 'category', category: 'Vegetables' } }), 1, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(gridRoot(r.messages)!.heading).toEqual({ key: 'category', category: 'Vegetables' });
    expect(shownIds(r.messages)).toEqual(IDS);
  });
});

describe('everything else still rejected (AC-L31)', () => {
  const bad = { key: 'category' };

  it('unknown product id plus a bad heading', () => {
    const r = mapRender(render({ heading: bad, productIds: [...IDS, 'no-such-product'] }), 1, CTX);
    expect(r).toEqual({ ok: false, codes: expect.arrayContaining(['RENDER_SCHEMA']) });
    // heading is dropped, so the heading is not the reason: the same input without a heading is rejected identically
    const plain = mapRender(render({ productIds: [...IDS, 'no-such-product'] }), 1, CTX);
    expect(r).toEqual(plain);
  });

  it('unknown component name', () => {
    const r = mapRender(render({ heading: bad }, [{ component: 'EvilWidget' }]), 1, CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codes).toContain('RENDER_SCHEMA');
  });

  it('a heading on a CompareTable', () => {
    const r = mapRender({ reply: { key: 'compare_shown' }, components: [{ component: 'CompareTable', productIds: ['sukuma-bunch', 'royco-200g'], heading: bad }] }, 1, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codes).toContain('RENDER_SCHEMA');
  });

  it('an over-budget product with a bad heading', () => {
    const r = mapRender(render({ heading: bad, productIds: ['sukuma-bunch', 'ketepa-100'] }), 1, CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codes).toContain('OVER_BUDGET');
  });
});

describe('other bad headings are NOT dropped (hostile text still rejects, AC-L31)', () => {
  // Codes recorded from mapRender on the HEAD loop.ts (budgetKES 100, the four cheap products, price_filtered).
  const CASES: Array<[string, unknown, string[]]> = [
    ['string heading', 'KES 1/-', ['PATH_IN_TEXT', 'RENDER_SCHEMA']],
    ['unknown key', { key: 'nope' }, ['BAD_PROPS', 'RENDER_SCHEMA']],
    ['free-text category', { key: 'category', category: 'KES 1 only' }, ['BAD_PROPS', 'RENDER_SCHEMA']],
    ['extra prop', { key: 'search_results', extra: 'x' }, ['BAD_PROPS', 'RENDER_SCHEMA']],
  ];
  for (const [label, heading, codes] of CASES) {
    it(`${label}: heading kept and the render rejects as before`, () => {
      const comp = { component: 'ProductGrid', heading, productIds: ['sukuma-bunch'] };
      const out = dropBadHeadings([comp]);
      expect(out[0]).toBe(comp);
      expect((out[0] as Comp).heading).toEqual(heading);
      expect(mapRender(render({ heading }), 1, CTX)).toEqual({ ok: false, codes });
    });
  }
});

describe('dropBadHeadings', () => {
  it('does not mutate its input and passes other components through', () => {
    const input = [
      { component: 'ProductGrid', productIds: ['sukuma-bunch'], heading: { key: 'category' } },
      { component: 'ProductGrid', productIds: ['royco-200g'], heading: { key: 'all_products' } },
      { component: 'CompareTable', productIds: ['a', 'b'], heading: { key: 'category' } },
      { component: 'ProductGrid', productIds: ['royco-200g'] },
      'junk',
      null,
    ];
    const before = JSON.stringify(input);
    const frozen = structuredClone(input);
    const deepFreeze = (o: unknown): void => {
      if (o && typeof o === 'object') {
        Object.freeze(o);
        Object.values(o).forEach(deepFreeze);
      }
    };
    deepFreeze(frozen);
    const out = dropBadHeadings(frozen);
    expect(JSON.stringify(frozen)).toBe(before);
    expect(out[0]).toEqual({ component: 'ProductGrid', productIds: ['sukuma-bunch'] });
    expect(out[0]).not.toBe(frozen[0]);
    expect(out[1]).toBe(frozen[1]); // valid heading: same object
    expect(out[2]).toBe(frozen[2]); // not a ProductGrid: untouched
    expect(out[3]).toBe(frozen[3]);
    expect(out[4]).toBe('junk');
    expect(out[5]).toBeNull();
  });
});
