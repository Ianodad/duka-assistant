/**
 * The panel's gate, as plain functions so unit tests run the exact code the
 * panel runs. A server response (or a raw batch from the mock test hook) is
 * turned into a turn outcome: trusted reply text plus surface ids, or
 * "rejected" (the panel then shows the fallback card).
 */
import type { MessageProcessor } from '@a2ui/web_core';
import { ReplySchema, replyText } from './trusted-text';
import { logRejection, validateA2ui, type A2uiMessage } from './validate';
import { A2UI_VERSION } from './catalog-api';
import { slotNotesFor, type SlotNote } from '@/lib/assistant/slot-notes';
import { parseCanvasMeta, type CanvasMeta } from '@/lib/assistant/canvas';

export type TurnOutcome = { rejected: boolean; text: string; surfaceIds: string[]; /** Earlier cards this turn replaced in place (AC-L13). */ replaced: string[]; /** One trusted key per replaced id (AC-L19). */ slotNotes: SlotNote[]; /** Trusted canvas title and pointer keys (AC-L24/L25), only with accepted cards. */ canvas?: CanvasMeta };

const SURFACE_ID = /^[a-z][a-z0-9-]{0,47}$/;

// Any catalog type works here; the gate feeds messages, reads surfaces and prunes components of a surface it updates in place.
type Processor = Pick<MessageProcessor<never>, 'processMessagesWithErrors'> & {
  getSurface(id: string): { componentsModel: { keys: Iterable<string>; removeComponent(id: string): void }; dataModel: { get(path: string): unknown } } | undefined;
};

/** Every surface id a message touches (createSurface, updateComponents, updateDataModel, deleteSurface). */
function touchedId(m: A2uiMessage): string {
  if ('createSurface' in m) return m.createSurface.surfaceId;
  if ('updateComponents' in m) return m.updateComponents.surfaceId;
  if ('updateDataModel' in m) return m.updateDataModel.surfaceId;
  return m.deleteSurface.surfaceId;
}

/**
 * Validate, preflight the whole batch, then process. Returns the created surface ids, or null when refused.
 *
 * replace: earlier surface ids the server says this batch updates. Only ids the batch itself re-creates
 * are honoured.
 *
 * Codex live review 9 (atomic gate): the library applies messages one by one, so a refused message does
 * not stop later ones. Every check therefore runs on the WHOLE batch before the first processor call:
 * - validateA2ui runs the batch on a fresh strict processor (schemas, graph, duplicate creates), so the
 *   batch is valid on its own as a fresh render;
 * - every surface id the batch touches must be new to this processor, or an existing surface the server
 *   listed in replace (and the batch re-creates). Any collision or unlisted existing surface refuses the
 *   batch with zero mutation;
 * - a listed surface may not be deleted by the same batch.
 *
 * Codex live review 9 (in place): every honoured replace is an in-place update of the existing surface
 * model, never delete and re-create. Its createSurface is dropped, components the new render no longer
 * has are removed (the strict graph check would see them as orphans), the data model is reset when the
 * batch sends none, and updateComponents is applied. The end state equals a fresh create, but
 * A2uiSurface keeps its surface object and React keeps every surviving component node (keyed by id).
 */
export function gateBatch(processor: Processor, raw: unknown, where: string, replace: string[] = []): { surfaceIds: string[]; replaced: string[] } | null {
  const v = validateA2ui(raw);
  if (!v.ok) {
    logRejection(where, v.diagnostics);
    return null;
  }
  const created = new Set(v.messages.flatMap((m) => ('createSurface' in m ? [m.createSurface.surfaceId] : [])));
  const replaced = [...new Set(replace)].filter((id) => SURFACE_ID.test(id) && created.has(id));
  // Listed ids that exist here are updated in place; a listed id with no surface (say after a reload) is a plain create.
  const inPlace = replaced.filter((id) => processor.getSurface(id) !== undefined);
  const listed = new Set(inPlace);
  const touched = new Set(v.messages.map(touchedId));
  for (const id of touched) {
    if (processor.getSurface(id) !== undefined && !listed.has(id)) {
      logRejection(where, [{ code: 'SURFACE_COLLISION', path: 'messages' }]);
      return null;
    }
  }
  if (v.messages.some((m) => 'deleteSurface' in m && listed.has(m.deleteSurface.surfaceId))) {
    logRejection(where, [{ code: 'SURFACE_COLLISION', path: 'messages' }]);
    return null;
  }
  // Preflight passed: from here on the batch only touches surfaces it creates or the server listed.
  for (const id of inPlace) {
    const old = processor.getSurface(id)!;
    const next = new Set(v.messages.flatMap((m) => ('updateComponents' in m && m.updateComponents.surfaceId === id ? m.updateComponents.components.map((c) => c.id) : [])));
    for (const cid of [...old.componentsModel.keys]) if (!next.has(cid)) old.componentsModel.removeComponent(cid);
  }
  const reset = inPlace
    .filter((id) => !v.messages.some((m) => 'updateDataModel' in m && m.updateDataModel.surfaceId === id) && JSON.stringify(processor.getSurface(id)!.dataModel.get('/') ?? {}) !== '{}')
    .map((surfaceId) => ({ version: A2UI_VERSION, updateDataModel: { surfaceId, path: '/', value: {} } }));
  const toApply = [...reset, ...v.messages.filter((m) => !('createSurface' in m && listed.has(m.createSurface.surfaceId)))];
  const errors = processor.processMessagesWithErrors(toApply as never);
  if (errors.length) {
    // Not reachable after the fresh-processor dry run and the preflight above; fail closed if it ever is:
    // surfaces this batch created are removed so a half-built card never shows.
    const fresh = [...created].filter((id) => !listed.has(id));
    if (fresh.length) processor.processMessagesWithErrors(fresh.map((surfaceId) => ({ version: A2UI_VERSION, deleteSurface: { surfaceId } })) as never);
    logRejection(where, errors.map((_, k) => ({ code: 'LIBRARY_REJECTED' as const, path: `library[${k}]` })));
    return null;
  }
  return { surfaceIds: [...created], replaced };
}

/** A server response: reply key and messages both pass their gates, or the turn is rejected. */
export function gateResponse(processor: Processor, res: { reply?: unknown; messages?: unknown; rejected?: boolean; replaced?: unknown; slotNotes?: unknown; canvas?: unknown }): TurnOutcome {
  const reply = ReplySchema.safeParse(res.reply);
  if (!reply.success) logRejection('server reply', [{ code: 'BAD_REPLY', path: 'reply' }]);
  const replace = Array.isArray(res.replaced) ? res.replaced.filter((x): x is string => typeof x === 'string').slice(0, 4) : [];
  const applied = res.rejected || !reply.success ? null : gateBatch(processor, res.messages, 'server reply', replace);
  if (!applied) return { rejected: true, text: replyText({ key: 'could_not_show' }), surfaceIds: [], replaced: [], slotNotes: [] };
  // Only ids the gate honoured get a note; a missing or unknown key becomes the generic `replaced` copy.
  // Canvas copy is re-checked here: allowlisted keys, bounded integers and catalog categories only (AC-L24/L25).
  const canvas = applied.surfaceIds.length ? parseCanvasMeta(res.canvas) : undefined;
  return { rejected: false, text: replyText(reply.data!), surfaceIds: applied.surfaceIds, replaced: applied.replaced, slotNotes: slotNotesFor(applied.replaced, res.slotNotes), ...(canvas ? { canvas } : {}) };
}

/** Mock-mode test hook: a raw batch with no reply bubble. */
export function gateInjected(processor: Processor, raw: unknown): TurnOutcome & { codes: string[] } {
  const v = validateA2ui(raw);
  const applied = v.ok ? gateBatch(processor, raw, 'test inject') : (logRejection('test inject', v.diagnostics), null);
  return { rejected: !applied, text: '', surfaceIds: applied?.surfaceIds ?? [], replaced: [], slotNotes: [], codes: v.ok ? [] : v.diagnostics.map((d) => d.code) };
}
