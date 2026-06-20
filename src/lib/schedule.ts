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
// rrule exposes a bundler-only `module` field, so Vite loads its real ESM build
// (named `RRule` export) while Node/tsx load the CJS build (where `RRule` is only
// reachable via the CJS default). Resolve from either so this module imports in
// both the browser app and the pure-planner unit tests in scripts/. The fallback
// is read via a computed key so the bundler doesn't flag the (absent) ESM default.
import * as rruleNs from 'rrule';
const rruleExports = rruleNs as unknown as Record<string, unknown>;
const RRule = (rruleExports.RRule ??
  (rruleExports['default'] as { RRule: unknown }).RRule) as typeof import('rrule').RRule;
import type { Task, ItemKind, Priority } from '../types/Task';
import { DEFAULT_WORKING_HOURS, type WorkingHours } from './preferences';

export const DEFAULT_DURATION_MIN = 60;

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

/**
 * Resolve a task's planned work session (when you'll *do* it — distinct from the
 * deadline) into a concrete start/end span. Returns null if no session is planned.
 */
export function parsePlanned(task: Task): Interval | null {
  if (!task.plannedDate || !task.plannedStart) return null;
  const [y, m, d] = task.plannedDate.split('-').map(Number);
  if (!y || !m || !d) return null;
  const [hh, mm] = task.plannedStart.split(':').map(Number);
  const start = new Date(y, m - 1, d, hh ?? 0, mm ?? 0);
  const minutes = task.plannedMinutes && task.plannedMinutes > 0 ? task.plannedMinutes : taskDurationMin(task);
  return { start, end: addMinutes(start, minutes) };
}

/**
 * Parse a stored event datetime as a *floating* local wall-clock time. Event
 * times are stored offset-free by design (api/_google.ts `eventToItem`, ItemForm),
 * but the `timestamptz` column round-trips them UTC-tagged ("…+00:00"). Letting
 * `new Date` interpret that would re-shift the wall clock by the browser's offset
 * — so we read the calendar fields directly and 2:00 PM always renders as 2:00 PM.
 */
function parseFloating(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const [, y, mo, d, hh, mm, ss] = m;
    return new Date(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), ss ? Number(ss) : 0);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Resolve an event's start datetime into a concrete Date (floating local). */
export function parseStart(item: Task): Date | null {
  return item.startAt ? parseFloating(item.startAt) : null;
}

export function parseEnd(item: Task): Date | null {
  return item.endAt ? parseFloating(item.endAt) : null;
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

// When the planner splits one big task across several work sessions, the first
// session commits onto the task itself (keeping its title + deadline) and each
// extra session becomes its own row labelled "<title> — session N of M". These
// two helpers are the single source of truth for that label, so the code that
// writes it and the code that reads it back can't drift apart.
const SPLIT_SESSION_RE = / — session (\d+) of (\d+)$/;

/** The title for the Nth extra split work-session row (N is 1-based over M total). */
export function splitSessionTitle(base: string, index: number, count: number): string {
  return `${base} — session ${index} of ${count}`;
}

/**
 * Parse a split-session row title back into its parts, or null if the title isn't
 * one of those rows (i.e. a plain task or the parent session-1 row). `base` is the
 * original task title with the suffix stripped, so the parent can be found again.
 */
export function parseSplitSession(
  title: string,
): { base: string; index: number; count: number } | null {
  const m = SPLIT_SESSION_RE.exec(title);
  if (!m) return null;
  return { base: title.replace(SPLIT_SESSION_RE, ''), index: Number(m[1]), count: Number(m[2]) };
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

/** Longer tasks get pulled forward in the schedule — 200 min ≈ 1 day of lead time. */
const EST_URGENCY_WEIGHT = 1 / 200;

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
  /** Pre-placed busy intervals to plan around (e.g. locked or hand-edited blocks). */
  fixed?: Interval[];
}

export interface Interval {
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
  // A per-date override wins over the recurring weekly pattern (holiday / extra school day).
  const override = prefs.overrides?.[dayKey(day)];
  let workInterval: Interval | null = null;
  if (override === 'off') {
    workInterval = null;
  } else if (typeof override === 'object' && override !== null) {
    // Custom hours (e.g. school Saturday that ends at 1 PM instead of 5 PM).
    workInterval = { start: atTime(day, override.start), end: atTime(day, override.end) };
  } else {
    // 'work' override or no override — fall back to the weekly pattern + default block.
    const isWorkday = override === 'work' || prefs.workdays.includes(day.getDay());
    if (isWorkday) {
      workInterval = { start: atTime(day, prefs.workStart), end: atTime(day, prefs.workEnd) };
    }
  }
  if (!workInterval) return base;
  return freeGaps(base, [workInterval]).map((g) => ({ start: g.cursor, end: g.end }));
}

/** Busy intervals on `day` from timed events + already-timed tasks, plus any
 * pre-placed `fixed` intervals (locked/edited blocks) that fall on the day. */
function busyForDay(items: Task[], day: Date, fixed: Interval[]): Interval[] {
  const pinned = fixed.filter((iv) => isSameDay(iv.start, day));
  return mergeIntervals([...dayBusyIntervals(items, day), ...pinned]);
}

/**
 * The concrete free intervals on `day` — working-hours windows minus events and
 * already-timed tasks, clamped so today's gaps never start in the past. Used by
 * the plan editor to validate hand-moved blocks.
 */
export function dayFreeIntervals(items: Task[], day: Date, prefs: WorkingHours = DEFAULT_WORKING_HOURS): Interval[] {
  const windows = clampToNow(freeWindowsForDay(day, prefs), day);
  return freeGaps(windows, dayBusyIntervals(items, day)).map((g) => ({ start: g.cursor, end: g.end }));
}

/**
 * Does `next` fit entirely inside a free window on its day (working hours minus
 * the busy time from `items`, plus `extraBusy`) without crossing midnight? Shared
 * by the plan preview's nudge controls and the live timeline's drag/resize editing
 * so both honour one rule. Callers exclude the block being moved so it can't block
 * itself: drop it from `items` when it's a committed session, or from `extraBusy`
 * when it's an uncommitted preview block.
 */
export function isValidPlacement(
  next: Interval,
  items: Task[],
  prefs: WorkingHours = DEFAULT_WORKING_HOURS,
  extraBusy: Interval[] = [],
): boolean {
  if (next.end <= next.start) return false;
  if (!isSameDay(next.start, next.end)) return false;
  const free = dayFreeIntervals(items, startOfDay(next.start), prefs);
  const inWindow = free.some(
    (w) => w.start.getTime() <= next.start.getTime() && next.end.getTime() <= w.end.getTime(),
  );
  if (!inWindow) return false;
  return !extraBusy.some((o) => o.start < next.end && o.end > next.start);
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
    }
  }
  // A task blocks time at its planned work session (a deadline is a point, not a
  // span — a "due 11:59pm" task shouldn't eat the whole evening).
  for (const item of items) {
    if (itemKind(item) !== 'task') continue;
    const session = parsePlanned(item);
    if (session && isSameDay(session.start, day)) busy.push(session);
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

/**
 * Lower = more urgent. Deadline dominates; longer estimated tasks get a
 * fractional-day pull-forward so big work starts before a tight deadline
 * without leaping past a meaningfully closer one.
 */
function urgencyScore(due: Date, estimatedMinutes: number, from: Date): number {
  return differenceInCalendarDays(due, from) - estimatedMinutes * EST_URGENCY_WEIGHT;
}

/** Undone, dated, not-yet-planned tasks due within the horizon (overdue included), urgency-ordered. */
function candidateTasks(items: Task[], from: Date, horizonDays: number): Task[] {
  const horizon = endOfDay(addDays(from, horizonDays));
  return items
    .filter((t) => itemKind(t) === 'task' && !t.done && !t.plannedDate && !!t.dueDate)
    .map((t) => ({ t, due: parseDue(t) }))
    .filter((x): x is { t: Task; due: Date } => !!x.due && x.due <= horizon)
    .sort(
      (a, b) =>
        urgencyScore(a.due, taskDurationMin(a.t), from) -
        urgencyScore(b.due, taskDurationMin(b.t), from),
    )
    .map((x) => x.t);
}

/**
 * Undone tasks with a planned work session whose start is already in the past —
 * work you scheduled into a slot but didn't do. Distinct from not-yet-planned
 * overdue tasks, which `planAhead`/`planDay` already pull in as candidates.
 *
 * Tasks the user has *started* (in progress) are excluded: they're actively being
 * worked, not slipping, so flagging them as "missed" the moment their slot ends is
 * a false alarm. They surface in the in-progress lane instead.
 */
export function stalePlannedTasks(items: Task[], now: Date = new Date()): Task[] {
  return items.filter((t) => {
    if (itemKind(t) !== 'task' || t.done || t.startedAt) return false;
    const session = parsePlanned(t);
    return !!session && session.start.getTime() < now.getTime();
  });
}

/** Tasks the user has tapped "Start" on and not yet finished — actively in progress. */
export function inProgressTasks(items: Task[]): Task[] {
  return items.filter((t) => itemKind(t) === 'task' && !t.done && !!t.startedAt);
}

/**
 * Incomplete tasks whose planned work session overlaps something it can't share
 * the time with — either a timed event (e.g. an event added after the plan was
 * committed) or *another* planned work session (a double-book you can't actually
 * do at once). Both want re-planning to pull the work onto free time.
 */
export function conflictedPlannedTasks(items: Task[]): Task[] {
  const planned = items
    .map((t) => ({ t, session: parsePlanned(t) }))
    .filter((x): x is { t: Task; session: Interval } => itemKind(x.t) === 'task' && !x.t.done && !!x.session);
  if (planned.length === 0) return [];
  let min = planned[0].session.start;
  let max = planned[0].session.end;
  for (const { session } of planned) {
    if (session.start < min) min = session.start;
    if (session.end > max) max = session.end;
  }
  const events = resolveOccurrences(items, startOfDay(min), endOfDay(max)).filter(
    (o): o is ScheduledItem & { end: Date } => o.kind === 'event' && !o.item.allDay && !!o.end,
  );
  const overlaps = (a: Interval, b: Interval) => a.start < b.end && a.end > b.start;
  return planned
    .filter(
      ({ t, session }) =>
        events.some((e) => overlaps({ start: e.date, end: e.end }, session)) ||
        planned.some((p) => p.t.id !== t.id && overlaps(p.session, session)),
    )
    .map((x) => x.t);
}

/**
 * Events whose times overlap another event within [rangeStart, rangeEnd] — two
 * commitments booked at once, which you can't physically be at both of. Recurring
 * events are expanded, so a weekly class landing on a one-off meeting is caught.
 * All-day events span no specific hours, so they never count as a clash. Returns
 * each conflicting event once (deduped by id), at its earliest clashing time first.
 */
export function conflictingEvents(items: Task[], rangeStart: Date, rangeEnd: Date): Task[] {
  const occ = resolveOccurrences(items, rangeStart, rangeEnd).filter(
    (o): o is ScheduledItem & { end: Date } => o.kind === 'event' && !o.item.allDay && !!o.end,
  );
  const overlaps = (a: ScheduledItem & { end: Date }, b: ScheduledItem & { end: Date }) =>
    a.date < b.end && a.end > b.date;
  // occ is sorted soonest-first, so j > i compares each pair once and records the
  // earliest time each event is involved in a clash.
  const clashing = new Map<string, { item: Task; at: number }>();
  const mark = (o: ScheduledItem & { end: Date }) => {
    const prev = clashing.get(o.item.id);
    if (!prev || o.date.getTime() < prev.at) clashing.set(o.item.id, { item: o.item, at: o.date.getTime() });
  };
  for (let i = 0; i < occ.length; i++) {
    for (let j = i + 1; j < occ.length; j++) {
      if (occ[i].item.id === occ[j].item.id) continue; // a recurring event can't clash with itself
      if (occ[j].date >= occ[i].end) break; // sorted: nothing later can overlap occ[i]
      if (overlaps(occ[i], occ[j])) {
        mark(occ[i]);
        mark(occ[j]);
      }
    }
  }
  return [...clashing.values()].sort((a, b) => a.at - b.at).map((x) => x.item);
}

/** The urgency buckets the "Everything left" rail groups remaining work into. */
export type WorkloadBucketId = 'overdue' | 'today' | 'week' | 'later' | 'undated';

export interface WorkloadGroup {
  id: WorkloadBucketId;
  /** Human label for the bucket heading. */
  label: string;
  /** Tasks in the bucket: dated ones by soonest due, undated by priority then title. */
  tasks: Task[];
  /** Σ working length of the bucket's tasks (estimate, or default when unset). */
  totalMinutes: number;
}

const BUCKET_LABELS: Record<WorkloadBucketId, string> = {
  overdue: 'Overdue',
  today: 'Today',
  week: 'This week',
  later: 'Later',
  undated: 'No date',
};

const BUCKET_ORDER: WorkloadBucketId[] = ['overdue', 'today', 'week', 'later', 'undated'];

const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

/**
 * Group every *incomplete task* (events excluded — they're commitments, not work to
 * grind down) into calm urgency buckets for the Daily Plan's "Everything left" rail.
 * Seeing the whole, organized scope is what reduces overwhelm. Returns only non-empty
 * groups, always in `Overdue → Today → This week → Later → No date` order.
 */
export function workloadBuckets(items: Task[], now: Date): WorkloadGroup[] {
  const order: Record<WorkloadBucketId, { task: Task; due: Date | null }[]> = {
    overdue: [], today: [], week: [], later: [], undated: [],
  };
  for (const task of items) {
    if (itemKind(task) !== 'task' || task.done) continue;
    const due = parseDue(task);
    if (!due) { order.undated.push({ task, due: null }); continue; }
    const diff = differenceInCalendarDays(due, now);
    const id: WorkloadBucketId =
      diff < 0 ? 'overdue' : diff === 0 ? 'today' : diff <= 7 ? 'week' : 'later';
    order[id].push({ task, due });
  }

  return BUCKET_ORDER.flatMap((id) => {
    const entries = order[id];
    if (entries.length === 0) return [];
    entries.sort((a, b) =>
      a.due && b.due
        ? a.due.getTime() - b.due.getTime()
        : PRIORITY_RANK[a.task.priority ?? 'medium'] - PRIORITY_RANK[b.task.priority ?? 'medium'] ||
          a.task.title.localeCompare(b.task.title),
    );
    return [{
      id,
      label: BUCKET_LABELS[id],
      tasks: entries.map((e) => e.task),
      totalMinutes: entries.reduce((sum, e) => sum + taskDurationMin(e.task), 0),
    }];
  });
}

/** One day's committed-vs-free-time load, for the week-at-a-glance strip. */
export interface DayLoad {
  /** Midnight of the day. */
  day: Date;
  /** Booked minutes: timed events + planned work sessions on the day. */
  committedMinutes: number;
  /** Free minutes: the day's actual open time — the working-hours window
   * (`dayStart`–`dayEnd`) minus the work/school block. This is real availability,
   * not the planner's per-day focus budget (`maxPerDayMinutes`). */
  freeMinutes: number;
  /** Booked more than the day's free time — flagged so the strip can warn. */
  over: boolean;
}

const intervalMinutes = (intervals: Interval[]): number =>
  intervals.reduce((sum, iv) => sum + (iv.end.getTime() - iv.start.getTime()) / 60_000, 0);

/**
 * The Mon–Sun (or any 7 days from `weekStart`) workload picture for the "will I
 * make it this week?" strip. Per day: `committedMinutes` is what's already booked
 * (timed events + planned work sessions, merged so overlaps aren't double-counted),
 * `freeMinutes` is the day's actual open time (the `dayStart`–`dayEnd` window minus
 * the work/school block), and `over` flags a day booked past that free time. Pure +
 * unit-tested; reuses the same busy/free model the planner places blocks into.
 *
 * Note `freeMinutes` is genuine availability, deliberately *not* capped by
 * `maxPerDayMinutes` — that cap is how much focused work the planner schedules per
 * day, not how many hours you actually have, so capping here would read as "3h free"
 * on a wide-open day.
 */
export function weeklyLoad(
  items: Task[],
  weekStart: Date,
  prefs: WorkingHours = DEFAULT_WORKING_HOURS,
): DayLoad[] {
  const start = startOfDay(weekStart);
  const days: DayLoad[] = [];
  for (let i = 0; i < 7; i++) {
    const day = addDays(start, i);
    const committedMinutes = Math.round(intervalMinutes(dayBusyIntervals(items, day)));
    const freeMinutes = Math.round(intervalMinutes(freeWindowsForDay(day, prefs)));
    days.push({ day, committedMinutes, freeMinutes, over: committedMinutes > freeMinutes });
  }
  return days;
}

/**
 * Plan a single day: place eligible tasks into that day's free gaps (working
 * hours minus events and already-timed tasks), earliest-deadline first, capped at
 * `prefs.maxPerDayMinutes`. First-fit, one block per task, no splitting.
 */
export function planDay(items: Task[], day: Date, prefs: WorkingHours = DEFAULT_WORKING_HOURS): DayPlan {
  const windows = clampToNow(freeWindowsForDay(day, prefs), day);
  const gaps = freeGaps(windows, dayBusyIntervals(items, day));
  const breakMin = prefs.breakMinutes ?? 0;

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
      // Leave a break before whatever lands next in this gap (doesn't use capacity).
      gap.cursor = addMinutes(end, breakMin);
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
  const breakMin = prefs.breakMinutes ?? 0;
  const fixed = opts.fixed ?? [];

  // Build the capacity model for each day in the horizon (around fixed blocks).
  const days: DaySlots[] = [];
  for (let i = 0; i <= horizonDays; i++) {
    const d = addDays(from, i);
    const windows = clampToNow(freeWindowsForDay(d, prefs), d);
    days.push({ day: d, gaps: freeGaps(windows, busyForDay(items, d, fixed)), remaining: prefs.maxPerDayMinutes });
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
          gap.cursor = addMinutes(end, breakMin);
          slot.remaining -= dur;
          placed = true;
          break;
        }
      }
      if (!placed) unplaced.push(task);
      continue;
    }

    // Split mode: lay down sessions across eligible days until fully scheduled.
    const sessions: Interval[] = [];
    let rem = taskDurationMin(task);

    /** Place a single session in this day's earliest fitting gap; returns minutes laid. */
    const placeOne = (slot: DaySlots): number => {
      if (rem <= 0 || slot.remaining < MIN_SESSION_MIN) return 0;
      const gap = slot.gaps.find((g) => gapMinutes(g) >= MIN_SESSION_MIN);
      if (!gap) return 0;
      const room = Math.min(gapMinutes(gap), slot.remaining, prefs.sessionMinutes, rem);
      if (room < Math.min(MIN_SESSION_MIN, rem)) return 0;
      const start = new Date(gap.cursor);
      const end = addMinutes(start, room);
      sessions.push({ start, end });
      gap.cursor = addMinutes(end, breakMin);
      slot.remaining -= room;
      rem -= room;
      return room;
    };

    // When spacing is on (and the task isn't already overdue), first lay at most
    // one session per eligible day so study spreads out instead of front-loading.
    if ((prefs.spaceSessions ?? true) && !overdue) {
      for (const slot of days) {
        if (rem <= 0) break;
        if (eligible(slot)) placeOne(slot);
      }
    }
    // Packing pass: fill the remaining minutes (the only pass when spacing is off,
    // and the fallback when one-per-day couldn't finish before the deadline).
    for (const slot of days) {
      if (rem <= 0) break;
      if (!eligible(slot)) continue;
      while (placeOne(slot) > 0) {
        /* keep filling this day */
      }
    }

    const total = sessions.length;
    sessions
      .sort((a, b) => a.start.getTime() - b.start.getTime())
      .forEach((s, i) =>
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
