/**
 * The A2UI gate. Every batch of messages (planner output on the server, and
 * every batch the panel receives, including the test hook) passes through
 * validateA2ui() before anything is rendered. Our checks run first, then the
 * @a2ui/web_core strict processor runs as a second opinion.
 *
 * Why our own layer: the library's strict mode rejects unknown components and
 * props, but accepts any action name (even "pay") and functionCall actions
 * (evidence/week2/a2ui-probe-output.txt).
 *
 * Display text is not checked by pattern here: the component schemas have no
 * free-text props at all (trusted label keys only, lib/a2ui/trusted-text.ts),
 * so an amount cannot be expressed. The URL and HTML string rules below are
 * defence in depth for ids and the (never rendered) data model.
 *
 * Diagnostics are redacted: an error code plus a structural path built only
 * from indexes and names we own. Raw values never appear in a diagnostic.
 */
import { z } from 'zod';
import { A2UI_VERSION, COMPONENT_SCHEMAS, createStrictProcessor, dukaApiCatalog, DUKA_CATALOG_ID, DUKA_COMPONENT_NAMES } from './catalog-api';
import { ACTION_PAYLOADS, AGENT_ACTION_SLOTS, isAllowedActionName, PAY_LIKE } from './actions';

export const LIMITS = {
  /** Serialized size of one batch, in characters. */
  maxBytes: 16_000,
  maxMessages: 12,
  /** Components in one updateComponents message. */
  maxComponents: 40,
  /** Component tree depth from root (root = 1). */
  maxTreeDepth: 3,
  /** Nesting depth of any JSON value in a message. */
  maxJsonDepth: 10,
  maxStringLength: 200,
} as const;

export type DiagnosticCode =
  | 'NOT_AN_ARRAY'
  | 'TOO_MANY_MESSAGES'
  | 'OVERSIZE'
  | 'UNSERIALIZABLE'
  | 'JSON_TOO_DEEP'
  | 'STRING_TOO_LONG'
  | 'URL_IN_TEXT'
  | 'PATH_IN_TEXT'
  | 'HTML_IN_TEXT'
  | 'FORBIDDEN_KEY'
  | 'BAD_ENVELOPE'
  | 'WRONG_CATALOG'
  | 'SURFACE_NOT_CREATED'
  | 'TOO_MANY_COMPONENTS'
  | 'UNKNOWN_COMPONENT'
  | 'BAD_PROPS'
  | 'BAD_CHILD'
  | 'MISSING_ROOT'
  | 'TREE_TOO_DEEP'
  | 'PAY_ACTION_REJECTED'
  | 'UNKNOWN_ACTION'
  | 'FUNCTION_CALL_REJECTED'
  | 'ACTION_NOT_ALLOWED_HERE'
  | 'BAD_ACTION_PAYLOAD'
  | 'LIBRARY_REJECTED'
  | 'SURFACE_COLLISION'
  | 'BAD_REPLY';

export type Diagnostic = { code: DiagnosticCode; path: string };
export type A2uiComponent = { id: string; component: string; [prop: string]: unknown };
export type A2uiMessage =
  | { version: typeof A2UI_VERSION; createSurface: { surfaceId: string; catalogId: string } }
  | { version: typeof A2UI_VERSION; updateComponents: { surfaceId: string; components: A2uiComponent[] } }
  | { version: typeof A2UI_VERSION; updateDataModel: { surfaceId: string; path?: string; value?: unknown } }
  | { version: typeof A2UI_VERSION; deleteSurface: { surfaceId: string } };

export type ValidationResult = { ok: true; messages: A2uiMessage[] } | { ok: false; diagnostics: Diagnostic[] };

const SURFACE_ID = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const COMPONENT_ID = /^[a-z][a-z0-9-]{0,31}$/;

const Envelope = z.union([
  z.object({ version: z.literal(A2UI_VERSION), createSurface: z.object({ surfaceId: SURFACE_ID, catalogId: z.string() }).strict() }).strict(),
  z
    .object({
      version: z.literal(A2UI_VERSION),
      updateComponents: z.object({ surfaceId: SURFACE_ID, components: z.array(z.record(z.unknown())) }).strict(),
    })
    .strict(),
  z
    .object({
      version: z.literal(A2UI_VERSION),
      updateDataModel: z.object({ surfaceId: SURFACE_ID, path: z.literal('/').optional(), value: z.unknown().optional() }).strict(),
    })
    .strict(),
  z.object({ version: z.literal(A2UI_VERSION), deleteSurface: z.object({ surfaceId: SURFACE_ID }).strict() }).strict(),
]);

/** Any scheme://, javascript:, data:, protocol-relative //host, or www. host. */
const URL_LIKE = /([a-z][a-z0-9+.-]*:\/\/|\b(javascript|data|vbscript|file|blob)\s*:|(^|[\s"'(])\/\/[^\s/]|\bwww\.)/i;
const HTML_LIKE = /[<>]/;
/** No message string may look like a path or file (the envelope's updateDataModel.path is checked by the schema as exactly "/" and is not walked): our components take ids and enums only, and image URLs come from the catalog. */
const PATH_LIKE = /[\/\\]|\.\.|\.[a-z0-9]{2,5}$/i;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'dangerouslySetInnerHTML', 'style', 'className', 'class', 'href', 'src', 'srcSet', 'srcset', 'image', 'imageSrc', 'imageUrl', 'url', 'html', 'innerHTML', 'onClick']);

class Collector {
  readonly list: Diagnostic[] = [];
  add(code: DiagnosticCode, path: string) {
    if (this.list.length < 20) this.list.push({ code, path });
  }
}

/**
 * The only string allowed to contain a slash is updateDataModel.path, and only when it is exactly "/".
 * That one field is removed before the walk; every other string, including data model values, is walked.
 * Any other path value fails the Envelope schema (z.literal('/')).
 */
function withoutRootDataPath(m: unknown): unknown {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return m;
  // createSurface.catalogId is a URI by protocol design; the Envelope schema plus WRONG_CATALOG accept only DUKA_CATALOG_ID there.
  const cs = (m as Record<string, unknown>).createSurface;
  if (cs && typeof cs === 'object' && !Array.isArray(cs) && (cs as Record<string, unknown>).catalogId === DUKA_CATALOG_ID) {
    const { catalogId: _cat, ...restCs } = cs as Record<string, unknown>;
    return { ...(m as Record<string, unknown>), createSurface: restCs };
  }
  const dm = (m as Record<string, unknown>).updateDataModel;
  if (!dm || typeof dm !== 'object' || Array.isArray(dm) || (dm as Record<string, unknown>).path !== '/') return m;
  const { path: _root, ...rest } = dm as Record<string, unknown>;
  return { ...(m as Record<string, unknown>), updateDataModel: rest };
}

/** Walks every value: depth, string content, forbidden keys, and any action-shaped object. */
function walk(v: unknown, path: string, depth: number, out: Collector): void {
  if (depth > LIMITS.maxJsonDepth) {
    out.add('JSON_TOO_DEEP', path);
    return;
  }
  if (typeof v === 'string') {
    if (v.length > LIMITS.maxStringLength) out.add('STRING_TOO_LONG', path);
    if (URL_LIKE.test(v)) out.add('URL_IN_TEXT', path);
    else if (PATH_LIKE.test(v)) out.add('PATH_IN_TEXT', path);
    if (HTML_LIKE.test(v)) out.add('HTML_IN_TEXT', path);
    return;
  }
  if (Array.isArray(v)) {
    v.forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1, out));
    return;
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('functionCall' in o) out.add('FUNCTION_CALL_REJECTED', path);
    const ev = o.event as { name?: unknown } | undefined;
    if (ev && typeof ev === 'object' && 'name' in ev && !isAllowedActionName(ev.name)) {
      out.add(typeof ev.name === 'string' && PAY_LIKE.test(ev.name) ? 'PAY_ACTION_REJECTED' : 'UNKNOWN_ACTION', path);
    }
    for (const k of Object.keys(o)) {
      if (FORBIDDEN_KEYS.has(k)) out.add('FORBIDDEN_KEY', path);
      // Keys are attacker text: never copy them into the path.
      walk(o[k], `${path}.*`, depth + 1, out);
    }
  }
}

function checkActionSlots(c: A2uiComponent, path: string, out: Collector): void {
  const slots = AGENT_ACTION_SLOTS[c.component] ?? {};
  for (const [prop, value] of Object.entries(c)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const isAction = 'event' in value || 'functionCall' in value;
    if (!isAction) continue;
    const expected = slots[prop];
    const ppath = `${path}.${expected ? prop : '*'}`;
    if (!expected || !('event' in value)) {
      out.add('ACTION_NOT_ALLOWED_HERE', ppath);
      continue;
    }
    const ev = (value as { event?: { name?: unknown; context?: unknown } }).event ?? {};
    if (ev.name !== expected) {
      out.add(typeof ev.name === 'string' && PAY_LIKE.test(ev.name) ? 'PAY_ACTION_REJECTED' : 'ACTION_NOT_ALLOWED_HERE', ppath);
      continue;
    }
    const parsed = ACTION_PAYLOADS[expected].safeParse(ev.context ?? {});
    if (!parsed.success) {
      out.add('BAD_ACTION_PAYLOAD', ppath);
      continue;
    }
    // A card's Add button may only add that card's product.
    if (expected === 'add_to_cart' && (parsed.data as { productId: string }).productId !== c.productId) out.add('BAD_ACTION_PAYLOAD', ppath);
  }
}

function checkTree(components: A2uiComponent[], path: string, out: Collector): void {
  const byId = new Map(components.map((c) => [c.id, c]));
  if (!byId.has('root')) {
    out.add('MISSING_ROOT', path);
    return;
  }
  // Bounded walk: stops as soon as a path is deeper than the cap or loops, so a
  // crafted fan-out tree cannot make this exponential (security review, finding 1).
  const tooDeep = (id: string, depth: number, seen: Set<string>): boolean => {
    if (depth > LIMITS.maxTreeDepth || seen.has(id)) return true;
    const c = byId.get(id);
    if (!c) return true;
    const kids = Array.isArray(c.children) ? (c.children as string[]) : [];
    const next = new Set(seen).add(id);
    return kids.some((k) => tooDeep(k, depth + 1, next));
  };
  if (tooDeep('root', 1, new Set())) out.add('TREE_TOO_DEEP', path);
}

function checkComponents(surfaceId: string, comps: Record<string, unknown>[], mi: number, out: Collector): void {
  const path = `messages[${mi}].updateComponents`;
  if (comps.length > LIMITS.maxComponents) {
    out.add('TOO_MANY_COMPONENTS', path);
    return;
  }
  const typed: A2uiComponent[] = [];
  const ids = new Set<string>();
  comps.forEach((raw, ci) => {
    const cpath = `${path}.components[${ci}]`;
    const { id, component, ...props } = raw;
    if (typeof id !== 'string' || !COMPONENT_ID.test(id) || ids.has(id) || typeof component !== 'string') {
      out.add('BAD_ENVELOPE', cpath);
      return;
    }
    ids.add(id);
    if (!DUKA_COMPONENT_NAMES.includes(component)) {
      out.add('UNKNOWN_COMPONENT', cpath);
      return;
    }
    const named = `${cpath}(${component})`;
    const c = { id, component, ...props } as A2uiComponent;
    checkActionSlots(c, named, out);
    if (!COMPONENT_SCHEMAS[component].safeParse(props).success) out.add('BAD_PROPS', named);
    if (component === 'FilterChips') {
      // AC-L16: no duplicate chips, counts aligned with categories, selected must be a shown chip.
      const cats = Array.isArray(props.categories) ? (props.categories as unknown[]) : [];
      const counts = props.counts;
      if (new Set(cats).size !== cats.length) out.add('BAD_PROPS', named);
      else if (counts !== undefined && (!Array.isArray(counts) || counts.length !== cats.length)) out.add('BAD_PROPS', named);
      else if (props.selected !== undefined && !cats.includes(props.selected)) out.add('BAD_PROPS', named);
    }
    if (component === 'ProductGrid') {
      const kids = props.children;
      if (!Array.isArray(kids) || kids.length === 0 || kids.length > 24 || !kids.every((k) => typeof k === 'string') || new Set(kids).size !== kids.length) out.add('BAD_CHILD', named);
    }
    typed.push(c);
  });
  // Children must exist and be cards or nested grids.
  for (const c of typed) {
    if (!Array.isArray(c.children)) continue;
    for (const k of c.children as unknown[]) {
      const child = typed.find((t) => t.id === k);
      if (!child || (child.component !== 'ProductCard' && child.component !== 'ProductGrid')) out.add('BAD_CHILD', `${path}(${c.component})`);
    }
  }
  if (out.list.length === 0) checkTree(typed, `${path}(${surfaceId ? 'surface' : ''})`, out);
}

export function validateA2ui(input: unknown): ValidationResult {
  const out = new Collector();
  if (!Array.isArray(input)) return { ok: false, diagnostics: [{ code: 'NOT_AN_ARRAY', path: 'messages' }] };
  if (input.length > LIMITS.maxMessages) return { ok: false, diagnostics: [{ code: 'TOO_MANY_MESSAGES', path: 'messages' }] };
  let size: number;
  try {
    size = JSON.stringify(input).length;
  } catch {
    return { ok: false, diagnostics: [{ code: 'UNSERIALIZABLE', path: 'messages' }] };
  }
  if (size > LIMITS.maxBytes) return { ok: false, diagnostics: [{ code: 'OVERSIZE', path: 'messages' }] };

  input.forEach((m, i) => walk(withoutRootDataPath(m), `messages[${i}]`, 0, out));
  if (out.list.length) return { ok: false, diagnostics: out.list };

  const created = new Set<string>();
  input.forEach((m, i) => {
    const env = Envelope.safeParse(m);
    if (!env.success) {
      out.add('BAD_ENVELOPE', `messages[${i}]`);
      return;
    }
    const msg = env.data as unknown as Record<string, { surfaceId: string; catalogId?: string; components?: Record<string, unknown>[] }>;
    if (msg.createSurface) {
      if (msg.createSurface.catalogId !== DUKA_CATALOG_ID) out.add('WRONG_CATALOG', `messages[${i}].createSurface`);
      created.add(msg.createSurface.surfaceId);
    } else if (msg.updateComponents) {
      if (!created.has(msg.updateComponents.surfaceId)) out.add('SURFACE_NOT_CREATED', `messages[${i}]`);
      checkComponents(msg.updateComponents.surfaceId, msg.updateComponents.components ?? [], i, out);
    } else if (msg.updateDataModel && !created.has(msg.updateDataModel.surfaceId)) {
      out.add('SURFACE_NOT_CREATED', `messages[${i}]`);
    } else if (msg.deleteSurface && !created.has(msg.deleteSurface.surfaceId)) {
      // A reply may not remove surfaces from earlier turns (security review, finding 3).
      out.add('SURFACE_NOT_CREATED', `messages[${i}]`);
    }
  });
  if (out.list.length) return { ok: false, diagnostics: out.list };

  // Second opinion: the library's own strict validation (schemas, references, cycles).
  const errors = createStrictProcessor(dukaApiCatalog).processMessagesWithErrors(input as never);
  if (errors.length) return { ok: false, diagnostics: errors.slice(0, 5).map((_, k) => ({ code: 'LIBRARY_REJECTED' as const, path: `library[${k}]` })) };
  return { ok: true, messages: input as A2uiMessage[] };
}

/** Dev-only diagnostic log. Diagnostics hold codes and structural paths only, never raw values. */
export function logRejection(where: string, diagnostics: Diagnostic[]): void {
  if (process.env.NODE_ENV === 'production') return;
  console.warn(`[a2ui] ${where}: rejected`, JSON.stringify(diagnostics));
}
