import { Clock, MapPin, Repeat, Trash2, CheckCircle2, Circle } from 'lucide-react';
import type { Task } from '../types/Task';
import {
  itemKind,
  dueBadge,
  eventTimeLabel,
  parseDue,
  parsePlanned,
  relativeLabel,
} from '../lib/schedule';
import { format } from 'date-fns';

export function ItemActions({
  item,
  onToggleDone,
  onDelete,
}: {
  item: Task;
  onToggleDone: (item: Task) => void;
  onDelete: (id: string) => void;
}) {
  const isEvent = itemKind(item) === 'event';
  return (
    <div className="task-actions">
      {!isEvent && (
        <button
          type="button"
          className="icon-button"
          onClick={() => onToggleDone(item)}
          aria-label={item.done ? 'Mark as not done' : 'Mark as done'}
          title={item.done ? 'Mark as not done' : 'Mark as done'}
        >
          {item.done ? <CheckCircle2 size={18} /> : <Circle size={18} />}
        </button>
      )}
      <button
        type="button"
        className="icon-button"
        onClick={() => onDelete(item.id)}
        aria-label={`Delete ${item.title}`}
        title="Delete"
      >
        <Trash2 size={16} />
      </button>
    </div>
  );
}

/**
 * A single row for a task or event in the agenda / Today views. Pass `date`
 * (resolved occurrence) for dated items; omit it for undated items.
 */
export default function ItemRow({
  item,
  date,
  end,
  onToggleDone,
  onDelete,
  onOpen,
}: {
  item: Task;
  date?: Date | null;
  end?: Date | null;
  onToggleDone: (item: Task) => void;
  onDelete: (id: string) => void;
  /** Open the item's detail/edit view. When set, the row body is clickable. */
  onOpen?: (item: Task, date?: Date | null, end?: Date | null) => void;
}) {
  const kind = itemKind(item);
  const isEvent = kind === 'event';
  const barClass = isEvent ? 'prio-event' : 'prio-task';

  // A task has two times: a deadline (when it's due) and an optional planned work
  // session (when you'll do it). Derive both from the item so the row reads the
  // same wherever it appears; the detail view always opens on the deadline.
  const session = !isEvent ? parsePlanned(item) : null;
  const deadline = !isEvent ? parseDue(item) : null;
  const openDate = isEvent ? date : deadline;
  const openEnd = isEvent ? end : null;
  const showTaskMeta = !isEvent && (!!session || !!deadline);

  return (
    <div className={`task-row${item.done ? ' done' : ''}${isEvent ? ' is-event' : ''}`}>
      <span className={`prio-bar ${barClass}`} aria-hidden="true" />
      <div
        className={`task-row-body${onOpen ? ' clickable' : ''}`}
        {...(onOpen
          ? {
              role: 'button',
              tabIndex: 0,
              onClick: () => onOpen(item, openDate, openEnd),
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpen(item, openDate, openEnd);
                }
              },
            }
          : {})}
      >
        <div className="task-row-main">
          <span className="task-row-title">{item.title}</span>
          {item.subject && <span className="task-chip">{item.subject}</span>}
          {isEvent && <span className="task-chip event-chip">Event</span>}
          {item.source === 'google' && (
            <span className="task-chip google-chip" title="From Google Calendar">
              Google
            </span>
          )}
        </div>
        {isEvent
          ? date && (
              <div className="task-row-meta">
                <span className="task-time">
                  <Clock size={13} /> {eventTimeLabel(date, end ?? null, item.allDay)}
                </span>
                {item.location && (
                  <span className="task-time">
                    <MapPin size={13} /> {item.location}
                  </span>
                )}
                {item.recurrenceRule && (
                  <span className="task-time" title="Recurring">
                    <Repeat size={13} /> Repeats
                  </span>
                )}
              </div>
            )
          : showTaskMeta && (
              <div className="task-row-meta">
                {session && (
                  <span className="task-time work-time" title="When you'll work on this">
                    <Clock size={13} /> Work {relativeLabel(session.start)} · {eventTimeLabel(session.start, session.end)}
                  </span>
                )}
                {!session && deadline && item.dueTime && (
                  <span className="task-time">
                    <Clock size={13} /> {format(deadline, 'h:mm a')}
                  </span>
                )}
                {deadline && (() => {
                  const badge = dueBadge(deadline);
                  return <span className={`task-badge badge-${badge.tone}`}>{badge.text}</span>;
                })()}
              </div>
            )}
      </div>
      <ItemActions item={item} onToggleDone={onToggleDone} onDelete={onDelete} />
    </div>
  );
}
