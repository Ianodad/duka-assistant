import Link from 'next/link';
import Shell from '@/components/Shell';
import CheckoutForm from '@/components/CheckoutForm';
import { buttonVariants } from '@/components/ui/button';
import { formatKES } from '@/lib/catalog';
import { cartSignature, getItems, viewCart } from '@/lib/shop/cart';
import { issueCheckoutToken } from '@/lib/shop/checkout-token';
import { requestSid } from '@/lib/shop/request-sid';
import { payAction } from '@/app/checkout/actions';

export const dynamic = 'force-dynamic';

export default async function CheckoutPage() {
  const sid = await requestSid();
  const cart = viewCart(sid);
  if (!sid || cart.lines.length === 0) {
    return (
      <Shell>
        <h1 className="font-display text-[clamp(1.8rem,4vw,2.4rem)] font-bold tracking-tight">Checkout</h1>
        <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-line-strong bg-surface px-6 py-12 text-center" data-testid="checkout-empty">
          <p className="font-display text-[20px] font-semibold">Your cart is empty</p>
          <Link href="/" className={buttonVariants({ variant: 'primary' })}>
            Browse products
          </Link>
        </div>
      </Shell>
    );
  }
  const token = issueCheckoutToken(sid, cartSignature(getItems(sid)));
  return (
    <Shell>
      <h1 className="font-display text-[clamp(1.8rem,4vw,2.4rem)] font-bold tracking-tight">Checkout</h1>
      <div className="grid gap-6 lg:grid-cols-[1fr_420px] lg:items-start">
        <section aria-labelledby="summary-title" className="rounded-card border border-line bg-surface p-4" data-testid="order-summary">
          <h2 id="summary-title" className="font-display mb-3 text-[20px] font-semibold">
            Order summary
          </h2>
          <ul className="flex flex-col divide-y divide-line">
            {cart.lines.map((l) => (
              <li key={l.product.id} className="flex items-start justify-between gap-3 py-2.5">
                <span className="min-w-0">
                  <span className="font-medium">{l.product.name}</span>
                  <span className="tabular block text-[13px] text-muted">
                    {l.qty} x {formatKES(l.product.priceKES)}
                  </span>
                </span>
                <span className="tabular font-semibold">{formatKES(l.lineTotalKES)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-center justify-between border-t border-line-strong pt-3">
            <span className="font-semibold">Total</span>
            <span className="font-display tabular text-[24px] font-bold" data-testid="checkout-total">
              {formatKES(cart.subtotalKES)}
            </span>
          </div>
          <Link href="/cart" className="mt-3 inline-block text-[14px] font-semibold text-board underline underline-offset-4">
            Edit cart
          </Link>
        </section>
        <section aria-labelledby="pay-title" className="rounded-card border border-line bg-surface p-4">
          <h2 id="pay-title" className="font-display mb-3 text-[20px] font-semibold">
            Pay with M-Pesa
          </h2>
          <CheckoutForm action={payAction} checkoutToken={token} amountKES={cart.subtotalKES} />
        </section>
      </div>
    </Shell>
  );
}
