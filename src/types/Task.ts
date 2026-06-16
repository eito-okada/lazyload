export type Priority = "high" | "medium" | "low";

export interface Task {
  id: string;
  title: string;
  subject?: string;
  /** Absolute due date in ISO form, e.g. "2026-06-17". */
  dueDate?: string;
  /** Start time in 24h "HH:MM" form, when the source shows a specific time. */
  startTime?: string;
  estimatedMinutes?: number;
  priority?: Priority;
}
