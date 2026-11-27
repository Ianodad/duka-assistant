/**
 * AC-5 guard: STK Push can only be started by the Pay tap on /checkout.
 * (a) static scan: only app/checkout/actions.ts (plus the adapter definitions
 *     and the operator smoke script) mention initiateStk;
 * (b) runtime: every other route handler and page, driven with a spy adapter,
 *     never calls initiateStk.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SID_A, spyAdapter } from './helpers';

const ROOT = join(__dirname, '..');
const SKIP = new Set(['node_modules', '.pnpm-store', '.next', '.git', 'tests', 'logs', 'evidence']);
const SRC_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (SRC_EXT.test(name)) out.push(relative(ROOT, p));
  }
  return out;
}

const files = walk(ROOT);
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');

const THE_CALLER = 'app/checkout/actions.ts';
const DEFINITIONS = ['lib/daraja/types.ts', 'lib/daraja/mock.ts', 'lib/daraja/sandbox.ts'];
const OPERATOR_SCRIPT = 'scripts/sandbox-smoke.ts';
// Static `from '...scripts/'`, side-effect `import '...scripts/'`, dynamic `import('...scripts/')`, `require('...scripts/')`.
const SCRIPTS_IMPORT = /(\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"`][^'"`]*scripts\//;

describe('guard (a): static scan', () => {
  it('scans a real source tree', () => {
    expect(files).toContain(THE_CALLER);
    expect(files.length).toBeGreaterThan(20);
  });

  it('only the checkout pay action references initiateStk in the app', () => {
    const refs = files.filter((f) => /initiateStk/.test(read(f))).sort();
    expect(refs).toEqual([THE_CALLER, ...DEFINITIONS, OPERATOR_SCRIPT].sort());
    const appRefs = refs.filter((f) => !DEFINITIONS.includes(f) && f !== OPERATOR_SCRIPT);
    expect(appRefs).toEqual([THE_CALLER]);
  });

  it('the pay action calls initiateStk exactly once, through the server-only adapter module', () => {
    const src = read(THE_CALLER);
    expect(src.match(/initiateStk\s*\(/g)?.length).toBe(1);
    expect(src.startsWith("'use server';")).toBe(true);
    expect(src).toMatch(/from '@\/lib\/daraja'/);
    expect(read('lib/daraja/index.ts')).toMatch(/^import 'server-only';$/m);
  });

  it('no indirect access to initiate (bracket access, string keys) outside the allowed files', () => {
    const allowed = new Set([THE_CALLER, ...DEFINITIONS, OPERATOR_SCRIPT, 'lib/daraja/index.ts']);
    const offenders = files.filter((f) => !allowed.has(f) && /initiate/i.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it('adapters are only constructed in lib/daraja/index.ts (and the operator script)', () => {
    const offenders = files.filter(
      (f) =>
        f !== 'lib/daraja/index.ts' &&
        f !== OPERATOR_SCRIPT &&
        !f.startsWith('lib/daraja/') &&
        /(lib\/daraja\/(mock|sandbox)|createMockAdapter|createSandboxAdapter)/.test(read(f)),
    );
    expect(offenders).toEqual([]);
  });

  it('nothing in the app imports the operator scripts', () => {
    const offenders = files.filter((f) => !f.startsWith('scripts/') && SCRIPTS_IMPORT.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it('the scripts-import pattern catches static, dynamic import() and require() forms', () => {
    for (const bad of [
      "import x from '../scripts/sandbox-smoke';",
      "export * from '@/scripts/sandbox-smoke';",
      "const m = await import('../scripts/sandbox-smoke');",
      "const m = await import ( \"../../scripts/sandbox-smoke.ts\" );",
      "const m = require('../scripts/sandbox-smoke');",
      "import '../scripts/sandbox-smoke';",
      "const m = await import(`../scripts/sandbox-smoke`);",
    ]) expect(SCRIPTS_IMPORT.test(bad), bad).toBe(true);
    for (const ok of ["import { x } from '@/lib/daraja';", "const s = 'see scripts folder';"])
      expect(SCRIPTS_IMPORT.test(ok), ok).toBe(false);
  });

  it('only one server action file exists', () => {
    const actionFiles = files.filter((f) => /^\s*['"]use server['"]/m.test(read(f)));
    expect(actionFiles).toEqual([THE_CALLER]);
  });
});

// ---------- runtime ----------
const spy = spyAdapter({ state: 'final', resultCode: 0, resultDesc: 'ok' });
vi.mock('@/lib/daraja', async (orig) => ({ ...(await orig<typeof import('@/lib/daraja')>()), getAdapter: () => spy.adapter }));

let currentSid: string | undefined = SID_A;
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'duka_sid' && currentSid ? { name: n, value: currentSid } : undefined) }),
  headers: async () => new Headers({ host: 'localhost:3200', origin: 'http://localhost:3200' }),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  redirect: (u: string) => {
    throw new Error(`NEXT_REDIRECT ${u}`);
  },
}));

function nreq(path: string, init: { method?: string; sid?: string; body?: unknown } = {}) {
  const headers = new Headers({ host: 'localhost:3200' });
  if (init.sid) headers.set('cookie', `duka_sid=${init.sid}`);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  return new NextRequest(`http://localhost:3200${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body),
  });
}

const routeFiles = files.filter((f) => /^app\/.*route\.ts$/.test(f)).sort();
const pageFiles = files.filter((f) => /^app\/.*page\.tsx$/.test(f)).sort();

const COVERED_ROUTES = ['app/api/assistant/action/route.ts', 'app/api/assistant/mode/route.ts', 'app/api/assistant/route.ts', 'app/api/cart/route.ts', 'app/api/daraja/callback/route.ts', 'app/api/mock/daraja/resolve/route.ts', 'app/api/orders/[id]/status/route.ts'];
const COVERED_PAGES = ['app/cart/page.tsx', 'app/checkout/page.tsx', 'app/orders/[id]/page.tsx', 'app/p/[slug]/page.tsx', 'app/page.tsx'];

describe('guard (b): runtime, no other path calls initiateStk', () => {
  beforeEach(() => {
    spy.initiateStk.mockClear();
    spy.queryStk.mockClear();
    vi.unstubAllEnvs();
  });

  it('every route handler and page in app/ is exercised below', () => {
    expect(routeFiles).toEqual(COVERED_ROUTES);
    expect(pageFiles).toEqual(COVERED_PAGES);
  });

  it('exercises all routes and pages with a spy adapter; initiateStk is never called', async () => {
    const cart = await import('@/app/api/cart/route');
    const status = await import('@/app/api/orders/[id]/status/route');
    const callback = await import('@/app/api/daraja/callback/route');
    const resolve = await import('@/app/api/mock/daraja/resolve/route');
    const { createOrder, attachCheckout, _resetOrdersForTests } = await import('@/lib/shop/orders');
    const { computeCart } = await import('@/lib/shop/cart');
    _resetOrdersForTests();

    // Cart API, every method, including bad input.
    expect((await cart.GET(nreq('/api/cart', { sid: SID_A }))).status).toBe(200);
    expect((await cart.POST(nreq('/api/cart', { method: 'POST', sid: SID_A, body: { productId: 'unga-2kg', qty: 2 } }))).status).toBe(200);
    expect((await cart.POST(nreq('/api/cart', { method: 'POST', body: { productId: 'unga-2kg' } }))).status).toBe(200);
    expect((await cart.PATCH(nreq('/api/cart', { method: 'PATCH', sid: SID_A, body: { productId: 'unga-2kg', qty: 3 } }))).status).toBe(200);
    expect((await cart.DELETE(nreq('/api/cart', { method: 'DELETE', sid: SID_A, body: { productId: 'unga-2kg' } }))).status).toBe(200);
    expect((await cart.POST(nreq('/api/cart', { method: 'POST', sid: SID_A, body: { productId: 'x', initiateStk: true, pay: true } }))).status).toBe(400);
    await cart.POST(nreq('/api/cart', { method: 'POST', sid: SID_A, body: { productId: 'ketepa-100', qty: 1 } }));

    // An existing pending order to poll and call back on.
    const o = createOrder({ sid: SID_A, lines: computeCart([{ productId: 'ketepa-100', qty: 1 }]).lines, phone: '254712345678' });
    attachCheckout(o.id, 'ws_CO_GUARD_1', 'm1');
    const o2 = createOrder({ sid: SID_A, lines: computeCart([{ productId: 'ketepa-100', qty: 1 }]).lines, phone: '254712345000' });
    attachCheckout(o2.id, 'ws_CO_GUARD_2', 'm2');
    const o3 = createOrder({ sid: SID_A, lines: computeCart([{ productId: 'ketepa-100', qty: 1 }]).lines, phone: '254712345000' });

    // Status endpoint: pending (runs queryStk), unknown id, other session, order without a checkout id.
    const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
    const s1 = await status.GET(nreq(`/api/orders/${o.id}/status`, { sid: SID_A }), ctx(o.id));
    expect(((await s1.json()) as { state: string }).state).toBe('paid');
    expect(spy.queryStk).toHaveBeenCalledTimes(1);
    expect((await status.GET(nreq('/api/orders/nope/status', { sid: SID_A }), ctx('nope'))).status).toBe(404);
    expect((await status.GET(nreq(`/api/orders/${o.id}/status`, { sid: 'sidOTHERxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' }), ctx(o.id))).status).toBe(404);
    expect((await status.GET(nreq(`/api/orders/${o3.id}/status`, { sid: SID_A }), ctx(o3.id))).status).toBe(200);

    // Callback: valid, unknown id, bad shape, bad JSON.
    const body = (id: string, rc: number) => ({ Body: { stkCallback: { MerchantRequestID: 'm', CheckoutRequestID: id, ResultCode: rc, ResultDesc: 'x' } } });
    expect((await callback.POST(nreq('/api/daraja/callback', { method: 'POST', body: body('ws_CO_GUARD_2', 1032) }))).status).toBe(200);
    expect((await callback.POST(nreq('/api/daraja/callback', { method: 'POST', body: body('ws_CO_UNKNOWN', 0) }))).status).toBe(200);
    expect((await callback.POST(nreq('/api/daraja/callback', { method: 'POST', body: { hello: 1 } }))).status).toBe(400);
    expect((await callback.POST(nreq('/api/daraja/callback', { method: 'POST', body: 'not json' }))).status).toBe(400);

    // Mock control: works in mock mode, 404 in sandbox mode; never initiates.
    const o4 = createOrder({ sid: SID_A, lines: computeCart([{ productId: 'ketepa-100', qty: 1 }]).lines, phone: '254712345000' });
    attachCheckout(o4.id, 'ws_CO_GUARD_4', 'm4');
    expect((await resolve.POST(nreq('/api/mock/daraja/resolve', { method: 'POST', sid: SID_A, body: { orderId: o4.id, outcome: 'paid' } }))).status).toBe(200);
    expect((await resolve.POST(nreq('/api/mock/daraja/resolve', { method: 'POST', sid: SID_A, body: { orderId: o3.id, outcome: 'paid' } }))).status).toBe(404);
    vi.stubEnv('DUKA_DARAJA_MODE', 'sandbox');
    expect((await resolve.POST(nreq('/api/mock/daraja/resolve', { method: 'POST', sid: SID_A, body: { orderId: o4.id, outcome: 'paid' } }))).status).toBe(404);
    vi.stubEnv('DUKA_DARAJA_MODE', 'bogus');
    expect((await resolve.POST(nreq('/api/mock/daraja/resolve', { method: 'POST', sid: SID_A, body: { orderId: o4.id, outcome: 'paid' } }))).status).toBe(404);
    vi.unstubAllEnvs();

    // Week 2 assistant routes (planner text and A2UI actions), including pay-like input.
    const assistant = await import('@/app/api/assistant/route');
    const action = await import('@/app/api/assistant/action/route');
    for (const text of ['add 2 unga', 'pay now', 'checkout', 'show cart', 'confirm payment with mpesa'])
      expect((await assistant.POST(nreq('/api/assistant', { method: 'POST', sid: SID_A, body: { text, turn: 1 } }))).status).toBe(200);
    expect((await action.POST(nreq('/api/assistant/action', { method: 'POST', sid: SID_A, body: { name: 'go_to_checkout', payload: {} } }))).status).toBe(200);
    expect((await action.POST(nreq('/api/assistant/action', { method: 'POST', sid: SID_A, body: { name: 'pay', payload: {} } }))).status).toBe(400);
    // SPEC-LIVE mode endpoint: read-only, two enum fields.
    const mode = await import('@/app/api/assistant/mode/route');
    expect(await mode.GET().json()).toEqual({ planner: 'regex', client: 'none' });

    // Pages (server components), including checkout which issues a token but must not pay.
    currentSid = SID_A;
    const pages = {
      catalog: (await import('@/app/page')).default,
      product: (await import('@/app/p/[slug]/page')).default,
      cartPage: (await import('@/app/cart/page')).default,
      checkout: (await import('@/app/checkout/page')).default,
      order: (await import('@/app/orders/[id]/page')).default,
    };
    await pages.catalog({ searchParams: Promise.resolve({}) });
    await pages.catalog({ searchParams: Promise.resolve({ q: 'chai' }) });
    await pages.product({ params: Promise.resolve({ slug: 'unga-2kg' }) });
    await expect(pages.product({ params: Promise.resolve({ slug: 'nope' }) })).rejects.toThrow('NEXT_NOT_FOUND');
    await pages.cartPage();
    await pages.checkout();
    await pages.order({ params: Promise.resolve({ id: o.id }) });
    currentSid = undefined;
    await pages.checkout();

    expect(spy.initiateStk).not.toHaveBeenCalled();
  });
});
