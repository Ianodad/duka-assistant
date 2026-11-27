/** AC-W2-14: the app always uses the mock adapter; Daraja sandbox is PARKED. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _resetAdapterForTests, getAdapter, PARKED_SANDBOX_MESSAGE } from '@/lib/daraja';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  _resetAdapterForTests();
});

describe('AC-W2-14 mock only', () => {
  it('default: mock adapter', () => {
    _resetAdapterForTests();
    expect(getAdapter().mode).toBe('mock');
  });

  it('DUKA_DARAJA_MODE=sandbox is ignored with one clear log line, still mock, no env file read', () => {
    _resetAdapterForTests();
    vi.stubEnv('DUKA_DARAJA_MODE', 'sandbox');
    vi.stubEnv('DUKA_DARAJA_ENV_FILE', '/nonexistent/should-not-be-read.env');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getAdapter().mode).toBe('mock');
    _resetAdapterForTests();
    getAdapter();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('PARKED'));
    expect(PARKED_SANDBOX_MESSAGE).toMatch(/ignored, using the mock adapter/);
  });

  it('the app entry no longer imports the sandbox adapter or env loader', () => {
    const src = readFileSync(join(__dirname, '..', 'lib/daraja/index.ts'), 'utf8');
    expect(src).not.toMatch(/from '@\/lib\/daraja\/(sandbox|env)'/);
    expect(src).not.toMatch(/createSandboxAdapter|loadSandboxEnv/);
  });
});
