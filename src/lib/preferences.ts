import { useCallback, useEffect, useState } from 'react';
import { format, addMonths, startOfMonth, endOfMonth, parseISO } from 'date-fns';
import { supabase } from './supabase';

/**
 * A day marked differently from the recurring weekly pattern.
 * 'off' = holiday (no work block); 'work' = extra school/work day using the
 * default block hours; { start, end } = extra school/work day with custom hours.
 */
export type DayOverride = 'off' | 'work' | { start: string; end: string };

/**
 * Working-hours preferences that drive auto-scheduling. Persisted in Supabase
 * `user_preferences` (cross-device) and mirrored in localStorage (instant read
 * cache + offline fallback). The hook is the authoritative interface — callers
 * don't need to know where the data lives.
 */
export interface WorkingHours {
  /** Weekday numbers (0=Sun … 6=Sat) that have a work/school block. */
  workdays: number[];
  /** Start of the daily work/school block, "HH:MM" 24h. */
  workStart: string;
  /** End of the work/school block, "HH:MM". */
  workEnd: string;
  /** Earliest you'd do tasks on any day, "HH:MM". */
  dayStart: string;
  /** Latest you'd do tasks on any day, "HH:MM". */
  dayEnd: string;
  /** Cap on auto-planned task minutes per day (keeps a day from overloading). */
  maxPerDayMinutes: number;
  /** Longest single focus session when splitting a big task across days. */
  sessionMinutes: number;
  /**
   * Per-date exceptions to the weekly `workdays` pattern, keyed by "yyyy-MM-dd":
   * 'off' = a normally-busy day with no work block (e.g. a holiday), 'work' = a
   * normally-free day that does have one (e.g. an occasional school Saturday).
   */
  overrides: Record<string, DayOverride>;
  /**
   * Months acknowledged as having no school days, stored as 'yyyy-MM' strings.
   * These are excluded from the Inbox badge count so the notification goes away.
   */
  dismissedReminders: string[];
}

export const DEFAULT_WORKING_HOURS: WorkingHours = {
  workdays: [1, 2, 3, 4, 5], // Mon–Fri
  workStart: '08:00',
  workEnd: '17:00',
  dayStart: '08:00',
  dayEnd: '22:00',
  maxPerDayMinutes: 180,
  sessionMinutes: 90,
  overrides: {},
  dismissedReminders: [],
};

/**
 * Drop overrides for past dates — they can never affect a plan again, and would
 * otherwise grow the stored map without bound.
 */
export function pruneOverrides(overrides: Record<string, DayOverride>): Record<string, DayOverride> {
  const today = format(new Date(), 'yyyy-MM-dd'); // yyyy-MM-dd sorts lexically
  const kept: Record<string, DayOverride> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (key >= today) kept[key] = value;
  }
  return kept;
}

const STORAGE_KEY = 'lazyload.workingHours';
const PREFS_TABLE = 'user_preferences';

/** Read working hours from localStorage, falling back to defaults. */
export function loadWorkingHours(): WorkingHours {
  if (typeof localStorage === 'undefined') return DEFAULT_WORKING_HOURS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_WORKING_HOURS;
    const parsed = JSON.parse(raw) as Partial<WorkingHours>;
    // Merge over defaults so a stored value missing a newer field stays valid.
    return { ...DEFAULT_WORKING_HOURS, ...parsed };
  } catch {
    return DEFAULT_WORKING_HOURS;
  }
}

export function saveWorkingHours(value: WorkingHours): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  window.dispatchEvent(new CustomEvent('lazyload:workingHours'));
}

async function fetchFromDB(): Promise<WorkingHours | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase
    .from(PREFS_TABLE)
    .select('working_hours')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!data?.working_hours) return null;
  return { ...DEFAULT_WORKING_HOURS, ...(data.working_hours as Partial<WorkingHours>) };
}

async function upsertToDB(value: WorkingHours): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  await supabase.from(PREFS_TABLE).upsert({
    user_id: user.id,
    working_hours: value,
    updated_at: new Date().toISOString(),
  });
}

/**
 * React hook over the stored working hours. On mount: immediately applies the
 * localStorage cache (instant), then fetches from Supabase and hydrates any
 * cross-device changes. First load with no DB row migrates local data up.
 * Re-reads on same-tab (`lazyload:workingHours`) and cross-tab (`storage`) events.
 */
export function useWorkingHours(): [WorkingHours, (value: WorkingHours) => void] {
  const [value, setValue] = useState<WorkingHours>(loadWorkingHours);

  useEffect(() => {
    fetchFromDB().then((remote) => {
      if (remote) {
        saveWorkingHours(remote);
        setValue(remote);
      } else {
        // No DB row yet — push current localStorage data up (one-time migration).
        upsertToDB(loadWorkingHours());
      }
    });
  }, []);

  useEffect(() => {
    const reload = () => setValue(loadWorkingHours());
    window.addEventListener('lazyload:workingHours', reload);
    window.addEventListener('storage', reload);
    return () => {
      window.removeEventListener('lazyload:workingHours', reload);
      window.removeEventListener('storage', reload);
    };
  }, []);

  const update = useCallback((next: WorkingHours) => {
    saveWorkingHours(next);
    setValue(next);
    upsertToDB(next);
  }, []);

  return [value, update];
}

export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Count upcoming months (current + next) that have no school-day overrides set
 * and haven't been explicitly dismissed. Used to badge the Inbox nav link.
 */
export function countPendingSchoolReminders(
  overrides: Record<string, DayOverride>,
  dismissed: string[],
): number {
  const today = new Date();
  let count = 0;
  for (let i = 0; i <= 1; i++) {
    const mStart = addMonths(startOfMonth(today), i);
    const mEnd = endOfMonth(mStart);
    const monthKey = format(mStart, 'yyyy-MM');
    if (dismissed.includes(monthKey)) continue;
    const hasSchool = Object.entries(overrides).some(([key, val]) => {
      const d = parseISO(key);
      return d >= mStart && d <= mEnd && val !== 'off';
    });
    if (!hasSchool) count++;
  }
  return count;
}

/** Remove dismissed-reminder entries for months already in the past. */
export function pruneDismissed(dismissed: string[]): string[] {
  const current = format(startOfMonth(new Date()), 'yyyy-MM');
  return dismissed.filter((m) => m >= current);
}
