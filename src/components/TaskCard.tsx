import { Trash2 } from 'lucide-react';
import type { Task } from '../types/Task';

interface TaskCardProps {
  task: Task;
  onChange?: (task: Task) => void;
  onDelete?: (id: string) => void;
  editable?: boolean;
}

export default function TaskCard({ task, onChange, onDelete, editable = false }: TaskCardProps) {
  if (!editable) {
    return (
      <div className="task-card">
        <div className="task-card-main">
          <h3>{task.title}</h3>
          <div className="task-meta">
            {task.subject && <span className="task-subject">{task.subject}</span>}
            {task.dueDate && <span className="task-due">Due {task.dueDate}</span>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="task-card">
      <div className="task-card-main">
        <input
          className="task-title-input"
          value={task.title}
          onChange={(e) => onChange?.({ ...task, title: e.target.value })}
          placeholder="Task title"
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
          <label className="task-field">
            <span>Due date</span>
            <input
              type="date"
              value={task.dueDate ?? ''}
              onChange={(e) => onChange?.({ ...task, dueDate: e.target.value || undefined })}
            />
          </label>
          <label className="task-field">
            <span>Start time</span>
            <input
              type="time"
              value={task.startTime ?? ''}
              onChange={(e) => onChange?.({ ...task, startTime: e.target.value || undefined })}
            />
          </label>
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
