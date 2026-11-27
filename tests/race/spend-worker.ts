/**
 * Child process for tests/spend-race.test.ts. Hammers reserve then settle/keep
 * against the temp ledger in DUKA_SPEND_DIR. Run with
 *   node --conditions=react-server --import tsx tests/race/spend-worker.ts <attempts> <startAtMs>
 * Prints one JSON line: what this worker was admitted for and charged.
 * No network: the spend module only reads and writes files.
 */
import { keep, reserve, settle } from '../../lib/assistant/claude/spend';
import type { CreateParams } from '../../lib/assistant/claude/client';

const attempts = Number(process.argv[2]);
const startAt = Number(process.argv[3]);
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
while (Date.now() < startAt) sleep(1);

const params: CreateParams = { model: 'claude-sonnet-5-5', max_tokens: 1024, messages: [{ role: 'user', content: 'x'.repeat(300) }] } as CreateParams;
const out = { admitted: 0, refusedCap: 0, refusedOther: 0, chargedMicro: 0, maxSeenOver: 0 };
for (let i = 0; i < attempts; i++) {
  const r = reserve(params);
  if (!r.ok) {
    if (r.reason === 'spend_cap') out.refusedCap++;
    else out.refusedOther++;
    continue;
  }
  out.admitted++;
  sleep(Math.floor(Math.random() * 4)); // hold the reservation while others reserve
  if (i % 2 === 0) {
    keep(r.r, 'kept_error'); // charges the full reservation (worst case)
    out.chargedMicro += Math.round(r.r.usd * 1e6);
  } else {
    const cost = settle(r.r, { input: 100, output: 50 + (i % 7), cacheCreation: 0, cacheRead: 0 });
    out.chargedMicro += Math.round(cost * 1e6);
  }
}
process.stdout.write(`${JSON.stringify(out)}\n`);
