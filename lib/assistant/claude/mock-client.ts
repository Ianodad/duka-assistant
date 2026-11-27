/**
 * Fixture-script client (DUKA_PLANNER_CLIENT=mock). Shopper text picks a
 * scenario; request N of that scenario returns tests/fixtures/claude/<scenario>.<N>.json
 * (the last file repeats when the loop asks for more). Fixtures are
 * hand-written Messages API responses, or an API error body ({type: "error"}),
 * which is thrown as the SDK's APIError. The "timeout" scenario never answers
 * until the request is aborted. Unknown text has no scenario: the planner
 * falls back to the regex planner.
 *
 * The mock also checks the conversation it is sent is well formed (every
 * tool_use answered by a tool_result with the same id), as the API would.
 *
 * Multi-turn (SPEC-LIVE AC-L13, AC-L14): follow-up scenarios ("only the
 * cheaper one", "add it", "make it 3", "remove that") list in REQUIRES what
 * must be in the request's conversation_state block. If it is missing (no
 * history, no current screen), the mock answers like a confused model with
 * plain text, so a loop that drops the state fails the follow-up.
 */
import 'server-only';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { testOnlyBehaviourAllowed, type CreateParams, type PlannerClient } from './client';

export const FIXTURE_DIR = join(process.cwd(), 'tests', 'fixtures', 'claude');

/** Normalised shopper text to scenario name. */
export const SCRIPT: Record<string, string> = {
  'search tea': 'search-grid',
  'what tea do you have': 'search-grid',
  'compare ketepa and kericho gold': 'compare',
  'add 2 unga': 'add-cart',
  'add two unga and show my basket': 'add-cart',
  'checkout please': 'checkout-handoff',
  'show me a deal': 'hostile-price',
  'hostile price': 'hostile-price',
  'hostile link': 'hostile-link',
  'hostile path': 'hostile-path',
  'hostile pay': 'hostile-pay',
  'hostile component': 'hostile-component',
  'hostile html': 'hostile-html',
  'hostile pay tool': 'hostile-pay-tool',
  'tell me a joke': 'plain-text',
  'trigger api error': 'api-error',
  'trigger loop': 'loop-cap',
  'trigger malformed': 'malformed',
  'trigger bad reply': 'bad-reply',
  'trigger timeout': 'timeout',
  'trigger refusal': 'refusal',
  'show flour': 'show-flour',
  'only the cheaper one': 'follow-cheaper',
  'add it': 'add-it',
  'make it 3': 'make-it-3',
  'remove that': 'remove-that',
  'under 200 bob': 'budget-200',
  'show me things under 200 bob': 'budget-200',
  'anything under 100 bob': 'budget-100',
  'where is my order': 'order-none',
  'tell me about tea': 'nudge-render',
  'hostile budget': 'budget-hostile',
  'trigger render retry': 'render-retry',
  'trigger render retry twice': 'render-retry-twice',
  'trigger render retry cart': 'render-retry-cart',
};

/** Follow-up scenarios: substrings the conversation_state block must contain, else the mock answers with plain text. */
export const REQUIRES: Record<string, string[]> = {
  'follow-cheaper': ['<conversation_state>', '- ProductGrid products unga-2kg,mandazi-mix-1kg', 'shopper "show flour"'],
  'add-it': ['<conversation_state>', '- ProductGrid products unga-2kg\n'],
  'make-it-3': ['<conversation_state>', '- CartSummary', '"productId":"unga-2kg"'],
  'remove-that': ['<conversation_state>', '"productId":"unga-2kg"'],
};

/** The text of the first user message (state block plus shopper message). */
export function firstUserText(params: CreateParams): string {
  const m = params.messages[0];
  if (!m || m.role !== 'user') return '';
  return typeof m.content === 'string' ? m.content : m.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
}

export const normalise = (t: string) => t.toLowerCase().replace(/[?!.]+$/g, '').replace(/\s+/g, ' ').trim();

/** Scenarios that only make sense in unit tests (the timeout one holds a request open). */
const TEST_ONLY = new Set(['timeout', 'render-retry', 'render-retry-twice', 'render-retry-cart']);

export function scenarioFor(text: string): string | undefined {
  const s = Object.hasOwn(SCRIPT, normalise(text)) ? SCRIPT[normalise(text)] : undefined;
  return s && TEST_ONLY.has(s) && !testOnlyBehaviourAllowed() ? undefined : s;
}

export class MalformedConversation extends Error {}

function checkConversation(params: CreateParams): void {
  const msgs = params.messages;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    const ids = m.content.filter((b) => b.type === 'tool_use').map((b) => (b as { id: string }).id);
    if (!ids.length) continue;
    const next = msgs[i + 1];
    const answered = next && next.role === 'user' && typeof next.content !== 'string' ? next.content.filter((b) => b.type === 'tool_result').map((b) => (b as { tool_use_id: string }).tool_use_id) : [];
    if (!ids.every((id) => answered.includes(id))) throw new MalformedConversation('tool_use without tool_result');
  }
}

export type MockOptions = { dir?: string; onRequest?: (p: CreateParams) => void };

export function createMockClient(shopperText: string, opts: MockOptions = {}): PlannerClient | null {
  const scenario = scenarioFor(shopperText);
  if (!scenario) return null;
  const dir = opts.dir ?? FIXTURE_DIR;
  return {
    kind: 'mock',
    async create(params, { signal }) {
      opts.onRequest?.(params);
      checkConversation(params);
      if (scenario === 'timeout') {
        return new Promise((_, reject) => {
          if (signal.aborted) reject(new Anthropic.APIUserAbortError());
          signal.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError()), { once: true });
        });
      }
      const need = REQUIRES[scenario];
      const first = firstUserText(params) + '\n';
      const lost = need ? !need.every((x) => first.includes(x)) : false;
      const script = lost ? 'plain-text' : scenario;
      const n = params.messages.filter((m) => m.role === 'assistant').length + 1;
      let file = join(dir, `${script}.${n}.json`);
      for (let k = n - 1; !existsSync(file) && k >= 1; k--) file = join(dir, `${script}.${k}.json`);
      const body = JSON.parse(readFileSync(file, 'utf8')) as { type?: string; error?: { type?: string } };
      if (body.type === 'error') throw Anthropic.APIError.generate(body.error?.type === 'overloaded_error' ? 529 : 500, body, undefined, new Headers());
      return body as unknown as Anthropic.Message;
    },
  };
}
