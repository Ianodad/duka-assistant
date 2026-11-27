import { afterEach, describe, expect, it, vi } from 'vitest';
import { _clearRegisteredSecretsForTests, dlog, redact, registerSecret } from '@/lib/daraja/redact';

afterEach(() => _clearRegisteredSecretsForTests());

describe('redact', () => {
  it('masks secret keys in objects, nested', () => {
    const out = redact({ consumerKey: 'k', consumer_secret: 's', passkey: 'p', Password: 'pw', access_token: 't', headers: { Authorization: 'Bearer abc' }, ok: 'fine' });
    expect(out).toEqual({ consumerKey: '[REDACTED]', consumer_secret: '[REDACTED]', passkey: '[REDACTED]', Password: '[REDACTED]', access_token: '[REDACTED]', headers: { Authorization: '[REDACTED]' }, ok: 'fine' });
  });
  it('masks Bearer and Basic tokens and key=value strings', () => {
    expect(redact('Authorization: Bearer eyJhbGciOi.xyz')).toBe('Authorization: Bearer [REDACTED]');
    expect(redact('Basic Zm9vOmJhcg==')).toBe('Basic [REDACTED]');
    expect(redact('{"access_token":"abc123","expires_in":"3599"}')).toBe('{"access_token":"[REDACTED]","expires_in":"3599"}');
    expect(redact('Password=xyz&b=1')).toBe('Password=[REDACTED]&b=1');
  });
  it('masks registered secret values anywhere', () => {
    registerSecret('FAKE_SECRET_VALUE_123');
    expect(redact({ msg: 'oops FAKE_SECRET_VALUE_123 leaked' })).toEqual({ msg: 'oops [REDACTED] leaked' });
    expect(redact(new Error('x FAKE_SECRET_VALUE_123'))).toEqual({ name: 'Error', message: 'x [REDACTED]' });
  });
  it('dlog output is redacted', () => {
    registerSecret('FAKE_PASSKEY_ZZZ');
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    dlog('evt', { passkey: 'FAKE_PASSKEY_ZZZ', note: 'has FAKE_PASSKEY_ZZZ', headers: { Authorization: 'Basic abc' } });
    const line = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(line).not.toContain('FAKE_PASSKEY_ZZZ');
    expect(line).not.toContain('Basic abc');
    spy.mockRestore();
  });
});

describe('redact: callback secret and phone numbers', () => {
  it('masks ?secret= in callback URLs and full MSISDNs', () => {
    const out = redact({ body: { CallBackURL: 'https://x.test/api/daraja/callback?secret=TOPSECRETVALUE&a=1', PartyA: '254712345678' } });
    expect(JSON.stringify(out)).not.toContain('TOPSECRETVALUE');
    expect(JSON.stringify(out)).not.toContain('254712345678');
    expect(JSON.stringify(out)).toContain('2547******78');
    expect(JSON.stringify(redact({ PhoneNumber: 254712345678 }))).not.toContain('254712345678');
  });
  it('validateEnv registers the callback secret so it is masked everywhere', async () => {
    const { validateEnv } = await import('@/lib/daraja/env');
    validateEnv({ DARAJA_ENV: 'sandbox', DARAJA_CONSUMER_KEY: 'fake_ck_1234', DARAJA_CONSUMER_SECRET: 'fake_cs_1234', DARAJA_SHORTCODE: '174379', DARAJA_PASSKEY: 'fake_pk_1234', DARAJA_CALLBACK_URL: 'https://x.test/cb?secret=CBSECRET99' });
    expect(redact('leak CBSECRET99 here')).toBe('leak [REDACTED] here');
  });
});
