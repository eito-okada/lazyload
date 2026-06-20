// The "coach" layer for the Daily Plan: warm, deterministic copy that frames the
// day and points at what to do right now. Kept pure (no React, no network) so it's
// instant, free, and unit-testable — the AI plan summary is surfaced on top when
// present, but the app never depends on it. See src/services/api.ts for the same
// "AI is decorative, always has a fallback" pattern.
import { isToday, isTomorrow } from 'date-fns';
import { relativeLabel } from './schedule';

/** Minimal shape the focus picker needs — a block with a concrete time span. */
export interface TimeSpan {
  start: Date;
  end: Date;
}

export interface BriefingInput {
  /** The day being viewed. */
  day: Date;
  /** Reference instant ("now") — passed in so the copy is testable. */
  now: Date;
  /** Planned work sessions on this day. */
  sessionCount: number;
  /** Timed events on this day. */
  eventCount: number;
  /** Total planned focus minutes across the sessions. */
  focusMinutes: number;
  /** Task completion for the day. */
  progress: { total: number; done: number };
}

/** "Good morning" / "afternoon" / "evening" from the clock. */
export function greeting(now: Date): string {
  const h = now.getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

/** Compact human duration: 90 → "1h 30m", 60 → "1h", 45 → "45m". */
export function formatDuration(min: number): string {
  if (min <= 0) return '0m';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * A warm one-liner framing the day: a time-of-day greeting (for today), the shape
 * of the day (focus blocks + events + total focus time), and a nudge. Celebrates
 * when every task is done; gently invites planning when the day is empty.
 */
export function buildBriefing(input: BriefingInput): string {
  const { day, now, sessionCount, eventCount, focusMinutes, progress } = input;
  const today = isToday(day);
  const lead = today ? greeting(now) : isTomorrow(day) ? 'Tomorrow' : relativeLabel(day);

  // Day cleared — every task done.
  if (progress.total > 0 && progress.done === progress.total) {
    return today
      ? `${lead} — every task done. The rest of the day is yours.`
      : `${lead} is all wrapped up. Nice and clear.`;
  }

  // Nothing on the books.
  if (sessionCount === 0 && eventCount === 0) {
    return today
      ? `${lead}. Nothing scheduled yet — auto-plan your tasks or add something.`
      : `${lead} is open. Auto-plan ahead or keep it free.`;
  }

  const parts: string[] = [];
  if (sessionCount > 0) parts.push(plural(sessionCount, 'focus block'));
  if (eventCount > 0) parts.push(plural(eventCount, 'event'));
  const shape = parts.join(' and ');
  const focus = focusMinutes > 0 ? `, ${formatDuration(focusMinutes)} of deep work` : '';

  // Mid-progress momentum line takes priority when some tasks are already done.
  if (today && progress.done > 0) {
    return `${lead} — ${progress.done} of ${progress.total} done. ${shape}${focus} left. Keep the momentum.`;
  }

  const closer = today ? "You've got this." : 'Plenty of runway.';
  return `${lead} — ${shape}${focus} ahead. ${closer}`;
}

/**
 * One calm line for the plan banner when the auto-plan pulled overdue work into
 * the day, so it's not a silent surprise that past-due tasks now sit on your
 * schedule. Empty when nothing overdue was carried in (so callers can append it
 * unconditionally). #1 in the roadmap.
 */
export function overduePlanNote(overdueCount: number): string {
  if (overdueCount <= 0) return '';
  return `Includes ${plural(overdueCount, 'overdue task')}, pulled in for today.`;
}

/**
 * The brief, auto-dismissing beat shown right after a task is checked off: a small
 * acknowledgement plus what remains, so finishing one thing points at the next
 * instead of leaving a void. `remaining` counts still-incomplete tasks; `nextTitle`
 * is the soonest one left (null when the slate is clear). #3 in the roadmap.
 */
export function completionNudge(remaining: number, nextTitle: string | null): string {
  if (remaining <= 0) return "That's everything cleared — nicely done.";
  const left = `Nice — ${plural(remaining, 'task')} left.`;
  return nextTitle ? `${left} Next up: ${nextTitle}.` : left;
}

/** A completed task's estimate vs. the time it actually took (both in minutes). */
export interface EstimateSample {
  estimated: number;
  actual: number;
}

/**
 * Duration-learning nudge (#8): given recently completed tasks that carry both an
 * estimate and a recorded actual time, gently flag when they ran consistently long
 * (or short) so the user can correct stale estimates. Returns null unless there's
 * real signal — we never nag off one or two data points, and we use the *median*
 * ratio so a single marathon session doesn't trip it. `subject`, when given, scopes
 * the copy ("your Physics tasks") since estimate bias tends to cluster by subject.
 */
export function estimateBiasNudge(samples: EstimateSample[], subject?: string): string | null {
  const ratios = samples
    .filter((s) => s.estimated > 0 && s.actual > 0)
    .map((s) => s.actual / s.estimated)
    .sort((a, b) => a - b);
  if (ratios.length < 3) return null;
  const median = ratios[Math.floor(ratios.length / 2)];
  const scope = subject ? `your ${subject} tasks` : 'these tasks';
  if (median >= 1.25) {
    const pct = Math.round((median - 1) * 100);
    return `Heads up — ${scope} have run about ${pct}% longer than estimated lately. Padding future estimates will make your plan more realistic.`;
  }
  if (median <= 0.75) {
    const pct = Math.round((1 - median) * 100);
    return `Nice — ${scope} have taken about ${pct}% less time than estimated. You could trim those estimates and fit a little more in.`;
  }
  return null;
}

/**
 * The block to surface in the "Right now" card: the one in progress (now within
 * its span), else the next upcoming one. Returns null when nothing lies ahead.
 * Generic over any timed entry so callers pass their own block shape.
 */
export function pickFocus<T extends TimeSpan>(
  entries: T[],
  now: Date,
): { entry: T; state: 'now' | 'next' } | null {
  const sorted = [...entries].sort((a, b) => a.start.getTime() - b.start.getTime());
  const current = sorted.find((e) => e.start <= now && now < e.end);
  if (current) return { entry: current, state: 'now' };
  const next = sorted.find((e) => e.start > now);
  if (next) return { entry: next, state: 'next' };
  return null;
}
