/** Shared setup for the shared-ledger, rate-limit and vercel-host tests: fake store env and install helpers. No network. */
import { afterEach } from 'vitest';
import { setStoreFetchForTests, setStoreTimeoutForTests } from '@/lib/assistant/claude/store';
import { createFakeUpstash, type FakeOptions } from './fake-upstash';

export const STORE_URL = 'https://fake-store.example.test';
export const STORE_TOKEN = 'FAKE_STORE_TOKEN_not_a_real_credential';
export const NS = 'tns';
export const ledgerKey = `${NS}:ledger`;

/** Env that selects the shared ledger on the fake store. */
export const sharedEnv = (extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  KV_REST_API_URL: STORE_URL,
  KV_REST_API_TOKEN: STORE_TOKEN,
  DUKA_LEDGER_NAMESPACE: NS,
  ...extra,
});

/** Creates a fake store, injects it as the only transport, and removes it after each test. */
export function installFakeStore(opts: FakeOptions = {}) {
  const fake = createFakeUpstash({ token: STORE_TOKEN, ...opts });
  setStoreFetchForTests(fake.fetch);
  return fake;
}

export function useStoreCleanup(): void {
  afterEach(() => {
    setStoreFetchForTests(null);
    setStoreTimeoutForTests(null);
  });
}

/** The ledger hash as plain numbers (missing fields are 0). */
export function ledgerOf(state: ReturnType<typeof createFakeUpstash>['state'], key = ledgerKey) {
  const h = state.hashes.get(key) ?? new Map<string, string>();
  const n = (f: string) => Number(h.get(f) ?? '0');
  return { spent: n('spent'), reserved: n('reserved'), calls: n('calls'), expired: n('expired'), raw: h };
}
