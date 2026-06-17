import type { Task, Priority } from '../types/Task';

// Develop the UI without burning API calls: set VITE_USE_MOCK=true in .env.local.
// The Vite dev server doesn't run /api functions — use `vercel dev` to exercise
// the real endpoint locally, or keep the mock on while iterating on the UI.
const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true';

// Spread across states (overdue / today / upcoming / no-date) so the schedule
// UI can be developed against realistic data via VITE_USE_MOCK=true.
const mockTasks: Task[] = [
  { id: '1', title: 'Spanish vocab quiz', dueDate: '2026-06-14', dueTime: '08:00', subject: 'Spanish 3', priority: 'high' },
  { id: '2', title: 'Physics Homework #7', dueDate: '2026-06-16', dueTime: '22:00', subject: 'AP Physics', estimatedMinutes: 45, priority: 'high' },
  { id: '3', title: 'Read Chapter 12', dueDate: '2026-06-17', subject: 'English', estimatedMinutes: 60, priority: 'low' },
  { id: '4', title: 'Chemistry Lab Report', dueDate: '2026-06-20', dueTime: '23:59', subject: 'Chemistry', estimatedMinutes: 90, priority: 'medium' },
  { id: '5', title: 'History Essay', dueDate: '2026-06-24', dueTime: '22:00', subject: 'US History', estimatedMinutes: 120, priority: 'medium' },
  { id: '6', title: 'Study for SAT', subject: 'Test Prep', priority: 'low' },
  { id: '7', kind: 'event' as const, title: 'AP Bio Lecture', startAt: '2026-06-17T09:00', endAt: '2026-06-17T10:30', subject: 'AP Biology', location: 'Room 204', priority: 'medium' },
  { id: '8', kind: 'event' as const, title: 'Math Office Hours', startAt: '2026-06-18T14:00', endAt: '2026-06-18T15:00', priority: 'low' },
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

// --- Plan action text ---------------------------------------------------------
// The algorithm decides WHEN each block runs; this asks the AI to write the
// "what to actually do" label. Always falls back to templated text so the
// planner keeps working when the endpoint/API key is unavailable (or in mock).

export interface PlanTextInput {
  id: string;
  title: string;
  subject?: string;
  priority?: Priority;
  durationMin: number;
  startLabel: string;
  dueLabel?: string;
  part?: { index: number; total: number };
}

export interface PlanTextResult {
  items: { id: string; actionText: string }[];
  summary: string;
}

/** Plain, no-AI action text — also the fallback when the endpoint fails. */
function templatePlanText(items: PlanTextInput[]): PlanTextResult {
  const out = items.map((it) => {
    const verb = it.part && it.part.index > 1 ? 'Continue' : 'Work on';
    const part = it.part ? ` (part ${it.part.index} of ${it.part.total})` : '';
    return { id: it.id, actionText: `${verb} ${it.title}${part}` };
  });
  const n = items.length;
  return { items: out, summary: `Planned ${n} session${n === 1 ? '' : 's'} into your free time.` };
}

export async function generatePlanText(items: PlanTextInput[]): Promise<PlanTextResult> {
  if (items.length === 0) return { items: [], summary: '' };
  if (USE_MOCK) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return templatePlanText(items);
  }

  try {
    const res = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    if (!res.ok) return templatePlanText(items);
    const data = (await res.json()) as PlanTextResult;
    // Guard against a partial response: fill any gaps from the template.
    const byId = new Map(data.items?.map((i) => [i.id, i.actionText]) ?? []);
    const fallback = templatePlanText(items);
    return {
      items: items.map((it) => ({ id: it.id, actionText: byId.get(it.id) || `Work on ${it.title}` })),
      summary: data.summary || fallback.summary,
    };
  } catch {
    return templatePlanText(items);
  }
}
