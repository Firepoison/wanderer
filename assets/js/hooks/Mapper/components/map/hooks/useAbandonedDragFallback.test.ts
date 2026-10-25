import { renderHook } from '@testing-library/react';
import { MutableRefObject } from 'react';
import { useAbandonedDragFallback } from './useAbandonedDragFallback';

// jsdom has no PointerEvent; the hook only reads `pointerId`.
const pointer = (type: 'pointerdown' | 'pointerup' | 'pointercancel', pointerId: number) => {
  const event = new Event(type);
  Object.assign(event, { pointerId });
  window.dispatchEvent(event);
};

const setup = () => {
  const dragRef: MutableRefObject<object | null> = { current: null };
  const onAbandoned = jest.fn();
  const hook = renderHook(() => useAbandonedDragFallback(dragRef, onAbandoned));
  return { dragRef, onAbandoned, ...hook };
};

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('useAbandonedDragFallback', () => {
  it('reports a drag React Flow never ended once the last pointer is released', () => {
    const { dragRef, onAbandoned } = setup();
    pointer('pointerdown', 1);
    dragRef.current = {};

    pointer('pointerup', 1);
    jest.advanceTimersByTime(99);
    expect(onAbandoned).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);

    expect(onAbandoned).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when React Flow ends the drag on that release', () => {
    const { dragRef, onAbandoned } = setup();
    pointer('pointerdown', 1);
    dragRef.current = {};

    pointer('pointerup', 1);
    dragRef.current = null; // onNodeDragStop ran
    jest.runAllTimers();

    expect(onAbandoned).not.toHaveBeenCalled();
  });

  it('keeps a drag going while another finger is still down', () => {
    const { dragRef, onAbandoned } = setup();
    pointer('pointerdown', 1);
    pointer('pointerdown', 2);
    dragRef.current = {};

    pointer('pointerup', 2);
    jest.runAllTimers();
    expect(onAbandoned).not.toHaveBeenCalled();

    pointer('pointercancel', 1);
    jest.runAllTimers();
    expect(onAbandoned).toHaveBeenCalledTimes(1);
  });

  it('does not abandon a newer drag that started during the grace period', () => {
    const { dragRef, onAbandoned } = setup();
    pointer('pointerdown', 1);
    dragRef.current = {};

    pointer('pointerup', 1);
    dragRef.current = {}; // the old drag ended and a new one started
    jest.runAllTimers();

    expect(onAbandoned).not.toHaveBeenCalled();
  });

  it('does nothing when no drag is in progress', () => {
    const { onAbandoned } = setup();

    pointer('pointerdown', 1);
    pointer('pointerup', 1);
    jest.runAllTimers();

    expect(onAbandoned).not.toHaveBeenCalled();
  });

  it('stops listening when unmounted', () => {
    const { dragRef, onAbandoned, unmount } = setup();
    pointer('pointerdown', 1);
    dragRef.current = {};
    unmount();

    pointer('pointerup', 1);
    jest.runAllTimers();

    expect(onAbandoned).not.toHaveBeenCalled();
  });
});
