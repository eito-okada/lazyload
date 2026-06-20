import { useEffect, useMemo, useRef, useState } from 'react';
import { addDays, startOfDay, endOfDay, isToday, isSameDay, differenceInCalendarDays, format } from 'date-fns';
import {
  ChevronLeft,
  ChevronRight,
  Sun,
  Plus,
  Sparkles,
  Check,
  X,
  Clock,
  CheckCircle2,
  Circle,
  CircleDot,
  Play,
  CalendarPlus,
  Settings2,
  History,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTasks } from '../context/TaskContext';
import type { Task } from '../types/Task';
import ItemRow from '../components/TaskRow';
import ItemDetail from '../components/ItemDetail';
import DayTimeline, { type TimelineBlock } from '../components/DayTimeline';
import WorkloadRail from '../components/WorkloadRail';
import WeekStrip from '../components/WeekStrip';
import { useWorkingHours } from '../lib/preferences';
import {
  buildBriefing,
  pickFocus,
  overduePlanNote,
  completionNudge,
  estimateBiasNudge,
  formatDuration,
} from '../lib/coach';
import type { DragMode } from '../lib/useBlockDrag';
import { generatePlanText, type PlanTextInput } from '../services/api';
import {
  resolveOccurrences,
  planAhead,
  parseDue,
  dayKey,
  relativeLabel,
  itemKind,
  stalePlannedTasks,
  inProgressTasks,
  conflictedPlannedTasks,
  conflictingEvents,
  workloadBuckets,
  splitSessionTitle,
  parseSplitSession,
  parsePlanned,
  parseStart,
  parseEnd,
  isValidPlacement as placementOk,
  type ScheduledItem,
  type PlannedBlock,
  type Interval,
} from '../lib/schedule';

/** A previewed block carrying edit state on top of the computed placement. */
interface EditBlock extends PlannedBlock {
  /** Stable id across time edits, for React keys + edit targeting. */
  uid: string;
  /** Pinned: kept as-is when re-planning around it. */
  locked?: boolean;
}

interface EditPlan {
  blocks: EditBlock[];
  unplaced: Task[];
}

/** Step size (minutes) for nudging a block's time or changing its duration. */
const STEP = 15;

let blockSeq = 0;
const newUid = () => `b${blockSeq++}`;
const shiftMin = (d: Date, min: number) => new Date(d.getTime() + min * 60_000);

function isTimedEvent(occ: ScheduledItem): boolean {
  return itemKind(occ.item) === 'event' && !occ.item.allDay;
}

/** Minutes spanned by a block (≥ 1). */
function blockMinutes(b: PlannedBlock): number {
  return Math.max(1, Math.round((b.end.getTime() - b.start.getTime()) / 60_000));
}

/** Stable id for a block, shared between the AI request and the response merge. */
function blockKey(b: PlannedBlock): string {
  return `${b.task.id}#${b.part?.index ?? 0}#${b.start.getTime()}`;
}

const withUids = (blocks: PlannedBlock[]): EditBlock[] => blocks.map((b) => ({ ...b, uid: newUid() }));

export default function Today() {
  const { allTasks, updateTask, createItem, deleteTask } = useTasks();
  const [prefs] = useWorkingHours();
  const [day, setDay] = useState(() => new Date());
  // A live clock so the timeline's "now" line and the greeting stay current.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  // Which timeline block has its inline tap controls open.
  const [selectedBlock, setSelectedBlock] = useState<string | null>(null);
  const [plan, setPlan] = useState<EditPlan | null>(null);
  // When set, the active preview is a full re-plan: on Accept, sessions cleared
  // for re-planning that didn't land again are wiped and split-children removed.
  const [replan, setReplan] = useState<{ clear: Set<string>; deleteChildren: Set<string> } | null>(null);
  // The task list the current preview was built from (a catch-up plan re-times
  // stale tasks, so it differs from allTasks); used when toggling split.
  const [planSource, setPlanSource] = useState<Task[]>([]);
  const [summary, setSummary] = useState('');
  const [split, setSplit] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ item: Task; date?: Date | null; end?: Date | null } | null>(
    null,
  );
  // A brief, auto-dismissing beat after a task is checked off — either the #3
  // momentum line or, when there's signal, the #8 duration-learning nudge.
  const [momentum, setMomentum] = useState<string | null>(null);
  const momentumTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (momentumTimer.current) clearTimeout(momentumTimer.current);
  }, []);
  // The just-completed task awaiting an optional "how long did that take?" answer (#8).
  const [completion, setCompletion] = useState<Task | null>(null);
  const [actualInput, setActualInput] = useState('');
  // Which in-progress task has its "Not done" menu (+30 min / move) open, by id.
  const [notDoneFor, setNotDoneFor] = useState<string | null>(null);

  /** Flash a one-line beat in the momentum slot; auto-clears after `ms`. */
  function flashNudge(text: string, ms = 6000) {
    setMomentum(text);
    if (momentumTimer.current) clearTimeout(momentumTimer.current);
    momentumTimer.current = setTimeout(() => setMomentum(null), ms);
  }

  /** The #3 momentum beat: what's left + the soonest remaining task. */
  function showMomentum(task: Task) {
    const remaining = allTasks.filter(
      (t) => itemKind(t) === 'task' && !t.done && t.id !== task.id,
    ).length;
    const next = workloadBuckets(allTasks, new Date())
      .flatMap((g) => g.tasks)
      .find((t) => t.id !== task.id);
    flashNudge(completionNudge(remaining, next?.title ?? null));
  }

  /** The row that should carry a split task's logged time: the parent session-1
   *  row, which still holds the original estimate. Null if it can't be found. */
  function splitParentOf(child: Task, base: string): Task | null {
    return (
      allTasks.find(
        (t) =>
          t.id !== child.id &&
          itemKind(t) === 'task' &&
          !parseSplitSession(t.title) &&
          t.title === base &&
          (child.subject ? t.subject === child.subject : true),
      ) ?? null
    );
  }

  /** Does this task have split-off session rows? (i.e. it's the parent of a split) */
  function wasSplit(task: Task): boolean {
    return allTasks.some((t) => {
      const info = parseSplitSession(t.title);
      return !!info && info.base === task.title;
    });
  }

  /** Open the "how long did that take?" prompt for `task`, pre-filling its estimate. */
  function askActual(task: Task) {
    setActualInput(String(task.estimatedMinutes ?? task.plannedMinutes ?? ''));
    setCompletion(task);
  }

  function toggleDone(task: Task) {
    const markingDone = !task.done;
    updateTask(task.id, { done: markingDone });
    if (!markingDone) return; // un-checking shouldn't celebrate
    // Events never get the time prompt — just the momentum beat.
    if (itemKind(task) !== 'task') {
      showMomentum(task);
      return;
    }
    // A big task split across sessions is one piece of work with several "done"
    // checkboxes; asking on each would fragment its real duration. So earlier
    // sessions (and the parent, whose later sessions remain) stay silent, and only
    // the final session asks — logging the answer against the parent, which holds
    // the estimate, as the time for the whole task. #8, refined.
    const split = parseSplitSession(task.title);
    if (split) {
      const parent = split.index >= split.count ? splitParentOf(task, split.base) : null;
      if (parent) askActual(parent);
      else showMomentum(task);
      return;
    }
    if (wasSplit(task)) {
      showMomentum(task); // parent session-1 row; its final session will ask
      return;
    }
    askActual(task);
  }

  /** Mark a task's session in progress, so it's not flagged as "slipped" while worked. */
  function startTask(task: Task) {
    updateTask(task.id, { startedAt: new Date().toISOString() });
    flashNudge(`Started “${task.title}” — you're on it.`);
  }

  /** "Not done" → keep working: grow the session by 30 min (stays in progress). */
  function extendSession(task: Task) {
    const base = task.plannedMinutes ?? task.estimatedMinutes ?? 30;
    updateTask(task.id, { plannedMinutes: base + 30 });
    setNotDoneFor(null);
    flashNudge('Added 30 min — keep at it.');
  }

  /** "Not done" → move the unfinished session to the next day and clear the in-progress mark. */
  function moveToTomorrow(task: Task) {
    const session = parsePlanned(task);
    const target = addDays(session ? session.start : new Date(), 1);
    updateTask(task.id, { plannedDate: dayKey(target), startedAt: undefined });
    setNotDoneFor(null);
    flashNudge(`Moved to ${relativeLabel(target).toLowerCase()} — off your plate for now.`);
  }

  /** Compact "started 25m ago" / "started 1h 10m ago" from the in-progress mark. */
  function startedAgo(iso: string): string {
    const mins = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
    if (mins < 1) return 'just now';
    return `${formatDuration(mins)} ago`;
  }

  /** The "Not done" button + its two-action popover, shared by both surfaces. */
  function notDoneControl(task: Task) {
    const open = notDoneFor === task.id;
    return (
      <div className="notdone-wrap">
        <button
          type="button"
          className="btn btn-ghost"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setNotDoneFor(open ? null : task.id)}
        >
          <Circle size={16} /> Not done
        </button>
        {open && (
          <div className="notdone-menu" role="menu">
            <button type="button" role="menuitem" onClick={() => extendSession(task)}>
              <Clock size={15} /> +30 min · keep working
            </button>
            <button type="button" role="menuitem" onClick={() => moveToTomorrow(task)}>
              <CalendarPlus size={15} /> Move to tomorrow
            </button>
          </div>
        )}
      </div>
    );
  }

  /** Dismiss the time prompt without recording — still show the momentum beat. */
  function skipActual() {
    const task = completion;
    setCompletion(null);
    if (task) showMomentum(task);
  }

  /** Record the actual minutes, then surface a learning nudge if the subject's
   *  recent tasks show a consistent estimate bias — else the usual momentum beat. */
  async function saveActual() {
    const task = completion;
    if (!task) return;
    setCompletion(null);
    const minutes = parseInt(actualInput, 10);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      showMomentum(task);
      return;
    }
    await updateTask(task.id, { actualMinutes: minutes });
    // Build the learning sample from this subject's previously-logged tasks plus
    // the one just completed; only same-subject tasks count when this has a subject.
    const samples = allTasks
      .filter(
        (t) =>
          t.id !== task.id &&
          itemKind(t) === 'task' &&
          !!t.estimatedMinutes &&
          !!t.actualMinutes &&
          (task.subject ? t.subject === task.subject : true),
      )
      .map((t) => ({ estimated: t.estimatedMinutes!, actual: t.actualMinutes! }));
    if (task.estimatedMinutes) samples.push({ estimated: task.estimatedMinutes, actual: minutes });
    const learning = estimateBiasNudge(samples, task.subject);
    if (learning) flashNudge(learning, 9000);
    else showMomentum(task);
  }

  const openItem = (item: Task, date?: Date | null, end?: Date | null) =>
    setSelected({ item, date, end });

  // A quick, AI-free preview to decide whether Auto-plan is worth offering.
  const plannable = useMemo(
    () => planAhead(allTasks, new Date(), prefs, { split }),
    [allTasks, prefs, split],
  );
  const canPlan = plannable.blocks.length + plannable.unplaced.length > 0;

  // Planned work sessions whose time has already passed but aren't done — work to roll over.
  const stale = useMemo(() => stalePlannedTasks(allTasks, new Date()), [allTasks]);
  // Tasks the user has tapped "Start" on and hasn't finished — actively in progress.
  const inProgress = useMemo(() => inProgressTasks(allTasks), [allTasks]);
  // Committed sessions that now overlap a timed event (e.g. an event added later).
  const conflicts = useMemo(() => conflictedPlannedTasks(allTasks), [allTasks]);
  // Two events booked over each other within the next two weeks (#9) — you can't
  // be at both, so flag them even though the planner doesn't own events.
  const eventConflicts = useMemo(
    () => conflictingEvents(allTasks, startOfDay(now), endOfDay(addDays(now, 14))),
    [allTasks, now],
  );
  // Is there any committed work session at all? (gates the "Re-plan" action)
  const hasPlanned = useMemo(
    () => allTasks.some((t) => itemKind(t) === 'task' && !t.done && !!parsePlanned(t)),
    [allTasks],
  );

  const { timed, anytime, progress } = useMemo(() => {
    const occ = resolveOccurrences(allTasks, startOfDay(day), endOfDay(day));
    const key = dayKey(day);
    const todays = occ.filter((o) => dayKey(o.date) === key);
    const tasks = todays.filter((o) => itemKind(o.item) === 'task');
    const doneCount = tasks.filter((o) => o.item.done).length;

    // Work sessions you scheduled for this day (distinct from a task's deadline).
    const planned: ScheduledItem[] = allTasks
      .filter((t) => itemKind(t) === 'task')
      .map((t) => ({ t, session: parsePlanned(t) }))
      .filter((x): x is { t: Task; session: Interval } => !!x.session && dayKey(x.session.start) === key)
      .map(({ t, session }) => ({
        item: t,
        kind: 'task' as const,
        date: session.start,
        end: session.end,
        occurrenceKey: `${t.id}#planned`,
      }));

    return {
      // Timed lane: events with a time + work sessions, ordered by start.
      timed: [...todays.filter(isTimedEvent), ...planned],
      // Anytime lane: all-day events + tasks due today that aren't scheduled into a session.
      anytime: todays.filter((o) => !isTimedEvent(o) && !(itemKind(o.item) === 'task' && parsePlanned(o.item))),
      progress: { total: tasks.length, done: doneCount },
    };
  }, [allTasks, day]);

  // The proposed plan grouped by calendar day, for the preview.
  const planByDay = useMemo(() => {
    if (!plan) return [];
    const groups = new Map<string, EditBlock[]>();
    for (const b of plan.blocks) {
      const k = dayKey(b.start);
      const arr = groups.get(k);
      if (arr) arr.push(b);
      else groups.set(k, [b]);
    }
    return [...groups.values()].map((blocks) => ({ date: blocks[0].start, blocks }));
  }, [plan]);

  const hasLocks = !!plan?.blocks.some((b) => b.locked);

  // How many distinct overdue tasks the current plan pulled in, so the banner can
  // say so plainly instead of past-due work silently appearing on today (#1).
  const overdueInPlan = useMemo(() => {
    if (!plan) return 0;
    const ids = new Set<string>();
    for (const b of plan.blocks) {
      const due = parseDue(b.task);
      if (due && differenceInCalendarDays(due, now) < 0) ids.add(b.task.id);
    }
    return ids.size;
  }, [plan, now]);

  /** Ask the AI (with templated fallback) to label a set of placed blocks. */
  async function labelBlocks(blocks: PlannedBlock[]): Promise<{ blocks: PlannedBlock[]; summary: string }> {
    const inputs: PlanTextInput[] = blocks.map((b) => {
      const due = parseDue(b.task);
      return {
        id: blockKey(b),
        title: b.task.title,
        subject: b.task.subject,
        priority: b.task.priority,
        durationMin: blockMinutes(b),
        startLabel: `${relativeLabel(b.start)} ${format(b.start, 'h:mm a')}`,
        dueLabel: due ? `due ${relativeLabel(due)}` : undefined,
        part: b.part,
      };
    });
    const { items, summary: text } = await generatePlanText(inputs);
    const textById = new Map(items.map((i) => [i.id, i.actionText]));
    return { blocks: blocks.map((b) => ({ ...b, actionText: textById.get(blockKey(b)) })), summary: text };
  }

  async function generatePlan(useSplit = split, items: Task[] = allTasks) {
    setError(null);
    setPlanning(true);
    try {
      const computed = planAhead(items, new Date(), prefs, { split: useSplit });
      const labeled = await labelBlocks(computed.blocks);
      setPlan({ blocks: withUids(labeled.blocks), unplaced: computed.unplaced });
      setPlanSource(items);
      setSummary(labeled.summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to build a plan.');
    } finally {
      setPlanning(false);
    }
  }

  /** Re-plan everything except locked sessions, treating those as fixed busy time. */
  async function replanAroundLocked() {
    if (!plan) return;
    const locked = plan.blocks.filter((b) => b.locked);
    const fixed: Interval[] = locked.map((b) => ({ start: b.start, end: b.end }));
    const lockedTaskIds = new Set(locked.map((b) => b.task.id));
    const items = planSource.filter((t) => !lockedTaskIds.has(t.id));
    setError(null);
    setPlanning(true);
    try {
      const computed = planAhead(items, new Date(), prefs, { split, fixed });
      const labeled = await labelBlocks(computed.blocks);
      const blocks = [...locked, ...withUids(labeled.blocks)].sort(
        (a, b) => a.start.getTime() - b.start.getTime(),
      );
      setPlan({ blocks, unplaced: computed.unplaced });
      setSummary(labeled.summary || summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to re-plan.');
    } finally {
      setPlanning(false);
    }
  }

  /** Roll the stale (missed) timed sessions back into a fresh plan from now. */
  function catchUp() {
    const staleIds = new Set(stale.map((t) => t.id));
    // Clear the passed planned session locally so the planner treats them as
    // re-plannable; the deadline is left intact. Accept writes the new session.
    const cleared = allTasks.map((t) =>
      staleIds.has(t.id) ? { ...t, plannedDate: undefined, plannedStart: undefined, plannedMinutes: undefined } : t,
    );
    void generatePlan(split, cleared);
  }

  /**
   * Regenerate the whole plan from scratch around the current events: clear every
   * incomplete work session (keeping deadlines) and re-lay it out, so a freshly
   * added event no longer sits under committed work. Split-session rows (no
   * deadline) are dropped — the parent task re-splits cleanly. Nothing is written
   * until Accept, so Discard is safe.
   */
  function replanAll() {
    const planned = allTasks.filter((t) => itemKind(t) === 'task' && !t.done && !!parsePlanned(t));
    const clear = new Set(planned.filter((t) => t.dueDate).map((t) => t.id)); // re-plannable parents
    const deleteChildren = new Set(planned.filter((t) => !t.dueDate).map((t) => t.id)); // split-session rows
    const cleared = allTasks
      .filter((t) => !deleteChildren.has(t.id))
      .map((t) =>
        clear.has(t.id) ? { ...t, plannedDate: undefined, plannedStart: undefined, plannedMinutes: undefined } : t,
      );
    setReplan({ clear, deleteChildren });
    void generatePlan(split, cleared);
  }

  function onToggleSplit(next: boolean) {
    setSplit(next);
    if (plan) void generatePlan(next, planSource);
  }

  // --- Block editing ---------------------------------------------------------
  /** Other preview blocks sharing `next`'s day, as plain busy intervals. */
  function previewOthers(uid: string, next: Interval, blocks: EditBlock[]): Interval[] {
    return blocks
      .filter((b) => b.uid !== uid && isSameDay(b.start, next.start))
      .map((b) => ({ start: b.start, end: b.end }));
  }

  function applyEdit(uid: string, makeNext: (b: EditBlock) => Interval) {
    setPlan((p) => {
      if (!p) return p;
      const target = p.blocks.find((b) => b.uid === uid);
      if (!target) return p;
      const next = makeNext(target);
      if (!placementOk(next, allTasks, prefs, previewOthers(uid, next, p.blocks))) return p;
      const blocks = p.blocks
        .map((b) => (b.uid === uid ? { ...b, start: next.start, end: next.end } : b))
        .sort((a, b) => a.start.getTime() - b.start.getTime());
      return { ...p, blocks };
    });
  }

  const nudge = (uid: string, delta: number) =>
    applyEdit(uid, (b) => ({ start: shiftMin(b.start, delta), end: shiftMin(b.end, delta) }));
  const resize = (uid: string, delta: number) =>
    applyEdit(uid, (b) => ({ start: b.start, end: shiftMin(b.end, delta) }));

  function removeBlock(uid: string) {
    setSelectedBlock(null);
    setPlan((p) => (p ? { ...p, blocks: p.blocks.filter((b) => b.uid !== uid) } : p));
  }
  function toggleLock(uid: string) {
    setPlan((p) =>
      p ? { ...p, blocks: p.blocks.map((b) => (b.uid === uid ? { ...b, locked: !b.locked } : b)) } : p,
    );
  }

  /** A snapped move (shift both ends) or resize (extend the end) by `delta` minutes. */
  function proposed(start: Date, end: Date, mode: DragMode, delta: number): Interval {
    return mode === 'move'
      ? { start: shiftMin(start, delta), end: shiftMin(end, delta) }
      : { start, end: shiftMin(end, delta) };
  }

  // Preview timeline (uncommitted auto-plan): edits live in local plan state.
  const editPreview = (uid: string, mode: DragMode, delta: number) =>
    mode === 'move' ? nudge(uid, delta) : resize(uid, delta);
  function validatePreview(uid: string, mode: DragMode, delta: number): boolean {
    const b = plan?.blocks.find((x) => x.uid === uid);
    if (!b || b.locked) return false;
    const next = proposed(b.start, b.end, mode, delta);
    if (next.end <= next.start || blockMinutes({ ...b, ...next }) < STEP) return false;
    return placementOk(next, allTasks, prefs, previewOthers(uid, next, plan!.blocks));
  }

  // Committed timeline (live work sessions): edits persist immediately.
  function liveSession(uid: string): { task: Task; session: Interval } | null {
    const task = allTasks.find((t) => t.id === uid.replace(/#planned$/, ''));
    const session = task ? parsePlanned(task) : null;
    return task && session ? { task, session } : null;
  }
  function validateLive(uid: string, mode: DragMode, delta: number): boolean {
    const ls = liveSession(uid);
    if (!ls) return false;
    const next = proposed(ls.session.start, ls.session.end, mode, delta);
    if (next.end <= next.start || (next.end.getTime() - next.start.getTime()) / 60_000 < STEP) return false;
    // Exclude this task's own session so the block never blocks itself.
    return placementOk(next, allTasks.filter((t) => t.id !== ls.task.id), prefs);
  }
  async function editLive(uid: string, mode: DragMode, delta: number) {
    const ls = liveSession(uid);
    if (!ls || !validateLive(uid, mode, delta)) return;
    const next = proposed(ls.session.start, ls.session.end, mode, delta);
    await updateTask(ls.task.id, {
      plannedDate: dayKey(next.start),
      plannedStart: format(next.start, 'HH:mm'),
      plannedMinutes: Math.max(STEP, Math.round((next.end.getTime() - next.start.getTime()) / 60_000)),
    });
  }
  function removeLive(uid: string) {
    setSelectedBlock(null);
    void updateTask(uid.replace(/#planned$/, ''), {
      plannedDate: undefined,
      plannedStart: undefined,
      plannedMinutes: undefined,
    });
  }

  // Timeline blocks for the committed day view: editable sessions + read-only events.
  const committedBlocks: TimelineBlock[] = useMemo(
    () =>
      timed.map((occ): TimelineBlock => {
        const isEvt = itemKind(occ.item) === 'event';
        return {
          uid: occ.occurrenceKey,
          start: occ.date,
          end: occ.end ?? shiftMin(occ.date, 60),
          kind: isEvt ? 'event' : 'session',
          editable: !isEvt,
          title: occ.item.title,
          item: occ.item,
        };
      }),
    [timed],
  );

  const previewBlocks = (blocks: EditBlock[]): TimelineBlock[] =>
    blocks.map((b) => ({
      uid: b.uid,
      start: b.start,
      end: b.end,
      kind: 'session',
      editable: !b.locked,
      title: b.actionText ?? b.task.title,
      subtitle: b.actionText ? b.task.title : undefined,
      part: b.part,
      suggested: true,
      locked: b.locked,
      item: b.task,
    }));

  /** Read-only timed events on `date`, shown as context in the preview timeline so
   * the proposed sessions are visibly laid out around your existing commitments. */
  const eventsForDay = (date: Date): TimelineBlock[] =>
    resolveOccurrences(allTasks, startOfDay(date), endOfDay(date))
      .filter(isTimedEvent)
      .map((occ) => ({
        uid: occ.occurrenceKey,
        start: occ.date,
        end: occ.end ?? shiftMin(occ.date, 60),
        kind: 'event',
        editable: false,
        title: occ.item.title,
        item: occ.item,
      }));

  // Coach layer: a warm one-liner + the block to surface in the "Right now" card.
  const briefing = useMemo(() => {
    const sessions = timed.filter((o) => itemKind(o.item) === 'task');
    const events = timed.filter((o) => itemKind(o.item) === 'event');
    const focusMinutes = sessions.reduce(
      (s, o) => s + Math.round(((o.end?.getTime() ?? o.date.getTime()) - o.date.getTime()) / 60_000),
      0,
    );
    return buildBriefing({ day, now, sessionCount: sessions.length, eventCount: events.length, focusMinutes, progress });
  }, [timed, day, now, progress]);

  const focus = useMemo(() => {
    if (!isToday(day)) return null;
    return pickFocus(
      timed.map((o) => ({ start: o.date, end: o.end ?? shiftMin(o.date, 60), item: o.item })),
      now,
    );
  }, [timed, day, now]);

  async function acceptPlan() {
    if (!plan) return;
    setAccepting(true);
    setError(null);
    try {
      // Group sessions per task: the first commits onto the task itself; extra
      // split sessions become their own task rows so each persists + pushes to
      // Google Calendar (a task can carry only one due time).
      const byTask = new Map<string, EditBlock[]>();
      for (const b of plan.blocks) {
        const arr = byTask.get(b.task.id);
        if (arr) arr.push(b);
        else byTask.set(b.task.id, [b]);
      }
      for (const blks of byTask.values()) {
        blks.sort((a, b) => a.start.getTime() - b.start.getTime());
        const first = blks[0];
        // Write the work session onto the task; leave its deadline (dueDate/dueTime) intact.
        await updateTask(first.task.id, {
          plannedDate: dayKey(first.start),
          plannedStart: format(first.start, 'HH:mm'),
          plannedMinutes: blockMinutes(first),
        });
        // Extra split sessions become their own rows. They carry only the work
        // session (no deadline) so they show as work blocks, not duplicate deadlines.
        for (let i = 1; i < blks.length; i++) {
          const s = blks[i];
          await createItem({
            kind: 'task',
            title: splitSessionTitle(first.task.title, i + 1, blks.length),
            subject: first.task.subject,
            priority: first.task.priority,
            plannedDate: dayKey(s.start),
            plannedStart: format(s.start, 'HH:mm'),
            plannedMinutes: blockMinutes(s),
          });
        }
      }
      // Re-plan cleanup: wipe sessions we cleared that didn't get re-placed (e.g.
      // couldn't fit), and delete the old split-session rows the new plan replaced.
      if (replan) {
        const placed = new Set(plan.blocks.map((b) => b.task.id));
        for (const id of replan.clear) {
          if (!placed.has(id)) {
            await updateTask(id, { plannedDate: undefined, plannedStart: undefined, plannedMinutes: undefined });
          }
        }
        for (const id of replan.deleteChildren) await deleteTask(id);
      }
      setReplan(null);
      setPlan(null);
      setSummary('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save the plan.');
    } finally {
      setAccepting(false);
    }
  }

  function discardPlan() {
    setReplan(null);
    setPlan(null);
    setSummary('');
  }

  const empty = timed.length === 0 && anytime.length === 0;

  // Live state for the "Now" hero: how far through the current session we are (for the
  // progress ring) and how many minutes remain. Only meaningful when something is live.
  const focusLive = !!focus && focus.state === 'now';
  const focusFrac =
    focusLive && focus
      ? Math.min(
          1,
          Math.max(
            0,
            (now.getTime() - focus.entry.start.getTime()) /
              Math.max(1, focus.entry.end.getTime() - focus.entry.start.getTime()),
          ),
        )
      : 0;
  const focusMinLeft =
    focusLive && focus ? Math.max(0, Math.round((focus.entry.end.getTime() - now.getTime()) / 60_000)) : 0;
  const NOW_RING_C = 2 * Math.PI * 26; // circumference for r=26
  const otherInProgress = inProgress.filter((t) => t.id !== (focus ? focus.entry.item.id : null));

  // One clear next step. The three old CTAs (Auto-plan / Re-plan / Catch up) collapse
  // into a single primary button whose label + action follow the day's state, so there's
  // never a cluster of competing buttons. Slipped work and conflicts (shown as quiet
  // notes below) are both resolved by this same button.
  const primaryPlan: { label: string; busyLabel: string; run: () => void; Icon: typeof Sparkles } | null =
    stale.length > 0
      ? { label: 'Catch up on slipped work', busyLabel: 'Catching up…', run: catchUp, Icon: History }
      : conflicts.length > 0
        ? { label: 'Re-plan around conflicts', busyLabel: 'Re-planning…', run: replanAll, Icon: RefreshCw }
        : canPlan
          ? { label: 'Plan my day', busyLabel: 'Planning…', run: () => generatePlan(), Icon: Sparkles }
          : hasPlanned
            ? { label: 'Re-plan my day', busyLabel: 'Re-planning…', run: replanAll, Icon: RefreshCw }
            : null;

  return (
    <section className="page schedule-page today-layout">
      <div className="today-main">
      {momentum && (
        <div className="momentum-nudge" role="status">
          <CheckCircle2 size={15} />
          <span>{momentum}</span>
        </div>
      )}
      {plan ? (
        <div className="schedule-header">
          <h1>Your plan</h1>
        </div>
      ) : (
        <header className="today-topbar fade-seq">
          <div className="day-nav">
            <button onClick={() => setDay((d) => addDays(d, -1))} aria-label="Previous day">
              <ChevronLeft size={18} />
            </button>
            <div className="day-nav-label">
              <span className="day-nav-rel">{relativeLabel(day)}</span>
              <span className="day-nav-date">{format(day, 'EEEE, MMMM d')}</span>
            </div>
            <button onClick={() => setDay((d) => addDays(d, 1))} aria-label="Next day">
              <ChevronRight size={18} />
            </button>
          </div>
          {!isToday(day) && (
            <button type="button" className="link-button today-topbar-jump" onClick={() => setDay(new Date())}>
              Jump to today
            </button>
          )}

          <span className="today-topbar-spacer" />

          {/* Exceptions as quiet status chips — the primary CTA below already resolves
              slipped work + conflicts, so these just say what's off, not how to fix it. */}
          {(stale.length > 0 || conflicts.length > 0 || eventConflicts.length > 0) && (
            <div className="today-flags">
              {stale.length > 0 && (
                <span className="flag-chip" title="Sessions that slipped past their time">
                  <History size={13} /> {stale.length} slipped
                </span>
              )}
              {conflicts.length > 0 && (
                <span className="flag-chip" title="Sessions that overlap an event or each other">
                  <AlertTriangle size={13} /> {conflicts.length} conflict{conflicts.length === 1 ? '' : 's'}
                </span>
              )}
              {eventConflicts.length > 0 && (
                <button
                  type="button"
                  className="flag-chip flag-chip-button"
                  title="Two events overlap — open one to adjust"
                  onClick={() => openItem(eventConflicts[0], parseStart(eventConflicts[0]), parseEnd(eventConflicts[0]))}
                >
                  <AlertTriangle size={13} /> {eventConflicts.length} event clash
                </button>
              )}
            </div>
          )}

          {primaryPlan && (
            <button
              type="button"
              className="btn btn-primary today-plan-cta"
              onClick={primaryPlan.run}
              disabled={planning}
            >
              <primaryPlan.Icon size={18} /> {planning ? primaryPlan.busyLabel : primaryPlan.label}
            </button>
          )}
        </header>
      )}

      {/* Warm one-liner + a thin progress line: reassurance first, then the day's shape. */}
      {!plan && (
        <div className="today-subhead fade-seq">
          <p className="today-briefing">{briefing}</p>
          {progress.total > 0 && (
            <div className="day-progress">
              <div className="day-progress-track">
                <span
                  className="day-progress-fill"
                  style={{ width: `${(progress.done / progress.total) * 100}%` }}
                />
              </div>
              <span className="day-progress-label">
                {progress.done} of {progress.total} done
              </span>
            </div>
          )}
        </div>
      )}

      {plan && (
        <>
          <div className="plan-banner">
            <div className="plan-banner-text">
              <Sparkles size={16} />
              <span>
                {summary ||
                  (plan.blocks.length > 0
                    ? `Planned ${plan.blocks.length} session${plan.blocks.length === 1 ? '' : 's'}.`
                    : 'No free time to plan into.')}
                {overdueInPlan > 0 && (
                  <span className="plan-banner-note">{overduePlanNote(overdueInPlan)}</span>
                )}
              </span>
            </div>
            <div className="plan-banner-actions">
              {plan.blocks.length > 0 && (
                <button type="button" className="btn btn-primary" onClick={acceptPlan} disabled={accepting || planning}>
                  <Check size={16} /> {accepting ? 'Saving…' : 'Accept plan'}
                </button>
              )}
              <button type="button" className="btn btn-secondary" onClick={discardPlan} disabled={accepting}>
                <X size={16} /> Discard
              </button>
            </div>
          </div>

          <div className="plan-controls">
            <label className="plan-toggle">
              <input
                type="checkbox"
                checked={split}
                onChange={(e) => onToggleSplit(e.target.checked)}
                disabled={planning || accepting}
              />
              <span>Spread big tasks across days</span>
            </label>
            <div className="plan-controls-right">
              {hasLocks && (
                <button
                  type="button"
                  className="link-button"
                  onClick={replanAroundLocked}
                  disabled={planning || accepting}
                >
                  <Sparkles size={14} /> Re-plan around locked
                </button>
              )}
              <Link to="/settings" className="plan-hours-link">
                <Settings2 size={14} /> Planning around your work hours
              </Link>
            </div>
          </div>
        </>
      )}

      {error && <p className="upload-error">{error}</p>}

      {plan ? (
        <div className="today-plan">
          {planning && <p className="settings-status">Building your plan…</p>}
          {planByDay.map(({ date, blocks }) => (
            <div className="day-group" key={dayKey(date)}>
              <div className="day-heading">
                <span className="day-label">{relativeLabel(date)}</span>
                <span className="day-count">{blocks.length}</span>
              </div>
              <DayTimeline
                day={date}
                now={now}
                prefs={prefs}
                blocks={[...previewBlocks(blocks), ...eventsForDay(date)]}
                selectedUid={selectedBlock}
                onSelect={setSelectedBlock}
                onOpen={openItem}
                onEdit={editPreview}
                validate={validatePreview}
                onRemove={removeBlock}
                onToggleLock={toggleLock}
                showLock
                busy={planning || accepting}
              />
            </div>
          ))}
          {plan.unplaced.length > 0 && (
            <div className="day-group">
              <div className="day-heading muted">
                <span className="day-label">Couldn't fit before the deadline</span>
                <span className="day-count">{plan.unplaced.length}</span>
              </div>
              <div className="plan-unplaced">
                {plan.unplaced.map((t) => (
                  <span className="task-chip" key={t.id}>
                    {t.title}
                  </span>
                ))}
              </div>
              <p className="plan-hint">
                Try enabling “Spread big tasks across days”, widening your hours in Settings, or
                giving these a specific time yourself.
              </p>
            </div>
          )}
        </div>
      ) : empty ? (
        <div className="schedule-empty">
          <Sun size={40} strokeWidth={1.5} />
          <p>Nothing planned for this day.</p>
          <Link to="/add" className="cta-button">
            <Plus size={16} /> Add task or event
          </Link>
        </div>
      ) : (
        <div className="today-plan">
          {/* The "Now" zone — the single boldest thing on the page. What to do right
              now (with a live ring + minutes left) merged with any other in-progress work. */}
          {(focus || otherInProgress.length > 0) && (
            <div className="now-cluster fade-seq">
              {focus && (
                <div className={`now-hero${focusLive ? ' is-live' : ''}`}>
                  {focusLive && (
                    <div className="now-ring" aria-hidden="true">
                      <svg viewBox="0 0 64 64">
                        <circle className="now-ring-track" cx="32" cy="32" r="26" />
                        <circle
                          className="now-ring-fill"
                          cx="32"
                          cy="32"
                          r="26"
                          style={{
                            strokeDasharray: NOW_RING_C,
                            strokeDashoffset: NOW_RING_C * (1 - focusFrac),
                          }}
                        />
                      </svg>
                      <span className="now-ring-label">
                        {focusMinLeft}
                        <small>m</small>
                      </span>
                    </div>
                  )}
                  <div className="now-hero-info">
                    <span className="now-hero-label">{focusLive ? 'Right now' : 'Up next'}</span>
                    <span className="now-hero-title">{focus.entry.item.title}</span>
                    <span className="now-hero-meta">
                      <Clock size={14} /> {format(focus.entry.start, 'h:mm')}–{format(focus.entry.end, 'h:mm a')}
                      {focusLive && <span className="now-hero-left">{focusMinLeft} min left</span>}
                    </span>
                  </div>
                  {itemKind(focus.entry.item) === 'task' &&
                    (focus.entry.item.startedAt ? (
                      <div className="now-hero-actions">
                        <button type="button" className="btn btn-primary" onClick={() => toggleDone(focus.entry.item)}>
                          <CheckCircle2 size={16} /> Done
                        </button>
                        {notDoneControl(focus.entry.item)}
                      </div>
                    ) : (
                      <div className="now-hero-actions">
                        <button type="button" className="btn btn-primary" onClick={() => startTask(focus.entry.item)}>
                          <Play size={16} /> Start
                        </button>
                        <button type="button" className="btn btn-ghost" onClick={() => toggleDone(focus.entry.item)}>
                          <CheckCircle2 size={16} /> Done
                        </button>
                      </div>
                    ))}
                </div>
              )}

              {/* Other started tasks (e.g. ones that ran past their slot) sit in the same
                  "now" zone with their Done / Not-done controls. */}
              {otherInProgress.map((t) => (
                <div className="inprogress-row" key={t.id}>
                  <div className="inprogress-info">
                    <span className="inprogress-label">
                      <CircleDot size={13} /> In progress
                    </span>
                    <span className="inprogress-title">{t.title}</span>
                    {t.startedAt && <span className="inprogress-meta">Started {startedAgo(t.startedAt)}</span>}
                  </div>
                  <div className="focus-card-actions">
                    <button type="button" className="btn btn-primary" onClick={() => toggleDone(t)}>
                      <CheckCircle2 size={16} /> Done
                    </button>
                    {notDoneControl(t)}
                  </div>
                </div>
              ))}
            </div>
          )}

          {committedBlocks.length > 0 ? (
            <DayTimeline
              day={day}
              now={now}
              prefs={prefs}
              blocks={committedBlocks}
              selectedUid={selectedBlock}
              onSelect={setSelectedBlock}
              onOpen={openItem}
              onEdit={editLive}
              validate={validateLive}
              onRemove={removeLive}
            />
          ) : (
            <p className="timeline-empty">No timed work yet — auto-plan your tasks to shape your day.</p>
          )}

          {anytime.length > 0 && (
            <div className="day-group anytime-strip">
              <div className="day-heading muted">
                <span className="day-label">Anytime</span>
                <span className="day-count">{anytime.length}</span>
              </div>
              <div className="day-tasks">
                {anytime.map((occ) => (
                  <ItemRow
                    key={occ.occurrenceKey}
                    item={occ.item}
                    date={occ.date}
                    end={occ.end}
                    onToggleDone={toggleDone}
                    onDelete={deleteTask}
                    onOpen={openItem}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      </div>

      {!plan && (
        <aside className="today-rail">
          {/* "What's coming" lives in the rail: the week's load shape, then everything
              still on the plate by urgency. Keeps the main column focused on right-now. */}
          <WeekStrip tasks={allTasks} day={day} prefs={prefs} onSelectDay={setDay} />
          <WorkloadRail
            tasks={allTasks}
            now={now}
            onOpen={openItem}
            onToggleDone={toggleDone}
            onDelete={deleteTask}
          />
        </aside>
      )}

      {selected && (
        <ItemDetail
          item={selected.item}
          date={selected.date}
          end={selected.end}
          onClose={() => setSelected(null)}
          onUpdate={updateTask}
          onDelete={deleteTask}
          onToggleDone={toggleDone}
          onStart={startTask}
        />
      )}

      {completion && (
        <div className="modal-overlay" role="presentation" onClick={skipActual}>
          <div
            className="modal completion-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Log time spent"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="modal-title">
              {wasSplit(completion)
                ? 'Nice work — how long did the whole thing take?'
                : 'Nice work — how long did that take?'}
            </h2>
            <p className="completion-sub">
              “{completion.title}”
              {wasSplit(completion) ? ' · total across all its sessions' : ''}
              {completion.estimatedMinutes
                ? ` · you'd estimated ${formatDuration(completion.estimatedMinutes)}`
                : ''}
            </p>
            <div className="completion-input-row">
              <input
                type="number"
                min={1}
                max={1000}
                step={5}
                value={actualInput}
                onChange={(e) => setActualInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveActual();
                }}
                autoFocus
              />
              <span>minutes</span>
            </div>
            <p className="completion-hint">This only helps LazyLoad learn your pace — skip anytime.</p>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={skipActual}>
                Skip
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void saveActual()}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
