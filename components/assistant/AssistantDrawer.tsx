'use client';
/**
 * Assistant drawer, adapted from the spike. 1024px and wider: docked side
 * drawer, non-modal, the shop stays usable. Narrower: full-height sheet, modal,
 * the shop behind it is inert. Escape closes; focus goes to the input on open
 * and back to the opener on close.
 *
 * AC-L27: on mobile the sheet collapses after an answer with cards so the
 * main-area canvas is visible; a floating handle reopens the conversation.
 * Once there is a conversation the panel stays mounted while closed, because
 * it owns the action dispatcher the canvas card buttons use.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import dynamic from 'next/dynamic';
import { MessageCircle, ShieldCheck, X } from 'lucide-react';
import { assistantStore, useAssistant } from '@/lib/assistant/client-store';
import { cn } from '@/lib/utils';
import { subtitleFor, type SubtitleMode } from '@/lib/assistant/subtitle';

// Client only: the A2UI renderer needs the DOM (it cannot server-render).
const AssistantPanel = dynamic(() => import('./AssistantPanel'), {
  ssr: false,
  loading: () => (
    <div className="flex flex-1 items-center justify-center p-6 text-[14px] text-muted" role="status">
      Loading assistant...
    </div>
  ),
});

function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const on = () => setDesktop(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return desktop;
}

export default function AssistantDrawer({ testHooks, mode }: { testHooks: boolean; mode: SubtitleMode }) {
  const open = useAssistant((s) => s.open);
  const hasTurns = useAssistant((s) => s.turns.length > 0);
  const desktop = useIsDesktop();
  const modal = open && !desktop;
  const ref = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const [mounted, setMounted] = useState(open || hasTurns);

  useEffect(() => {
    if (open || hasTurns) setMounted(true);
  }, [open, hasTurns]);

  useEffect(() => {
    document.body.dataset.assistantOpen = String(open);
    const shell = document.getElementById('shop-shell');
    if (shell) shell.inert = modal;
    document.documentElement.style.overflow = modal ? 'hidden' : '';
    return () => {
      if (shell) shell.inert = false;
      document.documentElement.style.overflow = '';
    };
  }, [open, modal]);

  useEffect(() => {
    if (open) {
      const active = document.activeElement as HTMLElement | null;
      if (active && !ref.current?.contains(active)) returnTo.current = active;
      let tries = 0;
      const focusInput = () => {
        const el = ref.current?.querySelector<HTMLInputElement>('[data-testid=assistant-input]');
        if (el) el.focus({ preventScroll: true });
        else if (tries++ < 60) setTimeout(focusInput, 50);
      };
      focusInput();
    } else {
      const el = returnTo.current;
      returnTo.current = null;
      if (el && el.isConnected) el.focus({ preventScroll: true });
      else if (ref.current?.contains(document.activeElement)) document.querySelector<HTMLElement>('[data-testid=assistant-open]')?.focus({ preventScroll: true });
    }
  }, [open]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      assistantStore.setOpen(false);
    }
  }

  return (
    <>
      <div
        aria-hidden
        className={cn('fixed inset-0 z-40 bg-ink/45 transition-opacity duration-200 lg:hidden', open ? 'opacity-100' : 'pointer-events-none opacity-0')}
        onClick={() => assistantStore.setOpen(false)}
      />
      <div
        id="assistant-drawer"
        ref={ref}
        role="dialog"
        aria-modal={modal}
        aria-labelledby="assistant-title"
        aria-describedby="assistant-subtitle"
        data-testid="assistant-drawer"
        data-open={open}
        inert={!open}
        onKeyDown={onKeyDown}
        className="assistant-drawer fixed inset-x-0 bottom-0 top-3 z-50 flex flex-col overflow-hidden rounded-t-[24px] bg-page shadow-drawer lg:inset-y-0 lg:left-auto lg:right-0 lg:top-0 lg:w-[var(--drawer-w)] lg:rounded-none lg:border-l lg:border-line"
      >
        <div className="flex items-center gap-3 border-b border-line bg-surface px-4 py-3">
          <span aria-hidden className="font-display grid size-10 shrink-0 place-items-center rounded-xl bg-board text-[19px] font-bold text-sun">
            D
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="assistant-title" className="font-display text-[18px] font-semibold leading-tight">
              Duka assistant
            </h2>
            <p id="assistant-subtitle" data-testid="assistant-subtitle" data-planner={mode.planner} data-client={mode.client} className="flex items-center gap-1 text-[12.5px] text-muted">
              <ShieldCheck aria-hidden className="size-3.5 shrink-0" />
              {subtitleFor(mode)}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close assistant"
            data-testid="assistant-close"
            className="pressable grid size-11 shrink-0 cursor-pointer place-items-center rounded-full text-ink hover:bg-board-soft"
            onClick={() => assistantStore.setOpen(false)}
          >
            <X aria-hidden className="size-5" />
          </button>
        </div>
        {mounted ? <AssistantPanel testHooks={testHooks} /> : null}
      </div>
      {/* Mobile handle of the collapsed chat sheet: reopens the conversation (AC-L27). */}
      {!desktop && !open && hasTurns ? (
        <button
          type="button"
          data-testid="assistant-sheet-handle"
          aria-controls="assistant-drawer"
          aria-expanded={false}
          onClick={() => assistantStore.setOpen(true)}
          className="pressable fixed bottom-[max(16px,env(safe-area-inset-bottom))] right-4 z-40 inline-flex h-12 cursor-pointer items-center gap-2 rounded-full bg-board px-4 text-[15px] font-semibold text-white shadow-drawer hover:bg-board-strong"
        >
          <MessageCircle aria-hidden className="size-5" />
          Chat
        </button>
      ) : null}
    </>
  );
}
