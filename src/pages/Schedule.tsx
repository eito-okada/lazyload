import { useMemo } from 'react';
import { Calendar, dateFnsLocalizer, type Event } from 'react-big-calendar';
import { format, parse, startOfWeek, getDay } from 'date-fns';
import { enUS } from 'date-fns/locale';
import { createEvents, type EventAttributes } from 'ics';
import { CalendarPlus } from 'lucide-react';
import { useTasks } from '../context/TaskContext';
import type { Task } from '../types/Task';
import 'react-big-calendar/lib/css/react-big-calendar.css';

const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek,
  getDay,
  locales: { 'en-US': enUS },
});

const DEFAULT_START_HOUR = 16; // 4:00 PM when no specific time is given
const DEFAULT_DURATION_MIN = 60;

/** Resolve a task's due date + optional start time into a concrete Date. */
function taskStart(task: Task): Date | null {
  if (!task.dueDate) return null;
  const [y, m, d] = task.dueDate.split('-').map(Number);
  if (!y || !m || !d) return null;
  if (task.startTime) {
    const [hh, mm] = task.startTime.split(':').map(Number);
    return new Date(y, m - 1, d, hh, mm);
  }
  return new Date(y, m - 1, d, DEFAULT_START_HOUR, 0);
}

export default function Schedule() {
  const { tasks } = useTasks();

  const scheduled = useMemo(
    () => tasks.map((t) => ({ task: t, start: taskStart(t) })).filter((x) => x.start !== null),
    [tasks],
  );
  const unscheduled = tasks.filter((t) => !t.dueDate);

  const events: Event[] = scheduled.map(({ task, start }) => {
    const s = start as Date;
    const end = new Date(s.getTime() + (task.estimatedMinutes ?? DEFAULT_DURATION_MIN) * 60_000);
    return { title: task.title, start: s, end };
  });

  function handleExport() {
    const icsEvents: EventAttributes[] = scheduled.map(({ task, start }) => {
      const s = start as Date;
      return {
        title: task.title,
        description: task.subject ?? undefined,
        start: [s.getFullYear(), s.getMonth() + 1, s.getDate(), s.getHours(), s.getMinutes()],
        duration: { minutes: task.estimatedMinutes ?? DEFAULT_DURATION_MIN },
      };
    });

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

  return (
    <section className="page schedule-page">
      <h1>Your Schedule</h1>

      {tasks.length === 0 ? (
        <p>No tasks to schedule yet. Upload a screenshot first.</p>
      ) : (
        <>
          <button
            type="button"
            className="cta-button"
            onClick={handleExport}
            disabled={events.length === 0}
          >
            <CalendarPlus size={18} /> Add to Calendar (.ics)
          </button>

          <div className="calendar-wrap">
            <Calendar
              localizer={localizer}
              events={events}
              defaultView="week"
              views={['month', 'week', 'day', 'agenda']}
              startAccessor="start"
              endAccessor="end"
              style={{ height: 600 }}
            />
          </div>

          {unscheduled.length > 0 && (
            <div className="unscheduled">
              <h2>No due date — not on the calendar</h2>
              <ul>
                {unscheduled.map((t) => (
                  <li key={t.id}>{t.title}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
