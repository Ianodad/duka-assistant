/** Order state machine. Terminal states never change. */
export type OrderState = 'pending' | 'paid' | 'failed' | 'cancelled';

export const TERMINAL: ReadonlySet<OrderState> = new Set(['paid', 'failed', 'cancelled']);

const ALLOWED: Record<OrderState, readonly OrderState[]> = {
  pending: ['paid', 'failed', 'cancelled'],
  paid: [],
  failed: [],
  cancelled: [],
};

export function isTerminal(s: OrderState): boolean {
  return TERMINAL.has(s);
}

export function canTransition(from: OrderState, to: OrderState): boolean {
  return ALLOWED[from].includes(to);
}
