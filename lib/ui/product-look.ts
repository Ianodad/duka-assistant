/** Per-category tile tint for product image areas (emoji on a painted tile). */
const TINTS: Record<string, string> = {
  Flour: 'bg-[#FBEFC8]',
  Vegetables: 'bg-[#DDF0D6]',
  Tea: 'bg-[#F3E3D3]',
  Cooking: 'bg-[#FCEBC0]',
  Baking: 'bg-[#F6E2CF]',
  Spreads: 'bg-[#DCE8F7]',
  Spices: 'bg-[#F8DDD3]',
  Household: 'bg-[#E2E4F7]',
  Sugar: 'bg-[#F7E1EC]',
  Dairy: 'bg-[#E3EEF4]',
  Snacks: 'bg-[#FBE3C6]',
};

export function tileTint(category: string | undefined): string {
  // Own keys only: agent-supplied text such as '__proto__' falls back to the default tint.
  return (category && Object.hasOwn(TINTS, category) && TINTS[category]) || 'bg-[#E9EEE7]';
}

/** Stock wording shared by the shop grid and the A2UI ProductCard. */
export function stockState(stock: number): { label: string; tone: 'ok' | 'low' | 'out' } {
  if (stock <= 0) return { label: 'Out of stock', tone: 'out' };
  if (stock <= 12) return { label: `Only ${stock} left`, tone: 'low' };
  return { label: `${stock} in stock`, tone: 'ok' };
}
