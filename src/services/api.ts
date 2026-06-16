import type { Task } from '../types/Task';

// Develop the UI without burning API calls: set VITE_USE_MOCK=true in .env.local.
// The Vite dev server doesn't run /api functions — use `vercel dev` to exercise
// the real endpoint locally, or keep the mock on while iterating on the UI.
const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true';

// Spread across states (overdue / today / upcoming / no-date) so the schedule
// UI can be developed against realistic data via VITE_USE_MOCK=true.
const mockTasks: Task[] = [
  { id: '1', title: 'Spanish vocab quiz', dueDate: '2026-06-14', startTime: '08:00', subject: 'Spanish 3', priority: 'high' },
  { id: '2', title: 'Physics Homework #7', dueDate: '2026-06-16', startTime: '22:00', subject: 'AP Physics', estimatedMinutes: 45, priority: 'high' },
  { id: '3', title: 'Read Chapter 12', dueDate: '2026-06-17', subject: 'English', estimatedMinutes: 60, priority: 'low' },
  { id: '4', title: 'Chemistry Lab Report', dueDate: '2026-06-20', startTime: '23:59', subject: 'Chemistry', estimatedMinutes: 90, priority: 'medium' },
  { id: '5', title: 'History Essay', dueDate: '2026-06-24', startTime: '22:00', subject: 'US History', estimatedMinutes: 120, priority: 'medium' },
  { id: '6', title: 'Study for SAT', subject: 'Test Prep', priority: 'low' },
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
