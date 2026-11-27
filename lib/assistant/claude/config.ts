/**
 * Claude planner flags, live gate and per-request caps. Pure functions over an
 * env record, so the gate can be tested as a truth table.
 *
 * Planner choice:
 *   DUKA_PLANNER=regex|claude (default regex). It wins when set.
 *   DUKA_ASSISTANT_MODE (legacy): mock or unset = regex, model = claude.
 *
 * The live gate is open ONLY when all hold: planner is claude, DUKA_ALLOW_LIVE
 * is exactly "1", ANTHROPIC_API_KEY is non-empty, NODE_ENV is not "test", the
 * process is not under vitest, and DUKA_PLANNER_CLIENT is not "mock".
 */
export type PlannerMode = 'regex' | 'claude';
export type Env = Record<string, string | undefined>;

export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5-5';
export const CAPS = {
  maxTokens: 1024,
  /** Model requests per shopper message (each tool_use round trip is one). */
  maxTurns: 4,
  /** Tool calls executed per shopper message, across all turns. */
  maxToolCalls: 8,
  /** Wall clock for the whole loop, in ms. */
  timeoutMs: 20_000,
} as const;

export class PlannerConfigError extends Error {}

export function plannerMode(env: Env = process.env): PlannerMode {
  const p = env.DUKA_PLANNER;
  if (p !== undefined && p !== '') {
    if (p === 'regex' || p === 'claude') return p;
    throw new PlannerConfigError('DUKA_PLANNER must be "regex" or "claude".');
  }
  const legacy = env.DUKA_ASSISTANT_MODE;
  if (legacy === undefined || legacy === '' || legacy === 'mock') return 'regex';
  if (legacy === 'model') return 'claude';
  throw new PlannerConfigError('DUKA_ASSISTANT_MODE must be "mock" or "model".');
}

export function claudeModel(env: Env = process.env): string {
  const m = env.DUKA_CLAUDE_MODEL;
  return m && /^claude-[a-z0-9-]{1,60}$/.test(m) ? m : DEFAULT_CLAUDE_MODEL;
}

export type GateReason = 'ok' | 'planner_not_claude' | 'live_not_allowed' | 'no_key' | 'test_env' | 'mock_client';

export function liveGate(env: Env = process.env): { open: boolean; reason: GateReason } {
  let mode: PlannerMode;
  try {
    mode = plannerMode(env);
  } catch {
    return { open: false, reason: 'planner_not_claude' };
  }
  // The live gate needs DUKA_PLANNER=claude spelled out; the legacy DUKA_ASSISTANT_MODE=model alone never opens it.
  if (mode !== 'claude' || env.DUKA_PLANNER !== 'claude') return { open: false, reason: 'planner_not_claude' };
  if (env.NODE_ENV === 'test' || env.VITEST) return { open: false, reason: 'test_env' };
  if (env.DUKA_PLANNER_CLIENT === 'mock') return { open: false, reason: 'mock_client' };
  if (env.DUKA_ALLOW_LIVE !== '1') return { open: false, reason: 'live_not_allowed' };
  if (!env.ANTHROPIC_API_KEY || !env.ANTHROPIC_API_KEY.trim()) return { open: false, reason: 'no_key' };
  return { open: true, reason: 'ok' };
}

/** Which client the claude planner uses: live (gate open), mock (fixtures) or none (regex fallback). */
export function clientKind(env: Env = process.env): { kind: 'live' | 'mock' | 'none'; reason: GateReason } {
  if (env.DUKA_PLANNER_CLIENT === 'mock') return { kind: 'mock', reason: 'mock_client' };
  const g = liveGate(env);
  return g.open ? { kind: 'live', reason: 'ok' } : { kind: 'none', reason: g.reason };
}

// The key prefix is assembled at runtime so no tracked file contains it literally.
const KEY_PREFIX = ['sk', 'ant', ''].join('-');
const KEY_RE = new RegExp(`${KEY_PREFIX}[A-Za-z0-9_-]+`, 'g');

/** Removes Anthropic-style keys and the configured key value from any string bound for a log. */
export function redactSecrets(s: string, env: Env = process.env): string {
  let out = s.replace(KEY_RE, '[REDACTED]');
  const k = env.ANTHROPIC_API_KEY;
  if (k && k.length >= 8) out = out.split(k).join('[REDACTED]');
  return out;
}

/**
 * Live request shape (AC-L8, AC-L17): the ONE place to adjust the request for
 * the supervised live calls, so latency can be A/B tested without code changes.
 * Defaults match the reviewed buildRequest: thinking between_tools, effort low,
 * tool_choice auto, max_tokens CAPS.maxTokens, no prompt caching.
 *   DUKA_CLAUDE_THINKING   = between_tools | adaptive | off | omit (off and omit drop the thinking field)
 *   DUKA_CLAUDE_EFFORT     = low | medium | high | omit
 *   DUKA_CLAUDE_MAX_TOKENS = integer; can only LOWER the cap, floor MIN_MAX_TOKENS
 *   DUKA_CLAUDE_CACHE      = 1 adds cache_control ephemeral to the system prompt and the last tool
 * Unknown values keep the default. Forced tool_choice is not offered: current
 * models refuse it. between_tools is only accepted at effort high or below.
 */
export const REQUEST_DEFAULTS = { thinking: 'between_tools', effort: 'low', toolChoice: 'auto' } as const;
export const MIN_MAX_TOKENS = 256;
const THINKING = ['between_tools', 'adaptive', 'off', 'omit'] as const;
const EFFORT = ['low', 'medium', 'high', 'omit'] as const;
export type RequestShape = {
  thinking?: { type: 'between_tools' | 'adaptive' };
  output_config?: { effort: 'low' | 'medium' | 'high' };
  tool_choice: { type: 'auto' };
  /** Absent: CAPS.maxTokens. Never above it. */
  max_tokens?: number;
  /** Prompt caching of the stable prefix (system + tools). */
  cache?: boolean;
};

/** DUKA_CLAUDE_MAX_TOKENS lowers the output cap only: clamped to [MIN_MAX_TOKENS, CAPS.maxTokens]; junk keeps the default. */
export function maxTokens(env: Env = process.env): number {
  const raw = env.DUKA_CLAUDE_MAX_TOKENS;
  if (!raw || !/^\d{1,6}$/.test(raw)) return CAPS.maxTokens;
  return Math.min(CAPS.maxTokens, Math.max(MIN_MAX_TOKENS, Number(raw)));
}

export function requestShape(env: Env = process.env): RequestShape {
  const t = (THINKING as readonly string[]).includes(env.DUKA_CLAUDE_THINKING ?? '') ? (env.DUKA_CLAUDE_THINKING as (typeof THINKING)[number]) : REQUEST_DEFAULTS.thinking;
  const e = (EFFORT as readonly string[]).includes(env.DUKA_CLAUDE_EFFORT ?? '') ? (env.DUKA_CLAUDE_EFFORT as (typeof EFFORT)[number]) : REQUEST_DEFAULTS.effort;
  const mt = maxTokens(env);
  return {
    ...(t === 'omit' || t === 'off' ? {} : { thinking: { type: t } }),
    ...(e === 'omit' ? {} : { output_config: { effort: e } }),
    tool_choice: { type: REQUEST_DEFAULTS.toolChoice },
    ...(mt !== CAPS.maxTokens ? { max_tokens: mt } : {}),
    ...(env.DUKA_CLAUDE_CACHE === '1' ? { cache: true } : {}),
  };
}

/** What the panel subtitle needs, and nothing else: no key, no flags. */
export type ModeInfo = { planner: PlannerMode; client: 'live' | 'mock' | 'none' };
export function modeInfo(env: Env = process.env): ModeInfo {
  let planner: PlannerMode;
  try {
    planner = plannerMode(env);
  } catch {
    return { planner: 'regex', client: 'none' };
  }
  if (planner === 'regex') return { planner, client: 'none' };
  return { planner, client: clientKind(env).kind };
}

/**
 * Test seams (the spend price hook below, the raw-message hook in
 * lib/assistant/mode.ts) exist only when NODE_ENV is exactly "development" or
 * "test", read at runtime from the env record. NODE_ENV "production", unset or
 * anything else: every seam is off, whatever the other flags say. (next start
 * sets NODE_ENV=production when it is unset.)
 */
export function testSeamsAllowed(env: Env = process.env): boolean {
  return env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
}

/**
 * TEST-ONLY hook: DUKA_SPEND_TEST_PRICE_MOCK=1 sends the fixture mock client
 * through the spend guard (priced as live) so e2e can show the cap refusal and
 * its panel note without any live call. Needs: test seams allowed (never in
 * production), the ACTIVE planner is claude (DUKA_PLANNER wins over the legacy
 * flag), the client is the mock, live is not allowed, no key, gate closed.
 */
export function spendTestHookEnabled(env: Env = process.env): boolean {
  if (!testSeamsAllowed(env) || env.DUKA_SPEND_TEST_PRICE_MOCK !== '1') return false;
  let mode: PlannerMode;
  try {
    mode = plannerMode(env);
  } catch {
    return false;
  }
  return mode === 'claude' && env.DUKA_PLANNER_CLIENT === 'mock' && env.DUKA_ALLOW_LIVE !== '1' && !(env.ANTHROPIC_API_KEY ?? '').trim() && !liveGate(env).open;
}
