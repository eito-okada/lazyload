import { useMemo } from 'react';
import { Sun, ListChecks } from 'lucide-react';
import type { Task } from '../types/Task';
import { itemKind, parsePlanned, workloadBuckets } from '../lib/schedule';
import { formatDuration } from '../lib/coach';
import ItemRow from './TaskRow';

/**
 * The "Everything left" rail beside the Daily Plan. Shows the *complete* set of
 * incomplete tasks, organized into calm urgency buckets, so the user always sees
 * the whole scope at a glance instead of guessing how much is left. Presentational:
 * all task mutations flow back through the handlers the page already owns.
 */
export default function WorkloadRail({
  tasks,
  now,
  onOpen,
  onToggleDone,
  onDelete,
}: {
  tasks: Task[];
  now: Date;
  onOpen: (item: Task, date?: Date | null, end?: Date | null) => void;
  onToggleDone: (task: Task) => void;
  onDelete: (id: string) => void;
}) {
  const groups = useMemo(() => workloadBuckets(tasks, now), [tasks, now]);

  const summary = useMemo(() => {
    const left = tasks.filter((t) => itemKind(t) === 'task' && !t.done);
    const totalMinutes = groups.reduce((s, g) => s + g.totalMinutes, 0);
    const overdue = groups.find((g) => g.id === 'overdue')?.tasks.length ?? 0;
    const scheduled = left.filter((t) => !!parsePlanned(t)).length;
    return { count: left.length, totalMinutes, overdue, scheduled };
  }, [tasks, groups]);

  return (
    <div className="workload-rail">
      <div className="workload-head">
        <h2 className="workload-title">
          <ListChecks size={17} /> Everything left
        </h2>
        {summary.count > 0 && (
          <>
            <p className="workload-summary">
              {summary.count} task{summary.count === 1 ? '' : 's'} · ~{formatDuration(summary.totalMinutes)}
              {summary.scheduled > 0 && ` · ${summary.scheduled} scheduled`}
            </p>
            {summary.overdue > 0 && (
              <p className="workload-overdue-note">
                {summary.overdue} need{summary.overdue === 1 ? 's' : ''} a look
              </p>
            )}
          </>
        )}
      </div>

      {summary.count === 0 ? (
        <div className="workload-empty">
          <Sun size={32} strokeWidth={1.5} />
          <p>You're all caught up — nothing left to do.</p>
        </div>
      ) : (
        <div className="workload-groups">
          {groups.map((group) => {
            const rows = group.tasks.map((task) => (
              <ItemRow
                key={task.id}
                item={task}
                onToggleDone={onToggleDone}
                onDelete={onDelete}
                onOpen={onOpen}
              />
            ));
            // Lower-urgency buckets start collapsed so the rail stays calm — the
            // whole scope is one click away, not a wall of obligations on arrival.
            const collapsible = group.id === 'later' || group.id === 'undated';
            if (collapsible) {
              return (
                <details className="day-group workload-collapsible" key={group.id}>
                  <summary className="day-heading">
                    <span className="day-label">{group.label}</span>
                    <span className="day-count">{group.tasks.length}</span>
                  </summary>
                  <div className="day-tasks">{rows}</div>
                </details>
              );
            }
            return (
              <div className="day-group" key={group.id}>
                <div className={`day-heading${group.id === 'overdue' ? ' overdue' : ''}`}>
                  <span className="day-label">{group.label}</span>
                  <span className="day-count">{group.tasks.length}</span>
                </div>
                <div className="day-tasks">{rows}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
