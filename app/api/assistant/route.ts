/**
 * POST /api/assistant {text, turn}: shopper text to the planner. DUKA_PLANNER
 * picks it: regex (default, the scripted planner) or claude (tool loop, live
 * only through the gate in lib/assistant/claude/config.ts, otherwise fixtures
 * or a regex fallback). Planner cart changes run through the same allowlisted
 * handlers as panel buttons. Every response is validated A2UI plus server
 * snapshots. Nothing here can pay.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { MAX_PROMPT_CHARS, readJson, respond, sessionOf, turnOf } from '@/lib/assistant/http';
import { plannerMode, type PlannerMode } from '@/lib/assistant/claude/config';
import { planWithClaude } from '@/lib/assistant/claude/planner';
import { clientIp } from '@/lib/assistant/claude/store';
import { regexAnswer } from '@/lib/assistant/regex-answer';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let mode: PlannerMode;
  try {
    mode = plannerMode();
  } catch {
    return NextResponse.json({ error: 'Planner is misconfigured. Set DUKA_PLANNER to regex or claude.' }, { status: 500 });
  }
  const r = await readJson(req);
  if (!r.ok) return r.res;
  const text = r.body.text;
  if (typeof text !== 'string' || text.length > MAX_PROMPT_CHARS) return NextResponse.json({ error: `Text must be a string of at most ${MAX_PROMPT_CHARS} characters.` }, { status: 400 });
  const { sid, isNew } = sessionOf(req);
  const turn = turnOf(r.body.turn);

  if (mode === 'claude') {
    const a = await planWithClaude(text, sid, turn, { ip: clientIp(req.headers) });
    return respond(sid, isNew, { reply: a.reply, messages: a.messages, rejected: a.rejected, note: a.note, replaced: a.replaced, slotNotes: a.slotNotes, budgetKES: a.budgetKES }, a.source === 'claude' ? 'claude-planner' : a.source);
  }
  return respond(sid, isNew, regexAnswer(text, sid, turn), 'planner');
}
