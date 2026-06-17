import {
  format,
  isToday,
  isTomorrow,
  isYesterday,
  differenceInCalendarDays,
} from 'date-fns';
import { RRule } from 'rrule';
import type { Task, Priority, ItemKind } from '../types/Task';

export const DEFAULT_DURATION_MIN = 60;

export const PRIORITY_LABEL: Record<Priority, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

export function itemKind(item: Task): ItemKind {
  return item.kind ?? 'task';
}

/** Resolve a task's due date (+ optional time) into a concrete Date. */
export function parseDue(task: Task): Date | null {
  if (!task.dueDate) return null;
  const [y, m, d] = task.dueDate.split('-').map(Number);
  if (!y || !m || !d) return null;
  if (task.dueTime) {
    const [hh, mm] = task.dueTime.split(':').map(Number);
    return new Date(y, m - 1, d, hh ?? 0, mm ?? 0);
  }
  return new Date(y, m - 1, d);
}

/** Resolve an event's start datetime into a concrete Date. */
export function parseStart(item: Task): Date | null {
  if (!item.startAt) return null;
  const d = new Date(item.startAt);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseEnd(item: Task): Date | null {
  if (!item.endAt) return null;
  const d = new Date(item.endAt);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function dayKey(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

export function relativeLabel(date: Date): string {
  if (isToday(date)) return 'Today';
  if (isTomorrow(date)) return 'Tomorrow';
  if (isYesterday(date)) return 'Yesterday';
  return format(date, 'EEEE, MMM d');
}

export function dueBadge(date: Date): { text: string; tone: 'overdue' | 'soon' | 'later' } {
  const diff = differenceInCalendarDays(date, new Date());
  if (diff < 0) return { text: diff === -1 ? '1 day overdue' : `${-diff} days overdue`, tone: 'overdue' };
  if (diff === 0) return { text: 'Due today', tone: 'soon' };
  if (diff === 1) return { text: 'Due tomorrow', tone: 'soon' };
  return { text: `in ${diff} days`, tone: 'later' };
}

/** A single resolved occurrence of an item on a concrete date/time. */
export interface ScheduledItem {
  item: Task;
  kind: ItemKind;
  /** Resolved start (events) or due (tasks) instant. */
  date: Date;
  /** Event end instant; null for tasks. */
  end: Date | null;
  /** Unique per occurrence (an item may recur), for React keys. */
  occurrenceKey: string;
}

// --- Recurrence ---------------------------------------------------------------
// rrule operates in UTC. We store/render events in the browser's local time, so
// we translate local Dates to "floating" UTC for rrule and back again. This is
// the documented workaround and is correct under the single-timezone assumption.

function localToFloating(d: Date): Date {
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()));
}

function floatingToLocal(d: Date): Date {
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
}

/** Expand a recurring item's start times that fall within [rangeStart, rangeEnd]. */
export function expandOccurrences(item: Task, start: Date, rangeStart: Date, rangeEnd: Date): Date[] {
  if (!item.recurrenceRule) return [];
  try {
    const options = RRule.parseString(item.recurrenceRule);
    options.dtstart = localToFloating(start);
    const rule = new RRule(options);
    return rule
      .between(localToFloating(rangeStart), localToFloating(rangeEnd), true)
      .map(floatingToLocal);
  } catch {
    return [];
  }
}

function eventDurationMs(start: Date, end: Date | null): number {
  if (end && end.getTime() > start.getTime()) return end.getTime() - start.getTime();
  return DEFAULT_DURATION_MIN * 60_000;
}

/**
 * Resolve a list of items into concrete dated occurrences, sorted soonest-first.
 * Tasks and single events are always included (they're finite); recurring events
 * are expanded only within [rangeStart, rangeEnd].
 */
export function resolveOccurrences(items: Task[], rangeStart: Date, rangeEnd: Date): ScheduledItem[] {
  const out: ScheduledItem[] = [];
  for (const item of items) {
    if (itemKind(item) === 'event') {
      const start = parseStart(item);
      if (!start) continue;
      const durationMs = eventDurationMs(start, parseEnd(item));
      if (item.recurrenceRule) {
        for (const occ of expandOccurrences(item, start, rangeStart, rangeEnd)) {
          out.push({
            item,
            kind: 'event',
            date: occ,
            end: new Date(occ.getTime() + durationMs),
            occurrenceKey: `${item.id}@${occ.getTime()}`,
          });
        }
      } else {
        out.push({
          item,
          kind: 'event',
          date: start,
          end: new Date(start.getTime() + durationMs),
          occurrenceKey: item.id,
        });
      }
    } else {
      const due = parseDue(item);
      if (!due) continue;
      out.push({ item, kind: 'task', date: due, end: null, occurrenceKey: item.id });
    }
  }
  return out.sort((a, b) => a.date.getTime() - b.date.getTime());
}

/** Items with no resolvable date (tasks without a due date, events without a start). */
export function undatedItems(items: Task[]): Task[] {
  return items.filter((item) =>
    itemKind(item) === 'event' ? !parseStart(item) : !parseDue(item),
  );
}

/** Compact label for an event's time range, e.g. "9:00 – 10:30 AM". */
export function eventTimeLabel(start: Date, end: Date | null, allDay?: boolean): string {
  if (allDay) return 'All day';
  if (!end) return format(start, 'h:mm a');
  const sameMeridiem = format(start, 'a') === format(end, 'a');
  return `${format(start, sameMeridiem ? 'h:mm' : 'h:mm a')} – ${format(end, 'h:mm a')}`;
}
