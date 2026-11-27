/**
 * Builders for the A2UI v1.0 messages the planner and action handlers emit.
 * Only catalog component names, product ids, enums and trusted label keys go in.
 * There is no free display text anywhere in a message.
 */
import { A2UI_VERSION, DUKA_CATALOG_ID } from '@/lib/a2ui/catalog-api';
import type { Heading } from '@/lib/a2ui/trusted-text';
import type { A2uiComponent, A2uiMessage } from '@/lib/a2ui/validate';
import { CATEGORIES, PRODUCTS, type Product } from '@/lib/catalog';

const v = A2UI_VERSION;

export function surface(surfaceId: string, components: A2uiComponent[]): A2uiMessage[] {
  return [
    { version: v, createSurface: { surfaceId, catalogId: DUKA_CATALOG_ID } },
    { version: v, updateComponents: { surfaceId, components } },
  ];
}

/**
 * Codex live review 9: a grid card's component id follows the product (its catalog index), not its position,
 * so a narrowed follow-up keeps the surviving card's component and DOM node. Component ids must be UAX #31
 * identifiers (no dashes), hence the index. An id outside the catalog or a repeat falls back to its position.
 */
export function gridCardIds(productIds: readonly string[]): string[] {
  const ids: string[] = [];
  for (const [i, pid] of productIds.entries()) {
    const k = PRODUCTS.findIndex((c) => c.id === pid);
    const id = k >= 0 ? `p${k}` : `q${i}`;
    ids.push(ids.includes(id) ? `q${i}` : id);
  }
  return ids;
}

export function productsSurface(sid: string, heading: Heading, products: Product[]): A2uiMessage[] {
  const shown = products.slice(0, 12);
  const ids = gridCardIds(shown.map((p) => p.id));
  return surface(sid, [
    { id: 'root', component: 'ProductGrid', heading, children: ids },
    ...shown.map((p, i) => ({
      id: ids[i],
      component: 'ProductCard',
      productId: p.id,
      onAdd: { event: { name: 'add_to_cart', context: { productId: p.id } } },
    })),
  ]);
}

export function chipsSurface(sid: string, selected?: string): A2uiMessage[] {
  return surface(sid, [{ id: 'root', component: 'FilterChips', categories: [...CATEGORIES], ...(selected ? { selected } : {}) }]);
}

export function compareSurface(sid: string, ids: string[]): A2uiMessage[] {
  return surface(sid, [{ id: 'root', component: 'CompareTable', productIds: ids.slice(0, 3) }]);
}

export function cartSurface(sid: string): A2uiMessage[] {
  return surface(sid, [{ id: 'root', component: 'CartSummary' }]);
}

export function stepperSurface(sid: string, productId: string): A2uiMessage[] {
  return surface(sid, [{ id: 'root', component: 'QuantityStepper', productId }]);
}

export function handoffSurface(sid: string): A2uiMessage[] {
  return surface(sid, [{ id: 'root', component: 'CheckoutHandoff', onContinue: { event: { name: 'go_to_checkout', context: {} } } }]);
}

export function orderSurface(sid: string, orderId: string): A2uiMessage[] {
  return surface(sid, [{ id: 'root', component: 'OrderStatusCard', orderId }]);
}
