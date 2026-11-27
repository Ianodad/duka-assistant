/**
 * SPEC-LIVE AC-L32: one render retry. Mock clients, fixtures and temp ledger dirs only, zero network.
 * The retry has its own flag, sends a fixed codes-only error text, never exceeds CAPS.maxTurns requests
 * (every one through the spend guard), and stays inside the timeout.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/assistant/route';
import { CAPS } from '@/lib/assistant/claude/config';
import type { CreateParams, PlannerClient } from '@/lib/assistant/claude/client';
import { mapRender, RENDER_RETRY_TEXT, renderRetryText, runToolLoop } from '@/lib/assistant/claude/loop';
import { createMockClient, FIXTURE_DIR, scenarioFor } from '@/lib/assistant/claude/mock-client';
import { planWithClaude } from '@/lib/assistant/claude/planner';
import { readLedger, withSpendGuard } from '@/lib/assistant/claude/spend';
import { addItem, clearCart, getItems } from '@/lib/shop/cart';
import { jreq } from './route-helpers';
import { SID_A } from './helpers';

const MODEL = 'claude-sonnet-5-5';
const MOCK_ENV = { DUKA_PLANNER: 'claude', DUKA_PLANNER_CLIENT: 'mock', ANTHROPIC_API_KEY: '' };

type Block = { type: 'tool_use'; id: string; name: string; input: unknown } | { type: 'text'; text: string };
const msg = (content: Block[]): Anthropic.Message =>
  ({ id: 'msg_x', type: 'message', role: 'assistant', model: MODEL, content, stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 400, output_tokens: 50 } }) as unknown as Anthropic.Message;
const use = (id: string, name: string, input: unknown): Block => ({ type: 'tool_use', id, name, input });
const text = (t: string): Block => ({ type: 'text', text: t });
const BAD = (id: string) => msg([use(id, 'render_ui', { reply: { key: 'search_found' }, components: [{ component: 'ProductGrid', productIds: ['zz-nope-id'] }] })]);
const EMPTY = msg([use('toolu_empty', 'render_ui', { reply: { key: 'search_found' }, components: [] })]);
const PLAIN = msg([text('here are some teas')]);
const DATA = (id: string) => msg([use(id, 'list_products', {})]);

/** A scripted client: response N for request N (the last repeats). Records every request. */
function scripted(responses: Anthropic.Message[]) {
  const reqs: CreateParams[] = [];
  const client: PlannerClient = {
    kind: 'mock',
    async create(params) {
      reqs.push(structuredClone(params));
      return responses[Math.min(reqs.length, responses.length) - 1];
    },
  };
  return { client, reqs };
}

const fixtureInput = (name: string) => (JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as { content: Array<{ input: unknown }> }).content[0].input;
const lastUser = (p: CreateParams) => p.messages[p.messages.length - 1] as unknown as { role: string; content: Array<Record<string, unknown>> };

beforeEach(() => clearCart(SID_A));
afterEach(() => vi.restoreAllMocks());

describe('AC-L32 retry through the mock client', () => {
  it('retries exactly once: 3 requests, rendered, renderRetried true, fixed codes-only error text', async () => {
    const reqs: CreateParams[] = [];
    const client = createMockClient('trigger render retry', { onRequest: (p) => reqs.push(structuredClone(p)) })!;
    const r = await runToolLoop({ client, text: 'trigger render retry', sid: SID_A, turn: 1, model: MODEL });
    expect(r.status).toBe('rendered');
    expect(r.turns).toBe(3);
    expect(r.renderRetried).toBe(true);
    expect(reqs).toHaveLength(3);

    const codes = (() => {
      const m = mapRender(fixtureInput('render-retry.2.json'), 1, { cartEmpty: true, cartIds: [] });
      return m.ok ? [] : m.codes;
    })();
    expect(codes.length).toBeGreaterThan(0);
    const u = lastUser(reqs[2]);
    expect(u.role).toBe('user');
    const err = u.content.find((b) => b.type === 'tool_result' && b.tool_use_id === 'toolu_02BadRenderRetry') as { content: string; is_error: boolean };
    expect(err.is_error).toBe(true);
    expect(err.content).toBe(RENDER_RETRY_TEXT(codes));
    expect(u.content).toHaveLength(1); // the search_products call was answered a turn earlier; this user turn holds only the render_ui error
    // Nothing the model wrote in the rejected render is echoed in anything WE wrote (the user turn). The assistant turn
    // replays the model's own tool_use block, which the API requires so the tool_result can pair with it.
    expect(JSON.stringify(u)).not.toContain('zz-retry-sentinel-id');
  });

  it('does not retry a second time: render-retry-twice is rejected hostile_output after exactly 2 requests', async () => {
    const reqs: CreateParams[] = [];
    const client = createMockClient('trigger render retry twice', { onRequest: (p) => reqs.push(structuredClone(p)) })!;
    const r = await runToolLoop({ client, text: 'trigger render retry twice', sid: SID_A, turn: 1, model: MODEL });
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected') expect(r.reason).toBe('hostile_output');
    expect(r.turns).toBe(2);
    expect(r.renderRetried).toBe(true);
    expect(reqs).toHaveLength(2);
  });

  it('planner diag shows retried=1 on a retry that renders, and codes only on a rejection', async () => {
    const lines: string[] = [];
    const a = await planWithClaude('trigger render retry', SID_A, 1, { env: MOCK_ENV, log: (l) => lines.push(l) });
    expect(a.source).toBe('claude');
    expect(a.diag).toMatch(/outcome=rendered turns=3 tools=search_products,render_ui,render_ui retried=1/);
    const b = await planWithClaude('trigger render retry twice', SID_A, 2, { env: MOCK_ENV, log: (l) => lines.push(l) });
    expect(b.source).toBe('claude-rejected');
    expect(b.diag).toMatch(/reason=hostile_output codes=[A-Z_,]+ turns=2 tools=render_ui,render_ui retried=1/);
    expect(b.diag).not.toContain('zz-twice-sentinel-id');
  });
});

describe('AC-L32 request bound and spend guard', () => {
  let env: Record<string, string | undefined>;
  beforeEach(() => {
    env = { DUKA_SPEND_DIR: mkdtempSync(join(tmpdir(), 'duka-retry-')), ANTHROPIC_API_KEY: 'placeholder-retry-test-value' };
  });
  const run = async (responses: Anthropic.Message[]) => {
    const { client, reqs } = scripted(responses);
    const guarded = withSpendGuard(client, env, () => {});
    const r = await runToolLoop({ client: guarded, text: 'x', sid: SID_A, turn: 1, model: MODEL });
    return { r, reqs, calls: readLedger(env).calls };
  };

  it('plain text, empty render, bad render, bad render never exceeds CAPS.maxTurns; guard calls equal requests', async () => {
    const { r, reqs, calls } = await run([PLAIN, EMPTY, BAD('toolu_b1'), BAD('toolu_b2')]);
    expect(reqs.length).toBeLessThanOrEqual(CAPS.maxTurns);
    expect(calls).toBe(reqs.length);
    expect(['rejected', 'failed']).toContain(r.status);
    expect(r.status).toBe('failed'); // the shared nudge flag is spent on the plain text, so the empty render fails (2 requests)
    expect(reqs).toHaveLength(2);
  });

  it('plain text then two bad renders: nudge and retry both fire (3 requests), then rejected', async () => {
    const { r, reqs, calls } = await run([PLAIN, BAD('toolu_b1'), BAD('toolu_b2')]);
    expect(r.status).toBe('rejected');
    expect(r.nudged && r.renderRetried).toBe(true);
    expect(reqs).toHaveLength(3);
    expect(calls).toBe(3);
  });

  it('a data tool, a nudge, then two bad renders: exactly CAPS.maxTurns requests, then rejected', async () => {
    const { r, reqs, calls } = await run([DATA('toolu_d1'), PLAIN, BAD('toolu_b1'), BAD('toolu_b2'), BAD('toolu_b3')]);
    expect(r.status).toBe('rejected');
    expect(reqs).toHaveLength(CAPS.maxTurns);
    expect(calls).toBe(CAPS.maxTurns);
    expect(r.turns).toBe(CAPS.maxTurns);
  });

  it('at the turn cap the retry is skipped: three data turns then a bad render is rejected on request 4', async () => {
    const { r, reqs, calls } = await run([DATA('toolu_d1'), DATA('toolu_d2'), DATA('toolu_d3'), BAD('toolu_b1'), BAD('toolu_b2')]);
    expect(r.status).toBe('rejected');
    expect(r.renderRetried).toBe(false);
    expect(reqs).toHaveLength(CAPS.maxTurns);
    expect(calls).toBe(CAPS.maxTurns);
  });

  it('a client that always answers a bad render stops at 2 requests', async () => {
    const { r, reqs, calls } = await run([BAD('toolu_b1')]);
    expect(r.status).toBe('rejected');
    expect(reqs).toHaveLength(2);
    expect(calls).toBe(2);
  });
});

describe('AC-L32 timeout still applies during the retry', () => {
  it('a retry request that hangs until abort ends failed/timeout', async () => {
    let n = 0;
    const client: PlannerClient = {
      kind: 'mock',
      create(_p, opts) {
        n++;
        if (n === 1) return Promise.resolve(BAD('toolu_b1'));
        return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted'))));
      },
    };
    const r = await runToolLoop({ client, text: 'x', sid: SID_A, turn: 1, model: MODEL, timeoutMs: 50 });
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.reason).toBe('timeout');
    expect(r.renderRetried).toBe(true);
    expect(n).toBe(2);
  });
});

describe('renderRetryText', () => {
  it('keeps only code-shaped strings, at most 10', () => {
    const t = renderRetryText(['BAD_PROPS', '<script>', 'x y', 'lower', 'KES 1', 'A'.repeat(50)]);
    expect(t).toContain('(codes: BAD_PROPS)');
    expect(t).not.toMatch(/script|lower|KES/);
    const many = renderRetryText(Array.from({ length: 15 }, () => 'CODE'));
    expect((many.match(/CODE/g) ?? []).length).toBe(10);
    expect(renderRetryText([])).toContain('(codes: none)');
    expect(t).not.toContain(String.fromCharCode(0x2014));
  });
});

describe('AC-L32 test-only scenarios are gated', () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each(['trigger render retry', 'trigger render retry twice'])('%s exists in the test process only', (phrase) => {
    expect(scenarioFor(phrase)).toBeDefined();
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'production');
    expect(scenarioFor(phrase)).toBeUndefined();
    expect(scenarioFor('anything under 100 bob')).toBe('budget-100'); // a real demo prompt, never gated
  });
});

describe('"Anything under 100 bob?" end to end through the assistant route (mock client)', () => {
  it('renders the four cheap products with no heading prop, canvas budget 100, 2 requests and no retry', async () => {
    vi.stubEnv('DUKA_PLANNER', 'claude');
    vi.stubEnv('DUKA_PLANNER_CLIENT', 'mock');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const res = await POST(jreq('/api/assistant', { text: 'Anything under 100 bob?', turn: 1 }, { sid: SID_A }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reply: { key: string }; messages: Array<{ updateComponents?: { components: Array<Record<string, unknown>> } }>; rejected?: boolean; canvas?: { title: unknown } };
    expect(body.rejected).toBeFalsy();
    expect(body.reply).toEqual({ key: 'price_filtered' });
    expect(body.canvas?.title).toEqual({ key: 'results_budget', budgetKES: 100 }); // the server budget (100) reached the canvas title
    const comps = body.messages.flatMap((m) => m.updateComponents?.components ?? []);
    const grid = comps.find((c) => c.id === 'root' && c.component === 'ProductGrid')!;
    expect(grid).toBeTruthy();
    expect(Object.hasOwn(grid, 'heading')).toBe(false);
    expect(comps.filter((c) => c.component === 'ProductCard').map((c) => c.productId)).toEqual(['sukuma-bunch', 'royco-200g', 'brookside-milk-500ml', 'tropical-heat-crisps']);
    const diag = info.mock.calls.map((c) => String(c[0])).find((l) => l.includes('[claude-planner]'))!;
    expect(diag).toMatch(/outcome=rendered turns=2 /);
    expect(diag).not.toContain('retried=1');
  });
});

describe('AC-L32 M1: no retry after a cart write (a repeated write would apply twice)', () => {
  it('loop level: render-retry-cart is rejected hostile_output after exactly 1 request, no retry', async () => {
    const reqs: CreateParams[] = [];
    const client = createMockClient('trigger render retry cart', { onRequest: (p) => reqs.push(structuredClone(p)) })!;
    const r = await runToolLoop({ client, text: 'trigger render retry cart', sid: SID_A, turn: 1, model: MODEL });
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected') expect(r.reason).toBe('hostile_output');
    expect(r.turns).toBe(1);
    expect(r.renderRetried).toBe(false);
    expect(reqs).toHaveLength(1);
  });

  it('route level: the reply is could_not_show and the cart is rolled back to what it was (not qty 2)', async () => {
    vi.stubEnv('DUKA_PLANNER', 'claude');
    vi.stubEnv('DUKA_PLANNER_CLIENT', 'mock');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    for (const before of [0, 1]) {
      clearCart(SID_A);
      if (before) addItem(SID_A, 'unga-2kg', before);
      const snapshot = JSON.stringify(getItems(SID_A));
      const res = await POST(jreq('/api/assistant', { text: 'trigger render retry cart', turn: 1 }, { sid: SID_A }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { reply: { key: string }; rejected?: boolean };
      expect(body.reply).toEqual({ key: 'could_not_show' });
      expect(body.rejected).toBe(true);
      expect(JSON.stringify(getItems(SID_A))).toBe(snapshot);
      expect(getItems(SID_A).find((i) => i.productId === 'unga-2kg')?.qty ?? 0).toBe(before);
    }
    vi.unstubAllEnvs();
  });
});
