'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Minus, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function CartLineControls({ productId, productName, qty, max }: { productId: string; productName: string; qty: number; max: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const send = (method: 'PATCH' | 'DELETE', body: Record<string, unknown>) =>
    start(async () => {
      setError(null);
      const res = await fetch('/api/cart', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productId, ...body }) });
      if (!res.ok) setError('Could not update the cart.');
      router.refresh();
    });

  return (
    <div className="flex flex-wrap items-center gap-2" aria-busy={pending}>
      <div className="inline-flex items-center rounded-full border border-field bg-surface" role="group" aria-label={`Quantity of ${productName}`}>
        <Button variant="ghost" size="icon" aria-label={`Decrease ${productName}`} data-testid={`dec-${productId}`} disabled={pending || qty <= 1} onClick={() => send('PATCH', { qty: qty - 1 })}>
          <Minus aria-hidden className="size-4" />
        </Button>
        <span className="tabular w-8 text-center font-semibold" data-testid={`qty-${productId}`} aria-live="polite">
          {qty}
        </span>
        <Button variant="ghost" size="icon" aria-label={`Increase ${productName}`} data-testid={`inc-${productId}`} disabled={pending || qty >= max} onClick={() => send('PATCH', { qty: qty + 1 })}>
          <Plus aria-hidden className="size-4" />
        </Button>
      </div>
      <Button variant="ghost" size="sm" aria-label={`Remove ${productName}`} data-testid={`remove-${productId}`} disabled={pending} onClick={() => send('DELETE', {})}>
        <Trash2 aria-hidden className="size-4" /> Remove
      </Button>
      {error ? (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
