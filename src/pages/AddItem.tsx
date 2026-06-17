import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PenLine, Camera } from 'lucide-react';
import ItemForm from '../components/ItemForm';
import UploadBox from '../components/UploadBox';
import { useTasks } from '../context/TaskContext';
import { extractTasksFromScreenshot } from '../services/api';
import type { Task } from '../types/Task';

type Mode = 'manual' | 'scan';

export default function AddItem() {
  const { createItem, setDraftTasks } = useTasks();
  const [mode, setMode] = useState<Mode>('manual');

  // Manual state
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Scan state
  const [file, setFile] = useState<File | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);

  const navigate = useNavigate();

  async function handleSubmit(item: Partial<Task>) {
    setSaving(true);
    setSaveError(null);
    try {
      await createItem(item);
      navigate('/today');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save.');
      setSaving(false);
    }
  }

  async function handleExtract() {
    if (!file) return;
    setExtracting(true);
    setExtractError(null);
    try {
      const tasks = await extractTasksFromScreenshot(file);
      setDraftTasks(tasks);
      navigate('/review');
    } catch (err) {
      setExtractError(err instanceof Error ? err.message : 'Something went wrong extracting tasks.');
      setExtracting(false);
    }
  }

  function switchMode(next: Mode) {
    setMode(next);
    setSaveError(null);
    setExtractError(null);
  }

  return (
    <section className="page form-page">
      <h1>Add to your schedule</h1>

      <div className="kind-toggle add-mode-toggle" role="tablist" aria-label="Add method">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'manual'}
          className={mode === 'manual' ? 'active' : ''}
          onClick={() => switchMode('manual')}
        >
          <PenLine size={16} /> Manual
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'scan'}
          className={mode === 'scan' ? 'active' : ''}
          onClick={() => switchMode('scan')}
        >
          <Camera size={16} /> Scan photo
        </button>
      </div>

      {mode === 'manual' ? (
        <>
          <ItemForm submitLabel="Add" submitting={saving} onSubmit={handleSubmit} />
          {saveError && <p className="upload-error">{saveError}</p>}
        </>
      ) : (
        <div className="scan-panel">
          <p className="tagline">
            Take a photo or upload a screenshot — tasks and events are extracted automatically.
          </p>
          <UploadBox onFileSelected={setFile} />
          <button
            type="button"
            className="cta-button"
            disabled={!file || extracting}
            onClick={handleExtract}
          >
            {extracting ? 'Extracting…' : 'Extract tasks & events'}
          </button>
          {extractError && <p className="upload-error">{extractError}</p>}
        </div>
      )}
    </section>
  );
}
