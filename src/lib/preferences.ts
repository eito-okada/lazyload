import { useCallback, useEffect, useState } from 'react';

/**
 * Working-hours preferences that drive auto-scheduling. Stored per-browser in
 * localStorage (no schema/migration needed); planning is a client-side concern.
 * If we later want these to follow a user across devices, move the load/save
 * pair to a Supabase `user_preferences` row — the shape stays the same.
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
}

export const DEFAULT_WORKING_HOURS: WorkingHours = {
  workdays: [1, 2, 3, 4, 5], // Mon–Fri
  workStart: '08:00',
  workEnd: '17:00',
  dayStart: '08:00',
  dayEnd: '22:00',
  maxPerDayMinutes: 180,
  sessionMinutes: 90,
};

const STORAGE_KEY = 'lazyload.workingHours';

/** Read working hours from localStorage, falling back to (and filling) defaults. */
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
  // Let other open views (e.g. Today) pick up the change in this same tab.
  window.dispatchEvent(new CustomEvent('lazyload:workingHours'));
}

/**
 * React hook over the stored working hours. Re-reads when another part of the
 * app saves (via the `lazyload:workingHours` event or cross-tab `storage`).
 */
export function useWorkingHours(): [WorkingHours, (value: WorkingHours) => void] {
  const [value, setValue] = useState<WorkingHours>(loadWorkingHours);

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
  }, []);

  return [value, update];
}

export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
