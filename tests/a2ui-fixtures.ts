/** Shared helpers for the week 2 A2UI tests. */
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createStrictProcessor, dukaApiCatalog, DUKA_CATALOG_ID } from '@/lib/a2ui/catalog-api';
import { validateA2ui } from '@/lib/a2ui/validate';
import { ProductCardView } from '@/components/assistant/views';

export const CAT = DUKA_CATALOG_ID;
export const create = (surfaceId = 's1') => ({ version: '1.0', createSurface: { surfaceId, catalogId: CAT } });
export const update = (components: unknown[], surfaceId = 's1') => ({ version: '1.0', updateComponents: { surfaceId, components } });
export const dataModel = (value: unknown, surfaceId = 's1') => ({ version: '1.0', updateDataModel: { surfaceId, path: '/', value } });
export const one = (component: Record<string, unknown>) => [create(), update([{ id: 'root', ...component }])];

export function codes(raw: unknown): string[] {
  const r = validateA2ui(raw);
  return r.ok ? [] : r.diagnostics.map((d) => d.code);
}

export const html = (el: ReactElement) => renderToStaticMarkup(el);

/** Runs an accepted batch through the strict library processor and renders a ProductCard by its accepted props. */
export function renderAcceptedCard(raw: unknown[], componentId: string, surfaceId = 's1'): string {
  const v = validateA2ui(raw);
  if (!v.ok) throw new Error(`rejected: ${v.diagnostics.map((d) => d.code).join(',')}`);
  const p = createStrictProcessor(dukaApiCatalog);
  if (p.processMessagesWithErrors(v.messages as never).length) throw new Error('library rejected');
  const props = p.getSurface(surfaceId)!.componentsModel.get(componentId)!.properties as { productId: string; badge?: string };
  return html(createElement(ProductCardView, { productId: props.productId, badge: props.badge, inCart: 0, onAdd: () => {} }));
}
