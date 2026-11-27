import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import Shell from '@/components/Shell';
import AddToCartButton from '@/components/AddToCartButton';
import ProductImage from '@/components/ProductImage';
import { formatKES, getProductBySlug } from '@/lib/catalog';
import { stockState } from '@/lib/ui/product-look';

export const dynamic = 'force-dynamic';

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const p = getProductBySlug(slug);
  if (!p) notFound();
  const s = stockState(p.stock);
  return (
    <Shell>
      <Link href="/" className="inline-flex w-fit items-center gap-1.5 text-[14px] font-semibold text-board">
        <ArrowLeft aria-hidden className="size-4" /> All products
      </Link>
      <article className="grid gap-6 rounded-card border border-line bg-surface p-4 sm:p-6 md:grid-cols-[1fr_1.1fr]" data-testid="product-detail">
        <ProductImage productId={p.id} className="aspect-square w-full" emojiClassName="text-[110px] md:text-[140px]" />
        <div className="flex flex-col gap-3">
          <p className="text-[14px] text-muted">{p.category}</p>
          <h1 className="font-display text-[clamp(1.8rem,4vw,2.6rem)] font-bold leading-tight tracking-tight">{p.name}</h1>
          <p className="text-[15px] text-muted">{p.unit}</p>
          <p className="text-[16px] leading-relaxed">{p.description}</p>
          <p className="font-display tabular text-[30px] font-bold" data-testid="product-price">
            {formatKES(p.priceKES)}
          </p>
          <p className="text-[14px] text-muted">{s.label}</p>
          <div className="mt-2 max-w-xs">
            <AddToCartButton productId={p.id} productName={p.name} size="lg" />
          </div>
        </div>
      </article>
    </Shell>
  );
}
