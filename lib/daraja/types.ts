/** Duka's own small Daraja client surface. Not imported from Enroll. */
export type DarajaMode = 'mock' | 'sandbox';

export type StkInitiateInput = {
  amountKES: number;
  /** Normalised 2547XXXXXXXX or 2541XXXXXXXX. */
  phone: string;
  accountReference: string;
  description: string;
};

export type StkInitiateResult = {
  checkoutRequestId: string;
  merchantRequestId: string;
  customerMessage?: string;
};

export type StkQueryResult =
  | { state: 'pending' }
  | { state: 'final'; resultCode: number; resultDesc: string };

export interface DarajaAdapter {
  readonly mode: DarajaMode;
  /** Sends an STK Push. Only app/checkout/actions.ts may call this (see tests/guard-stk.test.ts). */
  initiateStk(input: StkInitiateInput): Promise<StkInitiateResult>;
  /** Read-only status query for an existing CheckoutRequestID. */
  queryStk(checkoutRequestId: string): Promise<StkQueryResult>;
}

export class DarajaError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'DarajaError';
  }
}

/** Error code for an STK push whose outcome is unknown (timeout, 5xx). The shopper may still get a prompt: never invite a retry. */
export const STK_UNCONFIRMED = 'stk_unconfirmed';
