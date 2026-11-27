/**
 * POST /api/assistant/action {name, payload, turn}: one allowlisted A2UI action.
 * Unknown or pay-like names are refused with 400. go_to_checkout only returns
 * navigate: '/checkout'; the panel then does a client navigation.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { parseAction } from '@/lib/a2ui/actions';
import { runAction } from '@/lib/assistant/handlers';
import { readJson, respond, sessionOf, turnOf } from '@/lib/assistant/http';
import { plannerMode } from '@/lib/assistant/claude/config';
import { recordTurn } from '@/lib/assistant/claude/memory';

/** Claude mode remembers button taps too, so the next message knows what is on screen (AC-L12). */
function claudeMode(): boolean {
  try {
    return plannerMode() === 'claude';
  } catch {
    return false;
  }
}

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const r = await readJson(req);
  if (!r.ok) return r.res;
  const parsed = parseAction(r.body.name, r.body.payload);
  if (!parsed.ok) return NextResponse.json({ error: 'Action refused.', code: parsed.code }, { status: 400 });
  const { sid, isNew } = sessionOf(req);
  const out = runAction(sid, parsed.call, turnOf(r.body.turn));
  if (claudeMode() && !out.error) recordTurn(sid, { action: parsed.call.name, reply: out.reply, messages: out.messages });
  return respond(sid, isNew, out, `action ${parsed.call.name}`);
}
