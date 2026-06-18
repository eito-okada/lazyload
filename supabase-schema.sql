-- Run this once in the Supabase SQL editor (Project > SQL Editor > New query).
-- Creates the tasks/imports tables with Row Level Security so each user can
-- only ever see or modify their own rows — this is what makes it safe to
-- call Supabase directly from the browser with the publishable key.

create table if not exists imports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_note text,
  created_at timestamptz not null default now()
);

-- The `tasks` table holds both homework tasks AND calendar events (kind column).
-- Tasks use due_date/due_time (deadline semantics); events use start_at/end_at
-- (a span), optionally recurring via an RFC-5545 recurrence_rule string.
create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  import_id uuid references imports(id) on delete cascade,
  title text not null,
  subject text,
  due_date date,
  due_time time,
  estimated_minutes integer,
  priority text not null default 'medium' check (priority in ('high', 'medium', 'low')),
  done boolean not null default false,
  kind text not null default 'task' check (kind in ('task', 'event')),
  start_at timestamptz,
  end_at timestamptz,
  all_day boolean not null default false,
  location text,
  recurrence_rule text,
  created_at timestamptz not null default now()
);

-- For databases provisioned before the event columns existed, add them in place.
-- (The create table above only runs for fresh installs because of "if not exists".)
alter table tasks add column if not exists kind text not null default 'task'
  check (kind in ('task', 'event'));
alter table tasks add column if not exists start_at timestamptz;
alter table tasks add column if not exists end_at timestamptz;
alter table tasks add column if not exists all_day boolean not null default false;
alter table tasks add column if not exists location text;
alter table tasks add column if not exists recurrence_rule text;

create index if not exists tasks_user_due_idx on tasks (user_id, due_date);
create index if not exists tasks_user_start_idx on tasks (user_id, start_at);
create index if not exists tasks_import_idx on tasks (import_id);

alter table imports enable row level security;
alter table tasks enable row level security;

-- Each policy scopes every row to its owner via auth.uid(). Without these,
-- enabling RLS would lock everyone out by default (the safe failure mode).

drop policy if exists "Users can view their own imports" on imports;
create policy "Users can view their own imports"
  on imports for select
  using (auth.uid() = user_id);

drop policy if exists "Users can create their own imports" on imports;
create policy "Users can create their own imports"
  on imports for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own imports" on imports;
create policy "Users can delete their own imports"
  on imports for delete
  using (auth.uid() = user_id);

drop policy if exists "Users can view their own tasks" on tasks;
create policy "Users can view their own tasks"
  on tasks for select
  using (auth.uid() = user_id);

drop policy if exists "Users can create their own tasks" on tasks;
create policy "Users can create their own tasks"
  on tasks for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own tasks" on tasks;
create policy "Users can update their own tasks"
  on tasks for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own tasks" on tasks;
create policy "Users can delete their own tasks"
  on tasks for delete
  using (auth.uid() = user_id);

-- ───────────────────────────────────────────────────────────────────────────
-- Google Calendar sync (v4.0)
--
-- Push-only sync (LazyLoad → Google Calendar). The refresh token and client
-- secret must never reach the browser, so the credential/tombstone tables below
-- are SERVICE-ROLE ONLY: RLS is enabled with no policies, which denies every
-- browser request (the service-role key used by the serverless functions
-- bypasses RLS). Same safe-failure pattern as the policies above, inverted.
-- ───────────────────────────────────────────────────────────────────────────

-- Each synced task remembers the Google event it maps to, so re-syncing updates
-- the same event in place instead of creating duplicates.
alter table tasks add column if not exists google_event_id text;

-- One row per connected user. Holds the long-lived Google refresh token used by
-- the serverless functions to mint short-lived access tokens for the Calendar API.
create table if not exists google_credentials (
  user_id uuid primary key references auth.users(id) on delete cascade,
  refresh_token text not null,
  calendar_id text not null default 'primary',
  time_zone text,
  last_sync_at timestamptz,
  last_sync_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Tombstones: when a task with a google_event_id is deleted locally, we record
-- the orphaned Google event id here so the next sync can remove it from Google.
create table if not exists google_deletions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  google_event_id text not null,
  created_at timestamptz not null default now()
);

create index if not exists google_deletions_user_idx on google_deletions (user_id);

-- Fires on direct task deletes AND on cascade deletes (e.g. removing an import),
-- so any path that drops a synced task queues its Google event for removal.
-- security definer lets the trigger insert into the service-role-only tombstone
-- table even though it runs in the deleting user's (RLS-bound) context.
create or replace function queue_google_deletion() returns trigger
  language plpgsql security definer as $$
begin
  if old.google_event_id is not null then
    insert into google_deletions(user_id, google_event_id)
    values (old.user_id, old.google_event_id);
  end if;
  return old;
end $$;

drop trigger if exists tasks_google_deletion on tasks;
create trigger tasks_google_deletion after delete on tasks
  for each row execute function queue_google_deletion();

-- RLS on, no policies → browser denied, service role bypasses.
alter table google_credentials enable row level security;
alter table google_deletions enable row level security;

-- ───────────────────────────────────────────────────────────────────────────
-- Gmail deadline/event extraction (v4.1)
--
-- An hourly cron reads the user's recent inbox via the Gmail API and turns
-- genuine deadlines/events into tasks. The Gmail refresh token is SERVICE-ROLE
-- ONLY (same pattern as google_credentials): RLS on, no policies. It is stored
-- separately from the calendar refresh token so the two scopes never collide.
-- ───────────────────────────────────────────────────────────────────────────

-- One row per Gmail-connected user. Holds the gmail.readonly refresh token used
-- by the serverless functions to mint access tokens for the Gmail API.
create table if not exists gmail_credentials (
  user_id uuid primary key references auth.users(id) on delete cascade,
  refresh_token text not null,
  last_scan_at timestamptz,
  last_scan_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Dedup ledger: every Gmail message we've already processed, so a given email is
-- only ever turned into tasks once (the scan runs hourly over an overlapping
-- 7-day window).
create table if not exists gmail_scanned_messages (
  user_id uuid not null references auth.users(id) on delete cascade,
  message_id text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, message_id)
);

-- RLS on, no policies → browser denied, service role bypasses.
alter table gmail_credentials enable row level security;
alter table gmail_scanned_messages enable row level security;

-- Staged suggestions awaiting the user's review. The scan (cron or manual) writes
-- here via the service role instead of straight into `tasks`; the user then
-- approves (→ a real task) or dismisses each one from the Suggestions screen.
-- Unlike the credential tables, this holds no secrets and is per-user content, so
-- it gets normal owner RLS policies (same pattern as `tasks`) — the browser reads
-- and deletes its own rows directly with the publishable key.
create table if not exists gmail_suggestions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  message_id text not null,
  -- Source email context, shown next to the suggestion so the user can confirm
  -- the extraction is correct (and deep-link to the message in Gmail).
  email_from text,
  email_subject text,
  email_snippet text,
  title text not null,
  subject text,
  priority text not null default 'medium' check (priority in ('high', 'medium', 'low')),
  kind text not null default 'task' check (kind in ('task', 'event')),
  due_date date,
  due_time time,
  estimated_minutes integer,
  start_at timestamptz,
  end_at timestamptz,
  all_day boolean not null default false,
  location text,
  created_at timestamptz not null default now()
);

-- For tables provisioned before the email-context columns existed, add in place.
alter table gmail_suggestions add column if not exists email_from text;
alter table gmail_suggestions add column if not exists email_subject text;
alter table gmail_suggestions add column if not exists email_snippet text;

create index if not exists gmail_suggestions_user_idx on gmail_suggestions (user_id);

alter table gmail_suggestions enable row level security;

drop policy if exists "Users can view their own gmail suggestions" on gmail_suggestions;
create policy "Users can view their own gmail suggestions"
  on gmail_suggestions for select
  using (auth.uid() = user_id);

drop policy if exists "Users can delete their own gmail suggestions" on gmail_suggestions;
create policy "Users can delete their own gmail suggestions"
  on gmail_suggestions for delete
  using (auth.uid() = user_id);

-- ───────────────────────────────────────────────────────────────────────────
-- Two-way Google Calendar sync (v5)
--
-- v4.0 was push-only (LazyLoad → Google). v5 also imports: events created or
-- edited directly in Google flow back into `tasks`, and conflicts resolve by
-- "newest edit wins". That needs three pieces of bookkeeping per task plus an
-- incremental sync token per user.
--
--   * source           — 'google' for events that first appeared on Google (shown
--                         with a "Google" badge); 'local' for everything LazyLoad
--                         created, even after it has been pushed up.
--   * updated_at        — local last-edit clock, bumped by the trigger below on
--                         EVERY update, so every client edit path is covered for
--                         free (no service/UI changes needed).
--   * last_synced_at    — set to now() whenever we push OR import a row. A row is
--                         "locally dirty" when updated_at > last_synced_at.
--   * google_synced_at  — the Google event's `updated` timestamp at the last time
--                         we reconciled it (set on both push and import). A row is
--                         "remotely dirty" when event.updated > google_synced_at.
--                         Storing the post-push value is what stops our own hourly
--                         push from echoing back as a remote change (no ping-pong).
-- ───────────────────────────────────────────────────────────────────────────

alter table tasks add column if not exists source text not null default 'local'
  check (source in ('local', 'google'));
alter table tasks add column if not exists updated_at timestamptz not null default now();
alter table tasks add column if not exists last_synced_at timestamptz;
alter table tasks add column if not exists google_synced_at timestamptz;

-- Maintain updated_at so it reflects genuine *edits*, not sync bookkeeping. A
-- sync write (push or import) sets last_synced_at; we keep updated_at in lockstep
-- with it so the row is not seen as "locally dirty" right after we reconcile it
-- (which would otherwise trigger a needless re-push). Any other update is a real
-- edit, so updated_at jumps to now() and the row becomes locally dirty until the
-- next push catches it up.
create or replace function set_tasks_updated_at() returns trigger
  language plpgsql as $$
begin
  if new.last_synced_at is distinct from old.last_synced_at then
    new.updated_at := new.last_synced_at;
  else
    new.updated_at := now();
  end if;
  return new;
end $$;

drop trigger if exists tasks_set_updated_at on tasks;
create trigger tasks_set_updated_at before update on tasks
  for each row execute function set_tasks_updated_at();

create index if not exists tasks_user_google_event_idx on tasks (user_id, google_event_id);

-- Per-user incremental sync state for the import direction. sync_token is
-- Google's events.list nextSyncToken (null → next import seeds a full forward
-- window); last_import_at / last_import_error mirror the push-side fields.
alter table google_credentials add column if not exists sync_token text;
alter table google_credentials add column if not exists last_import_at timestamptz;
alter table google_credentials add column if not exists last_import_error text;

-- ───────────────────────────────────────────────────────────────────────────
-- Cross-device working hours (v6)
--
-- Moves the auto-scheduling preferences (WorkingHours) from browser localStorage
-- to a Supabase row so they follow the user across devices. Normal owner RLS
-- (browser reads/writes its own row with the publishable key). The client
-- continues to use localStorage as an instant-read cache; the DB is the source
-- of truth when multiple devices are in play.
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists user_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  working_hours jsonb,
  updated_at timestamptz not null default now()
);

alter table user_preferences enable row level security;

drop policy if exists "Users can view their own preferences" on user_preferences;
create policy "Users can view their own preferences"
  on user_preferences for select
  using (auth.uid() = user_id);

drop policy if exists "Users can upsert their own preferences" on user_preferences;
create policy "Users can upsert their own preferences"
  on user_preferences for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own preferences" on user_preferences;
create policy "Users can update their own preferences"
  on user_preferences for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
