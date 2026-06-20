// Pointer-driven drag for timeline blocks: converts vertical pixel movement into
// a snapped minute delta, validating live and committing on release. Used by
// DayTimeline for both moving a block (shifting start+end) and resizing it
// (extending the end). Deliberately dependency-free — plain pointer events, so it
// works for mouse, touch, and pen without pulling in a drag library.
import { useCallback, useRef, useState } from 'react';

export type DragMode = 'move' | 'resize';

export interface DragState {
  uid: string;
  mode: DragMode;
  /** Snapped minutes shifted (move) or added to the end (resize); can be negative. */
  deltaMin: number;
  /** Whether the proposed placement currently validates (drives the red/valid UI). */
  valid: boolean;
}

interface DragArgs {
  /** Vertical scale of the timeline. */
  pxPerMin: number;
  /** Snap granularity in minutes (e.g. 15). */
  step: number;
  /** Is this delta an allowed placement? Drives live feedback + gates the commit. */
  validate: (uid: string, mode: DragMode, deltaMin: number) => boolean;
  /** Persist a finished drag (only called for a non-zero, valid delta). */
  commit: (uid: string, mode: DragMode, deltaMin: number) => void;
}

/**
 * Returns the in-flight `drag` (for rendering the ghost) and `dragProps(uid, mode)`
 * to spread onto a draggable element. Spread it on the block body for `move` and on
 * a small bottom-edge handle for `resize`; both capture their own pointer so the
 * gesture keeps tracking outside the element.
 */
export function useBlockDrag({ pxPerMin, step, validate, commit }: DragArgs) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const originY = useRef<number | null>(null);

  const start = useCallback((e: React.PointerEvent, uid: string, mode: DragMode) => {
    if (e.button > 0) return; // primary pointer only
    e.preventDefault();
    e.stopPropagation(); // a resize handle inside the block must not also start a move
    e.currentTarget.setPointerCapture?.(e.pointerId);
    originY.current = e.clientY;
    setDrag({ uid, mode, deltaMin: 0, valid: true });
  }, []);

  const move = useCallback(
    (e: React.PointerEvent) => {
      if (originY.current === null) return;
      const raw = (e.clientY - originY.current) / pxPerMin;
      const snapped = Math.round(raw / step) * step;
      setDrag((d) => {
        if (!d || snapped === d.deltaMin) return d;
        return { ...d, deltaMin: snapped, valid: validate(d.uid, d.mode, snapped) };
      });
    },
    [pxPerMin, step, validate],
  );

  const end = useCallback(
    (e: React.PointerEvent) => {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      originY.current = null;
      setDrag((d) => {
        if (d && d.deltaMin !== 0 && d.valid) commit(d.uid, d.mode, d.deltaMin);
        return null;
      });
    },
    [commit],
  );

  const dragProps = useCallback(
    (uid: string, mode: DragMode) => ({
      onPointerDown: (e: React.PointerEvent) => start(e, uid, mode),
      onPointerMove: move,
      onPointerUp: end,
      onPointerCancel: end,
    }),
    [start, move, end],
  );

  return { drag, dragProps };
}
