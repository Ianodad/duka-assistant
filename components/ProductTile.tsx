import { cn } from '@/lib/utils';
import { tileTint } from '@/lib/ui/product-look';

export default function ProductTile({ emoji, category, className }: { emoji: string; category: string; className?: string }) {
  return (
    <div aria-hidden className={cn('grid place-items-center rounded-tile', tileTint(category), className)}>
      {emoji}
    </div>
  );
}
