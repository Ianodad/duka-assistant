/**
 * Drawer subtitle (SPEC-LIVE AC-L1). The mode comes from the server
 * (modeInfo() in lib/assistant/claude/config.ts, also GET /api/assistant/mode),
 * never from the browser env. Fixed copy only.
 */
export type SubtitleMode = { planner: 'regex' | 'claude'; client: 'live' | 'mock' | 'none' };

export const SUBTITLES = {
  regex: 'Scripted helper. It never pays for you.',
  claudeLive: 'Claude assistant. It never pays for you.',
  claudeMock: 'Claude planner, test mode. It never pays for you.',
  // Claude planner chosen but no client (live not allowed or no key): every answer is the regex fallback.
  claudeOff: 'Claude is not connected, so a scripted fallback answers. It never pays for you.',
} as const;

export function subtitleFor(m: SubtitleMode): string {
  if (m.planner !== 'claude') return SUBTITLES.regex;
  if (m.client === 'live') return SUBTITLES.claudeLive;
  if (m.client === 'mock') return SUBTITLES.claudeMock;
  return SUBTITLES.claudeOff;
}
