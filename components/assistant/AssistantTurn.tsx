/**
 * One assistant turn as the chat renders it (AC-L25: conversation only): note,
 * reply bubble, the fallback card when the turn was rejected, then a pointer
 * line to the cards in the main-area canvas. No A2UI card renders here.
 *
 * Pointer line, all fixed trusted copy:
 * - the turn whose cards are on the canvas now: its server pointer key with the server count;
 * - a turn whose card a later turn took over in place: the AC-L19 slot key, one line per surface;
 * - a turn whose cards a later, unrelated render replaced: the generic `replaced` slot copy.
 */
import { AlertTriangle, ArrowUpLeft, PauseCircle, PanelTop } from 'lucide-react';
import { isNoteKey, NOTE_TEXT, type NoteKey } from '@/lib/assistant/notes';
import { FallbackCard } from '@/components/assistant/views';
import { isSlotNoteKey, SLOT_NOTE_TEXT, type SlotNote } from '@/lib/assistant/slot-notes';
import { canvasPointerText, type CanvasPointer } from '@/lib/assistant/canvas';
import { cn } from '@/lib/utils';

export type AssistantTurnData = { id: string; text: string; surfaceIds: string[]; rejected?: boolean; error?: boolean; note?: NoteKey; slotNotes?: SlotNote[]; pointer?: CanvasPointer };

const pointerCls =
  'pressable flex w-fit max-w-[90%] cursor-pointer items-center gap-1.5 rounded-xl border px-3 py-1.5 text-left text-[13px] leading-snug hover:border-board hover:text-board';

export function AssistantTurn({ turn, current = false, onPointer }: { turn: AssistantTurnData; current?: boolean; onPointer?: () => void }) {
  const notes = (turn.slotNotes ?? []).filter((n) => isSlotNoteKey(n.key));
  // Cards still owned by this turn but no longer on the canvas: a later render replaced them.
  const superseded = !turn.rejected && !current && turn.surfaceIds.length > 0 && notes.length === 0;
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="turn-assistant" data-current={current || undefined}>
      {isNoteKey(turn.note) ? (
        <p data-testid="assistant-note" data-note={turn.note} role="status" className="flex max-w-[90%] items-start gap-1.5 rounded-xl border border-line bg-board-soft px-3 py-1.5 text-[13px] leading-snug text-ink">
          <PauseCircle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          {NOTE_TEXT[turn.note]}
        </p>
      ) : null}
      {turn.text ? (
        <p
          className={cn(
            'max-w-[90%] break-words rounded-2xl rounded-bl-md px-3.5 py-2 text-[15px] leading-snug',
            turn.error ? 'border border-[#f3b8b0] bg-danger-soft text-danger' : 'border border-line bg-surface text-ink',
          )}
          role={turn.error ? 'alert' : undefined}
        >
          {turn.error ? <AlertTriangle aria-hidden className="mb-0.5 mr-1 inline size-4" /> : null}
          {turn.text}
        </p>
      ) : null}
      {turn.rejected ? <FallbackCard /> : null}
      {current && !turn.rejected && turn.surfaceIds.length > 0 && turn.pointer ? (
        <button type="button" data-testid="canvas-pointer" data-pointer-key={turn.pointer.key} onClick={onPointer} className={cn(pointerCls, 'border-board/40 bg-board-soft font-semibold text-board')}>
          <PanelTop aria-hidden className="size-3.5 shrink-0" />
          {canvasPointerText(turn.pointer)}
        </button>
      ) : null}
      {/* AC-L19/L25: one marker per card a later turn took over. Only a trusted key renders, with SLOT_NOTE_TEXT copy. */}
      {notes.map((n) => (
        <button key={n.id} type="button" data-testid="card-slot-note" data-slot-note={n.key} onClick={onPointer} className={cn(pointerCls, 'border-dashed border-line text-muted')}>
          <ArrowUpLeft aria-hidden className="size-3.5 shrink-0" />
          {SLOT_NOTE_TEXT[n.key]}
        </button>
      ))}
      {superseded ? (
        <button type="button" data-testid="card-slot-note" data-slot-note="replaced" data-superseded="true" onClick={onPointer} className={cn(pointerCls, 'border-dashed border-line text-muted')}>
          <ArrowUpLeft aria-hidden className="size-3.5 shrink-0" />
          {SLOT_NOTE_TEXT.replaced}
        </button>
      ) : null}
    </div>
  );
}
