/**
 * Operator CLI for the live Claude spend ledger (SPEC-LIVE AC-L38).
 *
 *   pnpm spend                          report on whichever ledger is active
 *   pnpm ledger:seed --spent-usd 0.5    set the shared spent total, only if the namespace has no ledger yet
 *
 * Run through `tsx --conditions=react-server` so the server-only modules in
 * lib/assistant/claude load (their `server-only` import resolves to an empty
 * module under that condition). One source of truth: the same store.ts and
 * spend.ts the app uses.
 *
 * File ledger (no store env): `report` runs scripts/spend-report.cjs unchanged.
 * Shared ledger: prints namespace, cap, spent, reserved, remaining, calls,
 * expired and the last 5 calls (numbers and codes only).
 * Never loads .env. Never prints a URL, a token or a key. Never makes a model call.
 */
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import type { Env } from '../lib/assistant/claude/config';
import { capUSD } from '../lib/assistant/claude/spend';
import { ledgerSelection, seedLedger, sharedStatus, StoreError, type SharedLedger } from '../lib/assistant/claude/store';

export type CliIo = { out: (line: string) => void; err: (line: string) => void };

const fmt = (x: number) => `$${(Math.round(x * 1e4) / 1e4).toFixed(4)}`;

/** Thrown to stop with a message and an exit code. */
class CliFail extends Error {
  constructor(
    msg: string,
    readonly code: number,
  ) {
    super(msg);
  }
}
const fail = (msg: string, code = 1): never => {
  throw new CliFail(msg, code);
};

/** The shared ledger to use, or a clean failure (no network is touched before this passes). */
function sharedOrFail(env: Env): SharedLedger {
  const sel = ledgerSelection(env);
  if (sel.kind === 'file') return fail('ledger: no shared store is configured (set KV_REST_API_URL and KV_REST_API_TOKEN, or UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN). Nothing was changed.');
  if (!sel.cfg) return fail('ledger: the shared store is required but its config is missing or invalid (https URL and token pair, namespace [A-Za-z0-9_-]{1,32}). Nothing was changed.');
  return { cfg: sel.cfg, ns: sel.ns };
}

async function report(env: Env, io: CliIo): Promise<number> {
  if (ledgerSelection(env).kind === 'file') {
    // Unchanged file report: same script, same text, same exit code.
    const r = spawnSync(process.execPath, [join(__dirname, 'spend-report.cjs')], { stdio: 'inherit', env: env as NodeJS.ProcessEnv });
    return r.status ?? 1;
  }
  const sh = sharedOrFail(env);
  const s = await sharedStatus(sh, Math.round(capUSD(env) * 1e6), 5);
  io.out(`ledger:      shared (namespace ${s.ns})`);
  io.out(`capUSD:      ${fmt(s.capUSD)}`);
  io.out(`spentUSD:    ${fmt(s.spentUSD)}`);
  io.out(`reservedUSD: ${fmt(s.reservedUSD)}`);
  io.out(`remaining:   ${fmt(s.remainingUSD)}`);
  io.out(`calls:       ${s.calls}`);
  io.out(`expired:     ${s.expired}`);
  if (s.seeded) io.out('seeded:      yes');
  for (const [o, v] of Object.entries(s.origins)) io.out(`origin ${o}: ${fmt(v.spentUSD)} in ${v.calls} calls`);
  io.out(`last ${s.lastCalls.length} calls:`);
  for (const c of s.lastCalls) io.out(`  ${Object.entries(c).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  return 0;
}

async function seed(args: string[], env: Env, io: CliIo): Promise<number> {
  let raw: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--spent-usd') raw = args[++i];
    else if (args[i].startsWith('--spent-usd=')) raw = args[i].slice('--spent-usd='.length);
    else fail('seed: unknown argument. Usage: pnpm ledger:seed --spent-usd <n>', 2);
  }
  if (raw === undefined || !/^\d+(\.\d+)?$/.test(raw)) return fail('seed: --spent-usd <n> is required, a plain number >= 0.', 2);
  const n = Number(raw);
  const cap = capUSD(env);
  if (!Number.isFinite(n) || n < 0 || n > cap) return fail(`seed: --spent-usd must be between 0 and the cap (${fmt(cap)}).`, 2);
  const sh = sharedOrFail(env);
  const r = await seedLedger(sh, Math.round(n * 1e6));
  io.out(r.seeded ? `seeded: spent ${fmt(r.spentMicro / 1e6)} (namespace ${sh.ns})` : `not seeded: the namespace already has a ledger, spent ${fmt(r.spentMicro / 1e6)} (namespace ${sh.ns})`);
  return 0;
}

/** Runs one command and returns the exit code. Never throws. Messages hold fixed codes only (a StoreError never holds the URL, token or a key). */
export async function runCli(argv: string[], env: Env, io: CliIo): Promise<number> {
  try {
    const [cmd, ...rest] = argv;
    if (cmd === 'report') return await report(env, io);
    if (cmd === 'seed') return await seed(rest, env, io);
    return fail('usage: ledger-cli.ts report | seed --spent-usd <n>', 2);
  } catch (e) {
    if (e instanceof CliFail) io.err(e.message);
    else io.err(e instanceof StoreError ? `ledger: ${e.message}` : 'ledger: unexpected error');
    return e instanceof CliFail ? e.code : 1;
  }
}

// Run only when started as a script (pnpm spend, pnpm ledger:seed), not when imported by a test.
if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  runCli(process.argv.slice(2), process.env, { out: (l) => console.log(l), err: (l) => console.error(l) }).then((code) => process.exit(code));
}
