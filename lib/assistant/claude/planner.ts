/**
 * Claude planner entry point (DUKA_PLANNER=claude). Picks the client (live
 * only through the gate, else the fixture mock, else none), runs the tool
 * loop, and turns every failure into a safe answer:
 *  - rendered: validated A2UI from render_ui.
 *  - rejected (hostile render, plain text): trusted reply + fallback card.
 *  - failed or no client (no key, live not allowed, API error, timeout,
 *    malformed, caps, refusal): the regex planner's answer.
 * Cart changes made by tools are rolled back unless the render is accepted.
 * Every outcome is recorded in the session memory (memory.ts, AC-L12), and the
 * next message sends that history, the current screen and the basket.
 * The log line holds codes and counters only: never the key, never model text.
 */
import 'server-only';
import type { Reply } from '@/lib/a2ui/trusted-text';
import { regexAnswer } from '@/lib/assistant/regex-answer';
import { clearCart, getItems, restoreItems } from '@/lib/shop/cart';
import { claudeModel, clientKind, redactSecrets, requestShape, spendTestHookEnabled, type Env } from './config';
import { counterLine, createLiveClient, type PlannerClient } from './client';
import { runToolLoop } from './loop';
import { cartSnapshot } from '@/lib/assistant/http';
import { createMockClient } from './mock-client';
import { currentScreen, knownSurfaceIds, recordTurn, stateBlock } from './memory';
import { withSpendGuard } from './spend';
import { checkRate, ledgerSelection } from './store';
import type { NoteKey } from '@/lib/assistant/notes';
import type { SlotNote } from '@/lib/assistant/slot-notes';

export type ClaudeAnswer = {
  reply: Reply;
  messages: unknown[];
  rejected?: boolean;
  /** For tests and logs: what actually produced the answer. */
  source: 'claude' | 'claude-rejected' | 'regex-fallback';
  diag: string;
  /** Fixed panel note key (spend cap, live busy). The panel shows trusted copy for it. */
  note?: NoteKey;
  /** Surface ids of earlier cards this answer updates in place (re-created in messages). */
  replaced?: string[];
  /** One trusted slot note key per replaced id (AC-L19). */
  slotNotes?: SlotNote[];
  /** The server-side maxPriceKES that filtered this render's grid (canvas title, AC-L24). Shop data, never model text. */
  budgetKES?: number;
};

export type ClaudeDeps = {
  env?: Env;
  client?: PlannerClient | null;
  timeoutMs?: number;
  log?: (line: string) => void;
  /** Client IP for the per-IP live limit (AC-L35). Missing means "unknown". Never logged. */
  ip?: string;
};

const defaultLog = (line: string) => console.info(line);

/**
 * Spend guard for live mode only: at most LIVE_LIMITS.perSession live planner runs per
 * session and LIVE_LIMITS.global per process in any rolling minute. Over the limit the
 * shopper gets the regex answer and the live_busy note. In-memory, per process. The
 * money cap is the persisted spend ledger (spend.ts); the Console limit is a backstop.
 */
export const LIVE_LIMITS = { perSession: 6, global: 30, windowMs: 60_000 } as const;
const liveHits = new Map<string, number[]>();
export function liveBudget(sid: string, now = Date.now()): boolean {
  const cut = now - LIVE_LIMITS.windowMs;
  const mine = (liveHits.get(sid) ?? []).filter((t) => t > cut);
  let total = 0;
  for (const [k, v] of liveHits) {
    const kept = v.filter((t) => t > cut);
    if (kept.length) liveHits.set(k, kept);
    else liveHits.delete(k);
    total += kept.length;
  }
  if (mine.length >= LIVE_LIMITS.perSession || total >= LIVE_LIMITS.global) return false;
  liveHits.set(sid, [...mine, now]);
  return true;
}
export function _resetLiveBudgetForTests(): void {
  liveHits.clear();
}

export async function planWithClaude(text: string, sid: string, turn: number, deps: ClaudeDeps = {}): Promise<ClaudeAnswer> {
  const a = await plan(text, sid, turn, deps);
  recordTurn(sid, { shopper: text, reply: a.reply, messages: a.messages });
  return a;
}

async function plan(text: string, sid: string, turn: number, deps: ClaudeDeps): Promise<ClaudeAnswer> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? defaultLog;
  const { kind, reason } = clientKind(env);
  let totalMs: number | undefined;
  const emit = (diag: string) => {
    // AC-L17: total wall clock of the model loop for this prompt (numbers only), when the loop ran.
    const line = redactSecrets(`[claude-planner] ${diag}${totalMs === undefined ? '' : ` total_ms=${totalMs}`} ${counterLine(kind)}`, env);
    log(line);
    return line;
  };
  const fallback = (why: string, note?: NoteKey): ClaudeAnswer => {
    const a = regexAnswer(text, sid, turn);
    return { ...a, source: 'regex-fallback', diag: emit(`outcome=fallback reason=${why}`), ...(note ? { note } : {}) };
  };

  if (kind === 'live' && deps.client === undefined && !liveBudget(sid)) return fallback('rate_limited', 'live_busy');

  // AC-L35, AC-L36: per-IP limit and store check BEFORE any client is built or any model request is possible.
  // Applies to live prompts and to the test-only priced mock. A limited or unavailable store means no model request.
  const gated = (kind === 'live' && deps.client === undefined) || (kind === 'mock' && spendTestHookEnabled(env));
  if (gated) {
    const g = await checkRate(deps.ip ?? 'unknown', env);
    if (g === 'limited') return fallback('ip_rate_limited', 'rate_limited');
    if (g === 'unavailable') return fallback('store_unavailable', 'live_unavailable');
  }

  let client: PlannerClient | null;
  if (deps.client !== undefined) client = deps.client;
  else if (kind === 'mock') {
    const mock = createMockClient(text);
    // Test-only: price the mock through the spend guard (never with a key or live allowed).
    client = mock && spendTestHookEnabled(env) ? withSpendGuard(mock, env, log) : mock;
  }
  else if (kind === 'live') {
    try {
      client = createLiveClient(env);
    } catch {
      return fallback('live_refused');
    }
  } else client = null;
  if (!client) return fallback(kind === 'mock' ? 'mock_no_fixture' : reason);

  // Rollback restores the cart only if nothing but our own tools touched it during the
  // model call (up to 20 s): a checkout or panel edit in another tab must not be undone.
  const before = getItems(sid);
  let expected = JSON.stringify(before);
  let movedOutside = false;
  // Before each of our writes: if the cart is not what our own previous writes left, someone else changed it.
  const beforeCartWrite = () => {
    if (JSON.stringify(getItems(sid)) !== expected) movedOutside = true;
  };
  const onCartWrite = () => {
    expected = JSON.stringify(getItems(sid));
  };
  const rollback = (): boolean => {
    if (movedOutside || JSON.stringify(getItems(sid)) !== expected) return false;
    clearCart(sid);
    restoreItems(sid, before);
    return true;
  };
  const state = stateBlock(sid, cartSnapshot(sid));
  const r = await runToolLoop({ client, text, sid, turn, model: claudeModel(env), timeoutMs: deps.timeoutMs, onCartWrite, beforeCartWrite, shape: requestShape(env), state, screen: currentScreen(sid), usedSurfaceIds: knownSurfaceIds(sid) });
  totalMs = r.timing.totalMs;
  // DUKA_LIVE_TRACE=1: per-prompt latency split (ms per model request, ms in data tools, total). Numbers only.
  if (env.DUKA_LIVE_TRACE === '1') log(`[claude-trace] prompt model_ms=${r.timing.modelMs.join(',') || '-'} tool_ms=${r.timing.toolMs} total_ms=${r.timing.totalMs} requests=${r.turns}`);
  const tools = (r.tools.join(',') || '-') + (r.nudged ? ' nudged=1' : '') + (r.renderRetried ? ' retried=1' : '');
  if (r.status === 'rendered') {
    return { reply: r.reply, messages: r.messages, source: 'claude', diag: emit(`outcome=rendered turns=${r.turns} tools=${tools}${r.replaced.length ? ` replaced=${r.replaced.length}` : ''}`), ...(r.replaced.length ? { replaced: r.replaced, slotNotes: r.slotNotes } : {}), ...(r.budgetKES !== undefined ? { budgetKES: r.budgetKES } : {}) };
  }
  if (!rollback()) {
    // The cart moved under us: leave it alone and do not run the regex fallback (it could apply the change twice).
    return { reply: { key: 'could_not_show' }, messages: [], rejected: true, source: 'claude-rejected', diag: emit(`outcome=rejected reason=${r.reason} rollback=skipped_cart_changed turns=${r.turns} tools=${tools}`) };
  }
  if (r.status === 'rejected') {
    return { reply: { key: 'could_not_show' }, messages: [], rejected: true, source: 'claude-rejected', diag: emit(`outcome=rejected reason=${r.reason} codes=${r.codes.join(',')} turns=${r.turns} tools=${tools}`) };
  }
  // spend_refused with the shared ledger selected is a store problem (error, timeout, bad answer): say so, not "cap reached".
  const note: NoteKey | undefined = r.reason === 'spend_cap' ? 'spend_cap' : r.reason === 'spend_refused' && ledgerSelection(env).kind === 'shared' ? 'live_unavailable' : undefined;
  return fallback(`${r.reason} turns=${r.turns} tools=${tools}`, note);
}
