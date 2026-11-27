'use client';
import { Sparkles } from 'lucide-react';
import { assistantStore, useAssistant } from '@/lib/assistant/client-store';

/** Header button that opens the assistant drawer on every shop page. */
export default function AssistantButton() {
  const open = useAssistant((s) => s.open);
  return (
    <button
      type="button"
      data-testid="assistant-open"
      aria-controls="assistant-drawer"
      aria-expanded={open}
      aria-haspopup="dialog"
      className="pressable inline-flex h-11 cursor-pointer items-center gap-2 rounded-full border border-field bg-surface px-3 text-[14px] font-semibold text-ink hover:border-board sm:px-3.5 hover:text-board"
      onClick={() => assistantStore.setOpen(!open)}
    >
      <Sparkles aria-hidden className="size-[18px]" />
      <span className="sr-only sm:not-sr-only">Assistant</span>
    </button>
  );
}
