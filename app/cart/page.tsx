import Link from 'next/link';
import { ShoppingBasket } from 'lucide-react';
import Shell from '@/components/Shell';
import CartLineControls from '@/components/CartLineControls';
import ProductImage from '@/components/ProductImage';
import { buttonVariants } from '@/components/ui/button';
import { formatKES } from '@/lib/catalog';
import { MAX_QTY, viewCart } from '@/lib/shop/cart';
import { requestSid } from '@/lib/shop/request-sid';

export const dynamic = 'force-dynamic';

export default async function CartPage() {
  const cart = viewCart(await requestSid());
  return (
    <Shell>
      <h1 className="font-display text-[clamp(1.8rem,4vw,2.4rem)] font-bold tracking-tight">Your cart</h1>
      {cart.lines.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-line-strong bg-surface px-6 py-12 text-center" data-testid="cart-empty">
          <ShoppingBasket aria-hidden className="size-9 text-muted" />
          <p className="font-display text-[20px] font-semibold">Your cart is empty</p>
          <Link href="/" className={buttonVariants({ variant: 'primary' })}>
            Browse products
          </Link>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_360px] lg:items-start">
          <ul className="flex flex-col gap-3" data-testid="cart-lines">
            {cart.lines.map((l) => (
              <li key={l.product.id} className="flex gap-3 rounded-card border border-line bg-surface p-3 sm:gap-4" data-testid={`line-${l.product.id}`}>
                <ProductImage productId={l.product.id} className="size-20 shrink-0 sm:size-24" emojiClassName="text-[40px]" />
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <div className="flex flex-wrap items-start justify-between gap-x-3">
                    <div className="min-w-0">
                      <Link href={`/p/${l.product.id}`} className="font-semibold leading-snug hover:text-board">
                        {l.product.name}
                      </Link>
                      <p className="tabular text-[13px] text-muted">
                        {l.product.unit} at {formatKES(l.product.priceKES)}
                      </p>
                    </div>
                    <p className="font-display tabular text-[18px] font-semibold" data-testid={`line-total-${l.product.id}`}>
                      {formatKES(l.lineTotalKES)}
                    </p>
                  </div>
                  <CartLineControls productId={l.product.id} productName={l.product.name} qty={l.qty} max={MAX_QTY} />
                </div>
              </li>
            ))}
          </ul>
          <aside className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4" aria-label="Cart summary">
            <div className="flex items-center justify-between text-[15px]">
              <span className="text-muted">Items</span>
              <span className="tabular" data-testid="cart-item-count">
                {cart.itemCount}
              </span>
            </div>
            <div className="flex items-center justify-between border-t border-line pt-3">
              <span className="font-semibold">Subtotal</span>
              <span className="font-display tabular text-[22px] font-bold" data-testid="cart-subtotal">
                {formatKES(cart.subtotalKES)}
              </span>
            </div>
            <Link href="/checkout" className={buttonVariants({ variant: 'primary', size: 'lg', className: 'w-full' })} data-testid="go-checkout">
              Go to checkout
            </Link>
          </aside>
        </div>
      )}
    </Shell>
  );
}
