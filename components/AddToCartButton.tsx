'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function AddToCartButton({ productId, productName, size = 'md' }: { productId: string; productName: string; size?: 'md' | 'lg' }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [added, setAdded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-1">
      <Button
        size={size}
        className="w-full"
        data-testid={`add-${productId}`}
        aria-label={`Add ${productName} to cart`}
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const res = await fetch('/api/cart', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ productId, qty: 1 }),
            });
            if (!res.ok) {
              setError('Could not add to cart. Try again.');
              return;
            }
            setAdded(true);
            router.refresh();
            setTimeout(() => setAdded(false), 1500);
          })
        }
      >
        {added ? <Check aria-hidden className="size-4" /> : <Plus aria-hidden className="size-4" />}
        {added ? 'Added' : 'Add to cart'}
      </Button>
      <p role="status" aria-live="polite" className="min-h-0 text-[13px] text-danger">
        {error}
      </p>
    </div>
  );
}
