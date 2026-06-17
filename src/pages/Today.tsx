import { useMemo, useState } from 'react';
import { addDays, startOfDay, endOfDay, isToday, format } from 'date-fns';
import { ChevronLeft, ChevronRight, Sun, Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTasks } from '../context/TaskContext';
import type { Task } from '../types/Task';
import ItemRow from '../components/TaskRow';
import { resolveOccurrences, dayKey, relativeLabel, itemKind, type ScheduledItem } from '../lib/schedule';

function isTimed(occ: ScheduledItem): boolean {
  return itemKind(occ.item) === 'event' ? !occ.item.allDay : !!occ.item.dueTime;
}

export default function Today() {
  const { allTasks, updateTask, deleteTask } = useTasks();
  const [day, setDay] = useState(() => new Date());

  function toggleDone(task: Task) {
    updateTask(task.id, { done: !task.done });
  }

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

  const empty = timed.length === 0 && anytime.length === 0;

  return (
    <section className="page schedule-page">
      <div className="schedule-header">
        <h1>Daily Plan</h1>
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
          <button type="button" className="link-button" onClick={() => setDay(new Date())}>
            Jump to today
          </button>
        )}
        {progress.total > 0 && (
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

      {empty ? (
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
                {timed.map((occ) => (
                  <ItemRow
                    key={occ.occurrenceKey}
                    item={occ.item}
                    date={occ.date}
                    end={occ.end}
                    onToggleDone={toggleDone}
                    onDelete={deleteTask}
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
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
