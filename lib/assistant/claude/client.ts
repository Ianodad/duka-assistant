/**
 * Claude client factory. Two implementations of one interface:
 *  - live: the official SDK, constructed ONLY when liveGate() is open, with a
 *    guarded fetch that re-checks the gate on every request and only talks to
 *    api.anthropic.com. No retries; 20 s timeout. Wrapped by the spend
 *    guard (spend.ts): every request is priced and reserved against the cap.
 *  - mock: fixtures (mock-client.ts). Never touches the network.
 *
 * liveCounters counts live constructions and transport attempts so tests and
 * the e2e server log can prove they stay at 0 in this build.
 */
import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { CAPS, liveGate, type Env } from './config';
import { withSpendGuard } from './spend';

export type CreateParams = Anthropic.MessageCreateParamsNonStreaming;
export interface PlannerClient {
  kind: 'live' | 'mock';
  /** meta: loop position for the spend log (numbers only). */
  create(params: CreateParams, opts: { signal: AbortSignal; meta?: { turn?: number; req?: number } }): Promise<Anthropic.Message>;
}

export const liveCounters = { constructions: 0, transportCalls: 0 };

export class LiveCallRefused extends Error {
  constructor() {
    super('Live Claude call refused: the live gate is closed.');
  }
}

/**
 * True when e, or any error in its cause chain, is a LiveCallRefused. The SDK
 * wraps errors thrown by a custom fetch as APIConnectionError({cause}), so a
 * refusal from guardedFetch arrives wrapped (SDK 1.14 client.js, no middleware).
 */
export function isLiveRefused(e: unknown): boolean {
  for (let x: unknown = e, i = 0; x && i < 5; x = (x as { cause?: unknown }).cause, i++) if (x instanceof LiveCallRefused) return true;
  return false;
}

const API_HOST = 'api.anthropic.com';

/** Second, env-independent check: the real process is never a test runner when a live call goes out. */
export function processIsTest(): boolean {
  return process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
}

/**
 * Gate for test-only BEHAVIOUR (as opposed to processIsTest, which only ever refuses).
 * Never on under NODE_ENV=production, whatever VITEST says.
 */
export function testOnlyBehaviourAllowed(): boolean {
  return process.env.NODE_ENV !== 'production' && processIsTest();
}

/** The live client's transport. Refuses unless the gate is open at call time and the host is the API. */
export function guardedFetch(env: Env = process.env): typeof fetch {
  return async (input, init) => {
    liveCounters.transportCalls++;
    if (processIsTest() || !liveGate(env).open) throw new LiveCallRefused();
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.protocol !== 'https:' || url.host !== API_HOST) throw new LiveCallRefused();
    return fetch(input, { ...init, redirect: 'manual' });
  };
}

export function createLiveClient(env: Env = process.env): PlannerClient {
  if (processIsTest() || !liveGate(env).open) throw new LiveCallRefused();
  liveCounters.constructions++;
  const sdk = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: CAPS.timeoutMs, maxRetries: 0, fetch: guardedFetch(env) });
  // Every live request goes through the spend guard (reserve, then settle from usage): lib/assistant/claude/spend.ts.
  return withSpendGuard(
    {
      kind: 'live',
      create: (params, opts) => sdk.messages.create(params, { signal: opts.signal, timeout: CAPS.timeoutMs, maxRetries: 0 }),
    },
    env,
  );
}

/** One log-safe line: counters only. */
export function counterLine(kind: string): string {
  return `client=${kind} live_constructions=${liveCounters.constructions} live_transport_calls=${liveCounters.transportCalls}`;
}
