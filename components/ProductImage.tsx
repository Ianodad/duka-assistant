'use client';
/**
 * The one product image component (week 2b), used by the shop pages and every
 * A2UI view. It takes a product id, never a URL: the path comes from the
 * catalog allowlist (lib/catalog.ts). alt = product name. When there is no
 * photo, or it fails to load (including a failure before hydration, which
 * React's onError misses), it shows the emoji tile placeholder.
 */
import { useEffect, useRef, useState } from 'react';
import ProductTile from '@/components/ProductTile';
import { getProduct } from '@/lib/catalog';
import { tileTint } from '@/lib/ui/product-look';
import { cn } from '@/lib/utils';

export default function ProductImage({ productId, className, emojiClassName }: { productId: string; className?: string; emojiClassName?: string }) {
  const p = getProduct(productId);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const img = ref.current;
    if (img && img.complete && img.naturalWidth === 0) setFailed(true);
  }, []);

  if (!p) return null;
  if (!p.imageSrc || failed) {
    return <ProductTile emoji={p.image} category={p.category} className={cn('aspect-square', className, emojiClassName)} />;
  }
  return (
    <img
      ref={ref}
      src={p.imageSrc}
      alt={p.name}
      width={640}
      height={640}
      decoding="async"
      data-testid="product-image"
      data-product-id={p.id}
      onError={() => setFailed(true)}
      className={cn('aspect-square rounded-tile object-cover', tileTint(p.category), className)}
    />
  );
}
