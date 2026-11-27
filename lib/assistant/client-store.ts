/**
 * Client state for the assistant: drawer open flag, the latest server
 * snapshots (cart, orders), the conversation, the main-area canvas (AC-L23:
 * the cards of the newest render) and the action dispatcher the A2UI
 * components call. Module level, so it survives page navigations.
 */
import { useSyncExternalStore } from 'react';
import type { ActionCall } from '@/lib/a2ui/actions';
import type { NoteKey } from '@/lib/assistant/notes';
import type { CanvasPointer, CanvasTitle } from '@/lib/assistant/canvas';
import { slotNotesFor, type SlotNote } from '@/lib/assistant/slot-notes';
import { EMPTY_CART, type CartSnapshot, type OrderSnapshot } from '@/lib/assistant/types';

export type Turn = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  surfaceIds: string[];
  /** True when the messages for this turn were rejected: render the fallback card. */
  rejected?: boolean;
  error?: boolean;
  /** Fixed note key from the server (lib/assistant/notes.ts). */
  note?: NoteKey;
  /** Cards of this turn that a later turn took over: one trusted slot note key per surface (AC-L13, AC-L19). */
  slotNotes?: SlotNote[];
  /** Trusted pointer key with a server count (AC-L25): the chat line that points at this turn's cards in the canvas. */
  pointer?: CanvasPointer;
};

/**
 * The canvas shows the surfaces of ONE turn, the newest render (AC-L23).
 * rev changes when a new or different render swaps the canvas (fade in); pulse changes when a true follow-up
 * (every replaced surface classified `updated`, AC-L19) updated the cards in place (subtle highlight, no swap).
 */
export type CanvasState = { turnId: string; surfaceIds: string[]; title?: CanvasTitle; rev: number; pulse: number };

type State = {
  open: boolean;
  cart: CartSnapshot;
  orders: OrderSnapshot[];
  turns: Turn[];
  busy: boolean;
  canvas: CanvasState | null;
  /** Back to shop hid the canvas; the next render shows it again (AC-L24). */
  canvasHidden: boolean;
  /** A shopper message is in flight: the canvas shows its skeleton (AC-L25). */
  loading: boolean;
};

const INITIAL: State = { open: false, cart: EMPTY_CART, orders: [], turns: [], busy: false, canvas: null, canvasHidden: false, loading: false };
let state: State = INITIAL;
const listeners = new Set<() => void>();
let dispatcher: ((call: ActionCall) => void) | null = null;

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export const assistantStore = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  setOpen: (open: boolean) => set({ open }),
  setBusy: (busy: boolean) => set({ busy }),
  setLoading: (loading: boolean) => set({ loading }),
  /** Back to shop: hide the canvas, keep the conversation and the cards (AC-L24). */
  hideCanvas: () => set({ canvasHidden: true }),
  showCanvas: () => set({ canvasHidden: false }),
  setSnapshot: (cart: CartSnapshot, orders?: OrderSnapshot[]) => set({ cart, ...(orders ? { orders } : {}) }),
  /**
   * moved: surface ids the new turn re-created (replaced in place). They leave earlier turns, and each one leaves
   * a slot note there with its trusted key from `notes` (AC-L19; a missing key shows the generic `replaced` copy).
   */
  addTurn: (t: Turn, moved: string[] = [], notes: SlotNote[] = [], title?: CanvasTitle) => {
    const keyed = new Map(slotNotesFor(moved, notes).map((n) => [n.id, n]));
    const prev = keyed.size
      ? state.turns.map((x) => {
          const gone = x.surfaceIds.filter((id) => keyed.has(id));
          if (!gone.length) return x;
          return { ...x, surfaceIds: x.surfaceIds.filter((id) => !keyed.has(id)), slotNotes: [...(x.slotNotes ?? []), ...gone.map((id) => keyed.get(id)!)] };
        })
      : state.turns;
    // AC-L23: an assistant turn with accepted cards takes over the canvas. A rejected render leaves it as it is.
    if (t.role !== 'assistant' || t.rejected || !t.surfaceIds.length) {
      set({ turns: [...prev, t] });
      return;
    }
    const cur = state.canvas;
    const notesNow = [...keyed.values()];
    // In place only for a true follow-up of the cards on the canvas now: every replaced surface was there and is `updated`.
    const inPlace = cur !== null && notesNow.length > 0 && notesNow.every((n) => n.key === 'updated' && cur.surfaceIds.includes(n.id));
    const canvas: CanvasState = {
      turnId: t.id,
      surfaceIds: [...t.surfaceIds],
      ...(title ? { title } : {}),
      rev: inPlace ? cur!.rev : (cur?.rev ?? 0) + 1,
      pulse: inPlace ? cur!.pulse + 1 : 0,
    };
    set({ turns: [...prev, t], canvas, canvasHidden: false });
  },
  /** Unit tests only: back to a fresh page session. */
  _resetForTests: () => set(INITIAL),
  setDispatcher(fn: ((call: ActionCall) => void) | null) {
    dispatcher = fn;
  },
  dispatch(call: ActionCall) {
    dispatcher?.(call);
  },
};

export function useAssistant<T>(select: (s: State) => T): T {
  return useSyncExternalStore(
    assistantStore.subscribe,
    () => select(state),
    () => select(INITIAL),
  );
}
