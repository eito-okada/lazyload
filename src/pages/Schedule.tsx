import { useEffect, useMemo, useState } from 'react';
import {
  format,
  isToday,
  differenceInCalendarDays,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  isSameMonth,
  addMonths,
} from 'date-fns';
import { createEvents, type EventAttributes, type DateArray } from 'ics';
import {
  CalendarPlus,
  CalendarDays,
  List,
  ChevronLeft,
  ChevronRight,
  Plus,
  RefreshCw,
  X,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTasks } from '../context/TaskContext';
import { syncNow } from '../services/googleSync';
import type { Task } from '../types/Task';
import ItemRow from '../components/TaskRow';
import ItemDetail from '../components/ItemDetail';
import {
  DEFAULT_DURATION_MIN,
  dayKey,
  relativeLabel,
  resolveOccurrences,
  undatedItems,
  itemKind,
  parseDue,
  parseStart,
  parseEnd,
  type ScheduledItem,
} from '../lib/schedule';

function toDateArray(d: Date): DateArray {
  return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];
}

/** An item the user clicked, with the occurrence instants for display. */
interface OpenItem {
  item: Task;
  date?: Date | null;
  end?: Date | null;
}

export default function Schedule() {
  const { allTasks, updateTask, deleteTask } = useTasks();
  const [view, setView] = useState<'upcoming' | 'month'>('upcoming');
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [selected, setSelected] = useState<OpenItem | null>(null);
  const [expandedDay, setExpandedDay] = useState<{ date: Date; items: ScheduledItem[] } | null>(null);

  const openItem = (item: Task, date?: Date | null, end?: Date | null) =>
    setSelected({ item, date, end });

  // From the day-overflow modal: replace it with the item's detail view.
  const openItemFromDay = (item: Task, date?: Date | null, end?: Date | null) => {
    setExpandedDay(null);
    setSelected({ item, date, end });
  };

  // Wide window so overdue items and a few months of recurring events show in the agenda.
  const upcoming = useMemo<ScheduledItem[]>(() => {
    const now = new Date();
    return resolveOccurrences(allTasks, addMonths(now, -2), addMonths(now, 3));
  }, [allTasks]);

  const unscheduled = useMemo(() => undatedItems(allTasks), [allTasks]);

  function toggleDone(task: Task) {
    updateTask(task.id, { done: !task.done });
  }

  function handleExport() {
    const events: EventAttributes[] = [];
    for (const item of allTasks) {
      if (itemKind(item) === 'event') {
        const start = parseStart(item);
        if (!start) continue;
        const end = parseEnd(item);
        const base = {
          title: item.title,
          description: item.subject ?? undefined,
          location: item.location ?? undefined,
          start: toDateArray(start),
          recurrenceRule: item.recurrenceRule ?? undefined,
        };
        events.push(
          end
            ? { ...base, end: toDateArray(end) }
            : { ...base, duration: { minutes: DEFAULT_DURATION_MIN } },
        );
      } else {
        const due = parseDue(item);
        if (!due) continue;
        events.push({
          title: item.title,
          description: item.subject ?? undefined,
          start: toDateArray(due),
          duration: { minutes: item.estimatedMinutes ?? DEFAULT_DURATION_MIN },
        });
      }
    }
    const { error, value } = createEvents(events);
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

  async function handleGoogleSync() {
    setSyncing(true);
    setSyncMessage(null);
    try {
      const r = await syncNow();
      setSyncMessage(
        `Synced to Google — ${r.created} added, ${r.updated} updated, ${r.deleted} removed.`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sync failed.';
      setSyncMessage(
        message === 'Google Calendar not connected'
          ? 'Google Calendar not connected — connect it in Settings.'
          : message,
      );
    } finally {
      setSyncing(false);
    }
  }

  if (allTasks.length === 0) {
    return (
      <section className="page schedule-page">
        <h1>Your Schedule</h1>
        <div className="schedule-empty">
          <CalendarDays size={40} strokeWidth={1.5} />
          <p>Nothing scheduled yet. Upload a screenshot or add a task or event to get started.</p>
          <Link to="/add" className="cta-button">
            <Plus size={16} /> Add task or event
          </Link>
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
          <div className="schedule-toolbar-actions">
            <Link to="/add" className="export-button">
              <Plus size={16} /> Add
            </Link>
            <button type="button" className="export-button" onClick={handleExport}>
              <CalendarPlus size={16} /> Add to iCalendar
            </button>
            <button
              type="button"
              className="export-button"
              onClick={handleGoogleSync}
              disabled={syncing}
            >
              <RefreshCw size={16} /> {syncing ? 'Syncing…' : 'Sync to Google Calendar'}
            </button>
          </div>
        </div>
        {syncMessage && <p className="schedule-sync-message">{syncMessage}</p>}
      </div>

      {view === 'upcoming' ? (
        <UpcomingView
          dated={upcoming}
          unscheduled={unscheduled}
          onToggleDone={toggleDone}
          onDelete={deleteTask}
          onOpen={openItem}
        />
      ) : (
        <MonthView
          items={allTasks}
          month={month}
          onMonthChange={setMonth}
          unscheduled={unscheduled}
          onOpen={openItem}
          onExpandDay={(date, items) => setExpandedDay({ date, items })}
        />
      )}

      {expandedDay && (
        <DayModal
          date={expandedDay.date}
          items={expandedDay.items}
          onClose={() => setExpandedDay(null)}
          onOpen={openItemFromDay}
          onToggleDone={toggleDone}
          onDelete={deleteTask}
        />
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

function UpcomingView({
  dated,
  unscheduled,
  onToggleDone,
  onDelete,
  onOpen,
}: {
  dated: ScheduledItem[];
  unscheduled: Task[];
  onToggleDone: (task: Task) => void;
  onDelete: (taskId: string) => void;
  onOpen: (item: Task, date?: Date | null, end?: Date | null) => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, ScheduledItem[]>();
    for (const occ of dated) {
      const key = dayKey(occ.date);
      const arr = map.get(key);
      if (arr) arr.push(occ);
      else map.set(key, [occ]);
    }
    return Array.from(map.entries()).map(([key, items]) => ({ key, date: items[0].date, items }));
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
              {items.map((occ) => (
                <ItemRow
                  key={occ.occurrenceKey}
                  item={occ.item}
                  date={occ.date}
                  end={occ.end}
                  onToggleDone={onToggleDone}
                  onDelete={onDelete}
                  onOpen={onOpen}
                />
              ))}
            </div>
          </div>
        );
      })}

      {unscheduled.length > 0 && (
        <div className="day-group">
          <div className="day-heading muted">
            <span className="day-label">No date</span>
          </div>
          <div className="day-tasks">
            {unscheduled.map((task) => (
              <ItemRow
                key={task.id}
                item={task}
                onToggleDone={onToggleDone}
                onDelete={onDelete}
                onOpen={onOpen}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MonthView({
  items,
  month,
  onMonthChange,
  unscheduled,
  onOpen,
  onExpandDay,
}: {
  items: Task[];
  month: Date;
  onMonthChange: (d: Date) => void;
  unscheduled: Task[];
  onOpen: (item: Task, date?: Date | null, end?: Date | null) => void;
  onExpandDay: (date: Date, items: ScheduledItem[]) => void;
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
    const occ = resolveOccurrences(
      items,
      startOfWeek(startOfMonth(month)),
      endOfWeek(endOfMonth(month)),
    );
    const map = new Map<string, ScheduledItem[]>();
    for (const item of occ) {
      const key = dayKey(item.date);
      const arr = map.get(key);
      if (arr) arr.push(item);
      else map.set(key, [item]);
    }
    return map;
  }, [items, month]);

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
          const dayItems = byDay.get(dayKey(day)) ?? [];
          const outside = !isSameMonth(day, month);
          return (
            <div
              key={day.toISOString()}
              className={`month-cell${outside ? ' outside' : ''}${isToday(day) ? ' today' : ''}`}
            >
              <span className="month-cell-num">{format(day, 'd')}</span>
              <div className="month-cell-tasks">
                {dayItems.slice(0, 3).map((occ) => (
                  <button
                    type="button"
                    key={occ.occurrenceKey}
                    className={`month-pill ${occ.kind === 'event' ? 'prio-event' : `prio-${occ.item.priority ?? 'medium'}`}`}
                    title={occ.item.title}
                    onClick={() => onOpen(occ.item, occ.date, occ.end)}
                  >
                    {occ.item.title}
                  </button>
                ))}
                {dayItems.length > 3 && (
                  <button
                    type="button"
                    className="month-more"
                    onClick={() => onExpandDay(day, dayItems)}
                  >
                    +{dayItems.length - 3} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {unscheduled.length > 0 && (
        <p className="month-unscheduled">
          {unscheduled.length} item{unscheduled.length > 1 ? 's' : ''} with no date (see Upcoming).
        </p>
      )}
    </div>
  );
}

/** Lists every item on a single day, opened from a month cell's "+N more". */
function DayModal({
  date,
  items,
  onClose,
  onOpen,
  onToggleDone,
  onDelete,
}: {
  date: Date;
  items: ScheduledItem[];
  onClose: () => void;
  onOpen: (item: Task, date?: Date | null, end?: Date | null) => void;
  onToggleDone: (task: Task) => void;
  onDelete: (taskId: string) => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Items on ${format(date, 'MMMM d')}`}
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="modal-close icon-button" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>
        <div className="modal-head">
          <span className="detail-kind is-event">{relativeLabel(date)}</span>
          <h2 className="modal-title">{format(date, 'EEEE, MMMM d')}</h2>
        </div>
        <div className="day-tasks">
          {items.map((occ) => (
            <ItemRow
              key={occ.occurrenceKey}
              item={occ.item}
              date={occ.date}
              end={occ.end}
              onToggleDone={onToggleDone}
              onDelete={onDelete}
              onOpen={onOpen}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
