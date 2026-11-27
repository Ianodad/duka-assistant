import type { Reply } from '@/lib/a2ui/trusted-text';
import type { NoteKey } from '@/lib/assistant/notes';
import type { SlotNote } from '@/lib/assistant/slot-notes';
import type { CanvasMeta } from '@/lib/assistant/canvas';

/** Shapes shared by the assistant routes and the panel. Cart and order data are server snapshots, never planner output. */
export type CartSnapshot = { items: Array<{ productId: string; qty: number }>; itemCount: number; subtotalKES: number };
export type OrderSnapshot = { id: string; state: 'pending' | 'paid' | 'failed' | 'cancelled'; amountKES: number; itemCount: number; /** Catalog ids from the server order lines; the card shows their catalog photos. */ productIds?: string[] };

export type AssistantResponse = {
  /** A trusted reply key (lib/a2ui/trusted-text.ts). The panel validates it and renders the words itself. */
  reply: Reply;
  /** A2UI v1.0 messages, already validated on the server. The panel validates them again. */
  messages: unknown[];
  cart: CartSnapshot;
  orders: OrderSnapshot[];
  /** Only ever '/checkout' (go_to_checkout). The panel ignores any other value. */
  navigate?: '/checkout';
  /** True when the server refused the planner output; the panel shows the fallback card. */
  rejected?: boolean;
  /** A fixed note key (lib/assistant/notes.ts), for example the spend cap pause. The panel renders trusted copy only. */
  note?: NoteKey;
  /** Surface ids of earlier cards this answer updates in place. Each is re-created in messages; the panel replaces that card. */
  replaced?: string[];
  /** One trusted slot note key per replaced id (AC-L19). The panel renders SLOT_NOTE_TEXT for it, never other text. */
  slotNotes?: SlotNote[];
  /** AC-L24/L25: trusted canvas title and chat pointer keys with server counts, for a render that has cards. The panel re-checks it. */
  canvas?: CanvasMeta;
};

export const EMPTY_CART: CartSnapshot = { items: [], itemCount: 0, subtotalKES: 0 };
