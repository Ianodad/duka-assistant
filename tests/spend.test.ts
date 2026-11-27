/**
 * SPEC-LIVE AC-L1 to AC-L8: spend ledger, pre-call guard, post-call accounting,
 * panel note, status script, request shape and shape trace. Mocks only, temp
 * ledger dirs only, zero network (the setup file checks the live counters).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantTurn } from '@/components/assistant/AssistantTurn';
import { LiveCallRefused, type CreateParams, type PlannerClient } from '@/lib/assistant/claude/client';
import { liveGate, modeInfo, REQUEST_DEFAULTS, requestShape, spendTestHookEnabled } from '@/lib/assistant/claude/config';
import { buildRequest } from '@/lib/assistant/claude/loop';
import { planWithClaude } from '@/lib/assistant/claude/planner';
import { capUSD, costFromUsage, estimateCostUSD, estimateInputTokens, HARD_CAP_USD, LOCK_STALE_MS, LOCK_WAIT_MS, readLedger, reserve, SpendRefused, withLock, spendStatus, withSpendGuard, type CallLine, type Ledger } from '@/lib/assistant/claude/spend';
import { respond } from '@/lib/assistant/http';
import { NOTE_TEXT } from '@/lib/assistant/notes';
import { regexAnswer } from '@/lib/assistant/regex-answer';
import { SUBTITLES, subtitleFor } from '@/lib/assistant/subtitle';
import { clearCart } from '@/lib/shop/cart';
import { SID_A } from './helpers';

const FAKE_KEY = 'FAKE_ANTHROPIC_KEY_DO_NOT_USE_spendtest';
const MODEL = 'claude-sonnet-5-5';
const SHOPPER = 'SHOPPER_SECRET_TEXT_unga please';
const MODEL_TEXT = 'MODEL_SECRET_TEXT_do not log me';

let dir: string;
let env: Record<string, string | undefined>;
const tmp = () => mkdtempSync(join(tmpdir(), 'duka-spend-'));
const params = (text = SHOPPER): CreateParams => buildRequest(MODEL, [{ role: 'user', content: [{ type: 'text', text }] }]);
const ledgerFile = () => join(dir, 'ledger.json');
const callLines = (): CallLine[] => (existsSync(join(dir, 'calls.jsonl')) ? readFileSync(join(dir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as CallLine) : []);
function prefill(spentUSD: number, extra: Partial<Ledger> = {}) {
  const l: Ledger = { version: 1, capUSD: 5, spentUSD, reservedUSD: 0, calls: 0, origins: {}, updatedAt: new Date().toISOString(), ...extra };
  writeFileSync(ledgerFile(), JSON.stringify(l));
}

const usage = { input_tokens: 1200, output_tokens: 80, cache_creation_input_tokens: 100, cache_read_input_tokens: 300 };
function reply(withUsage = true): Anthropic.Message {
  return {
    id: 'msg_spend',
    type: 'message',
    role: 'assistant',
    model: MODEL,
    content: [
      { type: 'text', text: MODEL_TEXT },
      { type: 'tool_use', id: 'toolu_1', name: 'search_products', input: { query: MODEL_TEXT } },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    ...(withUsage ? { usage } : {}),
  } as unknown as Anthropic.Message;
}
/** A fake inner client. mode: answer, slow answer, hang until abort, throw LiveCallRefused, throw an API-ish error. */
function fake(mode: 'ok' | 'slow' | 'hang' | 'refused' | 'error' | 'nousage' = 'ok') {
  const calls: CreateParams[] = [];
  const client: PlannerClient = {
    kind: 'live',
    create(p, { signal }) {
      calls.push(p);
      if (mode === 'refused') return Promise.reject(new LiveCallRefused());
      if (mode === 'error') return Promise.reject(new Error('500 internal'));
      if (mode === 'hang')
        return new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'APIUserAbortError' })), { once: true }));
      if (mode === 'slow') return new Promise((res) => setTimeout(() => res(reply()), 20));
      return Promise.resolve(reply(mode !== 'nousage'));
    },
  };
  return { client, calls };
}
const sig = () => new AbortController().signal;

beforeEach(() => {
  dir = tmp();
  env = { DUKA_SPEND_DIR: dir, ANTHROPIC_API_KEY: FAKE_KEY };
  clearCart(SID_A);
});
afterEach(() => vi.restoreAllMocks());

describe('AC-L3 estimate and price table', () => {
  it('input tokens are an upper bound (>= serialised UTF-8 bytes), cost = input x 2.00 + max_tokens x 10.00 per million', () => {
    const p = params();
    expect(estimateInputTokens(p)).toBeGreaterThanOrEqual(Buffer.byteLength(JSON.stringify({ system: p.system, tools: p.tools, messages: p.messages }), 'utf8'));
    expect(estimateCostUSD(p)).toBeCloseTo((estimateInputTokens(p) * 2 + 1024 * 10) / 1e6, 6);
  });
  it('an unknown model is refused before any call', async () => {
    const f = fake();
    const g = withSpendGuard(f.client, env);
    await expect(g.create({ ...params(), model: 'claude-unknown-9' }, { signal: sig() })).rejects.toMatchObject({ reason: 'unknown_model' });
    expect(f.calls).toHaveLength(0);
  });
  it('actual cost from usage uses all four prices', () => {
    expect(costFromUsage(MODEL, { input: 1_000_000, output: 1_000_000, cacheCreation: 1_000_000, cacheRead: 1_000_000 })).toBeCloseTo(2 + 10 + 2.5 + 0.2, 6);
  });
});

describe('AC-L3 pre-call guard', () => {
  it('allows a call under the cap and reserves the estimate before the call', async () => {
    let reservedDuring = -1;
    const inner: PlannerClient = {
      kind: 'live',
      async create() {
        reservedDuring = readLedger(env).reservedUSD;
        return reply();
      },
    };
    await withSpendGuard(inner, env).create(params(), { signal: sig() });
    expect(reservedDuring).toBeCloseTo(estimateCostUSD(params())!, 6);
  });

  it('refuses at the cap boundary: spent == cap, and one cent over; allows landing exactly on the cap', async () => {
    const est = estimateCostUSD(params())!;
    prefill(HARD_CAP_USD);
    const f = fake();
    await expect(withSpendGuard(f.client, env).create(params(), { signal: sig() })).rejects.toBeInstanceOf(SpendRefused);
    prefill(HARD_CAP_USD - est + 0.01);
    await expect(withSpendGuard(f.client, env).create(params(), { signal: sig() })).rejects.toMatchObject({ reason: 'spend_cap' });
    expect(f.calls).toHaveLength(0); // refused before any network
    prefill(HARD_CAP_USD - est);
    expect(reserve(params(), env).ok).toBe(true);
  });

  it('the reservation stops two concurrent calls from jointly crossing the cap', async () => {
    const est = estimateCostUSD(params())!;
    const e = { ...env, DUKA_SPEND_CAP_USD: String(est * 1.5) };
    const f = fake('slow');
    const g = withSpendGuard(f.client, e);
    const [a, b] = await Promise.allSettled([g.create(params(), { signal: sig() }), g.create(params(), { signal: sig() })]);
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
    const rej = [a, b].find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(rej.reason).toBeInstanceOf(SpendRefused);
    expect(f.calls).toHaveLength(1);
  });

  it('the cap cannot be raised by env but can be lowered; nonsense fails closed', async () => {
    expect(capUSD({})).toBe(5);
    expect(capUSD({ DUKA_SPEND_CAP_USD: '100' })).toBe(5);
    expect(capUSD({ DUKA_SPEND_CAP_USD: '1.5' })).toBe(1.5);
    expect(capUSD({ DUKA_SPEND_CAP_USD: 'lots' })).toBe(0);
    expect(capUSD({ DUKA_SPEND_CAP_USD: '-1' })).toBe(0);
    prefill(4.999);
    expect(reserve(params(), { ...env, DUKA_SPEND_CAP_USD: '100' })).toMatchObject({ ok: false, reason: 'spend_cap' });
    prefill(0.5);
    expect(reserve(params(), { ...env, DUKA_SPEND_CAP_USD: '0.5' })).toMatchObject({ ok: false, reason: 'spend_cap' });
    // A capUSD written into the file does not raise the cap either.
    prefill(4.999, { capUSD: 1000 });
    expect(reserve(params(), env)).toMatchObject({ ok: false, reason: 'spend_cap' });
  });

  it('ledger.lock: a held lock refuses after the wait (fail closed); each call leaves no lock behind', async () => {
    const lock = join(dir, 'ledger.lock');
    await withSpendGuard(fake().client, env).create(params(), { signal: sig() });
    expect(existsSync(lock)).toBe(false);
    writeFileSync(lock, 'other.owner');
    const t0 = Date.now();
    expect(reserve(params(), env)).toMatchObject({ ok: false, reason: 'ledger_error' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(LOCK_WAIT_MS);
    expect(readFileSync(lock, 'utf8')).toBe('other.owner');
  });

  it('ledger.lock: a stale lock is NEVER removed or reclaimed; the call is refused as stale_lock (typed) and charges nothing', async () => {
    const lock = join(dir, 'ledger.lock');
    prefill(1);
    writeFileSync(lock, '999999.crashedholder');
    const old = (Date.now() - LOCK_STALE_MS - 5_000) / 1000;
    utimesSync(lock, old, old);
    const f = fake();
    expect(reserve(params(), env)).toMatchObject({ ok: false, reason: 'stale_lock' });
    await expect(withSpendGuard(f.client, env).create(params(), { signal: sig() })).rejects.toMatchObject({ reason: 'stale_lock' });
    expect(f.calls).toHaveLength(0);
    expect(readFileSync(lock, 'utf8')).toBe('999999.crashedholder');
    expect(readLedger(env)).toMatchObject({ spentUSD: 1, reservedUSD: 0, calls: 0 });
    // Through the planner: the fixed fallback, never a model render.
    const a = await planWithClaude('search tea', SID_A, 1, { env: { NODE_ENV: 'test', DUKA_PLANNER: 'claude', DUKA_PLANNER_CLIENT: 'mock', DUKA_SPEND_TEST_PRICE_MOCK: '1', DUKA_SPEND_DIR: dir }, log: () => {} });
    expect(a.source).toBe('regex-fallback');
    expect(a.diag).toMatch(/reason=spend_refused/);
  });

  it('ledger.lock: the lock holds an ownership token; cleanup never removes a lock that is not ours', () => {
    const lock = join(dir, 'ledger.lock');
    let token = '';
    withLock(env, () => {
      token = readFileSync(lock, 'utf8');
    });
    expect(token).toMatch(new RegExp(`^${process.pid}\\.[0-9a-f]{24}$`));
    expect(existsSync(lock)).toBe(false);
    // Simulate a successor's lock appearing while we hold ours (it never should): our cleanup leaves it alone.
    withLock(env, () => {
      writeFileSync(lock, 'successor.token');
    });
    expect(readFileSync(lock, 'utf8')).toBe('successor.token');
  });

  it('missing ledger = fresh at 0; corrupt or wrong-shape ledger fails CLOSED; tests without a temp dir are refused', async () => {
    expect(readLedger(env)).toMatchObject({ spentUSD: 0, reservedUSD: 0, calls: 0 });
    expect(reserve(params(), env).ok).toBe(true);
    const f = fake();
    writeFileSync(ledgerFile(), '{not json');
    await expect(withSpendGuard(f.client, env).create(params(), { signal: sig() })).rejects.toMatchObject({ reason: 'ledger_error' });
    writeFileSync(ledgerFile(), JSON.stringify({ version: 1, spentUSD: -3 }));
    expect(reserve(params(), env)).toMatchObject({ ok: false, reason: 'ledger_error' });
    writeFileSync(ledgerFile(), JSON.stringify({ version: 1, capUSD: 5, spentUSD: 0, reservedUSD: 0, calls: 0, origins: {}, updatedAt: 'x', extra: 1 }));
    expect(reserve(params(), env)).toMatchObject({ ok: false, reason: 'ledger_error' });
    expect(reserve(params(), { ANTHROPIC_API_KEY: FAKE_KEY })).toMatchObject({ ok: false, reason: 'ledger_error' });
    expect(f.calls).toHaveLength(0);
  });
});

describe('AC-L4 post-call accounting', () => {
  it('actual usage replaces the reservation; calls and origin sums update', async () => {
    const e = { ...env, DUKA_SPEND_ORIGIN: 'box' };
    await withSpendGuard(fake().client, e).create(params(), { signal: sig(), meta: { turn: 3, req: 2 } });
    const l = readLedger(e);
    const actual = costFromUsage(MODEL, { input: 1200, output: 80, cacheCreation: 100, cacheRead: 300 });
    expect(l.reservedUSD).toBe(0);
    expect(l.spentUSD).toBeCloseTo(actual, 6);
    expect(l.calls).toBe(1);
    expect(l.origins.box).toEqual({ spentUSD: l.spentUSD, calls: 1 });
    const [line] = callLines();
    expect(line).toMatchObject({ origin: 'box', model: MODEL, turn: 3, req: 2, input: 1200, output: 80, cache_creation: 100, cache_read: 300, outcome: 'ok' });
    expect(line.costUSD).toBeCloseTo(actual, 6);
    expect(line.totalUSD).toBeCloseTo(actual, 6);
  });

  it('a timeout (abort) keeps the reservation as the charge', async () => {
    const ac = new AbortController();
    const p = withSpendGuard(fake('hang').client, env).create(params(), { signal: ac.signal });
    setTimeout(() => ac.abort(), 5);
    await expect(p).rejects.toThrow();
    const l = readLedger(env);
    expect(l.reservedUSD).toBe(0);
    expect(l.spentUSD).toBeCloseTo(estimateCostUSD(params())!, 6);
    expect(callLines()[0].outcome).toBe('kept_timeout');
  });

  it('an API error with no usage keeps the reservation; a response without usage keeps it too', async () => {
    await expect(withSpendGuard(fake('error').client, env).create(params(), { signal: sig() })).rejects.toThrow();
    await withSpendGuard(fake('nousage').client, env).create(params(), { signal: sig() });
    expect(readLedger(env).spentUSD).toBeCloseTo(2 * estimateCostUSD(params())!, 6);
    expect(callLines().map((l) => l.outcome)).toEqual(['kept_error', 'kept_no_usage']);
  });

  it('a definite client-side refusal before send (LiveCallRefused) releases the reservation', async () => {
    await expect(withSpendGuard(fake('refused').client, env).create(params(), { signal: sig() })).rejects.toBeInstanceOf(LiveCallRefused);
    const l = readLedger(env);
    expect(l).toMatchObject({ spentUSD: 0, reservedUSD: 0, calls: 0 });
    expect(callLines()[0]).toMatchObject({ outcome: 'released_refused', costUSD: 0 });
  });

  it('a LiveCallRefused wrapped by the SDK (APIConnectionError cause) is also released, not charged', async () => {
    const { default: Sdk } = await import('@anthropic-ai/sdk');
    const inner: PlannerClient = { kind: 'live', create: () => Promise.reject(new Sdk.APIConnectionError({ cause: new LiveCallRefused() })) };
    await expect(withSpendGuard(inner, env).create(params(), { signal: sig() })).rejects.toBeInstanceOf(Sdk.APIConnectionError);
    expect(readLedger(env)).toMatchObject({ spentUSD: 0, reservedUSD: 0, calls: 0 });
    expect(callLines()[0].outcome).toBe('released_refused');
  });

  it('the ledger survives a reload (a fresh module instance reads the file)', async () => {
    await withSpendGuard(fake().client, env).create(params(), { signal: sig() });
    const before = readLedger(env);
    vi.resetModules();
    const fresh = await import('@/lib/assistant/claude/spend');
    expect(fresh.readLedger(env)).toEqual(before);
    expect(fresh.spendStatus(env)).toMatchObject({ capUSD: 5, spentUSD: before.spentUSD, calls: 1 });
  });

  it('calls.jsonl and the ledger hold no prompt text, no model text, no tool input, no key', async () => {
    await withSpendGuard(fake().client, env).create(params(), { signal: sig() });
    const raw = readFileSync(join(dir, 'calls.jsonl'), 'utf8') + readFileSync(ledgerFile(), 'utf8');
    for (const s of [SHOPPER, 'SHOPPER_SECRET', MODEL_TEXT, 'MODEL_SECRET', FAKE_KEY, 'shopping assistant']) expect(raw).not.toContain(s);
    expect(Object.keys(callLines()[0]).sort()).toEqual(['cache_creation', 'cache_read', 'costUSD', 'input', 'model', 'origin', 'outcome', 'output', 'req', 'totalUSD', 'ts', 'turn']);
  });
});

describe('AC-L5 refusal in the planner: regex answer plus the fixed note', () => {
  const MOCK_PRICED = () => ({ NODE_ENV: 'test', DUKA_PLANNER: 'claude', DUKA_PLANNER_CLIENT: 'mock', DUKA_SPEND_TEST_PRICE_MOCK: '1', DUKA_SPEND_DIR: dir });

  it('at the cap: source regex-fallback, note spend_cap, and the same reply as the regex planner', async () => {
    prefill(HARD_CAP_USD);
    const lines: string[] = [];
    const a = await planWithClaude('search tea', SID_A, 1, { env: MOCK_PRICED(), log: (l) => lines.push(l) });
    expect(a.source).toBe('regex-fallback');
    expect(a.note).toBe('spend_cap');
    expect(a.reply).toEqual(regexAnswer('search tea', SID_A, 1).reply);
    expect(lines.at(-1)).toMatch(/outcome=fallback reason=spend_cap/);
  });

  it('under the cap the priced mock renders normally and the ledger records the fixture usage', async () => {
    const a = await planWithClaude('search tea', SID_A, 1, { env: MOCK_PRICED(), log: () => {} });
    expect(a.source).toBe('claude');
    expect(a.note).toBeUndefined();
    expect(readLedger(MOCK_PRICED()).calls).toBe(2);
  });

  it('the mock client bypasses the ledger by default (costs 0, no file written)', async () => {
    const a = await planWithClaude('search tea', SID_A, 1, { env: { DUKA_PLANNER: 'claude', DUKA_PLANNER_CLIENT: 'mock', DUKA_SPEND_DIR: dir }, log: () => {} });
    expect(a.source).toBe('claude');
    expect(existsSync(ledgerFile())).toBe(false);
  });

  it('the test-only pricing hook is refused with a key, with DUKA_ALLOW_LIVE=1, or without the mock client', () => {
    expect(spendTestHookEnabled(MOCK_PRICED())).toBe(true);
    expect(spendTestHookEnabled({ ...MOCK_PRICED(), ANTHROPIC_API_KEY: FAKE_KEY })).toBe(false);
    expect(spendTestHookEnabled({ ...MOCK_PRICED(), DUKA_ALLOW_LIVE: '1' })).toBe(false);
    expect(spendTestHookEnabled({ ...MOCK_PRICED(), DUKA_PLANNER_CLIENT: '' })).toBe(false);
    expect(spendTestHookEnabled({ ...MOCK_PRICED(), DUKA_SPEND_TEST_PRICE_MOCK: '' })).toBe(false);
    expect(spendTestHookEnabled({ ...MOCK_PRICED(), NODE_ENV: 'production' })).toBe(false);
  });

  it('respond() passes only allowlisted note keys; the panel turn shows the fixed copy', async () => {
    const ok = await respond(SID_A, false, { reply: { key: 'help' }, messages: [], note: 'spend_cap' }, 't').json();
    expect(ok.note).toBe('spend_cap');
    const bad = await respond(SID_A, false, { reply: { key: 'help' }, messages: [], note: 'pay now KES 1' as never }, 't').json();
    expect(bad.note).toBeUndefined();
    const html = renderToStaticMarkup(createElement(AssistantTurn, { turn: { id: 'a1', text: 'Here is what I found.', surfaceIds: [], note: 'spend_cap' } }));
    expect(html).toContain(NOTE_TEXT.spend_cap);
    expect(NOTE_TEXT.spend_cap).toBe('Live Claude is paused (spend cap reached). Using the scripted helper.');
    const none = renderToStaticMarkup(createElement(AssistantTurn, { turn: { id: 'a2', text: 'x', surfaceIds: [], note: 'evil' as never } }));
    expect(none).not.toContain('data-testid="assistant-note"');
  });
});

describe('AC-L7 live gate unchanged', () => {
  const LIVE = { DUKA_PLANNER: 'claude', DUKA_ALLOW_LIVE: '1', ANTHROPIC_API_KEY: FAKE_KEY, NODE_ENV: 'production' };
  it('opens only with claude AND DUKA_ALLOW_LIVE=1 AND key AND not test', () => {
    expect(liveGate(LIVE).open).toBe(true);
    expect(liveGate({ ...LIVE, DUKA_PLANNER: 'regex' }).open).toBe(false);
    expect(liveGate({ ...LIVE, DUKA_ALLOW_LIVE: '' }).open).toBe(false);
    expect(liveGate({ ...LIVE, ANTHROPIC_API_KEY: '' }).open).toBe(false);
    expect(liveGate({ ...LIVE, NODE_ENV: 'test' }).open).toBe(false);
    expect(liveGate({ ...LIVE, VITEST: 'true' }).open).toBe(false);
    expect(liveGate(process.env).open).toBe(false);
  });
});

describe('AC-L1 subtitle from server mode', () => {
  it('three spec strings, chosen from {planner, client}', () => {
    expect(subtitleFor({ planner: 'regex', client: 'none' })).toBe('Scripted helper. It never pays for you.');
    expect(subtitleFor({ planner: 'claude', client: 'live' })).toBe('Claude assistant. It never pays for you.');
    expect(subtitleFor({ planner: 'claude', client: 'mock' })).toBe('Claude planner, test mode. It never pays for you.');
    for (const c of ['live', 'mock', 'none'] as const) expect(subtitleFor({ planner: 'claude', client: c })).not.toContain(SUBTITLES.regex);
  });
  it('modeInfo reads only the server env and returns two enum fields', () => {
    expect(modeInfo({})).toEqual({ planner: 'regex', client: 'none' });
    expect(modeInfo({ DUKA_PLANNER: 'claude', DUKA_PLANNER_CLIENT: 'mock' })).toEqual({ planner: 'claude', client: 'mock' });
    expect(modeInfo({ DUKA_PLANNER: 'claude', DUKA_ALLOW_LIVE: '1', ANTHROPIC_API_KEY: FAKE_KEY, NODE_ENV: 'production' })).toEqual({ planner: 'claude', client: 'live' });
    expect(modeInfo({ DUKA_PLANNER: 'claude' })).toEqual({ planner: 'claude', client: 'none' });
    expect(modeInfo({ DUKA_PLANNER: 'bogus' })).toEqual({ planner: 'regex', client: 'none' });
    expect(JSON.stringify(modeInfo({ DUKA_PLANNER: 'claude', DUKA_ALLOW_LIVE: '1', ANTHROPIC_API_KEY: FAKE_KEY, NODE_ENV: 'production' }))).not.toContain(FAKE_KEY);
  });
});

describe('AC-L8 request shape in one place, shape trace', () => {
  it('defaults: between_tools, effort low, tool_choice auto; env can adjust; bad values keep defaults', () => {
    expect(REQUEST_DEFAULTS).toEqual({ thinking: 'between_tools', effort: 'low', toolChoice: 'auto' });
    const d = buildRequest(MODEL, [], requestShape({}));
    expect(d).toMatchObject({ thinking: { type: 'between_tools' }, output_config: { effort: 'low' }, tool_choice: { type: 'auto' } });
    const a = buildRequest(MODEL, [], requestShape({ DUKA_CLAUDE_THINKING: 'adaptive', DUKA_CLAUDE_EFFORT: 'medium' }));
    expect(a).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } });
    const o = buildRequest(MODEL, [], requestShape({ DUKA_CLAUDE_THINKING: 'omit', DUKA_CLAUDE_EFFORT: 'omit' }));
    expect('thinking' in o || 'output_config' in o).toBe(false);
    expect(requestShape({ DUKA_CLAUDE_THINKING: 'disabled', DUKA_CLAUDE_EFFORT: 'max' })).toEqual(requestShape({}));
  });

  it('DUKA_LIVE_TRACE=1 logs only shape: no prompt, model text, tool input or key; off by default', async () => {
    const lines: string[] = [];
    await withSpendGuard(fake().client, { ...env, DUKA_LIVE_TRACE: '1' }, (l) => lines.push(l)).create(params(), { signal: sig() });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[claude-trace\] req model=claude_sonnet_5_5 thinking=between_tools effort=low tool_choice=auto tools=\S+ messages=1 max_tokens=1024 cache=off$/);
    expect(lines[1]).toMatch(/^\[claude-trace\] res stop=tool_use blocks=text,tool_use tool_uses=search_products usage_in=1200 usage_out=80 cache_write=100 cache_read=300 ms=\d+$/);
    for (const s of [SHOPPER, MODEL_TEXT, FAKE_KEY, 'Duka']) expect(lines.join('\n')).not.toContain(s);
    const quiet: string[] = [];
    await withSpendGuard(fake().client, env, (l) => quiet.push(l)).create(params(), { signal: sig() });
    expect(quiet).toHaveLength(0);
  });
});

describe('AC-L6 status helper and pnpm spend script', () => {
  it('spendStatus reports cap, spent, reserved, remaining and the last 5 lines', async () => {
    for (let i = 0; i < 7; i++) await withSpendGuard(fake().client, env).create(params(), { signal: sig(), meta: { turn: i, req: 1 } });
    const s = spendStatus(env);
    expect(s.capUSD).toBe(5);
    expect(s.calls).toBe(7);
    expect(s.lastCalls.map((l) => l.turn)).toEqual([2, 3, 4, 5, 6]);
    expect(s.remainingUSD).toBeCloseTo(5 - s.spentUSD, 6);
  });

  it('scripts/spend-report.cjs prints the status and never the key; a corrupt ledger exits 1', async () => {
    await withSpendGuard(fake().client, env).create(params(), { signal: sig() });
    const run = (e: Record<string, string>) => execFileSync(process.execPath, [join(process.cwd(), 'scripts', 'spend-report.cjs')], { env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', ...e }, encoding: 'utf8' });
    const out = run({ DUKA_SPEND_DIR: dir, ANTHROPIC_API_KEY: FAKE_KEY, DUKA_SPEND_CAP_USD: '9' });
    expect(out).toMatch(/capUSD:\s+\$5\.0000/);
    expect(out).toMatch(/remaining:\s+\$4\.\d{4}/);
    expect(out).toMatch(/last 1 calls:\n {2}ts=\S+ origin=app model=claude-sonnet-5-5 turn=0 req=0 input=1200 output=80/);
    expect(out).not.toContain(FAKE_KEY);
    writeFileSync(ledgerFile(), 'garbage');
    expect(() => run({ DUKA_SPEND_DIR: dir })).toThrow();
  });
});
