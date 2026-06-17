# Google Calendar Sync — setup

LazyLoad v4.0 can push your tasks and events into your Google Calendar. Sync is
**push-only** (LazyLoad → Google) and runs both on demand (the **Sync now**
button in Settings) and in the background (an hourly Vercel cron). The Google
refresh token and client secret live only on the server; the browser never sees
them.

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

### How items map to calendar entries

- **Events** → timed entries (`start_at`/`end_at`); all-day events become all-day
  entries; recurring events carry their `RRULE`.
- **Tasks with a due time** → a timed entry from the due time for
  `estimated_minutes` (default 30 min).
- **Tasks with only a due date** → an all-day entry on that date.
- **Tasks with no date** → skipped.

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
