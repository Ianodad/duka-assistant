/**
 * Shared spend ledger and per-IP rate limit on a Redis-over-REST store
 * (SPEC-LIVE AC-L33 to AC-L36, AC-L38). Used when the app runs on several
 * instances with no shared disk (Vercel). Upstash style REST API: one POST per
 * command, EVAL for every money or quota change so each is ONE atomic step.
 *
 * Rules:
 *  - Money is integer micro-dollars. Reserve, settle, rate check and seed are one
 *    Lua script each (below). The scripts are tiny on purpose; tests run a line
 *    by line TypeScript mirror of each one (tests/fakes/fake-upstash.ts).
 *  - Fail closed: any store problem is a StoreError whose message holds a fixed
 *    code only (never the URL, the token, a key, a body or an IP).
 *  - Tests never reach a real store: in a test process every call throws unless
 *    a fake transport was injected with setStoreFetchForTests.
 *  - The raw IP is never stored or logged. Rate keys hold an HMAC of it keyed by
 *    the store token.
 * Nothing here logs. Server only.
 */
import 'server-only';
import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type { Env } from './config';
import { processIsTest, testOnlyBehaviourAllowed } from './client';
import type { CallLine } from './spend';

export const STORE_TIMEOUT_MS = 2_000;
export const RESERVATION_TTL_MS = 120_000;
export const CALL_LOG_KEEP = 200;
/** Live prompts allowed per IP. DUKA_RATE_PER_MIN and DUKA_RATE_PER_DAY may only lower these. */
export const RATE_LIMITS = { perMinute: 5, perDay: 40 } as const;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const MINUTE_KEY_TTL_MS = 120_000;
const DAY_KEY_TTL_MS = 172_800_000;

// ---------- selection ----------

export type StoreConfig = { url: string; token: string };
export type LedgerSelection = { kind: 'file' } | { kind: 'shared'; cfg: StoreConfig; ns: string } | { kind: 'shared'; cfg: null };
export type SharedLedger = { cfg: StoreConfig; ns: string };

const STORE_NAMES = ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'] as const;
const NS_RE = /^[A-Za-z0-9_-]{1,32}$/;

function pair(url: string | undefined, token: string | undefined): StoreConfig | null {
  const u = (url ?? '').trim();
  const t = (token ?? '').trim();
  if (!u || !t) return null;
  try {
    const p = new URL(u);
    if (p.protocol !== 'https:' || p.username || p.password) return null;
  } catch {
    return null;
  }
  return { url: u, token: t };
}

/** A complete https pair: KV_* first (Vercel integration), then UPSTASH_*. Otherwise null. */
export function storeConfig(env: Env = process.env): StoreConfig | null {
  return pair(env.KV_REST_API_URL, env.KV_REST_API_TOKEN) ?? pair(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
}

/** DUKA_LEDGER_NAMESPACE, default "duka". Null when it is set to something invalid (callers fail closed). */
export function ledgerNamespace(env: Env = process.env): string | null {
  const raw = env.DUKA_LEDGER_NAMESPACE;
  if (raw === undefined || raw === '') return 'duka';
  return NS_RE.test(raw) ? raw : null;
}

/**
 * Which ledger runs. A complete store config selects the shared ledger (also on a
 * laptop). The store is REQUIRED when VERCEL, VERCEL_ENV or AWS_LAMBDA_FUNCTION_NAME is
 * non-empty (Vercel functions set these even when system env exposure is off),
 * DUKA_LEDGER=shared, or any of the four store names is set: then a missing or invalid config is shared with
 * cfg null (fail closed). Otherwise the file ledger, as before.
 */
export function ledgerSelection(env: Env = process.env): LedgerSelection {
  const cfg = storeConfig(env);
  const ns = ledgerNamespace(env);
  if (cfg && ns) return { kind: 'shared', cfg, ns };
  const required =
    (env.VERCEL ?? '') !== '' || (env.VERCEL_ENV ?? '') !== '' || (env.AWS_LAMBDA_FUNCTION_NAME ?? '') !== '' || env.DUKA_LEDGER === 'shared' || STORE_NAMES.some((n) => (env[n] ?? '') !== '');
  return required ? { kind: 'shared', cfg: null } : { kind: 'file' };
}

// ---------- transport ----------

export type StoreErrorCode = 'blocked_in_tests' | 'timeout' | 'network' | 'http' | 'store_error' | 'bad_response';
export class StoreError extends Error {
  constructor(readonly code: StoreErrorCode) {
    super(`ledger store error: ${code}`);
  }
}

let testFetch: typeof fetch | null = null;
let testTimeoutMs: number | null = null;
/** Test seam: a fake transport. Ignored unless test-only behaviour is allowed. */
export function setStoreFetchForTests(fn: typeof fetch | null): void {
  testFetch = fn !== null && testOnlyBehaviourAllowed() ? fn : null;
}
/** Test seam: a shorter store timeout. Ignored unless test-only behaviour is allowed. */
export function setStoreTimeoutForTests(ms: number | null): void {
  testTimeoutMs = ms !== null && testOnlyBehaviourAllowed() ? ms : null;
}

function transport(): typeof fetch {
  if (processIsTest()) {
    if (testFetch && testOnlyBehaviourAllowed()) return testFetch;
    throw new StoreError('blocked_in_tests');
  }
  return fetch;
}

/** One POST. Resolves to the parsed JSON body. Every failure is a StoreError with a fixed code. */
async function rest(cfg: StoreConfig, path: '' | '/pipeline', body: unknown): Promise<unknown> {
  const f = transport();
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = (async (): Promise<unknown> => {
    let res: Response;
    try {
      res = await f(`${cfg.url.replace(/\/+$/, '')}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
        cache: 'no-store',
        redirect: 'manual',
      });
    } catch {
      throw new StoreError(ac.signal.aborted ? 'timeout' : 'network');
    }
    if (!res.ok) throw new StoreError('http');
    try {
      return (await res.json()) as unknown;
    } catch {
      throw new StoreError(ac.signal.aborted ? 'timeout' : 'bad_response');
    }
  })();
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new StoreError('timeout'));
    }, testTimeoutMs ?? STORE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    work.catch(() => {});
  }
}

function resultOf(v: unknown): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new StoreError('bad_response');
  const o = v as { result?: unknown; error?: unknown };
  if (o.error !== undefined) throw new StoreError('store_error');
  if (!('result' in o)) throw new StoreError('bad_response');
  return o.result;
}

async function command(cfg: StoreConfig, args: string[]): Promise<unknown> {
  return resultOf(await rest(cfg, '', args));
}

/** Several commands in one request. Any error entry fails the whole call. */
async function pipeline(cfg: StoreConfig, cmds: string[][]): Promise<unknown[]> {
  const out = await rest(cfg, '/pipeline', cmds);
  if (!Array.isArray(out) || out.length !== cmds.length) throw new StoreError('bad_response');
  return out.map(resultOf);
}

/** EVAL with all keys and args as strings. The script must return a table of integers. */
async function evalInts(cfg: StoreConfig, script: string, keys: string[], args: Array<string | number>, len: number): Promise<number[]> {
  const r = await command(cfg, ['EVAL', script, String(keys.length), ...keys, ...args.map(String)]);
  if (!Array.isArray(r) || r.length < len || !r.every((x) => typeof x === 'number' && Number.isSafeInteger(x))) throw new StoreError('bad_response');
  return r as number[];
}

// ---------- Lua scripts ----------
// Keys: KEYS[1] ledger hash, KEYS[2] res hash (id -> micro), KEYS[3] resexp zset (id -> expiry ms).
// ARGV[1] is always "now" in ms, passed in (no TIME), so tests can drive the clock.
// SWEEP: every reservation whose TTL passed is KEPT as spent (never released), counted as a call.
const SWEEP = `
local ids = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', ARGV[1])
for _, id in ipairs(ids) do
  local amt = redis.call('HGET', KEYS[2], id)
  if amt then
    local n = tonumber(amt)
    redis.call('HINCRBY', KEYS[1], 'spent', n)
    redis.call('HINCRBY', KEYS[1], 'reserved', 0 - n)
    redis.call('HINCRBY', KEYS[1], 'calls', 1)
    redis.call('HINCRBY', KEYS[1], 'expired', 1)
    redis.call('HDEL', KEYS[2], id)
  end
  redis.call('ZREM', KEYS[3], id)
end
`;

export const LUA = {
  /** ARGV: now, capMicro, worstMicro, id, ttlMs. Returns {1|0, spent, reserved}. */
  reserve: `${SWEEP}
local spent = tonumber(redis.call('HGET', KEYS[1], 'spent') or '0')
local reserved = tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0')
local worst = tonumber(ARGV[3])
if spent + reserved + worst > tonumber(ARGV[2]) then
  return {0, spent, reserved}
end
redis.call('HINCRBY', KEYS[1], 'reserved', worst)
redis.call('HSET', KEYS[2], ARGV[4], worst)
redis.call('ZADD', KEYS[3], tonumber(ARGV[1]) + tonumber(ARGV[5]), ARGV[4])
return {1, spent, reserved + worst}
`,
  /** ARGV: now, id, chargeMicro, charged (0|1), origin. Returns {1, newSpent} or {0, spent} when the id was already swept. */
  settle: `${SWEEP}
local amt = redis.call('HGET', KEYS[2], ARGV[2])
if not amt then
  return {0, tonumber(redis.call('HGET', KEYS[1], 'spent') or '0')}
end
redis.call('HDEL', KEYS[2], ARGV[2])
redis.call('ZREM', KEYS[3], ARGV[2])
redis.call('HINCRBY', KEYS[1], 'reserved', 0 - tonumber(amt))
local spent = redis.call('HINCRBY', KEYS[1], 'spent', tonumber(ARGV[3]))
redis.call('HINCRBY', KEYS[1], 'o:' .. ARGV[5] .. ':spent', tonumber(ARGV[3]))
if ARGV[4] == '1' then
  redis.call('HINCRBY', KEYS[1], 'calls', 1)
  redis.call('HINCRBY', KEYS[1], 'o:' .. ARGV[5] .. ':calls', 1)
end
return {1, spent}
`,
  /** KEYS: minute key, day key. ARGV: minLimit, dayLimit, minTtlMs, dayTtlMs. Returns {1|0, minuteCount, dayCount}. A refusal changes nothing. */
  rate: `
local m = tonumber(redis.call('GET', KEYS[1]) or '0')
local d = tonumber(redis.call('GET', KEYS[2]) or '0')
if m >= tonumber(ARGV[1]) or d >= tonumber(ARGV[2]) then
  return {0, m, d}
end
local m2 = redis.call('INCR', KEYS[1])
local d2 = redis.call('INCR', KEYS[2])
if m2 == 1 then
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
end
if d2 == 1 then
  redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[4]))
end
return {1, m2, d2}
`,
  /** KEYS: ledger, res. ARGV: spentMicro. Sets the ledger only when none exists. Returns {1|0, spent}. */
  seed: `
if redis.call('EXISTS', KEYS[1]) == 1 or redis.call('HLEN', KEYS[2]) > 0 then
  return {0, tonumber(redis.call('HGET', KEYS[1], 'spent') or '0')}
end
redis.call('HSET', KEYS[1], 'spent', ARGV[1], 'reserved', 0, 'calls', 0, 'expired', 0, 'seeded', 1)
return {1, tonumber(ARGV[1])}
`,
} as const;

// ---------- shared ledger operations ----------

const ledgerKeys = (ns: string) => [`${ns}:ledger`, `${ns}:res`, `${ns}:resexp`];
const callsKey = (ns: string) => `${ns}:calls`;
const isMicro = (n: number) => Number.isSafeInteger(n) && n >= 0;

export type SharedReserve = { ok: true; id: string; spentMicro: number; reservedMicro: number } | { ok: false; spentMicro: number; reservedMicro: number };

/** Sweeps expired reservations, then reserves worstMicro under a fresh id if spent + reserved + worst fits under capMicro. Throws StoreError. */
export async function sharedReserve(sh: SharedLedger, capMicro: number, worstMicro: number, now = Date.now()): Promise<SharedReserve> {
  if (!isMicro(capMicro) || !isMicro(worstMicro)) throw new StoreError('bad_response');
  const id = randomBytes(12).toString('hex');
  const r = await evalInts(sh.cfg, LUA.reserve, ledgerKeys(sh.ns), [now, capMicro, worstMicro, id, RESERVATION_TTL_MS], 3);
  return r[0] === 1 ? { ok: true, id, spentMicro: r[1], reservedMicro: r[2] } : { ok: false, spentMicro: r[1], reservedMicro: r[2] };
}

/** Replaces reservation id by the charge. Returns the new spent total in micro-dollars, or null when the id was already swept (nothing changed). Throws StoreError. */
export async function sharedSettle(sh: SharedLedger, id: string, chargeMicro: number, charged: boolean, origin: string, now = Date.now()): Promise<number | null> {
  if (!isMicro(chargeMicro)) throw new StoreError('bad_response');
  const r = await evalInts(sh.cfg, LUA.settle, ledgerKeys(sh.ns), [now, id, chargeMicro, charged ? 1 : 0, origin], 2);
  return r[0] === 1 ? r[1] : null;
}

/** Best effort: newest first, last CALL_LOG_KEEP kept. Numbers and codes only. Never throws. */
export async function pushCallLine(sh: SharedLedger, line: CallLine): Promise<void> {
  try {
    const key = callsKey(sh.ns);
    await pipeline(sh.cfg, [['LPUSH', key, JSON.stringify(line)], ['LTRIM', key, '0', String(CALL_LOG_KEEP - 1)]]);
  } catch {}
}

export type SharedStatus = {
  ns: string;
  capUSD: number;
  spentUSD: number;
  reservedUSD: number;
  remainingUSD: number;
  calls: number;
  expired: number;
  seeded: boolean;
  origins: Record<string, { spentUSD: number; calls: number }>;
  lastCalls: Partial<CallLine>[];
};

const toInt = (v: unknown) => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  return Number.isSafeInteger(n) ? n : 0;
};
const CALL_FIELDS = ['ts', 'origin', 'model', 'turn', 'req', 'input', 'output', 'cache_creation', 'cache_read', 'costUSD', 'totalUSD', 'outcome'] as const;

/** Reads the shared ledger for the operator report. Throws StoreError. Nothing swept or written. */
export async function sharedStatus(sh: SharedLedger, capMicro: number, last = 5): Promise<SharedStatus> {
  const [all, rows] = await pipeline(sh.cfg, [['HGETALL', ledgerKeys(sh.ns)[0]], ['LRANGE', callsKey(sh.ns), '0', String(Math.max(1, last) - 1)]]);
  const h = new Map<string, string>();
  if (Array.isArray(all)) for (let i = 0; i + 1 < all.length; i += 2) h.set(String(all[i]), String(all[i + 1]));
  else if (all && typeof all === 'object') for (const [k, v] of Object.entries(all)) h.set(k, String(v));
  const spent = toInt(h.get('spent'));
  const reserved = toInt(h.get('reserved'));
  const origins: SharedStatus['origins'] = {};
  for (const [k, v] of h) {
    const m = /^o:([A-Za-z0-9_-]{1,32}):spent$/.exec(k);
    if (m) origins[m[1]] = { spentUSD: toInt(v) / 1e6, calls: toInt(h.get(`o:${m[1]}:calls`)) };
  }
  const lastCalls: Partial<CallLine>[] = [];
  for (const raw of Array.isArray(rows) ? [...rows].reverse() : []) {
    try {
      const o = JSON.parse(String(raw)) as Record<string, unknown>;
      const safe: Record<string, unknown> = {};
      for (const f of CALL_FIELDS) {
        const v = o[f];
        if (typeof v === 'number' && Number.isFinite(v)) safe[f] = v;
        else if (typeof v === 'string' && /^[A-Za-z0-9_.:+-]{1,40}$/.test(v)) safe[f] = v;
      }
      lastCalls.push(safe as Partial<CallLine>);
    } catch {}
  }
  return {
    ns: sh.ns,
    capUSD: capMicro / 1e6,
    spentUSD: spent / 1e6,
    reservedUSD: reserved / 1e6,
    remainingUSD: Math.max(0, capMicro - spent - reserved) / 1e6,
    calls: toInt(h.get('calls')),
    expired: toInt(h.get('expired')),
    seeded: h.get('seeded') === '1',
    origins,
    lastCalls,
  };
}

/** Sets the spent total only when the namespace has no ledger yet. Returns whether it seeded and the current spent. Throws StoreError. */
export async function seedLedger(sh: SharedLedger, spentMicro: number): Promise<{ seeded: boolean; spentMicro: number }> {
  if (!isMicro(spentMicro)) throw new StoreError('bad_response');
  const [name, res] = ledgerKeys(sh.ns);
  const r = await evalInts(sh.cfg, LUA.seed, [name, res], [spentMicro], 2);
  return { seeded: r[0] === 1, spentMicro: r[1] };
}

// ---------- per-IP rate limit ----------

/** Per-IP limits after DUKA_RATE_PER_MIN / DUKA_RATE_PER_DAY: lower only; nonsense or negative means 0 (fail closed). */
export function rateLimitFor(env: Env = process.env): { perMinute: number; perDay: number } {
  const lower = (raw: string | undefined, hard: number) => {
    if (raw === undefined || raw.trim() === '') return hard;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(hard, Math.floor(n));
  };
  return { perMinute: lower(env.DUKA_RATE_PER_MIN, RATE_LIMITS.perMinute), perDay: lower(env.DUKA_RATE_PER_DAY, RATE_LIMITS.perDay) };
}

/** First hop of x-forwarded-for, else x-real-ip, else "unknown". */
export function clientIp(headers: { get(name: string): string | null }): string {
  const first = (headers.get('x-forwarded-for') ?? '').split(',')[0].trim();
  if (first) return first;
  const real = (headers.get('x-real-ip') ?? '').trim();
  return real || 'unknown';
}

/** HMAC-SHA256 of the IP keyed by the store token, first 32 hex chars. The raw IP is never a key. */
export function ipKeyPart(ip: string, token: string): string {
  return createHmac('sha256', token).update(ip).digest('hex').slice(0, 32);
}

/**
 * The identity a quota is charged to. IPv4: the address. IPv4-mapped IPv6: the dotted IPv4.
 * Other IPv6: its /64 (first 4 hextets, lowercase, no leading zeros, "::/64" suffix), so a
 * client rotating addresses inside its own /64 shares one quota. Not an IP: "unknown".
 */
export function rateKeyIp(ip: string): string {
  const raw = ip.trim();
  if (isIP(raw) === 4) return raw;
  let a = raw.split('%')[0].toLowerCase();
  if (isIP(a) !== 6) return 'unknown';
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (v4) {
    const [b0, b1, b2, b3] = v4.slice(1).map(Number);
    a = `${a.slice(0, v4.index)}${((b0 << 8) | b1).toString(16)}:${((b2 << 8) | b3).toString(16)}`;
  }
  const halves = a.split('::');
  if (halves.length > 2) return 'unknown';
  const head = halves[0] === '' ? [] : halves[0].split(':');
  const tail = halves.length === 2 && halves[1] !== '' ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return 'unknown';
  const parts = [...head, ...Array<string>(fill).fill('0'), ...tail].map((h) => parseInt(h, 16));
  if (parts.length !== 8 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return 'unknown';
  if (parts.slice(0, 5).every((n) => n === 0) && parts[5] === 0xffff) {
    return `${parts[6] >> 8}.${parts[6] & 255}.${parts[7] >> 8}.${parts[7] & 255}`;
  }
  return `${parts.slice(0, 4).map((n) => n.toString(16)).join(':')}::/64`;
}

export type RateVerdict = 'ok' | 'limited' | 'unavailable' | 'off';

/**
 * One atomic check and increment for this IP (a refusal consumes nothing).
 * off: the file ledger is selected, no per-IP limit. unavailable: the store is required
 * but missing, invalid, erroring or slow (fail closed).
 */
export async function checkRate(ip: string, env: Env = process.env, now = Date.now()): Promise<RateVerdict> {
  const sel = ledgerSelection(env);
  if (sel.kind === 'file') return 'off';
  if (!sel.cfg) return 'unavailable';
  const lim = rateLimitFor(env);
  const h = ipKeyPart(rateKeyIp(ip), sel.cfg.token);
  try {
    const r = await evalInts(
      sel.cfg,
      LUA.rate,
      [`${sel.ns}:rl:m:${h}:${Math.floor(now / MINUTE_MS)}`, `${sel.ns}:rl:d:${h}:${Math.floor(now / DAY_MS)}`],
      [lim.perMinute, lim.perDay, MINUTE_KEY_TTL_MS, DAY_KEY_TTL_MS],
      3,
    );
    return r[0] === 1 ? 'ok' : 'limited';
  } catch {
    return 'unavailable';
  }
}
