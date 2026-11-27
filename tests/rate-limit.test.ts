/**
 * SPEC-LIVE AC-L35, AC-L36, AC-L40: per-IP live prompt limit on the shared store.
 * In-memory fake store, no network. `now` is passed in so windows are driven by the test.
 */
import { describe, expect, it } from 'vitest';
import { clientIp, checkRate, ipKeyPart, rateKeyIp, rateLimitFor, RATE_LIMITS, setStoreTimeoutForTests } from '@/lib/assistant/claude/store';
import { installFakeStore, sharedEnv, STORE_TOKEN, STORE_URL, useStoreCleanup } from './fakes/store-helpers';

useStoreCleanup();

const DAY = 86_400_000;
const MIN = 60_000;
const T0 = 20_000 * DAY + 3_600_000; // 01:00 UTC on some day
const IP = '203.0.113.77';

describe('AC-L35 limits and headers', () => {
  it('the limits are 5 per minute and 40 per day, in one place', () => {
    expect(RATE_LIMITS).toEqual({ perMinute: 5, perDay: 40 });
    expect(rateLimitFor({})).toEqual({ perMinute: 5, perDay: 40 });
  });
  it('env can only lower them; nonsense or negative fails closed to 0; fractions round down', () => {
    expect(rateLimitFor({ DUKA_RATE_PER_MIN: '2', DUKA_RATE_PER_DAY: '10' })).toEqual({ perMinute: 2, perDay: 10 });
    expect(rateLimitFor({ DUKA_RATE_PER_MIN: '500', DUKA_RATE_PER_DAY: '9999' })).toEqual({ perMinute: 5, perDay: 40 });
    expect(rateLimitFor({ DUKA_RATE_PER_MIN: 'lots', DUKA_RATE_PER_DAY: '-1' })).toEqual({ perMinute: 0, perDay: 0 });
    expect(rateLimitFor({ DUKA_RATE_PER_MIN: '2.9' })).toEqual({ perMinute: 2, perDay: 40 });
    expect(rateLimitFor({ DUKA_RATE_PER_MIN: '', DUKA_RATE_PER_DAY: '  ' })).toEqual({ perMinute: 5, perDay: 40 });
  });
  it('clientIp: first hop of x-forwarded-for (trimmed), else x-real-ip, else unknown', () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(clientIp(h({ 'x-forwarded-for': ' 1.2.3.4 , 5.6.7.8' }))).toBe('1.2.3.4');
    expect(clientIp(h({ 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '9.9.9.9' }))).toBe('1.2.3.4');
    expect(clientIp(h({ 'x-real-ip': ' 9.9.9.9 ' }))).toBe('9.9.9.9');
    expect(clientIp(h({ 'x-forwarded-for': ' , 5.6.7.8', 'x-real-ip': '9.9.9.9' }))).toBe('9.9.9.9');
    expect(clientIp(h({}))).toBe('unknown');
    expect(clientIp(h({ 'x-forwarded-for': '' }))).toBe('unknown');
  });
  it('the key part is an HMAC keyed by the token: stable, 32 hex, never the IP', () => {
    const a = ipKeyPart(IP, STORE_TOKEN);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(ipKeyPart(IP, STORE_TOKEN)).toBe(a);
    expect(ipKeyPart('203.0.113.78', STORE_TOKEN)).not.toBe(a);
    expect(ipKeyPart(IP, 'another-token')).not.toBe(a);
    expect(a).not.toContain('203');
  });
});

describe('AC-L35 rateKeyIp: IPv6 is charged per /64', () => {
  it('IPv4 is unchanged; IPv4-mapped IPv6 (any case, dotted or hex) is the IPv4', () => {
    expect(rateKeyIp('203.0.113.77')).toBe('203.0.113.77');
    expect(rateKeyIp('::ffff:203.0.113.77')).toBe('203.0.113.77');
    expect(rateKeyIp('::FFFF:203.0.113.77')).toBe('203.0.113.77');
    expect(rateKeyIp('0:0:0:0:0:ffff:203.0.113.77')).toBe('203.0.113.77');
    expect(rateKeyIp('::ffff:cb00:714d')).toBe('203.0.113.77');
  });
  it('other IPv6 maps to its /64: first 4 hextets, lowercase, no leading zeros', () => {
    expect(rateKeyIp('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(rateKeyIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(rateKeyIp('2001:db8::5')).toBe('2001:db8:0:0::/64');
    expect(rateKeyIp('::1')).toBe('0:0:0:0::/64');
    expect(rateKeyIp('::')).toBe('0:0:0:0::/64');
    expect(rateKeyIp('2001:db8:1:2:3:4:5::')).toBe('2001:db8:1:2::/64');
    expect(rateKeyIp('2001:db8:1:2:3:4:1.2.3.4')).toBe('2001:db8:1:2::/64');
  });
  it('zone suffix, case and zero-compression variants map to the same key', () => {
    const want = '2001:db8:1:2::/64';
    for (const v of ['2001:DB8:1:2::9', '2001:0db8:0001:0002:0000:0000:0000:0009', '2001:db8:1:2:0:0:0:9', '2001:db8:1:2::9%eth0', '2001:db8:1:2::9%3', '  2001:db8:1:2::9  '])
      expect(rateKeyIp(v)).toBe(want);
  });
  it('anything that is not a valid IP is "unknown"', () => {
    for (const v of ['unknown', '', 'garbage', '1.2.3', '999.1.1.1', '2001:db8::1::2', '2001:db8:1:2:3:4:5:6:7', 'g001::1', '%eth0', '1.2.3.4%eth0x:'])
      expect(rateKeyIp(v)).toBe('unknown');
    expect(rateKeyIp('unknown')).toBe('unknown');
  });
});

describe('AC-L35 windows', () => {
  it('per minute: 5 pass, the 6th is limited and consumes nothing; the next minute resets', async () => {
    const fake = installFakeStore();
    const env = sharedEnv();
    for (let i = 0; i < 5; i++) expect(await checkRate(IP, env, T0 + i * 1000)).toBe('ok');
    expect(await checkRate(IP, env, T0 + 6000)).toBe('limited');
    expect(await checkRate(IP, env, T0 + 7000)).toBe('limited');
    const counts = [...fake.state.strings].map(([k, v]) => [k.split(':')[2], Number(v.value)]).sort();
    expect(counts).toEqual([['d', 5], ['m', 5]]); // refusals did not count
    expect(await checkRate(IP, env, T0 + MIN)).toBe('ok');
  });

  it('per day: 40 pass across 40 minutes, the 41st is limited, the next UTC day resets', async () => {
    installFakeStore();
    const env = sharedEnv();
    for (let i = 0; i < 40; i++) expect(await checkRate(IP, env, T0 + i * MIN)).toBe('ok');
    expect(await checkRate(IP, env, T0 + 40 * MIN)).toBe('limited');
    expect(await checkRate(IP, env, T0 + 41 * MIN)).toBe('limited');
    expect(await checkRate(IP, env, 21_000 * DAY + 100)).toBe('ok'); // a later day: both windows are fresh
    expect(await checkRate(IP, env, (20_000 + 1) * DAY + 100)).toBe('ok'); // the very next UTC day
  });

  it('a different IP has its own quota; the same IP in another namespace too', async () => {
    installFakeStore();
    for (let i = 0; i < 5; i++) await checkRate(IP, sharedEnv(), T0);
    expect(await checkRate(IP, sharedEnv(), T0)).toBe('limited');
    expect(await checkRate('203.0.113.78', sharedEnv(), T0)).toBe('ok');
    expect(await checkRate(IP, sharedEnv({ DUKA_LEDGER_NAMESPACE: 'other' }), T0)).toBe('ok');
  });

  it('IPv6: addresses in one /64 share a quota (6th prompt limited across them); another /64 is separate; IPv4-mapped shares with plain IPv4', async () => {
    installFakeStore();
    const env = sharedEnv();
    const a = ['2001:db8:1:2::1', '2001:db8:1:2:aaaa::2', '2001:DB8:1:2:0:0:0:3', '2001:db8:1:2:ffff:ffff:ffff:ffff%eth0', '2001:db8:1:2::5'];
    for (const ip of a) expect(await checkRate(ip, env, T0)).toBe('ok');
    expect(await checkRate('2001:db8:1:2:1234::9', env, T0)).toBe('limited');
    expect(await checkRate('2001:db8:1:3::1', env, T0)).toBe('ok');
    for (let i = 0; i < 4; i++) await checkRate(IP, env, T0);
    expect(await checkRate(`::ffff:${IP}`, env, T0)).toBe('ok'); // 5th for the IPv4
    expect(await checkRate(IP, env, T0)).toBe('limited');
    expect(await checkRate(`::FFFF:${IP}`, env, T0)).toBe('limited');
  });

  it('garbage and unknown share the single "unknown" quota', async () => {
    installFakeStore();
    const env = sharedEnv();
    for (const ip of ['unknown', 'garbage', '', 'x', 'not-an-ip']) expect(await checkRate(ip, env, T0)).toBe('ok');
    expect(await checkRate('unknown', env, T0)).toBe('limited');
  });

  it('IPv6 keys hold only the HMAC of the /64 key, never the raw address', async () => {
    const fake = installFakeStore();
    await checkRate('2001:db8:1:2::abcd', sharedEnv(), T0);
    const h = ipKeyPart('2001:db8:1:2::/64', STORE_TOKEN);
    expect([...fake.state.strings.keys()].sort()).toEqual([`tns:rl:d:${h}:${Math.floor(T0 / DAY)}`, `tns:rl:m:${h}:${Math.floor(T0 / MIN)}`].sort());
    const dump = JSON.stringify({ keys: [...fake.state.strings.keys()], bodies: fake.calls.map((c) => c.body) });
    for (const s of ['2001', 'db8', 'abcd', '/64']) expect(dump).not.toContain(s);
  });

  it('lowered limits apply; 0 (nonsense) admits nobody', async () => {
    installFakeStore();
    const two = sharedEnv({ DUKA_RATE_PER_MIN: '2' });
    expect(await checkRate(IP, two, T0)).toBe('ok');
    expect(await checkRate(IP, two, T0)).toBe('ok');
    expect(await checkRate(IP, two, T0)).toBe('limited');
    expect(await checkRate('198.51.100.1', sharedEnv({ DUKA_RATE_PER_MIN: 'abc' }), T0)).toBe('limited');
    expect(await checkRate('198.51.100.2', sharedEnv({ DUKA_RATE_PER_DAY: '-3' }), T0)).toBe('limited');
  });

  it('keys hold the namespace and an HMAC, never the raw IP or the token; ttl is set on the first increment', async () => {
    const fake = installFakeStore();
    await checkRate(IP, sharedEnv(), T0);
    const keys = [...fake.state.strings.keys()];
    expect(keys).toHaveLength(2);
    const h = ipKeyPart(IP, STORE_TOKEN);
    expect(keys.sort()).toEqual([`tns:rl:d:${h}:${Math.floor(T0 / DAY)}`, `tns:rl:m:${h}:${Math.floor(T0 / MIN)}`].sort());
    expect(fake.state.strings.get(`tns:rl:m:${h}:${Math.floor(T0 / MIN)}`)!.pttl).toBe(120_000);
    expect(fake.state.strings.get(`tns:rl:d:${h}:${Math.floor(T0 / DAY)}`)!.pttl).toBe(172_800_000);
    const dump = JSON.stringify({ keys, values: [...fake.state.strings.values()], bodies: fake.calls.map((c) => c.body) });
    for (const s of [IP, STORE_TOKEN, STORE_URL]) expect(dump).not.toContain(s);
    expect(fake.calls).toHaveLength(1); // check and both increments are ONE request
    expect((fake.calls[0].body as string[])[0]).toBe('EVAL');
  });
});

describe('AC-L35 / AC-L36 verdicts', () => {
  it('off with the file ledger: no store call at all', async () => {
    const fake = installFakeStore();
    expect(await checkRate(IP, {}, T0)).toBe('off');
    expect(await checkRate(IP, { DUKA_SPEND_DIR: '/tmp/x' }, T0)).toBe('off');
    expect(fake.calls).toHaveLength(0);
  });
  it('unavailable (fail closed) when the store is required and missing or invalid, with no store call', async () => {
    const fake = installFakeStore();
    expect(await checkRate(IP, { VERCEL: '1' }, T0)).toBe('unavailable');
    expect(await checkRate(IP, { DUKA_LEDGER: 'shared' }, T0)).toBe('unavailable');
    expect(await checkRate(IP, { KV_REST_API_URL: 'http://insecure.example.test', KV_REST_API_TOKEN: 't' }, T0)).toBe('unavailable');
    expect(await checkRate(IP, sharedEnv({ DUKA_LEDGER_NAMESPACE: 'bad ns' }), T0)).toBe('unavailable');
    expect(fake.calls).toHaveLength(0);
  });
  it.each([['error500'], ['errorBody'], ['badJson'], ['hang']] as const)('unavailable on store failure %s', async (fail) => {
    setStoreTimeoutForTests(40);
    installFakeStore({ fail });
    expect(await checkRate(IP, sharedEnv(), T0)).toBe('unavailable');
  });
  it('unavailable in a test process with no injected transport (no network)', async () => {
    expect(await checkRate(IP, sharedEnv(), T0)).toBe('unavailable');
  });
});
