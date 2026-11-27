/**
 * Main-area assistant canvas copy (SPEC-LIVE AC-L23 to AC-L25).
 *
 * The cards of the newest assistant render show in a canvas at the top of the
 * storefront main area; the chat keeps a short pointer line per turn. Both the
 * canvas title row and the pointer line are FIXED trusted copy filled with
 * server data only: counts of catalog cards the server built, a category from
 * the catalog list, the budget the server used to filter the grid. Never model
 * free text, never raw shopper text.
 *
 * The server computes a CanvasMeta from the validated A2UI messages it sends
 * (canvasMetaFrom); the panel re-checks it with parseCanvasMeta and renders
 * canvasTitleText / canvasPointerText. Anything off the allowlist is dropped.
 */
import { CATEGORIES, formatKES } from '@/lib/catalog';

export const CANVAS_TITLE_KEYS = ['results', 'results_budget', 'results_category', 'compare', 'basket', 'checkout', 'order', 'categories'] as const;
export type CanvasTitleKey = (typeof CANVAS_TITLE_KEYS)[number];
export type CanvasTitle = { key: CanvasTitleKey; n?: number; budgetKES?: number; category?: string };

export const CANVAS_POINTER_KEYS = ['results', 'compare', 'basket', 'checkout', 'order', 'categories'] as const;
export type CanvasPointerKey = (typeof CANVAS_POINTER_KEYS)[number];
export type CanvasPointer = { key: CanvasPointerKey; n?: number };

export type CanvasMeta = { title: CanvasTitle; pointer: CanvasPointer };

/** Bounds for server numbers the panel accepts. Grids hold at most 12 cards, compares 3. */
const MAX_COUNT = 50;
const MAX_BUDGET = 1_000_000;

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_COUNT;
const isBudget = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_BUDGET;
const isCategory = (v: unknown): v is string => typeof v === 'string' && (CATEGORIES as readonly string[]).includes(v);

export function canvasTitleText(t: CanvasTitle): string {
  switch (t.key) {
    case 'results':
      return 'Results';
    case 'results_budget':
      return `Results: under ${formatKES(t.budgetKES ?? 0)}`;
    case 'results_category':
      return `Results: ${t.category ?? ''}`;
    case 'compare':
      return `Compare: ${t.n ?? 0} products`;
    case 'basket':
      return 'Your basket';
    case 'checkout':
      return 'Checkout';
    case 'order':
      return 'Your order';
    case 'categories':
      return 'Shop by category';
  }
}

export function canvasPointerText(p: CanvasPointer): string {
  switch (p.key) {
    case 'results':
      return `Showing ${p.n ?? 0} ${p.n === 1 ? 'result' : 'results'} in the main view`;
    case 'compare':
      return 'Showing the comparison in the main view';
    case 'basket':
      return 'Showing your basket in the main view';
    case 'checkout':
      return 'Checkout is ready in the main view';
    case 'order':
      return 'Showing your order in the main view';
    case 'categories':
      return 'Showing categories in the main view';
  }
}

/** Untrusted (a response body) to a CanvasMeta, or undefined. Unknown keys, bad numbers and unknown categories are refused. */
export function parseCanvasMeta(raw: unknown): CanvasMeta | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const { title, pointer } = raw as { title?: unknown; pointer?: unknown };
  if (!title || typeof title !== 'object' || !pointer || typeof pointer !== 'object') return undefined;
  const t = title as Record<string, unknown>;
  const p = pointer as Record<string, unknown>;
  if (!(CANVAS_TITLE_KEYS as readonly unknown[]).includes(t.key) || !(CANVAS_POINTER_KEYS as readonly unknown[]).includes(p.key)) return undefined;
  const tk = t.key as CanvasTitleKey;
  const pk = p.key as CanvasPointerKey;
  let ct: CanvasTitle;
  if (tk === 'results_budget') {
    if (!isBudget(t.budgetKES)) return undefined;
    ct = { key: tk, budgetKES: t.budgetKES };
  } else if (tk === 'results_category') {
    if (!isCategory(t.category)) return undefined;
    ct = { key: tk, category: t.category };
  } else if (tk === 'compare') {
    if (!isCount(t.n)) return undefined;
    ct = { key: tk, n: t.n };
  } else ct = { key: tk };
  let cp: CanvasPointer;
  if (pk === 'results') {
    if (!isCount(p.n)) return undefined;
    cp = { key: pk, n: p.n };
  } else cp = { key: pk };
  return { title: ct, pointer: cp };
}

type Root = { component: string; productCount: number; category?: string };

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Root component per surface from validated A2UI messages (server data), in send order. */
function rootsOf(messages: readonly unknown[]): Root[] {
  const out: Root[] = [];
  for (const m of messages) {
    if (!isObj(m) || !isObj(m.updateComponents)) continue;
    const comps = Array.isArray(m.updateComponents.components) ? m.updateComponents.components.filter(isObj) : [];
    const root = comps.find((c) => c.id === 'root');
    if (!root || typeof root.component !== 'string') continue;
    const productCount =
      root.component === 'ProductGrid'
        ? comps.filter((c) => c.component === 'ProductCard').length
        : Array.isArray(root.productIds)
          ? root.productIds.length
          : 0;
    const heading = isObj(root.heading) ? root.heading : undefined;
    const category = heading?.key === 'category' && isCategory(heading.category) ? heading.category : isCategory(root.selected) ? root.selected : undefined;
    out.push({ component: root.component, productCount, category });
  }
  return out;
}

/**
 * The canvas title and pointer for one validated render. Priority follows what the shopper asked to see:
 * checkout, order, compare, results, basket (CartSummary or a lone stepper), categories (chips alone).
 * budgetKES: the server-side maxPriceKES that filtered the grid this turn (loop.ts), if any.
 */
export function canvasMetaFrom(messages: readonly unknown[], opts: { budgetKES?: number } = {}): CanvasMeta | undefined {
  const roots = rootsOf(messages);
  if (!roots.length) return undefined;
  const has = (name: string) => roots.find((r) => r.component === name);
  if (has('CheckoutHandoff')) return { title: { key: 'checkout' }, pointer: { key: 'checkout' } };
  if (has('OrderStatusCard')) return { title: { key: 'order' }, pointer: { key: 'order' } };
  const cmp = has('CompareTable');
  if (cmp) return { title: { key: 'compare', n: Math.min(cmp.productCount, MAX_COUNT) }, pointer: { key: 'compare' } };
  const grids = roots.filter((r) => r.component === 'ProductGrid');
  if (grids.length) {
    const n = Math.min(
      grids.reduce((s, g) => s + g.productCount, 0),
      MAX_COUNT,
    );
    const budget = opts.budgetKES !== undefined && isBudget(Math.floor(opts.budgetKES)) ? Math.floor(opts.budgetKES) : undefined;
    const category = grids.find((g) => g.category)?.category ?? roots.find((r) => r.component === 'FilterChips' && r.category)?.category;
    const title: CanvasTitle = budget !== undefined ? { key: 'results_budget', budgetKES: budget } : category ? { key: 'results_category', category } : { key: 'results' };
    return { title, pointer: { key: 'results', n } };
  }
  if (has('CartSummary') || has('QuantityStepper')) return { title: { key: 'basket' }, pointer: { key: 'basket' } };
  if (has('FilterChips')) return { title: { key: 'categories' }, pointer: { key: 'categories' } };
  return undefined;
}
