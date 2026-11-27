'use client';
/**
 * Assistant panel (the chat). Sends shopper text to /api/assistant and
 * allowlisted actions to /api/assistant/action, validates every A2UI batch it
 * receives with validateA2ui() and feeds accepted batches into the shared strict
 * @a2ui/web_core MessageProcessor. The cards render in the main-area canvas
 * (AssistantCanvas, AC-L23); the chat is conversation only: bubbles, trusted
 * reply text and a pointer line per turn (AC-L25). Anything rejected shows the
 * fallback card in the chat and leaves the canvas as it is. Nothing here can
 * pay: go_to_checkout only does a client navigation to /checkout, where the
 * shopper taps Pay.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowUp } from 'lucide-react';
import { CHECKOUT_PATH, type ActionCall } from '@/lib/a2ui/actions';
import { getProcessor } from '@/lib/a2ui/client-processor';
import { gateInjected, gateResponse } from '@/lib/a2ui/panel-gate';
import { focusCanvas } from '@/lib/assistant/canvas-focus';
import { assistantStore, useAssistant } from '@/lib/assistant/client-store';
import type { AssistantResponse, CartSnapshot } from '@/lib/assistant/types';
import { isNoteKey } from '@/lib/assistant/notes';
import { AssistantTurn } from '@/components/assistant/AssistantTurn';

const PROMPTS = ['search tea', 'show flour', 'compare ketepa and kericho gold', 'show cart', 'checkout', 'order status'];
const WELCOME = [
  { label: 'Find tea', text: 'search tea' },
  { label: 'Compare two teas', text: 'compare ketepa and kericho gold' },
  { label: 'Add 2 unga', text: 'add 2 unga' },
  { label: 'Browse categories', text: 'help' },
];

declare global {
  interface Window {
    __dukaAssistantTest?: { inject: (raw: unknown) => { ok: boolean; codes: string[] } };
  }
}

let seq = 0;
const nextTurn = () => ++seq;

const sameCart = (a: CartSnapshot, b: CartSnapshot) => a.itemCount === b.itemCount && a.subtotalKES === b.subtotalKES && JSON.stringify(a.items) === JSON.stringify(b.items);

export default function AssistantPanel({ testHooks }: { testHooks: boolean }) {
  const router = useRouter();
  const turns = useAssistant((s) => s.turns);
  const busy = useAssistant((s) => s.busy);
  const canvasTurn = useAssistant((s) => s.canvas?.turnId);
  const [input, setInput] = useState('');
  const [live, setLive] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());

  const handle = useCallback(
    (res: AssistantResponse, turn: number, quiet: boolean) => {
      const before = assistantStore.get().cart;
      assistantStore.setSnapshot(res.cart, res.orders);
      if (!sameCart(before, res.cart)) router.refresh();
      const out = gateResponse(getProcessor(), res);
      // Only an allowlisted note key is kept; the words come from NOTE_TEXT, never from the response.
      const note = isNoteKey(res.note) ? res.note : undefined;
      if (!quiet || out.rejected || out.surfaceIds.length || note) {
        assistantStore.addTurn(
          { id: `a${turn}`, role: 'assistant', text: out.text, surfaceIds: out.surfaceIds, rejected: out.rejected, note, ...(out.canvas ? { pointer: out.canvas.pointer } : {}) },
          out.replaced,
          out.slotNotes,
          out.canvas?.title,
        );
      }
      setLive(out.text);
      if (res.navigate === CHECKOUT_PATH) {
        assistantStore.setOpen(false);
        // The checkout page has the real form; the handoff card is not repeated above it.
        assistantStore.hideCanvas();
        router.push(CHECKOUT_PATH); // the only navigation target, a constant
      } else if (!out.rejected && out.surfaceIds.length && !quiet) {
        // AC-L27: new cards are in the main view. On mobile the chat sheet collapses so they are visible.
        if (!window.matchMedia('(min-width: 1024px)').matches) focusCanvas();
      }
    },
    [router],
  );

  const post = useCallback(
    (url: string, body: unknown, turn: number, quiet = false, loading = false) => {
      const job = async () => {
        assistantStore.setBusy(true);
        // Only shopper messages show the canvas skeleton; card button taps keep the cards in view.
        if (loading) assistantStore.setLoading(true);
        try {
          const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          if (!r.ok) throw new Error(`status ${r.status}`);
          handle((await r.json()) as AssistantResponse, turn, quiet);
        } catch {
          assistantStore.addTurn({ id: `e${turn}`, role: 'assistant', text: 'Something went wrong. Please try again.', surfaceIds: [], error: true });
          setLive('Something went wrong. Please try again.');
        } finally {
          assistantStore.setBusy(false);
          if (loading) assistantStore.setLoading(false);
        }
      };
      queue.current = queue.current.then(job, job);
      return queue.current;
    },
    [handle],
  );

  const send = useCallback(
    (text: string) => {
      const turn = nextTurn();
      assistantStore.addTurn({ id: `u${turn}`, role: 'user', text, surfaceIds: [] });
      return post('/api/assistant', { text, turn }, turn, false, true);
    },
    [post],
  );

  // Every component button ends up here, already allowlisted and parsed.
  useEffect(() => {
    assistantStore.setDispatcher((call: ActionCall) => {
      const turn = nextTurn();
      void post('/api/assistant/action', { name: call.name, payload: call.payload, turn }, turn, call.name === 'set_quantity');
    });
    return () => assistantStore.setDispatcher(null);
  }, [post]);

  // Initial cart snapshot from the week 1 cart API (server computed).
  useEffect(() => {
    void fetch('/api/cart')
      .then((r) => r.json())
      .then((c: CartSnapshot) => assistantStore.setSnapshot({ items: c.items.map((i) => ({ productId: i.productId, qty: i.qty })), itemCount: c.itemCount, subtotalKES: c.subtotalKES }))
      .catch(() => {});
  }, []);

  // Mock-mode test seam: push a raw batch through the same client gate (e2e fallback check).
  useEffect(() => {
    if (!testHooks) return;
    window.__dukaAssistantTest = {
      inject(raw: unknown) {
        const turn = nextTurn();
        const out = gateInjected(getProcessor(), raw);
        assistantStore.addTurn({ id: `i${turn}`, role: 'assistant', text: '', surfaceIds: out.surfaceIds, rejected: out.rejected });
        return { ok: !out.rejected, codes: out.codes };
      },
    };
    return () => {
      delete window.__dukaAssistantTest;
    };
  }, [testHooks]);

  // On (re)mount, for example after a page navigation, jump straight to the newest turn.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // AC-L15: keep the newest card (and the CheckoutHandoff button) inside the visible log.
  // Root cause of the live-demo bug: this used to scroll once when turns/busy changed, but
  // A2uiSurface renders null on its first commit (its useSyncExternalStore snapshot exists only
  // after its subscribe effect), so the card mounted one render later, after the scroll, and the
  // log stopped short of it. Now the log stays pinned to the end while content grows (surface
  // mount, in-place card updates, image loads), until the shopper scrolls away themselves.
  const pinned = useRef(true);
  const toEnd = useCallback((smooth: boolean) => {
    const el = listRef.current;
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reduce ? 'smooth' : 'auto' });
  }, []);

  useEffect(() => {
    pinned.current = true;
    toEnd(true);
  }, [turns, busy, toEnd]);

  useEffect(() => {
    const el = listRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const follow = () => {
      if (pinned.current) toEnd(false);
    };
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(follow);
    ro?.observe(content);
    // Images inside cards: a late load can change height; load does not bubble, so capture it.
    el.addEventListener('load', follow, true);
    // Only the shopper's own scroll gestures unpin; programmatic scrolls do not fire these.
    const unpin = () => {
      pinned.current = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) unpin();
    };
    const onScroll = () => {
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 8) pinned.current = true;
    };
    el.addEventListener('wheel', unpin, { passive: true });
    el.addEventListener('touchmove', unpin, { passive: true });
    el.addEventListener('keydown', onKey);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      ro?.disconnect();
      el.removeEventListener('load', follow, true);
      el.removeEventListener('wheel', unpin);
      el.removeEventListener('touchmove', unpin);
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('scroll', onScroll);
    };
  }, [toEnd]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const text = input.trim().slice(0, 300);
    if (!text || busy) return;
    setInput('');
    void send(text);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="assistant">
      <p className="sr-only" aria-live="polite" data-testid="assistant-live">
        {live}
      </p>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3.5 py-4" ref={listRef} role="region" aria-label="Conversation" tabIndex={-1} data-testid="assistant-log">
        {turns.length === 0 ? (
          <div className="flex flex-col gap-4 px-1 pt-1" data-testid="assistant-welcome">
            <div>
              <p className="font-display text-[22px] font-semibold leading-tight">Habari! What do you need today?</p>
              <p className="mt-1.5 text-[14px] text-muted">I can find products, compare prices and fill your basket. You tap Pay yourself on the checkout page.</p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {WELCOME.map((p) => (
                <button
                  key={p.text}
                  type="button"
                  disabled={busy}
                  className="pressable flex min-h-[64px] cursor-pointer flex-col items-start justify-between gap-1 rounded-2xl border border-line bg-surface p-3 text-left hover:border-board"
                  onClick={() => void send(p.text)}
                >
                  <span className="text-[14px] font-semibold text-ink">{p.label}</span>
                  <span className="text-[12.5px] text-muted">&quot;{p.text}&quot;</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="flex flex-col gap-3" ref={contentRef}>
          {turns.map((t) =>
            t.role === 'user' ? (
              <div key={t.id} className="flex justify-end" data-testid="turn-user">
                <p className="max-w-[85%] break-words rounded-2xl rounded-br-md bg-board px-3.5 py-2 text-[15px] leading-snug text-white">{t.text}</p>
              </div>
            ) : (
              <AssistantTurn key={t.id} turn={t} current={t.id === canvasTurn} onPointer={focusCanvas} />
            ),
          )}
          {busy ? (
            <div className="flex h-9 w-fit items-center gap-1 rounded-2xl rounded-bl-md border border-line bg-surface px-3.5" data-testid="assistant-typing" aria-hidden>
              <span className="pulse-dot size-1.5 rounded-full bg-muted" />
              <span className="pulse-dot size-1.5 rounded-full bg-muted [animation-delay:150ms]" />
              <span className="pulse-dot size-1.5 rounded-full bg-muted [animation-delay:300ms]" />
            </div>
          ) : null}
        </div>
      </div>

      <div className="border-t border-line bg-surface px-3 pb-[max(12px,env(safe-area-inset-bottom))] pt-2.5">
        <ul className="-mx-3 mb-2.5 flex gap-1.5 overflow-x-auto px-3 [scrollbar-width:none]" aria-label="Suggested prompts">
          {PROMPTS.map((q) => (
            <li key={q} className="shrink-0">
              <button
                type="button"
                className="pressable h-8 cursor-pointer rounded-full border border-line bg-sunken px-3 text-[13px] text-ink hover:border-board hover:text-board disabled:cursor-not-allowed disabled:opacity-55"
                disabled={busy}
                onClick={() => void send(q)}
              >
                {q}
              </button>
            </li>
          ))}
        </ul>
        <form className="flex items-center gap-2" onSubmit={onSubmit}>
          <label htmlFor="assistant-input" className="sr-only">
            Message the assistant
          </label>
          <input
            id="assistant-input"
            data-testid="assistant-input"
            value={input}
            maxLength={300}
            onChange={(e) => setInput(e.target.value)}
            placeholder='Try "compare ketepa and kericho gold"'
            autoComplete="off"
            enterKeyHint="send"
            className="h-12 min-w-0 flex-1 rounded-full border border-field bg-surface px-4 text-[15px] text-ink placeholder:text-muted focus:border-board"
          />
          <button
            type="submit"
            aria-label="Send message"
            data-testid="assistant-send"
            className="pressable grid size-12 shrink-0 cursor-pointer place-items-center rounded-full bg-board text-white hover:bg-board-strong disabled:cursor-not-allowed disabled:opacity-55"
            disabled={busy}
          >
            <ArrowUp aria-hidden className="size-5" />
          </button>
        </form>
      </div>
    </div>
  );
}
