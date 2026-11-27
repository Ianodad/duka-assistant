/**
 * Server-only entry to the Daraja adapter. App code imports from here, never
 * from mock.ts or sandbox.ts directly. Only app/checkout/actions.ts may start an
 * STK push; everything else may only use queryStk (guarded by tests/guard-stk.test.ts).
 *
 * Week 2 scope change (Ian, 2026-11-24): Duka is a front-end playground and
 * Daraja is PARKED. The app always uses the mock adapter. DUKA_DARAJA_MODE=sandbox
 * is ignored with one log line. lib/daraja/sandbox.ts, env.ts and the smoke
 * script are kept unchanged but are not reachable from the app.
 */
import 'server-only';
import type { DarajaAdapter } from '@/lib/daraja/types';
import { createMockAdapter } from '@/lib/daraja/mock';

const g = globalThis as unknown as { __dukaAdapter?: DarajaAdapter; __dukaParkedLogged?: boolean };

export const PARKED_SANDBOX_MESSAGE = 'Daraja sandbox is PARKED (front-end playground): DUKA_DARAJA_MODE=sandbox is ignored, using the mock adapter.';

export function getAdapter(): DarajaAdapter {
  if (g.__dukaAdapter) return g.__dukaAdapter;
  if (process.env.DUKA_DARAJA_MODE === 'sandbox' && !g.__dukaParkedLogged) {
    g.__dukaParkedLogged = true;
    console.warn(`[duka] ${PARKED_SANDBOX_MESSAGE}`);
  }
  g.__dukaAdapter = createMockAdapter();
  return g.__dukaAdapter;
}

/** Test helper: forget the cached adapter. */
export function _resetAdapterForTests(): void {
  g.__dukaAdapter = undefined;
  g.__dukaParkedLogged = false;
}

export { darajaMode } from '@/lib/daraja/mode';
export { parseCallback, mapResultCode } from '@/lib/daraja/callback';
export type { DarajaAdapter, StkQueryResult } from '@/lib/daraja/types';
