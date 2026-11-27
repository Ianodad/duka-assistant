import type { DarajaMode } from '@/lib/daraja/types';

/** DUKA_DARAJA_MODE: mock (default) or sandbox. Anything else is refused. */
export function darajaMode(value = process.env.DUKA_DARAJA_MODE): DarajaMode {
  if (value === undefined || value === '' || value === 'mock') return 'mock';
  if (value === 'sandbox') return 'sandbox';
  throw new Error('DUKA_DARAJA_MODE must be "mock" or "sandbox".');
}
