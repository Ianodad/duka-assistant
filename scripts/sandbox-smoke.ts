/**
 * Daraja SANDBOX smoke test (operator CLI, not part of the app).
 *   pnpm smoke:sandbox 2547XXXXXXXX
 * Steps: OAuth token, one STK Push for KES 1 to the given phone, then the STK query.
 * All output is redacted. Reads only DUKA_DARAJA_ENV_FILE (default
 * ~/.secrets/duka-daraja-sandbox.env); never the Enroll env file.
 * Exits non-zero with a clear message when the env file is missing or invalid.
 * Queries up to 3 times, 30 s apart.
 */
import { loadSandboxEnv, resolveEnvPath, EnvError } from '../lib/daraja/env';
import { createSandboxAdapter } from '../lib/daraja/sandbox';
import { redact } from '../lib/daraja/redact';
import { normalizeKenyanPhone } from '../lib/shop/phone';

function out(line: string, data?: unknown): void {
  console.log(data === undefined ? redact(line) : `${redact(line)} ${JSON.stringify(redact(data))}`);
}

async function main(): Promise<number> {
  const phoneArg = process.argv[2];
  const phone = normalizeKenyanPhone(phoneArg ?? '');
  if (!phone.ok) {
    out('Usage: pnpm smoke:sandbox <phone>   (for example 2547XXXXXXXX)');
    return 2;
  }
  const path = resolveEnvPath();
  let env;
  try {
    env = loadSandboxEnv(path);
  } catch (e) {
    const msg = e instanceof EnvError ? e.message : 'Could not load the Daraja env file.';
    out(`sandbox-smoke: cannot start. ${msg}`);
    out('Set DUKA_DARAJA_ENV_FILE to a Duka sandbox env file with DARAJA_ENV, DARAJA_CONSUMER_KEY, DARAJA_CONSUMER_SECRET, DARAJA_SHORTCODE, DARAJA_PASSKEY.');
    return 1;
  }
  out(`sandbox-smoke: env loaded (shortcode ${env.shortcode.slice(0, 2)}****), host ${env.baseUrl}`);
  const adapter = createSandboxAdapter(env);
  out('step 1+2: OAuth token and STK push for KES 1');
  const r = await adapter.initiateStk({ amountKES: 1, phone: phone.msisdn, accountReference: 'DukaSmoke', description: 'Duka smoke' });
  out('stk accepted', { checkoutRequestId: r.checkoutRequestId, merchantRequestId: r.merchantRequestId });
  // Up to 3 queries, 30 s apart, to stay clear of sandbox rate limits (429). Stops at a final result.
  for (let attempt = 1; attempt <= 3; attempt++) {
    out(`step 3: waiting 30s, then STK query (attempt ${attempt} of 3)`);
    await new Promise((res) => setTimeout(res, 30_000));
    const q = await adapter.queryStk(r.checkoutRequestId);
    out('query result', q);
    if (q.state === 'final') return 0;
  }
  out('query still pending after 3 attempts');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    out('sandbox-smoke: failed', e instanceof Error ? { name: e.name, message: e.message } : { error: String(e) });
    process.exit(1);
  },
);
