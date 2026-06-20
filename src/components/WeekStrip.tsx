import { useMemo } from 'react';
import { startOfWeek, isToday, isSameDay, format } from 'date-fns';
import type { Task } from '../types/Task';
import { weeklyLoad } from '../lib/schedule';
import { formatDuration } from '../lib/coach';
import type { WorkingHours } from '../lib/preferences';

/**
 * A compact 7-bar "will I make it this week?" strip. Each bar fills with how booked
 * that day is relative to its own schedulable capacity (working hours minus the
 * work/school block, capped by the daily focus limit); a day booked past capacity
 * is toned as a warning. Today is marked, the day shown in the Daily Plan is
 * highlighted, and clicking a bar jumps the plan to that day. Read-only — it surfaces
 * the shape of the week so a heavy stretch is visible before it arrives.
 */
export default function WeekStrip({
  tasks,
  day,
  prefs,
  onSelectDay,
}: {
  tasks: Task[];
  /** The day currently shown in the Daily Plan (highlighted + sets the week). */
  day: Date;
  prefs: WorkingHours;
  onSelectDay: (day: Date) => void;
}) {
  const week = useMemo(() => weeklyLoad(tasks, startOfWeek(day), prefs), [tasks, day, prefs]);
  const overCount = week.filter((d) => d.over).length;

  return (
    <div className="week-strip">
      <div className="week-strip-head">
        <span className="week-strip-title">This week</span>
        {overCount > 0 && (
          <span className="week-strip-warn">
            {overCount} day{overCount === 1 ? '' : 's'} over capacity
          </span>
        )}
      </div>
      <div className="week-strip-days">
        {week.map((d) => {
          // Fill is how booked the day is against its free time (clamped to 100%,
          // tinted when over). A day with no free time but something booked reads full.
          const ratio =
            d.freeMinutes > 0
              ? d.committedMinutes / d.freeMinutes
              : d.committedMinutes > 0
                ? 1
                : 0;
          const fillPct = Math.min(100, Math.round(ratio * 100));
          const selected = isSameDay(d.day, day);
          const today = isToday(d.day);
          const cls = [
            'week-bar',
            selected ? 'selected' : '',
            today ? 'today' : '',
            d.over ? 'over' : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <button
              key={d.day.toISOString()}
              type="button"
              className={cls}
              onClick={() => onSelectDay(d.day)}
              title={`${format(d.day, 'EEE MMM d')} — ${formatDuration(d.committedMinutes)} booked of ${formatDuration(d.freeMinutes)} free${d.over ? ' (over capacity)' : ''}`}
              aria-label={`${format(d.day, 'EEEE MMMM d')}, ${formatDuration(d.committedMinutes)} booked of ${formatDuration(d.freeMinutes)} free${d.over ? ', over capacity' : ''}`}
            >
              <span className="week-bar-track">
                <span className="week-bar-fill" style={{ height: `${fillPct}%` }} />
              </span>
              <span className="week-bar-label">{format(d.day, 'EEEEE')}</span>
              <span className="week-bar-date">{format(d.day, 'd')}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
