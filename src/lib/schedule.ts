import {
  format,
  isToday,
  isTomorrow,
  isYesterday,
  differenceInCalendarDays,
  addDays,
  startOfDay,
  endOfDay,
  isSameDay,
} from 'date-fns';
import { RRule } from 'rrule';
import type { Task, Priority, ItemKind } from '../types/Task';
import { DEFAULT_WORKING_HOURS, type WorkingHours } from './preferences';

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

// --- Auto-scheduling ----------------------------------------------------------
// Place undone, untimed tasks into the free time left by a person's working
// hours (work/school block carved out) and their fixed events, earliest deadline
// first. `planDay` plans a single day; `planAhead` distributes work across the
// coming days and can split a big task into sessions. All pure/side-effect free —
// the Today view previews the result and commits it via updateTask/createItem.

/** Tasks due within this many days of the planned day are candidates. */
export const PLAN_HORIZON_DAYS = 7;
/** How many days forward `planAhead` distributes work over. */
export const PLAN_AHEAD_DAYS = 14;
/** Don't carve out a focus session shorter than this — too small to be useful. */
const MIN_SESSION_MIN = 30;

const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

export interface PlannedBlock {
  task: Task;
  start: Date;
  end: Date;
  /** Set when a task is split across days: this session's 1-based index + total. */
  part?: { index: number; total: number };
  /** Action-guiding label (AI-written, or templated fallback). */
  actionText?: string;
}

export interface DayPlan {
  /** Proposed time blocks, sorted earliest-first. */
  blocks: PlannedBlock[];
  /** Eligible tasks that didn't fit (or couldn't be fully scheduled) before their deadline. */
  unplaced: Task[];
}

export interface PlanOptions {
  /** Break tasks longer than one session across multiple days, up to the deadline. */
  split: boolean;
  /** Days forward to consider (default PLAN_AHEAD_DAYS). */
  horizonDays?: number;
}

interface Interval {
  start: Date;
  end: Date;
}

interface Gap {
  cursor: Date;
  end: Date;
}

/** A task's working length: its estimate, or the default when none is set. */
function taskDurationMin(task: Task): number {
  return task.estimatedMinutes && task.estimatedMinutes > 0
    ? task.estimatedMinutes
    : DEFAULT_DURATION_MIN;
}

function gapMinutes(g: Gap): number {
  return (g.end.getTime() - g.cursor.getTime()) / 60_000;
}

function addMinutes(d: Date, min: number): Date {
  return new Date(d.getTime() + min * 60_000);
}

/** Resolve "HH:MM" on a given calendar day to a concrete local Date. */
function atTime(day: Date, hm: string): Date {
  const [h, m] = hm.split(':').map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h || 0, m || 0, 0, 0);
}

/** Sort + merge overlapping/touching intervals. */
function mergeIntervals(intervals: Interval[]): Interval[] {
  const merged: Interval[] = [];
  for (const b of [...intervals].sort((a, b) => a.start.getTime() - b.start.getTime())) {
    const last = merged[merged.length - 1];
    if (last && b.start <= last.end) {
      if (b.end > last.end) last.end = b.end;
    } else {
      merged.push({ start: new Date(b.start), end: new Date(b.end) });
    }
  }
  return merged;
}

/** Subtract busy intervals from free windows, returning the leftover gaps. */
function freeGaps(windows: Interval[], busy: Interval[]): Gap[] {
  const gaps: Gap[] = [];
  for (const w of windows) {
    let cur = w.start;
    for (const b of busy) {
      if (b.end <= cur) continue;
      if (b.start >= w.end) break;
      if (b.start > cur) {
        gaps.push({ cursor: new Date(cur), end: new Date(Math.min(b.start.getTime(), w.end.getTime())) });
      }
      if (b.end > cur) cur = b.end;
      if (cur >= w.end) break;
    }
    if (cur < w.end) gaps.push({ cursor: new Date(cur), end: new Date(w.end) });
  }
  return gaps.filter((g) => g.end > g.cursor);
}

/**
 * The free windows on `day` per the user's working hours: the [dayStart, dayEnd]
 * span, with the work/school block carved out on workdays.
 */
export function freeWindowsForDay(day: Date, prefs: WorkingHours): Interval[] {
  const dayStart = atTime(day, prefs.dayStart);
  const dayEnd = atTime(day, prefs.dayEnd);
  if (dayEnd <= dayStart) return [];
  const base: Interval[] = [{ start: dayStart, end: dayEnd }];
  if (!prefs.workdays.includes(day.getDay())) return base;
  const work: Interval = { start: atTime(day, prefs.workStart), end: atTime(day, prefs.workEnd) };
  return freeGaps(base, [work]).map((g) => ({ start: g.cursor, end: g.end }));
}

/** Merged busy intervals on `day` from timed events + already-timed tasks. */
function dayBusyIntervals(items: Task[], day: Date): Interval[] {
  const occ = resolveOccurrences(items, startOfDay(day), endOfDay(day)).filter((o) =>
    isSameDay(o.date, day),
  );
  const busy: Interval[] = [];
  for (const o of occ) {
    if (o.kind === 'event') {
      if (o.item.allDay) continue; // all-day events don't block specific hours
      busy.push({ start: o.date, end: o.end ?? addMinutes(o.date, DEFAULT_DURATION_MIN) });
    } else if (o.item.dueTime) {
      busy.push({ start: o.date, end: addMinutes(o.date, taskDurationMin(o.item)) });
    }
  }
  return mergeIntervals(busy);
}

/** If `day` is today, push window starts to "now" so nothing lands in the past. */
function clampToNow(windows: Interval[], day: Date): Interval[] {
  if (!isToday(day)) return windows;
  const now = new Date();
  return windows
    .map((w) => ({ start: w.start < now ? now : w.start, end: w.end }))
    .filter((w) => w.end > w.start);
}

/** Undone, untimed, dated tasks due within the horizon (overdue included), urgency-ordered. */
function candidateTasks(items: Task[], from: Date, horizonDays: number): Task[] {
  const horizon = endOfDay(addDays(from, horizonDays));
  return items
    .filter((t) => itemKind(t) === 'task' && !t.done && !t.dueTime && !!t.dueDate)
    .map((t) => ({ t, due: parseDue(t) }))
    .filter((x): x is { t: Task; due: Date } => !!x.due && x.due <= horizon)
    .sort(
      (a, b) =>
        a.due.getTime() - b.due.getTime() ||
        PRIORITY_RANK[a.t.priority ?? 'medium'] - PRIORITY_RANK[b.t.priority ?? 'medium'],
    )
    .map((x) => x.t);
}

/**
 * Plan a single day: place eligible tasks into that day's free gaps (working
 * hours minus events and already-timed tasks), earliest-deadline first, capped at
 * `prefs.maxPerDayMinutes`. First-fit, one block per task, no splitting.
 */
export function planDay(items: Task[], day: Date, prefs: WorkingHours = DEFAULT_WORKING_HOURS): DayPlan {
  const windows = clampToNow(freeWindowsForDay(day, prefs), day);
  const gaps = freeGaps(windows, dayBusyIntervals(items, day));

  const blocks: PlannedBlock[] = [];
  const unplaced: Task[] = [];
  let remaining = prefs.maxPerDayMinutes;

  for (const task of candidateTasks(items, day, PLAN_HORIZON_DAYS)) {
    const dur = taskDurationMin(task);
    const gap = dur <= remaining ? gaps.find((g) => gapMinutes(g) >= dur) : undefined;
    if (gap) {
      const start = new Date(gap.cursor);
      const end = addMinutes(start, dur);
      blocks.push({ task, start, end });
      gap.cursor = end;
      remaining -= dur;
    } else {
      unplaced.push(task);
    }
  }
  blocks.sort((a, b) => a.start.getTime() - b.start.getTime());
  return { blocks, unplaced };
}

interface DaySlots {
  day: Date;
  gaps: Gap[];
  remaining: number;
}

/**
 * Plan across the coming days. Distributes each task onto the earliest day that
 * still has capacity at or before its deadline, respecting working hours and
 * `maxPerDayMinutes`. With `opts.split`, a task longer than `sessionMinutes` is
 * broken into multiple sessions spread across days up to its deadline.
 */
export function planAhead(
  items: Task[],
  fromDay: Date,
  prefs: WorkingHours = DEFAULT_WORKING_HOURS,
  opts: PlanOptions = { split: false },
): DayPlan {
  const horizonDays = opts.horizonDays ?? PLAN_AHEAD_DAYS;
  const from = startOfDay(fromDay);

  // Build the capacity model for each day in the horizon.
  const days: DaySlots[] = [];
  for (let i = 0; i <= horizonDays; i++) {
    const d = addDays(from, i);
    const windows = clampToNow(freeWindowsForDay(d, prefs), d);
    days.push({ day: d, gaps: freeGaps(windows, dayBusyIntervals(items, d)), remaining: prefs.maxPerDayMinutes });
  }

  const blocks: PlannedBlock[] = [];
  const unplaced: Task[] = [];

  for (const task of candidateTasks(items, fromDay, horizonDays)) {
    const due = parseDue(task);
    if (!due) continue;
    const dueDay = startOfDay(due);
    const overdue = dueDay < from; // place overdue work as soon as possible
    const eligible = (slot: DaySlots) => overdue || slot.day <= dueDay;

    if (!opts.split) {
      const dur = taskDurationMin(task);
      let placed = false;
      for (const slot of days) {
        if (!eligible(slot) || slot.remaining < dur) continue;
        const gap = slot.gaps.find((g) => gapMinutes(g) >= dur);
        if (gap) {
          const start = new Date(gap.cursor);
          const end = addMinutes(start, dur);
          blocks.push({ task, start, end });
          gap.cursor = end;
          slot.remaining -= dur;
          placed = true;
          break;
        }
      }
      if (!placed) unplaced.push(task);
      continue;
    }

    // Split mode: lay down sessions across eligible days until fully scheduled.
    let rem = taskDurationMin(task);
    const sessions: Interval[] = [];
    for (const slot of days) {
      if (rem <= 0) break;
      if (!eligible(slot)) continue;
      while (rem > 0 && slot.remaining >= MIN_SESSION_MIN) {
        const gap = slot.gaps.find((g) => gapMinutes(g) >= MIN_SESSION_MIN);
        if (!gap) break;
        const room = Math.min(gapMinutes(gap), slot.remaining, prefs.sessionMinutes, rem);
        if (room < Math.min(MIN_SESSION_MIN, rem)) break;
        const start = new Date(gap.cursor);
        const end = addMinutes(start, room);
        sessions.push({ start, end });
        gap.cursor = end;
        slot.remaining -= room;
        rem -= room;
      }
    }
    const total = sessions.length;
    sessions.forEach((s, i) =>
      blocks.push({ task, start: s.start, end: s.end, part: total > 1 ? { index: i + 1, total } : undefined }),
    );
    if (rem > 0 || total === 0) unplaced.push(task);
  }

  blocks.sort((a, b) => a.start.getTime() - b.start.getTime());
  return { blocks, unplaced };
}

/** Compact label for an event's time range, e.g. "9:00 – 10:30 AM". */
export function eventTimeLabel(start: Date, end: Date | null, allDay?: boolean): string {
  if (allDay) return 'All day';
  if (!end) return format(start, 'h:mm a');
  const sameMeridiem = format(start, 'a') === format(end, 'a');
  return `${format(start, sameMeridiem ? 'h:mm' : 'h:mm a')} – ${format(end, 'h:mm a')}`;
}
