import { describe, expect, it } from 'vitest';
import { maskPhone, normalizeKenyanPhone } from '@/lib/shop/phone';

describe('normalizeKenyanPhone', () => {
  it.each([
    ['0712345678', '254712345678'],
    ['0712 345 678', '254712345678'],
    ['712345678', '254712345678'],
    ['+254712345678', '254712345678'],
    ['254712345678', '254712345678'],
    ['+254 (712) 345-678', '254712345678'],
    ['0110123456', '254110123456'],
    ['254110123456', '254110123456'],
    ['110123456', '254110123456'],
  ])('%s -> %s', (input, out) => {
    expect(normalizeKenyanPhone(input)).toEqual({ ok: true, msisdn: out });
  });
  it.each(['', '   ', '0812345678', '071234567', '07123456789', '+255712345678', '2540712345678', 'abc', '0712abc678', '12+254712345678', '0212345678', null, 712345678])(
    'rejects %s with a clear message',
    (input) => {
      const r = normalizeKenyanPhone(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/Safaricom number/);
    },
  );
  it('masks', () => expect(maskPhone('254712345678')).toBe('2547******78'));
});

describe('session cookie parsing', () => {
  it('a malformed percent escape in duka_sid is ignored, not a 500', async () => {
    const { sidFromCookieHeader } = await import('@/lib/shop/session');
    expect(sidFromCookieHeader('duka_sid=%E0%A4%A')).toBeUndefined();
    expect(sidFromCookieHeader('a=1; duka_sid=abcdefghijklmnopqrstuvwxyzABCDEFGH')).toBe('abcdefghijklmnopqrstuvwxyzABCDEFGH');
  });
});
