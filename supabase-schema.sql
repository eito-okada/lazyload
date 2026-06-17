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

create policy "Users can view their own imports"
  on imports for select
  using (auth.uid() = user_id);

create policy "Users can create their own imports"
  on imports for insert
  with check (auth.uid() = user_id);

create policy "Users can delete their own imports"
  on imports for delete
  using (auth.uid() = user_id);

create policy "Users can view their own tasks"
  on tasks for select
  using (auth.uid() = user_id);

create policy "Users can create their own tasks"
  on tasks for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own tasks"
  on tasks for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete their own tasks"
  on tasks for delete
  using (auth.uid() = user_id);
