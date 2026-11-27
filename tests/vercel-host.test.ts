/**
 * SPEC-LIVE AC-L35 to AC-L40 at planner and route level: the per-IP gate, fail
 * closed, prompt length, the operator CLI and the client bundle check.
 * In-memory fake store, no network, no model request (live counters stay 0).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/assistant/route';
import { liveCounters, type PlannerClient } from '@/lib/assistant/claude/client';
import { _resetLiveBudgetForTests, planWithClaude } from '@/lib/assistant/claude/planner';
import { readLedger, withSpendGuard } from '@/lib/assistant/claude/spend';
import { LUA, ledgerSelection, seedLedger, setStoreFetchForTests, setStoreTimeoutForTests } from '@/lib/assistant/claude/store';
import { MAX_PROMPT_CHARS } from '@/lib/assistant/http';
import { NOTE_TEXT } from '@/lib/assistant/notes';
import { regexAnswer } from '@/lib/assistant/regex-answer';
import { clearCart } from '@/lib/shop/cart';
import { runCli } from '../scripts/ledger-cli';
import { SID_A, SID_B } from './helpers';
import { installFakeStore, ledgerOf, NS, sharedEnv, STORE_TOKEN, STORE_URL, useStoreCleanup } from './fakes/store-helpers';

useStoreCleanup();

const API_KEY = 'FAKE_ANTHROPIC_KEY_DO_NOT_USE_vercelhost';
const IP = '198.51.100.23';
const ROOT = join(__dirname, '..');

/** A live-shaped env (gate open) so the planner reaches the per-IP gate; in a test process no client can actually be built. */
const LIVE = (extra: Record<string, string | undefined> = {}) => ({ NODE_ENV: 'production', DUKA_PLANNER: 'claude', DUKA_ALLOW_LIVE: '1', ANTHROPIC_API_KEY: API_KEY, ...extra });
/** The test-only priced mock: goes through the spend guard and the same per-IP gate. */
const MOCK_PRICED = (extra: Record<string, string | undefined> = {}) => ({ NODE_ENV: 'test', DUKA_PLANNER: 'claude', DUKA_PLANNER_CLIENT: 'mock', DUKA_SPEND_TEST_PRICE_MOCK: '1', ...extra });
const shared = () => {
  const s = ledgerSelection(sharedEnv());
  if (s.kind !== 'shared' || !s.cfg) throw new Error('test setup');
  return { cfg: s.cfg, ns: s.ns };
};

beforeEach(() => {
  _resetLiveBudgetForTests();
  clearCart(SID_A);
  clearCart(SID_B);
});
afterEach(() => vi.unstubAllEnvs());

const counters = () => ({ ...liveCounters });
const live = async (env: Record<string, string | undefined>, ip: string | undefined, sid = SID_A, lines: string[] = []) => planWithClaude('search tea', sid, 1, { env, ip, log: (l) => lines.push(l) });

describe('AC-L36 fail closed in the planner: no model request, scripted answer, note live_unavailable', () => {
  it('VERCEL=1 with no store env', async () => {
    const fake = installFakeStore();
    const before = counters();
    const lines: string[] = [];
    const a = await live(LIVE({ VERCEL: '1' }), IP, SID_A, lines);
    expect(a.source).toBe('regex-fallback');
    expect(a.note).toBe('live_unavailable');
    expect(a.reply).toEqual(regexAnswer('search tea', SID_A, 1).reply);
    expect(lines.at(-1)).toMatch(/outcome=fallback reason=store_unavailable/);
    expect(counters()).toEqual(before);
    expect(fake.calls).toHaveLength(0);
  });

  it.each([['error500'], ['errorBody'], ['badJson'], ['hang']] as const)('store failure %s (live path)', async (fail) => {
    setStoreTimeoutForTests(40);
    installFakeStore({ fail });
    const before = counters();
    const a = await live(LIVE(sharedEnv()), IP);
    expect(a.source).toBe('regex-fallback');
    expect(a.note).toBe('live_unavailable');
    expect(a.diag).toMatch(/reason=store_unavailable/);
    expect(counters()).toEqual(before); // no client was built, nothing was sent
  });

  it.each([['error500'], ['errorBody'], ['badJson'], ['hang']] as const)('store failure %s (priced mock path)', async (fail) => {
    setStoreTimeoutForTests(40);
    installFakeStore({ fail });
    const a = await live(MOCK_PRICED(sharedEnv()), IP);
    expect(a.source).toBe('regex-fallback');
    expect(a.note).toBe('live_unavailable');
    expect(a.reply).toEqual(regexAnswer('search tea', SID_A, 1).reply);
  });

  it('in a test process with no injected transport the store is unreachable: live_unavailable', async () => {
    const a = await live(LIVE(sharedEnv()), IP);
    expect(a.note).toBe('live_unavailable');
  });

  it('the rate gate passes but the RESERVE fails: the answer is the scripted one with live_unavailable, not "cap reached"', async () => {
    const fake = installFakeStore();
    setStoreFetchForTests(((u: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as unknown;
      if (Array.isArray(body) && body[0] === 'EVAL' && body[1] === LUA.reserve) return Promise.resolve(new Response('{"error":"boom"}', { status: 500 }));
      return fake.fetch(u, init);
    }) as typeof fetch);
    const a = await live(MOCK_PRICED(sharedEnv()), IP);
    expect(a.source).toBe('regex-fallback');
    expect(a.note).toBe('live_unavailable');
    expect(a.diag).toMatch(/reason=spend_refused/);
    expect(ledgerOf(fake.state).reserved).toBe(0);
  });

  it('a shared-ledger cap refusal keeps the spend_cap note', async () => {
    installFakeStore();
    await seedLedger(shared(), 5_000_000);
    const a = await live(MOCK_PRICED(sharedEnv()), IP);
    expect(a.note).toBe('spend_cap');
    expect(a.diag).toMatch(/reason=spend_cap/);
  });
});

describe('AC-L35 per-IP gate in the planner', () => {
  it('5 prompts per minute pass the gate; the 6th gets the scripted answer with rate_limited and no model request', async () => {
    const fake = installFakeStore();
    const before = counters();
    const lines: string[] = [];
    for (let i = 0; i < 5; i++) {
      const a = await live(LIVE(sharedEnv()), IP, SID_A, lines);
      expect(a.diag).toMatch(/reason=live_refused/); // past the gate: only the test process stops the client
    }
    const a = await live(LIVE(sharedEnv()), IP, SID_A, lines);
    expect(a.source).toBe('regex-fallback');
    expect(a.note).toBe('rate_limited');
    expect(a.reply).toEqual(regexAnswer('search tea', SID_A, 1).reply);
    expect(a.diag).toMatch(/reason=ip_rate_limited/);
    expect(NOTE_TEXT.rate_limited).not.toMatch(/\d/);
    expect(NOTE_TEXT.live_unavailable).not.toMatch(/\d/);
    // Another IP is not affected; no IP means the shared "unknown" bucket.
    expect((await live(LIVE(sharedEnv()), '198.51.100.99', SID_B)).diag).toMatch(/reason=live_refused/);
    expect((await live(LIVE(sharedEnv()), undefined, SID_B)).diag).toMatch(/reason=live_refused/);
    expect(counters()).toEqual(before);
    // The IP and the token are in no log line, store key, value or request body.
    const dump = JSON.stringify({ lines, keys: [...fake.state.strings.keys()], bodies: fake.calls.map((c) => c.body) });
    for (const s of [IP, '198.51.100.99', STORE_TOKEN, STORE_URL, API_KEY]) expect(dump).not.toContain(s);
  });

  it('the priced mock is gated the same way', async () => {
    installFakeStore();
    for (let i = 0; i < 5; i++) expect((await live(MOCK_PRICED(sharedEnv()), IP)).source).toBe('claude');
    const a = await live(MOCK_PRICED(sharedEnv()), IP);
    expect(a.note).toBe('rate_limited');
    expect(a.source).toBe('regex-fallback');
  });

  it('a lowered limit (DUKA_RATE_PER_MIN) applies; the per-session limit still applies on top', async () => {
    installFakeStore();
    const env = LIVE(sharedEnv({ DUKA_RATE_PER_MIN: '1' }));
    expect((await live(env, IP)).diag).toMatch(/reason=live_refused/);
    expect((await live(env, IP)).note).toBe('rate_limited');
  });

  it('the file ledger (no store env) has no per-IP limit and makes no store call', async () => {
    const fake = installFakeStore();
    const dir = mkdtempSync(join(tmpdir(), 'duka-vh-'));
    for (let i = 0; i < 5; i++) expect((await live(MOCK_PRICED({ DUKA_SPEND_DIR: dir }), IP)).source).toBe('claude');
    expect((await live(MOCK_PRICED({ DUKA_SPEND_DIR: dir }), IP)).source).toBe('claude');
    expect(fake.calls).toHaveLength(0);
    expect(readLedger({ DUKA_SPEND_DIR: dir }).calls).toBe(12);
  });

  it('an injected client (tests, not production) bypasses the gate and the store', async () => {
    const fake = installFakeStore();
    const msg = { id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } as unknown as Anthropic.Message;
    const client: PlannerClient = { kind: 'live', create: async () => msg };
    await planWithClaude('search tea', SID_A, 1, { env: LIVE(sharedEnv()), client, ip: IP, log: () => {} });
    expect(fake.calls).toHaveLength(0);
  });

  it('shared ledger end to end through the priced mock: ledger calls counted, rate keys written, no prompt text stored', async () => {
    const fake = installFakeStore();
    const a = await live(MOCK_PRICED(sharedEnv()), IP);
    expect(a.source).toBe('claude');
    expect(ledgerOf(fake.state).calls).toBe(2);
    expect([...fake.state.strings.keys()].every((k) => k.startsWith(`${NS}:rl:`))).toBe(true);
    expect(JSON.stringify({ h: [...fake.state.hashes], l: [...fake.state.lists], b: fake.calls.map((c) => c.body) })).not.toContain('search tea');
  });
});

describe('AC-L37 prompt length and the route', () => {
  const post = (text: unknown, ip?: string) =>
    POST(
      new NextRequest('http://localhost:3200/api/assistant', {
        method: 'POST',
        headers: new Headers({ host: 'localhost:3200', 'content-type': 'application/json', cookie: `duka_sid=${SID_A}`, ...(ip ? { 'x-forwarded-for': ip } : {}) }),
        body: JSON.stringify({ text, turn: 1 }),
      }),
    );
  const claudeEnv = (extra: Record<string, string> = {}) => {
    for (const [k, v] of Object.entries({ DUKA_PLANNER: 'claude', DUKA_PLANNER_CLIENT: 'mock', DUKA_SPEND_TEST_PRICE_MOCK: '1', ANTHROPIC_API_KEY: '', DUKA_ALLOW_LIVE: '', KV_REST_API_URL: STORE_URL, KV_REST_API_TOKEN: STORE_TOKEN, DUKA_LEDGER_NAMESPACE: NS, ...extra })) vi.stubEnv(k, v);
  };

  it('the limit is one constant, 300; 301 characters is a 400 with no planner, no store call and no model request', async () => {
    expect(MAX_PROMPT_CHARS).toBe(300);
    const fake = installFakeStore();
    claudeEnv();
    const before = counters();
    const tooLong = await post('x'.repeat(MAX_PROMPT_CHARS + 1), IP);
    expect(tooLong.status).toBe(400);
    expect((await tooLong.json()).error).toMatch(/300 characters/);
    expect((await post(42, IP)).status).toBe(400);
    expect(fake.calls).toHaveLength(0);
    expect(counters()).toEqual(before);
    expect((await post('x'.repeat(MAX_PROMPT_CHARS), IP)).status).toBe(200);
  });

  it('the route passes the first x-forwarded-for hop to the per-IP limit; the 6th prompt carries the rate_limited note', async () => {
    const fake = installFakeStore();
    claudeEnv();
    for (let i = 0; i < 5; i++) {
      const res = await post('search tea', `${IP}, 10.0.0.1`);
      expect((await res.json()).note).toBeUndefined();
    }
    const limited = await (await post('search tea', `${IP}, 10.0.0.2`)).json();
    expect(limited.note).toBe('rate_limited');
    expect((await (await post('search tea', '198.51.100.200')).json()).note).toBeUndefined();
    expect(JSON.stringify(fake.calls.map((c) => c.body))).not.toContain(IP);
  });

  it('the route fails closed when VERCEL is set without a store: scripted answer, live_unavailable', async () => {
    claudeEnv({ KV_REST_API_URL: '', KV_REST_API_TOKEN: '', VERCEL: '1' });
    const j = await (await post('search tea', IP)).json();
    expect(j.note).toBe('live_unavailable');
  });
});

describe('AC-L39 client bundle check', () => {
  const script = join(ROOT, 'scripts', 'check-client-bundle.cjs');
  const run = (dir: string) => spawnSync(process.execPath, [script, dir], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } as unknown as NodeJS.ProcessEnv });
  // Assembled at runtime so no tracked file holds the key prefix literally.
  const TERMS = [['sk', 'ant'].join('-'), 'ANTHROPIC', 'KV_REST', 'UPSTASH'];
  const tmp = () => mkdtempSync(join(tmpdir(), 'duka-bundle-'));

  it('a clean directory passes (exit 0)', () => {
    const d = tmp();
    mkdirSync(join(d, 'chunks'));
    writeFileSync(join(d, 'chunks', 'app.js'), 'console.log("hello shop")');
    const r = run(d);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('1 files scanned, 0 hits');
  });
  it.each(TERMS)('a planted file with %s trips it (exit 1); output names file and term only', (term) => {
    const d = tmp();
    mkdirSync(join(d, 'chunks'));
    writeFileSync(join(d, 'chunks', 'ok.js'), 'fine');
    writeFileSync(join(d, 'chunks', 'bad.js'), `var x="PRIVATE_SURROUNDING_TEXT ${term} more PRIVATE_SURROUNDING_TEXT";`);
    const r = run(d);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`chunks/bad.js: ${term}`);
    expect(r.stdout).not.toContain('PRIVATE_SURROUNDING_TEXT');
    expect(r.stdout).not.toContain('ok.js:');
  });
  it('a missing, empty or non-directory path is exit 2, never a vacuous pass', () => {
    expect(run(join(tmp(), 'nope')).status).toBe(2);
    expect(run(tmp()).status).toBe(2);
    const d = tmp();
    writeFileSync(join(d, 'f'), 'x');
    expect(run(join(d, 'f')).status).toBe(2);
    expect(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status).toBe(2);
  });
  it("no 'use client' file under components or app mentions the store or key names", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(join(ROOT, dir))) {
        const rel = `${dir}/${name}`;
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
        else if (/\.(ts|tsx)$/.test(name)) {
          const text = readFileSync(join(ROOT, rel), 'utf8');
          if (/^\s*(['"])use client\1/.test(text) && /KV_REST|UPSTASH|ANTHROPIC|NEXT_PUBLIC_/.test(text)) hits.push(rel);
        }
      }
    };
    walk('components');
    walk('app');
    expect(hits).toEqual([]);
  });
});

describe('AC-L38 operator CLI', () => {
  const cli = join(ROOT, 'scripts', 'ledger-cli.ts');
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ['--conditions=react-server', '--import', 'tsx', cli, ...args], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', ...env } });

  it('seed with no store env: non-zero, a clear message, nothing else', () => {
    const r = run(['seed', '--spent-usd', '0.5']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no shared store is configured');
  });
  it('seed validates the number: missing, nonsense, negative, over the cap (all exit 2)', () => {
    expect(run(['seed']).status).toBe(2);
    expect(run(['seed', '--spent-usd', 'abc']).status).toBe(2);
    expect(run(['seed', '--spent-usd', '-1']).status).toBe(2);
    expect(run(['seed', '--spent-usd', '5.01']).status).toBe(2);
    expect(run(['seed', '--spent-usd', '1e3']).status).toBe(2);
    expect(run(['seed', '--spent-usd', '2', '--spent-usd', '99']).status).toBe(2);
    expect(run(['seed', '--spent-usd', '1', '--bogus']).status).toBe(2);
    expect(run(['seed', '--spent-usd', '3'], { DUKA_SPEND_CAP_USD: '2' }).status).toBe(2); // the env cap lowers the allowed range
  });
  it('with a store config in a test process: the store is refused (no network), exit 1, no URL or token printed', () => {
    const r = run(['seed', '--spent-usd', '0.5'], { KV_REST_API_URL: STORE_URL, KV_REST_API_TOKEN: STORE_TOKEN });
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('blocked_in_tests');
    for (const s of [STORE_URL, STORE_TOKEN, 'example.test']) expect(r.stdout + r.stderr).not.toContain(s);
    const rep = run(['report'], { KV_REST_API_URL: STORE_URL, KV_REST_API_TOKEN: STORE_TOKEN });
    expect(rep.status).toBe(1);
    expect(rep.stdout + rep.stderr).not.toContain(STORE_TOKEN);
  });
  it('report with the store required but missing: non-zero', () => {
    expect(run(['report'], { VERCEL: '1' }).status).toBe(1);
  });
  it('report in file mode runs the unchanged spend-report script (same text, same exit code)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'duka-cli-'));
    const viaCli = run(['report'], { DUKA_SPEND_DIR: dir });
    const direct = spawnSync(process.execPath, [join(ROOT, 'scripts', 'spend-report.cjs')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', DUKA_SPEND_DIR: dir } });
    expect(viaCli.status).toBe(0);
    expect(viaCli.stdout).toBe(direct.stdout);
    writeFileSync(join(dir, 'ledger.json'), '{not json');
    expect(run(['report'], { DUKA_SPEND_DIR: dir }).status).toBe(1);
  });
  it('an unknown command is exit 2', () => {
    expect(run(['bogus']).status).toBe(2);
  });
});

describe('AC-L38 CLI against the fake store (in process)', () => {
  const env = () => ({ KV_REST_API_URL: STORE_URL, KV_REST_API_TOKEN: STORE_TOKEN, DUKA_LEDGER_NAMESPACE: NS });
  async function runIt(args: string[], e: Record<string, string | undefined> = env()) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(args, e, { out: (l) => out.push(l), err: (l) => err.push(l) });
    return { out: out.join('\n'), err: err.join('\n'), code };
  }

  it('seed prints seeded, then not seeded; report shows the shared ledger without URL, token or keys', async () => {
    const fake = installFakeStore();
    const first = await runIt(['seed', '--spent-usd', '0.5']);
    expect(first).toMatchObject({ out: `seeded: spent $0.5000 (namespace ${NS})`, code: 0 });
    const second = await runIt(['seed', '--spent-usd=1.5']);
    expect(second.out).toContain('not seeded');
    expect(second.out).toContain('spent $0.5000');
    expect(ledgerOf(fake.state).spent).toBe(500_000);
    const rep = await runIt(['report']);
    expect(rep.code).toBe(0);
    expect(rep.out).toContain(`ledger:      shared (namespace ${NS})`);
    for (const line of ['capUSD:      $5.0000', 'spentUSD:    $0.5000', 'reservedUSD: $0.0000', 'remaining:   $4.5000', 'calls:       0', 'seeded:      yes', 'last 0 calls:']) expect(rep.out).toContain(line);
    for (const s of [STORE_URL, STORE_TOKEN, `${NS}:`]) expect(rep.out + rep.err).not.toContain(s);
  });

  it('report lists origins and the last calls (codes and numbers only), oldest first', async () => {
    installFakeStore();
    const e = { ...env(), ANTHROPIC_API_KEY: API_KEY, DUKA_SPEND_ORIGIN: 'laptop' };
    const inner: PlannerClient = {
      kind: 'live',
      create: async () => ({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }) as unknown as Anthropic.Message,
    };
    const g = withSpendGuard(inner, e);
    for (let turn = 1; turn <= 2; turn++) await g.create({ model: 'claude-sonnet-5-5', max_tokens: 256, messages: [{ role: 'user', content: 'PROMPT_SECRET_TEXT' }] }, { signal: new AbortController().signal, meta: { turn, req: 1 } });
    const rep = await runIt(['report'], e);
    expect(rep.out).toMatch(/origin laptop: \$0\.0001 in 2 calls/);
    expect(rep.out).toContain('last 2 calls:');
    const lines = rep.out.split('\n').filter((l) => l.startsWith('  '));
    expect(lines[0]).toMatch(/turn=1 req=1 /);
    expect(lines[1]).toMatch(/turn=2 req=1 /);
    expect(rep.out).not.toContain('PROMPT_SECRET_TEXT');
    expect(rep.out).not.toContain(API_KEY);
  });

  it('a store error prints a fixed code only and exits 1; no config prints the clear message', async () => {
    installFakeStore({ fail: 'error500' });
    const r = await runIt(['report']);
    expect(r).toMatchObject({ err: 'ledger: ledger store error: http', code: 1 });
    expect(r.out + r.err).not.toContain(STORE_TOKEN);
    expect((await runIt(['seed', '--spent-usd', '1'], {})).err).toContain('no shared store is configured');
    expect((await runIt(['seed', '--spent-usd', '1'], { VERCEL: '1' })).err).toContain('required but its config is missing');
  });
});
