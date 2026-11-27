/**
 * Live Claude spend guard (SPEC-LIVE AC-L2 to AC-L4, AC-L6, AC-L8 trace).
 *
 * One ledger file, default <project>/.duka-spend/ledger.json (DUKA_SPEND_DIR
 * overrides the directory), plus a per-call log calls.jsonl next to it.
 *
 * Before every live Messages API request the worst-case cost is estimated and
 * RESERVED in the ledger; if spent + reserved + estimate would pass the cap the
 * call is refused before any network (SpendRefused). After the response the
 * reservation is replaced by the actual cost from response.usage.
 *
 * Accounting rules when there is no usage:
 *  - LiveCallRefused (our guarded fetch refused before sending, also when the
 *    SDK wraps it as APIConnectionError with it as the cause): the
 *    reservation is RELEASED, nothing went out.
 *  - timeout, abort, network or API error: the reservation is KEPT as the
 *    charge, because the request may have been processed and billed.
 *
 * Concurrency: every ledger read-modify-write is synchronous fs work, so in one
 * Node process no two of them interleave. Across processes sharing one dir
 * (for example next dev plus next start) each read-modify-write holds
 * ledger.lock (created with O_EXCL, holding an ownership token; see withLock).
 * A lock older than 30 s is never removed automatically: the call is refused
 * (stale_lock) until an operator deletes it. If the lock stays busy for 2 s the
 * call is refused (ledger_error). Writes are atomic (temp file plus rename).
 * The cap is per ledger: two machines with two ledgers have two caps.
 *
 * Shared ledger (SPEC-LIVE AC-L33 to AC-L36): when store.ts selects the shared
 * store (Vercel, or a store config in the env), withSpendGuard reserves and
 * settles through the store instead (sharedCreate below). The file functions in
 * this module are not used on that path and are unchanged.
 *
 * Fail closed: a missing ledger file is a fresh ledger at 0; a ledger that
 * cannot be read or parsed refuses every live call until it is fixed.
 * Nothing here logs prompt text, model text, tool inputs or the key.
 */
import 'server-only';
import { randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Env } from './config';
import { isLiveRefused, processIsTest, type CreateParams, type PlannerClient } from './client';
import { ledgerSelection, pushCallLine, sharedReserve, sharedSettle, type SharedLedger } from './store';

/** Hard cap in USD. DUKA_SPEND_CAP_USD may only lower it. */
export const HARD_CAP_USD = 5.0;

/**
 * List prices in USD per million tokens.
 * Source: /workspace/poster-app/src/experiments/prices.json "claude-sonnet-5-5"
 * (in 2.00, out 10.00, cached_in 0.20). Cache write = 1.25 x input is an
 * ASSUMPTION. Note: the claude-api skill table (cached 2026-11-03) lists Sonnet
 * 5.5 cache reads at 0.10; we keep the higher 0.20 because it only makes the
 * guard stricter. A model missing from this table is refused.
 */
export const PRICES: Readonly<Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>> = Object.freeze({
  'claude-sonnet-5-5': { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 2.5 },
});

/**
 * Input token UPPER BOUND (live review 4): a token always covers at least one UTF-8 byte, so the input tokens of a
 * request are at most the UTF-8 byte length of its serialised system + tools + messages, plus a fixed framing
 * allowance for what the API adds around them (role markers, tool scaffolding, tool_choice, thinking config).
 */
export const FRAMING_TOKENS = 1000;

export type SpendRefusal = 'spend_cap' | 'unknown_model' | 'ledger_error' | 'stale_lock';
export class SpendRefused extends Error {
  constructor(readonly reason: SpendRefusal) {
    super(`Live Claude call refused by the spend guard: ${reason}.`);
  }
}

const Origin = z.object({ spentUSD: z.number().finite().nonnegative(), calls: z.number().int().nonnegative() }).strict();
const LedgerSchema = z
  .object({
    version: z.literal(1),
    capUSD: z.number().finite().nonnegative(),
    spentUSD: z.number().finite().nonnegative(),
    reservedUSD: z.number().finite().nonnegative(),
    calls: z.number().int().nonnegative(),
    origins: z.record(z.string(), Origin),
    updatedAt: z.string(),
  })
  .strict();
export type Ledger = z.infer<typeof LedgerSchema>;

export class LedgerError extends Error {}

// Money is compared in integer micro-dollars so the cap boundary is exact.
const micro = (usd: number) => Math.round(usd * 1e6);
const usd = (m: number) => m / 1e6;

export function capUSD(env: Env = process.env): number {
  const raw = env.DUKA_SPEND_CAP_USD;
  if (raw === undefined || raw.trim() === '') return HARD_CAP_USD;
  const n = Number(raw);
  // Nonsense or negative values fail closed (cap 0). Higher values are clamped: the env can never raise the cap.
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(HARD_CAP_USD, n);
}

export function spendDir(env: Env = process.env): string {
  const d = env.DUKA_SPEND_DIR;
  if (d && d.trim()) return d;
  // Tests must never touch the real ledger: they pass a temp dir or get a refusal.
  if (processIsTest()) throw new LedgerError('DUKA_SPEND_DIR must point at a temp dir in tests.');
  return join(process.cwd(), '.duka-spend');
}

export function spendOrigin(env: Env = process.env): string {
  const o = env.DUKA_SPEND_ORIGIN;
  return o && /^[A-Za-z0-9_-]{1,32}$/.test(o) ? o : 'app';
}

const freshLedger = (cap: number): Ledger => ({ version: 1, capUSD: cap, spentUSD: 0, reservedUSD: 0, calls: 0, origins: {}, updatedAt: new Date().toISOString() });

/** Reads the ledger. Missing file: fresh at 0. Anything else wrong: LedgerError (callers refuse). */
export function readLedger(env: Env = process.env): Ledger {
  const file = join(spendDir(env), 'ledger.json');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return freshLedger(capUSD(env));
    throw new LedgerError('ledger unreadable');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LedgerError('ledger is not JSON');
  }
  const r = LedgerSchema.safeParse(parsed);
  if (!r.success) throw new LedgerError('ledger has the wrong shape');
  return r.data;
}

function writeLedger(env: Env, l: Ledger): void {
  const dir = spendDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `ledger.json.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(tmp, `${JSON.stringify({ ...l, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, join(dir, 'ledger.json'));
}

export const LOCK_STALE_MS = 30_000;
export const LOCK_WAIT_MS = 2_000;
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** A ledger.lock older than LOCK_STALE_MS: never removed automatically, the call is refused (fail closed). */
export class StaleLock extends LedgerError {}

/**
 * Runs fn while holding <dir>/ledger.lock. The lock is created with O_EXCL and
 * holds an ownership token (pid plus a random id). Rules:
 *  - Nobody ever removes or renames a lock it does not own. A lock older than
 *    LOCK_STALE_MS (a crashed holder) is NOT recovered: StaleLock is thrown and
 *    the live call is refused until an operator checks no process holds it and
 *    deletes the file by hand. This keeps mutual exclusion unconditional.
 *  - Cleanup removes the lock only if the file still holds our token. Since no
 *    one else may remove or replace a held lock, read-then-unlink is safe.
 *  - A lock that stays busy past LOCK_WAIT_MS: LedgerError (refused).
 */
export function withLock<T>(env: Env, fn: () => T): T {
  const dir = spendDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, 'ledger.lock');
  const token = `${process.pid}.${randomBytes(12).toString('hex')}`;
  const end = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(lock, 'wx', 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new LedgerError('ledger lock failed');
    }
    if (fd !== undefined) {
      try {
        writeSync(fd, token);
      } finally {
        closeSync(fd);
      }
      break;
    }
    let age = 0;
    try {
      age = Date.now() - statSync(lock).mtimeMs;
    } catch {
      continue; // released between our open and stat: try again at once
    }
    if (age > LOCK_STALE_MS) throw new StaleLock('ledger lock is stale');
    if (Date.now() > end) throw new LedgerError('ledger is locked');
    sleepSync(5 + Math.floor(Math.random() * 10));
  }
  try {
    return fn();
  } finally {
    try {
      if (readFileSync(lock, 'utf8') === token) unlinkSync(lock);
    } catch {}
  }
}

/** Worst-case input tokens: UTF-8 BYTES (not chars) of the serialised request (system + tools + messages) + FRAMING_TOKENS. */
export function estimateInputTokens(params: CreateParams): number {
  const json = JSON.stringify({ system: params.system ?? '', tools: params.tools ?? [], messages: params.messages });
  return Buffer.byteLength(json, 'utf8') + FRAMING_TOKENS;
}

/** True when the request marks any block for prompt caching (DUKA_CLAUDE_CACHE=1, AC-L17). */
export function usesCache(params: CreateParams): boolean {
  return JSON.stringify({ system: params.system ?? '', tools: params.tools ?? [] }).includes('"cache_control"');
}

/**
 * Worst-case cost of one request in USD, or null for an unpriced model. Output is bounded by max_tokens (thinking included).
 * Input is the byte upper bound (estimateInputTokens) priced at the highest input rate that can apply: with prompt caching
 * the HIGHER of the input and cache-write prices (a cold cache writes the whole prefix; cache reads are cheaper). Actual
 * cost comes from usage and replaces the reservation after the call.
 */
export function estimateCostUSD(params: CreateParams): number | null {
  const p = Object.hasOwn(PRICES, params.model) ? PRICES[params.model] : undefined;
  if (!p) return null;
  const inPrice = usesCache(params) ? Math.max(p.input, p.cacheWrite) : p.input;
  return usd(micro((estimateInputTokens(params) * inPrice + params.max_tokens * p.output) / 1e6));
}

export type Usage = { input: number; output: number; cacheCreation: number; cacheRead: number };
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/** Usage numbers from a response, or null when the response has none. */
export function readUsage(msg: unknown): Usage | null {
  const u = msg && typeof msg === 'object' ? (msg as { usage?: unknown }).usage : undefined;
  if (!u || typeof u !== 'object') return null;
  const r = u as Record<string, unknown>;
  return { input: num(r.input_tokens), output: num(r.output_tokens), cacheCreation: num(r.cache_creation_input_tokens), cacheRead: num(r.cache_read_input_tokens) };
}

export function costFromUsage(model: string, u: Usage): number {
  const p = PRICES[model];
  if (!p) return 0;
  return usd(micro((u.input * p.input + u.output * p.output + u.cacheCreation * p.cacheWrite + u.cacheRead * p.cacheRead) / 1e6));
}

export type Reservation = { usd: number; model: string; origin: string; env: Env; done: boolean };
export type ReserveResult = { ok: true; r: Reservation; estimateUSD: number } | { ok: false; reason: SpendRefusal; estimateUSD?: number };

/** Reserves the worst-case cost, or refuses. Synchronous read-modify-write: concurrent callers cannot both pass the cap. */
export function reserve(params: CreateParams, env: Env = process.env): ReserveResult {
  const est = estimateCostUSD(params);
  if (est === null) return { ok: false, reason: 'unknown_model' };
  const cap = capUSD(env);
  let over = false;
  try {
    withLock(env, () => {
      const l = readLedger(env);
      over = micro(l.spentUSD) + micro(l.reservedUSD) + micro(est) > micro(cap);
      if (!over) writeLedger(env, { ...l, capUSD: cap, reservedUSD: usd(micro(l.reservedUSD) + micro(est)) });
    });
  } catch (e) {
    return { ok: false, reason: e instanceof StaleLock ? 'stale_lock' : 'ledger_error', estimateUSD: est };
  }
  if (over) return { ok: false, reason: 'spend_cap', estimateUSD: est };
  return { ok: true, r: { usd: est, model: params.model, origin: spendOrigin(env), env, done: false }, estimateUSD: est };
}

export type CallMeta = { turn?: number; req?: number };
export type Outcome = 'ok' | 'kept_timeout' | 'kept_error' | 'kept_no_usage' | 'released_refused';

/** One calls.jsonl line: numbers and codes only. */
export type CallLine = { ts: string; origin: string; model: string; turn: number; req: number; input: number; output: number; cache_creation: number; cache_read: number; costUSD: number; totalUSD: number; outcome: Outcome };

function finish(r: Reservation, chargeUSD: number, u: Usage, outcome: Outcome, meta: CallMeta): void {
  if (r.done) return;
  r.done = true;
  const env = r.env;
  let total = NaN;
  try {
    total = withLock(env, () => {
      const l = readLedger(env);
      const charged = outcome !== 'released_refused';
      const spent = micro(l.spentUSD) + micro(chargeUSD);
      const o = l.origins[r.origin] ?? { spentUSD: 0, calls: 0 };
      const next: Ledger = {
        ...l,
        capUSD: capUSD(env),
        spentUSD: usd(spent),
        reservedUSD: usd(Math.max(0, micro(l.reservedUSD) - micro(r.usd))),
        calls: l.calls + (charged ? 1 : 0),
        origins: { ...l.origins, [r.origin]: { spentUSD: usd(micro(o.spentUSD) + micro(chargeUSD)), calls: o.calls + (charged ? 1 : 0) } },
      };
      writeLedger(env, next);
      return next.spentUSD;
    });
  } catch {
    // A ledger that broke (or stayed locked) mid-call keeps the reservation: the charge stays conservative.
  }
  const line: CallLine = {
    ts: new Date().toISOString(),
    origin: r.origin,
    model: r.model,
    turn: num(meta.turn),
    req: num(meta.req),
    input: u.input,
    output: u.output,
    cache_creation: u.cacheCreation,
    cache_read: u.cacheRead,
    costUSD: chargeUSD,
    totalUSD: Number.isFinite(total) ? total : -1,
    outcome,
  };
  try {
    appendFileSync(join(spendDir(env), 'calls.jsonl'), `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch {}
}

const ZERO: Usage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };

/** Replaces the reservation by the actual cost from usage. */
export function settle(r: Reservation, u: Usage, meta: CallMeta = {}): number {
  const cost = costFromUsage(r.model, u);
  finish(r, cost, u, 'ok', meta);
  return cost;
}
/** No usage after a timeout, abort or error: the reservation becomes the charge. */
export function keep(r: Reservation, outcome: 'kept_timeout' | 'kept_error' | 'kept_no_usage', meta: CallMeta = {}): void {
  finish(r, r.usd, ZERO, outcome, meta);
}
/** Definite client-side refusal before send: nothing is charged. */
export function release(r: Reservation, meta: CallMeta = {}): void {
  finish(r, 0, ZERO, 'released_refused', meta);
}

export type SpendStatus = { capUSD: number; spentUSD: number; reservedUSD: number; remainingUSD: number; calls: number; origins: Ledger['origins']; lastCalls: CallLine[] };

/** Server-side status (AC-L6). Throws LedgerError for a broken ledger. */
export function spendStatus(env: Env = process.env, last = 5): SpendStatus {
  const l = readLedger(env);
  const cap = capUSD(env);
  let lines: CallLine[] = [];
  try {
    lines = readFileSync(join(spendDir(env), 'calls.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-last)
      .map((s) => JSON.parse(s) as CallLine);
  } catch {}
  return { capUSD: cap, spentUSD: l.spentUSD, reservedUSD: l.reservedUSD, remainingUSD: usd(Math.max(0, micro(cap) - micro(l.spentUSD) - micro(l.reservedUSD))), calls: l.calls, origins: l.origins, lastCalls: lines };
}

// ---------- shape trace (AC-L8) ----------

const code = (v: unknown) => (typeof v === 'string' && /^[a-z0-9_]{1,40}$/.test(v) ? v : 'other');

/** One request line: config values and our own tool names only. */
export function traceRequest(params: CreateParams): string {
  const t = params.thinking as { type?: unknown } | undefined;
  const oc = (params as { output_config?: { effort?: unknown } }).output_config;
  const tc = params.tool_choice as { type?: unknown } | undefined;
  const tools = (params.tools ?? []).map((x) => code((x as { name?: unknown }).name)).join(',');
  return `[claude-trace] req model=${code(params.model.replace(/-/g, '_'))} thinking=${t ? code(t.type) : 'omitted'} effort=${oc ? code(oc.effort) : 'omitted'} tool_choice=${tc ? code(tc.type) : 'omitted'} tools=${tools || '-'} messages=${params.messages.length} max_tokens=${num(params.max_tokens)} cache=${usesCache(params) ? 'on' : 'off'}`;
}

/** One response line: stop reason, block types, known tool names, usage numbers, request ms. Never text or tool inputs. */
export function traceResponse(params: CreateParams, msg: unknown, ms?: number): string {
  const known = new Set((params.tools ?? []).map((x) => (x as { name?: string }).name));
  const m = (msg && typeof msg === 'object' ? msg : {}) as { stop_reason?: unknown; content?: unknown };
  const blocks = Array.isArray(m.content) ? (m.content as Array<{ type?: unknown; name?: unknown }>).slice(0, 20) : [];
  const types = blocks.map((b) => code(b?.type)).join(',');
  const uses = blocks.filter((b) => b?.type === 'tool_use').map((b) => (typeof b.name === 'string' && known.has(b.name) ? b.name : 'unknown')).join(',');
  const u = readUsage(msg) ?? ZERO;
  return `[claude-trace] res stop=${code(m.stop_reason)} blocks=${types || '-'} tool_uses=${uses || '-'} usage_in=${u.input} usage_out=${u.output} cache_write=${u.cacheCreation} cache_read=${u.cacheRead}${ms === undefined ? '' : ` ms=${num(ms)}`}`;
}

const isTimeout = (e: unknown, signal: AbortSignal) => signal.aborted || (e instanceof Error && /timeout|abort/i.test(e.name));

/**
 * Wraps a client so every create() goes through reserve, then settle / keep /
 * release. Used for the live client only (and, test-only, for the mock under
 * DUKA_SPEND_TEST_PRICE_MOCK; see spendTestHookEnabled in config.ts).
 */
export function withSpendGuard(inner: PlannerClient, env: Env = process.env, log: (line: string) => void = (l) => console.info(l)): PlannerClient {
  const trace = env.DUKA_LIVE_TRACE === '1';
  return {
    kind: inner.kind,
    async create(params, opts) {
      const sel = ledgerSelection(env);
      if (sel.kind === 'shared') {
        // Required but missing or invalid store: fail closed, no model request.
        if (!sel.cfg) throw new SpendRefused('ledger_error');
        return sharedCreate({ cfg: sel.cfg, ns: sel.ns }, inner, params, opts, env, trace, log);
      }
      const res = reserve(params, env);
      if (!res.ok) throw new SpendRefused(res.reason);
      const meta = opts.meta ?? {};
      if (trace) log(traceRequest(params));
      let msg: Anthropic.Message;
      const t0 = Date.now();
      try {
        msg = await inner.create(params, opts);
      } catch (e) {
        if (isLiveRefused(e)) release(res.r, meta);
        else keep(res.r, isTimeout(e, opts.signal) ? 'kept_timeout' : 'kept_error', meta);
        if (trace) log(`[claude-trace] res error ms=${Date.now() - t0}`);
        throw e;
      }
      const ms = Date.now() - t0;
      const u = readUsage(msg);
      if (u) settle(res.r, u, meta);
      else keep(res.r, 'kept_no_usage', meta);
      if (trace) log(traceResponse(params, msg, ms));
      return msg;
    },
  };
}

/** A reservation held in the shared store. */
type SharedReservation = { id: string; worstMicro: number; model: string; origin: string; done: boolean };

/** Same accounting as finish() for the file ledger: charge in micro-dollars, one capped call-log line. All store errors are swallowed (the sweep keeps the reservation). */
async function finishShared(sh: SharedLedger, r: SharedReservation, chargeMicro: number, u: Usage, outcome: Outcome, meta: CallMeta): Promise<void> {
  if (r.done) return;
  r.done = true;
  let total = -1;
  try {
    const spent = await sharedSettle(sh, r.id, chargeMicro, outcome !== 'released_refused', r.origin);
    if (spent !== null) total = spent / 1e6;
  } catch {
    // A store error (or timeout) mid-call keeps the reservation until the next sweep charges it in full.
  }
  const line: CallLine = {
    ts: new Date().toISOString(),
    origin: r.origin,
    model: r.model,
    turn: num(meta.turn),
    req: num(meta.req),
    input: u.input,
    output: u.output,
    cache_creation: u.cacheCreation,
    cache_read: u.cacheRead,
    costUSD: chargeMicro / 1e6,
    totalUSD: total,
    outcome,
  };
  await pushCallLine(sh, line);
}

/** The shared-ledger version of the guarded create: reserve in the store, call, settle in the store. */
async function sharedCreate(
  sh: SharedLedger,
  inner: PlannerClient,
  params: CreateParams,
  opts: { signal: AbortSignal; meta?: CallMeta },
  env: Env,
  trace: boolean,
  log: (line: string) => void,
): Promise<Anthropic.Message> {
  const est = estimateCostUSD(params);
  if (est === null) throw new SpendRefused('unknown_model'); // before any store call
  const worstMicro = micro(est);
  let held: SharedReservation;
  try {
    const r = await sharedReserve(sh, micro(capUSD(env)), worstMicro);
    if (!r.ok) throw new SpendRefused('spend_cap');
    held = { id: r.id, worstMicro, model: params.model, origin: spendOrigin(env), done: false };
  } catch (e) {
    if (e instanceof SpendRefused) throw e;
    // StoreError (error, bad answer, timeout) or anything unexpected: refuse. Nothing was sent to the model.
    throw new SpendRefused('ledger_error');
  }
  const meta = opts.meta ?? {};
  if (trace) log(traceRequest(params));
  let msg: Anthropic.Message;
  const t0 = Date.now();
  try {
    msg = await inner.create(params, opts);
  } catch (e) {
    if (isLiveRefused(e)) await finishShared(sh, held, 0, ZERO, 'released_refused', meta);
    else await finishShared(sh, held, held.worstMicro, ZERO, isTimeout(e, opts.signal) ? 'kept_timeout' : 'kept_error', meta);
    if (trace) log(`[claude-trace] res error ms=${Date.now() - t0}`);
    throw e;
  }
  const ms = Date.now() - t0;
  const u = readUsage(msg);
  if (u) await finishShared(sh, held, micro(costFromUsage(held.model, u)), u, 'ok', meta);
  else await finishShared(sh, held, held.worstMicro, ZERO, 'kept_no_usage', meta);
  if (trace) log(traceResponse(params, msg, ms));
  return msg;
}
