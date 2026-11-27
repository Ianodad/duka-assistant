/**
 * The one A2UI MessageProcessor per page session (module level), shared by the
 * chat panel (which feeds validated batches into it) and the main-area canvas
 * (which renders its surfaces, AC-L23). Surfaces survive panel remounts and
 * page navigations. Component actions are re-checked against the allowlist
 * before they reach the panel's dispatcher.
 */
import type { ActionPayload } from '@a2ui/web_core';
import { parseAction } from '@/lib/a2ui/actions';
import { createStrictProcessor } from '@/lib/a2ui/catalog-api';
import { dukaReactCatalog } from '@/lib/a2ui/catalog-react';
import { logRejection } from '@/lib/a2ui/validate';
import { assistantStore } from '@/lib/assistant/client-store';

let processor: ReturnType<typeof createStrictProcessor> | null = null;

export function getProcessor() {
  processor ??= createStrictProcessor(dukaReactCatalog, (a: ActionPayload) => {
    // Agent-wired action from a rendered component: re-check against the allowlist.
    const parsed = parseAction(a.name, a.context ?? {});
    if (!parsed.ok) {
      logRejection('component action', [{ code: parsed.code, path: 'action' }]);
      return;
    }
    assistantStore.dispatch(parsed.call);
  });
  return processor;
}
