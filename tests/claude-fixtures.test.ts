/** AC-CP-8: tests/fixtures/claude/*.json are Messages API responses (or an API error body) in the real wire shape. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SCRIPT } from '@/lib/assistant/claude/mock-client';
import { ALL_TOOLS, RENDER_TOOL } from '@/lib/assistant/tools/definitions';

const DIR = join(__dirname, 'fixtures', 'claude');
const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
const load = (f: string) => JSON.parse(readFileSync(join(DIR, f), 'utf8'));

const TextBlock = z.object({ type: z.literal('text'), text: z.string() }).strict();
const ToolUseBlock = z.object({ type: z.literal('tool_use'), id: z.string().regex(/^toolu_[A-Za-z0-9]+$/), name: z.string().min(1), input: z.record(z.unknown()) }).strict();
const Message = z
  .object({
    id: z.string().regex(/^msg_[A-Za-z0-9]+$/),
    type: z.literal('message'),
    role: z.literal('assistant'),
    model: z.string().startsWith('claude-'),
    content: z.array(z.union([TextBlock, ToolUseBlock])),
    stop_reason: z.enum(['end_turn', 'tool_use', 'max_tokens', 'stop_sequence', 'pause_turn', 'refusal']),
    stop_sequence: z.string().nullable(),
    stop_details: z.object({ type: z.literal('refusal'), category: z.string().nullable(), explanation: z.string().nullable() }).optional(),
    usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }),
  })
  .strict();
const ApiError = z.object({ type: z.literal('error'), error: z.object({ type: z.string(), message: z.string() }), request_id: z.string().optional() }).strict();

const KNOWN_TOOLS = new Set(ALL_TOOLS.map((t) => t.name));

describe('AC-CP-8 fixtures', () => {
  it('cover the required scenarios', () => {
    for (const s of ['search-grid', 'compare', 'add-cart', 'hostile-price', 'hostile-link', 'hostile-path', 'hostile-pay', 'hostile-component', 'hostile-html', 'plain-text', 'api-error'])
      expect(files.some((f) => f.startsWith(`${s}.`)), s).toBe(true);
  });

  it.each(files.filter((f) => !/^(api-error|malformed)\./.test(f)))('%s is a Messages API response', (f) => {
    const m = Message.parse(load(f));
    if (m.stop_reason === 'tool_use') expect(m.content.some((b) => b.type === 'tool_use')).toBe(true);
    if (m.stop_reason === 'end_turn') expect(m.content.every((b) => b.type === 'text')).toBe(true);
    if (m.stop_reason === 'refusal') expect(m.stop_details?.type).toBe('refusal');
    const ids = m.content.flatMap((b) => (b.type === 'tool_use' ? [b.id] : []));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('tool_use names are our tools, except the deliberate hostile pay tool', () => {
    for (const f of files.filter((x) => !/^(api-error|malformed)\./.test(x))) {
      for (const b of load(f).content) if (b.type === 'tool_use' && !f.startsWith('hostile-pay-tool.1')) expect(KNOWN_TOOLS.has(b.name), `${f} ${b.name}`).toBe(true);
    }
  });

  it('happy-path renders use render_ui last', () => {
    for (const s of ['search-grid.2', 'compare.2', 'add-cart.3', 'checkout-handoff.2']) {
      const c = load(`${s}.json`).content;
      expect(c[c.length - 1].name).toBe(RENDER_TOOL.name);
    }
  });

  it('api-error is an API error body; malformed is deliberately not a message', () => {
    expect(ApiError.safeParse(load('api-error.1.json')).success).toBe(true);
    expect(Message.safeParse(load('malformed.1.json')).success).toBe(false);
  });

  it('every scripted scenario has a fixture (except the timeout scenario, which never answers)', () => {
    for (const s of new Set(Object.values(SCRIPT))) if (s !== 'timeout') expect(files.some((f) => f.startsWith(`${s}.1.`)), s).toBe(true);
  });
});
