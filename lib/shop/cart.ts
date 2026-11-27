/**
 * Server-side cart. The browser only holds an opaque session id cookie; all
 * quantities and totals live and are computed here.
 */
import { getProduct, type Product } from '@/lib/catalog';

import { MAX_QTY } from '@/lib/shop/limits';

export { MAX_QTY };

export type CartItem = { productId: string; qty: number };
export type CartLine = { product: Product; qty: number; lineTotalKES: number };
export type CartView = { lines: CartLine[]; itemCount: number; subtotalKES: number };

type Store = Map<string, CartItem[]>;
const g = globalThis as unknown as { __dukaCarts?: Store };
const carts: Store = (g.__dukaCarts ??= new Map());

export class CartError extends Error {}

function clampQty(qty: unknown): number {
  if (typeof qty !== 'number' || !Number.isInteger(qty)) throw new CartError('Quantity must be a whole number.');
  if (qty < 1 || qty > MAX_QTY) throw new CartError(`Quantity must be between 1 and ${MAX_QTY}.`);
  return qty;
}

function requireProduct(productId: unknown): Product {
  const p = typeof productId === 'string' ? getProduct(productId) : undefined;
  if (!p) throw new CartError('Unknown product.');
  return p;
}

export function getItems(sid: string | undefined): CartItem[] {
  if (!sid) return [];
  return (carts.get(sid) ?? []).map((i) => ({ ...i }));
}

export function addItem(sid: string, productId: unknown, qty: unknown = 1): CartItem[] {
  const p = requireProduct(productId);
  const add = clampQty(qty);
  const items = carts.get(sid) ?? [];
  const existing = items.find((i) => i.productId === p.id);
  if (existing) existing.qty = Math.min(MAX_QTY, existing.qty + add);
  else items.push({ productId: p.id, qty: add });
  carts.set(sid, items);
  return getItems(sid);
}

export function setQty(sid: string, productId: unknown, qty: unknown): CartItem[] {
  const p = requireProduct(productId);
  const n = clampQty(qty);
  const items = carts.get(sid) ?? [];
  const existing = items.find((i) => i.productId === p.id);
  if (!existing) throw new CartError('That product is not in your cart.');
  existing.qty = n;
  return getItems(sid);
}

export function removeItem(sid: string, productId: unknown): CartItem[] {
  const p = requireProduct(productId);
  carts.set(
    sid,
    (carts.get(sid) ?? []).filter((i) => i.productId !== p.id),
  );
  return getItems(sid);
}

export function clearCart(sid: string): void {
  carts.delete(sid);
}

/** Put reserved items back (after a definitive STK rejection). Merges with anything added since. */
export function restoreItems(sid: string, items: CartItem[]): void {
  for (const i of items) addItem(sid, i.productId, Math.min(MAX_QTY, i.qty));
}

/** Pure cart math: prices always come from the catalog, never from the client. */
export function computeCart(items: CartItem[]): CartView {
  const lines: CartLine[] = [];
  for (const i of items) {
    const product = getProduct(i.productId);
    if (!product || !Number.isInteger(i.qty) || i.qty < 1) continue;
    lines.push({ product, qty: i.qty, lineTotalKES: product.priceKES * i.qty });
  }
  return {
    lines,
    itemCount: lines.reduce((n, l) => n + l.qty, 0),
    subtotalKES: lines.reduce((n, l) => n + l.lineTotalKES, 0),
  };
}

export function viewCart(sid: string | undefined): CartView {
  return computeCart(getItems(sid));
}

/** Stable signature of the cart contents, used to bind a checkout token to what the shopper saw. */
export function cartSignature(items: CartItem[]): string {
  return [...items]
    .sort((a, b) => a.productId.localeCompare(b.productId))
    .map((i) => `${i.productId}x${i.qty}`)
    .join('|');
}
