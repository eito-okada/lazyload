import { useMemo } from 'react';
import { format, addMonths, startOfMonth, endOfMonth, parseISO } from 'date-fns';
import { Link } from 'react-router-dom';
import { CalendarDays, AlertTriangle, Timer, CheckCircle2 } from 'lucide-react';
import { useWorkingHours, pruneDismissed, type DayOverride } from '../lib/preferences';
import { useTasks } from '../context/TaskContext';
import { workloadBuckets, parsePlanned, parseDue, itemKind, relativeLabel } from '../lib/schedule';
import type { Task } from '../types/Task';
import SuggestionsList from '../components/SuggestionsList';

interface MonthReminder {
  id: string;
  month: Date;
  label: string;
  schoolCount: number;
  dismissed: boolean;
}

function buildReminders(
  overrides: Record<string, DayOverride>,
  dismissed: string[],
): MonthReminder[] {
  const today = new Date();
  return [0, 1].map((i) => {
    const mStart = addMonths(startOfMonth(today), i);
    const mEnd = endOfMonth(mStart);
    const monthKey = format(mStart, 'yyyy-MM');
    const schoolCount = Object.entries(overrides).filter(([key, val]) => {
      const d = parseISO(key);
      return d >= mStart && d <= mEnd && val !== 'off';
    }).length;
    return {
      id: monthKey,
      month: mStart,
      label: format(mStart, 'MMMM yyyy'),
      schoolCount,
      dismissed: dismissed.includes(monthKey),
    };
  });
}

/** Compact preview of the tasks in a decision section (titles + when they're due). */
function TaskLines({ tasks, max = 4 }: { tasks: Task[]; max?: number }) {
  const shown = tasks.slice(0, max);
  const extra = tasks.length - shown.length;
  return (
    <ul className="inbox-task-list">
      {shown.map((t) => {
        const due = parseDue(t);
        return (
          <li key={t.id} className="inbox-task">
            <span className="inbox-task-title">{t.title}</span>
            {t.subject && <span className="inbox-task-subject">{t.subject}</span>}
            {due && <span className="inbox-task-due">{relativeLabel(due)}</span>}
          </li>
        );
      })}
      {extra > 0 && <li className="inbox-task-more">+{extra} more</li>}
    </ul>
  );
}

export default function Inbox() {
  const [prefs, setPrefs] = useWorkingHours();
  const { allTasks } = useTasks();
  const dismissed = useMemo(() => prefs.dismissedReminders ?? [], [prefs.dismissedReminders]);
  const now = useMemo(() => new Date(), []);
  const reminders = useMemo(
    () => buildReminders(prefs.overrides, dismissed),
    [prefs.overrides, dismissed],
  );

  // "Things needing a decision," composed from data we already have — no new
  // persistence. Each is a calm nudge with a one-tap path to the fix.
  const overdueUnscheduled = useMemo(() => {
    const overdue = workloadBuckets(allTasks, now).find((b) => b.id === 'overdue')?.tasks ?? [];
    // Overdue work the planner hasn't placed yet — the most pressing decision.
    return overdue.filter((t) => !parsePlanned(t));
  }, [allTasks, now]);

  const missingEstimate = useMemo(
    // The planner can't size a task with no estimate, so it can't schedule it well.
    () => allTasks.filter((t) => itemKind(t) === 'task' && !t.done && !t.estimatedMinutes),
    [allTasks],
  );

  const decisionCount = overdueUnscheduled.length + missingEstimate.length;

  function dismissMonth(monthKey: string) {
    const next = pruneDismissed([...dismissed.filter((m) => m !== monthKey), monthKey]);
    setPrefs({ ...prefs, dismissedReminders: next });
  }

  function undismissMonth(monthKey: string) {
    setPrefs({ ...prefs, dismissedReminders: dismissed.filter((m) => m !== monthKey) });
  }

  return (
    <section className="page inbox-page">
      <h1>Inbox</h1>

      <div className="inbox-section">
        <h2 className="inbox-section-title">Needs a decision</h2>
        {decisionCount === 0 ? (
          <div className="inbox-card all-clear">
            <div className="inbox-card-icon" aria-hidden="true">
              <CheckCircle2 size={20} />
            </div>
            <div className="inbox-card-body">
              <p className="inbox-card-title">You're all caught up.</p>
              <p className="inbox-card-sub">
                Nothing overdue, unsized, or waiting in email. Nice and clear.
              </p>
            </div>
          </div>
        ) : (
          <div className="inbox-cards">
            {overdueUnscheduled.length > 0 && (
              <div className="inbox-card needs-attention">
                <div className="inbox-card-icon" aria-hidden="true">
                  <AlertTriangle size={20} />
                </div>
                <div className="inbox-card-body">
                  <p className="inbox-card-title">
                    {overdueUnscheduled.length} overdue task
                    {overdueUnscheduled.length > 1 ? 's' : ''} with no plan
                  </p>
                  <p className="inbox-card-sub">
                    Past due and not yet scheduled. Auto-plan can pull them into today.
                  </p>
                  <TaskLines tasks={overdueUnscheduled} />
                </div>
                <div className="inbox-card-actions">
                  <Link to="/today" className="btn btn-primary inbox-card-action">
                    Plan today
                  </Link>
                </div>
              </div>
            )}

            {missingEstimate.length > 0 && (
              <div className="inbox-card">
                <div className="inbox-card-icon" aria-hidden="true">
                  <Timer size={20} />
                </div>
                <div className="inbox-card-body">
                  <p className="inbox-card-title">
                    {missingEstimate.length} task{missingEstimate.length > 1 ? 's' : ''} missing a
                    time estimate
                  </p>
                  <p className="inbox-card-sub">
                    The planner needs a rough size to fit these into your day. Open one to add it.
                  </p>
                  <TaskLines tasks={missingEstimate} />
                </div>
                <div className="inbox-card-actions">
                  <Link to="/schedule" className="btn btn-secondary inbox-card-action">
                    Review
                  </Link>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="inbox-section" id="suggestions">
        <SuggestionsList />
      </div>

      <div className="inbox-section">
        <h2 className="inbox-section-title">School schedule reminders</h2>
        <p className="inbox-intro">
          Mark your school Saturdays (or any irregular school days) in the Month calendar so
          auto-plan knows when you're busy. Here's a quick status for upcoming months.
        </p>
        <div className="inbox-cards">
          {reminders.map((r) => {
            const needsAttention = r.schoolCount === 0 && !r.dismissed;
            return (
              <div key={r.id} className={`inbox-card${needsAttention ? ' needs-attention' : ''}${r.dismissed ? ' dismissed' : ''}`}>
                <div className="inbox-card-icon" aria-hidden="true">
                  <CalendarDays size={20} />
                </div>
                <div className="inbox-card-body">
                  <p className="inbox-card-title">{r.label}</p>
                  <p className="inbox-card-sub">
                    {r.schoolCount > 0
                      ? `${r.schoolCount} school day${r.schoolCount > 1 ? 's' : ''} marked — looks good.`
                      : r.dismissed
                        ? 'Acknowledged — no school days this month.'
                        : 'No school days marked yet. Tap to open the calendar and set them.'}
                  </p>
                </div>
                <div className="inbox-card-actions">
                  {r.schoolCount > 0 ? (
                    <Link to="/schedule" className="btn btn-secondary inbox-card-action">
                      View
                    </Link>
                  ) : r.dismissed ? (
                    <button
                      type="button"
                      className="btn btn-ghost inbox-card-action"
                      onClick={() => undismissMonth(r.id)}
                    >
                      Undo
                    </button>
                  ) : (
                    <>
                      <Link to="/schedule" className="btn btn-primary inbox-card-action">
                        Set days
                      </Link>
                      <button
                        type="button"
                        className="btn btn-ghost inbox-card-action"
                        onClick={() => dismissMonth(r.id)}
                      >
                        All clear
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
