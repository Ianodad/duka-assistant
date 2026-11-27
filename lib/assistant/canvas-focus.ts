/**
 * Pointer line and Back to shop behaviour for the main-area canvas (AC-L24, AC-L25, AC-L27).
 * Browser only. No text in here: copy comes from lib/assistant/canvas.ts.
 */
import { assistantStore } from '@/lib/assistant/client-store';

export const CANVAS_ID = 'assistant-canvas';

const desktop = () => window.matchMedia('(min-width: 1024px)').matches;
const smooth = (): ScrollBehavior => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

/** Scroll to and focus the canvas. On mobile the chat sheet collapses first so the cards are visible. */
export function focusCanvas(): void {
  assistantStore.showCanvas();
  const collapse = !desktop() && assistantStore.get().open;
  if (collapse) assistantStore.setOpen(false);
  // After the sheet closes (the drawer returns focus to its opener and lifts inert on commit), move focus here.
  window.setTimeout(
    () => {
      const el = document.getElementById(CANVAS_ID);
      if (!el) return;
      el.scrollIntoView({ behavior: smooth(), block: 'start' });
      el.focus({ preventScroll: true });
    },
    collapse ? 60 : 0,
  );
}

/** Back to shop: hide the canvas and bring the normal catalogue back into view (the conversation is kept). */
export function backToShop(): void {
  assistantStore.hideCanvas();
  window.setTimeout(() => {
    const target = document.getElementById('products') ?? document.getElementById('top');
    target?.scrollIntoView({ behavior: smooth(), block: 'start' });
  }, 0);
}
