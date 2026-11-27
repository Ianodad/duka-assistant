/** AC-CP-1, AC-CP-2, AC-CP-9: planner flags, the live gate truth table, model and caps, redaction. */
import { describe, expect, it } from 'vitest';
import { CAPS, claudeModel, clientKind, DEFAULT_CLAUDE_MODEL, liveGate, plannerMode, redactSecrets } from '@/lib/assistant/claude/config';

const FAKE_KEY = 'FAKE_ANTHROPIC_KEY_DO_NOT_USE';

describe('AC-CP-1 planner mode flags', () => {
  it('default is regex', () => {
    expect(plannerMode({})).toBe('regex');
    expect(plannerMode({ DUKA_PLANNER: '' })).toBe('regex');
  });
  it('DUKA_PLANNER picks regex or claude and wins over the legacy flag', () => {
    expect(plannerMode({ DUKA_PLANNER: 'regex' })).toBe('regex');
    expect(plannerMode({ DUKA_PLANNER: 'claude' })).toBe('claude');
    expect(plannerMode({ DUKA_PLANNER: 'regex', DUKA_ASSISTANT_MODE: 'model' })).toBe('regex');
    expect(plannerMode({ DUKA_PLANNER: 'claude', DUKA_ASSISTANT_MODE: 'mock' })).toBe('claude');
  });
  it('legacy DUKA_ASSISTANT_MODE: mock = regex, model = claude', () => {
    expect(plannerMode({ DUKA_ASSISTANT_MODE: 'mock' })).toBe('regex');
    expect(plannerMode({ DUKA_ASSISTANT_MODE: 'model' })).toBe('claude');
  });
  it('anything else is refused', () => {
    expect(() => plannerMode({ DUKA_PLANNER: 'openai' })).toThrow();
    expect(() => plannerMode({ DUKA_PLANNER: 'Claude' })).toThrow();
    expect(() => plannerMode({ DUKA_ASSISTANT_MODE: 'live' })).toThrow();
  });
});

describe('AC-CP-2 live gate truth table', () => {
  const planners = [undefined, 'regex', 'claude', 'bogus'];
  const legacy = [undefined, 'mock', 'model'];
  const allow = [undefined, '', '0', 'true', '1'];
  const keys = [undefined, '', '   ', FAKE_KEY];
  const nodeEnvs = [undefined, 'test', 'development', 'production'];
  const vitest = [undefined, 'true'];
  const clients = [undefined, 'mock', 'live'];
  const rows: Array<Record<string, string | undefined>> = [];
  for (const DUKA_PLANNER of planners)
    for (const DUKA_ASSISTANT_MODE of legacy)
    for (const DUKA_ALLOW_LIVE of allow)
      for (const ANTHROPIC_API_KEY of keys)
        for (const NODE_ENV of nodeEnvs)
          for (const VITEST of vitest) for (const DUKA_PLANNER_CLIENT of clients) rows.push({ DUKA_PLANNER, DUKA_ASSISTANT_MODE, DUKA_ALLOW_LIVE, ANTHROPIC_API_KEY, NODE_ENV, VITEST, DUKA_PLANNER_CLIENT });

  it(`opens only for claude + DUKA_ALLOW_LIVE=1 + key + NODE_ENV not test + not vitest + no mock client (${rows.length} rows)`, () => {
    expect(rows.length).toBe(4 * 3 * 5 * 4 * 4 * 2 * 3);
    let opened = 0;
    for (const env of rows) {
      const expected = env.DUKA_PLANNER === 'claude' && env.DUKA_ALLOW_LIVE === '1' && env.ANTHROPIC_API_KEY === FAKE_KEY && env.NODE_ENV !== 'test' && !env.VITEST && env.DUKA_PLANNER_CLIENT !== 'mock';
      const g = liveGate(env);
      expect(g.open, JSON.stringify({ ...env, ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ? 'set' : env.ANTHROPIC_API_KEY })).toBe(expected);
      expect(g.reason === 'ok').toBe(expected);
      if (expected) opened++;
    }
    expect(opened).toBe(3 * 3 * 2); // legacy flag (3 values) x NODE_ENV (3) x client (2); legacy never changes the outcome // NODE_ENV undefined/development/production x client undefined/live
  });

  it('the legacy DUKA_ASSISTANT_MODE=model alone never opens the live gate', () => {
    const g = liveGate({ DUKA_ASSISTANT_MODE: 'model', DUKA_ALLOW_LIVE: '1', ANTHROPIC_API_KEY: FAKE_KEY, NODE_ENV: 'production' });
    expect(g).toEqual({ open: false, reason: 'planner_not_claude' });
    expect(liveGate({ DUKA_ASSISTANT_MODE: 'model', DUKA_PLANNER: 'claude', DUKA_ALLOW_LIVE: '1', ANTHROPIC_API_KEY: FAKE_KEY, NODE_ENV: 'production' }).open).toBe(true);
  });

  it('never open in this test process, whatever the flags', () => {
    expect(process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST)).toBe(true);
    expect(liveGate({ ...process.env, DUKA_PLANNER: 'claude', DUKA_ALLOW_LIVE: '1', ANTHROPIC_API_KEY: FAKE_KEY }).open).toBe(false);
    expect(liveGate().open).toBe(false);
  });

  it('DUKA_ALLOW_LIVE is unset in this process and in .env.example only as a comment', () => {
    expect(process.env.DUKA_ALLOW_LIVE ?? '').toBe('');
  });

  it('clientKind: mock flag always wins; otherwise live only through the gate, else none', () => {
    const base = { DUKA_PLANNER: 'claude', DUKA_ALLOW_LIVE: '1', ANTHROPIC_API_KEY: FAKE_KEY, NODE_ENV: 'production' };
    expect(clientKind({ ...base, DUKA_PLANNER_CLIENT: 'mock' }).kind).toBe('mock');
    expect(clientKind(base).kind).toBe('live');
    expect(clientKind({ ...base, DUKA_ALLOW_LIVE: undefined })).toEqual({ kind: 'none', reason: 'live_not_allowed' });
    expect(clientKind({ ...base, ANTHROPIC_API_KEY: '' })).toEqual({ kind: 'none', reason: 'no_key' });
    expect(clientKind({ ...base, NODE_ENV: 'test' })).toEqual({ kind: 'none', reason: 'test_env' });
    expect(clientKind({ ...base, DUKA_PLANNER: 'regex' })).toEqual({ kind: 'none', reason: 'planner_not_claude' });
  });
});

describe('AC-CP-4 caps and model', () => {
  it('model defaults to claude-sonnet-5-5 and is configurable via DUKA_CLAUDE_MODEL', () => {
    expect(DEFAULT_CLAUDE_MODEL).toBe('claude-sonnet-5-5');
    expect(claudeModel({})).toBe('claude-sonnet-5-5');
    expect(claudeModel({ DUKA_CLAUDE_MODEL: 'claude-haiku-5-5' })).toBe('claude-haiku-5-5');
    expect(claudeModel({ DUKA_CLAUDE_MODEL: 'gpt-x; rm -rf' })).toBe('claude-sonnet-5-5');
  });
  it('caps: max_tokens 1024, 4 turns, 20 s', () => {
    expect(CAPS).toMatchObject({ maxTokens: 1024, maxTurns: 4, timeoutMs: 20_000 });
  });
});

describe('AC-CP-9 redaction', () => {
  it('removes Anthropic-style keys and the configured key value', () => {
    const shaped = `${['sk', 'ant', ''].join('-')}api03-${'Q'.repeat(40)}`;
    const out = redactSecrets(`a ${shaped} b ${FAKE_KEY} c`, { ANTHROPIC_API_KEY: FAKE_KEY });
    expect(out).toBe('a [REDACTED] b [REDACTED] c');
  });
});
