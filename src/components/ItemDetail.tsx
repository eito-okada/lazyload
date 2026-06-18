import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import {
  X,
  Pencil,
  Trash2,
  CheckCircle2,
  Circle,
  Clock,
  MapPin,
  Repeat,
  CalendarDays,
  Tag,
} from 'lucide-react';
import type { Task } from '../types/Task';
import ItemForm from './ItemForm';
import {
  itemKind,
  parseDue,
  parseStart,
  parseEnd,
  eventTimeLabel,
  relativeLabel,
  dueBadge,
  PRIORITY_LABEL,
} from '../lib/schedule';

/** Human-readable summary of an RRULE for the detail view. */
function recurrenceSummary(rule: string): string {
  const map = new Map(rule.split(';').map((p) => p.split('=') as [string, string]));
  const freq = map.get('FREQ');
  if (freq === 'DAILY') return 'Repeats daily';
  if (freq === 'WEEKLY') {
    const days = map.get('BYDAY');
    return days ? `Repeats weekly on ${days.split(',').join(', ')}` : 'Repeats weekly';
  }
  return 'Repeats';
}

interface ItemDetailProps {
  item: Task;
  /** Resolved occurrence start, when opened from a dated row. */
  date?: Date | null;
  /** Resolved occurrence end (events). */
  end?: Date | null;
  onClose: () => void;
  onUpdate: (id: string, updates: Partial<Task>) => Promise<void>;
  onDelete: (id: string) => void;
  onToggleDone: (item: Task) => void;
}

/**
 * Modal showing an item's full details, with inline Edit (reusing ItemForm),
 * Delete, and done toggling. Opened by clicking a row in the schedule views.
 */
export default function ItemDetail({
  item,
  date,
  end,
  onClose,
  onUpdate,
  onDelete,
  onToggleDone,
}: ItemDetailProps) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const kind = itemKind(item);
  const isEvent = kind === 'event';
  const priority = item.priority ?? 'medium';

  // Resolved instants for display: prefer the occurrence the user clicked.
  const start = date ?? (isEvent ? parseStart(item) : parseDue(item));
  const endInstant = end ?? (isEvent ? parseEnd(item) : null);

  async function handleSave(updates: Partial<Task>) {
    setSaving(true);
    setError(null);
    try {
      await onUpdate(item.id, updates);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save changes.');
      setSaving(false);
    }
  }

  function handleDelete() {
    const series = item.recurrenceRule ? ' This removes the whole repeating series.' : '';
    if (!window.confirm(`Delete "${item.title}"?${series}`)) return;
    onDelete(item.id);
    onClose();
  }

  return (
    <div className="modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={item.title}
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="modal-close icon-button" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>

        {editing ? (
          <>
            <h2 className="modal-title">Edit {isEvent ? 'event' : 'task'}</h2>
            <ItemForm
              initial={item}
              submitLabel="Save changes"
              submitting={saving}
              onSubmit={handleSave}
            />
            {error && <p className="upload-error">{error}</p>}
            <button
              type="button"
              className="link-button modal-cancel"
              onClick={() => setEditing(false)}
              disabled={saving}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <div className="modal-head">
              <span className={`detail-kind ${isEvent ? 'is-event' : `prio-${priority}`}`}>
                {isEvent ? 'Event' : 'Task'}
              </span>
              <h2 className="modal-title">{item.title}</h2>
            </div>

            <div className="detail-list">
              {start ? (
                <div className="detail-row">
                  <Clock size={16} />
                  <span>
                    {isEvent
                      ? `${relativeLabel(start)} · ${eventTimeLabel(start, endInstant, item.allDay)}`
                      : item.dueTime
                        ? `${relativeLabel(start)} · ${format(start, 'h:mm a')}`
                        : `${relativeLabel(start)} · All day`}
                  </span>
                </div>
              ) : (
                <div className="detail-row">
                  <CalendarDays size={16} />
                  <span>No date set</span>
                </div>
              )}

              {!isEvent &&
                start &&
                (() => {
                  const badge = dueBadge(start);
                  return (
                    <div className="detail-row">
                      <span className={`task-badge badge-${badge.tone}`}>{badge.text}</span>
                    </div>
                  );
                })()}

              {item.subject && (
                <div className="detail-row">
                  <Tag size={16} />
                  <span>{item.subject}</span>
                </div>
              )}

              {isEvent && item.location && (
                <div className="detail-row">
                  <MapPin size={16} />
                  <span>{item.location}</span>
                </div>
              )}

              {isEvent && item.recurrenceRule && (
                <div className="detail-row">
                  <Repeat size={16} />
                  <span>{recurrenceSummary(item.recurrenceRule)}</span>
                </div>
              )}

              {item.source === 'google' && (
                <div className="detail-row">
                  <CalendarDays size={16} />
                  <span>From Google Calendar — changes sync both ways</span>
                </div>
              )}

              {!isEvent && (
                <div className="detail-row">
                  <span className={`prio-tag prio-${priority}`}>{PRIORITY_LABEL[priority]} priority</span>
                  {item.estimatedMinutes ? <span className="detail-est">~{item.estimatedMinutes} min</span> : null}
                </div>
              )}
            </div>

            <div className="modal-actions">
              {!isEvent && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    onToggleDone(item);
                    onClose();
                  }}
                >
                  {item.done ? (
                    <>
                      <Circle size={16} /> Mark not done
                    </>
                  ) : (
                    <>
                      <CheckCircle2 size={16} /> Mark done
                    </>
                  )}
                </button>
              )}
              <button type="button" className="btn btn-secondary" onClick={() => setEditing(true)}>
                <Pencil size={16} /> Edit
              </button>
              <button type="button" className="btn btn-danger" onClick={handleDelete}>
                <Trash2 size={16} /> Delete
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
