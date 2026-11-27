/**
 * DUKA_ASSISTANT_MODE (legacy flag): mock (default) or model. Since the Claude
 * planner, DUKA_PLANNER chooses the planner (lib/assistant/claude/config.ts):
 * mock means DUKA_PLANNER=regex and model means DUKA_PLANNER=claude, and
 * DUKA_PLANNER wins when both are set. Anything else is refused.
 */
import { liveGate, plannerMode, testSeamsAllowed } from './claude/config';

export type AssistantMode = 'mock' | 'model';

export function assistantMode(value = process.env.DUKA_ASSISTANT_MODE): AssistantMode {
  if (value === undefined || value === '' || value === 'mock') return 'mock';
  if (value === 'model') return 'model';
  throw new Error('DUKA_ASSISTANT_MODE must be "mock" or "model".');
}

/**
 * The raw-message test hook (window.__dukaAssistantTest.inject) exists only when
 * all hold: test seams allowed (NODE_ENV development or test, never production),
 * DUKA_ASSISTANT_TEST_HOOKS=1, the ACTIVE planner is regex (DUKA_PLANNER wins
 * over the legacy DUKA_ASSISTANT_MODE), and the live gate is closed.
 */
export function testHooksEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (!testSeamsAllowed(env) || env.DUKA_ASSISTANT_TEST_HOOKS !== '1') return false;
  try {
    return plannerMode(env) === 'regex' && !liveGate(env).open;
  } catch {
    return false;
  }
}
