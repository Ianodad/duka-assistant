/**
 * SPEC-LIVE AC-L33, AC-L34, AC-L36, AC-L38 (seed), AC-L40: the shared spend ledger.
 * Everything runs against the in-memory fake store (tests/fakes/fake-upstash.ts),
 * whose EVAL runs TypeScript mirrors of the Lua scripts. No network.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { LiveCallRefused, type CreateParams, type PlannerClient } from '@/lib/assistant/claude/client';
import { buildRequest } from '@/lib/assistant/claude/loop';
import { capUSD, costFromUsage, estimateCostUSD, SpendRefused, withSpendGuard, type CallLine } from '@/lib/assistant/claude/spend';
import {
  LUA,
  ledgerSelection,
  RESERVATION_TTL_MS,
  seedLedger,
  setStoreFetchForTests,
  setStoreTimeoutForTests,
  sharedReserve,
  sharedSettle,
  sharedStatus,
  StoreError,
  type SharedLedger,
} from '@/lib/assistant/claude/store';
import { createFakeUpstash, emptyState, mirrorRate, mirrorReserve, mirrorSeed, mirrorSettle, type FakeFail } from './fakes/fake-upstash';
import { installFakeStore, ledgerKey, ledgerOf, NS, sharedEnv, STORE_TOKEN, STORE_URL, useStoreCleanup } from './fakes/store-helpers';

useStoreCleanup();

const MODEL = 'claude-sonnet-5-5';
const SHOPPER = 'SHOPPER_SECRET_TEXT_unga please';
const MODEL_TEXT = 'MODEL_SECRET_TEXT_do not log me';
const API_KEY = 'FAKE_ANTHROPIC_KEY_DO_NOT_USE_sharedtest';
const params = (text = SHOPPER): CreateParams => buildRequest(MODEL, [{ role: 'user', content: [{ type: 'text', text }] }]);
const sig = () => new AbortController().signal;
const micro = (usd: number) => Math.round(usd * 1e6);
const sh = (): SharedLedger => {
  const s = ledgerSelection(sharedEnv());
  if (s.kind !== 'shared' || !s.cfg) throw new Error('test setup');
  return { cfg: s.cfg, ns: s.ns };
};

const usage = { input_tokens: 1200, output_tokens: 80, cache_creation_input_tokens: 100, cache_read_input_tokens: 300 };
function reply(withUsage = true): Anthropic.Message {
  return {
    id: 'msg_shared',
    type: 'message',
    role: 'assistant',
    model: MODEL,
    content: [{ type: 'text', text: MODEL_TEXT }, { type: 'tool_use', id: 'toolu_1', name: 'search_products', input: { query: MODEL_TEXT } }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    ...(withUsage ? { usage } : {}),
  } as unknown as Anthropic.Message;
}
function fakeInner(mode: 'ok' | 'refused' | 'error' | 'nousage' | 'hang' = 'ok', onCall?: () => void) {
  const calls: CreateParams[] = [];
  const client: PlannerClient = {
    kind: 'live',
    create(p, { signal }) {
      calls.push(p);
      onCall?.();
      if (mode === 'refused') return Promise.reject(new LiveCallRefused());
      if (mode === 'error') return Promise.reject(new Error('500 internal'));
      if (mode === 'hang') return new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'APIUserAbortError' })), { once: true }));
      return Promise.resolve(reply(mode !== 'nousage'));
    },
  };
  return { client, calls };
}

// ---------- AC-L33 selection ----------

describe('AC-L33 ledger selection', () => {
  const KV = { KV_REST_API_URL: 'https://kv.example.test', KV_REST_API_TOKEN: 'kv-token' };
  const UP = { UPSTASH_REDIS_REST_URL: 'https://up.example.test', UPSTASH_REDIS_REST_TOKEN: 'up-token' };
  it('a complete https pair selects the shared ledger; KV_* wins over UPSTASH_*; default namespace duka', () => {
    expect(ledgerSelection(KV)).toMatchObject({ kind: 'shared', ns: 'duka', cfg: { url: KV.KV_REST_API_URL, token: 'kv-token' } });
    expect(ledgerSelection(UP)).toMatchObject({ kind: 'shared', cfg: { url: UP.UPSTASH_REDIS_REST_URL, token: 'up-token' } });
    expect(ledgerSelection({ ...UP, ...KV })).toMatchObject({ cfg: { token: 'kv-token' } });
    expect(ledgerSelection({ ...KV, DUKA_LEDGER_NAMESPACE: 'prod_1' })).toMatchObject({ ns: 'prod_1' });
  });
  it('no store env and nothing requiring it: the file ledger', () => {
    expect(ledgerSelection({})).toEqual({ kind: 'file' });
    expect(ledgerSelection({ VERCEL: '', DUKA_LEDGER: 'file', KV_REST_API_URL: '' })).toEqual({ kind: 'file' });
    expect(ledgerSelection({ DUKA_SPEND_DIR: '/tmp/x', ANTHROPIC_API_KEY: API_KEY })).toEqual({ kind: 'file' });
  });
  it('required but missing or invalid fails CLOSED (shared with no config)', () => {
    const closed = { kind: 'shared', cfg: null };
    expect(ledgerSelection({ VERCEL: '1' })).toEqual(closed);
    expect(ledgerSelection({ DUKA_LEDGER: 'shared' })).toEqual(closed);
    for (const bad of [
      { KV_REST_API_URL: KV.KV_REST_API_URL }, // URL without token
      { KV_REST_API_TOKEN: 'kv-token' }, // token without URL
      { KV_REST_API_URL: 'http://kv.example.test', KV_REST_API_TOKEN: 'kv-token' }, // not https
      { KV_REST_API_URL: 'not a url', KV_REST_API_TOKEN: 'kv-token' },
      { KV_REST_API_URL: 'https://user:pw@kv.example.test', KV_REST_API_TOKEN: 'kv-token' }, // credentials in the URL
      { UPSTASH_REDIS_REST_URL: UP.UPSTASH_REDIS_REST_URL },
      { ...KV, DUKA_LEDGER_NAMESPACE: 'bad ns!' },
      { ...KV, DUKA_LEDGER_NAMESPACE: 'x'.repeat(33) },
    ])
      expect(ledgerSelection(bad)).toEqual(closed);
    // A broken KV pair does not stop a complete UPSTASH pair.
    expect(ledgerSelection({ KV_REST_API_URL: 'http://x', KV_REST_API_TOKEN: 't', ...UP })).toMatchObject({ kind: 'shared', cfg: { token: 'up-token' } });
  });
  it('VERCEL set (any non-empty value) requires the store even with a complete pair elsewhere being absent', () => {
    expect(ledgerSelection({ VERCEL: '0' })).toEqual({ kind: 'shared', cfg: null });
    expect(ledgerSelection({ VERCEL: '1', ...KV })).toMatchObject({ kind: 'shared', cfg: { token: 'kv-token' } });
  });
  it.each([['VERCEL_ENV', 'production'], ['AWS_LAMBDA_FUNCTION_NAME', 'fn-123']])('%s alone requires the store: fail closed with no store env, shared with a complete https pair', (name, value) => {
    expect(ledgerSelection({ [name]: value })).toEqual({ kind: 'shared', cfg: null });
    expect(ledgerSelection({ [name]: value, ...KV })).toMatchObject({ kind: 'shared', cfg: { url: KV.KV_REST_API_URL, token: 'kv-token' } });
    expect(ledgerSelection({ [name]: '' })).toEqual({ kind: 'file' });
  });
});

// ---------- the Lua mirrors as pure functions ----------

describe('AC-L40 the Lua mirrors (pure)', () => {
  const KEYS = ['L', 'R', 'Z'];
  const NOW = 1_000_000;
  const rsv = (st = emptyState(), worst = 100, id = 'a', now = NOW, cap = 1000) => ({ st, out: mirrorReserve(st, KEYS, [String(now), String(cap), String(worst), id, String(RESERVATION_TTL_MS)]) });

  it('reserve: fits exactly up to the cap, refuses one micro over, and a refusal changes nothing', () => {
    const { st, out } = rsv(undefined, 1000);
    expect(out).toEqual([1, 0, 1000]);
    expect(st.hashes.get('R')!.get('a')).toBe('1000');
    expect(st.zsets.get('Z')!.get('a')).toBe(NOW + RESERVATION_TTL_MS);
    const before = JSON.stringify([...st.hashes]);
    expect(rsv(st, 1, 'b').out).toEqual([0, 0, 1000]);
    expect(JSON.stringify([...st.hashes])).toBe(before);
    expect(rsv(emptyState(), 1001).out[0]).toBe(0);
  });
  it('reserve: spent counts toward the cap too', () => {
    const st = emptyState();
    mirrorSeed(st, ['L', 'R'], ['900']);
    expect(rsv(st, 100).out).toEqual([1, 900, 100]);
    expect(rsv(st, 1, 'b').out[0]).toBe(0);
  });
  it('sweep: an expired reservation is KEPT as spent (calls and expired +1), a live one stays reserved', () => {
    const st = emptyState();
    rsv(st, 100, 'old', NOW);
    rsv(st, 50, 'young', NOW + RESERVATION_TTL_MS - 10);
    const out = rsv(st, 10, 'new', NOW + RESERVATION_TTL_MS).out; // 'old' expires exactly now (score <= now)
    expect(out).toEqual([1, 100, 50 + 10]);
    const h = st.hashes.get('L')!;
    expect([h.get('spent'), h.get('reserved'), h.get('calls'), h.get('expired')]).toEqual(['100', '60', '1', '1']);
    expect(st.hashes.get('R')!.has('old')).toBe(false);
    expect(st.zsets.get('Z')!.has('old')).toBe(false);
    expect(st.zsets.get('Z')!.has('young')).toBe(true);
  });
  it('settle: replaces the reservation by the charge, counts the call and the origin; a release (charged 0) counts no call', () => {
    const { st } = rsv(undefined, 100, 'a');
    expect(mirrorSettle(st, KEYS, [String(NOW), 'a', '30', '1', 'app'])).toEqual([1, 30]);
    const h = st.hashes.get('L')!;
    expect([h.get('spent'), h.get('reserved'), h.get('calls'), h.get('o:app:spent'), h.get('o:app:calls')]).toEqual(['30', '0', '1', '30', '1']);
    expect(st.hashes.has('R')).toBe(false);
    rsv(st, 100, 'b');
    expect(mirrorSettle(st, KEYS, [String(NOW), 'b', '0', '0', 'app'])).toEqual([1, 30]);
    expect([h.get('calls'), h.get('o:app:calls'), h.get('reserved')]).toEqual(['1', '1', '0']);
  });
  it('settle after the sweep took the id: nothing changes (the worst case was already charged)', () => {
    const { st } = rsv(undefined, 100, 'a', NOW);
    const out = mirrorSettle(st, KEYS, [String(NOW + RESERVATION_TTL_MS + 5), 'a', '30', '1', 'app']);
    expect(out).toEqual([0, 100]); // swept at its full 100, the 30 charge is dropped
    const h = st.hashes.get('L')!;
    expect([h.get('spent'), h.get('reserved'), h.get('calls'), h.get('o:app:spent')]).toEqual(['100', '0', '1', undefined]);
    expect(mirrorSettle(st, KEYS, [String(NOW + RESERVATION_TTL_MS + 6), 'never-existed', '5', '1', 'app'])).toEqual([0, 100]);
  });
  it('rate: counts both windows, refuses at either limit without consuming, ttl only on the first increment', () => {
    const st = emptyState();
    const run = (m = 2, d = 3) => mirrorRate(st, ['m', 'd'], [String(m), String(d), '120000', '172800000']);
    expect(run()).toEqual([1, 1, 1]);
    expect(st.strings.get('m')!.pttl).toBe(120000);
    expect(st.strings.get('d')!.pttl).toBe(172800000);
    st.strings.get('m')!.pttl = 777; // a later increment must not touch the ttl
    expect(run()).toEqual([1, 2, 2]);
    expect(st.strings.get('m')!.pttl).toBe(777);
    expect(run()).toEqual([0, 2, 2]); // minute limit
    expect(st.strings.get('m')!.value).toBe('2');
    expect(run(5, 2)).toEqual([0, 2, 2]); // day limit
    expect(run(0, 3)).toEqual([0, 2, 2]); // limit 0 never admits
  });
  it('seed: only when no ledger and no reservation exists', () => {
    const st = emptyState();
    expect(mirrorSeed(st, ['L', 'R'], ['500'])).toEqual([1, 500]);
    expect(st.hashes.get('L')!.get('seeded')).toBe('1');
    expect(mirrorSeed(st, ['L', 'R'], ['900'])).toEqual([0, 500]);
    const other = emptyState();
    other.hashes.set('R', new Map([['x', '5']]));
    expect(mirrorSeed(other, ['L', 'R'], ['10'])).toEqual([0, 0]);
  });
});

// ---------- store operations over the fake REST endpoint ----------

describe('AC-L34 reserve and settle through the store', () => {
  it('the EVAL goes to the fake by exact script text, with keys and args as strings and the bearer header', async () => {
    const fake = installFakeStore();
    const r = await sharedReserve(sh(), 1000, 100, 5000);
    expect(r).toMatchObject({ ok: true, spentMicro: 0, reservedMicro: 100 });
    expect(fake.calls).toHaveLength(1);
    const [c] = fake.calls;
    expect(c.auth).toBe(`Bearer ${STORE_TOKEN}`);
    const body = c.body as string[];
    expect(body.slice(0, 3)).toEqual(['EVAL', LUA.reserve, '3']);
    expect(body.slice(3, 6)).toEqual([`${NS}:ledger`, `${NS}:res`, `${NS}:resexp`]);
    expect(body.every((x) => typeof x === 'string')).toBe(true);
    expect(ledgerOf(fake.state)).toMatchObject({ reserved: 100, spent: 0 });
  });

  it('cap refusal at the boundary: exact fit allowed, one micro over refused', async () => {
    const fake = installFakeStore();
    expect((await sharedReserve(sh(), 1000, 600, 1)).ok).toBe(true);
    expect((await sharedReserve(sh(), 1000, 401, 1)).ok).toBe(false);
    expect((await sharedReserve(sh(), 1000, 400, 1)).ok).toBe(true);
    expect(ledgerOf(fake.state)).toMatchObject({ reserved: 1000, spent: 0 });
  });

  it('an expired reservation is kept as spent; a settle that finds its id swept changes nothing', async () => {
    const fake = installFakeStore();
    const a = await sharedReserve(sh(), 1000, 300, 10_000);
    if (!a.ok) throw new Error('setup');
    // Another instance reserves after the TTL: the sweep charges `a` in full.
    const b = await sharedReserve(sh(), 1000, 100, 10_000 + RESERVATION_TTL_MS + 1);
    expect(b).toMatchObject({ ok: true, spentMicro: 300, reservedMicro: 100 });
    expect(ledgerOf(fake.state)).toMatchObject({ spent: 300, reserved: 100, calls: 1, expired: 1 });
    expect(await sharedSettle(sh(), a.id, 120, true, 'app', 10_000 + RESERVATION_TTL_MS + 2)).toBeNull();
    expect(ledgerOf(fake.state)).toMatchObject({ spent: 300, reserved: 100, calls: 1 });
    expect(ledgerOf(fake.state).raw.has('o:app:spent')).toBe(false);
  });

  it('settle through the store: charge replaces the reservation; the status read matches', async () => {
    const fake = installFakeStore();
    const a = await sharedReserve(sh(), micro(5), 2_000_000, 1);
    if (!a.ok) throw new Error('setup');
    expect(await sharedSettle(sh(), a.id, 500_000, true, 'app', 2)).toBe(500_000);
    const st = await sharedStatus(sh(), micro(5));
    expect(st).toMatchObject({ ns: NS, capUSD: 5, spentUSD: 0.5, reservedUSD: 0, remainingUSD: 4.5, calls: 1, expired: 0, origins: { app: { spentUSD: 0.5, calls: 1 } } });
    expect(JSON.stringify(st)).not.toContain(STORE_TOKEN);
    expect(fake.calls.at(-1)!.path).toBe('/pipeline');
  });
});

describe('AC-L34 withSpendGuard on the shared ledger', () => {
  it('reserves before the call, settles from usage, writes one capped call-log line with numbers and codes only', async () => {
    const fake = installFakeStore();
    const env = sharedEnv({ ANTHROPIC_API_KEY: API_KEY });
    let reservedDuring = -1;
    const inner = fakeInner('ok', () => (reservedDuring = ledgerOf(fake.state).reserved));
    await withSpendGuard(inner.client, env).create(params(), { signal: sig(), meta: { turn: 1, req: 2 } });
    expect(reservedDuring).toBe(micro(estimateCostUSD(params())!));
    const cost = micro(costFromUsage(MODEL, { input: 1200, output: 80, cacheCreation: 100, cacheRead: 300 }));
    expect(ledgerOf(fake.state)).toMatchObject({ spent: cost, reserved: 0, calls: 1 });
    expect(ledgerOf(fake.state).raw.get('o:app:spent')).toBe(String(cost));
    const lines = (fake.state.lists.get(`${NS}:calls`) ?? []).map((l) => JSON.parse(l) as CallLine);
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0]).sort()).toEqual(['cache_creation', 'cache_read', 'costUSD', 'input', 'model', 'origin', 'outcome', 'output', 'req', 'totalUSD', 'ts', 'turn']);
    expect(lines[0]).toMatchObject({ outcome: 'ok', turn: 1, req: 2, costUSD: cost / 1e6, totalUSD: cost / 1e6 });
  });

  it('no credential, prompt text, model text or API key reaches any store key, value, list or request body', async () => {
    const fake = installFakeStore();
    const env = sharedEnv({ ANTHROPIC_API_KEY: API_KEY });
    await withSpendGuard(fakeInner('ok').client, env).create(params(), { signal: sig() });
    await withSpendGuard(fakeInner('error').client, env).create(params(), { signal: sig() }).catch(() => {});
    const dump = JSON.stringify({ hashes: [...fake.state.hashes].map(([k, v]) => [k, [...v]]), zsets: [...fake.state.zsets].map(([k, v]) => [k, [...v]]), lists: [...fake.state.lists], strings: [...fake.state.strings], bodies: fake.calls.map((c) => c.body) });
    for (const s of [SHOPPER, 'SHOPPER_SECRET', MODEL_TEXT, 'MODEL_SECRET', API_KEY, STORE_TOKEN, STORE_URL, 'shopping assistant']) expect(dump).not.toContain(s);
    // The token travels only in the Authorization header.
    expect(fake.calls.every((c) => c.auth === `Bearer ${STORE_TOKEN}`)).toBe(true);
  });

  it('cap refusal: spend_cap, no model request, nothing reserved', async () => {
    const fake = installFakeStore();
    const est = micro(estimateCostUSD(params())!);
    await seedLedger(sh(), micro(5) - est + 1);
    const inner = fakeInner();
    await expect(withSpendGuard(inner.client, sharedEnv()).create(params(), { signal: sig() })).rejects.toMatchObject({ reason: 'spend_cap' });
    expect(inner.calls).toHaveLength(0);
    expect(ledgerOf(fake.state).reserved).toBe(0);
    // Landing exactly on the cap is allowed.
    const fake2 = installFakeStore();
    await seedLedger(sh(), micro(5) - est);
    await withSpendGuard(fakeInner().client, sharedEnv()).create(params(), { signal: sig() });
    expect(ledgerOf(fake2.state).calls).toBe(1);
  });

  it('the env can only lower the cap on the shared ledger too', async () => {
    installFakeStore();
    expect(capUSD(sharedEnv({ DUKA_SPEND_CAP_USD: '100' }))).toBe(5);
    const est = micro(estimateCostUSD(params())!);
    const inner = fakeInner();
    await expect(withSpendGuard(inner.client, sharedEnv({ DUKA_SPEND_CAP_USD: String((est - 1) / 1e6) })).create(params(), { signal: sig() })).rejects.toMatchObject({ reason: 'spend_cap' });
    expect(inner.calls).toHaveLength(0);
  });

  it('outcomes: refused-before-send releases (no charge, no call), error and no usage keep the full reservation', async () => {
    const fake = installFakeStore();
    const env = sharedEnv();
    const worst = micro(estimateCostUSD(params())!);
    await expect(withSpendGuard(fakeInner('refused').client, env).create(params(), { signal: sig() })).rejects.toBeInstanceOf(LiveCallRefused);
    expect(ledgerOf(fake.state)).toMatchObject({ spent: 0, reserved: 0, calls: 0 });
    await expect(withSpendGuard(fakeInner('error').client, env).create(params(), { signal: sig() })).rejects.toThrow('500 internal');
    expect(ledgerOf(fake.state)).toMatchObject({ spent: worst, reserved: 0, calls: 1 });
    await withSpendGuard(fakeInner('nousage').client, env).create(params(), { signal: sig() });
    expect(ledgerOf(fake.state)).toMatchObject({ spent: 2 * worst, reserved: 0, calls: 2 });
    const ac = new AbortController();
    const hung = withSpendGuard(fakeInner('hang').client, env).create(params(), { signal: ac.signal });
    await vi.waitFor(() => expect(ledgerOf(fake.state).reserved).toBe(worst));
    ac.abort();
    await expect(hung).rejects.toThrow('aborted');
    expect(ledgerOf(fake.state)).toMatchObject({ spent: 3 * worst, reserved: 0, calls: 3 });
    const outcomes = (fake.state.lists.get(`${NS}:calls`) ?? []).map((l) => (JSON.parse(l) as CallLine).outcome).reverse();
    expect(outcomes).toEqual(['released_refused', 'kept_error', 'kept_no_usage', 'kept_timeout']);
  });

  it('an unknown model is refused before any store call', async () => {
    const fake = installFakeStore();
    const inner = fakeInner();
    await expect(withSpendGuard(inner.client, sharedEnv()).create({ ...params(), model: 'claude-unknown-9' }, { signal: sig() })).rejects.toMatchObject({ reason: 'unknown_model' });
    expect(fake.calls).toHaveLength(0);
    expect(inner.calls).toHaveLength(0);
  });

  it.each<[string, FakeFail]>([
    ['a 500 from the store', 'error500'],
    ['an error body from the store', 'errorBody'],
    ['a non-JSON answer', 'badJson'],
    ['a store slower than its timeout', 'hang'],
  ])('fail closed on %s: ledger_error, ZERO model requests', async (_n, fail) => {
    setStoreTimeoutForTests(40);
    const fake = installFakeStore({ fail });
    const inner = fakeInner();
    const t0 = Date.now();
    const err = await withSpendGuard(inner.client, sharedEnv({ ANTHROPIC_API_KEY: API_KEY })).create(params(), { signal: sig() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpendRefused);
    expect(err).toMatchObject({ reason: 'ledger_error' });
    expect(inner.calls).toHaveLength(0);
    expect(Date.now() - t0).toBeLessThan(1500);
    // Error messages hold fixed codes only: no URL, token or key.
    for (const s of [STORE_URL, STORE_TOKEN, API_KEY, 'example.test']) expect((err as Error).message).not.toContain(s);
    expect(fake.state.hashes.size).toBe(0);
  });

  it('VERCEL=1 with no store env: ledger_error with zero store calls and zero model requests', async () => {
    const fake = installFakeStore();
    const inner = fakeInner();
    await expect(withSpendGuard(inner.client, { VERCEL: '1', ANTHROPIC_API_KEY: API_KEY }).create(params(), { signal: sig() })).rejects.toMatchObject({ reason: 'ledger_error' });
    expect(fake.calls).toHaveLength(0);
    expect(inner.calls).toHaveLength(0);
  });

  it('in a test process with no injected transport every store call is refused (no network, ever)', async () => {
    const inner = fakeInner();
    const err = await withSpendGuard(inner.client, sharedEnv()).create(params(), { signal: sig() }).catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: 'ledger_error' });
    expect(inner.calls).toHaveLength(0);
    await expect(sharedReserve(sh(), 1000, 1)).rejects.toMatchObject({ code: 'blocked_in_tests' });
    await expect(sharedReserve(sh(), 1000, 1)).rejects.toBeInstanceOf(StoreError);
  });

  it('a store error during settle still returns the model answer; the reservation stays and the next sweep charges it in full', async () => {
    const fake = installFakeStore();
    const env = sharedEnv();
    const worst = micro(estimateCostUSD(params())!);
    const inner = fakeInner('ok', () => fake.setFail('error500')); // the store dies after the reserve, before the settle
    const msg = await withSpendGuard(inner.client, env).create(params(), { signal: sig() });
    expect(msg.id).toBe('msg_shared');
    expect(ledgerOf(fake.state)).toMatchObject({ spent: 0, reserved: worst });
    fake.setFail(undefined);
    const r = await sharedReserve(sh(), micro(5), 1, Date.now() + RESERVATION_TTL_MS + 1000);
    expect(r).toMatchObject({ ok: true, spentMicro: worst });
    expect(ledgerOf(fake.state)).toMatchObject({ spent: worst, expired: 1 });
  });

  it('a reserve whose answer is lost is refused (ledger_error) and the stranded reservation is charged by the sweep, never released', async () => {
    const fake = installFakeStore({ fail: 'applyThenError500' });
    const inner = fakeInner();
    const worst = micro(estimateCostUSD(params())!);
    await expect(withSpendGuard(inner.client, sharedEnv()).create(params(), { signal: sig() })).rejects.toMatchObject({ reason: 'ledger_error' });
    expect(inner.calls).toHaveLength(0);
    expect(ledgerOf(fake.state).reserved).toBe(worst);
    fake.setFail(undefined);
    await sharedReserve(sh(), micro(5), 1, Date.now() + RESERVATION_TTL_MS + 1000);
    expect(ledgerOf(fake.state)).toMatchObject({ spent: worst, expired: 1 });
  });
});

// ---------- the race harness ----------

describe('AC-L40 parallel reserves never pass the cap', () => {
  const N = 50;
  const FIT = 8;
  const WORST = 100_000;
  const CAP = FIT * WORST + WORST / 2;
  const latency = () => Math.floor(Math.random() * 6);
  type Fake = ReturnType<typeof createFakeUpstash>;
  /** Runs N parallel attempts through `attempt`, checking spent + reserved <= CAP after EVERY applied store request. */
  async function harness(attempt: (fake: Fake) => Promise<boolean>) {
    const violations: number[] = [];
    const fake = createFakeUpstash({
      token: STORE_TOKEN,
      latency,
      afterApply: (st) => {
        const l = ledgerOf(st);
        if (l.spent + l.reserved > CAP) violations.push(l.spent + l.reserved);
      },
    });
    setStoreFetchForTests(fake.fetch);
    const results = await Promise.all(Array.from({ length: N }, () => attempt(fake)));
    return { admitted: results.filter(Boolean).length, violations, fake };
  }

  it('atomic Lua reserve (the real scripts via the mirrors): exactly FIT admitted, the cap is never passed at any step', async () => {
    const { admitted, violations, fake } = await harness(async () => (await sharedReserve(sh(), CAP, WORST)).ok);
    expect(admitted).toBe(FIT);
    expect(violations).toEqual([]);
    expect(ledgerOf(fake.state).reserved).toBe(FIT * WORST);
  });

  it('CONTROL: a non-atomic read-then-write reserve through the same harness DOES overspend (the harness can see a race)', async () => {
    const post = async (fake: Fake, body: string[]) => {
      const res = await fake.fetch(`${STORE_URL}`, { method: 'POST', headers: { Authorization: `Bearer ${STORE_TOKEN}` }, body: JSON.stringify(body) });
      return ((await res.json()) as { result: unknown }).result;
    };
    const { admitted, violations } = await harness(async (fake) => {
      const all = (await post(fake, ['HGETALL', ledgerKey])) as string[];
      const h = new Map<string, string>();
      for (let i = 0; i < all.length; i += 2) h.set(all[i], all[i + 1]);
      if (Number(h.get('spent') ?? 0) + Number(h.get('reserved') ?? 0) + WORST > CAP) return false; // read ...
      await post(fake, ['HINCRBY', ledgerKey, 'reserved', String(WORST)]); // ... then write: another request can slip in between
      return true;
    });
    expect(admitted).toBeGreaterThan(FIT);
    expect(violations.length).toBeGreaterThan(0);
  });

  it('50 parallel guarded creates with random latency: exactly FIT reach the model, the rest get spend_cap, invariant holds at every step', async () => {
    const worstUSD = estimateCostUSD(params())!;
    const worst = micro(worstUSD);
    const cap = Math.round((FIT + 0.5) * worst);
    const violations: number[] = [];
    const fake = createFakeUpstash({
      token: STORE_TOKEN,
      latency,
      afterApply: (st) => {
        const l = ledgerOf(st);
        if (l.spent + l.reserved > cap) violations.push(l.spent + l.reserved);
      },
    });
    setStoreFetchForTests(fake.fetch);
    // Hold every admitted call open until all 50 reserve decisions are made, so no settle frees room mid-race.
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let entered = 0;
    const inner: PlannerClient = {
      kind: 'live',
      async create() {
        entered++;
        await gate;
        return reply();
      },
    };
    const env = sharedEnv({ DUKA_SPEND_CAP_USD: String(cap / 1e6) });
    expect(micro(capUSD(env))).toBe(cap);
    const guard = withSpendGuard(inner, env);
    let refused = 0;
    const all = Array.from({ length: N }, () =>
      guard.create(params(), { signal: sig() }).then(
        () => 'ok' as const,
        (e: unknown) => {
          if (e instanceof SpendRefused && e.reason === 'spend_cap') refused++;
          return 'refused' as const;
        },
      ),
    );
    await vi.waitFor(() => expect(entered + refused).toBe(N));
    expect(entered).toBe(FIT);
    expect(ledgerOf(fake.state)).toMatchObject({ spent: 0, reserved: FIT * worst });
    open();
    const out = await Promise.all(all);
    expect(out.filter((x) => x === 'ok')).toHaveLength(FIT);
    expect(violations).toEqual([]);
    const actual = micro(costFromUsage(MODEL, { input: 1200, output: 80, cacheCreation: 100, cacheRead: 300 }));
    expect(ledgerOf(fake.state)).toMatchObject({ spent: FIT * actual, reserved: 0, calls: FIT });
  });
});

// ---------- seed ----------

describe('AC-L38 seed', () => {
  it('seeds only once: a second seed, a seed after a reserve, and 10 parallel seeds (one wins)', async () => {
    const fake = installFakeStore({ latency: () => Math.floor(Math.random() * 4) });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => seedLedger(sh(), 100_000 * (i + 1))));
    expect(results.filter((r) => r.seeded)).toHaveLength(1);
    const winner = results.find((r) => r.seeded)!;
    expect(ledgerOf(fake.state).spent).toBe(winner.spentMicro);
    expect(results.filter((r) => !r.seeded).every((r) => r.spentMicro === winner.spentMicro)).toBe(true);
    expect(ledgerOf(fake.state).raw.get('seeded')).toBe('1');

    installFakeStore();
    await sharedReserve(sh(), micro(5), 1000, 1);
    expect(await seedLedger(sh(), 5)).toEqual({ seeded: false, spentMicro: 0 });
  });

  it('seeded spent counts toward the cap', async () => {
    installFakeStore();
    await seedLedger(sh(), micro(4.9995));
    expect((await sharedReserve(sh(), micro(5), 500, 1)).ok).toBe(true);
    expect((await sharedReserve(sh(), micro(5), 1, 1)).ok).toBe(false);
  });
});
