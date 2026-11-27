import Link from 'next/link';
import { notFound } from 'next/navigation';
import Shell from '@/components/Shell';
import OrderStatus from '@/components/OrderStatus';
import { buttonVariants } from '@/components/ui/button';
import { formatKES } from '@/lib/catalog';
import { getOrderForSession } from '@/lib/shop/orders';
import { maskPhone } from '@/lib/shop/phone';
import { shopperReason } from '@/lib/shop/messages';
import { requestSid } from '@/lib/shop/request-sid';

export const dynamic = 'force-dynamic';

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const order = getOrderForSession(id, await requestSid());
  if (!order) notFound();
  return (
    <Shell>
      <h1 className="font-display text-[clamp(1.8rem,4vw,2.4rem)] font-bold tracking-tight">Your order</h1>
      <OrderStatus orderId={order.id} initialState={order.state} initialReason={shopperReason(order.state, order.resultCode, order.initiation)} unconfirmed={order.initiation === 'unconfirmed'} />
      <section aria-labelledby="order-lines" className="rounded-card border border-line bg-surface p-4">
        <h2 id="order-lines" className="font-display mb-2 text-[20px] font-semibold">
          Order {order.id.slice(0, 12)}
        </h2>
        <p className="mb-2 text-[14px] text-muted">M-Pesa number {maskPhone(order.phone)}</p>
        <ul className="flex flex-col divide-y divide-line">
          {order.lines.map((l) => (
            <li key={l.productId} className="flex items-start justify-between gap-3 py-2">
              <span>
                {l.name} <span className="tabular text-muted">x {l.qty}</span>
              </span>
              <span className="tabular font-semibold">{formatKES(l.lineTotalKES)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex items-center justify-between border-t border-line-strong pt-3">
          <span className="font-semibold">Total</span>
          <span className="font-display tabular text-[22px] font-bold" data-testid="order-total">
            {formatKES(order.amountKES)}
          </span>
        </div>
      </section>
      <Link href="/" className={buttonVariants({ variant: 'outline', className: 'w-fit' })}>
        Continue shopping
      </Link>
    </Shell>
  );
}
