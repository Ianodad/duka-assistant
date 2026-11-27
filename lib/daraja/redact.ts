/**
 * Redaction for every log line and error from the Daraja code. Masks known
 * secret keys in objects, Authorization header values, Bearer/Basic tokens,
 * and any exact secret value registered by the env loader.
 */
const SECRET_KEYS = /^(consumer_?key|consumer_?secret|passkey|password|access_?token|authorization|token|secret|callback_?secret|duka_callback_secret|daraja_consumer_key|daraja_consumer_secret|daraja_passkey)$/i;
const MASK = '[REDACTED]';

const g = globalThis as unknown as { __dukaSecretValues?: Set<string> };
const registered: Set<string> = (g.__dukaSecretValues ??= new Set());

export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 4) registered.add(value);
}

export function _clearRegisteredSecretsForTests(): void {
  registered.clear();
}

function redactString(s: string): string {
  let out = s;
  for (const v of registered) out = out.split(v).join(MASK);
  out = out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=._\-]+/gi, `$1 ${MASK}`);
  out = out.replace(/("?(?:access_token|Password|passkey|consumer_?secret|consumer_?key)"?\s*[:=]\s*"?)[^"&,\s}]+/gi, `$1${MASK}`);
  // Shared secret in a callback URL query string (?secret=... or &secret=...).
  out = out.replace(/([?&]secret=)[^&#"\s]+/gi, `$1${MASK}`);
  // Kenyan MSISDNs are personal data: keep prefix and last two digits.
  out = out.replace(/\b(254[17])\d{6}(\d{2})\b/g, '$1******$2');
  return out;
}

export function redact<T>(value: T): T {
  return walk(value, 0) as T;
}

function walk(v: unknown, depth: number): unknown {
  if (depth > 8) return '[...]';
  if (typeof v === 'string') return redactString(v);
  if (typeof v === 'number' && /^254[17]\d{8}$/.test(String(v))) return redactString(String(v));
  if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
  if (v instanceof Error) return { name: v.name, message: redactString(v.message) };
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = SECRET_KEYS.test(k) ? MASK : walk(val, depth + 1);
    return out;
  }
  return v;
}

/** The only logger the Daraja code uses. */
export function dlog(event: string, data: Record<string, unknown> = {}): void {
  if (process.env.DUKA_DARAJA_QUIET === '1') return;
  console.info(`[daraja] ${event}`, JSON.stringify(redact(data)));
}
