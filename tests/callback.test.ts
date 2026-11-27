import { describe, expect, it } from 'vitest';
import { mapResultCode, parseCallback } from '@/lib/daraja/callback';

export function cbBody(checkoutRequestId: string, resultCode: number, extra: Record<string, unknown> = {}) {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: 'm-1',
        CheckoutRequestID: checkoutRequestId,
        ResultCode: resultCode,
        ResultDesc: 'desc',
        ...extra,
      },
    },
  };
}

describe('callback mapping', () => {
  it('maps 0 paid, 1032 cancelled, others failed', () => {
    expect(mapResultCode(0)).toBe('paid');
    expect(mapResultCode(1032)).toBe('cancelled');
    for (const c of [1, 1037, 2001, 17, 9999]) expect(mapResultCode(c)).toBe('failed');
  });
  it('parses a success body with metadata', () => {
    const r = parseCallback(
      cbBody('ws_CO_1', 0, {
        CallbackMetadata: { Item: [{ Name: 'Amount', Value: 1 }, { Name: 'MpesaReceiptNumber', Value: 'NLJ7RT61SV' }, { Name: 'Balance' }] },
      }),
    );
    expect(r).toEqual({ ok: true, value: { merchantRequestId: 'm-1', checkoutRequestId: 'ws_CO_1', resultCode: 0, resultDesc: 'desc', amount: 1, receipt: 'NLJ7RT61SV' } });
  });
  it.each([null, 'x', [], {}, { Body: {} }, { Body: { stkCallback: {} } }, cbBody('', 0), cbBody('ws_CO_1', 1.5), cbBody('bad id!', 0), cbBody('ws_CO_1', 'abc' as unknown as number)])(
    'rejects bad shape %#',
    (b) => {
      expect(parseCallback(b).ok).toBe(false);
    },
  );
});
