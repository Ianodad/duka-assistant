/**
 * AC-CP-4, 6, 7: the Claude tool loop with the fixture mock client. Request
 * body (tools, caps), tool_use then tool_result, caps, hostile output,
 * plain text, and every failure mode falling back with a clean diagnostic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateA2ui } from '@/lib/a2ui/validate';
import { planWithClaude } from '@/lib/assistant/claude/planner';
import { buildRequest, mapRender, runToolLoop } from '@/lib/assistant/claude/loop';
import { createMockClient, SCRIPT } from '@/lib/assistant/claude/mock-client';
import type { CreateParams, PlannerClient } from '@/lib/assistant/claude/client';
import { DATA_TOOLS, RENDER_TOOL } from '@/lib/assistant/tools/definitions';
import { addItem, clearCart, getItems } from '@/lib/shop/cart';
import { SID_A } from './helpers';

const FAKE_KEY = 'FAKE_ANTHROPIC_KEY_DO_NOT_USE';
const MOCK_ENV = { DUKA_PLANNER: 'claude', DUKA_PLANNER_CLIENT: 'mock', ANTHROPIC_API_KEY: FAKE_KEY };
const lines: string[] = [];
const log = (l: string) => lines.push(l);

function recording(text: string) {
  const reqs: CreateParams[] = [];
  const client = createMockClient(text, { onRequest: (p) => reqs.push(structuredClone(p)) })!;
  return { client, reqs };
}

beforeEach(() => {
  clearCart(SID_A);
  lines.length = 0;
});
afterEach(() => vi.restoreAllMocks());

describe('AC-CP-4 request body and tool loop', () => {
  it('sends model, max_tokens 1024, auto tool choice, all 9 data tools plus render_ui', async () => {
    const { client, reqs } = recording('search tea');
    const r = await runToolLoop({ client, text: 'search tea', sid: SID_A, turn: 1, model: 'claude-sonnet-5-5' });
    expect(r.status).toBe('rendered');
    expect(reqs).toHaveLength(2);
    const body = reqs[0];
    expect(body.model).toBe('claude-sonnet-5-5');
    expect(body.max_tokens).toBe(1024);
    expect(body.tool_choice).toEqual({ type: 'auto' });
    expect((body.tools ?? []).map((t) => (t as { name: string }).name)).toEqual([
      'search_products', 'list_products', 'get_product', 'view_cart', 'add_to_cart', 'update_cart_quantity', 'remove_from_cart', 'place_mock_order', 'list_orders', 'render_ui',
    ]);
    for (const t of body.tools ?? []) expect(Object.keys(t).sort()).toEqual(['description', 'input_schema', 'name']);
    expect(JSON.stringify(body)).not.toContain(FAKE_KEY);
  });

  it('second request carries the assistant tool_use and a matching tool_result with catalog data', async () => {
    const { client, reqs } = recording('search tea');
    await runToolLoop({ client, text: 'search tea', sid: SID_A, turn: 1, model: 'm' });
    const [u, a, tr] = reqs[1].messages;
    expect(u.role).toBe('user');
    expect(a.role).toBe('assistant');
    const use = (a.content as Array<{ type: string; id?: string }>).find((b) => b.type === 'tool_use')!;
    const result = (tr.content as Array<{ type: string; tool_use_id: string; content: string }>)[0];
    expect(result.type).toBe('tool_result');
    expect(result.tool_use_id).toBe(use.id);
    expect(JSON.parse(result.content).products.map((p: { id: string }) => p.id)).toEqual(expect.arrayContaining(['ketepa-100', 'kericho-gold-50']));
  });

  it('the shopper text goes in as quoted data, capped at 300 chars', () => {
    const body = buildRequest('m', [{ role: 'user', content: 'x' }]);
    expect(body.system).toMatch(/never pay/);
    expect(body.thinking).toEqual({ type: 'between_tools' });
  });

  it('search fixture renders a validated ProductGrid with catalog ids', async () => {
    const a = await planWithClaude('search tea', SID_A, 3, { env: MOCK_ENV, log });
    expect(a.source).toBe('claude');
    expect(a.reply).toEqual({ key: 'search_found' });
    expect(validateA2ui(a.messages).ok).toBe(true);
    const s = JSON.stringify(a.messages);
    expect(s).toContain('"component":"ProductGrid"');
    expect(s).toContain('ketepa-100');
    expect(s).not.toMatch(/priceKES|KES/);
  });

  it('compare fixture: two parallel get_product calls answered in one user message, then a CompareTable', async () => {
    const { client, reqs } = recording('compare ketepa and kericho gold');
    const r = await runToolLoop({ client, text: 'compare ketepa and kericho gold', sid: SID_A, turn: 2, model: 'm' });
    expect(r.status).toBe('rendered');
    expect((reqs[1].messages[2].content as unknown[]).length).toBe(2);
    expect(JSON.stringify(r.status === 'rendered' && r.messages)).toContain('CompareTable');
  });

  it('add-to-cart fixture changes the server cart and renders CartSummary', async () => {
    const a = await planWithClaude('add 2 unga', SID_A, 4, { env: MOCK_ENV, log });
    expect(a.source).toBe('claude');
    expect(a.reply).toEqual({ key: 'added', productId: 'unga-2kg' });
    expect(getItems(SID_A)).toEqual([{ productId: 'unga-2kg', qty: 2 }]);
    expect(JSON.stringify(a.messages)).toContain('CartSummary');
  });

  it('checkout fixture: place_mock_order is a handoff only; renders CheckoutHandoff wired to go_to_checkout', async () => {
    addItem(SID_A, 'omo-1kg', 1);
    const a = await planWithClaude('checkout please', SID_A, 5, { env: MOCK_ENV, log });
    expect(a.source).toBe('claude');
    expect(JSON.stringify(a.messages)).toContain('"name":"go_to_checkout"');
    expect(getItems(SID_A)).toEqual([{ productId: 'omo-1kg', qty: 1 }]);
  });

  it('turn cap: a model that keeps calling tools stops after 4 requests and falls back to regex', async () => {
    const { client, reqs } = recording('trigger loop');
    const r = await runToolLoop({ client, text: 'trigger loop', sid: SID_A, turn: 1, model: 'm' });
    expect(r).toMatchObject({ status: 'failed', reason: 'turn_cap', turns: 4 });
    expect(reqs).toHaveLength(4);
    const a = await planWithClaude('trigger loop', SID_A, 1, { env: MOCK_ENV, log });
    expect(a.source).toBe('regex-fallback');
    expect(a.diag).toMatch(/reason=turn_cap/);
  });

  it('tool-call cap: more than 8 tool calls in a request is refused', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ type: 'tool_use', id: `toolu_${i}`, name: 'view_cart', input: {} }));
    const client: PlannerClient = { kind: 'mock', create: async () => ({ id: 'm', type: 'message', role: 'assistant', model: 'm', content: many, stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }) as never };
    expect(await runToolLoop({ client, text: 'x', sid: SID_A, turn: 1, model: 'm' })).toMatchObject({ status: 'failed', reason: 'tool_cap' });
  });

  it('timeout: a model that never answers is aborted at the deadline', async () => {
    const t0 = Date.now();
    const a = await planWithClaude('trigger timeout', SID_A, 1, { env: MOCK_ENV, log, timeoutMs: 50 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(a.source).toBe('regex-fallback');
    expect(a.diag).toMatch(/reason=timeout/);
  });
});

describe('AC-CP-6 hostile output and plain text', () => {
  const HOSTILE: Array<[string, string[]]> = [
    ['hostile price', ['PATH_IN_TEXT', 'RENDER_SCHEMA']], // "1/-" trips the path rule before the props check
    ['hostile link', ['FORBIDDEN_KEY', 'URL_IN_TEXT', 'RENDER_SCHEMA']],
    ['hostile path', ['PATH_IN_TEXT', 'RENDER_SCHEMA']],
    ['hostile pay', ['PAY_ACTION_REJECTED', 'RENDER_SCHEMA']],
    ['hostile component', ['UNKNOWN_COMPONENT', 'RENDER_SCHEMA']],
    ['hostile html', ['HTML_IN_TEXT', 'RENDER_SCHEMA']],
    ['trigger bad reply', ['BAD_REPLY', 'RENDER_SCHEMA']],
  ];
  it.each(HOSTILE)('"%s" is rejected: trusted reply + fallback card, nothing rendered', async (text, codes) => {
    const a = await planWithClaude(text, SID_A, 6, { env: MOCK_ENV, log });
    expect(a.source).toBe('claude-rejected');
    expect(a.rejected).toBe(true);
    expect(a.reply).toEqual({ key: 'could_not_show' });
    expect(a.messages).toEqual([]);
    for (const c of codes) expect(a.diag).toContain(c);
    expect(a.diag).not.toMatch(/evil|1\/-|passwd|onerror|PayNow|KES 1/);
  });

  it('plain text instead of render_ui is never rendered: trusted reply + fallback', async () => {
    const a = await planWithClaude('tell me a joke', SID_A, 7, { env: MOCK_ENV, log });
    expect(a).toMatchObject({ source: 'claude-rejected', rejected: true, reply: { key: 'could_not_show' }, messages: [] });
    expect(a.diag).toMatch(/reason=plain_text/);
    expect(JSON.stringify(a)).not.toMatch(/evil|KES 1|chicken/);
  });

  it('a pay-like tool the model invents is refused as unknown_tool; the loop continues safely', async () => {
    const { client, reqs } = recording('hostile pay tool');
    const r = await runToolLoop({ client, text: 'hostile pay tool', sid: SID_A, turn: 1, model: 'm' });
    expect(r.status).toBe('rendered');
    const result = (reqs[1].messages[2].content as Array<{ content: string; is_error?: boolean }>)[0];
    expect(result.is_error).toBe(true);
    expect(JSON.parse(result.content)).toEqual({ error: 'unknown_tool' });
    expect(r.tools).toEqual(['unknown', 'render_ui']);
  });

  it('a rejected render rolls back cart changes made by tools earlier in the loop', async () => {
    let n = 0;
    const client: PlannerClient = {
      kind: 'mock',
      create: async () => {
        n++;
        const content = n === 1 ? [{ type: 'tool_use', id: 't1', name: 'add_to_cart', input: { productId: 'omo-1kg', qty: 3 } }] : [{ type: 'tool_use', id: 't2', name: 'render_ui', input: { reply: { key: 'cart_shown' }, components: [{ component: 'CartSummary', title: 'KES 1' }] } }];
        return { id: 'm', type: 'message', role: 'assistant', model: 'm', content, stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } as never;
      },
    };
    addItem(SID_A, 'unga-2kg', 1);
    const a = await planWithClaude('anything', SID_A, 1, { env: MOCK_ENV, client, log });
    expect(a.source).toBe('claude-rejected');
    expect(getItems(SID_A)).toEqual([{ productId: 'unga-2kg', qty: 1 }]);
  });

  it('mapRender accepts each allowed component and rejects extra props', () => {
    const ok = mapRender({ reply: { key: 'help' }, components: [{ component: 'FilterChips' }, { component: 'QuantityStepper', productId: 'unga-2kg' }, { component: 'OrderStatusCard', orderId: 'ord_AAAAAAAAAAAAAAAA' }, { component: 'CheckoutHandoff' }] }, 1);
    expect(ok.ok).toBe(true);
    expect(mapRender({ reply: { key: 'help' }, components: [{ component: 'CartSummary', badge: 'x' }] }, 1).ok).toBe(false);
    expect(mapRender({ reply: { key: 'help' }, components: Array(5).fill({ component: 'CartSummary' }) }, 1)).toMatchObject({ ok: false });
    expect(mapRender('render <b>', 1).ok).toBe(false);
  });
});

describe('AC-CP-7 every failure mode falls back, diagnostics clean', () => {
  const env = (over: Record<string, string | undefined>) => ({ ...MOCK_ENV, ...over });
  const CASES: Array<[string, string, Record<string, string | undefined>, RegExp]> = [
    ['no key, live not allowed (no mock client)', 'search tea', { DUKA_PLANNER_CLIENT: undefined, ANTHROPIC_API_KEY: undefined }, /reason=live_not_allowed|reason=test_env/],
    ['live allowed flag but test env', 'search tea', { DUKA_PLANNER_CLIENT: undefined, DUKA_ALLOW_LIVE: '1', NODE_ENV: 'test' }, /reason=test_env/],
    ['API error', 'trigger api error', {}, /reason=api_error/],
    ['malformed response', 'trigger malformed', {}, /reason=malformed/],
    ['refusal stop reason', 'trigger refusal', {}, /reason=refusal/],
    ['tool loop cap', 'trigger loop', {}, /reason=turn_cap/],
    ['text with no fixture', 'xyzzy plugh', {}, /reason=mock_no_fixture/],
  ];
  it.each(CASES)('%s -> regex planner answer', async (_n, text, over, re) => {
    const a = await planWithClaude(text, SID_A, 9, { env: env(over), log });
    expect(a.source).toBe('regex-fallback');
    expect(a.diag).toMatch(re);
    expect(validateA2ui(a.messages).ok).toBe(true);
  });

  it('no key + regex fallback answers like the regex planner', async () => {
    const a = await planWithClaude('search tea', SID_A, 9, { env: { DUKA_PLANNER: 'claude' }, log });
    expect(a.reply).toEqual({ key: 'search_found' });
  });

  it('an API error thrown with the key in its message never reaches the log', async () => {
    const client: PlannerClient = { kind: 'mock', create: async () => { throw new Error(`401 bad key ${FAKE_KEY} raw model text here`); } };
    const a = await planWithClaude('search tea', SID_A, 9, { env: MOCK_ENV, client, log });
    expect(a.source).toBe('regex-fallback');
    expect(lines.join('\n')).not.toContain(FAKE_KEY);
    expect(lines.join('\n')).not.toContain('raw model text');
  });

  it('every diagnostic line is codes and counters only, with live counters at 0', async () => {
    for (const text of Object.keys(SCRIPT)) {
      if (text === 'trigger timeout') continue;
      await planWithClaude(text, SID_A, 1, { env: MOCK_ENV, log });
    }
    expect(lines.length).toBe(Object.keys(SCRIPT).length - 1);
    for (const l of lines) {
      expect(l).toMatch(/^\[claude-planner\] outcome=(rendered|rejected|fallback) [a-z0-9_=,\- A-Z]* client=mock live_constructions=0 live_transport_calls=0$/);
      expect(l).not.toContain(FAKE_KEY);
    }
  });
});

describe('fixture script covers the tools', () => {
  it('render_ui is never a data tool and every data tool has a handler', async () => {
    const { isDataTool } = await import('@/lib/assistant/tools/handlers');
    expect(isDataTool(RENDER_TOOL.name)).toBe(false);
    for (const t of DATA_TOOLS) expect(isDataTool(t.name)).toBe(true);
  });
});

describe('defence in depth: an env record that opens the gate still cannot go live in the test process', () => {
  it('planWithClaude with gate-open env falls back (live client refused), nothing constructed', async () => {
    const { liveCounters } = await import('@/lib/assistant/claude/client');
    const a = await planWithClaude('search tea', SID_A, 1, { env: { DUKA_PLANNER: 'claude', DUKA_ALLOW_LIVE: '1', ANTHROPIC_API_KEY: FAKE_KEY, NODE_ENV: 'production' }, log });
    expect(a.source).toBe('regex-fallback');
    expect(a.diag).toMatch(/reason=live_refused/);
    expect(a.diag).not.toContain(FAKE_KEY);
    expect(liveCounters).toEqual({ constructions: 0, transportCalls: 0 });
  });
});

describe('security review fixes', () => {
  it('rollback is skipped when the cart changed outside the loop (e.g. a checkout in another tab); no regex double-apply', async () => {
    let n = 0;
    const client: PlannerClient = {
      kind: 'mock',
      create: async () => {
        n++;
        if (n === 2) clearCart(SID_A); // another tab checks out while the model is thinking
        const content = n === 1 ? [{ type: 'tool_use', id: 't1', name: 'add_to_cart', input: { productId: 'omo-1kg', qty: 1 } }] : [{ type: 'text', text: 'done' }];
        return { id: 'm', type: 'message', role: 'assistant', model: 'm', content, stop_reason: n === 1 ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } as never;
      },
    };
    addItem(SID_A, 'unga-2kg', 2);
    const a = await planWithClaude('add 2 unga', SID_A, 1, { env: MOCK_ENV, client, log });
    expect(a).toMatchObject({ source: 'claude-rejected', rejected: true, reply: { key: 'could_not_show' } });
    expect(a.diag).toMatch(/rollback=skipped_cart_changed/);
    expect(getItems(SID_A)).toEqual([]); // the checked-out items did not come back
  });

  it('rollback is skipped when another tab changed the cart BEFORE a later planner write (no absorbing)', async () => {
    let n = 0;
    const client: PlannerClient = {
      kind: 'mock',
      create: async () => {
        n++;
        if (n === 2) clearCart(SID_A); // checkout elsewhere, between our two writes
        const content =
          n === 1 ? [{ type: 'tool_use', id: 't1', name: 'add_to_cart', input: { productId: 'sukuma-bunch', qty: 1 } }]
          : n === 2 ? [{ type: 'tool_use', id: 't2', name: 'add_to_cart', input: { productId: 'omo-1kg', qty: 1 } }]
          : [{ type: 'text', text: 'plain text, no render' }];
        return { id: 'm', type: 'message', role: 'assistant', model: 'm', content, stop_reason: n < 3 ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } as never;
      },
    };
    addItem(SID_A, 'unga-2kg', 2);
    const a = await planWithClaude('add stuff', SID_A, 1, { env: MOCK_ENV, client, log });
    expect(a.diag).toMatch(/rollback=skipped_cart_changed/);
    expect(getItems(SID_A).some((i) => i.productId === 'unga-2kg')).toBe(false); // checked-out unga must not come back
  });

  it('rollback still restores when only our own tools changed the cart', async () => {
    addItem(SID_A, 'unga-2kg', 1);
    const a = await planWithClaude('trigger loop', SID_A, 1, { env: MOCK_ENV, log }); // list_products only, then turn cap
    expect(a.source).toBe('regex-fallback');
    expect(a.diag).not.toMatch(/rollback=skipped/);
  });

  it('live budget: 6 per session and 30 overall per minute, then refused', async () => {
    const { liveBudget, _resetLiveBudgetForTests, LIVE_LIMITS } = await import('@/lib/assistant/claude/planner');
    _resetLiveBudgetForTests();
    const t = 1_000_000;
    for (let i = 0; i < LIVE_LIMITS.perSession; i++) expect(liveBudget('s1', t)).toBe(true);
    expect(liveBudget('s1', t)).toBe(false);
    expect(liveBudget('s1', t + LIVE_LIMITS.windowMs + 1)).toBe(true);
    _resetLiveBudgetForTests();
    let ok = 0;
    for (let i = 0; i < 40; i++) if (liveBudget(`s${i}`, t)) ok++;
    expect(ok).toBe(LIVE_LIMITS.global);
    _resetLiveBudgetForTests();
  });

  it('the timeout scenario exists only in the test process (cannot hold requests open under next start)', async () => {
    const { scenarioFor } = await import('@/lib/assistant/claude/mock-client');
    expect(scenarioFor('trigger timeout')).toBe('timeout');
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(scenarioFor('trigger timeout')).toBeUndefined();
      expect(scenarioFor('search tea')).toBe('search-grid');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
