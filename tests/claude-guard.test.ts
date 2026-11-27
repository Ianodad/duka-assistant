/**
 * AC-CP-3: the vitest network guard trips on api.anthropic.com (global fetch,
 * node:https, and the real SDK client), and the app's live client cannot be
 * built or used in tests. Every probe here restores the counters it raised;
 * the setup file then asserts all counters are 0 for this file.
 */
import https from 'node:https';
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLiveClient, guardedFetch, LiveCallRefused, liveCounters } from '@/lib/assistant/claude/client';

type NetCounters = { blockedFetches: number; blockedHttp: number; sdkConstructs: number };
const net = () => (globalThis as { __dukaNet?: NetCounters }).__dukaNet!;
const LIVE_ENV = { DUKA_PLANNER: 'claude', DUKA_ALLOW_LIVE: '1', ANTHROPIC_API_KEY: 'FAKE_ANTHROPIC_KEY_DO_NOT_USE', NODE_ENV: 'production' };

afterEach(() => {
  // Probes below raise these on purpose; the file-level check in the setup expects 0.
  Object.assign(net(), { blockedFetches: 0, blockedHttp: 0, sdkConstructs: 0 });
  Object.assign(liveCounters, { constructions: 0, transportCalls: 0 });
});

describe('AC-CP-3 vitest network guard', () => {
  it('global fetch to api.anthropic.com throws and is counted', async () => {
    await expect(fetch('https://api.anthropic.com/v1/messages', { method: 'POST', body: '{}' })).rejects.toThrow(/network guard/);
    await expect(fetch(new URL('https://console.anthropic.com/'))).rejects.toThrow(/network guard/);
    expect(net().blockedFetches).toBe(2);
  });

  it('node:https requests to api.anthropic.com throw', () => {
    expect(() => https.request({ hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST' })).toThrow(/network guard/);
    expect(() => https.get('https://api.anthropic.com/v1/models')).toThrow(/network guard/);
    expect(net().blockedHttp).toBe(2);
  });

  it('the real SDK client is counted on construction and its request is blocked', async () => {
    const before = net().sdkConstructs;
    const sdk = new Anthropic({ apiKey: 'FAKE_ANTHROPIC_KEY_DO_NOT_USE', maxRetries: 0, timeout: 2000 });
    expect(net().sdkConstructs).toBe(before + 1);
    await expect(sdk.messages.create({ model: 'claude-sonnet-5-5', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow();
    expect(net().blockedFetches).toBeGreaterThanOrEqual(1);
  });
});

describe('AC-CP-2/3 the app live client is unreachable in tests', () => {
  it('createLiveClient refuses in the test process even with every flag set, and constructs nothing', () => {
    expect(() => createLiveClient({ ...process.env, ...LIVE_ENV, NODE_ENV: 'test' })).toThrow(LiveCallRefused);
    expect(() => createLiveClient({ ...LIVE_ENV, VITEST: 'true' })).toThrow(LiveCallRefused);
    expect(liveCounters.constructions).toBe(0);
    expect(net().sdkConstructs).toBe(0);
  });

  it('guardedFetch refuses when the gate is closed (no DUKA_ALLOW_LIVE) and counts the attempt', async () => {
    const f = guardedFetch({ ...LIVE_ENV, DUKA_ALLOW_LIVE: undefined });
    await expect(f('https://api.anthropic.com/v1/messages')).rejects.toBeInstanceOf(LiveCallRefused);
    expect(liveCounters.transportCalls).toBe(1);
    expect(net().blockedFetches).toBe(0); // refused before reaching fetch at all
  });

  it('guardedFetch refuses any host other than api.anthropic.com, even with the gate open (process check stubbed off)', async () => {
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'production');
    const realFetch = vi.fn();
    vi.stubGlobal('fetch', realFetch);
    try {
      const f = guardedFetch(LIVE_ENV);
      await expect(f('https://evil.example/v1/messages')).rejects.toBeInstanceOf(LiveCallRefused);
      await expect(f('http://api.anthropic.com/v1/messages')).rejects.toBeInstanceOf(LiveCallRefused);
      expect(realFetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('even with an env record that opens the gate, the real test process refuses before any fetch', async () => {
    expect(() => createLiveClient(LIVE_ENV)).toThrow(LiveCallRefused);
    const f = guardedFetch(LIVE_ENV);
    await expect(f('https://api.anthropic.com/v1/messages', { method: 'POST', body: '{}' })).rejects.toBeInstanceOf(LiveCallRefused);
    expect(liveCounters.constructions).toBe(0);
    expect(net().blockedFetches).toBe(0);
  });
});
