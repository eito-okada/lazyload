import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import TaskCard from '../components/TaskCard';
import { useTasks } from '../context/TaskContext';
import type { Task } from '../types/Task';

export default function Review() {
  const { draftTasks, setDraftTasks, saveDraftTasks, undoImport } = useTasks();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ importId: string; count: number } | null>(null);
  const [undoing, setUndoing] = useState(false);
  const navigate = useNavigate();

  function updateTask(updated: Task) {
    setDraftTasks(draftTasks.map((t) => (t.id === updated.id ? updated : t)));
  }

  function deleteTask(id: string) {
    setDraftTasks(draftTasks.filter((t) => t.id !== id));
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const { importId, tasks } = await saveDraftTasks();
      setSaved({ importId, count: tasks.length });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save tasks.');
    } finally {
      setSaving(false);
    }
  }

  async function handleUndo() {
    if (!saved) return;
    setUndoing(true);
    try {
      await undoImport(saved.importId);
      setSaved(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to undo.');
    } finally {
      setUndoing(false);
    }
  }

  if (saved) {
    return (
      <section className="page review-page">
        <div className="success-state">
          <span className="success-icon">
            <CheckCircle2 size={32} strokeWidth={2} />
          </span>
          <h1>All set</h1>
          <p>
            {saved.count} item{saved.count === 1 ? '' : 's'} added to your schedule.
          </p>
          <div className="saved-actions">
            <button type="button" className="btn btn-primary" onClick={() => navigate('/schedule')}>
              View Schedule
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => navigate('/add')}>
              Add another
            </button>
            <button type="button" className="link-button" onClick={handleUndo} disabled={undoing}>
              {undoing ? 'Undoing…' : 'Undo'}
            </button>
          </div>
          {error && <p className="upload-error">{error}</p>}
        </div>
      </section>
    );
  }

  return (
    <section className="page review-page">
      <h1>Review &amp; save</h1>
      {draftTasks.length === 0 ? (
        <p>Nothing to review yet. Scan a photo from the Add page first.</p>
      ) : (
        <div className="task-list">
          {draftTasks.map((task) => (
            <TaskCard key={task.id} task={task} editable onChange={updateTask} onDelete={deleteTask} />
          ))}
        </div>
      )}
      <button
        type="button"
        className="cta-button"
        disabled={draftTasks.length === 0 || saving}
        onClick={handleSave}
      >
        {saving ? 'Saving…' : 'Save Tasks'}
      </button>
      {error && <p className="upload-error">{error}</p>}
    </section>
  );
}
