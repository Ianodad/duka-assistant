#!/usr/bin/env node
/* eslint-disable */
// Client bundle check (SPEC-LIVE AC-L39): node scripts/check-client-bundle.cjs <dir>
// Walks every file under <dir> (for example .next/static) and looks for terms that
// must never reach the browser. Prints "<relative file>: <term>" and nothing else
// about the content, so a hit never prints a secret. Exit 0: clean. Exit 1: a hit.
// Exit 2: bad usage, a missing directory or an empty one (a vacuous pass is a failure).
const fs = require('node:fs');
const path = require('node:path');

// The key prefix is assembled at runtime so no tracked file contains it literally.
const TERMS = [['sk', 'ant'].join('-'), 'ANTHROPIC', 'KV_REST', 'UPSTASH'];

const dir = process.argv[2];
if (!dir || process.argv.length !== 3) {
  console.error('usage: node scripts/check-client-bundle.cjs <dir>');
  process.exit(2);
}
let st;
try {
  st = fs.statSync(dir);
} catch {
  console.error('check-client-bundle: directory not found');
  process.exit(2);
}
if (!st.isDirectory()) {
  console.error('check-client-bundle: not a directory');
  process.exit(2);
}

let files = 0;
let hits = 0;
function walk(d) {
  for (const name of fs.readdirSync(d).sort()) {
    const full = path.join(d, name);
    const s = fs.statSync(full);
    if (s.isDirectory()) walk(full);
    else if (s.isFile()) {
      files++;
      const text = fs.readFileSync(full).toString('latin1');
      for (const t of TERMS) {
        if (text.includes(t)) {
          console.log(`${path.relative(dir, full)}: ${t}`);
          hits++;
        }
      }
    }
  }
}
walk(dir);
if (files === 0) {
  console.error('check-client-bundle: no files under the directory');
  process.exit(2);
}
console.log(`check-client-bundle: ${files} files scanned, ${hits} hits`);
process.exit(hits > 0 ? 1 : 0);
