// Local checks for the v5 two-way Google Calendar sync mapping + reconcile logic.
// These exercise the PURE functions in api/_google.ts (no network / DB), the same
// way scripts/extract.ts exercises the real extractor without Vercel.
//
//   npm run test:google
//
// Exits non-zero if any assertion fails, so it's usable as a quick gate.
import {
  eventToItem,
  decideImport,
  isLocallyDirty,
  type GoogleEvent,
} from "../api/_google";

let passed = 0;
let failed = 0;

function eq(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.error(`✗ ${label}\n    expected ${e}\n    actual   ${a}`);
  }
}

// ── isLocallyDirty ─────────────────────────────────────────────────────────────
eq("dirty: edited after sync", isLocallyDirty("2026-06-17T10:00:00Z", "2026-06-17T09:00:00Z"), true);
eq("dirty: synced after edit", isLocallyDirty("2026-06-17T09:00:00Z", "2026-06-17T10:00:00Z"), false);
eq("dirty: equal", isLocallyDirty("2026-06-17T09:00:00Z", "2026-06-17T09:00:00Z"), false);
eq("dirty: never synced", isLocallyDirty("2026-06-17T09:00:00Z", null), true);
eq("dirty: both null", isLocallyDirty(null, null), false);

// ── eventToItem: timed event (offset/timezone-independent of test machine) ──────
const timed: GoogleEvent = {
  id: "e1",
  status: "confirmed",
  summary: "Meeting",
  location: "Room 1",
  start: { dateTime: "2026-06-17T13:00:00Z", timeZone: "America/New_York" }, // 09:00 EDT
  end: { dateTime: "2026-06-17T14:00:00Z", timeZone: "America/New_York" },
  updated: "2026-06-17T12:00:00Z",
};
eq("event: timed", eventToItem(timed, "event", "UTC"), {
  title: "Meeting",
  kind: "event",
  all_day: false,
  start_at: "2026-06-17T09:00:00",
  end_at: "2026-06-17T10:00:00",
  location: "Room 1",
  recurrence_rule: null,
});

// ── eventToItem: all-day event (Google end.date is exclusive) ───────────────────
const allDay: GoogleEvent = {
  id: "e2",
  status: "confirmed",
  summary: "Holiday",
  start: { date: "2026-07-04" },
  end: { date: "2026-07-05" },
  updated: "2026-06-01T00:00:00Z",
};
eq("event: all-day", eventToItem(allDay, "event", "UTC"), {
  title: "Holiday",
  kind: "event",
  all_day: true,
  start_at: "2026-07-04T00:00:00",
  end_at: "2026-07-04T23:59:00",
  location: null,
  recurrence_rule: null,
});

// ── eventToItem: recurring master → RRULE on one row ────────────────────────────
const recurring: GoogleEvent = {
  id: "e3",
  status: "confirmed",
  summary: "Standup",
  start: { dateTime: "2026-06-17T13:00:00Z", timeZone: "UTC" },
  end: { dateTime: "2026-06-17T13:15:00Z", timeZone: "UTC" },
  recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR", "EXDATE:20260619T130000Z"],
  updated: "2026-06-17T12:00:00Z",
};
eq("event: recurring rule", eventToItem(recurring, "event", "UTC")?.recurrence_rule, "FREQ=WEEKLY;BYDAY=MO,WE,FR");

// ── eventToItem: a LazyLoad TASK pushed as an event maps back to deadline fields ─
const task: GoogleEvent = {
  id: "e4",
  status: "confirmed",
  summary: "Essay",
  start: { dateTime: "2026-06-17T13:00:00Z", timeZone: "UTC" },
  end: { dateTime: "2026-06-17T14:30:00Z", timeZone: "UTC" },
  updated: "2026-06-17T12:00:00Z",
};
eq("task: timed", eventToItem(task, "task", "UTC"), {
  title: "Essay",
  kind: "task",
  due_date: "2026-06-17",
  due_time: "13:00",
  estimated_minutes: 90,
});

const taskAllDay: GoogleEvent = {
  id: "e5",
  status: "confirmed",
  summary: "Project due",
  start: { date: "2026-06-20" },
  end: { date: "2026-06-21" },
  updated: "2026-06-17T12:00:00Z",
};
eq("task: date-only", eventToItem(taskAllDay, "task", "UTC"), {
  title: "Project due",
  kind: "task",
  due_date: "2026-06-20",
  due_time: null,
});

// ── decideImport ────────────────────────────────────────────────────────────────
const baseRow = {
  id: "r1",
  kind: "event",
  google_event_id: "e1",
  updated_at: "2026-06-17T09:00:00Z",
  last_synced_at: "2026-06-17T09:00:00Z",
  google_synced_at: "2026-06-17T09:00:00Z",
  source: "google",
};
const cancelled: GoogleEvent = { id: "e1", status: "cancelled" };
const confirmed = (updated: string): GoogleEvent => ({ id: "e1", status: "confirmed", updated });

eq("decide: cancelled + row", decideImport(cancelled, baseRow), "delete-local");
eq("decide: cancelled, no row", decideImport(cancelled, null), "skip");
eq("decide: new external", decideImport(confirmed("2026-06-17T12:00:00Z"), null), "create");
// remote not changed since watermark → skip
eq("decide: remote clean", decideImport(confirmed("2026-06-17T09:00:00Z"), baseRow), "skip");
// remote changed, local clean → apply
eq("decide: remote dirty only", decideImport(confirmed("2026-06-17T11:00:00Z"), baseRow), "apply-remote");
// conflict, remote newer → apply
eq(
  "decide: conflict remote-newer",
  decideImport(confirmed("2026-06-17T11:00:00Z"), { ...baseRow, updated_at: "2026-06-17T10:00:00Z" }),
  "apply-remote",
);
// conflict, local newer → skip (push side wins)
eq(
  "decide: conflict local-newer",
  decideImport(confirmed("2026-06-17T11:00:00Z"), { ...baseRow, updated_at: "2026-06-17T12:00:00Z" }),
  "skip",
);

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
