import { MutableRefObject, useEffect } from 'react';

/**
 * React Flow ends an aborted drag (a second finger on a touch screen) without calling
 * onNodeDragStop/onSelectionDragStop. Once every pointer is released, this gives React Flow's own
 * stop handler — which runs on that same release, and clears `dragRef` — `delayMs`, and calls
 * `onAbandoned` if the same drag is still in `dragRef` after that. Tracking all pressed pointers
 * keeps lifting a second finger mid-drag from ending a drag that is still going.
 */
export const useAbandonedDragFallback = <T>(
  dragRef: MutableRefObject<T | null>,
  onAbandoned: () => void,
  delayMs = 100,
) => {
  useEffect(() => {
    const pressed = new Set<number>();
    const onDown = (e: PointerEvent) => pressed.add(e.pointerId);
    const onUp = (e: PointerEvent) => {
      pressed.delete(e.pointerId);
      const drag = dragRef.current;
      if (!drag || pressed.size > 0) {
        return;
      }
      setTimeout(() => {
        if (dragRef.current === drag) {
          onAbandoned();
        }
      }, delayMs);
    };

    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
    };
  }, [dragRef, onAbandoned, delayMs]);
};
