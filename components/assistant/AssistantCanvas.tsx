'use client';
/**
 * Client wrapper of the main-area canvas (AC-L23): reads the canvas state from
 * the assistant store and renders the surfaces of the newest render from the
 * shared A2UI processor with A2uiSurface. Validation already happened in the
 * panel gate (panel-gate.ts) before any surface reached the processor.
 */
import { A2uiSurface } from '@a2ui/react';
import { getProcessor } from '@/lib/a2ui/client-processor';
import { useAssistant } from '@/lib/assistant/client-store';
import { backToShop } from '@/lib/assistant/canvas-focus';
import { CanvasView } from './CanvasView';

export default function AssistantCanvas() {
  const canvas = useAssistant((s) => s.canvas);
  const hidden = useAssistant((s) => s.canvasHidden);
  const loading = useAssistant((s) => s.loading);
  return (
    <CanvasView
      canvas={canvas}
      hidden={hidden}
      loading={loading}
      onBack={backToShop}
      renderSurface={(sid) => {
        const surface = getProcessor().getSurface(sid);
        return surface ? <A2uiSurface surface={surface as never} /> : null;
      }}
    />
  );
}
