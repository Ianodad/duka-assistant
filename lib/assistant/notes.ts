/**
 * Fixed panel notes (SPEC-LIVE AC-L5). The server sends only a note KEY; the
 * panel shows this trusted copy. No numbers or words from the model, ever.
 */
export const NOTE_TEXT = {
  spend_cap: 'Live Claude is paused (spend cap reached). Using the scripted helper.',
  live_busy: 'Live Claude is busy right now. Using the scripted helper.',
  rate_limited: 'Live Claude is limited for your connection right now. Using the scripted helper.',
  live_unavailable: 'Live Claude is unavailable right now. Using the scripted helper.',
} as const;
export type NoteKey = keyof typeof NOTE_TEXT;

export function isNoteKey(v: unknown): v is NoteKey {
  return typeof v === 'string' && Object.hasOwn(NOTE_TEXT, v);
}
