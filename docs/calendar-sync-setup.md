# Google Calendar Sync — setup

LazyLoad syncs your tasks and events with your Google Calendar **both ways** (v5):
LazyLoad items push to Google, and events you add or edit directly in Google flow
back into LazyLoad. Sync runs on demand (the **Sync now** button in Settings, or
**Sync with Google Calendar** on the schedule) and in the background (an hourly
Vercel cron). The Google refresh token and client secret live only on the server;
the browser never sees them.

> Versions: v4.0 shipped push-only sync (LazyLoad → Google). **v5 adds the import
> direction** (Google → LazyLoad) and "newest edit wins" conflict resolution. The
> setup is unchanged — no new OAuth scope is needed (`calendar.events` already
> grants read access); just re-run the migration so the new columns exist.

This guide covers the one-time setup. Most of it is configuring credentials —
the code is already in place.

---

## 1. Run the database migration

Open the Supabase dashboard → **SQL Editor** → paste the full contents of
[`supabase-schema.sql`](../supabase-schema.sql) and run it. The file is additive
and idempotent (`if not exists` / `add column if not exists`), so re-running it
is safe. It adds:

- `tasks.google_event_id` — links each synced item to its Google event.
- `google_credentials` — one row per connected user (holds the refresh token).
- `google_deletions` — tombstones so locally-deleted items get removed from Google.
- a delete trigger that queues those tombstones.

**v5 (two-way) additions** — re-run the file to pick these up:

- `tasks.source` — `'google'` for events that first appeared on Google (shown with
  a **Google** badge), `'local'` for everything LazyLoad created.
- `tasks.updated_at` / `last_synced_at` / `google_synced_at` — the edit clock,
  reconcile marker, and remote watermark that drive "newest edit wins" without the
  app's own pushes echoing back. A `before update` trigger keeps `updated_at`
  current on every edit (and in lockstep with `last_synced_at` on sync writes).
- `google_credentials.sync_token` / `last_import_at` / `last_import_error` — the
  Google incremental sync token and import-side status.

**Verify the security model:** both new tables have RLS enabled with **no
policies**, which means the browser (anon/publishable key) is denied and only the
serverless functions (service-role key) can touch them. Confirm by running a
`select * from google_credentials` from a browser-key client — it should return
0 rows / be denied.

---

## 2. Google Cloud Console — OAuth client + scope

You must use the **same OAuth client** that Supabase's Google provider already
uses (otherwise the refresh token won't match).

1. Go to **APIs & Services → Credentials** and open that OAuth 2.0 client. Note
   the **Client ID** and **Client secret**.
2. **APIs & Services → Library** → enable the **Google Calendar API**.
3. **APIs & Services → OAuth consent screen** → under *Scopes*, add
   `https://www.googleapis.com/auth/calendar.events`.
4. If your consent screen is in *Testing*, add your Google account under *Test
   users*. (`calendar.events` is a sensitive scope; production use eventually
   needs Google verification.)

The authorized redirect URI in the OAuth client should already point at
Supabase's callback (`https://<project>.supabase.co/auth/v1/callback`) — leave it
as is.

---

## 3. Supabase — Google provider

In **Authentication → Providers → Google**, confirm the Client ID and Client
secret match the OAuth client above. No other change is needed; the
`access_type=offline` + `prompt=consent` parameters that force a refresh token
are sent by the app's `connectGoogleCalendar()` call.

---

## 4. Environment variables (Vercel)

Set these in **Vercel → Project → Settings → Environment Variables** (and in
`.env.local` for `vercel dev`). They are server-side only — do **not** prefix
them with `VITE_`. See [`.env.example`](../.env.example).

| Variable | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth client ID from step 2 |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret from step 2 |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role (secret) key from Supabase → Settings → API |
| `CRON_SECRET` | Any long random string (guards the cron endpoint) |

The hourly background sync is configured in [`vercel.json`](../vercel.json). Vercel
automatically sends `Authorization: Bearer <CRON_SECRET>` to the cron path once
`CRON_SECRET` is set.

---

## 5. Use it

1. Sign in, then go to **Settings → Google Calendar → Connect Google Calendar**.
2. Complete the Google consent screen (you'll be asked for calendar access).
3. Back on the Settings page you should see **Connected**. Behind the scenes the
   refresh token was stored via `/api/google/connect`.
4. Add an event and a dated task in LazyLoad, then click **Sync now** — both
   should appear on your Google Calendar. Edit one and re-sync: it updates in
   place (no duplicate). Delete one and re-sync: it disappears from Google.
5. Now create an event **in Google Calendar** and click **Sync now** again — it
   appears in LazyLoad's schedule with a **Google** badge. Edit it in Google → it
   updates here; delete it in Google → it disappears here.

### How items map to calendar entries

**Push (LazyLoad → Google):**

- **Events** → timed entries (`start_at`/`end_at`); all-day events become all-day
  entries; recurring events carry their `RRULE`.
- **Tasks with a due time** → a timed entry from the due time for
  `estimated_minutes` (default 30 min).
- **Tasks with only a due date** → an all-day entry on that date.
- **Tasks with no date** → skipped.

### Two-way sync (v5)

Each sync **imports first, then pushes**. The import side pulls only what changed
since the last run (Google's incremental sync token; the first run seeds a window
from ~today through the next ~12 months), so it stays cheap.

- **New Google events** become LazyLoad events (`source = 'google'`, shown with a
  **Google** badge). Recurring series import as a master with its `RRULE`;
  per-instance exceptions are not imported yet.
- **Edited / deleted Google events** update or remove the matching LazyLoad item.
- **Conflicts** (the same event changed in both places between syncs) resolve by
  **newest edit wins**. LazyLoad-origin items still round-trip via their stored
  `google_event_id`; an unchanged, already-synced item is touched by neither side,
  so there's no churn.
- Imported events are full two-way: editing or deleting one in LazyLoad propagates
  back to Google. Pushes use `PATCH` (merge), so fields LazyLoad doesn't model
  (attendees, colors, etc.) are preserved.

> Times follow the app's single-timezone assumption (browser timezone == the
> connected calendar's timezone), the same convention the rest of the schedule uses.

---

## Gmail deadline/event extraction (v4.1)

LazyLoad can also read your **recent inbox** and surface genuine deadlines and
events as **suggestions** for you to review. An hourly cron
([`/api/gmail/scan-all`](../api/gmail/scan-all.ts)) scans the last 7 days of inbox
mail and stages what it finds in `gmail_suggestions`; you then approve or dismiss
each item on the **Suggestions** screen (nothing reaches your schedule until you
approve it). A dedup ledger (`gmail_scanned_messages`) ensures each email is
processed only once. Connect/disconnect from **Settings → Gmail**.

Setup is the same OAuth client and env vars as Calendar — only two extra steps:

1. **Enable the Gmail API:** Google Cloud Console → **APIs & Services → Library** →
   enable **Gmail API**.
2. **Add the scope:** **OAuth consent screen → Scopes** → add
   `https://www.googleapis.com/auth/gmail.readonly`.

> ⚠️ **`gmail.readonly` is a Google _restricted_ scope** — stricter than the
> `calendar.events` sensitive scope. In *Testing* mode it works for listed test
> users. Taking it to production requires Google verification **plus** an annual
> third-party CASA security assessment. Keep the app in Testing (with yourself as a
> test user) unless you're prepared for that process.

Re-run [`supabase-schema.sql`](../supabase-schema.sql) (it now also creates
`gmail_credentials`, `gmail_scanned_messages`, and `gmail_suggestions`). No new env
vars — Gmail reuses the existing Google client, `SUPABASE_SERVICE_ROLE_KEY`, and
`CRON_SECRET`.

The Gmail refresh token is stored separately from the calendar token, so connecting
one never affects the other. Connect Gmail from Settings, then click **Scan inbox
now** to verify before the hourly cron takes over.

## Troubleshooting

- **"Google Calendar not connected" after connecting.** The refresh token is only
  returned on first consent. Disconnect, then reconnect — the app forces
  `prompt=consent` so Google re-issues it.
- **Sync error about token refresh.** Re-check `GOOGLE_CLIENT_ID` /
  `GOOGLE_CLIENT_SECRET` and that they match the Supabase provider's client.
- **Nothing happens in the background.** Confirm `CRON_SECRET` is set in Vercel
  and that the project plan allows crons. You can trigger it manually:
  `curl -H "Authorization: Bearer $CRON_SECRET" https://<your-app>/api/google/sync-all`.
- **Google events aren't importing.** Make sure you re-ran `supabase-schema.sql`
  after upgrading to v5 (the import side needs the new `tasks`/`google_credentials`
  columns). If imports stop after a long idle period, Google may have expired the
  stored `sync_token` (HTTP 410); the next sync detects this and automatically
  re-seeds a full forward window.
