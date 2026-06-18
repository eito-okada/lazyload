import { serviceClient } from "./_supabase";

// ── Types ────────────────────────────────────────────────────────────────────

type ItemKind = "task" | "event";

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

// The bookkeeping subset of a row needed to reconcile an import (see schema v5).
interface ReconcileRow {
  id: string;
  kind: string;
  google_event_id: string | null;
  updated_at: string | null; // local last-edit clock
  last_synced_at: string | null; // last push/import reconcile
  google_synced_at: string | null; // Google event.updated watermark
  source: string; // 'local' | 'google'
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

// An event as returned by events.list (the fields we read on import).
export interface GoogleEvent {
  id: string;
  status?: string; // 'confirmed' | 'tentative' | 'cancelled'
  summary?: string;
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  recurrence?: string[];
  recurringEventId?: string; // set on per-instance occurrences of a series
  updated?: string; // RFC3339 last-modified
  extendedProperties?: { private?: Record<string, string> };
}

export interface SyncResult {
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  error?: string;
}

export interface ImportResult {
  imported: number; // new external events created locally
  updatedLocal: number; // existing rows updated from Google
  deletedLocal: number; // rows removed because cancelled on Google
  skipped: number;
  error?: string;
}

export interface ReconcileResult extends SyncResult {
  imported: number;
  updatedLocal: number;
  deletedLocal: number;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3/calendars";
const DEFAULT_TASK_DURATION_MIN = 30;
const LIST_PAGE_SIZE = 250;
/** How far back/forward the initial (token-less) import seeds events. */
const IMPORT_PAST_MS = 24 * 60 * 60 * 1000; // 1 day
const IMPORT_FUTURE_MS = 365 * 24 * 60 * 60 * 1000; // ~12 months
/** Thrown by listEvents when an incremental sync token has expired (HTTP 410). */
const SYNC_TOKEN_EXPIRED = "SYNC_TOKEN_EXPIRED";

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

/**
 * Create (no existingId) or update (PATCH) an event. Returns the event id plus
 * its post-write `updated` timestamp — the watermark the import side stores so
 * this push doesn't later read back as a remote change (no ping-pong).
 */
export async function pushEvent(
  accessToken: string,
  calendarId: string,
  body: GoogleEventBody,
  existingId: string | null,
): Promise<{ id: string; updated: string | null }> {
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
  const json = (await res.json()) as { id?: string; updated?: string };
  if (!json.id) throw new Error("pushEvent returned no event id");
  return { id: json.id, updated: json.updated ?? null };
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

    // 2. Upsert syncable tasks. Push only rows that are new (no google_event_id)
    //    or locally edited since the last reconcile — an unchanged, already-synced
    //    row needs no work (and re-PATCHing it every hour would just churn Google's
    //    `updated` timestamp). After each push we store the returned `updated` as
    //    the watermark so the import side won't read it back as a remote change.
    const { data: rows, error: rowsErr } = await db
      .from("tasks")
      .select(
        "id, user_id, title, subject, due_date, due_time, estimated_minutes, kind, start_at, end_at, all_day, location, recurrence_rule, google_event_id, updated_at, last_synced_at",
      )
      .eq("user_id", userId);
    if (rowsErr) throw new Error(`Failed to load tasks: ${rowsErr.message}`);

    for (const row of (rows ?? []) as (TaskRow & {
      updated_at: string | null;
      last_synced_at: string | null;
    })[]) {
      if (row.google_event_id && !isLocallyDirty(row.updated_at, row.last_synced_at)) {
        result.skipped++;
        continue;
      }
      const body = itemToEvent(row, timeZone);
      if (!body) {
        result.skipped++;
        continue;
      }
      const pushed = await pushEvent(accessToken, calendarId, body, row.google_event_id);
      const syncedAt = new Date().toISOString();
      await db
        .from("tasks")
        .update({
          google_event_id: pushed.id,
          google_synced_at: pushed.updated ?? syncedAt,
          last_synced_at: syncedAt,
        })
        .eq("id", row.id);
      if (row.google_event_id) result.updated++;
      else result.created++;
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

// ── Mapping: Google event → LazyLoad row (import direction) ────────────────────

/** True when a row was edited locally since the last push/import reconcile. */
export function isLocallyDirty(updatedAt: string | null, lastSyncedAt: string | null): boolean {
  const updated = updatedAt ? Date.parse(updatedAt) : 0;
  const synced = lastSyncedAt ? Date.parse(lastSyncedAt) : 0;
  return updated > synced;
}

/** 'YYYY-MM-DDTHH:MM:SS' wall-clock of an instant as seen in `timeZone` (no offset). */
function wallClockInTimeZone(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour"); // some engines emit '24' for midnight
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}`;
}

/** Pull the RRULE line out of a Google `recurrence` array, prefix stripped. */
function extractRrule(recurrence: string[] | undefined): string | null {
  if (!recurrence) return null;
  for (const line of recurrence) {
    const m = line.match(/^RRULE:(.*)$/i);
    if (m) return m[1].trim();
  }
  return null;
}

/** Start instant (ms) of a Google event, or null. */
function eventStartMs(event: GoogleEvent): number | null {
  const iso = event.start?.dateTime ?? (event.start?.date ? `${event.start.date}T00:00:00Z` : null);
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Reverse of `itemToEvent`: build the columns to write for an imported event.
 * `kind` is the existing local row's kind (so a LazyLoad task we pushed as an
 * event maps Google's change back into deadline fields), or 'event' for a new
 * external event. Times are stored as floating local wall-clock (no offset),
 * exactly as the browser stores manually-created items, so they render
 * identically under the app's single-timezone assumption. Returns null if the
 * event has no resolvable start.
 */
export function eventToItem(event: GoogleEvent, kind: ItemKind, timeZone: string): Partial<TaskRow> | null {
  const title = (event.summary ?? "").trim() || "(untitled)";
  const isAllDay = !!event.start?.date && !event.start?.dateTime;

  if (kind === "task") {
    if (isAllDay) {
      const date = event.start?.date;
      if (!date) return null;
      return { title, kind: "task", due_date: date, due_time: null };
    }
    const startIso = event.start?.dateTime;
    if (!startIso) return null;
    const wc = wallClockInTimeZone(startIso, event.start?.timeZone || timeZone);
    const endIso = event.end?.dateTime;
    const minutes = endIso
      ? Math.max(0, Math.round((Date.parse(endIso) - Date.parse(startIso)) / 60_000))
      : null;
    return {
      title,
      kind: "task",
      due_date: wc.slice(0, 10),
      due_time: wc.slice(11, 16),
      ...(minutes ? { estimated_minutes: minutes } : {}),
    };
  }

  // Calendar event.
  const location = event.location ?? null;
  const recurrence_rule = extractRrule(event.recurrence);
  if (isAllDay) {
    const date = event.start?.date;
    if (!date) return null;
    // Google's all-day end.date is exclusive; store the inclusive last day at
    // 23:59 to mirror how ItemForm persists a manual all-day event.
    const endInclusive = event.end?.date ? addDaysToDate(event.end.date, -1) : date;
    return {
      title,
      kind: "event",
      all_day: true,
      start_at: `${date}T00:00:00`,
      end_at: `${endInclusive}T23:59:00`,
      location,
      recurrence_rule,
    };
  }
  const startIso = event.start?.dateTime;
  if (!startIso) return null;
  const endIso = event.end?.dateTime;
  return {
    title,
    kind: "event",
    all_day: false,
    start_at: wallClockInTimeZone(startIso, event.start?.timeZone || timeZone),
    end_at: endIso ? wallClockInTimeZone(endIso, event.end?.timeZone || timeZone) : null,
    location,
    recurrence_rule,
  };
}

// ── Reconcile decision (pure) ──────────────────────────────────────────────────

export type ImportAction = "create" | "apply-remote" | "delete-local" | "skip";

/**
 * Decide what to do with one Google event given the local row it maps to (if any):
 *   - cancelled on Google  → delete the local row (mirror the deletion).
 *   - no local row         → create it.
 *   - remotely unchanged    → skip (the push side handles any local edit).
 *   - remote changed, local clean → apply Google → local.
 *   - both changed (conflict)     → newest edit wins.
 */
export function decideImport(event: GoogleEvent, row: ReconcileRow | null): ImportAction {
  if (event.status === "cancelled") return row ? "delete-local" : "skip";
  if (!row) return "create";

  const remoteUpdated = event.updated ? Date.parse(event.updated) : 0;
  const watermark = row.google_synced_at ? Date.parse(row.google_synced_at) : 0;
  if (remoteUpdated <= watermark) return "skip"; // not remotely dirty

  if (!isLocallyDirty(row.updated_at, row.last_synced_at)) return "apply-remote";
  // Conflict: both sides moved since the last reconcile → newest wins.
  const localUpdated = row.updated_at ? Date.parse(row.updated_at) : 0;
  return remoteUpdated > localUpdated ? "apply-remote" : "skip";
}

// ── Import (pull) ───────────────────────────────────────────────────────────────

interface ListResult {
  events: GoogleEvent[];
  nextSyncToken: string | null;
}

/**
 * List events for import. With a sync token, returns only the changes since the
 * token was issued (including cancellations); otherwise seeds a forward window
 * (and Google returns a token for next time). Paginates fully. Throws
 * SYNC_TOKEN_EXPIRED on HTTP 410 so the caller can reseed.
 */
async function listEvents(
  accessToken: string,
  calendarId: string,
  opts: { syncToken: string } | { timeMin: string; timeMax: string },
): Promise<ListResult> {
  const cal = encodeURIComponent(calendarId);
  const events: GoogleEvent[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | null = null;
  do {
    const params = new URLSearchParams({ maxResults: String(LIST_PAGE_SIZE) });
    if ("syncToken" in opts) {
      // Incremental: send only the token (+ paging). Other filters must match the
      // request that issued the token, so we don't resend them.
      params.set("syncToken", opts.syncToken);
    } else {
      params.set("singleEvents", "false"); // import recurring masters, not instances
      params.set("timeMin", opts.timeMin);
      params.set("timeMax", opts.timeMax);
    }
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetch(`${CALENDAR_BASE}/${cal}/events?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 410) throw new Error(SYNC_TOKEN_EXPIRED);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`listEvents failed (${res.status}): ${text}`);
    }
    const json = (await res.json()) as {
      items?: GoogleEvent[];
      nextPageToken?: string;
      nextSyncToken?: string;
    };
    for (const it of json.items ?? []) events.push(it);
    pageToken = json.nextPageToken;
    if (json.nextSyncToken) nextSyncToken = json.nextSyncToken;
  } while (pageToken);
  return { events, nextSyncToken };
}

/**
 * Pull one user's Google Calendar changes into `tasks`. Incremental after the
 * first run (via the stored sync token); seeds a forward window otherwise. Never
 * throws — records last_import_at / last_import_error and returns an ImportResult.
 */
export async function importUser(userId: string, timeZoneOverride?: string): Promise<ImportResult> {
  const db = serviceClient();
  const result: ImportResult = { imported: 0, updatedLocal: 0, deletedLocal: 0, skipped: 0 };

  const { data: cred, error: credErr } = await db
    .from("google_credentials")
    .select("refresh_token, calendar_id, time_zone, sync_token")
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

    const seed = () => ({
      timeMin: new Date(Date.now() - IMPORT_PAST_MS).toISOString(),
      timeMax: new Date(Date.now() + IMPORT_FUTURE_MS).toISOString(),
    });

    let listing: ListResult;
    try {
      listing = cred.sync_token
        ? await listEvents(accessToken, calendarId, { syncToken: cred.sync_token })
        : await listEvents(accessToken, calendarId, seed());
    } catch (e) {
      if (e instanceof Error && e.message === SYNC_TOKEN_EXPIRED) {
        listing = await listEvents(accessToken, calendarId, seed());
      } else {
        throw e;
      }
    }

    // Index the user's already-mapped rows for matching.
    const { data: rows, error: rowsErr } = await db
      .from("tasks")
      .select("id, kind, google_event_id, updated_at, last_synced_at, google_synced_at, source")
      .eq("user_id", userId);
    if (rowsErr) throw new Error(`Failed to load tasks: ${rowsErr.message}`);
    const byEventId = new Map<string, ReconcileRow>();
    const byId = new Map<string, ReconcileRow>();
    for (const r of (rows ?? []) as ReconcileRow[]) {
      if (r.google_event_id) byEventId.set(r.google_event_id, r);
      byId.set(r.id, r);
    }

    const cutoff = Date.now() - IMPORT_PAST_MS;
    for (const ev of listing.events) {
      // Per-instance occurrences of a series are skipped — we mirror the master
      // (with its RRULE); per-instance exceptions are deferred.
      if (ev.recurringEventId) {
        result.skipped++;
        continue;
      }
      // Match by stored event id, falling back to the lazyloadId we stamp on every
      // event we create (covers a row whose push hadn't recorded the id yet).
      const lazyloadId = ev.extendedProperties?.private?.lazyloadId;
      const row = byEventId.get(ev.id) ?? (lazyloadId ? (byId.get(lazyloadId) ?? null) : null);

      const action = decideImport(ev, row);
      if (action === "skip") {
        result.skipped++;
        continue;
      }
      if (action === "delete-local") {
        await db.from("tasks").delete().eq("id", row!.id);
        result.deletedLocal++;
        continue;
      }
      if (action === "create") {
        // Honor the forward window: don't seed brand-new one-off events that have
        // already ended (incremental responses can include past edits).
        const startMs = eventStartMs(ev);
        if (!ev.recurrence && startMs !== null && startMs < cutoff) {
          result.skipped++;
          continue;
        }
        const mapped = eventToItem(ev, "event", timeZone);
        if (!mapped) {
          result.skipped++;
          continue;
        }
        const nowIso = new Date().toISOString();
        const { error } = await db.from("tasks").insert({
          user_id: userId,
          source: "google",
          priority: "medium",
          google_event_id: ev.id,
          google_synced_at: ev.updated ?? nowIso,
          // updated_at == last_synced_at on a fresh import → not "locally dirty",
          // so the push phase won't immediately send it back to Google.
          updated_at: nowIso,
          last_synced_at: nowIso,
          ...mapped,
        });
        if (error) throw new Error(`Failed to import event: ${error.message}`);
        result.imported++;
        continue;
      }

      // apply-remote
      const mapped = eventToItem(ev, row!.kind === "task" ? "task" : "event", timeZone);
      if (!mapped) {
        result.skipped++;
        continue;
      }
      const nowIso = new Date().toISOString();
      const { error } = await db
        .from("tasks")
        .update({ ...mapped, google_synced_at: ev.updated ?? nowIso, last_synced_at: nowIso })
        .eq("id", row!.id);
      if (error) throw new Error(`Failed to update imported event: ${error.message}`);
      result.updatedLocal++;
    }

    await db
      .from("google_credentials")
      .update({
        // Keep the prior token if a run somehow returned none.
        sync_token: listing.nextSyncToken ?? cred.sync_token ?? null,
        last_import_at: new Date().toISOString(),
        last_import_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.error = message;
    await db
      .from("google_credentials")
      .update({ last_import_error: message, updated_at: new Date().toISOString() })
      .eq("user_id", userId);
  }

  return result;
}

/**
 * Full two-way sync for one user: import remote changes first (so the local edits
 * we keep are then pushed up), then push. The single entry point for both the
 * manual /sync endpoint and the hourly /sync-all cron.
 */
export async function reconcileUser(userId: string, timeZoneOverride?: string): Promise<ReconcileResult> {
  const imp = await importUser(userId, timeZoneOverride);
  if (imp.error === "not_connected") {
    return {
      created: 0,
      updated: 0,
      deleted: 0,
      skipped: 0,
      imported: 0,
      updatedLocal: 0,
      deletedLocal: 0,
      error: "not_connected",
    };
  }
  const push = await syncUser(userId, timeZoneOverride);
  return {
    ...push,
    imported: imp.imported,
    updatedLocal: imp.updatedLocal,
    deletedLocal: imp.deletedLocal,
    error: push.error ?? imp.error,
  };
}
