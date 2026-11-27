// AC-L30: the render_ui JSON schema for ProductGrid.heading is derived from the zod HeadingSchema and must not drift.
import { describe, expect, it } from 'vitest';
import { CATEGORIES } from '@/lib/catalog';
import { CategorySchema } from '@/lib/a2ui/ids';
import { HeadingSchema } from '@/lib/a2ui/trusted-text';
import { HEADING_JSON_SCHEMA, RENDER_TOOL } from '@/lib/assistant/tools/definitions';

type Variant = { type: string; properties: Record<string, { type: string; const?: string; enum?: string[] }>; required: string[]; additionalProperties: boolean };
const variants = HEADING_JSON_SCHEMA.anyOf as unknown as Variant[];
const zodKeys = HeadingSchema.options.map((o) => o.shape.key.value);

/** Tiny matcher for the closed-object subset used here (const, enum, required, additionalProperties false). */
function matches(v: Variant, value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  if (!v.required.every((k) => k in o)) return false;
  for (const [k, x] of Object.entries(o)) {
    const p = v.properties[k];
    if (!p) return !v.additionalProperties ? false : true;
    if (p.const !== undefined && x !== p.const) return false;
    if (p.enum && !p.enum.includes(x as string)) return false;
  }
  return true;
}
const matching = (value: unknown) => variants.filter((v) => matches(v, value)).length;

/** A sample for a variant: key const, plus the first enum value of every other required property. */
function sample(v: Variant): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of v.required) out[k] = v.properties[k].const ?? v.properties[k].enum![0];
  return out;
}

describe('heading JSON schema (AC-L30)', () => {
  it('variant key consts equal the zod option keys, same order', () => {
    expect(variants.map((v) => v.properties.key.const)).toEqual(zodKeys);
    expect(variants.length).toBe(3);
  });

  it('a sample built from each variant is accepted by zod', () => {
    for (const v of variants) expect(HeadingSchema.safeParse(sample(v)).success, JSON.stringify(sample(v))).toBe(true);
  });

  it('each variant is closed, and an extra property is refused by zod', () => {
    for (const v of variants) {
      expect(v.additionalProperties).toBe(false);
      expect(HeadingSchema.safeParse({ ...sample(v), extra: 'x' }).success).toBe(false);
      expect(matches(v, { ...sample(v), extra: 'x' })).toBe(false);
    }
  });

  it('a variant missing a required property is refused by zod', () => {
    for (const v of variants) {
      for (const k of v.required) {
        if (k === 'key') continue;
        const { [k]: _gone, ...rest } = sample(v);
        expect(HeadingSchema.safeParse(rest).success).toBe(false);
        expect(matches(v, rest)).toBe(false);
      }
    }
    // the category variant really does require a category
    expect(variants.find((v) => v.properties.key.const === 'category')!.required).toEqual(['key', 'category']);
  });

  it('every zod option shape key (optional or not) has a JSON property in its variant', () => {
    HeadingSchema.options.forEach((o, i) => {
      expect(Object.keys(variants[i].properties).sort()).toEqual(Object.keys(o.shape).sort());
    });
  });

  it('the category enum equals the catalog CATEGORIES', () => {
    const cat = variants.find((v) => v.properties.key.const === 'category')!;
    expect(cat.properties.category.enum).toEqual(CATEGORIES);
    expect(cat.properties.category.enum).toEqual(CategorySchema.options);
    for (const v of variants.filter((x) => x.properties.key.const !== 'category')) expect(Object.keys(v.properties)).toEqual(['key']);
  });

  it('RENDER_TOOL keeps a top-level object schema and carries the exported heading schema', () => {
    expect(RENDER_TOOL.input_schema.type).toBe('object');
    const items = (RENDER_TOOL.input_schema.properties.components as { items: { properties: Record<string, unknown> } }).items;
    expect(items.properties.heading).toBe(HEADING_JSON_SCHEMA);
    expect(HEADING_JSON_SCHEMA).not.toHaveProperty('oneOf');
  });

  it('the three bad headings are not representable; the three good ones match exactly one variant', () => {
    const bad = [{ key: 'category' }, { key: 'search_results', category: 'Vegetables' }, { key: 'all_products', category: 'Vegetables' }];
    const good = [{ key: 'search_results' }, { key: 'all_products' }, { key: 'category', category: 'Vegetables' }];
    for (const b of bad) {
      expect(matching(b), JSON.stringify(b)).toBe(0);
      expect(HeadingSchema.safeParse(b).success).toBe(false);
    }
    for (const g of good) {
      expect(matching(g), JSON.stringify(g)).toBe(1);
      expect(HeadingSchema.safeParse(g).success).toBe(true);
    }
  });
});
