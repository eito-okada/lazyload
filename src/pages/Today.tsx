import { useMemo, useState } from 'react';
import { addDays, startOfDay, endOfDay, isToday, format } from 'date-fns';
import { ChevronLeft, ChevronRight, Sun, Plus, Sparkles, Check, X, Clock, Settings2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTasks } from '../context/TaskContext';
import type { Task } from '../types/Task';
import ItemRow from '../components/TaskRow';
import ItemDetail from '../components/ItemDetail';
import { useWorkingHours } from '../lib/preferences';
import { generatePlanText, type PlanTextInput } from '../services/api';
import {
  resolveOccurrences,
  planAhead,
  parseDue,
  dayKey,
  relativeLabel,
  itemKind,
  eventTimeLabel,
  type ScheduledItem,
  type DayPlan,
  type PlannedBlock,
} from '../lib/schedule';

function isTimed(occ: ScheduledItem): boolean {
  return itemKind(occ.item) === 'event' ? !occ.item.allDay : !!occ.item.dueTime;
}

/** Minutes spanned by a block (≥ 1). */
function blockMinutes(b: PlannedBlock): number {
  return Math.max(1, Math.round((b.end.getTime() - b.start.getTime()) / 60_000));
}

/** Stable id for a block, shared between the AI request and the response merge. */
function blockKey(b: PlannedBlock): string {
  return `${b.task.id}#${b.part?.index ?? 0}#${b.start.getTime()}`;
}

export default function Today() {
  const { allTasks, updateTask, createItem, deleteTask } = useTasks();
  const [prefs] = useWorkingHours();
  const [day, setDay] = useState(() => new Date());
  const [plan, setPlan] = useState<DayPlan | null>(null);
  const [summary, setSummary] = useState('');
  const [split, setSplit] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ item: Task; date?: Date | null; end?: Date | null } | null>(
    null,
  );

  function toggleDone(task: Task) {
    updateTask(task.id, { done: !task.done });
  }

  const openItem = (item: Task, date?: Date | null, end?: Date | null) =>
    setSelected({ item, date, end });

  // A quick, AI-free preview to decide whether Auto-plan is worth offering.
  const plannable = useMemo(
    () => planAhead(allTasks, new Date(), prefs, { split }),
    [allTasks, prefs, split],
  );
  const canPlan = plannable.blocks.length + plannable.unplaced.length > 0;

  const { timed, anytime, progress } = useMemo(() => {
    const occ = resolveOccurrences(allTasks, startOfDay(day), endOfDay(day));
    const key = dayKey(day);
    const todays = occ.filter((o) => dayKey(o.date) === key);
    const tasks = todays.filter((o) => itemKind(o.item) === 'task');
    const doneCount = tasks.filter((o) => o.item.done).length;
    return {
      timed: todays.filter(isTimed),
      anytime: todays.filter((o) => !isTimed(o)),
      progress: { total: tasks.length, done: doneCount },
    };
  }, [allTasks, day]);

  // The proposed plan grouped by calendar day, for the preview.
  const planByDay = useMemo(() => {
    if (!plan) return [];
    const groups = new Map<string, PlannedBlock[]>();
    for (const b of plan.blocks) {
      const k = dayKey(b.start);
      const arr = groups.get(k);
      if (arr) arr.push(b);
      else groups.set(k, [b]);
    }
    return [...groups.values()].map((blocks) => ({ date: blocks[0].start, blocks }));
  }, [plan]);

  async function generatePlan(useSplit = split) {
    setError(null);
    setPlanning(true);
    try {
      const computed = planAhead(allTasks, new Date(), prefs, { split: useSplit });
      const inputs: PlanTextInput[] = computed.blocks.map((b) => {
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
      const blocks = computed.blocks.map((b) => ({ ...b, actionText: textById.get(blockKey(b)) }));
      setPlan({ blocks, unplaced: computed.unplaced });
      setSummary(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to build a plan.');
    } finally {
      setPlanning(false);
    }
  }

  function onToggleSplit(next: boolean) {
    setSplit(next);
    if (plan) void generatePlan(next);
  }

  async function acceptPlan() {
    if (!plan) return;
    setAccepting(true);
    setError(null);
    try {
      // Group sessions per task: the first commits onto the task itself; extra
      // split sessions become their own task rows so each persists + pushes to
      // Google Calendar (a task can carry only one due time).
      const byTask = new Map<string, PlannedBlock[]>();
      for (const b of plan.blocks) {
        const arr = byTask.get(b.task.id);
        if (arr) arr.push(b);
        else byTask.set(b.task.id, [b]);
      }
      for (const blks of byTask.values()) {
        blks.sort((a, b) => a.start.getTime() - b.start.getTime());
        const first = blks[0];
        await updateTask(first.task.id, {
          dueDate: dayKey(first.start),
          dueTime: format(first.start, 'HH:mm'),
          estimatedMinutes: blockMinutes(first),
        });
        for (let i = 1; i < blks.length; i++) {
          const s = blks[i];
          await createItem({
            kind: 'task',
            title: `${first.task.title} — session ${i + 1} of ${blks.length}`,
            subject: first.task.subject,
            priority: first.task.priority,
            dueDate: dayKey(s.start),
            dueTime: format(s.start, 'HH:mm'),
            estimatedMinutes: blockMinutes(s),
          });
        }
      }
      setPlan(null);
      setSummary('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save the plan.');
    } finally {
      setAccepting(false);
    }
  }

  function discardPlan() {
    setPlan(null);
    setSummary('');
  }

  const empty = timed.length === 0 && anytime.length === 0;

  return (
    <section className="page schedule-page">
      <div className="schedule-header">
        <h1>Daily Plan</h1>
        {!plan && (
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
        )}
        {!plan && !isToday(day) && (
          <button type="button" className="link-button" onClick={() => setDay(new Date())}>
            Jump to today
          </button>
        )}
        {!plan && canPlan && (
          <button type="button" className="export-button" onClick={() => generatePlan()} disabled={planning}>
            <Sparkles size={16} /> {planning ? 'Planning…' : 'Auto-plan my tasks'}
          </button>
        )}
        {!plan && progress.total > 0 && (
          <div className="day-progress">
            <div className="day-progress-track">
              <span
                className="day-progress-fill"
                style={{ width: `${(progress.done / progress.total) * 100}%` }}
              />
            </div>
            <span className="day-progress-label">
              {progress.done} of {progress.total} tasks done
            </span>
          </div>
        )}
      </div>

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
            <Link to="/settings" className="plan-hours-link">
              <Settings2 size={14} /> Planning around your work hours
            </Link>
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
              <div className="day-tasks">
                {blocks.map((b) => (
                  <PlanRow key={blockKey(b)} block={b} />
                ))}
              </div>
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
          {timed.length > 0 && (
            <div className="day-group">
              <div className="day-heading">
                <span className="day-label">Schedule</span>
                <span className="day-count">{timed.length}</span>
              </div>
              <div className="day-tasks">
                {timed
                  .slice()
                  .sort((a, b) => a.date.getTime() - b.date.getTime())
                  .map((occ) => (
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
          {anytime.length > 0 && (
            <div className="day-group">
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

      {selected && (
        <ItemDetail
          item={selected.item}
          date={selected.date}
          end={selected.end}
          onClose={() => setSelected(null)}
          onUpdate={updateTask}
          onDelete={deleteTask}
          onToggleDone={toggleDone}
        />
      )}
    </section>
  );
}

/** A proposed (not-yet-committed) plan block: action text first, then context. */
function PlanRow({ block }: { block: PlannedBlock }) {
  const priority = block.task.priority ?? 'medium';
  return (
    <div className="task-row suggested">
      <span className={`prio-bar prio-${priority}`} aria-hidden="true" />
      <div className="task-row-body">
        <div className="task-row-main">
          <span className="task-row-title">{block.actionText ?? block.task.title}</span>
          {block.part && (
            <span className="task-chip">
              Part {block.part.index}/{block.part.total}
            </span>
          )}
          <span className="task-chip suggested-chip">Suggested</span>
        </div>
        <div className="task-row-meta">
          <span className="task-time">
            <Clock size={13} /> {eventTimeLabel(block.start, block.end)}
          </span>
          <span className="task-time plan-source">{block.task.title}</span>
        </div>
      </div>
    </div>
  );
}
