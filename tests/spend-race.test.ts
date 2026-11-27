/**
 * Review fix 1: a real multi-process race on one temp ledger. 4 child node
 * processes hammer reserve then settle/keep. Asserts: total spend never passes
 * the cap, no reservation or charge is lost (ledger totals equal the sum the
 * workers report), nothing stays reserved, and no lock is left behind.
 * Temp dir only, no network (children only touch the temp ledger files).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const WORKER = join(process.cwd(), 'tests', 'race', 'spend-worker.ts');
type Out = { admitted: number; refusedCap: number; refusedOther: number; chargedMicro: number };

function runWorker(dir: string, cap: string, origin: string, attempts: number, startAt: number): Promise<Out> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--conditions=react-server', '--import', 'tsx', WORKER, String(attempts), String(startAt)], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', DUKA_SPEND_DIR: dir, DUKA_SPEND_CAP_USD: cap, DUKA_SPEND_ORIGIN: origin },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('exit', (code) => (code === 0 ? resolve(JSON.parse(out.trim().split('\n').pop()!)) : reject(new Error(`worker ${origin} exit ${code}: ${err.slice(0, 300)}`))));
  });
}

let dir = '';
afterEach(() => {
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

describe('spend ledger under a real multi-process race', () => {
  it.each([
    [2, 60],
    [4, 60],
  ])('%i processes x %i attempts: never over the cap, no lost reservation or charge, no lock left', async (procs, attempts) => {
    dir = mkdtempSync(join(tmpdir(), 'duka-spend-race-'));
    const cap = '0.3';
    const startAt = Date.now() + 1500; // all workers start hammering at the same moment
    const outs = await Promise.all(Array.from({ length: procs }, (_, i) => runWorker(dir, cap, `w${i}`, attempts, startAt)));
    const l = JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8'));
    const admitted = outs.reduce((s, o) => s + o.admitted, 0);
    const charged = outs.reduce((s, o) => s + o.chargedMicro, 0);
    expect(outs.reduce((s, o) => s + o.refusedOther, 0)).toBe(0);
    expect(outs.reduce((s, o) => s + o.refusedCap, 0)).toBeGreaterThan(0); // the cap really was the binding limit
    expect(Math.round(l.spentUSD * 1e6)).toBeLessThanOrEqual(0.3 * 1e6);
    expect(Math.round(l.spentUSD * 1e6)).toBe(charged); // no charge lost
    expect(l.calls).toBe(admitted); // no settle lost
    expect(l.reservedUSD).toBe(0); // no reservation leaked or lost
    for (let i = 0; i < procs; i++) expect(l.origins[`w${i}`].calls).toBe(outs[i].admitted);
    expect(readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n')).toHaveLength(admitted);
    expect(existsSync(join(dir, 'ledger.lock'))).toBe(false);
  }, 60_000);
});
