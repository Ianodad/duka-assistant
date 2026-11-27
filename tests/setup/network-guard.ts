/**
 * Vitest network guard (AC-CP-3), loaded before every test file.
 *  - global fetch to *.anthropic.com throws;
 *  - node:https / node:http requests to *.anthropic.com throw;
 *  - every @anthropic-ai/sdk client construction is counted.
 * After each file it asserts zero live activity: no SDK construction, no
 * blocked Anthropic request, and the app's own live counters at 0. A test
 * that trips the guard on purpose must restore the counters it raised.
 */
import http from 'node:http';
import https from 'node:https';
import { afterAll, expect, vi } from 'vitest';

type NetCounters = { blockedFetches: number; blockedHttp: number; sdkConstructs: number };
const g = globalThis as typeof globalThis & { __dukaNet?: NetCounters; __dukaGuardInstalled?: boolean };
g.__dukaNet ??= { blockedFetches: 0, blockedHttp: 0, sdkConstructs: 0 };
const net = g.__dukaNet;

export const isAnthropicHost = (host: string | null | undefined) => !!host && (host === 'anthropic.com' || host.endsWith('.anthropic.com'));

export class NetworkGuardError extends Error {
  constructor() {
    super('network guard: requests to api.anthropic.com are blocked in tests');
  }
}

if (!g.__dukaGuardInstalled) {
  g.__dukaGuardInstalled = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let host: string | undefined;
    try {
      host = new URL(href).hostname;
    } catch {}
    if (isAnthropicHost(host)) {
      net.blockedFetches++;
      throw new NetworkGuardError();
    }
    return realFetch(input, init);
  }) as typeof fetch;

  for (const mod of [http, https] as const) {
    for (const fn of ['request', 'get'] as const) {
      const real = mod[fn] as (...a: unknown[]) => unknown;
      (mod as unknown as Record<string, unknown>)[fn] = (...args: unknown[]) => {
        const a = args[0];
        const host = typeof a === 'string' || a instanceof URL ? new URL(String(a)).hostname : (a as { hostname?: string; host?: string } | undefined)?.hostname ?? (a as { host?: string } | undefined)?.host;
        if (isAnthropicHost(host?.split(':')[0])) {
          net.blockedHttp++;
          throw new NetworkGuardError();
        }
        return real.apply(mod, args);
      };
    }
  }
}

vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@anthropic-ai/sdk')>();
  class CountedAnthropic extends mod.default {
    constructor(...args: ConstructorParameters<typeof mod.default>) {
      (globalThis as typeof g).__dukaNet!.sdkConstructs++;
      super(...args);
    }
  }
  return { ...mod, default: CountedAnthropic, Anthropic: CountedAnthropic };
});

afterAll(async () => {
  const { liveCounters } = await import('@/lib/assistant/claude/client');
  const line = `[network-guard] live_constructions=${liveCounters.constructions} live_transport_calls=${liveCounters.transportCalls} sdk_constructs=${net.sdkConstructs} blocked_fetches=${net.blockedFetches} blocked_http=${net.blockedHttp}`;
  // console.log, not console.info: some tests mute console.info for the planner's own log lines.
  console.log(line);
  expect(line).toBe('[network-guard] live_constructions=0 live_transport_calls=0 sdk_constructs=0 blocked_fetches=0 blocked_http=0');
});
