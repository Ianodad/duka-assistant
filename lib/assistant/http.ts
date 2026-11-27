/** Request helpers shared by the two assistant route handlers. */
import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { ReplySchema, type Reply } from '@/lib/a2ui/trusted-text';
import { validateA2ui, logRejection } from '@/lib/a2ui/validate';
import { viewCart } from '@/lib/shop/cart';
import { ordersForSession } from '@/lib/shop/orders';
import { newSid, SID_COOKIE, SID_COOKIE_OPTIONS, sidFromCookieHeader } from '@/lib/shop/session';
import type { AssistantResponse, CartSnapshot, OrderSnapshot } from '@/lib/assistant/types';
import { isNoteKey, type NoteKey } from '@/lib/assistant/notes';
import { slotNotesFor } from '@/lib/assistant/slot-notes';
import { canvasMetaFrom } from '@/lib/assistant/canvas';

export const BODY_CAP = 4096;

/** Longest shopper text POST /api/assistant accepts (AC-L37). One place (a route file cannot export extra names). */
export const MAX_PROMPT_CHARS = 300;

export type ReadResult = { ok: true; body: Record<string, unknown> } | { ok: false; res: NextResponse };

const fail = (status: number, error: string): ReadResult => ({ ok: false, res: NextResponse.json({ error }, { status }) });

/** JSON only, same origin when the browser says where it came from, small bodies only. */
export async function readJson(req: NextRequest): Promise<ReadResult> {
  if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return fail(415, 'Send JSON.');
  const origin = req.headers.get('origin');
  if (origin) {
    const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
    let ok = false;
    try {
      ok = new URL(origin).host === host;
    } catch {}
    if (!ok) return fail(403, 'Cross-origin request refused.');
  }
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > BODY_CAP) return fail(413, 'Request too large.');
  const text = await req.text();
  if (text.length > BODY_CAP) return fail(413, 'Request too large.');
  try {
    const b = JSON.parse(text) as unknown;
    if (!b || typeof b !== 'object' || Array.isArray(b)) return fail(400, 'Bad request.');
    return { ok: true, body: b as Record<string, unknown> };
  } catch {
    return fail(400, 'Bad request.');
  }
}

export function sessionOf(req: NextRequest): { sid: string; isNew: boolean } {
  const existing = sidFromCookieHeader(req.headers.get('cookie'));
  return existing ? { sid: existing, isNew: false } : { sid: newSid(), isNew: true };
}

export function turnOf(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1_000_000 ? v : 0;
}

export function cartSnapshot(sid: string): CartSnapshot {
  const v = viewCart(sid);
  return { items: v.lines.map((l) => ({ productId: l.product.id, qty: l.qty })), itemCount: v.itemCount, subtotalKES: v.subtotalKES };
}

export function orderSnapshots(sid: string): OrderSnapshot[] {
  return ordersForSession(sid).map((o) => ({ id: o.id, state: o.state, amountKES: o.amountKES, itemCount: o.lines.reduce((n, l) => n + l.qty, 0), productIds: o.lines.map((l) => l.productId) }));
}

/** Validates outgoing messages one more time, then answers with fresh server snapshots. */
export function respond(sid: string, isNew: boolean, out: { reply: Reply; messages: unknown[]; navigate?: '/checkout'; rejected?: boolean; note?: NoteKey; replaced?: string[]; slotNotes?: unknown; budgetKES?: number }, where: string): NextResponse {
  const v = validateA2ui(out.messages);
  if (!v.ok) logRejection(where, v.diagnostics);
  // The reply bubble goes through the same allowlist gate: a trusted key or nothing.
  const r = ReplySchema.safeParse(out.reply);
  if (!r.success) logRejection(where, [{ code: 'BAD_REPLY', path: 'reply' }]);
  const ok = v.ok && r.success;
  // A planner that refused its own output (hostile model render, plain text) keeps its trusted reply and shows the fallback card.
  const refused = ok && out.rejected === true;
  // Only ids this batch re-creates may replace an earlier card (AC-L13).
  const created = ok && !refused ? new Set(v.messages.flatMap((m) => ('createSurface' in m ? [m.createSurface.surfaceId] : []))) : new Set<string>();
  const replaced = [...new Set(out.replaced ?? [])].filter((id) => created.has(id));
  // AC-L24/L25: canvas title and pointer from the validated messages and server data (the grid budget) only.
  const canvas = ok && v.ok && !refused ? canvasMetaFrom(v.messages, { budgetKES: out.budgetKES }) : undefined;
  const body: AssistantResponse = {
    reply: ok ? r.data! : { key: 'could_not_show' },
    messages: ok && v.ok && !refused ? v.messages : [],
    rejected: ok && !refused ? undefined : true,
    cart: cartSnapshot(sid),
    orders: orderSnapshots(sid),
    ...(out.navigate === '/checkout' ? { navigate: '/checkout' as const } : {}),
    // Only allowlisted note keys leave the server.
    ...(isNoteKey(out.note) ? { note: out.note } : {}),
    ...(replaced.length ? { replaced, slotNotes: slotNotesFor(replaced, out.slotNotes) } : {}),
    ...(canvas ? { canvas } : {}),
  };
  const res = NextResponse.json(body);
  if (isNew) res.cookies.set(SID_COOKIE, sid, SID_COOKIE_OPTIONS);
  return res;
}
