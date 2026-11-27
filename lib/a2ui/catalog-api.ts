/**
 * Duka trusted A2UI catalog: component APIs only (zod schemas, no React).
 * Isomorphic: used by the server routes, the client panel and the tests.
 *
 * Rules for every component:
 * - props are plain literals (no data bindings), validated by a strict schema;
 * - NO free display text: every prop is an id, an enum, a child list, an
 *   action, or a trusted label key (lib/a2ui/trusted-text.ts). Display words
 *   are produced by our code, so the agent cannot write an amount or a URL;
 * - products are referenced by catalog id only: names, prices and stock are
 *   looked up by the renderer, never taken from the message;
 * - no HTML, URLs, class names, styles or handler code can be expressed.
 * Agent-wired actions are limited (see AGENT_ACTION_SLOTS in ./actions.ts).
 */
import { Catalog, MessageProcessor, STRICT_VALIDATION, type ActionListener, type ComponentApi } from '@a2ui/web_core';
import { CommonSchemas } from '@a2ui/web_core/v1_0';
import { z } from 'zod';
import { CATEGORIES, PRODUCTS } from '@/lib/catalog';
import { CategorySchema, OrderIdSchema, ProductIdSchema } from './ids';
import { HeadingSchema } from './trusted-text';

export { CategorySchema, OrderIdSchema, ProductIdSchema };

export const DUKA_CATALOG_ID = 'https://duka.local/a2ui/catalog/v2';
export const A2UI_VERSION = '1.0' as const;

const S = CommonSchemas;

export const ProductGridApi = {
  name: 'ProductGrid',
  schema: z.object({ heading: HeadingSchema.optional(), children: S.ChildList }).strict(),
} satisfies ComponentApi;

export const ProductCardApi = {
  name: 'ProductCard',
  schema: z
    .object({
      productId: ProductIdSchema,
      badge: z.enum(['Best value', 'Lowest price', 'Popular']).optional(),
      onAdd: S.Action.optional(),
    })
    .strict(),
} satisfies ComponentApi;

export const CompareTableApi = {
  name: 'CompareTable',
  schema: z
    .object({
      productIds: z.array(ProductIdSchema).min(2).max(3),
    })
    .strict(),
} satisfies ComponentApi;

export const CartSummaryApi = {
  name: 'CartSummary',
  schema: z.object({}).strict(),
} satisfies ComponentApi;

export const QuantityStepperApi = {
  name: 'QuantityStepper',
  schema: z.object({ productId: ProductIdSchema }).strict(),
} satisfies ComponentApi;

/**
 * counts (SPEC-LIVE AC-L16): when present, one integer per category, set by the server from the
 * products shown in the same render (lib/assistant/claude/loop.ts deriveChips). Without counts the
 * view shows whole-catalog counts (the regex planner's "browse categories" chips). Categories are
 * unique; selected must be one of them (both checked in lib/a2ui/validate.ts, BAD_PROPS).
 */
export const FilterChipsApi = {
  name: 'FilterChips',
  schema: z
    .object({
      categories: z.array(CategorySchema).min(1).max(CATEGORIES.length),
      counts: z.array(z.number().int().min(1).max(PRODUCTS.length)).max(CATEGORIES.length).optional(),
      selected: CategorySchema.optional(),
    })
    .strict(),
} satisfies ComponentApi;

/** Shows the cart total (server snapshot) and a "Go to checkout" button. It cannot pay. */
export const CheckoutHandoffApi = {
  name: 'CheckoutHandoff',
  schema: z.object({ onContinue: S.Action.optional() }).strict(),
} satisfies ComponentApi;

export const OrderStatusCardApi = {
  name: 'OrderStatusCard',
  schema: z.object({ orderId: OrderIdSchema }).strict(),
} satisfies ComponentApi;

export const DUKA_COMPONENT_APIS = [
  ProductGridApi,
  ProductCardApi,
  CompareTableApi,
  CartSummaryApi,
  QuantityStepperApi,
  FilterChipsApi,
  CheckoutHandoffApi,
  OrderStatusCardApi,
] as const;

export type DukaComponentName = (typeof DUKA_COMPONENT_APIS)[number]['name'];
export const DUKA_COMPONENT_NAMES: readonly string[] = DUKA_COMPONENT_APIS.map((a) => a.name);
export const COMPONENT_SCHEMAS: Record<string, z.ZodTypeAny> = Object.fromEntries(DUKA_COMPONENT_APIS.map((a) => [a.name, a.schema]));

/** API-only catalog (no renderers): server-side and test validation. */
export const dukaApiCatalog = new Catalog(DUKA_CATALOG_ID, A2UI_VERSION, [...DUKA_COMPONENT_APIS], []);

/** Strict processor: the package default (relaxed) silently accepts unknown component types. */
export function createStrictProcessor<T extends ComponentApi>(catalog: Catalog<T>, onAction?: ActionListener): MessageProcessor<T> {
  return new MessageProcessor<T>([catalog], onAction, { version: A2UI_VERSION, validationConfig: { ...STRICT_VALIDATION } });
}
