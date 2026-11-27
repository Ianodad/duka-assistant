import type { ReactNode } from 'react';
import SiteHeader from '@/components/SiteHeader';
import AssistantDrawer from '@/components/assistant/AssistantDrawer';
import AssistantCanvasSlot from '@/components/assistant/AssistantCanvasSlot';
import { testHooksEnabled } from '@/lib/assistant/mode';
import { modeInfo } from '@/lib/assistant/claude/config';

export default function Shell({ children, query }: { children: ReactNode; query?: string }) {
  return (
    <>
      <div id="shop-shell" className="assistant-dock">
        <SiteHeader query={query} />
        <main id="top" className="mx-auto flex max-w-[1240px] flex-col gap-8 px-4 py-6 md:px-6 md:py-8">
          {/* AC-L23: the assistant's cards render here, above the page content, hidden until the first render. */}
          <AssistantCanvasSlot />
          {children}
        </main>
        <footer className="mx-auto max-w-[1240px] px-4 pb-10 text-[13px] text-muted md:px-6">
          Prices in Kenya shillings. Payments by M-Pesa. You always tap Pay yourself.
        </footer>
      </div>
      {/* Planner mode from the server env at request time (pages are force-dynamic), never from the browser. */}
      <AssistantDrawer testHooks={testHooksEnabled()} mode={modeInfo()} />
    </>
  );
}
