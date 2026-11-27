/**
 * Slot notes (SPEC-LIVE AC-L19, canvas wording AC-L25). When a follow-up reuses
 * the surface of an earlier card, the earlier turn's pointer line in the chat
 * changes to this marker (the cards themselves live in the main-area canvas).
 * The server classifies how the new card relates to the old one from shop
 * data only (component names and catalog product ids, never model text) and
 * sends a KEY per replaced surface; the panel renders this trusted copy.
 */
export const SLOT_NOTE_TEXT = {
  updated: 'Updated in the main view',
  moved_search: 'Moved to your search results',
  moved_cart: 'Moved to your basket',
  moved_checkout: 'Moved to checkout',
  moved_order: 'Moved to your order',
  replaced: 'Replaced in the main view',
} as const;
export type SlotNoteKey = keyof typeof SLOT_NOTE_TEXT;
export type SlotNote = { id: string; key: SlotNoteKey };

export function isSlotNoteKey(v: unknown): v is SlotNoteKey {
  return typeof v === 'string' && Object.hasOwn(SLOT_NOTE_TEXT, v);
}

/** What the classifier reads about a card: its root component and catalog ids (server data). */
export type SlotCard = { component: string; productIds?: readonly string[]; orderId?: string };

const PRODUCT_CARDS = new Set(['ProductGrid', 'CompareTable']);
const CART_CARDS = new Set(['CartSummary', 'QuantityStepper']);
const KNOWN_CARDS = new Set([...PRODUCT_CARDS, ...CART_CARDS, 'CheckoutHandoff', 'OrderStatusCard', 'FilterChips']);

const subsetOf = (next: readonly string[], prev: readonly string[]) => {
  const p = new Set(prev);
  return next.length > 0 && next.every((id) => p.has(id));
};

/**
 * How the card that took over a surface relates to the card that was there.
 * Unknown or missing cards fall through to the generic `replaced`.
 */
export function classifySlot(prev: SlotCard | undefined, next: SlotCard | undefined): SlotNoteKey {
  if (!prev || !next || !KNOWN_CARDS.has(prev.component) || !KNOWN_CARDS.has(next.component)) return 'replaced';
  const a = prev.component;
  const b = next.component;
  if (PRODUCT_CARDS.has(b)) return PRODUCT_CARDS.has(a) && subsetOf(next.productIds ?? [], prev.productIds ?? []) ? 'updated' : 'moved_search';
  if (CART_CARDS.has(b)) return CART_CARDS.has(a) ? 'updated' : 'moved_cart';
  if (b === 'CheckoutHandoff') return a === 'CheckoutHandoff' ? 'updated' : 'moved_checkout';
  if (b === 'OrderStatusCard') return a === 'OrderStatusCard' && prev.orderId !== undefined && prev.orderId === next.orderId ? 'updated' : 'moved_order';
  return a === b ? 'updated' : 'replaced';
}

/** Untrusted list (a response body) to one valid note per allowed id, in `ids` order. Missing or bad keys become `replaced`. */
export function slotNotesFor(ids: readonly string[], raw: unknown): SlotNote[] {
  const given = new Map<string, SlotNoteKey>();
  if (Array.isArray(raw)) {
    for (const n of raw) {
      if (!n || typeof n !== 'object') continue;
      const { id, key } = n as { id?: unknown; key?: unknown };
      if (typeof id === 'string' && isSlotNoteKey(key) && !given.has(id)) given.set(id, key);
    }
  }
  return [...new Set(ids)].map((id) => ({ id, key: given.get(id) ?? 'replaced' }));
}
