/** Adapted from the spike's SiteHeader: server component, GET search, server-side cart count. */
import Link from 'next/link';
import { Search, ShoppingBasket } from 'lucide-react';
import AssistantButton from '@/components/assistant/AssistantButton';
import { viewCart } from '@/lib/shop/cart';
import { requestSid } from '@/lib/shop/request-sid';

export default async function SiteHeader({ query = '' }: { query?: string }) {
  const count = viewCart(await requestSid()).itemCount;
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/85">
      <div className="mx-auto flex max-w-[1240px] flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 md:flex-nowrap md:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2 rounded-lg" aria-label="Duka home">
          <span aria-hidden className="font-display grid size-9 place-items-center rounded-[10px] bg-board text-[20px] font-bold text-sun">
            D
          </span>
          <span className="font-display text-[22px] font-bold tracking-tight text-ink">Duka</span>
        </Link>

        <form role="search" action="/" method="get" className="order-last w-full md:order-none md:mx-4 md:max-w-xl md:flex-1">
          <label htmlFor="shop-search" className="sr-only">
            Search products
          </label>
          <div className="relative">
            <Search aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 size-[18px] -translate-y-1/2 text-muted" />
            <input
              id="shop-search"
              name="q"
              type="search"
              defaultValue={query}
              placeholder="Search unga, chai, sukuma..."
              autoComplete="off"
              className="h-11 w-full rounded-full border border-field bg-sunken pl-10 pr-4 text-[15px] text-ink placeholder:text-muted focus:border-board focus:bg-surface"
            />
          </div>
        </form>

        <div className="ml-auto flex items-center gap-2">
          <AssistantButton />
          <Link
            href="/cart"
            data-testid="cart-link"
            aria-label={`Cart, ${count} ${count === 1 ? 'item' : 'items'}`}
            className="pressable relative inline-flex h-11 items-center gap-2 rounded-full bg-board px-4 text-[14px] font-semibold text-white hover:bg-board-strong"
          >
            <ShoppingBasket aria-hidden className="size-[18px]" />
            <span>Cart</span>
            <span data-testid="cart-count" className="tabular grid min-w-6 place-items-center rounded-full bg-sun px-1.5 text-[13px] font-bold text-ink">
              {count}
            </span>
          </Link>
        </div>
      </div>
    </header>
  );
}
