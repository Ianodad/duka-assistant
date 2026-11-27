/**
 * In-memory fake of an Upstash style Redis REST endpoint (no network, ever).
 *
 * POST <url>           body ["CMD", ...args]            -> {result} | {error}
 * POST <url>/pipeline  body [["CMD", ...], ...]         -> [{result} | {error}, ...]
 * Header Authorization: Bearer <token> is checked when opts.token is set.
 *
 * Each request runs its command(s) synchronously inside one microtask AFTER the
 * (random) latency, so every EVAL is atomic exactly like a Redis script. EVAL is
 * dispatched by exact string equality with the Lua text exported by store.ts
 * (LUA.reserve and so on); any other script is an error. Each mirror below is a
 * line by line TypeScript copy of that Lua script: KEYS and ARGV are 1-based like
 * in Lua, `?? '0'` stands for `or '0'`, and a missing hash field (Lua false) is null.
 * If a script in store.ts changes, its mirror here must change with it.
 */
import { LUA } from '@/lib/assistant/claude/store';

export type FakeState = {
  hashes: Map<string, Map<string, string>>;
  zsets: Map<string, Map<string, number>>;
  lists: Map<string, string[]>;
  strings: Map<string, { value: string; pttl: number | null }>;
};
export const emptyState = (): FakeState => ({ hashes: new Map(), zsets: new Map(), lists: new Map(), strings: new Map() });

export type FakeFail = 'error500' | 'errorBody' | 'badJson' | 'hang' | 'applyThenError500';
export type FakeCall = { path: string; auth: string | null; body: unknown };

// ---------- Redis primitives (the few the scripts and the tests use) ----------

class RedisError extends Error {}
const toInteger = (s: string) => {
  const n = Number(s);
  if (!Number.isSafeInteger(n)) throw new RedisError('ERR value is not an integer or out of range');
  return n;
};

export const hget = (st: FakeState, key: string, field: string): string | null => st.hashes.get(key)?.get(field) ?? null;
export function hset(st: FakeState, key: string, ...pairs: Array<string | number>): number {
  if (pairs.length === 0 || pairs.length % 2 !== 0) throw new RedisError('ERR wrong number of arguments for HSET');
  const h = st.hashes.get(key) ?? new Map<string, string>();
  let added = 0;
  for (let i = 0; i < pairs.length; i += 2) {
    if (!h.has(String(pairs[i]))) added++;
    h.set(String(pairs[i]), String(pairs[i + 1]));
  }
  st.hashes.set(key, h);
  return added;
}
export function hincrby(st: FakeState, key: string, field: string, n: number): number {
  const next = toInteger(hget(st, key, field) ?? '0') + toInteger(String(n));
  hset(st, key, field, next);
  return next;
}
export function hdel(st: FakeState, key: string, field: string): number {
  const h = st.hashes.get(key);
  const had = h?.delete(field) ?? false;
  if (h && h.size === 0) st.hashes.delete(key); // Redis removes an empty hash
  return had ? 1 : 0;
}
export const hlen = (st: FakeState, key: string) => st.hashes.get(key)?.size ?? 0;
export const exists = (st: FakeState, key: string) => (st.hashes.has(key) || st.zsets.has(key) || st.lists.has(key) || st.strings.has(key) ? 1 : 0);
export function zadd(st: FakeState, key: string, score: number, member: string): void {
  const z = st.zsets.get(key) ?? new Map<string, number>();
  z.set(member, score);
  st.zsets.set(key, z);
}
export function zrem(st: FakeState, key: string, member: string): void {
  const z = st.zsets.get(key);
  z?.delete(member);
  if (z && z.size === 0) st.zsets.delete(key);
}
/** Members with score <= max, by score then member. */
export function zrangebyscore(st: FakeState, key: string, max: number): string[] {
  return [...(st.zsets.get(key) ?? new Map<string, number>())].filter(([, s]) => s <= max).sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)).map(([m]) => m);
}
export const get = (st: FakeState, key: string): string | null => st.strings.get(key)?.value ?? null;
export function incr(st: FakeState, key: string): number {
  const cur = st.strings.get(key);
  const next = toInteger(cur?.value ?? '0') + 1;
  st.strings.set(key, { value: String(next), pttl: cur?.pttl ?? null });
  return next;
}
export function pexpire(st: FakeState, key: string, ms: number): void {
  const cur = st.strings.get(key);
  if (cur) cur.pttl = ms;
}

// ---------- mirrors of the Lua scripts ----------

/** Mirrors the SWEEP prefix inlined at the top of LUA.reserve and LUA.settle. */
function sweep(st: FakeState, KEYS: string[], ARGV: string[]): void {
  const ids = zrangebyscore(st, KEYS[3], Number(ARGV[1]));
  for (const id of ids) {
    const amt = hget(st, KEYS[2], id);
    if (amt !== null) {
      const n = Number(amt);
      hincrby(st, KEYS[1], 'spent', n);
      hincrby(st, KEYS[1], 'reserved', 0 - n);
      hincrby(st, KEYS[1], 'calls', 1);
      hincrby(st, KEYS[1], 'expired', 1);
      hdel(st, KEYS[2], id);
    }
    zrem(st, KEYS[3], id);
  }
}

/** Mirrors LUA.reserve. */
export function mirrorReserve(st: FakeState, keys: string[], argv: string[]): number[] {
  const KEYS = ['', ...keys];
  const ARGV = ['', ...argv];
  sweep(st, KEYS, ARGV);
  const spent = Number(hget(st, KEYS[1], 'spent') ?? '0');
  const reserved = Number(hget(st, KEYS[1], 'reserved') ?? '0');
  const worst = Number(ARGV[3]);
  if (spent + reserved + worst > Number(ARGV[2])) {
    return [0, spent, reserved];
  }
  hincrby(st, KEYS[1], 'reserved', worst);
  hset(st, KEYS[2], ARGV[4], worst);
  zadd(st, KEYS[3], Number(ARGV[1]) + Number(ARGV[5]), ARGV[4]);
  return [1, spent, reserved + worst];
}

/** Mirrors LUA.settle. */
export function mirrorSettle(st: FakeState, keys: string[], argv: string[]): number[] {
  const KEYS = ['', ...keys];
  const ARGV = ['', ...argv];
  sweep(st, KEYS, ARGV);
  const amt = hget(st, KEYS[2], ARGV[2]);
  if (amt === null) {
    return [0, Number(hget(st, KEYS[1], 'spent') ?? '0')];
  }
  hdel(st, KEYS[2], ARGV[2]);
  zrem(st, KEYS[3], ARGV[2]);
  hincrby(st, KEYS[1], 'reserved', 0 - Number(amt));
  const spent = hincrby(st, KEYS[1], 'spent', Number(ARGV[3]));
  hincrby(st, KEYS[1], `o:${ARGV[5]}:spent`, Number(ARGV[3]));
  if (ARGV[4] === '1') {
    hincrby(st, KEYS[1], 'calls', 1);
    hincrby(st, KEYS[1], `o:${ARGV[5]}:calls`, 1);
  }
  return [1, spent];
}

/** Mirrors LUA.rate. */
export function mirrorRate(st: FakeState, keys: string[], argv: string[]): number[] {
  const KEYS = ['', ...keys];
  const ARGV = ['', ...argv];
  const m = Number(get(st, KEYS[1]) ?? '0');
  const d = Number(get(st, KEYS[2]) ?? '0');
  if (m >= Number(ARGV[1]) || d >= Number(ARGV[2])) {
    return [0, m, d];
  }
  const m2 = incr(st, KEYS[1]);
  const d2 = incr(st, KEYS[2]);
  if (m2 === 1) {
    pexpire(st, KEYS[1], Number(ARGV[3]));
  }
  if (d2 === 1) {
    pexpire(st, KEYS[2], Number(ARGV[4]));
  }
  return [1, m2, d2];
}

/** Mirrors LUA.seed. */
export function mirrorSeed(st: FakeState, keys: string[], argv: string[]): number[] {
  const KEYS = ['', ...keys];
  const ARGV = ['', ...argv];
  if (exists(st, KEYS[1]) === 1 || hlen(st, KEYS[2]) > 0) {
    return [0, Number(hget(st, KEYS[1], 'spent') ?? '0')];
  }
  hset(st, KEYS[1], 'spent', ARGV[1], 'reserved', 0, 'calls', 0, 'expired', 0, 'seeded', 1);
  return [1, Number(ARGV[1])];
}

const MIRRORS = new Map<string, (st: FakeState, keys: string[], argv: string[]) => number[]>([
  [LUA.reserve, mirrorReserve],
  [LUA.settle, mirrorSettle],
  [LUA.rate, mirrorRate],
  [LUA.seed, mirrorSeed],
]);

// ---------- command execution ----------

function exec(st: FakeState, args: unknown): unknown {
  if (!Array.isArray(args) || args.length === 0 || !args.every((a) => typeof a === 'string')) throw new RedisError('ERR bad command');
  const [name, ...a] = args as string[];
  switch (name.toUpperCase()) {
    case 'EVAL': {
      const mirror = MIRRORS.get(a[0]);
      if (!mirror) throw new RedisError('ERR unknown script');
      const nkeys = toInteger(a[1]);
      return mirror(st, a.slice(2, 2 + nkeys), a.slice(2 + nkeys));
    }
    case 'HGETALL':
      return [...(st.hashes.get(a[0]) ?? new Map<string, string>())].flat();
    case 'HGET':
      return hget(st, a[0], a[1]);
    case 'HINCRBY':
      return hincrby(st, a[0], a[1], toInteger(a[2]));
    case 'LPUSH': {
      const l = st.lists.get(a[0]) ?? [];
      l.unshift(a[1]);
      st.lists.set(a[0], l);
      return l.length;
    }
    case 'LTRIM': {
      const l = st.lists.get(a[0]) ?? [];
      st.lists.set(a[0], l.slice(toInteger(a[1]), toInteger(a[2]) + 1));
      return 'OK';
    }
    case 'LRANGE': {
      const l = st.lists.get(a[0]) ?? [];
      return l.slice(toInteger(a[1]), toInteger(a[2]) + 1);
    }
    case 'GET':
      return get(st, a[0]);
    case 'PTTL':
      return st.strings.get(a[0])?.pttl ?? -1;
    default:
      throw new RedisError('ERR unknown command');
  }
}

// ---------- the fake endpoint ----------

export type FakeOptions = {
  /** Bearer token the endpoint accepts. Unset: any. */
  token?: string;
  /** Milliseconds each request waits before it is applied. */
  latency?: () => number;
  fail?: FakeFail;
  /** Runs synchronously right after each applied request (invariant checks). */
  afterApply?: (st: FakeState) => void;
};

export function createFakeUpstash(opts: FakeOptions = {}) {
  const state = emptyState();
  const calls: FakeCall[] = [];
  let fail: FakeFail | undefined = opts.fail;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const aborted = (signal?: AbortSignal | null) => Object.assign(new Error('aborted'), { name: 'AbortError', aborted: signal?.aborted });

  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(href).pathname.replace(/\/+$/, '');
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ path, auth: headers.get('authorization'), body });
    const signal = init?.signal;

    const wait = opts.latency ? opts.latency() : 0;
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(aborted(signal));
      const t = setTimeout(resolve, wait);
      signal?.addEventListener('abort', () => (clearTimeout(t), reject(aborted(signal))), { once: true });
    });
    if (fail === 'hang') return new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(aborted(signal)), { once: true }));
    // These three answer without touching state.
    if (fail === 'error500') return json(500, { error: 'ERR boom' });
    if (fail === 'errorBody') return json(200, { error: 'ERR boom' });
    if (fail === 'badJson') return new Response('<html>not json', { status: 200 });

    if (opts.token !== undefined && headers.get('authorization') !== `Bearer ${opts.token}`) return json(401, { error: 'unauthorized' });

    // Everything from here to the return is synchronous: one atomic step.
    const run = (cmd: unknown): { result: unknown } | { error: string } => {
      try {
        return { result: exec(state, cmd) };
      } catch (e) {
        return { error: e instanceof RedisError ? e.message : 'ERR script failed' };
      }
    };
    let out: unknown;
    if (path === '/pipeline') out = Array.isArray(body) ? body.map(run) : { error: 'ERR bad pipeline' };
    else out = run(body);
    opts.afterApply?.(state);

    // The command was applied but the answer is lost: the caller sees an error, the store keeps the change.
    if (fail === 'applyThenError500') return json(500, { error: 'ERR boom' });
    return json(200, out);
  }) as typeof fetch;

  return {
    fetch: fakeFetch,
    state,
    calls,
    setFail: (f: FakeFail | undefined) => {
      fail = f;
    },
  };
}
