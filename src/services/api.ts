import type { Task } from '../types/Task';

// Develop the UI without burning API calls: set VITE_USE_MOCK=true in .env.local.
// The Vite dev server doesn't run /api functions — use `vercel dev` to exercise
// the real endpoint locally, or keep the mock on while iterating on the UI.
const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true';

const mockTasks: Task[] = [
  { id: '1', title: 'Physics Homework #7', dueDate: '2026-06-17', startTime: '16:00', subject: 'Physics', estimatedMinutes: 45, priority: 'high' },
  { id: '2', title: 'History Essay', dueDate: '2026-06-24', subject: 'History', estimatedMinutes: 120, priority: 'medium' },
  { id: '3', title: 'Chemistry Lab Report', dueDate: '2026-06-20', subject: 'Chemistry', estimatedMinutes: 90, priority: 'low' },
];

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // strip the "data:image/png;base64," prefix
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export async function extractTasksFromScreenshot(file: File): Promise<Task[]> {
  if (USE_MOCK) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    return mockTasks;
  }

  const imageBase64 = await fileToBase64(file);
  const res = await fetch('/api/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageBase64, mediaType: file.type }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Extraction failed (${res.status})`);
  }

  const data = await res.json();
  return data.tasks as Task[];
}
