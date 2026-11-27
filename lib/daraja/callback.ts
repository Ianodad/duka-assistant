/**
 * STK callback parsing. Shape per the public Daraja docs:
 * { Body: { stkCallback: { MerchantRequestID, CheckoutRequestID, ResultCode, ResultDesc,
 *   CallbackMetadata?: { Item: [{ Name, Value? }] } } } }
 */
import type { OrderState } from '@/lib/shop/order-state';

export type ParsedCallback = {
  merchantRequestId: string;
  checkoutRequestId: string;
  resultCode: number;
  resultDesc: string;
  receipt?: string;
  amount?: number;
};

export type ParseResult = { ok: true; value: ParsedCallback } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const ID_RE = /^[A-Za-z0-9_\-.]{1,100}$/;

export function parseCallback(body: unknown): ParseResult {
  if (!isObj(body) || !isObj(body.Body) || !isObj(body.Body.stkCallback)) return { ok: false, error: 'Missing Body.stkCallback.' };
  const cb = body.Body.stkCallback;
  const checkoutRequestId = cb.CheckoutRequestID;
  const merchantRequestId = cb.MerchantRequestID;
  if (typeof checkoutRequestId !== 'string' || !ID_RE.test(checkoutRequestId)) return { ok: false, error: 'Invalid CheckoutRequestID.' };
  if (typeof merchantRequestId !== 'string' || !ID_RE.test(merchantRequestId)) return { ok: false, error: 'Invalid MerchantRequestID.' };
  // ResultCode is documented as a number; accept a numeric string defensively (UNVERIFIED whether Daraja ever sends a string).
  const rc = typeof cb.ResultCode === 'string' && /^\d+$/.test(cb.ResultCode) ? Number(cb.ResultCode) : cb.ResultCode;
  if (typeof rc !== 'number' || !Number.isInteger(rc)) return { ok: false, error: 'Invalid ResultCode.' };
  const resultDesc = typeof cb.ResultDesc === 'string' ? cb.ResultDesc.slice(0, 200) : '';
  const out: ParsedCallback = { merchantRequestId, checkoutRequestId, resultCode: rc, resultDesc };
  if (cb.CallbackMetadata !== undefined) {
    if (!isObj(cb.CallbackMetadata) || !Array.isArray(cb.CallbackMetadata.Item)) return { ok: false, error: 'Invalid CallbackMetadata.' };
    const seen = new Set<string>();
    for (const item of cb.CallbackMetadata.Item) {
      if (!isObj(item) || typeof item.Name !== 'string' || !item.Name) return { ok: false, error: 'Invalid CallbackMetadata item.' };
      if (seen.has(item.Name)) return { ok: false, error: 'Duplicate CallbackMetadata item.' };
      seen.add(item.Name);
      if (item.Name === 'MpesaReceiptNumber') {
        if (typeof item.Value !== 'string' || !/^[A-Z0-9]{6,20}$/.test(item.Value)) return { ok: false, error: 'Invalid MpesaReceiptNumber.' };
        out.receipt = item.Value;
      }
      if (item.Name === 'Amount') {
        if (typeof item.Value !== 'number' || !Number.isFinite(item.Value)) return { ok: false, error: 'Invalid Amount.' };
        out.amount = item.Value;
      }
    }
  }
  return { ok: true, value: out };
}

/** 0 paid, 1032 cancelled by user, anything else failed. */
export function mapResultCode(code: number): Exclude<OrderState, 'pending'> {
  if (code === 0) return 'paid';
  if (code === 1032) return 'cancelled';
  return 'failed';
}
