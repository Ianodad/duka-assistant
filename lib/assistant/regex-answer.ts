/**
 * The regex (scripted) planner answer, as the assistant route has served it
 * since week 2: plan() then the planner's cart actions through the same
 * allowlisted handlers as panel buttons. Also the Claude planner's fallback.
 */
import 'server-only';
import { parseAction } from '@/lib/a2ui/actions';
import type { Reply } from '@/lib/a2ui/trusted-text';
import { runAction } from '@/lib/assistant/handlers';
import { cartSnapshot, orderSnapshots } from '@/lib/assistant/http';
import { plan } from '@/lib/assistant/planner';

export function regexAnswer(text: string, sid: string, turn: number): { reply: Reply; messages: unknown[] } {
  const out = plan(text, { cart: cartSnapshot(sid), latestOrderId: orderSnapshots(sid)[0]?.id }, turn);
  let reply: Reply = out.reply;
  let messages: unknown[] = out.messages;
  for (const a of out.actions) {
    const parsed = parseAction(a.name, a.payload);
    if (!parsed.ok || parsed.call.name === 'go_to_checkout') continue; // planner text never navigates; the shopper taps the handoff
    const res = runAction(sid, parsed.call, turn);
    if (res.error) {
      reply = res.reply;
      messages = [];
    }
  }
  return { reply, messages };
}
