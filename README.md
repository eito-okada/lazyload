# LazyLoad

**Snap it. Plan it.** Take a photo of any worksheet, syllabus, Canvas page, or
screen — LazyLoad uses AI to turn it into a clean, editable schedule of tasks
and calendar events in seconds.

## For judges — what this is

**The problem:** students juggle assignments scattered across Canvas, Google
Classroom, email, paper handouts, and screenshots. Manually re-typing each one
into a planner is the exact friction that makes people stop planning.

**The idea:** point your camera (or drop a screenshot) at *whatever* shows your
work — LazyLoad reads it, extracts the assignments with due dates, and builds a
realistic schedule around your actual free time.

**The 60-second demo flow:**
1. **Capture** — upload or photograph a screenshot of assignments.
2. **Extract** — Gemini vision reads it and returns structured tasks (title,
   due date, estimated effort) which you review and fix on the **Review** page.
3. **Schedule** — LazyLoad slots tasks into your working hours and shows a
   **Today** / week / month view; smart **Suggestions** propose when to actually
   do each one.
4. **Sync** — two-way Google Calendar sync and Gmail scanning pull in events and
   surface assignment emails automatically (nightly cron), so the plan stays
   current without manual entry.

**What's built (v1 → v7):**
- 📸 Screenshot **and live camera** extraction via Gemini (vision + structured output)
- ✅ Review/edit flow, manual task entry, recurring items
- 🗓️ Custom calendar with Today / Upcoming / Month views and a workload rail
- 🤖 Smart scheduling that fits tasks into your configured working hours
- 🔁 **Two-way Google Calendar sync** (import + reconcile)
- 📧 **Gmail extraction** — scans for assignment emails and turns them into tasks
- 🔐 Supabase auth with Row Level Security; cross-device working-hours preferences
- ⏰ Nightly Vercel cron jobs for calendar + Gmail sync

**Stack:** Vite + React 19 + TypeScript on the frontend; Vercel serverless
functions for the AI extraction, scheduling, and Google/Gmail integrations;
Supabase (Postgres + auth + RLS) for storage; Gemini API for the AI.

## Run it locally

**Prerequisites:** Node 18+ and npm.

```sh
npm install
cp .env.example .env   # then fill in the keys below
```

### Quickest path — UI only, no API keys (mock data)

Great for seeing the interface without setting anything up:

```sh
VITE_USE_MOCK=true npm run dev      # http://localhost:5173
```

This serves the full UI with built-in mock tasks — no Gemini, Supabase, or
Google credentials required.

### Full app — real extraction + serverless functions

The plain Vite dev server does **not** run the `/api` functions. Use Vercel's
dev server, which serves the frontend and the serverless functions together:

```sh
npm i -g vercel
vercel dev                          # http://localhost:3000
```

For full functionality you'll need, in `.env`:

| Var | Side | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | backend | Gemini API key — powers extraction. Free tier available, see below. |
| `EXTRACT_MODEL` | backend | Optional. Override the model (defaults to `gemini-3.5-flash`). |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | frontend | Supabase project (use the **publishable** key — it ships in the bundle; RLS protects data). |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | backend | Service-role key for the server functions. **Secret.** |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | backend | Google OAuth client for Calendar + Gmail sync. **Secret.** |
| `CRON_SECRET` | backend | Shared secret guarding the cron sync endpoints. |

Calendar/Gmail are optional — the core capture → review → schedule loop works
with just `GEMINI_API_KEY` and the Supabase vars. See
[.env.example](.env.example) for full notes and
[docs/calendar-sync-setup.md](docs/calendar-sync-setup.md) for Google setup.

Get a Gemini key at
[aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) —
`gemini-3.5-flash` has a (rate-limited) free tier and is the default. No payment
method required to start.

### Fastest feedback on extraction — no browser needed

Run the real extraction against an image file straight from the CLI:

```sh
npm run extract -- path/to/screenshot.png

# try a different model on the same image (see ai.google.dev/gemini-api/docs/models):
EXTRACT_MODEL=gemini-3.1-pro-preview npm run extract -- path/to/screenshot.png
```

It prints the extracted tasks as JSON plus the model used and elapsed time, and
reads `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) from your environment or `.env`.

### Build

```sh
npm run build
```

## Project layout

```
api/
  extract.ts          serverless HTTP handler for screenshot extraction
  _extract-core.ts    shared Gemini extraction logic (vision + structured output)
  plan.ts             smart scheduling endpoint
  _plan-core.ts       scheduling logic (fits tasks into working hours)
  google/             two-way Google Calendar sync (incl. sync-all cron)
  gmail/              Gmail scanning -> tasks (incl. scan-all cron)
  _google.ts _gmail.ts _supabase.ts   shared integration helpers
scripts/
  extract.ts          local CLI extraction tester (reuses _extract-core)
  test-google-sync.ts / test-plan.ts  integration test scripts
src/
  pages/              Home, Login, Today, Upload, Review, Schedule,
                      Inbox, Suggestions, AddItem, Settings
  components/         Navbar, calendar views, task/item UI, RequireAuth
  context/            shared task + auth state
  services/           API client (mock-aware)
  lib/ types/         Supabase client, task/event types
supabase-schema.sql   database schema + RLS policies
```
