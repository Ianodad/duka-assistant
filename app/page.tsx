import Link from 'next/link';
import { SearchX } from 'lucide-react';
import Shell from '@/components/Shell';
import AddToCartButton from '@/components/AddToCartButton';
import ProductImage from '@/components/ProductImage';
import { formatKES, PRODUCTS, searchProducts } from '@/lib/catalog';
import { stockState } from '@/lib/ui/product-look';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function CatalogPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const sp = await searchParams;
  const q = (Array.isArray(sp.q) ? sp.q[0] : sp.q ?? '').trim().slice(0, 60);
  const products = q ? searchProducts(q) : PRODUCTS;

  return (
    <Shell query={q}>
      <section aria-labelledby="hero-title" className="on-board relative overflow-hidden rounded-board bg-board text-white">
        <div aria-hidden className="absolute inset-y-0 left-0 w-2.5 bg-sun" />
        <div className="flex flex-col gap-3 px-6 py-7 pl-8 sm:px-10 sm:py-9 sm:pl-12">
          <p className="text-[14px] text-white/85">Duka la Mtaa, open 6am to 10pm</p>
          <h1 id="hero-title" className="font-display max-w-[20ch] text-[clamp(1.9rem,4.6vw,3.2rem)] font-bold leading-[1.04] tracking-[-0.02em]">
            Everyday staples from the duka down the road.
          </h1>
          <p className="max-w-[52ch] text-[16px] leading-relaxed text-white/85">Unga, chai, sukuma and more, priced in shillings. Pay with <span className="whitespace-nowrap">M-Pesa</span> when you are ready.</p>
        </div>
      </section>

      <section id="products" aria-labelledby="products-title">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
          <h2 id="products-title" className="font-display text-[26px] font-semibold tracking-tight">
            {q ? `Results for "${q}"` : 'On the shelves today'}
          </h2>
          <p className="tabular text-[14px] text-muted" data-testid="result-count">
            {products.length} of {PRODUCTS.length} products
          </p>
        </div>

        {products.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-line-strong bg-surface px-6 py-12 text-center" data-testid="shop-empty">
            <SearchX aria-hidden className="size-9 text-muted" />
            <p className="font-display text-[20px] font-semibold">No products match &quot;{q}&quot;</p>
            <Link href="/" className="font-semibold text-board underline underline-offset-4">
              Show all products
            </Link>
          </div>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 lg:grid-cols-4">
            {products.map((p) => {
              const s = stockState(p.stock);
              return (
                <li key={p.id}>
                  <article className="lift flex h-full flex-col rounded-card border border-line bg-surface p-2.5 sm:p-3" data-testid="product-card" data-product-id={p.id}>
                    <Link href={`/p/${p.id}`} className="flex flex-1 flex-col rounded-tile" data-testid={`product-link-${p.id}`}>
                      <ProductImage productId={p.id} className="aspect-[4/3] w-full" emojiClassName="text-[52px] sm:text-[56px]" />
                      <div className="flex flex-1 flex-col gap-0.5 px-1 pt-3">
                        <p className="text-[12.5px] text-muted">{p.category}</p>
                        <h3 className="text-[15px] font-semibold leading-snug text-ink sm:text-base">{p.name}</h3>
                        <p className="text-[13px] text-muted">{p.unit}</p>
                        <div className="mt-auto flex flex-wrap items-end justify-between gap-x-2 pt-2">
                          <p className="font-display tabular text-[19px] font-semibold text-ink">{formatKES(p.priceKES)}</p>
                          <p className={cn('flex items-center gap-1.5 pb-0.5 text-[12.5px]', s.tone === 'ok' ? 'text-muted' : 'text-warn')}>
                            <span aria-hidden className={cn('size-1.5 rounded-full', s.tone === 'ok' ? 'bg-board' : 'bg-[#c98a00]')} />
                            {s.label}
                          </p>
                        </div>
                      </div>
                    </Link>
                    <div className="px-1 pb-0.5 pt-3">
                      <AddToCartButton productId={p.id} productName={p.name} />
                    </div>
                  </article>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </Shell>
  );
}
