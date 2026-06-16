import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import UploadBox from '../components/UploadBox';
import { extractTasksFromScreenshot } from '../services/api';
import { useTasks } from '../context/TaskContext';

export default function Upload() {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { setTasks } = useTasks();
  const navigate = useNavigate();

  async function handleContinue() {
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      const tasks = await extractTasksFromScreenshot(file);
      setTasks(tasks);
      navigate('/review');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong extracting tasks.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="page upload-page">
      <h1>Upload a Screenshot</h1>
      <p>Homework site, worksheet, Google Classroom, Canvas — anything works.</p>
      <UploadBox onFileSelected={setFile} />
      <button
        type="button"
        className="cta-button"
        disabled={!file || loading}
        onClick={handleContinue}
      >
        {loading ? 'Extracting tasks…' : 'Continue'}
      </button>
      {error && <p className="upload-error">{error}</p>}
    </section>
  );
}
