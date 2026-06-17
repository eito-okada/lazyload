import { supabase } from '../lib/supabase';
import type { Task, Priority, ItemKind } from '../types/Task';

const COLUMNS =
  'id, import_id, title, subject, due_date, due_time, estimated_minutes, priority, done, ' +
  'kind, start_at, end_at, all_day, location, recurrence_rule';

interface TaskRow {
  id: string;
  import_id: string | null;
  title: string;
  subject: string | null;
  due_date: string | null;
  due_time: string | null;
  estimated_minutes: number | null;
  priority: Priority;
  done: boolean;
  kind: ItemKind | null;
  start_at: string | null;
  end_at: string | null;
  all_day: boolean | null;
  location: string | null;
  recurrence_rule: string | null;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    subject: row.subject ?? undefined,
    dueDate: row.due_date ?? undefined,
    dueTime: row.due_time ?? undefined,
    estimatedMinutes: row.estimated_minutes ?? undefined,
    priority: row.priority,
    done: row.done,
    kind: row.kind ?? 'task',
    startAt: row.start_at ?? undefined,
    endAt: row.end_at ?? undefined,
    allDay: row.all_day ?? undefined,
    location: row.location ?? undefined,
    recurrenceRule: row.recurrence_rule ?? undefined,
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
    priority: item.priority ?? 'medium',
    kind: item.kind ?? 'task',
    start_at: item.startAt ?? null,
    end_at: item.endAt ?? null,
    all_day: item.allDay ?? false,
    location: item.location ?? null,
    recurrence_rule: item.recurrenceRule ?? null,
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
  if (updates.title !== undefined) patch.title = updates.title;
  if (updates.subject !== undefined) patch.subject = updates.subject ?? null;
  if (updates.dueDate !== undefined) patch.due_date = updates.dueDate ?? null;
  if (updates.dueTime !== undefined) patch.due_time = updates.dueTime ?? null;
  if (updates.estimatedMinutes !== undefined) patch.estimated_minutes = updates.estimatedMinutes ?? null;
  if (updates.priority !== undefined) patch.priority = updates.priority;
  if (updates.done !== undefined) patch.done = updates.done;
  if (updates.kind !== undefined) patch.kind = updates.kind;
  if (updates.startAt !== undefined) patch.start_at = updates.startAt ?? null;
  if (updates.endAt !== undefined) patch.end_at = updates.endAt ?? null;
  if (updates.allDay !== undefined) patch.all_day = updates.allDay;
  if (updates.location !== undefined) patch.location = updates.location ?? null;
  if (updates.recurrenceRule !== undefined) patch.recurrence_rule = updates.recurrenceRule ?? null;

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
