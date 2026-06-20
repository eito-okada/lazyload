import { supabase } from '../lib/supabase';
import type { Task, Priority, ItemKind, ItemSource } from '../types/Task';

const COLUMNS =
  'id, import_id, title, subject, due_date, due_time, estimated_minutes, ' +
  'actual_minutes, planned_date, planned_start, planned_minutes, started_at, priority, done, ' +
  'kind, start_at, end_at, all_day, location, recurrence_rule, source, notes';

interface TaskRow {
  id: string;
  import_id: string | null;
  title: string;
  subject: string | null;
  due_date: string | null;
  due_time: string | null;
  estimated_minutes: number | null;
  actual_minutes: number | null;
  planned_date: string | null;
  planned_start: string | null;
  planned_minutes: number | null;
  started_at: string | null;
  priority: Priority;
  done: boolean;
  kind: ItemKind | null;
  start_at: string | null;
  end_at: string | null;
  all_day: boolean | null;
  location: string | null;
  recurrence_rule: string | null;
  source: ItemSource | null;
  notes: string | null;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    subject: row.subject ?? undefined,
    dueDate: row.due_date ?? undefined,
    dueTime: row.due_time ?? undefined,
    estimatedMinutes: row.estimated_minutes ?? undefined,
    actualMinutes: row.actual_minutes ?? undefined,
    plannedDate: row.planned_date ?? undefined,
    plannedStart: row.planned_start ?? undefined,
    plannedMinutes: row.planned_minutes ?? undefined,
    startedAt: row.started_at ?? undefined,
    priority: row.priority,
    done: row.done,
    kind: row.kind ?? 'task',
    startAt: row.start_at ?? undefined,
    endAt: row.end_at ?? undefined,
    allDay: row.all_day ?? undefined,
    location: row.location ?? undefined,
    recurrenceRule: row.recurrence_rule ?? undefined,
    source: row.source ?? 'local',
    notes: row.notes ?? undefined,
  };
}

/** Maps the camelCase event/task fields of an item to its snake_case DB columns. */
function itemToRow(item: Partial<Task>): Record<string, unknown> {
  return {
    title: item.title,
    subject: item.subject ?? null,
    due_date: item.dueDate ?? null,
    due_time: item.dueTime ?? null,
    estimated_minutes: item.estimatedMinutes ?? null,
    actual_minutes: item.actualMinutes ?? null,
    planned_date: item.plannedDate ?? null,
    planned_start: item.plannedStart ?? null,
    planned_minutes: item.plannedMinutes ?? null,
    started_at: item.startedAt ?? null,
    priority: item.priority ?? 'medium',
    kind: item.kind ?? 'task',
    start_at: item.startAt ?? null,
    end_at: item.endAt ?? null,
    all_day: item.allDay ?? false,
    location: item.location ?? null,
    recurrence_rule: item.recurrenceRule ?? null,
    notes: item.notes ?? null,
  };
}

/** All items belonging to the current user, soonest due date first. */
export async function fetchTasks(): Promise<Task[]> {
  const { data, error } = await supabase
    .from('tasks')
    .select(COLUMNS)
    .order('due_date', { ascending: true, nullsFirst: false });
  if (error) throw error;
  return (data as unknown as TaskRow[]).map(rowToTask);
}

/**
 * Persists one screenshot's reviewed tasks as a new import. Returns the saved
 * tasks (with real DB ids) plus the import id, so the caller can offer "undo"
 * (deleting the import cascades to its tasks).
 */
export async function saveImport(
  userId: string,
  draftTasks: Task[],
  sourceNote?: string,
): Promise<{ importId: string; tasks: Task[] }> {
  const { data: importRow, error: importError } = await supabase
    .from('imports')
    .insert({ user_id: userId, source_note: sourceNote ?? null })
    .select('id')
    .single();
  if (importError) throw importError;

  const rows = draftTasks.map((t) => ({
    user_id: userId,
    import_id: importRow.id,
    ...itemToRow(t),
  }));

  const { data, error } = await supabase.from('tasks').insert(rows).select(COLUMNS);
  if (error) throw error;

  return { importId: importRow.id as string, tasks: (data as unknown as TaskRow[]).map(rowToTask) };
}

/** Creates a single manually-added item (task or event). Manual items have no import. */
export async function createItem(userId: string, item: Partial<Task>): Promise<Task> {
  const { data, error } = await supabase
    .from('tasks')
    .insert({ user_id: userId, import_id: null, ...itemToRow(item) })
    .select(COLUMNS)
    .single();
  if (error) throw error;
  return rowToTask(data as unknown as TaskRow);
}

export async function updateTask(taskId: string, updates: Partial<Task>): Promise<void> {
  const patch: Record<string, unknown> = {};
  // Nullable columns: a *present* key clears (or sets) the column, even when its
  // value is undefined — that's how callers wipe a planned session
  // (`{ plannedDate: undefined, … }`). Keying off `in` (not `!== undefined`) is
  // essential: treating an explicit undefined as "skip" makes the patch empty,
  // and `supabase.update({})` is a silent no-op that never clears the row.
  const nullable: [keyof Task, string][] = [
    ['subject', 'subject'],
    ['dueDate', 'due_date'],
    ['dueTime', 'due_time'],
    ['estimatedMinutes', 'estimated_minutes'],
    ['actualMinutes', 'actual_minutes'],
    ['plannedDate', 'planned_date'],
    ['plannedStart', 'planned_start'],
    ['plannedMinutes', 'planned_minutes'],
    ['startedAt', 'started_at'],
    ['startAt', 'start_at'],
    ['endAt', 'end_at'],
    ['location', 'location'],
    ['recurrenceRule', 'recurrence_rule'],
    ['notes', 'notes'],
  ];
  for (const [key, col] of nullable) {
    if (key in updates) patch[col] = updates[key] ?? null;
  }
  // Non-nullable columns: only set when a real value is provided (never null).
  if (updates.title !== undefined) patch.title = updates.title;
  if (updates.priority !== undefined) patch.priority = updates.priority;
  if (updates.done !== undefined) patch.done = updates.done;
  if (updates.kind !== undefined) patch.kind = updates.kind;
  if (updates.allDay !== undefined) patch.all_day = updates.allDay;

  if (Object.keys(patch).length === 0) return; // nothing to change
  const { error } = await supabase.from('tasks').update(patch).eq('id', taskId);
  if (error) throw error;
}

export async function deleteTask(taskId: string): Promise<void> {
  const { error } = await supabase.from('tasks').delete().eq('id', taskId);
  if (error) throw error;
}

/** Deletes an import and (via cascade) every task that came from it. */
export async function deleteImport(importId: string): Promise<void> {
  const { error } = await supabase.from('imports').delete().eq('id', importId);
  if (error) throw error;
}
