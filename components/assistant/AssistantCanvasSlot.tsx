'use client';
// Client only: the A2UI renderer needs the DOM (it cannot server-render). Nothing shows until the first render.
import dynamic from 'next/dynamic';

const AssistantCanvas = dynamic(() => import('./AssistantCanvas'), { ssr: false, loading: () => null });

export default function AssistantCanvasSlot() {
  return <AssistantCanvas />;
}
