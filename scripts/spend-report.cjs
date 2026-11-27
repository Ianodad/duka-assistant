#!/usr/bin/env node
/* eslint-disable */
// pnpm spend: live Claude spend status (SPEC-LIVE AC-L6). Reads only the ledger
// dir (.duka-spend/ or DUKA_SPEND_DIR). Never loads .env, never prints the key:
// it prints cap, spent, reserved, remaining, call counts and the last 5 call
// lines (numbers and codes only). The cap rule matches lib/assistant/claude/spend.ts:
// hard 5.00, DUKA_SPEND_CAP_USD may only lower it, nonsense means 0.
const fs = require('node:fs');
const path = require('node:path');

const HARD_CAP_USD = 5.0;
const ROOT = path.resolve(__dirname, '..');
const dir = process.env.DUKA_SPEND_DIR && process.env.DUKA_SPEND_DIR.trim() ? process.env.DUKA_SPEND_DIR : path.join(ROOT, '.duka-spend');

function cap() {
  const raw = process.env.DUKA_SPEND_CAP_USD;
  if (raw === undefined || raw.trim() === '') return HARD_CAP_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(HARD_CAP_USD, n);
}
const m = (x) => Math.round(x * 1e6);
const fmt = (x) => `$${(Math.round(x * 1e4) / 1e4).toFixed(4)}`;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;

let ledger;
try {
  ledger = JSON.parse(fs.readFileSync(path.join(dir, 'ledger.json'), 'utf8'));
} catch (e) {
  if (e && e.code === 'ENOENT') ledger = { spentUSD: 0, reservedUSD: 0, calls: 0, origins: {} };
  else {
    console.log(`ledger: UNREADABLE in ${dir} (live calls are refused until it is fixed)`);
    process.exit(1);
  }
}
if (!ledger || !isNum(ledger.spentUSD) || !isNum(ledger.reservedUSD)) {
  console.log(`ledger: BAD SHAPE in ${dir} (live calls are refused until it is fixed)`);
  process.exit(1);
}
const c = cap();
const remaining = Math.max(0, m(c) - m(ledger.spentUSD) - m(ledger.reservedUSD)) / 1e6;
console.log(`ledger dir:  ${dir}`);
console.log(`capUSD:      ${fmt(c)}`);
console.log(`spentUSD:    ${fmt(ledger.spentUSD)}`);
console.log(`reservedUSD: ${fmt(ledger.reservedUSD)}`);
console.log(`remaining:   ${fmt(remaining)}`);
console.log(`calls:       ${isNum(ledger.calls) ? ledger.calls : 0}`);
for (const [o, v] of Object.entries(ledger.origins || {})) {
  if (/^[A-Za-z0-9_-]{1,32}$/.test(o) && v && isNum(v.spentUSD)) console.log(`origin ${o}: ${fmt(v.spentUSD)} in ${isNum(v.calls) ? v.calls : 0} calls`);
}

const FIELDS = ['ts', 'origin', 'model', 'turn', 'req', 'input', 'output', 'cache_creation', 'cache_read', 'costUSD', 'totalUSD', 'outcome'];
let lines = [];
try {
  lines = fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).slice(-5);
} catch {}
console.log(`last ${lines.length} calls:`);
for (const l of lines) {
  let o;
  try {
    o = JSON.parse(l);
  } catch {
    console.log('  (unparseable line skipped)');
    continue;
  }
  // Whitelisted fields only; strings must be short codes.
  const safe = FIELDS.map((k) => {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) return `${k}=${v}`;
    if (typeof v === 'string' && /^[A-Za-z0-9_.:+-]{1,40}$/.test(v)) return `${k}=${v}`;
    return `${k}=?`;
  });
  console.log(`  ${safe.join(' ')}`);
}
