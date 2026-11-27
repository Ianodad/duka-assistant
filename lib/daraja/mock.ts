/**
 * Mock Daraja adapter (default mode). Never touches the network.
 * Outcome by the phone's last three digits:
 *   000 -> stays pending (resolve with the mock control route)
 *   111 -> failed (ResultCode 1) after the delay
 *   222 -> cancelled (ResultCode 1032) after the delay
 *   888 -> initiation definitively rejected (as if Daraja answered 4xx)
 *   999 -> initiation outcome unknown (as if the request timed out)
 *   other -> paid (ResultCode 0) after the delay
 */
import { randomBytes } from 'node:crypto';
import type { DarajaAdapter, StkInitiateInput, StkInitiateResult, StkQueryResult } from '@/lib/daraja/types';
import { DarajaError, STK_UNCONFIRMED } from '@/lib/daraja/types';
import { dlog } from '@/lib/daraja/redact';

type Pending = { phone: string; startedAt: number };

export function mockOutcomeForPhone(phone: string): { resultCode: number; resultDesc: string } | null {
  if (phone.endsWith('000')) return null;
  if (phone.endsWith('111')) return { resultCode: 1, resultDesc: 'The balance is insufficient for the transaction.' };
  if (phone.endsWith('222')) return { resultCode: 1032, resultDesc: 'Request cancelled by user.' };
  return { resultCode: 0, resultDesc: 'The service request is processed successfully.' };
}

export function createMockAdapter(opts: { delayMs?: number; now?: () => number } = {}): DarajaAdapter {
  const now = opts.now ?? Date.now;
  const delayMs = opts.delayMs ?? Number(process.env.DUKA_MOCK_DELAY_MS ?? 3000);
  const g = globalThis as unknown as { __dukaMockStk?: Map<string, Pending> };
  const pending: Map<string, Pending> = (g.__dukaMockStk ??= new Map());

  return {
    mode: 'mock',
    async initiateStk(input: StkInitiateInput): Promise<StkInitiateResult> {
      if (!Number.isInteger(input.amountKES) || input.amountKES < 1) throw new DarajaError('Amount must be a positive whole number.', 'bad_amount');
      if (!/^254[17]\d{8}$/.test(input.phone)) throw new DarajaError('Phone must be normalised.', 'bad_phone');
      if (input.phone.endsWith('888')) throw new DarajaError('Mock: STK push rejected.', 'stk_rejected');
      if (input.phone.endsWith('999')) throw new DarajaError('Mock: STK push outcome unknown.', STK_UNCONFIRMED);
      const checkoutRequestId = `ws_CO_MOCK_${randomBytes(9).toString('hex')}`;
      const merchantRequestId = `MOCK-${randomBytes(6).toString('hex')}`;
      pending.set(checkoutRequestId, { phone: input.phone, startedAt: now() });
      dlog('mock.stk.initiated', { checkoutRequestId, amountKES: input.amountKES });
      return { checkoutRequestId, merchantRequestId, customerMessage: 'Success. Request accepted for processing' };
    },
    async queryStk(checkoutRequestId: string): Promise<StkQueryResult> {
      const p = pending.get(checkoutRequestId);
      if (!p) throw new DarajaError('Unknown CheckoutRequestID.', 'unknown_checkout');
      const outcome = mockOutcomeForPhone(p.phone);
      if (!outcome || now() - p.startedAt < delayMs) return { state: 'pending' };
      return { state: 'final', ...outcome };
    },
  };
}
