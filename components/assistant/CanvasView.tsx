/**
 * Main-area assistant canvas (SPEC-LIVE AC-L23, AC-L24), as a pure view so unit
 * tests can render it on the server. `renderSurface` is A2uiSurface in the
 * client wrapper (AssistantCanvas); tests pass a stub.
 *
 * Hidden until the first render (or a request in flight). The title row is
 * fixed trusted copy plus server data (canvasTitleText). A new render remounts
 * the body under a new `rev` key (short fade, CSS, off for reduced motion); a
 * true follow-up keeps the body and the card nodes (keys are surface id and
 * rev only) and bumps `pulse`, which remounts only a stateless highlight overlay.
 */
import type { ReactNode } from 'react';
import { ArrowLeft, Sparkles } from 'lucide-react';
import { canvasTitleText } from '@/lib/assistant/canvas';
import type { CanvasState } from '@/lib/assistant/client-store';
import { CANVAS_ID } from '@/lib/assistant/canvas-focus';

/** Placeholder while a shopper message is in flight. Fixed trusted markup only, no model text (AC-L17, AC-L25). */
export function CanvasSkeleton() {
  return (
    <div className="grid gap-3 @2xl:grid-cols-2" data-testid="assistant-skeleton" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-3 rounded-card border border-line bg-surface p-3">
          <div className="size-16 shrink-0 animate-pulse rounded-xl bg-sunken" />
          <div className="flex flex-1 flex-col gap-1.5">
            <div className="h-3 w-3/5 animate-pulse rounded-full bg-sunken" />
            <div className="h-3 w-2/5 animate-pulse rounded-full bg-sunken" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function CanvasView({
  canvas,
  hidden,
  loading,
  renderSurface,
  onBack,
}: {
  canvas: CanvasState | null;
  hidden: boolean;
  loading: boolean;
  renderSurface: (surfaceId: string) => ReactNode;
  onBack?: () => void;
}) {
  if (!loading && (!canvas || hidden)) return null;
  const title = loading ? 'Loading' : canvas?.title ? canvasTitleText(canvas.title) : 'From the assistant';
  return (
    <section
      id={CANVAS_ID}
      tabIndex={-1}
      aria-labelledby="assistant-canvas-title"
      aria-busy={loading}
      data-testid="assistant-canvas"
      data-rev={canvas?.rev ?? 0}
      data-pulse={canvas?.pulse ?? 0}
      className="@container scroll-mt-24 rounded-board border border-line bg-board-soft/50 p-3 outline-none focus-visible:ring-2 focus-visible:ring-board sm:p-4"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="assistant-canvas-title" data-testid="canvas-title" data-title-key={loading ? 'loading' : (canvas?.title?.key ?? 'none')} className="font-display flex min-w-0 items-center gap-2 text-[20px] font-semibold leading-tight tracking-tight">
          <Sparkles aria-hidden className="size-[18px] shrink-0 text-board" />
          <span className="truncate">{title}</span>
        </h2>
        {onBack ? (
          <button
            type="button"
            data-testid="canvas-back"
            onClick={onBack}
            className="pressable inline-flex h-10 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-field bg-surface px-3.5 text-[14px] font-semibold text-ink hover:border-board hover:text-board"
          >
            <ArrowLeft aria-hidden className="size-4" />
            Back to shop
          </button>
        ) : null}
      </div>
      {loading ? <CanvasSkeleton /> : null}
      {/* The body stays mounted while loading (hidden), so a true follow-up updates in place without a swap. */}
      {canvas ? (
        <div key={canvas.rev} hidden={loading || hidden} className="canvas-swap flex min-w-0 flex-col gap-3" data-testid="canvas-body" data-turn-id={canvas.turnId}>
          {canvas.surfaceIds.map((sid) => (
            // Keyed by surface id only (inside the rev-keyed body): a true follow-up keeps the same card nodes
            // and their state. The highlight is a separate stateless overlay keyed by pulse, so a new pulse
            // restarts its CSS animation without touching the card.
            <div key={sid} className="relative min-w-0 rounded-card" data-surface-id={sid} data-pulse={canvas.pulse}>
              {renderSurface(sid)}
              {canvas.pulse ? <span key={`pulse-${canvas.pulse}`} aria-hidden data-testid="canvas-pulse" className="canvas-pulse pointer-events-none absolute inset-0 rounded-card" /> : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
