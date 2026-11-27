import { describe, expect, it, vi } from 'vitest';
import { createMockAdapter } from '@/lib/daraja/mock';
import { classifyStkResponse, createSandboxAdapter, darajaTimestamp, stkPassword, type FetchLike } from '@/lib/daraja/sandbox';
import type { SandboxEnv } from '@/lib/daraja/env';

describe('mock adapter', () => {
  it('never touches the network and resolves by phone suffix after the delay', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    let t = 1_000_000;
    const a = createMockAdapter({ delayMs: 3000, now: () => t });
    expect(a.mode).toBe('mock');
    const cases: Array<[string, unknown]> = [
      ['254712345678', { state: 'final', resultCode: 0 }],
      ['254712345111', { state: 'final', resultCode: 1 }],
      ['254712345222', { state: 'final', resultCode: 1032 }],
      ['254712345000', { state: 'pending' }],
    ];
    const ids: string[] = [];
    for (const [phone] of cases) ids.push((await a.initiateStk({ amountKES: 10, phone, accountReference: 'Duka', description: 'x' })).checkoutRequestId);
    for (const id of ids) expect(await a.queryStk(id)).toEqual({ state: 'pending' });
    t += 3000;
    for (let i = 0; i < cases.length; i++) expect(await a.queryStk(ids[i])).toMatchObject(cases[i][1] as object);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
  it('validates amount and phone; unknown id throws', async () => {
    const a = createMockAdapter({ delayMs: 0 });
    await expect(a.initiateStk({ amountKES: 0, phone: '254712345678', accountReference: 'a', description: 'b' })).rejects.toThrow();
    await expect(a.initiateStk({ amountKES: 1, phone: '0712345678', accountReference: 'a', description: 'b' })).rejects.toThrow();
    await expect(a.queryStk('nope')).rejects.toThrow();
    await expect(a.initiateStk({ amountKES: 1, phone: '254712345888', accountReference: 'a', description: 'b' })).rejects.toMatchObject({ code: 'stk_rejected' });
    await expect(a.initiateStk({ amountKES: 1, phone: '254712345999', accountReference: 'a', description: 'b' })).rejects.toMatchObject({ code: 'stk_unconfirmed' });
  });
});

const ENV: SandboxEnv = {
  env: 'sandbox',
  baseUrl: 'https://sandbox.safaricom.co.ke',
  consumerKey: 'fake_ck',
  consumerSecret: 'fake_cs',
  shortcode: '174379',
  passkey: 'fake_pk',
  callbackUrl: 'https://example.test/api/daraja/callback',
};

type Call = { url: string; method?: string; headers?: Record<string, string>; body?: unknown; redirect?: string };

function fakeFetch(responses: Record<string, { status: number; body: unknown }>) {
  const calls: Call[] = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method, headers: init?.headers, body: init?.body ? JSON.parse(init.body) : undefined, redirect: init?.redirect });
    const key = Object.keys(responses).find((k) => url.includes(k));
    const r = key ? responses[key] : { status: 404, body: {} };
    return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body) };
  };
  return { f, calls };
}

describe('sandbox adapter request shapes (fake fetch, no network)', () => {
  const now = () => new Date(Date.UTC(2026, 10, 24, 9, 5, 7)); // 12:05:07 EAT

  it('timestamp is yyyyMMddHHmmss in EAT and password is base64(shortcode+passkey+timestamp)', () => {
    expect(darajaTimestamp(now())).toBe('20261124120507');
    expect(Buffer.from(stkPassword('174379', 'fake_pk', '20261124120507'), 'base64').toString()).toBe('174379fake_pk20261124120507');
  });

  it('OAuth then STK push with the documented body', async () => {
    const { f, calls } = fakeFetch({
      '/oauth/v1/generate': { status: 200, body: { access_token: 'fake_token', expires_in: '3599' } },
      '/mpesa/stkpush/v1/processrequest': { status: 200, body: { MerchantRequestID: 'm1', CheckoutRequestID: 'ws_CO_1', ResponseCode: '0', CustomerMessage: 'ok' } },
    });
    const a = createSandboxAdapter(ENV, { fetch: f, now });
    const r = await a.initiateStk({ amountKES: 1, phone: '254712345678', accountReference: 'Duka order 123456', description: 'Duka order long text' });
    expect(r).toEqual({ checkoutRequestId: 'ws_CO_1', merchantRequestId: 'm1', customerMessage: 'ok' });
    expect(calls[0].url).toBe('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].headers?.Authorization).toBe(`Basic ${Buffer.from('fake_ck:fake_cs').toString('base64')}`);
    expect(calls[1].url).toBe('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest');
    expect(calls[1].method).toBe('POST');
    expect(calls[1].headers?.Authorization).toBe('Bearer fake_token');
    expect(calls[1].body).toEqual({
      BusinessShortCode: '174379',
      Password: stkPassword('174379', 'fake_pk', '20261124120507'),
      Timestamp: '20261124120507',
      TransactionType: 'CustomerPayBillOnline',
      Amount: 1,
      PartyA: '254712345678',
      PartyB: '174379',
      PhoneNumber: '254712345678',
      CallBackURL: 'https://example.test/api/daraja/callback',
      AccountReference: 'Duka order 1',
      TransactionDesc: 'Duka order lo',
    });
    for (const c of calls) {
      expect(c.url.startsWith('https://sandbox.safaricom.co.ke/')).toBe(true);
      expect(c.redirect).toBe('manual');
    }
  });

  it('query: pending while processing, final with ResultCode, token cached', async () => {
    const { f, calls } = fakeFetch({
      '/oauth/v1/generate': { status: 200, body: { access_token: 'fake_token', expires_in: '3599' } },
      '/mpesa/stkpushquery/v1/query': { status: 500, body: { errorCode: '500.001.1001', errorMessage: 'The transaction is being processed' } },
    });
    const a = createSandboxAdapter(ENV, { fetch: f, now });
    expect(await a.queryStk('ws_CO_1')).toEqual({ state: 'pending' });
    expect(calls[1].body).toEqual({ BusinessShortCode: '174379', Password: stkPassword('174379', 'fake_pk', '20261124120507'), Timestamp: '20261124120507', CheckoutRequestID: 'ws_CO_1' });

    const { f: f2, calls: c2 } = fakeFetch({
      '/oauth/v1/generate': { status: 200, body: { access_token: 'fake_token', expires_in: '3599' } },
      '/mpesa/stkpushquery/v1/query': { status: 200, body: { ResponseCode: '0', ResultCode: '1032', ResultDesc: 'Request cancelled by user' } },
    });
    const b = createSandboxAdapter(ENV, { fetch: f2, now });
    expect(await b.queryStk('ws_CO_1')).toEqual({ state: 'final', resultCode: 1032, resultDesc: 'Request cancelled by user' });
    await b.queryStk('ws_CO_1');
    expect(c2.filter((c) => c.url.includes('/oauth/')).length).toBe(1);
  });

  it('errors are generic and redacted; OAuth failure surfaces', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { f } = fakeFetch({ '/oauth/v1/generate': { status: 400, body: { errorMessage: 'Invalid credentials fake_cs' } } });
    const a = createSandboxAdapter(ENV, { fetch: f, now });
    const err = await a.initiateStk({ amountKES: 1, phone: '254712345678', accountReference: 'a', description: 'b' }).catch((e: unknown) => e);
    expect(String((err as Error).message)).toMatch(/OAuth failed \(HTTP 400\)/);
    const logged = log.mock.calls.map((c) => c.map(String).join(' ')).join('\n') + '\n' + String((err as Error).message);
    for (const secret of ['fake_ck', 'fake_cs', 'fake_pk', 'fake_token', Buffer.from('fake_ck:fake_cs').toString('base64')]) {
      expect(logged.includes(secret), secret).toBe(false);
    }
    log.mockRestore();
  });

  it('STK timeout or 5xx is reported as unconfirmed, a 4xx/ResponseCode != 0 as rejected', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const oauth = { '/oauth/v1/generate': { status: 200, body: { access_token: 'fake_token', expires_in: '3599' } } };
    const input = { amountKES: 1, phone: '254712345678', accountReference: 'a', description: 'b' };
    const throwing: FetchLike = async (url) => {
      if (url.includes('/oauth/')) return { ok: true, status: 200, text: async () => JSON.stringify(oauth['/oauth/v1/generate'].body) };
      throw new Error('timeout');
    };
    await expect(createSandboxAdapter(ENV, { fetch: throwing, now }).initiateStk(input)).rejects.toMatchObject({ code: 'stk_unconfirmed' });
    const f5 = fakeFetch({ ...oauth, '/mpesa/stkpush/v1/processrequest': { status: 503, body: {} } }).f;
    await expect(createSandboxAdapter(ENV, { fetch: f5, now }).initiateStk(input)).rejects.toMatchObject({ code: 'stk_unconfirmed' });
    const f4 = fakeFetch({ ...oauth, '/mpesa/stkpush/v1/processrequest': { status: 400, body: { errorCode: '400.002.02' } } }).f;
    await expect(createSandboxAdapter(ENV, { fetch: f4, now }).initiateStk(input)).rejects.toMatchObject({ code: 'stk_rejected' });
    const fRc = fakeFetch({ ...oauth, '/mpesa/stkpush/v1/processrequest': { status: 200, body: { ResponseCode: '1', ResponseDescription: 'Rejected' } } }).f;
    await expect(createSandboxAdapter(ENV, { fetch: fRc, now }).initiateStk(input)).rejects.toMatchObject({ code: 'stk_rejected' });
    // Ambiguous 200s: unreadable body, missing ids, empty ids -> unconfirmed, never a retry.
    for (const body of [{}, { ResponseCode: '0' }, { ResponseCode: '0', CheckoutRequestID: '', MerchantRequestID: '' }, { ResponseCode: '0', CheckoutRequestID: 'ws_CO_1' }]) {
      const fa = fakeFetch({ ...oauth, '/mpesa/stkpush/v1/processrequest': { status: 200, body } }).f;
      await expect(createSandboxAdapter(ENV, { fetch: fa, now }).initiateStk(input)).rejects.toMatchObject({ code: 'stk_unconfirmed' });
    }
    const unreadable: FetchLike = async (url) =>
      url.includes('/oauth/') ? { ok: true, status: 200, text: async () => JSON.stringify(oauth['/oauth/v1/generate'].body) } : { ok: true, status: 200, text: async () => '<html>gateway</html>' };
    await expect(createSandboxAdapter(ENV, { fetch: unreadable, now }).initiateStk(input)).rejects.toMatchObject({ code: 'stk_unconfirmed' });
  });

  it('STK request log strips the callback query (shared secret)', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { f } = fakeFetch({
      '/oauth/v1/generate': { status: 200, body: { access_token: 'fake_token', expires_in: '3599' } },
      '/mpesa/stkpush/v1/processrequest': { status: 200, body: { MerchantRequestID: 'm1', CheckoutRequestID: 'ws_CO_1', ResponseCode: '0' } },
    });
    await createSandboxAdapter({ ...ENV, callbackUrl: 'https://x.test/cb?secret=CB_SHARED_1' }, { fetch: f, now }).initiateStk({ amountKES: 1, phone: '254712345678', accountReference: 'a', description: 'b' });
    const lines = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(lines).not.toContain('CB_SHARED_1');
    expect(lines).not.toContain('fake_token');
    expect(lines).not.toContain('254712345678');
    log.mockRestore();
  });

  it('refuses a non-sandbox env object', () => {
    expect(() => createSandboxAdapter({ ...ENV, baseUrl: 'https://api.safaricom.co.ke' as 'https://sandbox.safaricom.co.ke' })).toThrow();
  });
});

describe('classifyStkResponse (explicit allowlist)', () => {
  const ok = { ResponseCode: '0', CheckoutRequestID: 'ws_CO_1', MerchantRequestID: 'm1' };
  it('accepts only a well-formed success', () => {
    expect(classifyStkResponse(200, ok)).toMatchObject({ checkoutRequestId: 'ws_CO_1' });
    expect(classifyStkResponse(200, { ...ok, ResponseCode: 0 })).toMatchObject({ merchantRequestId: 'm1' });
  });
  it.each([
    [400, {}],
    [401, { errorCode: 'x' }],
    [200, { ResponseCode: '1' }],
    [200, { ResponseCode: 2001 }],
  ])('rejected: HTTP %i %j', (status, json) => {
    expect(() => classifyStkResponse(status, json)).toThrow(expect.objectContaining({ code: 'stk_rejected' }));
  });
  it.each([
    [200, {}],
    [200, { ResponseCode: null }],
    [200, { ResponseCode: false }],
    [200, { ResponseCode: '' }],
    [200, { ResponseCode: '0x1' }],
    [200, { ResponseCode: 1.5 }],
    [200, { ResponseCode: '0' }],
    [200, { ...ok, CheckoutRequestID: '' }],
    [200, { ...ok, MerchantRequestID: 5 }],
    [201, ok],
    [302, ok],
    [503, ok],
  ])('unknown (no retry): HTTP %i %j', (status, json) => {
    expect(() => classifyStkResponse(status, json as Record<string, unknown>)).toThrow(expect.objectContaining({ code: 'stk_unconfirmed' }));
  });
  it('a 307 redirect from the STK endpoint is not followed and is unknown', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { f, calls } = fakeFetch({
      '/oauth/v1/generate': { status: 200, body: { access_token: 'fake_token', expires_in: '3599' } },
      '/mpesa/stkpush/v1/processrequest': { status: 307, body: {} },
    });
    await expect(createSandboxAdapter(ENV, { fetch: f }).initiateStk({ amountKES: 1, phone: '254712345678', accountReference: 'a', description: 'b' })).rejects.toMatchObject({ code: 'stk_unconfirmed' });
    expect(calls).toHaveLength(2);
  });

  it('a JSON null or array body from the STK endpoint is unknown, not a TypeError', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    for (const raw of ['null', '[]', '"x"']) {
      const f: FetchLike = async (url) =>
        url.includes('/oauth/')
          ? { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'fake_token', expires_in: '3599' }) }
          : { ok: true, status: 200, text: async () => raw };
      await expect(createSandboxAdapter(ENV, { fetch: f }).initiateStk({ amountKES: 1, phone: '254712345678', accountReference: 'a', description: 'b' })).rejects.toMatchObject({
        code: 'stk_unconfirmed',
      });
    }
  });
});
