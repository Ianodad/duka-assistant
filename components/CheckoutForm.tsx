'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatKES } from '@/lib/catalog';
import type { PayState } from '@/app/checkout/actions';

function PayButton({ amountKES }: { amountKES: number }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="mpesa" size="lg" className="w-full" disabled={pending} data-testid="pay-button" aria-label={`Pay ${formatKES(amountKES)} with M-Pesa`}>
      <Smartphone aria-hidden className="size-5" />
      {pending ? 'Sending M-Pesa prompt...' : `Pay ${formatKES(amountKES)} with M-Pesa`}
    </Button>
  );
}

export default function CheckoutForm({
  action,
  checkoutToken,
  amountKES,
}: {
  action: (prev: PayState, fd: FormData) => Promise<PayState>;
  checkoutToken: string;
  amountKES: number;
}) {
  const [state, formAction] = useActionState(action, {});
  const phoneError = state.field === 'phone' ? state.error : undefined;
  const formError = state.field ? undefined : state.error;
  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate data-testid="checkout-form">
      <input type="hidden" name="checkoutToken" value={checkoutToken} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor="phone" className="font-semibold">
          M-Pesa phone number
        </label>
        <input
          key={state.attempt ?? 0}
          defaultValue={state.phone}
          id="phone"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          required
          placeholder="0712 345 678"
          aria-describedby="phone-help phone-error"
          aria-invalid={phoneError ? true : undefined}
          data-testid="phone-input"
          className="h-12 w-full rounded-xl border border-field bg-surface px-4 text-[16px] text-ink placeholder:text-muted focus:border-board aria-[invalid=true]:border-danger"
        />
        <p id="phone-help" className="text-[13px] text-muted">
          Safaricom number, for example 0712 345 678 or +254 712 345 678. You will get a prompt on this phone.
        </p>
        <p id="phone-error" role="alert" className="text-[14px] font-medium text-danger" data-testid="phone-error">
          {phoneError}
        </p>
      </div>
      {formError ? (
        <p role="alert" className="rounded-xl bg-danger-soft px-3 py-2 text-[14px] text-danger" data-testid="form-error">
          {formError}
        </p>
      ) : null}
      <PayButton amountKES={amountKES} />
      <p className="text-[13px] text-muted">Nothing is charged until you enter your M-Pesa PIN on your phone.</p>
    </form>
  );
}
