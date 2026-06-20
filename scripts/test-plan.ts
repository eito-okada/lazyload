// Local checks for the v7 deterministic planner logic in src/lib/schedule.ts:
// breaks between sessions, urgency-weighted ordering, spaced split + packing
// fallback, planning around fixed blocks, and stale-timed-task detection.
// These exercise the PURE functions only (no network / DB), like
// scripts/test-google-sync.ts.
//
//   npm run test:plan
//
// Exits non-zero if any assertion fails, so it's usable as a quick gate.
import {
  planAhead,
  stalePlannedTasks,
  inProgressTasks,
  parseDue,
  parsePlanned,
  parseStart,
  parseEnd,
  isValidPlacement,
  conflictedPlannedTasks,
  conflictingEvents,
  workloadBuckets,
  weeklyLoad,
  splitSessionTitle,
  parseSplitSession,
  type Interval,
} from "../src/lib/schedule";
import { startOfWeek } from "date-fns";
import {
  buildBriefing,
  completionNudge,
  estimateBiasNudge,
  formatDuration,
  greeting,
  overduePlanNote,
  pickFocus,
} from "../src/lib/coach";
import { DEFAULT_WORKING_HOURS, type WorkingHours } from "../src/lib/preferences";
import type { Task } from "../src/types/Task";
import { addDays, format, isSameDay, differenceInMinutes } from "date-fns";

let passed = 0;
let failed = 0;

function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`✗ ${label}${detail ? `\n    ${detail}` : ""}`);
  }
}

const ymd = (d: Date) => format(d, "yyyy-MM-dd");

// A fixed "today" so the assertions are deterministic regardless of run time.
// 09:00 on a Monday well clear of the work block's end, all-day-free weekend ahead.
const NOW = new Date(2026, 5, 15, 9, 0, 0); // Mon 2026-06-15 09:00 local

// Free all day, no work block, generous caps — isolates the placement logic.
const prefs = (over: Partial<WorkingHours> = {}): WorkingHours => ({
  ...DEFAULT_WORKING_HOURS,
  workdays: [],
  dayStart: "00:00",
  dayEnd: "23:59",
  maxPerDayMinutes: 600,
  sessionMinutes: 90,
  breakMinutes: 15,
  spaceSessions: true,
  deepWorkEarly: true,
  ...over,
});

let seq = 0;
function task(over: Partial<Task>): Task {
  return { id: `t${++seq}`, title: over.title ?? `Task ${seq}`, kind: "task", ...over };
}

// ── Breaks between sessions ─────────────────────────────────────────────────────
// Two 60-min tasks due today, 15-min break → second starts 75 min after the first.
{
  const due = ymd(NOW);
  const tasks = [
    task({ title: "A", dueDate: due, estimatedMinutes: 60, priority: "high" }),
    task({ title: "B", dueDate: due, estimatedMinutes: 60, priority: "high" }),
  ];
  const plan = planAhead(tasks, NOW, prefs({ breakMinutes: 15 }), { split: false });
  check("breaks: both placed", plan.blocks.length === 2, JSON.stringify(plan.unplaced.map((t) => t.title)));
  if (plan.blocks.length === 2) {
    const [a, b] = plan.blocks;
    const gapMin = differenceInMinutes(b.start, a.end);
    check("breaks: 15-min gap between sessions", gapMin === 15, `gap was ${gapMin}min`);
  }

  // With no break the second should start exactly when the first ends.
  const noBreak = planAhead(tasks, NOW, prefs({ breakMinutes: 0 }), { split: false });
  const back2back = differenceInMinutes(noBreak.blocks[1].start, noBreak.blocks[0].end);
  check("breaks: 0-min break is back-to-back", back2back === 0, `gap was ${back2back}min`);
}

// ── Urgency-weighted ordering ────────────────────────────────────────────────────
// When two tasks share the same deadline, the larger one (240 min) should be
// scheduled first — it needs more runway. Deadline still dominates: a task due
// tomorrow always beats a task due next week regardless of size.
{
  const tasks = [
    task({ title: "Small", dueDate: ymd(addDays(NOW, 3)), estimatedMinutes: 60 }),
    task({ title: "Large", dueDate: ymd(addDays(NOW, 3)), estimatedMinutes: 240 }),
  ];
  // Capacity for 240 min on day 0, so only Large fits; Small spills to day 1.
  const plan = planAhead(tasks, NOW, prefs({ maxPerDayMinutes: 240 }), { split: false });
  const firstOnDay0 = plan.blocks.find((b) => isSameDay(b.start, NOW));
  check(
    "urgency: larger task with same deadline is scheduled first",
    firstOnDay0?.task.title === "Large",
    `day-0 task was ${firstOnDay0?.task.title}`,
  );
}

// ── Spaced split: one session per day across days up to the deadline ─────────────
{
  // 180 min of work, 60-min sessions, due in 4 days → spread one session/day.
  const t = task({ title: "BigStudy", dueDate: ymd(addDays(NOW, 4)), estimatedMinutes: 180, priority: "medium" });
  const plan = planAhead([t], NOW, prefs({ sessionMinutes: 60, spaceSessions: true }), { split: true });
  check("spaced: 3 sessions laid", plan.blocks.length === 3, `got ${plan.blocks.length}`);
  const distinctDays = new Set(plan.blocks.map((b) => ymd(b.start)));
  check("spaced: sessions on distinct days", distinctDays.size === plan.blocks.length, `${distinctDays.size} distinct days`);
  check("spaced: parts numbered 1..3", plan.blocks.every((b, i) => b.part?.index === i + 1), JSON.stringify(plan.blocks.map((b) => b.part)));
  check("spaced: nothing unplaced", plan.unplaced.length === 0);
}

// ── Packing fallback: deadline too close to spread → multiple sessions same day ───
{
  // 180 min, 60-min sessions, due TODAY → must pack into day 0 (can't spread).
  const t = task({ title: "Cram", dueDate: ymd(NOW), estimatedMinutes: 180, priority: "high" });
  const plan = planAhead([t], NOW, prefs({ sessionMinutes: 60, spaceSessions: true }), { split: true });
  const onDay0 = plan.blocks.filter((b) => isSameDay(b.start, NOW));
  check("packing: all sessions fall on the due day", onDay0.length === plan.blocks.length && plan.blocks.length >= 3, `${onDay0.length}/${plan.blocks.length} on day0`);
  check("packing: fully scheduled (nothing unplaced)", plan.unplaced.length === 0);
}

// ── Planning around fixed (locked) blocks ────────────────────────────────────────
{
  const due = ymd(NOW);
  // Lock 09:00–12:00 today; a 60-min task must land at/after 12:00.
  const fixed: Interval[] = [
    { start: new Date(2026, 5, 15, 9, 0), end: new Date(2026, 5, 15, 12, 0) },
  ];
  const t = task({ title: "Around", dueDate: due, estimatedMinutes: 60, priority: "high" });
  const plan = planAhead([t], NOW, prefs(), { split: false, fixed });
  const block = plan.blocks[0];
  check("fixed: task placed", !!block, "no block placed");
  if (block) {
    // The planner may use free time before OR after the lock; it just must not overlap it.
    const overlaps = block.start < fixed[0].end && block.end > fixed[0].start;
    check("fixed: does not overlap the locked interval", !overlaps, `block ${block.start.toISOString()}–${block.end.toISOString()}`);
  }
}

// ── Candidate selection: deadline vs. planned session ────────────────────────────
// v8: a task is plannable when it has a DEADLINE and no planned session yet — even
// if that deadline carries a specific time. A task already given a planned session
// is left alone (not re-planned).
{
  const tasks = [
    task({ title: "DeadlineWithTime", dueDate: ymd(NOW), dueTime: "17:00", estimatedMinutes: 60, priority: "high" }),
    task({ title: "AlreadyPlanned", dueDate: ymd(NOW), plannedDate: ymd(NOW), plannedStart: "20:00", plannedMinutes: 60 }),
  ];
  const plan = planAhead(tasks, NOW, prefs(), { split: false });
  const titles = plan.blocks.map((b) => b.task.title);
  check("candidates: deadline-with-time task is planned", titles.includes("DeadlineWithTime"), JSON.stringify(titles));
  check("candidates: already-planned task is not re-planned", !titles.includes("AlreadyPlanned"), JSON.stringify(titles));
}

// ── Planned sessions block time (planner schedules around them) ──────────────────
// A task already planned 09:00–11:00 today must not be overlapped by a fresh
// candidate placed the same day (deadlines are points; planned sessions are spans).
{
  const planned = task({
    title: "Pinned",
    dueDate: ymd(addDays(NOW, 3)),
    plannedDate: ymd(NOW),
    plannedStart: "09:00",
    plannedMinutes: 120,
  });
  const fresh = task({ title: "Fresh", dueDate: ymd(NOW), estimatedMinutes: 60, priority: "high" });
  const plan = planAhead([planned, fresh], NOW, prefs(), { split: false });
  const block = plan.blocks.find((b) => b.task.title === "Fresh");
  const session = parsePlanned(planned)!;
  check("planned-busy: fresh task placed", !!block);
  if (block) {
    const overlaps = block.start < session.end && block.end > session.start;
    check("planned-busy: does not overlap an existing planned session", !overlaps, `block ${block.start.toISOString()}–${block.end.toISOString()}`);
  }
}

// ── stalePlannedTasks ────────────────────────────────────────────────────────────
{
  const items: Task[] = [
    task({ title: "MissedSession", dueDate: ymd(addDays(NOW, 2)), plannedDate: ymd(NOW), plannedStart: "08:00" }), // before NOW (09:00)
    task({ title: "LaterToday", dueDate: ymd(addDays(NOW, 2)), plannedDate: ymd(NOW), plannedStart: "14:00" }), // future
    task({ title: "DoneMissed", dueDate: ymd(NOW), plannedDate: ymd(NOW), plannedStart: "07:00", done: true }), // done → excluded
    task({ title: "Unplanned", dueDate: ymd(NOW) }), // no session → not stale
  ];
  const stale = stalePlannedTasks(items, NOW).map((t) => t.title);
  check("stale: only the missed planned session", JSON.stringify(stale) === JSON.stringify(["MissedSession"]), JSON.stringify(stale));
}

// ── started tasks are "in progress", not "slipped" ──────────────────────────────
{
  const items: Task[] = [
    task({ title: "Working", dueDate: ymd(addDays(NOW, 2)), plannedDate: ymd(NOW), plannedStart: "08:00", startedAt: new Date(NOW.getTime() - 20 * 60_000).toISOString() }),
    task({ title: "Slipped", dueDate: ymd(addDays(NOW, 2)), plannedDate: ymd(NOW), plannedStart: "08:00" }),
    task({ title: "DoneStarted", plannedDate: ymd(NOW), plannedStart: "07:00", startedAt: new Date(NOW).toISOString(), done: true }),
  ];
  const stale = stalePlannedTasks(items, NOW).map((t) => t.title);
  check("inProgress: a started session isn't flagged as slipped", !stale.includes("Working"), JSON.stringify(stale));
  check("inProgress: an unstarted past session still slips", stale.includes("Slipped"));
  const live = inProgressTasks(items).map((t) => t.title);
  check("inProgress: lists started, not-done tasks", JSON.stringify(live) === JSON.stringify(["Working"]), JSON.stringify(live));
}

// Event times are floating wall-clock: a UTC-tagged round-trip from the
// timestamptz column ("…+00:00") must still read back as the same wall time, not
// shift by the browser/runtime offset. 2:00 PM stays 2:00 PM on the 17th.
{
  const evt = task({ kind: "event", startAt: "2026-06-17T14:00:00+00:00", endAt: "2026-06-17T15:30:00+00:00" });
  const s = parseStart(evt);
  const e = parseEnd(evt);
  check("event: start reads as floating wall-clock", s?.getHours() === 14 && s?.getMinutes() === 0, String(s));
  check("event: keeps the calendar day", s ? ymd(s) === "2026-06-17" : false, s ? ymd(s) : "null");
  check("event: end reads as floating wall-clock", e?.getHours() === 15 && e?.getMinutes() === 30, String(e));
  // A bare local string (no offset, as ItemForm submits) parses identically.
  check("event: bare local string matches", parseStart(task({ kind: "event", startAt: "2026-06-17T14:00" }))?.getHours() === 14);
}

// ── conflictedPlannedTasks: committed work that now sits under an event ──────────
{
  const planned = task({
    title: "Hackathon work",
    dueDate: ymd(addDays(NOW, 1)),
    plannedDate: ymd(NOW), plannedStart: "16:45", plannedMinutes: 360, // 16:45–22:45
  });
  const clearTask = task({
    title: "Clear work",
    dueDate: ymd(addDays(NOW, 1)),
    plannedDate: ymd(NOW), plannedStart: "08:00", plannedMinutes: 60, // 08:00–09:00, no event
  });
  const game = task({ kind: "event", title: "carp vs yakult", startAt: `${ymd(NOW)}T17:30`, endAt: `${ymd(NOW)}T22:00` });
  const allDay = task({ kind: "event", title: "Holiday", allDay: true, startAt: `${ymd(NOW)}T00:00`, endAt: `${ymd(NOW)}T23:59` });
  const titles = conflictedPlannedTasks([planned, clearTask, game, allDay]).map((t) => t.title);
  check("conflict: flags the session overlapping the event", titles.includes("Hackathon work"), JSON.stringify(titles));
  check("conflict: leaves a clear session alone", !titles.includes("Clear work"), JSON.stringify(titles));
  check("conflict: an all-day event never causes a clash", conflictedPlannedTasks([clearTask, allDay]).length === 0);

  // Two work sessions booked at the same time — a double-book you can't actually do.
  const calcA = task({
    title: "Calculus 8.8a",
    dueDate: ymd(addDays(NOW, 1)),
    plannedDate: ymd(NOW), plannedStart: "16:00", plannedMinutes: 60, // 16:00–17:00
  });
  const calcB = task({
    title: "Hackathon block",
    dueDate: ymd(addDays(NOW, 1)),
    plannedDate: ymd(NOW), plannedStart: "16:00", plannedMinutes: 90, // 16:00–17:30, overlaps calcA
  });
  const dbl = conflictedPlannedTasks([calcA, calcB, clearTask]).map((t) => t.title);
  check("conflict: flags both sides of a session-vs-session double-book", dbl.includes("Calculus 8.8a") && dbl.includes("Hackathon block"), JSON.stringify(dbl));
  check("conflict: a non-overlapping session is not flagged as a double-book", !dbl.includes("Clear work"), JSON.stringify(dbl));
  // Back-to-back sessions (touching, not overlapping) don't count as a clash.
  const after = task({
    title: "After",
    dueDate: ymd(addDays(NOW, 1)),
    plannedDate: ymd(NOW), plannedStart: "17:00", plannedMinutes: 60, // 17:00–18:00, abuts calcA
  });
  check("conflict: back-to-back sessions don't clash", conflictedPlannedTasks([calcA, after]).length === 0);
}

// ── workloadBuckets: the "Everything left" rail's grouping ──────────────────────
{
  const items = [
    task({ title: "Overdue", dueDate: ymd(addDays(NOW, -1)), estimatedMinutes: 30 }),
    task({ title: "Today", dueDate: ymd(NOW) }), // no estimate → 60 default
    task({ title: "ThisWeek", dueDate: ymd(addDays(NOW, 3)), estimatedMinutes: 45 }),
    task({ title: "Later", dueDate: ymd(addDays(NOW, 20)), estimatedMinutes: 90 }),
    task({ title: "Undated" }), // no due date
    task({ title: "Done", dueDate: ymd(NOW), done: true }), // excluded: completed
    task({ title: "Event", kind: "event", startAt: `${ymd(NOW)}T10:00`, endAt: `${ymd(NOW)}T11:00` }), // excluded: not a task
  ];
  const groups = workloadBuckets(items, NOW);
  const ids = groups.map((g) => g.id).join(",");
  check("workload: 5 non-empty buckets in fixed order", ids === "overdue,today,week,later,undated", ids);
  const byId = new Map(groups.map((g) => [g.id, g]));
  check("workload: overdue task lands in overdue", byId.get("overdue")?.tasks[0]?.title === "Overdue");
  check("workload: due-today task lands in today", byId.get("today")?.tasks[0]?.title === "Today");
  check("workload: within-a-week task lands in week", byId.get("week")?.tasks[0]?.title === "ThisWeek");
  check("workload: far-off task lands in later", byId.get("later")?.tasks[0]?.title === "Later");
  check("workload: undated task lands in No date", byId.get("undated")?.tasks[0]?.title === "Undated");
  check("workload: completed tasks are excluded", !groups.some((g) => g.tasks.some((t) => t.title === "Done")));
  check("workload: events are excluded", !groups.some((g) => g.tasks.some((t) => t.title === "Event")));
  check("workload: totalMinutes uses the estimate", byId.get("overdue")?.totalMinutes === 30);
  check("workload: totalMinutes defaults to 60 when unset", byId.get("today")?.totalMinutes === 60);
  check("workload: empty input → no groups", workloadBuckets([], NOW).length === 0);

  // Within a bucket, dated tasks sort by soonest due first.
  const twoToday = workloadBuckets(
    [
      task({ title: "Sooner", dueDate: ymd(addDays(NOW, 2)) }),
      task({ title: "Later wk", dueDate: ymd(addDays(NOW, 5)) }),
    ],
    NOW,
  );
  check("workload: within a bucket, soonest due is first", twoToday[0]?.tasks[0]?.title === "Sooner");
}

// ── weeklyLoad: the week-at-a-glance load strip (#2) ────────────────────────────
{
  const weekStart = startOfWeek(NOW); // Sun 2026-06-14 (week containing Mon the 15th)
  const empty = weeklyLoad([], weekStart, prefs());
  check("weeklyLoad: returns 7 days", empty.length === 7, String(empty.length));
  check("weeklyLoad: first day is the week start", isSameDay(empty[0].day, weekStart));
  check("weeklyLoad: an empty week books nothing", empty.every((d) => d.committedMinutes === 0 && !d.over));
  // prefs() opens the whole day (00:00–23:59) with no work block → 1439 free minutes,
  // NOT capped by maxPerDayMinutes (that's the planner's focus budget, not availability).
  check("weeklyLoad: free time is the open window, uncapped", empty.every((d) => d.freeMinutes === 1439), String(empty[0]?.freeMinutes));

  // A 2h event + a 1h work session on Monday → 180 committed that one day.
  const mon = ymd(NOW); // 2026-06-15 (a Monday)
  const items = [
    task({ kind: "event", title: "Game", startAt: `${mon}T18:00`, endAt: `${mon}T20:00` }), // 120
    task({ title: "Essay", dueDate: ymd(addDays(NOW, 2)), plannedDate: mon, plannedStart: "20:00", plannedMinutes: 60 }), // 60, abuts the event
  ];
  const load = weeklyLoad(items, weekStart, prefs());
  const monday = load.find((d) => isSameDay(d.day, NOW))!;
  check("weeklyLoad: sums events + work sessions on the day", monday.committedMinutes === 180, String(monday.committedMinutes));
  check("weeklyLoad: only the booked day carries load", load.filter((d) => d.committedMinutes > 0).length === 1);

  // Overlapping commitments are merged (union), not double-counted.
  const overlap = [
    task({ kind: "event", title: "A", startAt: `${mon}T18:00`, endAt: `${mon}T20:00` }), // 18–20
    task({ kind: "event", title: "B", startAt: `${mon}T19:00`, endAt: `${mon}T21:00` }), // 19–21 → union 18–21 = 180
  ];
  const merged = weeklyLoad(overlap, weekStart, prefs()).find((d) => isSameDay(d.day, NOW))!;
  check("weeklyLoad: overlapping commitments are merged", merged.committedMinutes === 180, String(merged.committedMinutes));

  // A narrow open window (60 min/day) makes the 180-min Monday exceed it → over;
  // empty days with the same 60-min window aren't flagged.
  const tight = weeklyLoad(items, weekStart, prefs({ dayStart: "19:00", dayEnd: "20:00" }));
  const tightMon = tight.find((d) => isSameDay(d.day, NOW))!;
  check("weeklyLoad: flags a day booked past its free time", tightMon.over && tightMon.freeMinutes === 60, JSON.stringify(tightMon));
  check("weeklyLoad: only the over-booked day is flagged", tight.filter((d) => d.over).length === 1);

  // All-day events don't block specific hours, so they add no committed minutes.
  const allDay = [task({ kind: "event", title: "Holiday", allDay: true, startAt: `${mon}T00:00`, endAt: `${mon}T23:59` })];
  const holiday = weeklyLoad(allDay, weekStart, prefs()).find((d) => isSameDay(d.day, NOW))!;
  check("weeklyLoad: all-day events add no committed time", holiday.committedMinutes === 0, String(holiday.committedMinutes));
}

// Sanity: parseDue round-trips a date+time, and parsePlanned a session.
check("parseDue: resolves date+time", parseDue(task({ dueDate: "2026-06-15", dueTime: "08:00" }))?.getHours() === 8);
check(
  "parsePlanned: resolves a planned session span",
  parsePlanned(task({ plannedDate: "2026-06-15", plannedStart: "20:00", plannedMinutes: 90 }))?.start.getHours() === 20,
);

// ── isValidPlacement: shared rule for the plan preview + live timeline drag ───────
{
  const at = (h: number, m = 0) => new Date(2026, 5, 15, h, m, 0);
  // Free all day (no work block). A 60-min slot mid-morning is valid.
  check("placement: fits a free window", isValidPlacement({ start: at(10), end: at(11) }, [], prefs()));
  // Zero/negative spans are never valid.
  check("placement: rejects non-positive span", !isValidPlacement({ start: at(10), end: at(10) }, [], prefs()));
  // A timed event makes its hour busy → an overlapping placement is rejected.
  const evt = task({ kind: "event", startAt: "2026-06-15T10:00", endAt: "2026-06-15T11:00" });
  check("placement: rejects overlap with an event", !isValidPlacement({ start: at(10, 30), end: at(11, 30) }, [evt], prefs()));
  check("placement: allows a slot clear of the event", isValidPlacement({ start: at(12), end: at(13) }, [evt], prefs()));
  // extraBusy (e.g. a sibling preview block) is honoured too.
  check(
    "placement: rejects overlap with extraBusy",
    !isValidPlacement({ start: at(14), end: at(15) }, [], prefs(), [{ start: at(14, 30), end: at(15, 30) }]),
  );
}

// ── coach.formatDuration ──────────────────────────────────────────────────────────
check("duration: 90 → 1h 30m", formatDuration(90) === "1h 30m", formatDuration(90));
check("duration: 60 → 1h", formatDuration(60) === "1h", formatDuration(60));
check("duration: 45 → 45m", formatDuration(45) === "45m", formatDuration(45));
check("duration: 0 → 0m", formatDuration(0) === "0m", formatDuration(0));

// ── coach.greeting ─────────────────────────────────────────────────────────────────
const atHour = (h: number) => new Date(2026, 5, 15, h, 0, 0);
check("greeting: morning", greeting(atHour(8)) === "Good morning", greeting(atHour(8)));
check("greeting: afternoon", greeting(atHour(13)) === "Good afternoon", greeting(atHour(13)));
check("greeting: evening", greeting(atHour(20)) === "Good evening", greeting(atHour(20)));

// ── coach.buildBriefing ────────────────────────────────────────────────────────────
{
  const today = new Date();
  const now = new Date();
  // Every task done → celebratory line (today).
  const done = buildBriefing({ day: today, now, sessionCount: 0, eventCount: 0, focusMinutes: 0, progress: { total: 2, done: 2 } });
  check("briefing: celebrates a cleared day", /every task done/i.test(done), done);

  // A future day with planned work names the shape + total focus time.
  const ahead = buildBriefing({
    day: addDays(today, 2), now,
    sessionCount: 2, eventCount: 0, focusMinutes: 180, progress: { total: 2, done: 0 },
  });
  check("briefing: counts focus blocks", /2 focus blocks/.test(ahead), ahead);
  check("briefing: states total focus time", /3h/.test(ahead), ahead);

  // An empty future day invites planning rather than going silent.
  const openDay = buildBriefing({
    day: addDays(today, 3), now,
    sessionCount: 0, eventCount: 0, focusMinutes: 0, progress: { total: 0, done: 0 },
  });
  check("briefing: open day is non-empty + inviting", openDay.length > 0 && /open/i.test(openDay), openDay);
}

// ── coach.pickFocus: in-progress beats upcoming; nothing past returns null ──────────
{
  const span = (h: number, dur: number) => ({ start: new Date(2026, 5, 15, h, 0), end: new Date(2026, 5, 15, h + dur, 0) });
  const now = new Date(2026, 5, 15, 10, 30);
  const entries = [span(9, 1), span(10, 2), span(14, 1)]; // 9–10 past, 10–12 in progress, 14–15 future
  const cur = pickFocus(entries, now);
  check("focus: surfaces the in-progress block", cur?.state === "now" && cur.entry.start.getHours() === 10, JSON.stringify(cur?.state));
  // After everything for the morning, the next upcoming block is chosen.
  const later = pickFocus([span(14, 1)], new Date(2026, 5, 15, 12, 0));
  check("focus: falls back to the next upcoming block", later?.state === "next" && later.entry.start.getHours() === 14);
  // Nothing ahead → null.
  check("focus: null when nothing remains", pickFocus([span(9, 1)], new Date(2026, 5, 15, 23, 0)) === null);
}

// ── conflictingEvents: two commitments booked over each other (#9) ───────────────
{
  const range = (days: number) => addDays(NOW, days);
  const start = new Date(2026, 5, 14); // Sun, day before NOW — covers the whole window
  const end = range(14);

  const meeting = task({ kind: "event", title: "Advisor meeting", startAt: `${ymd(NOW)}T14:00`, endAt: `${ymd(NOW)}T15:00` });
  const overlap = task({ kind: "event", title: "Lab section", startAt: `${ymd(NOW)}T14:30`, endAt: `${ymd(NOW)}T16:00` });
  const clear = task({ kind: "event", title: "Dinner", startAt: `${ymd(NOW)}T18:00`, endAt: `${ymd(NOW)}T19:00` });
  const allDay = task({ kind: "event", title: "Holiday", allDay: true, startAt: `${ymd(NOW)}T00:00`, endAt: `${ymd(NOW)}T23:59` });

  const titles = conflictingEvents([meeting, overlap, clear, allDay], start, end).map((t) => t.title);
  check("eventConflicts: flags both sides of an overlap", titles.includes("Advisor meeting") && titles.includes("Lab section"), JSON.stringify(titles));
  check("eventConflicts: leaves a non-overlapping event alone", !titles.includes("Dinner"), JSON.stringify(titles));
  check("eventConflicts: an all-day event never clashes", !titles.includes("Holiday"), JSON.stringify(titles));
  check("eventConflicts: earliest-starting clashing event is first", titles[0] === "Advisor meeting", JSON.stringify(titles));

  // Back-to-back events (touching, not overlapping) don't count.
  const back = task({ kind: "event", title: "After", startAt: `${ymd(NOW)}T15:00`, endAt: `${ymd(NOW)}T16:00` });
  check("eventConflicts: back-to-back events don't clash", conflictingEvents([meeting, back], start, end).length === 0);

  // Each event is returned once even if it overlaps several others (dedup by id).
  const wide = task({ kind: "event", title: "All-afternoon", startAt: `${ymd(NOW)}T13:00`, endAt: `${ymd(NOW)}T17:00` });
  const deduped = conflictingEvents([wide, meeting, overlap], start, end).filter((t) => t.title === "All-afternoon");
  check("eventConflicts: each event appears once despite multiple overlaps", deduped.length === 1, String(deduped.length));

  // Tasks (work sessions) are not events, so they never appear here.
  const session = task({ title: "Essay", dueDate: ymd(addDays(NOW, 1)), plannedDate: ymd(NOW), plannedStart: "14:15", plannedMinutes: 60 });
  check("eventConflicts: ignores task work sessions", conflictingEvents([meeting, session], start, end).every((t) => t.title !== "Essay"));
}

// ── coach.overduePlanNote (#1) ──────────────────────────────────────────────────
check("overdueNote: empty when nothing overdue", overduePlanNote(0) === "", overduePlanNote(0));
check("overdueNote: singular", overduePlanNote(1) === "Includes 1 overdue task, pulled in for today.", overduePlanNote(1));
check("overdueNote: plural", overduePlanNote(3) === "Includes 3 overdue tasks, pulled in for today.", overduePlanNote(3));

// ── coach.completionNudge (#3) ──────────────────────────────────────────────────
check("nudge: clears slate when nothing remains", /everything cleared/i.test(completionNudge(0, null)), completionNudge(0, null));
check("nudge: names what's left + next up", completionNudge(2, "Physics set") === "Nice — 2 tasks left. Next up: Physics set.", completionNudge(2, "Physics set"));
check("nudge: singular remaining", completionNudge(1, null) === "Nice — 1 task left.", completionNudge(1, null));
check("nudge: omits next when none given", !/Next up/.test(completionNudge(2, null)), completionNudge(2, null));

// ── coach.estimateBiasNudge (#8) ─────────────────────────────────────────────────
const over = [
  { estimated: 60, actual: 90 },
  { estimated: 30, actual: 50 },
  { estimated: 45, actual: 60 },
]; // median ratio 1.5 / 1.33 / 1.5 → 1.5
check("bias: too few samples → null", estimateBiasNudge(over.slice(0, 2)) === null);
check("bias: consistent overrun flags + names subject",
  /longer than estimated/.test(estimateBiasNudge(over, "Physics") ?? "") &&
    /your Physics tasks/.test(estimateBiasNudge(over, "Physics") ?? ""),
  estimateBiasNudge(over, "Physics") ?? "null");
check("bias: overrun reports a sensible percent",
  /50% longer/.test(estimateBiasNudge(over) ?? ""), estimateBiasNudge(over) ?? "null");
check("bias: on-target estimates stay quiet",
  estimateBiasNudge([
    { estimated: 60, actual: 60 },
    { estimated: 30, actual: 33 },
    { estimated: 45, actual: 40 },
  ]) === null);
check("bias: consistent under-run suggests trimming",
  /less time than estimated/.test(
    estimateBiasNudge([
      { estimated: 60, actual: 30 },
      { estimated: 30, actual: 15 },
      { estimated: 40, actual: 20 },
    ]) ?? "",
  ));
check("bias: ignores samples missing a value",
  estimateBiasNudge([
    { estimated: 0, actual: 90 },
    { estimated: 60, actual: 0 },
    { estimated: 45, actual: 60 },
  ]) === null);

// ── split-session titles round-trip (duration-learning guard) ────────────────────
check("split: builds the session label", splitSessionTitle("Lab report", 2, 3) === "Lab report — session 2 of 3", splitSessionTitle("Lab report", 2, 3));
check("split: plain titles aren't sessions", parseSplitSession("Lab report") === null);
{
  const parsed = parseSplitSession(splitSessionTitle("Lab report", 2, 3));
  check("split: parses index + count", parsed?.index === 2 && parsed?.count === 3, JSON.stringify(parsed));
  check("split: recovers the parent's base title", parsed?.base === "Lab report", parsed?.base);
}
check("split: detects the final session", parseSplitSession("Essay — session 3 of 3")?.index === 3);
check("split: a title that merely mentions 'session' isn't one", parseSplitSession("Plan the session") === null);

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
