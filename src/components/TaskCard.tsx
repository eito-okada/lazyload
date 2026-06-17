import { Trash2 } from 'lucide-react';
import type { Task } from '../types/Task';

interface TaskCardProps {
  task: Task;
  onChange?: (task: Task) => void;
  onDelete?: (id: string) => void;
  editable?: boolean;
}

/** Split an ISO datetime string ("2026-06-17T09:00") into [date, time] parts. */
function splitAt(iso: string | undefined): [string, string] {
  if (!iso) return ['', ''];
  const [d = '', t = ''] = iso.split('T');
  // Trim seconds if present (e.g. "09:00:00" → "09:00")
  return [d, t.slice(0, 5)];
}

/** Combine date + time strings back into an ISO datetime string. */
function joinAt(date: string, time: string): string | undefined {
  if (!date) return undefined;
  return `${date}T${time || '00:00'}`;
}

export default function TaskCard({ task, onChange, onDelete, editable = false }: TaskCardProps) {
  const isEvent = task.kind === 'event';

  if (!editable) {
    const [startDate, startTime] = splitAt(task.startAt);
    return (
      <div className="task-card">
        <div className="task-card-main">
          <h3>{task.title}</h3>
          <div className="task-meta">
            {task.subject && <span className="task-subject">{task.subject}</span>}
            {isEvent ? (
              startDate && (
                <span className="task-due">
                  {startDate}{startTime ? ` at ${startTime}` : ''}
                </span>
              )
            ) : (
              task.dueDate && <span className="task-due">Due {task.dueDate}</span>
            )}
            {isEvent && <span className="task-subject">Event</span>}
          </div>
        </div>
      </div>
    );
  }

  // ---- Editable mode ----
  const [startDate, startTime] = splitAt(task.startAt);
  const [endDate, endTime] = splitAt(task.endAt);

  return (
    <div className="task-card">
      <div className="task-card-main">
        <input
          className="task-title-input"
          value={task.title}
          onChange={(e) => onChange?.({ ...task, title: e.target.value })}
          placeholder={isEvent ? 'Event name' : 'Task title'}
        />
        <div className="task-edit-fields">
          <label className="task-field">
            <span>Subject</span>
            <input
              value={task.subject ?? ''}
              onChange={(e) => onChange?.({ ...task, subject: e.target.value || undefined })}
              placeholder="e.g. Physics"
            />
          </label>

          {isEvent ? (
            <>
              <label className="task-field">
                <span>All day</span>
                <input
                  type="checkbox"
                  checked={task.allDay ?? false}
                  onChange={(e) => onChange?.({ ...task, allDay: e.target.checked })}
                  style={{ width: 'auto' }}
                />
              </label>
              <label className="task-field">
                <span>Start date</span>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) =>
                    onChange?.({ ...task, startAt: joinAt(e.target.value, startTime) })
                  }
                />
              </label>
              {!(task.allDay) && (
                <label className="task-field">
                  <span>Start time</span>
                  <input
                    type="time"
                    value={startTime}
                    onChange={(e) =>
                      onChange?.({ ...task, startAt: joinAt(startDate, e.target.value) })
                    }
                  />
                </label>
              )}
              <label className="task-field">
                <span>End date</span>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) =>
                    onChange?.({ ...task, endAt: joinAt(e.target.value, endTime) })
                  }
                />
              </label>
              {!(task.allDay) && (
                <label className="task-field">
                  <span>End time</span>
                  <input
                    type="time"
                    value={endTime}
                    onChange={(e) =>
                      onChange?.({ ...task, endAt: joinAt(endDate, e.target.value) })
                    }
                  />
                </label>
              )}
              <label className="task-field">
                <span>Location</span>
                <input
                  value={task.location ?? ''}
                  onChange={(e) =>
                    onChange?.({ ...task, location: e.target.value || undefined })
                  }
                  placeholder="Room / link"
                />
              </label>
            </>
          ) : (
            <>
              <label className="task-field">
                <span>Due date</span>
                <input
                  type="date"
                  value={task.dueDate ?? ''}
                  onChange={(e) => onChange?.({ ...task, dueDate: e.target.value || undefined })}
                />
              </label>
              <label className="task-field">
                <span>Due time</span>
                <input
                  type="time"
                  value={task.dueTime ?? ''}
                  onChange={(e) => onChange?.({ ...task, dueTime: e.target.value || undefined })}
                />
              </label>
            </>
          )}

          <label className="task-field">
            <span>Priority</span>
            <select
              value={task.priority ?? 'medium'}
              onChange={(e) => onChange?.({ ...task, priority: e.target.value as Task['priority'] })}
            >
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </label>
        </div>
      </div>
      {onDelete && (
        <button
          type="button"
          className="task-delete"
          onClick={() => onDelete(task.id)}
          aria-label={`Delete ${task.title}`}
        >
          <Trash2 size={18} />
        </button>
      )}
    </div>
  );
}
