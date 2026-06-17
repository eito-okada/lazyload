import { supabase } from '../lib/supabase';
import type { Task, Priority, ItemKind } from '../types/Task';

// Suggestions staged by the Gmail scan (cron or manual), awaiting review. The
// rows have normal owner RLS policies, so the browser reads/deletes them
// directly — same publishable-key pattern as `tasks` in ./tasks.ts.

const COLUMNS =
  'id, message_id, email_from, email_subject, email_snippet, title, subject, due_date, due_time, ' +
  'estimated_minutes, priority, kind, start_at, end_at, all_day, location';

/** A staged suggestion: the draft Task plus the email it came from (for review). */
export interface Suggestion {
  task: Task;
  messageId: string;
  emailFrom?: string;
  emailSubject?: string;
  emailSnippet?: string;
}

interface SuggestionRow {
  id: string;
  message_id: string;
  email_from: string | null;
  email_subject: string | null;
  email_snippet: string | null;
  title: string;
  subject: string | null;
  due_date: string | null;
  due_time: string | null;
  estimated_minutes: number | null;
  priority: Priority;
  kind: ItemKind | null;
  start_at: string | null;
  end_at: string | null;
  all_day: boolean | null;
  location: string | null;
}

/** A suggestion row → its draft Task (the Task `id` is the suggestion row id). */
function rowToSuggestion(row: SuggestionRow): Suggestion {
  return {
    task: {
      id: row.id,
      title: row.title,
      subject: row.subject ?? undefined,
      dueDate: row.due_date ?? undefined,
      dueTime: row.due_time ?? undefined,
      estimatedMinutes: row.estimated_minutes ?? undefined,
      priority: row.priority,
      kind: row.kind ?? 'task',
      startAt: row.start_at ?? undefined,
      endAt: row.end_at ?? undefined,
      allDay: row.all_day ?? undefined,
      location: row.location ?? undefined,
    },
    messageId: row.message_id,
    emailFrom: row.email_from ?? undefined,
    emailSubject: row.email_subject ?? undefined,
    emailSnippet: row.email_snippet ?? undefined,
  };
}

/** Pending suggestions for the current user, newest first. */
export async function fetchSuggestions(): Promise<Suggestion[]> {
  const { data, error } = await supabase
    .from('gmail_suggestions')
    .select(COLUMNS)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data as unknown as SuggestionRow[]).map(rowToSuggestion);
}

/** Remove a suggestion (used by both approve — after creating the task — and dismiss). */
export async function deleteSuggestion(id: string): Promise<void> {
  const { error } = await supabase.from('gmail_suggestions').delete().eq('id', id);
  if (error) throw error;
}
