'use client';
/**
 * React implementations of the 8 Duka A2UI components, registered with
 * @a2ui/react through a web_core Catalog. They render the pure views in
 * components/assistant/views.tsx. Built-in buttons (stepper, chips, compare,
 * cart) dispatch fixed allowlisted actions with ids from validated props.
 * Agent-wired actions (ProductCard.onAdd, CheckoutHandoff.onContinue) arrive as
 * functions resolved by the library and go through the processor's action
 * listener, which re-checks them against the allowlist.
 */
import type { ReactNode } from 'react';
import { createComponentImplementation, type ReactA2uiComponentProps } from '@a2ui/react';
import { Catalog, type ResolvedChildRef } from '@a2ui/web_core';
import {
  A2UI_VERSION,
  CartSummaryApi,
  CheckoutHandoffApi,
  CompareTableApi,
  DUKA_CATALOG_ID,
  FilterChipsApi,
  OrderStatusCardApi,
  ProductCardApi,
  ProductGridApi,
  QuantityStepperApi,
} from '@/lib/a2ui/catalog-api';
import type { Heading } from '@/lib/a2ui/trusted-text';
import { assistantStore, useAssistant } from '@/lib/assistant/client-store';
import {
  CartSummaryView,
  CheckoutHandoffView,
  CompareTableView,
  FilterChipsView,
  OrderStatusCardView,
  ProductCardView,
  ProductGridView,
  QuantityStepperView,
} from '@/components/assistant/views';

type BuildChild = ReactA2uiComponentProps<unknown>['buildChild'];
const d = assistantStore.dispatch;

function children(list: (string | ResolvedChildRef)[] | undefined, buildChild: BuildChild): ReactNode[] {
  return (list ?? []).map((c, i) => (typeof c === 'string' ? <div key={c}>{buildChild(c)}</div> : <div key={`${c.id}-${i}`}>{buildChild(c.id, c.basePath)}</div>));
}

function Stepper({ productId }: { productId: string }) {
  const qty = useAssistant((s) => s.cart.items.find((i) => i.productId === productId)?.qty ?? 0);
  return (
    <QuantityStepperView
      productId={productId}
      qty={qty}
      onSet={(q) => d({ name: 'set_quantity', payload: { productId, qty: q } })}
      onRemove={() => d({ name: 'remove_from_cart', payload: { productId } })}
      onAdd={() => d({ name: 'add_to_cart', payload: { productId } })}
    />
  );
}

function CardWithCart({ productId, badge, onAdd }: { productId: string; badge?: string; onAdd?: () => void }) {
  const inCart = useAssistant((s) => s.cart.items.find((i) => i.productId === productId)?.qty ?? 0);
  return <ProductCardView productId={productId} badge={badge} inCart={inCart} onAdd={onAdd} />;
}

function Cart() {
  const cart = useAssistant((s) => s.cart);
  return <CartSummaryView cart={cart} stepper={(id) => <Stepper productId={id} />} />;
}

/** AC-L15: the handoff always has its button. Without a wired action it dispatches the fixed, allowlisted go_to_checkout. */
function Handoff({ onContinue }: { onContinue?: () => void }) {
  const cart = useAssistant((s) => s.cart);
  return <CheckoutHandoffView cart={cart} onContinue={onContinue ?? (() => d({ name: 'go_to_checkout', payload: {} }))} />;
}

function Order({ orderId }: { orderId: string }) {
  const order = useAssistant((s) => s.orders.find((o) => o.id === orderId));
  return <OrderStatusCardView orderId={orderId} order={order} />;
}

const ProductGrid = createComponentImplementation(ProductGridApi, ({ props, buildChild }) => (
  <ProductGridView heading={props.heading as Heading | undefined}>{children(props.children as (string | ResolvedChildRef)[], buildChild)}</ProductGridView>
));

const ProductCard = createComponentImplementation(ProductCardApi, ({ props }) => {
  const fire = props.onAdd as unknown as (() => void) | undefined;
  return <CardWithCart productId={String(props.productId)} badge={props.badge} onAdd={typeof fire === 'function' ? () => void fire() : undefined} />;
});

const CompareTable = createComponentImplementation(CompareTableApi, ({ props }) => (
  <CompareTableView productIds={props.productIds as string[]} onAdd={(productId) => d({ name: 'add_to_cart', payload: { productId } })} />
));

const CartSummary = createComponentImplementation(CartSummaryApi, () => <Cart />);

const QuantityStepper = createComponentImplementation(QuantityStepperApi, ({ props }) => <Stepper productId={String(props.productId)} />);

const FilterChips = createComponentImplementation(FilterChipsApi, ({ props }) => (
  <FilterChipsView categories={props.categories as string[]} counts={props.counts as number[] | undefined} selected={props.selected} onPick={(category) => d({ name: 'apply_filter', payload: { category } })} />
));

const CheckoutHandoff = createComponentImplementation(CheckoutHandoffApi, ({ props }) => {
  const fire = props.onContinue as unknown as (() => void) | undefined;
  return <Handoff onContinue={typeof fire === 'function' ? () => void fire() : undefined} />;
});

const OrderStatusCard = createComponentImplementation(OrderStatusCardApi, ({ props }) => <Order orderId={String(props.orderId)} />);

export const dukaReactCatalog = new Catalog(DUKA_CATALOG_ID, A2UI_VERSION, [
  ProductGrid,
  ProductCard,
  CompareTable,
  CartSummary,
  QuantityStepper,
  FilterChips,
  CheckoutHandoff,
  OrderStatusCard,
]);
