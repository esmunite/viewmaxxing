-- BennettIQ async jobs — run once in Supabase → SQL Editor → New query.
-- One row per grading job: the "ticket" the app polls while the grade runs
-- in the background. The server uses the service-role key (bypasses RLS);
-- the policy below keeps the public anon key from reading anything directly,
-- same pattern as the usage and reports tables.

create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status text not null default 'queued',  -- queued | running | done | failed
  brief jsonb not null default '{}'::jsonb,
  frames jsonb,          -- upload payload; wiped when the job finishes
  audio_b64 text,        -- upload payload; wiped when the job finishes
  audio_format text,
  report jsonb,          -- the finished grade (also saved to reports)
  transcript text,
  error text
);
create index if not exists jobs_user_idx on jobs (user_id, created_at desc);
create index if not exists jobs_status_idx on jobs (status, created_at);

alter table jobs enable row level security;

drop policy if exists "users_own_jobs" on jobs;
create policy "users_own_jobs" on jobs
  for all using (auth.uid()::text = user_id) with check (auth.uid()::text = user_id);
