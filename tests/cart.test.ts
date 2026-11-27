import { describe, expect, it } from 'vitest';
import { addItem, cartSignature, CartError, computeCart, MAX_QTY, removeItem, setQty, viewCart } from '@/lib/shop/cart';

const sid = () => `t_${Math.random().toString(36).slice(2)}_xxxxxxxxxxxxxxxxxxxxxxxx`;

describe('cart math', () => {
  it('computes line totals and subtotal from catalog prices', () => {
    const v = computeCart([
      { productId: 'unga-2kg', qty: 2 },
      { productId: 'sukuma-bunch', qty: 3 },
    ]);
    expect(v.lines.map((l) => l.lineTotalKES)).toEqual([350, 90]);
    expect(v.subtotalKES).toBe(440);
    expect(v.itemCount).toBe(5);
  });
  it('ignores unknown products and bad quantities', () => {
    const v = computeCart([
      { productId: 'nope', qty: 1 },
      { productId: 'unga-2kg', qty: 0 },
      { productId: 'unga-2kg', qty: 1.5 },
    ]);
    expect(v.subtotalKES).toBe(0);
  });
  it('add, change qty, remove', () => {
    const s = sid();
    addItem(s, 'unga-2kg');
    addItem(s, 'unga-2kg', 2);
    expect(viewCart(s).subtotalKES).toBe(525);
    setQty(s, 'unga-2kg', 1);
    expect(viewCart(s).subtotalKES).toBe(175);
    addItem(s, 'ketepa-100');
    removeItem(s, 'unga-2kg');
    expect(viewCart(s).lines.map((l) => l.product.id)).toEqual(['ketepa-100']);
  });
  it('rejects bad input', () => {
    const s = sid();
    expect(() => addItem(s, 'nope')).toThrow(CartError);
    expect(() => addItem(s, 'unga-2kg', -1)).toThrow(CartError);
    expect(() => addItem(s, 'unga-2kg', MAX_QTY + 1)).toThrow(CartError);
    expect(() => setQty(s, 'unga-2kg', 2)).toThrow(CartError);
  });
  it('caps accumulated quantity', () => {
    const s = sid();
    addItem(s, 'unga-2kg', MAX_QTY);
    addItem(s, 'unga-2kg', 5);
    expect(viewCart(s).itemCount).toBe(MAX_QTY);
  });
  it('carts are per session', () => {
    const a = sid();
    addItem(a, 'unga-2kg');
    expect(viewCart(sid()).subtotalKES).toBe(0);
    expect(viewCart(undefined).subtotalKES).toBe(0);
  });
  it('signature is order independent', () => {
    expect(cartSignature([{ productId: 'b', qty: 1 }, { productId: 'a', qty: 2 }])).toBe(cartSignature([{ productId: 'a', qty: 2 }, { productId: 'b', qty: 1 }]));
  });
});
