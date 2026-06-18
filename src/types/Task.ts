export type Priority = "high" | "medium" | "low";

/** An item is either a homework "task" (has a deadline) or a calendar "event" (has a span). */
export type ItemKind = "task" | "event";

/** Where an item came from. 'google' = mirrored in from Google Calendar (v5). */
export type ItemSource = "local" | "google";

export interface Task {
  id: string;
  title: string;
  subject?: string;
  /** What this item is. Defaults to "task" when absent (e.g. extracted homework). */
  kind?: ItemKind;
  priority?: Priority;
  done?: boolean;
  /** Origin of the item; 'local' unless it first appeared on Google Calendar. */
  source?: ItemSource;

  // --- Task fields (kind === "task") ---
  /** Absolute due date in ISO form, e.g. "2026-06-17". */
  dueDate?: string;
  /** Due time in 24h "HH:MM" form, when the source shows a specific time. */
  dueTime?: string;
  estimatedMinutes?: number;

  // --- Event fields (kind === "event") ---
  /** Event start as an ISO datetime string, e.g. "2026-06-17T09:00". */
  startAt?: string;
  /** Event end as an ISO datetime string. */
  endAt?: string;
  /** All-day event (no specific time shown). */
  allDay?: boolean;
  /** Free-text location or link. */
  location?: string;
  /** RFC-5545 RRULE string for recurring events (e.g. "FREQ=WEEKLY;BYDAY=MO,WE"). */
  recurrenceRule?: string;
}

/** Alias: the table holds both tasks and events, conceptually "items". */
export type Item = Task;
