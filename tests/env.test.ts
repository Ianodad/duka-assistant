import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ENV_FILE, EnvError, loadSandboxEnv, resolveEnvPath, validateEnv } from '@/lib/daraja/env';
import { darajaMode } from '@/lib/daraja/mode';

const dir = mkdtempSync(join(tmpdir(), 'duka-env-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

const FAKE = {
  DARAJA_ENV: 'sandbox',
  DARAJA_CONSUMER_KEY: 'fake_consumer_key_AAAA',
  DARAJA_CONSUMER_SECRET: 'fake_consumer_secret_BBBB',
  DARAJA_SHORTCODE: '174379',
  DARAJA_PASSKEY: 'fake_passkey_CCCC',
};
function write(name: string, vars: Record<string, string>) {
  const p = join(dir, name);
  writeFileSync(p, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n'));
  return p;
}

describe('env loader', () => {
  it('default path is the Duka secrets file (resolved, not read)', () => {
    vi.stubEnv('DUKA_DARAJA_ENV_FILE', undefined as unknown as string);
    delete process.env.DUKA_DARAJA_ENV_FILE;
    expect(resolveEnvPath()).toBe(DEFAULT_ENV_FILE);
    expect(DEFAULT_ENV_FILE).toBe(join(homedir(), '.secrets', 'duka-daraja-sandbox.env'));
  });
  it('an empty DUKA_DARAJA_ENV_FILE falls back to the default path', () => {
    vi.stubEnv('DUKA_DARAJA_ENV_FILE', '');
    expect(resolveEnvPath()).toBe(DEFAULT_ENV_FILE);
  });
  it('DUKA_DARAJA_ENV_FILE overrides the path', () => {
    const p = write('ok.env', FAKE);
    vi.stubEnv('DUKA_DARAJA_ENV_FILE', p);
    expect(resolveEnvPath()).toBe(p);
    const env = loadSandboxEnv();
    expect(env.shortcode).toBe('174379');
    expect(env.baseUrl).toBe('https://sandbox.safaricom.co.ke');
  });
  it('refuses the Enroll env file without touching the filesystem', () => {
    // The basename check runs before any fs call, so a path that does not exist still gets the refusal (not "not found").
    expect(() => loadSandboxEnv('/nonexistent-duka-test/enroll-daraja-sandbox.env')).toThrow(/Refusing to read enroll-daraja-sandbox.env/);
    vi.stubEnv('DUKA_DARAJA_ENV_FILE', '/nonexistent-duka-test/enroll-daraja-sandbox.env');
    expect(() => loadSandboxEnv()).toThrow(EnvError);
  });
  it('refuses a symlink that points at an Enroll-named file', () => {
    const target = write('enroll-daraja-sandbox.env', FAKE);
    const link = join(dir, 'innocent.env');
    symlinkSync(target, link);
    expect(() => loadSandboxEnv(link)).toThrow(/Refusing/);
  });
  it('missing file gives a clear error', () => {
    expect(() => loadSandboxEnv(join(dir, 'nope.env'))).toThrow(/env file not found/);
  });
  it('missing vars are named, values never shown', () => {
    const p = write('partial.env', { DARAJA_ENV: 'sandbox', DARAJA_CONSUMER_KEY: 'fake_consumer_key_AAAA' });
    try {
      loadSandboxEnv(p);
      expect.unreachable();
    } catch (e) {
      const m = (e as Error).message;
      expect(m).toContain('DARAJA_CONSUMER_SECRET');
      expect(m).toContain('DARAJA_SHORTCODE');
      expect(m).toContain('DARAJA_PASSKEY');
      expect(m).not.toContain('fake_consumer_key_AAAA');
    }
  });
  it('refuses non-sandbox DARAJA_ENV and non-sandbox base URL', () => {
    expect(() => validateEnv({ ...FAKE, DARAJA_ENV: 'production' })).toThrow(/must be "sandbox"/);
    expect(() => validateEnv({ ...FAKE, DARAJA_BASE_URL: 'https://api.safaricom.co.ke' })).toThrow(/sandbox.safaricom.co.ke/);
    expect(validateEnv({ ...FAKE, DARAJA_BASE_URL: 'https://sandbox.safaricom.co.ke/' }).env).toBe('sandbox');
  });
  it('callback URL must be https when set', () => {
    expect(() => validateEnv({ ...FAKE, DARAJA_CALLBACK_URL: 'http://x.test/cb' })).toThrow(/https/);
    expect(validateEnv({ ...FAKE, DARAJA_CALLBACK_URL: 'https://x.test/cb' }).callbackUrl).toBe('https://x.test/cb');
  });
});

describe('mode', () => {
  it('defaults to mock with no env set', () => {
    expect(darajaMode(undefined)).toBe('mock');
    expect(darajaMode('')).toBe('mock');
    expect(darajaMode('mock')).toBe('mock');
    expect(darajaMode('sandbox')).toBe('sandbox');
    expect(() => darajaMode('production')).toThrow();
  });
});
