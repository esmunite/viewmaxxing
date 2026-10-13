-- Content Rater schema — run once in Supabase → SQL Editor → New query.
-- Users themselves are handled by Supabase Auth (no users table needed).

-- Daily quota counters: one row per user per UTC day
create table if not exists usage (
  user_id text not null,
  day date not null,
  count integer not null default 0,
  primary key (user_id, day)
);

-- Saved grade reports
create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  created_at timestamptz not null default now(),
  brief jsonb not null default '{}'::jsonb,
  report jsonb not null default '{}'::jsonb
);
create index if not exists reports_user_idx on reports (user_id, created_at desc);

-- Row Level Security: the server uses the service-role key (bypasses RLS),
-- but these policies keep the anon key from reading anything directly.
alter table usage enable row level security;
alter table reports enable row level security;

drop policy if exists "users_own_usage" on usage;
create policy "users_own_usage" on usage
  for all using (auth.uid()::text = user_id) with check (auth.uid()::text = user_id);

drop policy if exists "users_own_reports" on reports;
create policy "users_own_reports" on reports
  for all using (auth.uid()::text = user_id) with check (auth.uid()::text = user_id);
