/**
 * Review fix 2: every test-only seam is off when NODE_ENV=production, keyed off
 * the ACTIVE planner (DUKA_PLANNER wins over the legacy DUKA_ASSISTANT_MODE).
 * Truth tables over NODE_ENV production, development, test (and unset).
 * Seams: the spend price hook (DUKA_SPEND_TEST_PRICE_MOCK), the raw-message
 * hook (DUKA_ASSISTANT_TEST_HOOKS), the test-only mock scenario, and the seam
 * switch itself. Mocks and temp dirs only.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scenarioFor } from '@/lib/assistant/claude/mock-client';
import { processIsTest, testOnlyBehaviourAllowed } from '@/lib/assistant/claude/client';
import { plannerMode, spendTestHookEnabled, testSeamsAllowed } from '@/lib/assistant/claude/config';
import { planWithClaude } from '@/lib/assistant/claude/planner';
import { testHooksEnabled } from '@/lib/assistant/mode';
import { SID_A } from './helpers';

const NODE_ENVS = ['production', 'development', 'test', undefined, 'staging'] as const;
const PLANNERS: Array<Record<string, string | undefined>> = [
  { DUKA_PLANNER: 'claude' },
  { DUKA_PLANNER: 'regex' },
  { DUKA_PLANNER: 'claude', DUKA_ASSISTANT_MODE: 'mock' }, // legacy says mock, active planner is claude
  { DUKA_PLANNER: 'regex', DUKA_ASSISTANT_MODE: 'model' }, // legacy says model, active planner is regex
  { DUKA_ASSISTANT_MODE: 'model' },
  { DUKA_ASSISTANT_MODE: 'mock' },
  {},
  { DUKA_PLANNER: 'bogus' },
];
const active = (e: Record<string, string | undefined>) => {
  try {
    return plannerMode(e);
  } catch {
    return 'invalid';
  }
};
const seamsOn = (n: string | undefined) => n === 'development' || n === 'test';

describe('testSeamsAllowed', () => {
  it.each(NODE_ENVS.map((n) => [n, seamsOn(n)]))('NODE_ENV=%s -> %s', (NODE_ENV, want) => {
    expect(testSeamsAllowed({ NODE_ENV })).toBe(want);
  });
});

describe('spend price hook (DUKA_SPEND_TEST_PRICE_MOCK) truth table', () => {
  const rows: Array<Record<string, string | undefined>> = [];
  for (const NODE_ENV of NODE_ENVS)
    for (const p of PLANNERS)
      for (const DUKA_PLANNER_CLIENT of ['mock', undefined])
        for (const DUKA_SPEND_TEST_PRICE_MOCK of ['1', undefined, 'yes'])
          for (const live of [{}, { DUKA_ALLOW_LIVE: '1' }, { ANTHROPIC_API_KEY: 'FAKE_ANTHROPIC_KEY_DO_NOT_USE_seams' }]) rows.push({ NODE_ENV, ...p, DUKA_PLANNER_CLIENT, DUKA_SPEND_TEST_PRICE_MOCK, ...live });
  it(`on only for NODE_ENV development/test + flag + active planner claude + mock client + no live flag or key (${rows.length} rows)`, () => {
    let on = 0;
    for (const env of rows) {
      const want = seamsOn(env.NODE_ENV) && env.DUKA_SPEND_TEST_PRICE_MOCK === '1' && active(env) === 'claude' && env.DUKA_PLANNER_CLIENT === 'mock' && env.DUKA_ALLOW_LIVE !== '1' && !env.ANTHROPIC_API_KEY;
      expect(spendTestHookEnabled(env), JSON.stringify(env)).toBe(want);
      if (want) on++;
    }
    expect(on).toBe(2 * 3); // NODE_ENV dev/test x planners whose active mode is claude (claude, claude+legacy mock, legacy model)
    expect(rows.filter((r) => r.NODE_ENV === 'production').every((r) => !spendTestHookEnabled(r))).toBe(true);
  });

  it.each(['production', 'development', 'test'])('through the planner with NODE_ENV=%s: the mock is priced only outside production', async (NODE_ENV) => {
    const dir = mkdtempSync(join(tmpdir(), 'duka-seam-'));
    try {
      const a = await planWithClaude('search tea', SID_A, 1, { env: { NODE_ENV, DUKA_PLANNER: 'claude', DUKA_PLANNER_CLIENT: 'mock', DUKA_SPEND_TEST_PRICE_MOCK: '1', DUKA_SPEND_DIR: dir }, log: () => {} });
      expect(a.source).toBe('claude');
      expect(existsSync(join(dir, 'ledger.json'))).toBe(NODE_ENV !== 'production');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('raw-message hook (DUKA_ASSISTANT_TEST_HOOKS) truth table', () => {
  const rows: Array<Record<string, string | undefined>> = [];
  for (const NODE_ENV of NODE_ENVS)
    for (const p of PLANNERS)
      for (const DUKA_ASSISTANT_TEST_HOOKS of ['1', undefined, 'true'])
        for (const live of [{}, { DUKA_ALLOW_LIVE: '1', ANTHROPIC_API_KEY: 'FAKE_ANTHROPIC_KEY_DO_NOT_USE_seams' }]) rows.push({ NODE_ENV, ...p, DUKA_ASSISTANT_TEST_HOOKS, ...live });
  it(`on only for NODE_ENV development/test + flag + active planner regex (${rows.length} rows)`, () => {
    let on = 0;
    for (const env of rows) {
      const want = seamsOn(env.NODE_ENV) && env.DUKA_ASSISTANT_TEST_HOOKS === '1' && active(env) === 'regex';
      expect(testHooksEnabled(env), JSON.stringify(env)).toBe(want);
      if (want) on++;
    }
    expect(on).toBe(2 * 4 * 2); // NODE_ENV dev/test x planners whose active mode is regex x live flags (gate stays closed for regex)
  });

  it('the legacy flag alone no longer enables the hook while the active planner is claude', () => {
    expect(testHooksEnabled({ NODE_ENV: 'test', DUKA_PLANNER: 'claude', DUKA_ASSISTANT_MODE: 'mock', DUKA_ASSISTANT_TEST_HOOKS: '1' })).toBe(false);
    expect(testHooksEnabled({ NODE_ENV: 'production', DUKA_PLANNER: 'regex', DUKA_ASSISTANT_TEST_HOOKS: '1' })).toBe(false);
    expect(testHooksEnabled({ NODE_ENV: 'development', DUKA_PLANNER: 'regex', DUKA_ASSISTANT_TEST_HOOKS: '1' })).toBe(true);
  });
});

describe('test-only mock scenario (the "timeout" fixture that holds a request open)', () => {
  afterEach(() => vi.unstubAllEnvs());
  // Truth table: NODE_ENV production/development/test x VITEST set/unset. Production is always off.
  it.each([
    ['production', '', undefined],
    ['production', 'true', undefined],
    ['production', '1', undefined],
    ['development', '', undefined],
    ['development', 'true', 'timeout'],
    ['test', '', 'timeout'],
    ['test', 'true', 'timeout'],
  ])('NODE_ENV=%s VITEST=%j -> %s', (NODE_ENV, VITEST, want) => {
    vi.stubEnv('NODE_ENV', NODE_ENV);
    vi.stubEnv('VITEST', VITEST);
    expect(scenarioFor('trigger timeout')).toBe(want);
    expect(scenarioFor('search tea')).toBe('search-grid');
  });
});

describe('testOnlyBehaviourAllowed vs processIsTest (production never enables test behaviour; refusals stay on)', () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each([
    ['production', '', false, false],
    ['production', 'true', false, true],
    ['development', '', false, false],
    ['development', 'true', true, true],
    ['test', '', true, true],
    ['test', 'true', true, true],
  ])('NODE_ENV=%s VITEST=%j -> behaviour %s, refuse-live %s', (NODE_ENV, VITEST, behaviour, refuse) => {
    vi.stubEnv('NODE_ENV', NODE_ENV);
    vi.stubEnv('VITEST', VITEST);
    expect(testOnlyBehaviourAllowed()).toBe(behaviour);
    expect(processIsTest()).toBe(refuse);
  });
});
