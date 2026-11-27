/**
 * Sandbox env loader. Reads KEY=VALUE lines from DUKA_DARAJA_ENV_FILE
 * (default ~/.secrets/duka-daraja-sandbox.env, built from os.homedir(); an
 * empty value also means the default). Never reads the Enroll env file.
 * Errors name missing variables only, never values.
 */
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { registerSecret } from '@/lib/daraja/redact';

export const DEFAULT_ENV_FILE = join(homedir(), '.secrets', 'duka-daraja-sandbox.env');
export const FORBIDDEN_BASENAME = 'enroll-daraja-sandbox.env';
export const SANDBOX_BASE_URL = 'https://sandbox.safaricom.co.ke';

export const REQUIRED_VARS = ['DARAJA_ENV', 'DARAJA_CONSUMER_KEY', 'DARAJA_CONSUMER_SECRET', 'DARAJA_SHORTCODE', 'DARAJA_PASSKEY'] as const;

export type SandboxEnv = {
  env: 'sandbox';
  baseUrl: typeof SANDBOX_BASE_URL;
  consumerKey: string;
  consumerSecret: string;
  shortcode: string;
  passkey: string;
  callbackUrl?: string;
};

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvError';
  }
}

export function resolveEnvPath(override?: string): string {
  return override ?? (process.env.DUKA_DARAJA_ENV_FILE || DEFAULT_ENV_FILE);
}

export function assertAllowedPath(path: string): void {
  if (basename(path) === FORBIDDEN_BASENAME) {
    throw new EnvError(`Refusing to read ${FORBIDDEN_BASENAME}: Duka must use its own Daraja credentials.`);
  }
}

export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.match(/^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

export function validateEnv(vars: Record<string, string>): SandboxEnv {
  const missing = REQUIRED_VARS.filter((k) => !vars[k]);
  if (missing.length) throw new EnvError(`Daraja env is missing: ${missing.join(', ')}`);
  if (vars.DARAJA_ENV !== 'sandbox') throw new EnvError('DARAJA_ENV must be "sandbox". Refusing to start sandbox mode.');
  if (vars.DARAJA_BASE_URL && vars.DARAJA_BASE_URL.replace(/\/+$/, '') !== SANDBOX_BASE_URL) {
    throw new EnvError(`DARAJA_BASE_URL must be ${SANDBOX_BASE_URL}. Refusing to start sandbox mode.`);
  }
  if (!/^\d{5,7}$/.test(vars.DARAJA_SHORTCODE)) throw new EnvError('DARAJA_SHORTCODE must be 5 to 7 digits.');
  let callbackUrl: string | undefined;
  if (vars.DARAJA_CALLBACK_URL) {
    let u: URL;
    try {
      u = new URL(vars.DARAJA_CALLBACK_URL);
    } catch {
      throw new EnvError('DARAJA_CALLBACK_URL is not a valid URL.');
    }
    if (u.protocol !== 'https:') throw new EnvError('DARAJA_CALLBACK_URL must use https.');
    callbackUrl = u.toString();
    registerSecret(u.searchParams.get('secret') ?? undefined);
  }
  registerSecret(process.env.DUKA_CALLBACK_SECRET);
  for (const k of ['DARAJA_CONSUMER_KEY', 'DARAJA_CONSUMER_SECRET', 'DARAJA_PASSKEY']) registerSecret(vars[k]);
  return {
    env: 'sandbox',
    baseUrl: SANDBOX_BASE_URL,
    consumerKey: vars.DARAJA_CONSUMER_KEY,
    consumerSecret: vars.DARAJA_CONSUMER_SECRET,
    shortcode: vars.DARAJA_SHORTCODE,
    passkey: vars.DARAJA_PASSKEY,
    callbackUrl,
  };
}

export function loadSandboxEnv(override?: string): SandboxEnv {
  const path = resolveEnvPath(override);
  assertAllowedPath(path);
  if (!existsSync(path)) throw new EnvError(`Daraja env file not found at DUKA_DARAJA_ENV_FILE (${path}). Sandbox mode needs it; mock mode does not.`);
  // A symlink pointing at the Enroll file is refused too.
  assertAllowedPath(realpathSync(path));
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new EnvError('Daraja env file could not be read.');
  }
  return validateEnv(parseEnvText(text));
}
