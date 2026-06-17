import { Clock, MapPin, Repeat, Trash2, CheckCircle2, Circle } from 'lucide-react';
import type { Task } from '../types/Task';
import {
  itemKind,
  dueBadge,
  eventTimeLabel,
  PRIORITY_LABEL,
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
}: {
  item: Task;
  date?: Date | null;
  end?: Date | null;
  onToggleDone: (item: Task) => void;
  onDelete: (id: string) => void;
}) {
  const kind = itemKind(item);
  const isEvent = kind === 'event';
  const priority = item.priority ?? 'medium';
  const barClass = isEvent ? 'prio-event' : `prio-${priority}`;

  return (
    <div className={`task-row${item.done ? ' done' : ''}${isEvent ? ' is-event' : ''}`}>
      <span className={`prio-bar ${barClass}`} aria-hidden="true" />
      <div className="task-row-body">
        <div className="task-row-main">
          <span className="task-row-title">{item.title}</span>
          {item.subject && <span className="task-chip">{item.subject}</span>}
          {isEvent && <span className="task-chip event-chip">Event</span>}
        </div>
        {date && (
          <div className="task-row-meta">
            {isEvent ? (
              <>
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
              </>
            ) : (
              <>
                <span className="task-time">
                  <Clock size={13} /> {item.dueTime ? format(date, 'h:mm a') : 'All day'}
                </span>
                {(() => {
                  const badge = dueBadge(date);
                  return <span className={`task-badge badge-${badge.tone}`}>{badge.text}</span>;
                })()}
                <span className={`prio-tag prio-${priority}`}>{PRIORITY_LABEL[priority]}</span>
              </>
            )}
          </div>
        )}
      </div>
      <ItemActions item={item} onToggleDone={onToggleDone} onDelete={onDelete} />
    </div>
  );
}
