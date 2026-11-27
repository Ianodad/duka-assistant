'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, CircleX, Smartphone, Ban } from 'lucide-react';
import type { OrderState } from '@/lib/shop/order-state';
import { cn } from '@/lib/utils';

const COPY: Record<OrderState, { title: string; body: string }> = {
  pending: { title: 'Check your phone', body: 'We sent an M-Pesa prompt. Enter your PIN to pay. This page updates by itself.' },
  paid: { title: 'Payment received', body: 'Asante! Your order is paid and the duka is packing it.' },
  failed: { title: 'Payment failed', body: 'M-Pesa did not complete the payment.' },
  cancelled: { title: 'Payment cancelled', body: 'The M-Pesa prompt was cancelled on the phone.' },
};

export default function OrderStatus({
  orderId,
  initialState,
  initialReason,
  unconfirmed = false,
}: {
  orderId: string;
  initialState: OrderState;
  initialReason?: string;
  unconfirmed?: boolean;
}) {
  const [state, setState] = useState<OrderState>(initialState);
  const [reason, setReason] = useState<string | undefined>(initialReason);

  useEffect(() => {
    // Unconfirmed orders have no CheckoutRequestID to query; nothing to poll.
    if (state !== 'pending' || unconfirmed) return;
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/status`, { cache: 'no-store' });
        if (res.ok) {
          const j = (await res.json()) as { state: OrderState; reason?: string };
          if (!stop) {
            setState(j.state);
            setReason(j.reason);
          }
        }
      } catch {
        /* keep polling */
      }
    };
    const t = setInterval(tick, 2000);
    void tick();
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [orderId, state, unconfirmed]);

  const c = unconfirmed && state === 'pending' ? { title: 'Payment not confirmed', body: 'Your order is saved. Nothing more will be sent to your phone.' } : COPY[state];
  const Icon = state === 'paid' ? CheckCircle2 : state === 'failed' ? CircleX : state === 'cancelled' ? Ban : Smartphone;
  return (
    <div
      className={cn(
        'flex items-start gap-4 rounded-card border p-5',
        state === 'paid' && 'border-mpesa bg-board-soft',
        state === 'pending' && 'border-info bg-info-soft',
        (state === 'failed' || state === 'cancelled') && 'border-danger bg-danger-soft',
      )}
      data-testid="order-status"
      data-state={state}
      data-unconfirmed={unconfirmed ? 'true' : undefined}
      role="status"
      aria-live="polite"
    >
      <Icon aria-hidden className={cn('mt-0.5 size-8 shrink-0', state === 'paid' ? 'text-mpesa' : state === 'pending' ? 'text-info' : 'text-danger')} />
      <div className="flex flex-col gap-1">
        <p className="font-display flex items-center gap-2 text-[22px] font-bold">
          {state === 'pending' && !unconfirmed ? <span aria-hidden className="pulse-dot size-2.5 rounded-full bg-info" /> : null}
          {c.title}
        </p>
        <p className="text-[15px]">{c.body}</p>
        {state !== 'paid' && reason ? <p className="text-[14px] text-muted" data-testid="order-reason">{reason}</p> : null}
      </div>
    </div>
  );
}
