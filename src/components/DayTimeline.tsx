// A vertical day timeline: time runs top→bottom across the user's available hours,
// with work sessions and timed events laid out as blocks sized by their duration.
// Work-session blocks are editable in place — drag the body to move, drag the
// bottom edge to resize, or use the tap controls when selected. Events are
// read-only (they sync to Google Calendar) and just open their detail on tap.
// The timeline doesn't know about persistence: Today owns `onEdit`/`validate` and
// dispatches them to in-memory preview edits or live `updateTask` writes.
import { ChevronUp, ChevronDown, Minus, Plus, Trash2, Lock, Maximize2 } from 'lucide-react';
import { format } from 'date-fns';
import type { Task } from '../types/Task';
import type { WorkingHours } from '../lib/preferences';
import { freeWindowsForDay } from '../lib/schedule';
import { useBlockDrag, type DragMode } from '../lib/useBlockDrag';

/** Vertical scale: minutes → pixels. ~54px per hour reads comfortably. */
export const PX_PER_MIN = 0.9;
/** Snap + nudge granularity, in minutes. */
export const STEP = 15;

/** A laid-out item on the timeline — a work session or a timed event. */
export interface TimelineBlock {
  /** Stable id for keys + edit targeting (a preview uid, or `${taskId}#planned`). */
  uid: string;
  start: Date;
  end: Date;
  kind: 'session' | 'event';
  /** Sessions can be moved/resized; events are read-only. */
  editable: boolean;
  title: string;
  /** Secondary line, e.g. the source task title behind an action label. */
  subtitle?: string;
  part?: { index: number; total: number };
  /** A not-yet-committed auto-plan block (dashed styling). */
  suggested?: boolean;
  /** Pinned in the preview (kept when re-planning). */
  locked?: boolean;
  /** The underlying item, for opening detail. */
  item: Task;
}

interface DayTimelineProps {
  day: Date;
  now: Date;
  prefs: WorkingHours;
  blocks: TimelineBlock[];
  selectedUid: string | null;
  onSelect: (uid: string | null) => void;
  onOpen: (item: Task) => void;
  /** Commit a move/resize by a snapped minute delta. */
  onEdit: (uid: string, mode: DragMode, deltaMin: number) => void;
  /** Would this move/resize land in a valid slot? Gates drag + disables buttons. */
  validate: (uid: string, mode: DragMode, deltaMin: number) => boolean;
  onRemove: (uid: string) => void;
  onToggleLock?: (uid: string) => void;
  /** Whether lock controls are relevant (preview mode). */
  showLock?: boolean;
  busy?: boolean;
}

function atTime(day: Date, hm: string): Date {
  const [h, m] = hm.split(':').map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h || 0, m || 0, 0, 0);
}

function hourLabel(h: number): string {
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}${h < 12 || h === 24 ? 'a' : 'p'}`;
}

export default function DayTimeline({
  day,
  now,
  prefs,
  blocks,
  selectedUid,
  onSelect,
  onOpen,
  onEdit,
  validate,
  onRemove,
  onToggleLock,
  showLock = false,
  busy = false,
}: DayTimelineProps) {
  const dayStart = atTime(day, prefs.dayStart);
  const dayEnd = atTime(day, prefs.dayEnd);
  const startMin = dayStart.getHours() * 60 + dayStart.getMinutes();
  const endMin = dayEnd.getHours() * 60 + dayEnd.getMinutes();
  const totalMin = Math.max(60, endMin - startMin);
  const height = totalMin * PX_PER_MIN;

  /** Minutes from the top of the timeline for an instant on this day. */
  const offsetMin = (d: Date) => (d.getTime() - dayStart.getTime()) / 60_000;
  const yOf = (d: Date) => Math.max(0, Math.min(totalMin, offsetMin(d))) * PX_PER_MIN;

  const { drag, dragProps } = useBlockDrag({ pxPerMin: PX_PER_MIN, step: STEP, validate, commit: onEdit });

  // Hour gridlines across the visible span.
  const firstHour = Math.ceil(startMin / 60);
  const lastHour = Math.floor(endMin / 60);
  const hours: number[] = [];
  for (let h = firstHour; h <= lastHour; h++) hours.push(h);

  // The shaded work/school window(s) sit between the free windows.
  const free = freeWindowsForDay(day, prefs);
  const busyBands = freeGapsBetween(dayStart, dayEnd, free);

  // Lay overlapping blocks side-by-side so nothing overprints (calendar columns).
  const layout = packColumns(blocks);

  const showNow =
    now >= dayStart && now <= dayEnd && day.toDateString() === now.toDateString();

  return (
    <div className="day-timeline" style={{ height }} onClick={() => onSelect(null)}>
      <div className="timeline-gutter">
        {hours.map((h) => (
          <span key={h} className="timeline-hour-label" style={{ top: (h * 60 - startMin) * PX_PER_MIN }}>
            {hourLabel(h)}
          </span>
        ))}
      </div>

      <div className="timeline-track">
        {hours.map((h) => (
          <span key={h} className="timeline-hour-line" style={{ top: (h * 60 - startMin) * PX_PER_MIN }} />
        ))}

        {busyBands.map((b, i) => (
          <div
            key={i}
            className="timeline-busy-band"
            style={{ top: yOf(b.start), height: yOf(b.end) - yOf(b.start) }}
            title="Work / school hours"
          />
        ))}

        {showNow && (
          <div className="timeline-now" style={{ top: yOf(now) }}>
            <span className="timeline-now-dot" />
          </div>
        )}

        {blocks.map((b) => {
          const dragging = drag?.uid === b.uid ? drag : null;
          const moveShift = dragging?.mode === 'move' ? dragging.deltaMin * PX_PER_MIN : 0;
          const resizeGrow = dragging?.mode === 'resize' ? dragging.deltaMin * PX_PER_MIN : 0;
          const top = yOf(b.start) + moveShift;
          const blockH = Math.max(STEP * PX_PER_MIN, yOf(b.end) - yOf(b.start) + resizeGrow);
          const selected = selectedUid === b.uid;
          const cls = [
            'timeline-block',
            b.kind === 'event' ? 'is-event' : 'is-session',
            b.suggested ? 'suggested' : '',
            b.locked ? 'locked' : '',
            selected ? 'selected' : '',
            dragging ? 'dragging' : '',
            dragging && !dragging.valid ? 'invalid' : '',
          ]
            .filter(Boolean)
            .join(' ');

          const editable = b.editable && !b.locked;
          const bodyProps = editable ? dragProps(b.uid, 'move') : {};

          // Side-by-side placement when this block shares time with others.
          const lay = layout.get(b.uid);
          const cols = lay?.cols ?? 1;
          const colStyle =
            cols > 1
              ? {
                  left: `calc(6px + (100% - 12px) * ${lay!.col} / ${cols})`,
                  width: `calc((100% - 12px) / ${cols} - 4px)`,
                  right: 'auto' as const,
                }
              : {};

          return (
            <div
              key={b.uid}
              className={cls}
              style={{ top, height: blockH, ...colStyle }}
              onClick={(e) => {
                e.stopPropagation();
                if (b.kind === 'event') onOpen(b.item);
                else onSelect(selected ? null : b.uid);
              }}
              {...bodyProps}
            >
              <div className="timeline-block-body">
                <span className="timeline-block-title">{b.title}</span>
                <span className="timeline-block-meta">
                  {format(b.start, 'h:mm')}–{format(b.end, 'h:mm a')}
                  {b.part ? ` · part ${b.part.index}/${b.part.total}` : ''}
                  {b.subtitle ? ` · ${b.subtitle}` : ''}
                </span>
              </div>

              {selected && b.editable && (
                <div
                  className="timeline-block-controls"
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    onClick={() => onEdit(b.uid, 'move', -STEP)}
                    disabled={busy || b.locked || !validate(b.uid, 'move', -STEP)}
                    title="Earlier"
                    aria-label="Move earlier"
                  >
                    <ChevronUp size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onEdit(b.uid, 'move', STEP)}
                    disabled={busy || b.locked || !validate(b.uid, 'move', STEP)}
                    title="Later"
                    aria-label="Move later"
                  >
                    <ChevronDown size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onEdit(b.uid, 'resize', -STEP)}
                    disabled={busy || b.locked || !validate(b.uid, 'resize', -STEP)}
                    title="Shorten"
                    aria-label="Shorten"
                  >
                    <Minus size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onEdit(b.uid, 'resize', STEP)}
                    disabled={busy || b.locked || !validate(b.uid, 'resize', STEP)}
                    title="Lengthen"
                    aria-label="Lengthen"
                  >
                    <Plus size={14} />
                  </button>
                  {showLock && onToggleLock && (
                    <button
                      type="button"
                      className={b.locked ? 'is-active' : ''}
                      onClick={() => onToggleLock(b.uid)}
                      disabled={busy}
                      title={b.locked ? 'Unlock' : 'Lock'}
                      aria-label={b.locked ? 'Unlock session' : 'Lock session'}
                    >
                      <Lock size={14} />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onOpen(b.item)}
                    disabled={busy}
                    title="Details"
                    aria-label="Open details"
                  >
                    <Maximize2 size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemove(b.uid)}
                    disabled={busy}
                    title="Remove"
                    aria-label="Remove session"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              )}

              {editable && <span className="timeline-resize-handle" {...dragProps(b.uid, 'resize')} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Assign each block a column within its cluster of transitively-overlapping
 * blocks, so overlapping items render side-by-side instead of on top of each
 * other. Greedy first-fit: a block reuses the earliest column whose previous
 * block has already ended, else opens a new one; the cluster's column count is
 * the max reached. Non-overlapping blocks stay full width (cols = 1).
 */
function packColumns(blocks: TimelineBlock[]): Map<string, { col: number; cols: number }> {
  const result = new Map<string, { col: number; cols: number }>();
  const sorted = [...blocks].sort(
    (a, b) => a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime(),
  );
  let cluster: TimelineBlock[] = [];
  let clusterEnd = -Infinity;
  const colEnd: number[] = []; // last end time (ms) per active column in the cluster
  const assign = new Map<string, number>();

  const flush = () => {
    const cols = colEnd.length || 1;
    for (const b of cluster) result.set(b.uid, { col: assign.get(b.uid) ?? 0, cols });
    cluster = [];
    colEnd.length = 0;
    assign.clear();
    clusterEnd = -Infinity;
  };

  for (const b of sorted) {
    const s = b.start.getTime();
    if (cluster.length && s >= clusterEnd) flush();
    let col = colEnd.findIndex((end) => end <= s);
    if (col === -1) {
      col = colEnd.length;
      colEnd.push(b.end.getTime());
    } else {
      colEnd[col] = b.end.getTime();
    }
    assign.set(b.uid, col);
    cluster.push(b);
    clusterEnd = Math.max(clusterEnd, b.end.getTime());
  }
  flush();
  return result;
}

/** The spans between `free` windows within [dayStart, dayEnd] — i.e. busy/work bands. */
function freeGapsBetween(
  dayStart: Date,
  dayEnd: Date,
  free: { start: Date; end: Date }[],
): { start: Date; end: Date }[] {
  const sorted = [...free].sort((a, b) => a.start.getTime() - b.start.getTime());
  const bands: { start: Date; end: Date }[] = [];
  let cursor = dayStart;
  for (const w of sorted) {
    if (w.start > cursor) bands.push({ start: cursor, end: w.start });
    if (w.end > cursor) cursor = w.end;
  }
  if (cursor < dayEnd) bands.push({ start: cursor, end: dayEnd });
  return bands;
}
