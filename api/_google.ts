import { serviceClient } from "./_supabase";

// ── Types ────────────────────────────────────────────────────────────────────

// Raw task row (snake_case, straight from Supabase) — distinct from the
// camelCase `Task` the browser uses.
interface TaskRow {
  id: string;
  user_id: string;
  title: string;
  subject: string | null;
  due_date: string | null; // 'YYYY-MM-DD'
  due_time: string | null; // 'HH:MM[:SS]'
  estimated_minutes: number | null;
  kind: string; // 'task' | 'event'
  start_at: string | null; // ISO timestamptz
  end_at: string | null;
  all_day: boolean;
  location: string | null;
  recurrence_rule: string | null;
  google_event_id: string | null;
}

interface GoogleEventBody {
  summary: string;
  description?: string;
  location?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  recurrence?: string[];
  extendedProperties?: { private?: Record<string, string> };
}

export interface SyncResult {
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  error?: string;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3/calendars";
const DEFAULT_TASK_DURATION_MIN = 30;

// ── Date helpers (single-timezone model, consistent with src/lib/schedule.ts) ──

/** Add `days` to a 'YYYY-MM-DD' string, returning 'YYYY-MM-DD'. */
function addDaysToDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** Calendar date ('YYYY-MM-DD') of an instant as seen in `timeZone`. */
function dateInTimeZone(iso: string, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/** Normalize a stored time to 'HH:MM:SS'. */
function normalizeTime(t: string): string {
  const parts = t.split(":");
  const [hh = "00", mm = "00", ss = "00"] = parts;
  return `${hh.padStart(2, "0")}:${mm.padStart(2, "0")}:${ss.padStart(2, "0")}`;
}

/** Combine a date + time into a floating local datetime + duration offset. */
function addMinutesToLocal(date: string, time: string, minutes: number): { date: string; time: string } {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi, s] = normalizeTime(time).split(":").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi + minutes, s));
  return {
    date: dt.toISOString().slice(0, 10),
    time: dt.toISOString().slice(11, 19),
  };
}

function normalizeRecurrence(rule: string): string[] {
  return rule
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (/^(RRULE|EXRULE|RDATE|EXDATE):/i.test(line) ? line : `RRULE:${line}`));
}

// ── Mapping: LazyLoad task/event → Google event body ──────────────────────────

/**
 * Build a Google Calendar event body for a task row, or null if the row has no
 * resolvable date (undated tasks are skipped).
 */
export function itemToEvent(row: TaskRow, timeZone: string): GoogleEventBody | null {
  const isEvent = (row.kind ?? "task") === "event";
  const base: Pick<GoogleEventBody, "summary" | "location" | "extendedProperties"> = {
    summary: row.title || (isEvent ? "Event" : "Task"),
    extendedProperties: { private: { lazyloadId: row.id } },
  };
  if (row.location) base.location = row.location;

  if (isEvent) {
    if (!row.start_at) return null;
    if (row.all_day) {
      const startDate = dateInTimeZone(row.start_at, timeZone);
      const endDate = row.end_at ? dateInTimeZone(row.end_at, timeZone) : startDate;
      // Google all-day end date is exclusive; ensure at least one day.
      const exclusiveEnd = endDate > startDate ? endDate : addDaysToDate(startDate, 1);
      return {
        ...base,
        start: { date: startDate },
        end: { date: exclusiveEnd },
        ...(row.recurrence_rule ? { recurrence: normalizeRecurrence(row.recurrence_rule) } : {}),
      };
    }
    const end =
      row.end_at ?? new Date(new Date(row.start_at).getTime() + DEFAULT_TASK_DURATION_MIN * 60_000).toISOString();
    return {
      ...base,
      description: row.subject ? `Subject: ${row.subject}` : undefined,
      start: { dateTime: row.start_at, timeZone },
      end: { dateTime: end, timeZone },
      ...(row.recurrence_rule ? { recurrence: normalizeRecurrence(row.recurrence_rule) } : {}),
    };
  }

  // Task (deadline semantics).
  if (!row.due_date) return null;
  const descParts: string[] = ["Task deadline"];
  if (row.subject) descParts.push(`Subject: ${row.subject}`);
  const description = descParts.join("\n");

  if (row.due_time) {
    const startTime = normalizeTime(row.due_time);
    const dur = row.estimated_minutes ?? DEFAULT_TASK_DURATION_MIN;
    const end = addMinutesToLocal(row.due_date, startTime, dur);
    return {
      ...base,
      description,
      // Floating local time + timeZone (no offset) — Google resolves in tz.
      start: { dateTime: `${row.due_date}T${startTime}`, timeZone },
      end: { dateTime: `${end.date}T${end.time}`, timeZone },
    };
  }

  // Date-only task → all-day entry.
  return {
    ...base,
    description,
    start: { date: row.due_date },
    end: { date: addDaysToDate(row.due_date, 1) },
  };
}

// ── Google REST calls ─────────────────────────────────────────────────────────

/** Exchange the stored refresh token for a short-lived access token. */
export async function refreshAccessToken(refreshToken: string): Promise<string> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set");
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("Token refresh returned no access_token");
  return json.access_token;
}

/** Create (no existingId) or update (PATCH) an event. Returns the event id. */
export async function pushEvent(
  accessToken: string,
  calendarId: string,
  body: GoogleEventBody,
  existingId: string | null,
): Promise<string> {
  const cal = encodeURIComponent(calendarId);
  const url = existingId
    ? `${CALENDAR_BASE}/${cal}/events/${encodeURIComponent(existingId)}`
    : `${CALENDAR_BASE}/${cal}/events`;
  const res = await fetch(url, {
    method: existingId ? "PATCH" : "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  // A stored event that vanished on Google's side (404/410) → recreate it.
  if (existingId && (res.status === 404 || res.status === 410)) {
    return pushEvent(accessToken, calendarId, body, null);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`pushEvent failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as { id?: string };
  if (!json.id) throw new Error("pushEvent returned no event id");
  return json.id;
}

/** Delete an event; a 404/410 (already gone) is treated as success. */
export async function deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void> {
  const cal = encodeURIComponent(calendarId);
  const res = await fetch(`${CALENDAR_BASE}/${cal}/events/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    const text = await res.text();
    throw new Error(`deleteEvent failed (${res.status}): ${text}`);
  }
}

// ── Sync core (shared by /sync and /sync-all) ─────────────────────────────────

/**
 * Push one user's items to Google Calendar: process deletions, then upsert every
 * syncable task. Records last_sync_at / last_sync_error. Never throws — returns a
 * SyncResult (with `error` set on failure) so the cron path can continue.
 */
export async function syncUser(userId: string, timeZoneOverride?: string): Promise<SyncResult> {
  const db = serviceClient();
  const result: SyncResult = { created: 0, updated: 0, deleted: 0, skipped: 0 };

  const { data: cred, error: credErr } = await db
    .from("google_credentials")
    .select("refresh_token, calendar_id, time_zone")
    .eq("user_id", userId)
    .maybeSingle();
  if (credErr) {
    result.error = `Failed to load credentials: ${credErr.message}`;
    return result;
  }
  if (!cred) {
    result.error = "not_connected";
    return result;
  }

  const calendarId = cred.calendar_id || "primary";
  const timeZone = timeZoneOverride || cred.time_zone || "UTC";

  try {
    const accessToken = await refreshAccessToken(cred.refresh_token);

    // 1. Tombstones: remove locally-deleted events from Google.
    const { data: tombstones } = await db
      .from("google_deletions")
      .select("id, google_event_id")
      .eq("user_id", userId);
    for (const t of tombstones ?? []) {
      await deleteEvent(accessToken, calendarId, t.google_event_id);
      await db.from("google_deletions").delete().eq("id", t.id);
      result.deleted++;
    }

    // 2. Upsert syncable tasks.
    const { data: rows, error: rowsErr } = await db
      .from("tasks")
      .select(
        "id, user_id, title, subject, due_date, due_time, estimated_minutes, kind, start_at, end_at, all_day, location, recurrence_rule, google_event_id",
      )
      .eq("user_id", userId);
    if (rowsErr) throw new Error(`Failed to load tasks: ${rowsErr.message}`);

    for (const row of (rows ?? []) as TaskRow[]) {
      const body = itemToEvent(row, timeZone);
      if (!body) {
        result.skipped++;
        continue;
      }
      const eventId = await pushEvent(accessToken, calendarId, body, row.google_event_id);
      if (row.google_event_id) {
        result.updated++;
      } else {
        await db.from("tasks").update({ google_event_id: eventId }).eq("id", row.id);
        result.created++;
      }
    }

    await db
      .from("google_credentials")
      .update({ last_sync_at: new Date().toISOString(), last_sync_error: null, updated_at: new Date().toISOString() })
      .eq("user_id", userId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.error = message;
    await db
      .from("google_credentials")
      .update({ last_sync_error: message, updated_at: new Date().toISOString() })
      .eq("user_id", userId);
  }

  return result;
}
