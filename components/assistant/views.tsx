/**
 * Pure views behind the 8 trusted A2UI components, plus the fallback card.
 * Every product fact (name, price, unit, stock) is read from lib/catalog by id;
 * cart and order facts come from the server snapshot. Text is rendered as React
 * text children only, never as HTML. Styling reuses the week 1 tokens.
 */
import type { ReactNode } from 'react';
import { AlertTriangle, ArrowRight, Check, Minus, Plus, Scale, ShieldCheck, ShoppingBasket, Trash2 } from 'lucide-react';
import { formatKES, getProduct, PRODUCTS } from '@/lib/catalog';
import { MAX_QTY } from '@/lib/shop/limits';
import type { CartSnapshot, OrderSnapshot } from '@/lib/assistant/types';
import { headingText, type Heading } from '@/lib/a2ui/trusted-text';
import ProductImage from '@/components/ProductImage';
import { stockState } from '@/lib/ui/product-look';
import { cn } from '@/lib/utils';

const card = 'rounded-card border border-line bg-surface';
const title = 'font-display text-[17px] font-semibold leading-tight text-ink';
const smallBtn =
  'pressable inline-flex h-9 cursor-pointer items-center justify-center gap-1 rounded-full px-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-55';

function StockLine({ stock }: { stock: number }) {
  const s = stockState(stock);
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[12.5px]', s.tone === 'ok' ? 'text-muted' : 'text-warn')}>
      <span aria-hidden className={cn('size-1.5 rounded-full', s.tone === 'ok' ? 'bg-board' : s.tone === 'low' ? 'bg-[#c98a00]' : 'bg-danger')} />
      {s.label}
    </span>
  );
}

/** The heading is a trusted label key; the words come from headingText(), never from the message. */
export function ProductGridView({ heading, children }: { heading?: Heading; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5" data-a2ui="ProductGrid">
      {heading ? <h4 className={title} data-testid="a2ui-heading">{headingText(heading)}</h4> : null}
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

export function ProductCardView({ productId, badge, inCart, onAdd }: { productId: string; badge?: string; inCart: number; onAdd?: () => void }) {
  const p = getProduct(productId);
  if (!p) return <FallbackCard />;
  return (
    <article className={cn(card, 'flex items-center gap-3 p-2.5')} data-a2ui="ProductCard" data-product-id={p.id} data-category={p.category}>
      <ProductImage productId={p.id} className="size-16 shrink-0" emojiClassName="text-[30px]" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {badge ? <span className="mb-0.5 inline-flex h-6 w-fit items-center rounded-full bg-sun px-2 text-[12px] font-semibold text-ink">{badge}</span> : null}
        <strong className="text-[15px] font-semibold leading-snug text-ink">{p.name}</strong>
        <span className="text-[13px] text-muted">{p.unit}</span>
        <StockLine stock={p.stock} />
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <span className="font-display tabular text-[17px] font-semibold text-ink" data-testid={`a2ui-price-${p.id}`}>
          {formatKES(p.priceKES)}
        </span>
        {onAdd ? (
          <button
            type="button"
            className={cn(smallBtn, 'bg-board text-white hover:bg-board-strong')}
            data-testid={`a2ui-add-${p.id}`}
            aria-label={`Add ${p.name} to cart`}
            disabled={p.stock <= 0 || inCart >= MAX_QTY}
            onClick={onAdd}
          >
            {inCart > 0 ? <Check aria-hidden className="size-4" /> : <Plus aria-hidden className="size-4" />}
            {inCart > 0 ? `In cart (${inCart})` : 'Add'}
          </button>
        ) : null}
      </div>
    </article>
  );
}

export function CompareTableView({ productIds, onAdd }: { productIds: string[]; onAdd: (id: string) => void }) {
  const items = productIds.map((id) => getProduct(id)).filter((p): p is NonNullable<typeof p> => Boolean(p));
  if (items.length < 2) return <FallbackCard />;
  const cheapest = Math.min(...items.map((p) => p.priceKES));
  const rows: Array<[string, (p: (typeof items)[number]) => ReactNode]> = [
    ['Price', (p) => <span className="font-display tabular text-[16px] font-semibold">{formatKES(p.priceKES)}</span>],
    ['Pack', (p) => p.unit],
    ['Category', (p) => p.category],
    ['Stock', (p) => <StockLine stock={p.stock} />],
  ];
  return (
    <section className={cn(card, 'flex flex-col gap-3 p-3')} data-a2ui="CompareTable" aria-label="Product comparison">
      <div className="flex items-center gap-2">
        <span aria-hidden className="grid size-8 place-items-center rounded-full bg-board-soft text-board">
          <Scale className="size-4" />
        </span>
        <h4 className={title}>Side by side</h4>
      </div>
      <table className="w-full table-fixed border-collapse text-[13.5px]">
        <thead>
          <tr>
            <th scope="col" className="w-[64px] p-1 text-left text-[12px] font-medium text-muted">
              <span className="sr-only">Detail</span>
            </th>
            {items.map((p) => (
              <th key={p.id} scope="col" className="p-1 text-left align-top">
                <ProductImage productId={p.id} className="mb-1.5 size-14" emojiClassName="text-[26px]" />
                <span className="break-words font-semibold text-ink">{p.name}</span>
                {p.priceKES === cheapest ? <span className="mt-1 block w-fit rounded-full bg-sun px-2 text-[11.5px] font-semibold text-ink">Lowest price</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, cell]) => (
            <tr key={label} className="border-t border-line">
              <th scope="row" className="p-1 text-left align-top text-[12px] font-medium text-muted">
                {label}
              </th>
              {items.map((p) => (
                <td key={p.id} className="break-words p-1 align-top text-ink" data-testid={label === 'Price' ? `a2ui-compare-price-${p.id}` : undefined}>
                  {cell(p)}
                </td>
              ))}
            </tr>
          ))}
          <tr className="border-t border-line">
            <td />
            {items.map((p) => (
              <td key={p.id} className="p-1 pt-2">
                <button type="button" className={cn(smallBtn, 'w-full bg-board text-white hover:bg-board-strong')} aria-label={`Add ${p.name} to cart`} onClick={() => onAdd(p.id)}>
                  <Plus aria-hidden className="size-4" /> Add
                </button>
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </section>
  );
}

export function QuantityStepperView({ productId, qty, onSet, onRemove, onAdd }: { productId: string; qty: number; onSet: (q: number) => void; onRemove: () => void; onAdd: () => void }) {
  const p = getProduct(productId);
  if (!p) return <FallbackCard />;
  if (qty === 0) {
    return (
      <div className="flex items-center justify-between gap-2" data-a2ui="QuantityStepper" data-product-id={p.id}>
        <span className="text-[13px] text-muted">Not in your basket</span>
        <button type="button" className={cn(smallBtn, 'bg-board text-white hover:bg-board-strong')} aria-label={`Add ${p.name} to cart`} onClick={onAdd}>
          <Plus aria-hidden className="size-4" /> Add
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-a2ui="QuantityStepper" data-product-id={p.id}>
      <div className="inline-flex items-center rounded-full border border-field bg-surface" role="group" aria-label={`Quantity of ${p.name}`}>
        <button type="button" className={cn(smallBtn, 'size-9 px-0 text-ink hover:bg-board-soft')} aria-label={`Decrease ${p.name}`} disabled={qty <= 1} onClick={() => onSet(qty - 1)} data-testid={`a2ui-dec-${p.id}`}>
          <Minus aria-hidden className="size-4" />
        </button>
        <span className="tabular w-7 text-center text-[14px] font-semibold" data-testid={`a2ui-qty-${p.id}`} aria-live="polite">
          {qty}
        </span>
        <button type="button" className={cn(smallBtn, 'size-9 px-0 text-ink hover:bg-board-soft')} aria-label={`Increase ${p.name}`} disabled={qty >= MAX_QTY} onClick={() => onSet(qty + 1)} data-testid={`a2ui-inc-${p.id}`}>
          <Plus aria-hidden className="size-4" />
        </button>
      </div>
      <button type="button" className={cn(smallBtn, 'size-9 px-0 text-muted hover:bg-danger-soft hover:text-danger')} aria-label={`Remove ${p.name}`} onClick={onRemove}>
        <Trash2 aria-hidden className="size-4" />
      </button>
    </div>
  );
}

export function CartSummaryView({ cart, stepper }: { cart: CartSnapshot; stepper: (productId: string, qty: number) => ReactNode }) {
  return (
    <section className={cn(card, 'flex flex-col p-3.5')} data-a2ui="CartSummary">
      <div className="flex items-center justify-between">
        <h4 className={title}>Your basket</h4>
        <span className="tabular rounded-full bg-board-soft px-2.5 py-0.5 text-[13px] font-semibold text-board" data-testid="a2ui-cart-count">
          {cart.itemCount} {cart.itemCount === 1 ? 'item' : 'items'}
        </span>
      </div>
      {cart.items.length === 0 ? (
        <div className="mt-3 flex flex-col items-center gap-1.5 rounded-tile bg-sunken px-4 py-6 text-center">
          <ShoppingBasket aria-hidden className="size-7 text-muted" />
          <p className="font-semibold text-ink">Your basket is empty</p>
          <p className="text-[13px] text-muted">Try &quot;search tea&quot;.</p>
        </div>
      ) : (
        <ul className="mt-1 divide-y divide-line">
          {cart.items.map((i) => {
            const p = getProduct(i.productId);
            if (!p) return null;
            return (
              <li key={p.id} className="flex flex-col gap-1.5 py-2.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2.5 text-[14px] font-medium text-ink">
                    <ProductImage productId={p.id} className="size-11 shrink-0 rounded-xl" emojiClassName="text-[22px]" />
                    <span className="min-w-0">{p.name}</span>
                  </span>
                  <span className="tabular shrink-0 text-[14px] font-semibold text-ink">{formatKES(p.priceKES * i.qty)}</span>
                </div>
                {stepper(p.id, i.qty)}
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-2 flex items-baseline justify-between border-t border-dashed border-line-strong pt-2.5">
        <span className="text-[14px] text-muted">Subtotal</span>
        <strong className="font-display tabular text-[20px] font-semibold text-ink" data-testid="a2ui-cart-total">
          {formatKES(cart.subtotalKES)}
        </strong>
      </div>
    </section>
  );
}

/** counts: per-category counts of the products shown with the chips (server derived, AC-L16); absent = whole catalog. */
export function FilterChipsView({ categories, counts, selected, onPick }: { categories: string[]; counts?: number[]; selected?: string; onPick: (c: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Shop by category" data-a2ui="FilterChips">
      {categories.map((c, i) => {
        const n = counts?.[i] ?? PRODUCTS.filter((p) => p.category === c).length;
        return (
          <button
            key={c}
            type="button"
            aria-pressed={c === selected}
            data-chip-category={c}
            data-chip-count={n}
            className={cn(
              'pressable h-9 cursor-pointer rounded-full border px-3 text-[13px] font-medium',
              c === selected ? 'border-board bg-board text-white' : 'border-line bg-surface text-ink hover:border-board hover:text-board',
            )}
            onClick={() => onPick(c)}
          >
            {c} <span className={cn('tabular', c === selected ? 'text-white/80' : 'text-muted')}>{n}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Always shows the "Go to checkout" button (AC-L15); with an empty basket it is disabled and a fixed line says why. */
export function CheckoutHandoffView({ cart, onContinue }: { cart: CartSnapshot; onContinue: () => void }) {
  return (
    <section className={cn(card, 'flex flex-col gap-2.5 p-3.5')} data-a2ui="CheckoutHandoff">
      <div className="flex items-baseline justify-between">
        <h4 className={title}>Ready to check out?</h4>
        <strong className="font-display tabular text-[20px] font-semibold text-ink" data-testid="a2ui-handoff-total">
          {formatKES(cart.subtotalKES)}
        </strong>
      </div>
      <p className="flex items-start gap-2 rounded-tile bg-sun-soft px-3 py-2 text-[13.5px] leading-snug text-ink">
        <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-board" />
        The assistant cannot pay. On the checkout page you check the total and tap Pay yourself.
      </p>
      {cart.itemCount === 0 ? (
        <p className="text-[13.5px] text-muted" data-testid="a2ui-handoff-empty">
          Your basket is empty. Add something first.
        </p>
      ) : null}
      <button
        type="button"
        className="pressable inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-xl bg-board px-4 text-[15px] font-semibold text-white hover:bg-board-strong disabled:cursor-not-allowed disabled:opacity-55"
        data-testid="a2ui-go-checkout"
        disabled={cart.itemCount === 0}
        onClick={onContinue}
      >
        Go to checkout <ArrowRight aria-hidden className="size-4" />
      </button>
    </section>
  );
}

const STATE_LABEL: Record<OrderSnapshot['state'], { label: string; cls: string }> = {
  pending: { label: 'Waiting for payment', cls: 'bg-warn-soft text-warn' },
  paid: { label: 'Paid', cls: 'bg-board-soft text-board' },
  failed: { label: 'Payment failed', cls: 'bg-danger-soft text-danger' },
  cancelled: { label: 'Cancelled', cls: 'bg-sunken text-muted' },
};

export function OrderStatusCardView({ orderId, order }: { orderId: string; order?: OrderSnapshot }) {
  if (!order) return <FallbackCard />;
  const s = STATE_LABEL[order.state];
  return (
    <section className={cn(card, 'flex flex-col gap-2 p-3.5')} data-a2ui="OrderStatusCard" data-state={order.state}>
      <div className="flex items-center justify-between gap-2">
        <h4 className={title}>Order {orderId.slice(0, 12)}</h4>
        <span className={cn('rounded-full px-2.5 py-0.5 text-[13px] font-semibold', s.cls)}>{s.label}</span>
      </div>
      {order.productIds?.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Items in this order" data-testid="a2ui-order-items">
          {order.productIds.slice(0, 6).map((id) => (
            <li key={id}>
              <ProductImage productId={id} className="size-10 rounded-lg" emojiClassName="text-[20px]" />
            </li>
          ))}
        </ul>
      ) : null}
      <p className="tabular text-[14px] text-muted">
        {order.itemCount} {order.itemCount === 1 ? 'item' : 'items'}, {formatKES(order.amountKES)}
      </p>
      {/* Internal path built from a validated order id; never a URL from the message. */}
      <a href={`/orders/${encodeURIComponent(orderId)}`} className="text-[14px] font-semibold text-board underline underline-offset-4">
        Open order page
      </a>
    </section>
  );
}

export function FallbackCard() {
  return (
    <div className="flex items-start gap-2 rounded-card border border-line-strong bg-sunken px-3.5 py-3 text-[14px] text-ink" role="status" data-testid="a2ui-fallback">
      <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
      <span>
        <strong className="block">I could not show that.</strong>
        <span className="text-[13px] text-muted">That reply used something this shop does not allow, so it was not shown. Try asking another way.</span>
      </span>
    </div>
  );
}
