/**
 * Sandbox Daraja adapter built on the public sandbox endpoints:
 *   GET  /oauth/v1/generate?grant_type=client_credentials   (Basic auth)
 *   POST /mpesa/stkpush/v1/processrequest                   (Bearer)
 *   POST /mpesa/stkpushquery/v1/query                       (Bearer)
 * Password = base64(shortcode + passkey + timestamp), timestamp yyyyMMddHHmmss.
 * fetch is injected so tests never touch the network.
 */
import { DarajaError, STK_UNCONFIRMED, type DarajaAdapter, type StkInitiateInput, type StkInitiateResult, type StkQueryResult } from '@/lib/daraja/types';
import { SANDBOX_BASE_URL, type SandboxEnv } from '@/lib/daraja/env';
import { dlog, redact, registerSecret } from '@/lib/daraja/redact';

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; redirect?: 'manual' }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/** Placeholder used when DARAJA_CALLBACK_URL is not set; status queries still reconcile. UNVERIFIED that Daraja accepts a .invalid host. */
export const FALLBACK_CALLBACK_URL = 'https://duka.invalid/api/daraja/callback';

/** yyyyMMddHHmmss in East Africa Time (UTC+3, no DST). UNVERIFIED: docs imply local Kenyan time. */
export function darajaTimestamp(date: Date): string {
  const eat = new Date(date.getTime() + 3 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${eat.getUTCFullYear()}${p(eat.getUTCMonth() + 1)}${p(eat.getUTCDate())}${p(eat.getUTCHours())}${p(eat.getUTCMinutes())}${p(eat.getUTCSeconds())}`;
}

export function stkPassword(shortcode: string, passkey: string, timestamp: string): string {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
}

const ID_RE = /^[A-Za-z0-9_\-.]{1,100}$/;

/**
 * Explicit allowlist classification of the STK push response.
 *   accepted:  HTTP 200, ResponseCode "0" or 0, valid CheckoutRequestID and MerchantRequestID.
 *   rejected:  HTTP 4xx, or HTTP 200 with a well-formed non-zero integer ResponseCode. No prompt was sent.
 *   unknown:   everything else (5xx, odd status, malformed or missing fields). The prompt may be live,
 *              so the caller must not invite a retry.
 */
export function classifyStkResponse(status: number, json: Record<string, unknown>): StkInitiateResult {
  if (status >= 400 && status < 500) throw new DarajaError(`STK push was not accepted (HTTP ${status}).`, 'stk_rejected');
  if (status !== 200) throw new DarajaError(`STK push outcome unknown (HTTP ${status}).`, STK_UNCONFIRMED);
  const rc = json.ResponseCode;
  const code = typeof rc === 'number' && Number.isInteger(rc) ? rc : typeof rc === 'string' && /^\d{1,6}$/.test(rc) ? Number(rc) : null;
  if (code === null) throw new DarajaError('STK push outcome unknown (malformed ResponseCode).', STK_UNCONFIRMED);
  if (code !== 0) throw new DarajaError('STK push was not accepted.', 'stk_rejected');
  const checkoutRequestId = json.CheckoutRequestID;
  const merchantRequestId = json.MerchantRequestID;
  if (typeof checkoutRequestId !== 'string' || !ID_RE.test(checkoutRequestId) || typeof merchantRequestId !== 'string' || !ID_RE.test(merchantRequestId)) {
    throw new DarajaError('STK push outcome unknown (missing ids).', STK_UNCONFIRMED);
  }
  return { checkoutRequestId, merchantRequestId, customerMessage: typeof json.CustomerMessage === 'string' ? json.CustomerMessage : undefined };
}

export function createSandboxAdapter(env: SandboxEnv, deps: { fetch?: FetchLike; now?: () => Date; timeoutMs?: number } = {}): DarajaAdapter {
  if (env.env !== 'sandbox' || env.baseUrl !== SANDBOX_BASE_URL) throw new DarajaError('Sandbox adapter only talks to the sandbox host.', 'not_sandbox');
  // Defense in depth: mask these values even if a caller built the env without the loader.
  for (const v of [env.consumerKey, env.consumerSecret, env.passkey]) registerSecret(v);
  const doFetch: FetchLike = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.timeoutMs ?? 15000;
  let token: { value: string; expiresAt: number } | null = null;

  async function call(path: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<{ status: number; json: Record<string, unknown> }> {
    const url = `${SANDBOX_BASE_URL}${path}`;
    let res;
    try {
      // Never follow redirects: a 3xx must not carry credentials or the STK body off the sandbox host.
      res = await doFetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      dlog('sandbox.network_error', { path, error: e });
      throw new DarajaError('Could not reach the Daraja sandbox.', 'network');
    }
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      const parsed: unknown = text ? JSON.parse(text) : {};
      json = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      json = {};
    }
    dlog('sandbox.response', { path, status: res.status, body: json });
    return { status: res.status, json };
  }

  async function accessToken(): Promise<string> {
    if (token && token.expiresAt > Date.now() + 30_000) return token.value;
    const basic = Buffer.from(`${env.consumerKey}:${env.consumerSecret}`).toString('base64');
    registerSecret(basic);
    const { status, json } = await call('/oauth/v1/generate?grant_type=client_credentials', {
      method: 'GET',
      headers: { Authorization: `Basic ${basic}` },
    });
    const value = json.access_token;
    if (status !== 200 || typeof value !== 'string' || !value) throw new DarajaError(`Daraja OAuth failed (HTTP ${status}).`, 'oauth');
    // expires_in is documented as seconds, sent as a string (UNVERIFIED type); default to 3599.
    const ttl = Number(json.expires_in ?? 3599);
    registerSecret(value);
    token = { value, expiresAt: Date.now() + (Number.isFinite(ttl) ? ttl : 3599) * 1000 };
    return value;
  }

  function signed() {
    const timestamp = darajaTimestamp(now());
    return { timestamp, password: stkPassword(env.shortcode, env.passkey, timestamp) };
  }

  return {
    mode: 'sandbox',
    async initiateStk(input: StkInitiateInput): Promise<StkInitiateResult> {
      if (!Number.isInteger(input.amountKES) || input.amountKES < 1) throw new DarajaError('Amount must be a positive whole number.', 'bad_amount');
      if (!/^254[17]\d{8}$/.test(input.phone)) throw new DarajaError('Phone must be normalised.', 'bad_phone');
      const bearer = await accessToken();
      const { timestamp, password } = signed();
      const body = {
        BusinessShortCode: env.shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: input.amountKES,
        PartyA: input.phone,
        PartyB: env.shortcode,
        PhoneNumber: input.phone,
        CallBackURL: env.callbackUrl ?? FALLBACK_CALLBACK_URL,
        // AccountReference max 12 chars and TransactionDesc max 13 chars per public docs (UNVERIFIED limits).
        AccountReference: input.accountReference.slice(0, 12),
        TransactionDesc: input.description.slice(0, 13),
      };
      dlog('sandbox.stk.request', { body: { ...body, CallBackURL: body.CallBackURL.split('?')[0] } });
      let status: number;
      let json: Record<string, unknown>;
      try {
        ({ status, json } = await call('/mpesa/stkpush/v1/processrequest', {
          method: 'POST',
          headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }));
      } catch {
        // Timeout or dropped connection after sending: Daraja may have accepted the push.
        throw new DarajaError('STK push outcome unknown (no response).', STK_UNCONFIRMED);
      }
      if (status >= 500) throw new DarajaError(`STK push outcome unknown (HTTP ${status}).`, STK_UNCONFIRMED);
      return classifyStkResponse(status, json);
    },
    async queryStk(checkoutRequestId: string): Promise<StkQueryResult> {
      const bearer = await accessToken();
      const { timestamp, password } = signed();
      const { status, json } = await call('/mpesa/stkpushquery/v1/query', {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ BusinessShortCode: env.shortcode, Password: password, Timestamp: timestamp, CheckoutRequestID: checkoutRequestId }),
      });
      // While the shopper has not answered, the sandbox answers with an error such as
      // errorCode "500.001.1001" ("The transaction is being processed"). UNVERIFIED exact code and status.
      if (typeof json.errorCode === 'string') return { state: 'pending' };
      const rc = json.ResultCode;
      const code = typeof rc === 'number' ? rc : typeof rc === 'string' && /^\d+$/.test(rc) ? Number(rc) : NaN;
      if (status !== 200 || !Number.isInteger(code)) {
        dlog('sandbox.query.unexpected', redact({ status }));
        return { state: 'pending' };
      }
      return { state: 'final', resultCode: code, resultDesc: typeof json.ResultDesc === 'string' ? json.ResultDesc.slice(0, 200) : '' };
    },
  };
}
