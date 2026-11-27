/**
 * Kenyan mobile number normalisation for M-Pesa. Accepts 07XXXXXXXX,
 * 01XXXXXXXX, 7XXXXXXXX, 1XXXXXXXX, 2547XXXXXXXX, 2541XXXXXXXX and +254 forms,
 * with spaces, dashes or brackets. Output is 2547XXXXXXXX or 2541XXXXXXXX.
 */
export type PhoneResult = { ok: true; msisdn: string } | { ok: false; error: string };

export const PHONE_ERROR = 'Enter a Safaricom number like 0712 345 678 or 0110 123 456.';

export function normalizeKenyanPhone(input: unknown): PhoneResult {
  if (typeof input !== 'string') return { ok: false, error: PHONE_ERROR };
  const raw = input.trim();
  if (!raw || raw.length > 20) return { ok: false, error: PHONE_ERROR };
  if (!/^\+?[\d\s\-()]+$/.test(raw)) return { ok: false, error: PHONE_ERROR };
  if (raw.indexOf('+') > 0) return { ok: false, error: PHONE_ERROR };
  let d = raw.replace(/\D/g, '');
  if (raw.startsWith('+') && !d.startsWith('254')) return { ok: false, error: PHONE_ERROR };
  if (d.startsWith('254')) d = d.slice(3);
  else if (d.startsWith('0')) d = d.slice(1);
  if (!/^[17]\d{8}$/.test(d)) return { ok: false, error: PHONE_ERROR };
  return { ok: true, msisdn: `254${d}` };
}

/** Display mask for a normalised number: 2547******78. */
export function maskPhone(msisdn: string): string {
  if (msisdn.length < 6) return '***';
  return `${msisdn.slice(0, 4)}${'*'.repeat(msisdn.length - 6)}${msisdn.slice(-2)}`;
}
