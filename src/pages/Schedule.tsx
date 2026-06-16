import { useMemo, useState } from 'react';
import {
  format,
  isToday,
  isTomorrow,
  isYesterday,
  differenceInCalendarDays,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  isSameMonth,
  addMonths,
} from 'date-fns';
import { createEvents, type EventAttributes } from 'ics';
import { CalendarPlus, Clock, ChevronLeft, ChevronRight, CalendarDays, List } from 'lucide-react';
import { useTasks } from '../context/TaskContext';
import type { Task, Priority } from '../types/Task';

const DEFAULT_DURATION_MIN = 60;

/** Resolve a task's due date (+ optional time) into a concrete Date. */
function parseDue(task: Task): Date | null {
  if (!task.dueDate) return null;
  const [y, m, d] = task.dueDate.split('-').map(Number);
  if (!y || !m || !d) return null;
  if (task.startTime) {
    const [hh, mm] = task.startTime.split(':').map(Number);
    return new Date(y, m - 1, d, hh ?? 0, mm ?? 0);
  }
  return new Date(y, m - 1, d);
}

function dayKey(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

function relativeLabel(date: Date): string {
  if (isToday(date)) return 'Today';
  if (isTomorrow(date)) return 'Tomorrow';
  if (isYesterday(date)) return 'Yesterday';
  return format(date, 'EEEE, MMM d');
}

function dueBadge(date: Date): { text: string; tone: 'overdue' | 'soon' | 'later' } {
  const diff = differenceInCalendarDays(date, new Date());
  if (diff < 0) return { text: diff === -1 ? '1 day overdue' : `${-diff} days overdue`, tone: 'overdue' };
  if (diff === 0) return { text: 'Due today', tone: 'soon' };
  if (diff === 1) return { text: 'Due tomorrow', tone: 'soon' };
  return { text: `in ${diff} days`, tone: 'later' };
}

const PRIORITY_LABEL: Record<Priority, string> = { high: 'High', medium: 'Medium', low: 'Low' };

interface DatedTask {
  task: Task;
  due: Date;
}

export default function Schedule() {
  const { tasks } = useTasks();
  const [view, setView] = useState<'upcoming' | 'month'>('upcoming');

  const dated = useMemo<DatedTask[]>(() => {
    return tasks
      .map((task) => ({ task, due: parseDue(task) }))
      .filter((x): x is DatedTask => x.due !== null)
      .sort((a, b) => a.due.getTime() - b.due.getTime());
  }, [tasks]);

  const unscheduled = useMemo(() => tasks.filter((t) => !t.dueDate), [tasks]);

  const [month, setMonth] = useState(() => startOfMonth(dated[0]?.due ?? new Date()));

  function handleExport() {
    const icsEvents: EventAttributes[] = dated.map(({ task, due }) => ({
      title: task.title,
      description: task.subject ?? undefined,
      start: [due.getFullYear(), due.getMonth() + 1, due.getDate(), due.getHours(), due.getMinutes()],
      duration: { minutes: task.estimatedMinutes ?? DEFAULT_DURATION_MIN },
    }));
    const { error, value } = createEvents(icsEvents);
    if (error || !value) {
      console.error('Failed to build .ics:', error);
      return;
    }
    const blob = new Blob([value], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'lazyload-schedule.ics';
    a.click();
    URL.revokeObjectURL(url);
  }

  if (tasks.length === 0) {
    return (
      <section className="page schedule-page">
        <h1>Your Schedule</h1>
        <div className="schedule-empty">
          <CalendarDays size={40} strokeWidth={1.5} />
          <p>No tasks yet. Upload a screenshot to build your schedule.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="page schedule-page">
      <div className="schedule-header">
        <h1>Your Schedule</h1>
        <div className="schedule-toolbar">
          <div className="view-toggle" role="tablist" aria-label="Calendar view">
            <button
              role="tab"
              aria-selected={view === 'upcoming'}
              className={view === 'upcoming' ? 'active' : ''}
              onClick={() => setView('upcoming')}
            >
              <List size={16} /> Upcoming
            </button>
            <button
              role="tab"
              aria-selected={view === 'month'}
              className={view === 'month' ? 'active' : ''}
              onClick={() => setView('month')}
            >
              <CalendarDays size={16} /> Month
            </button>
          </div>
          <button type="button" className="export-button" onClick={handleExport} disabled={dated.length === 0}>
            <CalendarPlus size={16} /> Add to Calendar
          </button>
        </div>
      </div>

      {view === 'upcoming' ? (
        <UpcomingView dated={dated} unscheduled={unscheduled} />
      ) : (
        <MonthView dated={dated} month={month} onMonthChange={setMonth} unscheduled={unscheduled} />
      )}
    </section>
  );
}

function UpcomingView({ dated, unscheduled }: { dated: DatedTask[]; unscheduled: Task[] }) {
  // Group by calendar day, preserving sorted order.
  const groups = useMemo(() => {
    const map = new Map<string, DatedTask[]>();
    for (const item of dated) {
      const key = dayKey(item.due);
      const arr = map.get(key);
      if (arr) arr.push(item);
      else map.set(key, [item]);
    }
    return Array.from(map.entries()).map(([key, items]) => ({ key, date: items[0].due, items }));
  }, [dated]);

  return (
    <div className="upcoming">
      {groups.map(({ key, date, items }) => {
        const overdue = differenceInCalendarDays(date, new Date()) < 0;
        return (
          <div className="day-group" key={key}>
            <div className={`day-heading${overdue ? ' overdue' : ''}${isToday(date) ? ' today' : ''}`}>
              <span className="day-label">{relativeLabel(date)}</span>
              <span className="day-date">{format(date, 'MMM d')}</span>
            </div>
            <div className="day-tasks">
              {items.map(({ task, due }) => (
                <TaskRow key={task.id} task={task} due={due} />
              ))}
            </div>
          </div>
        );
      })}

      {unscheduled.length > 0 && (
        <div className="day-group">
          <div className="day-heading muted">
            <span className="day-label">No due date</span>
          </div>
          <div className="day-tasks">
            {unscheduled.map((task) => (
              <div className="task-row" key={task.id}>
                <span className={`prio-bar prio-${task.priority ?? 'medium'}`} aria-hidden="true" />
                <div className="task-row-body">
                  <div className="task-row-main">
                    <span className="task-row-title">{task.title}</span>
                    {task.subject && <span className="task-chip">{task.subject}</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TaskRow({ task, due }: { task: Task; due: Date }) {
  const badge = dueBadge(due);
  const priority = task.priority ?? 'medium';
  return (
    <div className="task-row">
      <span className={`prio-bar prio-${priority}`} aria-hidden="true" />
      <div className="task-row-body">
        <div className="task-row-main">
          <span className="task-row-title">{task.title}</span>
          {task.subject && <span className="task-chip">{task.subject}</span>}
        </div>
        <div className="task-row-meta">
          <span className="task-time">
            <Clock size={13} /> {task.startTime ? format(due, 'h:mm a') : 'All day'}
          </span>
          <span className={`task-badge badge-${badge.tone}`}>{badge.text}</span>
          <span className={`prio-tag prio-${priority}`}>{PRIORITY_LABEL[priority]}</span>
        </div>
      </div>
    </div>
  );
}

function MonthView({
  dated,
  month,
  onMonthChange,
  unscheduled,
}: {
  dated: DatedTask[];
  month: Date;
  onMonthChange: (d: Date) => void;
  unscheduled: Task[];
}) {
  const days = useMemo(
    () =>
      eachDayOfInterval({
        start: startOfWeek(startOfMonth(month)),
        end: endOfWeek(endOfMonth(month)),
      }),
    [month],
  );

  const byDay = useMemo(() => {
    const map = new Map<string, DatedTask[]>();
    for (const item of dated) {
      const key = dayKey(item.due);
      const arr = map.get(key);
      if (arr) arr.push(item);
      else map.set(key, [item]);
    }
    return map;
  }, [dated]);

  return (
    <div className="month">
      <div className="month-nav">
        <button onClick={() => onMonthChange(addMonths(month, -1))} aria-label="Previous month">
          <ChevronLeft size={18} />
        </button>
        <span className="month-title">{format(month, 'MMMM yyyy')}</span>
        <button onClick={() => onMonthChange(addMonths(month, 1))} aria-label="Next month">
          <ChevronRight size={18} />
        </button>
      </div>

      <div className="month-grid">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
          <div className="month-weekday" key={d}>
            {d}
          </div>
        ))}
        {days.map((day) => {
          const items = byDay.get(dayKey(day)) ?? [];
          const outside = !isSameMonth(day, month);
          return (
            <div
              key={day.toISOString()}
              className={`month-cell${outside ? ' outside' : ''}${isToday(day) ? ' today' : ''}`}
            >
              <span className="month-cell-num">{format(day, 'd')}</span>
              <div className="month-cell-tasks">
                {items.slice(0, 3).map(({ task }) => (
                  <span
                    key={task.id}
                    className={`month-pill prio-${task.priority ?? 'medium'}`}
                    title={task.title}
                  >
                    {task.title}
                  </span>
                ))}
                {items.length > 3 && <span className="month-more">+{items.length - 3} more</span>}
              </div>
            </div>
          );
        })}
      </div>

      {unscheduled.length > 0 && (
        <p className="month-unscheduled">
          {unscheduled.length} task{unscheduled.length > 1 ? 's' : ''} with no due date (see Upcoming).
        </p>
      )}
    </div>
  );
}
