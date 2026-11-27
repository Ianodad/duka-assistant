/**
 * The panel's own render path for unit tests (AC-L23, AC-L25): a gated turn
 * goes through the real client store, the chat shows AssistantTurn (no cards)
 * and the main-area CanvasView shows the store's canvas. Only A2uiSurface is
 * stubbed (it cannot render on the server); the e2e covers it in a browser.
 */
import { createElement } from 'react';
import { AssistantTurn } from '@/components/assistant/AssistantTurn';
import { CanvasView } from '@/components/assistant/CanvasView';
import { assistantStore } from '@/lib/assistant/client-store';
import type { TurnOutcome } from '@/lib/a2ui/panel-gate';
import { html } from './a2ui-fixtures';

export const stubSurface = (sid: string) => createElement('div', { 'data-stub-surface': sid });

/** Chat markup and canvas markup for one fresh turn, separately, so tests can check where things render. */
export function panelRender(out: Pick<TurnOutcome, 'rejected' | 'text' | 'surfaceIds'> & Partial<TurnOutcome>): { chat: string; canvas: string } {
  assistantStore._resetForTests();
  assistantStore.addTurn({ id: 't', role: 'assistant', text: out.text, surfaceIds: out.surfaceIds, rejected: out.rejected, ...(out.canvas ? { pointer: out.canvas.pointer } : {}) }, out.replaced ?? [], out.slotNotes ?? [], out.canvas?.title);
  const s = assistantStore.get();
  const turn = s.turns[s.turns.length - 1];
  const chat = html(createElement(AssistantTurn, { turn, current: s.canvas?.turnId === turn.id }));
  const canvas = html(createElement(CanvasView, { canvas: s.canvas, hidden: s.canvasHidden, loading: s.loading, renderSurface: stubSurface }));
  return { chat, canvas };
}
