/**
 * AC-11 / AC-CP-9: scan for key-like strings. Scope is git-tracked files
 * (git ls-files), untracked files that are not gitignored, plus everything
 * under logs/ and evidence/. Without a .git folder (a tarball extract) it walks the tree
 * skipping node_modules, .next and .pnpm-store; env files are always filtered out. Nothing else is
 * opened: in particular the untracked, gitignored .env (it holds a real key)
 * is never read by this test.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const BINARY = /\.(png|jpg|jpeg|gif|webp|woff2?|ico|lock|tsbuildinfo)$/;

/** True for .env and every .env.* except the placeholder .env.example. */
export function isEnvFile(rel: string): boolean {
  const base = rel.split('/').pop() ?? '';
  return (base === '.env' || base.startsWith('.env.') || base.endsWith('.env')) && base !== '.env.example';
}

function walkOut(dir: string, out: string[] = []): string[] {
  if (!existsSync(join(ROOT, dir))) return out;
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walkOut(rel, out);
    else out.push(rel);
  }
  return out;
}

const inGitRepo = existsSync(join(ROOT, '.git'));
const git = (args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
const SKIP_DIRS = new Set(['node_modules', '.next', '.pnpm-store', '.git']);
/** Fallback for a tarball extract (no .git): walk the tree, skip dependency and build dirs; env files are filtered later. */
function walkTree(dir = '', out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (SKIP_DIRS.has(name)) continue;
    const rel = dir ? `${dir}/${name}` : name;
    if (statSync(join(ROOT, rel)).isDirectory()) walkTree(rel, out);
    else out.push(rel);
  }
  return out;
}
const tracked = inGitRepo ? git(['ls-files', '-z']) : walkTree();
// New files not yet added are in scope too; gitignored files (.env, node_modules, .next) are not.
const untracked = inGitRepo ? git(['ls-files', '-z', '--others', '--exclude-standard']) : [];
const scope = [...new Set([...tracked, ...untracked, ...walkOut('logs'), ...walkOut('evidence')])];
const files = scope.filter((f) => !isEnvFile(f) && !BINARY.test(f) && f !== 'pnpm-lock.yaml' && existsSync(join(ROOT, f)) && statSync(join(ROOT, f)).isFile());
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');

// The Anthropic key prefix is built at runtime so this file never contains it literally (git grep stays empty).
const ANTHROPIC_PREFIX = ['sk', 'ant', ''].join('-');
export const ANTHROPIC_KEY_RE = new RegExp(`${ANTHROPIC_PREFIX}[A-Za-z0-9_-]{20,}`);

// Patterns for real-looking credentials. Test fixtures use obvious fake_ prefixes and are short.
const PATTERNS: Array<[string, RegExp]> = [
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['Daraja-style 48+ char key assignment', /DARAJA_(CONSUMER_KEY|CONSUMER_SECRET|PASSKEY)\s*=\s*["']?(?!<|fake|\$)[A-Za-z0-9+/]{20,}/],
  ['bearer token literal', /Bearer\s+(?!\$|\[REDACTED\]|abc|fake|eyJhbGciOi\.xyz)[A-Za-z0-9._\-]{24,}/],
  ['basic auth literal', /Basic\s+(?!\$|\[REDACTED\]|Zm9vOmJhcg==|abc)[A-Za-z0-9+/=]{24,}/],
  ['64-hex passkey-shaped string', /\b[a-f0-9]{64}\b/],
  ['Anthropic API key', ANTHROPIC_KEY_RE],
];

describe('secret scan', () => {
  it('scans tracked source plus logs and evidence', () => {
    expect(files).toContain('app/checkout/actions.ts');
    // The public repo ships without logs/ and evidence/; scan them whenever they exist.
    if (existsSync(join(ROOT, 'logs'))) expect(files.some((f) => f.startsWith('logs/'))).toBe(true);
  });
  it('never opens an env file: .env is not in scope (untracked, gitignored, filtered)', () => {
    expect(files.filter(isEnvFile)).toEqual([]);
    expect(files).not.toContain('.env');
    expect(isEnvFile('.env')).toBe(true);
    expect(isEnvFile('.env.local')).toBe(true);
    expect(isEnvFile('.env.example')).toBe(false);
    expect(tracked).not.toContain('.env');
    expect(untracked).not.toContain('.env');
  });
  it('.env is gitignored', () => {
    if (inGitRepo) {
      const r = execFileSync('git', ['check-ignore', '-q', '--no-index', '.env'], { cwd: ROOT, stdio: 'ignore' });
      expect(r).toBeDefined();
    } else {
      // Tarball extract: no .git, so check the shipped .gitignore lists env files.
      expect(readFileSync(join(ROOT, '.gitignore'), 'utf8')).toMatch(/^\.env\*?$/m);
    }
  });
  it('the Anthropic key pattern catches a key-shaped value and ignores prose', () => {
    expect(ANTHROPIC_KEY_RE.test(`${ANTHROPIC_PREFIX}api03-${'x'.repeat(30)}`)).toBe(true);
    expect(ANTHROPIC_KEY_RE.test(`${ANTHROPIC_PREFIX} style values`)).toBe(false);
  });
  it.each(PATTERNS)('no %s in tracked files, logs or evidence', (_name, re) => {
    // File names only on a hit, never the matched value.
    const hits = files.filter((f) => re.test(read(f)));
    expect(hits).toEqual([]);
  });
  it('fake env values used in tests never appear in logs/ or evidence/', () => {
    const FAKE_VALUES = ['fake_consumer_key_AAAA', 'fake_consumer_secret_BBBB', 'fake_passkey_CCCC', 'FAKE_SECRET_VALUE_123', 'FAKE_PASSKEY_ZZZ', 'FAKE_ANTHROPIC_KEY_DO_NOT_USE'];
    const out = files.filter((f) => /^(logs|evidence)\//.test(f));
    const hits = out.filter((f) => FAKE_VALUES.some((v) => read(f).includes(v)));
    expect(hits).toEqual([]);
  });
  it('.env.example has placeholders only, ANTHROPIC_API_KEY blank, DUKA_ALLOW_LIVE commented out', () => {
    const t = read('.env.example');
    for (const line of t.split('\n')) {
      const m = line.match(/^#?\s*DARAJA_(CONSUMER_KEY|CONSUMER_SECRET|PASSKEY|SHORTCODE)=(.*)$/);
      if (m) expect(m[2]).toMatch(/^<.*>$|^$/);
    }
    expect(t).toMatch(/^ANTHROPIC_API_KEY=$/m);
    expect(t).not.toMatch(/^DUKA_ALLOW_LIVE=/m);
  });
});
