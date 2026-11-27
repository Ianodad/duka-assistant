/**
 * Duka assistant tools, defined once in the MCP tool shape (name, description,
 * input_schema as JSON Schema). The Claude planner sends these to the Messages
 * API; a later MCP or WebMCP server can expose the same list (toMcpTool).
 *
 * There is no payment tool. place_mock_order only hands the shopper to
 * /checkout, where the shopper taps Pay themselves.
 *
 * Each tool also has a strict zod schema; handlers parse with it, so a schema
 * the model ignores still cannot pass bad input through.
 */
import { z } from 'zod';
import { CATEGORIES, PRODUCTS } from '@/lib/catalog';
import { CategorySchema, OrderIdSchema, ProductIdSchema } from '@/lib/a2ui/ids';
import { HeadingSchema, ReplySchema } from '@/lib/a2ui/trusted-text';

export type JsonSchema = { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };
export type DukaTool = { name: string; description: string; input_schema: JsonSchema };

const PRODUCT_IDS = PRODUCTS.map((p) => p.id);
const productId = { type: 'string', enum: PRODUCT_IDS, description: 'A catalog product id.' };
const category = { type: 'string', enum: [...CATEGORIES] };
const qty = { type: 'integer', minimum: 1, maximum: 20 };
const obj = (properties: Record<string, unknown>, required: string[] = []): JsonSchema => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });

const Qty = z.number().int().min(1).max(20);
/** Budget filter in whole KES (for "under 200 bob"). The shop filters by its own prices. */
export const MAX_PRICE_KES = 100_000;
const MaxPrice = z.number().int().min(1).max(MAX_PRICE_KES);
const maxPriceKES = { type: 'integer', minimum: 1, maximum: MAX_PRICE_KES, description: 'Only products whose catalog price is at or under this many KES.' };

export const TOOL_INPUTS = {
  search_products: z.object({ query: z.string().min(1).max(60), maxPriceKES: MaxPrice.optional() }).strict(),
  list_products: z.object({ category: CategorySchema.optional(), maxPriceKES: MaxPrice.optional() }).strict(),
  get_product: z.object({ productId: ProductIdSchema }).strict(),
  view_cart: z.object({}).strict(),
  add_to_cart: z.object({ productId: ProductIdSchema, qty: Qty.optional() }).strict(),
  update_cart_quantity: z.object({ productId: ProductIdSchema, qty: Qty }).strict(),
  remove_from_cart: z.object({ productId: ProductIdSchema }).strict(),
  place_mock_order: z.object({}).strict(),
  list_orders: z.object({}).strict(),
} as const;
export type DataToolName = keyof typeof TOOL_INPUTS;

export const DATA_TOOLS: DukaTool[] = [
  { name: 'search_products', description: 'Search the shop catalog by words in the product name, category or description. Returns matching products with ids and catalog prices. maxPriceKES keeps only products at or under that price.', input_schema: obj({ query: { type: 'string', minLength: 1, maxLength: 60 }, maxPriceKES }, ['query']) },
  { name: 'list_products', description: 'List catalog products, optionally only one category and only at or under maxPriceKES (use it for budget asks like "under 200 bob").', input_schema: obj({ category, maxPriceKES }) },
  { name: 'get_product', description: 'Get one catalog product by id.', input_schema: obj({ productId }, ['productId']) },
  { name: 'view_cart', description: "View the shopper's basket: lines, item count and subtotal from the server.", input_schema: obj({}) },
  { name: 'add_to_cart', description: "Add a product to the shopper's basket. qty defaults to 1, at most 20 per product.", input_schema: obj({ productId, qty }, ['productId']) },
  { name: 'update_cart_quantity', description: 'Set the quantity of a product already in the basket (1 to 20).', input_schema: obj({ productId, qty }, ['productId', 'qty']) },
  { name: 'remove_from_cart', description: 'Remove a product from the basket.', input_schema: obj({ productId }, ['productId']) },
  {
    name: 'place_mock_order',
    description: 'Prepare checkout. This does NOT pay and does NOT create an order: it returns a checkout handoff. The shopper opens checkout, checks the total and taps Pay there themselves. Render a CheckoutHandoff component afterwards.',
    input_schema: obj({}),
  },
  { name: 'list_orders', description: "List the shopper's recent orders in this session (id, state, amount).", input_schema: obj({}) },
];

// ---------- render_ui: the only way the model answers the shopper ----------

const RenderComponent = z.discriminatedUnion('component', [
  z.object({ component: z.literal('ProductGrid'), heading: HeadingSchema.optional(), productIds: z.array(ProductIdSchema).min(1).max(12) }).strict(),
  z.object({ component: z.literal('CompareTable'), productIds: z.array(ProductIdSchema).min(2).max(3) }).strict(),
  z.object({ component: z.literal('CartSummary') }).strict(),
  z.object({ component: z.literal('QuantityStepper'), productId: ProductIdSchema }).strict(),
  z.object({ component: z.literal('FilterChips'), selected: CategorySchema.optional() }).strict(),
  z.object({ component: z.literal('CheckoutHandoff') }).strict(),
  z.object({ component: z.literal('OrderStatusCard'), orderId: OrderIdSchema }).strict(),
]);
export type RenderComponent = z.infer<typeof RenderComponent>;
export const MAX_RENDER_COMPONENTS = 4;
/**
 * Live review 4: every displayed product is counted exactly once and chips render once. The validator refuses a render
 * with a product id twice in one ProductGrid or CompareTable, a product id in two ProductGrids, or two FilterChips.
 * (mapRender in loop.ts de-duplicates model input BEFORE this check, so these only fire on a mapping bug.)
 */
export const RenderInputSchema = z
  .object({ reply: ReplySchema, components: z.array(RenderComponent).min(1).max(MAX_RENDER_COMPONENTS), replacePrevious: z.boolean().optional() })
  .strict()
  .superRefine((v, ctx) => {
    const gridSeen = new Set<string>();
    let chips = 0;
    v.components.forEach((c, i) => {
      if (c.component === 'FilterChips' && ++chips > 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['components', i], message: 'one FilterChips per render' });
      if (c.component === 'ProductGrid' || c.component === 'CompareTable') {
        if (new Set(c.productIds).size !== c.productIds.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['components', i, 'productIds'], message: 'duplicate product id' });
      }
      if (c.component === 'ProductGrid') {
        for (const id of c.productIds) {
          if (gridSeen.has(id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['components', i, 'productIds'], message: 'product in two grids' });
          gridSeen.add(id);
        }
      }
    });
  });
export const RenderComponentSchema = RenderComponent;

const REPLY_KEYS = ReplySchema.options.map((o) => o.shape.key.value);

/**
 * AC-L30: the render_ui JSON schema for ProductGrid.heading, DERIVED from the zod HeadingSchema so the two cannot
 * drift: an anyOf of one closed object per key. `anyOf`, not `oneOf`: the Anthropic SDK strict transform maps
 * oneOf to anyOf anyway. A variant carries `category` (the catalog enum) only when its zod shape has that field,
 * and requires every non-optional shape key.
 */
export const HEADING_JSON_SCHEMA = {
  description: 'Trusted heading key. search_results and all_products take no other field; category requires a category.',
  anyOf: HeadingSchema.options.map((o) => {
    const shape = o.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = { key: { type: 'string', const: o.shape.key.value } };
    if ('category' in shape) properties.category = category;
    const required = Object.keys(shape).filter((k) => !shape[k].isOptional());
    return { type: 'object', properties, required, additionalProperties: false };
  }),
};

export const RENDER_TOOL: DukaTool = {
  name: 'render_ui',
  description:
    'Answer the shopper. Call this exactly once, last. You cannot write display text: pick a reply key (the shop turns it into words) and 1 to 4 components (at least one card, always) by name with catalog ids. Prices, links and free text are not accepted. Set replacePrevious true when this answer changes the card on the current screen (a follow-up): that card is then updated instead of a new one stacking below.',
  input_schema: obj(
    {
      reply: {
        type: 'object',
        description: 'Trusted reply key. productId is required for added, removed, qty_set, not_in_cart; category for category_shown.',
        properties: { key: { type: 'string', enum: REPLY_KEYS }, productId, category },
        required: ['key'],
        additionalProperties: false,
      },
      components: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_RENDER_COMPONENTS,
        items: {
          type: 'object',
          properties: {
            component: { type: 'string', enum: ['ProductGrid', 'CompareTable', 'CartSummary', 'QuantityStepper', 'FilterChips', 'CheckoutHandoff', 'OrderStatusCard'] },
            heading: HEADING_JSON_SCHEMA,
            productIds: { type: 'array', items: productId, minItems: 1, maxItems: 12 },
            productId,
            selected: category,
            orderId: { type: 'string', pattern: '^ord_[A-Za-z0-9_-]{16}$' },
          },
          required: ['component'],
          additionalProperties: false,
        },
      },
      replacePrevious: { type: 'boolean', description: 'True for a follow-up that changes the card already on screen (same kind of card).' },
    },
    ['reply', 'components'],
  ),
};

/** Everything the Claude planner sends, in a fixed order (stable prompt prefix). */
export const ALL_TOOLS: DukaTool[] = [...DATA_TOOLS, RENDER_TOOL];

/** The same tool in the MCP wire shape (inputSchema), for a week 3 MCP or WebMCP server. */
export function toMcpTool(t: DukaTool): { name: string; description: string; inputSchema: JsonSchema } {
  return { name: t.name, description: t.description, inputSchema: t.input_schema };
}
