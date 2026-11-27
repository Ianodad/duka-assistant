import { vi } from 'vitest';
import type { DarajaAdapter, StkQueryResult } from '@/lib/daraja/types';

export const SID_A = 'sidAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
export const SID_B = 'sidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

export function spyAdapter(query: StkQueryResult = { state: 'pending' }) {
  const initiateStk = vi.fn(async () => ({ checkoutRequestId: `ws_CO_SPY_${Math.random().toString(36).slice(2)}`, merchantRequestId: 'm-spy' }));
  const queryStk = vi.fn(async () => query);
  const adapter: DarajaAdapter = { mode: 'mock', initiateStk, queryStk };
  return { adapter, initiateStk, queryStk };
}
