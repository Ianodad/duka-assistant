/**
 * Codex live review 4 BLOCK fixes. Mock clients, fixtures and temp ledger dirs only, zero network.
 *  1. Duplicate product ids are de-duplicated before display: cards, chip counts and the render agree.
 *  2. At most one FilterChips per render: extra chip requests are dropped; the strict schema refuses two.
 *  3. The pre-call input estimate is a true upper bound: >= UTF-8 bytes of the request, plus framing,
 *     at the highest input rate. Cap math still holds and a normal prompt near the cap is not refused.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildRequest, dedupeProducts, mapRender } from '@/lib/assistant/claude/loop';
import { requestShape } from '@/lib/assistant/claude/config';
import { _resetMemoryForTests, recordTurn, stateBlock } from '@/lib/assistant/claude/memory';
import { costFromUsage, estimateCostUSD, estimateInputTokens, FRAMING_TOKENS, HARD_CAP_USD, PRICES, readLedger, withSpendGuard, type Ledger } from '@/lib/assistant/claude/spend';
import type { CreateParams, PlannerClient } from '@/lib/assistant/claude/client';
import { RenderInputSchema } from '@/lib/assistant/tools/definitions';
import { runTool } from '@/lib/assistant/tools/handlers';
import { clearCart } from '@/lib/shop/cart';
import { EMPTY_CART } from '@/lib/assistant/types';
import { SID_A } from './helpers';

const MODEL = 'claude-sonnet-5-5';
type Comp = Record<string, unknown>;
const comps = (messages: unknown[]) => (messages as Array<{ updateComponents?: { components: Comp[] } }>).flatMap((m) => m.updateComponents?.components ?? []);
const cards = (messages: unknown[]) => comps(messages).filter((c) => c.component === 'ProductCard');
const chipGroups = (messages: unknown[]) => comps(messages).filter((c) => c.component === 'FilterChips');
const sum = (xs: unknown) => (xs as number[]).reduce((a, b) => a + b, 0);

beforeEach(() => {
  clearCart(SID_A);
  _resetMemoryForTests();
});

describe('review 4 BLOCK 1: duplicate product ids', () => {
  it('ProductGrid [ketepa, ketepa] + FilterChips shows ONE card and Tea 1 (the Codex repro)', () => {
    const r = mapRender({ reply: { key: 'search_found' }, components: [{ component: 'ProductGrid', productIds: ['ketepa-100', 'ketepa-100'] }, { component: 'FilterChips' }] }, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(cards(r.messages).map((c) => c.productId)).toEqual(['ketepa-100']);
    expect(chipGroups(r.messages)).toHaveLength(1);
    expect(chipGroups(r.messages)[0]).toMatchObject({ categories: ['Tea'], counts: [1] });
  });

  it('every displayed card is counted exactly once: card count == sum of chip counts, cards unique', () => {
    const cases: string[][][] = [
      [['ketepa-100', 'unga-2kg', 'ketepa-100', 'kericho-gold-50', 'unga-2kg']],
      [['ketepa-100', 'unga-2kg'], ['unga-2kg', 'kericho-gold-50']],
      [['sukuma-bunch', 'royco-200g', 'sukuma-bunch', 'brookside-milk-500ml', 'tropical-heat-crisps', 'royco-200g']],
    ];
    for (const grids of cases) {
      const r = mapRender({ reply: { key: 'search_found' }, components: [...grids.map((productIds) => ({ component: 'ProductGrid', productIds })), { component: 'FilterChips' }] }, 1);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      const shown = cards(r.messages).map((c) => c.productId);
      expect(new Set(shown).size).toBe(shown.length);
      expect(sum(chipGroups(r.messages)[0].counts)).toBe(shown.length);
    }
  });

  it('a second grid that only repeats shown products is dropped, the first stays', () => {
    const r = mapRender({ reply: { key: 'search_found' }, components: [{ component: 'ProductGrid', productIds: ['ketepa-100'] }, { component: 'ProductGrid', productIds: ['ketepa-100', 'ketepa-100'] }] }, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(comps(r.messages).filter((c) => c.component === 'ProductGrid')).toHaveLength(1);
    expect(cards(r.messages)).toHaveLength(1);
  });

  it('CompareTable duplicates collapse: [a, b, a] compares 2; [a, a] has nothing to compare and is rejected', () => {
    const three = mapRender({ reply: { key: 'compare_shown' }, components: [{ component: 'CompareTable', productIds: ['ketepa-100', 'kericho-gold-50', 'ketepa-100'] }] }, 1);
    expect(three.ok).toBe(true);
    if (three.ok) expect(comps(three.messages).find((c) => c.component === 'CompareTable')?.productIds).toEqual(['ketepa-100', 'kericho-gold-50']);
    const two = mapRender({ reply: { key: 'compare_shown' }, components: [{ component: 'CompareTable', productIds: ['ketepa-100', 'ketepa-100'] }] }, 1);
    expect(two.ok).toBe(false);
    if (!two.ok) expect(two.codes).toContain('RENDER_SCHEMA'); // min 2 distinct products
  });

  it('dedupeProducts never mutates model input and keeps non-string ids for the schema to reject', () => {
    const input = [{ component: 'ProductGrid', productIds: ['ketepa-100', 'ketepa-100', 7] }];
    const out = dedupeProducts(input) as Array<{ productIds: unknown[] }>;
    expect(out[0].productIds).toEqual(['ketepa-100', 7]);
    expect(input[0].productIds).toHaveLength(3);
    expect(mapRender({ reply: { key: 'search_found' }, components: input }, 1).ok).toBe(false);
  });

  it('the strict schema refuses duplicate ids in a grid or compare, and one id in two grids', () => {
    const ok = { reply: { key: 'search_found' }, components: [{ component: 'ProductGrid', productIds: ['ketepa-100', 'unga-2kg'] }] };
    expect(RenderInputSchema.safeParse(ok).success).toBe(true);
    expect(RenderInputSchema.safeParse({ ...ok, components: [{ component: 'ProductGrid', productIds: ['ketepa-100', 'ketepa-100'] }] }).success).toBe(false);
    expect(RenderInputSchema.safeParse({ reply: { key: 'compare_shown' }, components: [{ component: 'CompareTable', productIds: ['ketepa-100', 'ketepa-100'] }] }).success).toBe(false);
    expect(RenderInputSchema.safeParse({ ...ok, components: [{ component: 'ProductGrid', productIds: ['ketepa-100'] }, { component: 'ProductGrid', productIds: ['ketepa-100'] }] }).success).toBe(false);
  });
});

describe('review 4 BLOCK 2: one FilterChips per render', () => {
  const grid = { component: 'ProductGrid', productIds: ['ketepa-100'] };
  it.each([2, 3])('%i FilterChips requests render ONE chip group (Tea 1 once, never twice)', (n) => {
    const r = mapRender({ reply: { key: 'search_found' }, components: [grid, ...Array.from({ length: n }, () => ({ component: 'FilterChips' }))] }, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(chipGroups(r.messages)).toHaveLength(1);
    expect(chipGroups(r.messages)[0]).toMatchObject({ categories: ['Tea'], counts: [1] });
    expect((r.messages as Array<{ createSurface?: unknown }>).filter((m) => m.createSurface)).toHaveLength(2); // grid + one chips surface
  });

  it('the first chip request wins (its selected is kept), later ones are dropped', () => {
    const g = { component: 'ProductGrid', productIds: ['ketepa-100', 'unga-2kg'] };
    const r = mapRender({ reply: { key: 'search_found' }, components: [g, { component: 'FilterChips', selected: 'Tea' }, { component: 'FilterChips', selected: 'Flour' }] }, 1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(chipGroups(r.messages).map((c) => c.selected)).toEqual(['Tea']);
  });

  it('the strict schema refuses two FilterChips groups in one render', () => {
    expect(RenderInputSchema.safeParse({ reply: { key: 'search_found' }, components: [grid, { component: 'FilterChips' }] }).success).toBe(true);
    expect(RenderInputSchema.safeParse({ reply: { key: 'search_found' }, components: [grid, { component: 'FilterChips' }, { component: 'FilterChips' }] }).success).toBe(false);
  });
});

describe('review 4 BLOCK 3: input estimate is an upper bound', () => {
  const bytesOf = (p: CreateParams) => Buffer.byteLength(JSON.stringify({ system: p.system ?? '', tools: p.tools ?? [], messages: p.messages }), 'utf8');
  const req = (text: string, cache = true) => buildRequest(MODEL, [{ role: 'user', content: [{ type: 'text', text }] }], requestShape(cache ? { DUKA_CLAUDE_CACHE: '1' } : {}));

  it('Unicode and token-dense payloads: estimate >= the UTF-8 byte length of the serialised request', () => {
    const payloads = [
      '🍅🥬🧅🥛🍞'.repeat(400), // 4-byte emoji, 2 UTF-16 units each
      'ሻይ ስኳር ዱቄት 茶 砂糖 面粉 चाय चीनी आटा '.repeat(200), // Ethiopic, CJK, Devanagari: 3 bytes per char
      Array.from({ length: 3000 }, (_, i) => `${(i * 7919) % 10007}${'{}[]<>|\\"'.charAt(i % 9)}`).join(''), // digits + JSON-escaped punctuation
      '\u0000\u0001\u001f'.repeat(500), // control chars: escaped to \\u00XX in JSON
    ];
    for (const text of payloads) {
      const p = req(text);
      expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThanOrEqual(text.length); // dense: bytes >= chars
      expect(estimateInputTokens(p)).toBeGreaterThanOrEqual(bytesOf(p));
      // Priced at the cache-write rate (the highest input rate) for every byte, plus max_tokens at the output rate.
      const pr = PRICES[MODEL];
      expect(estimateCostUSD(p)!).toBeGreaterThanOrEqual((bytesOf(p) * pr.cacheWrite + p.max_tokens * pr.output) / 1e6 - 1e-6);
    }
  });

  /** A realistic second request of a live prompt: state block with earlier turns, shopper text, a data tool result. */
  function liveShape(): CreateParams {
    const grid = mapRender({ reply: { key: 'price_filtered' }, components: [{ component: 'ProductGrid', productIds: ['sukuma-bunch', 'royco-200g', 'brookside-milk-500ml', 'tropical-heat-crisps'] }, { component: 'FilterChips' }] }, 1, { budgetKES: 100 });
    if (!grid.ok) throw new Error('fixture render failed');
    for (const s of ['Anything under 100 bob?', 'Compare the teas', 'Add 2 Ketepa', 'Show my basket']) recordTurn(SID_A, { shopper: s, reply: grid.reply, messages: grid.messages });
    const state = stateBlock(SID_A, EMPTY_CART);
    const out = runTool('list_products', { maxPriceKES: 200 }, { sid: SID_A, turn: 5 });
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: [{ type: 'text', text: state }, { type: 'text', text: 'Shopper message: "anything under 200 bob for chai?"' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'list_products', input: { maxPriceKES: 200 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: out.content }] },
    ];
    return buildRequest(MODEL, messages, requestShape({ DUKA_CLAUDE_CACHE: '1' }));
  }

  it('recorded live usage (4107 input tokens on a request of about 15 KB) is under the estimate, tokens and cost', () => {
    const p = liveShape();
    const bytes = bytesOf(p);
    expect(bytes).toBeGreaterThan(10_000);
    expect(bytes).toBeLessThan(20_000);
    expect(estimateInputTokens(p)).toBeGreaterThanOrEqual(4107);
    // Real usage, whatever its split between plain input, cache write and cache read, costs at most all-cache-write.
    const real = Math.max(
      costFromUsage(MODEL, { input: 4107, output: p.max_tokens, cacheCreation: 0, cacheRead: 0 }),
      costFromUsage(MODEL, { input: 0, output: p.max_tokens, cacheCreation: 4107, cacheRead: 0 }),
    );
    expect(estimateCostUSD(p)!).toBeGreaterThanOrEqual(real);
    // The reservation for this shape is about 4 to 5 cents.
    expect(estimateCostUSD(p)!).toBeGreaterThan(0.03);
    expect(estimateCostUSD(p)!).toBeLessThan(0.07);
  });

  it('the framing allowance is a fixed 1000 tokens on top of the bytes', () => {
    expect(FRAMING_TOKENS).toBe(1000);
    const p = req('tea');
    expect(estimateInputTokens(p) - bytesOf(p)).toBe(FRAMING_TOKENS);
  });

  describe('cap math with the larger reservation', () => {
    let dir: string;
    let env: Record<string, string | undefined>;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'duka-spend6-'));
      env = { DUKA_SPEND_DIR: dir, ANTHROPIC_API_KEY: 'FAKE_ANTHROPIC_KEY_DO_NOT_USE_live6' };
    });
    const prefillAt = (spentUSD: number) => {
      const l: Ledger = { version: 1, capUSD: 5, spentUSD, reservedUSD: 0, calls: 0, origins: {}, updatedAt: new Date().toISOString() };
      writeFileSync(join(dir, 'ledger.json'), JSON.stringify(l));
    };
    // A real-sized usage per request (cache write on the first, reads after).
    const client = (): PlannerClient & { n: number } => {
      const c = {
        kind: 'live' as const,
        n: 0,
        async create() {
          c.n++;
          return { id: 'm', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 400, output_tokens: 150, cache_creation_input_tokens: c.n === 1 ? 3700 : 0, cache_read_input_tokens: c.n === 1 ? 0 : 3700 } } as unknown as Anthropic.Message;
        },
      };
      return c;
    };
    const sig = () => new AbortController().signal;

    it('a normal 3-request prompt with 10 cents left is not refused, and the settled total stays under the cap', async () => {
      prefillAt(HARD_CAP_USD - 0.1);
      const p = liveShape();
      const c = client();
      const g = withSpendGuard(c, env);
      for (let i = 0; i < 3; i++) await g.create(p, { signal: sig() });
      expect(c.n).toBe(3);
      const l = readLedger(env);
      expect(l.reservedUSD).toBe(0);
      expect(l.spentUSD).toBeLessThanOrEqual(HARD_CAP_USD);
    });

    it('with less than one reservation left the call is refused before any network', async () => {
      const p = liveShape();
      prefillAt(HARD_CAP_USD - estimateCostUSD(p)! + 0.000001);
      const c = client();
      await expect(withSpendGuard(c, env).create(p, { signal: sig() })).rejects.toMatchObject({ reason: 'spend_cap' });
      expect(c.n).toBe(0);
      prefillAt(HARD_CAP_USD - estimateCostUSD(p)!);
      await withSpendGuard(c, env).create(p, { signal: sig() });
      expect(c.n).toBe(1);
    });
  });
});
