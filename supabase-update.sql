-- Hustl update 2.5 (reminder alarms): run once in Supabase → SQL Editor → New query → Run. Safe to run again.
-- Adds: "Important Reminders" with a date and time (alarms), synced between your devices,
-- plus live updates for tasks and the streak if they aren't on yet. (Already in supabase.sql for new projects.)

-- ---------------------------------------------------------------------
-- ALARMS — "Important Reminders" with a date and time. Synced like tasks: last write wins by updated_at.
-- ---------------------------------------------------------------------
create table if not exists public.alarms (
  id                uuid primary key,
  user_id           uuid not null default auth.uid() references auth.users (id) on delete cascade,
  text              text not null check (char_length(text) between 1 and 200),
  due_at            timestamptz not null,
  done_at           timestamptz,
  deleted           boolean not null default false,
  updated_at        timestamptz not null,
  server_updated_at timestamptz not null default clock_timestamp()
);
create index if not exists alarms_user_idx on public.alarms (user_id);

create or replace function public.alarms_before_write()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.updated_at < old.updated_at then
      return null;               -- an older edit arrived late: keep the newer one
    end if;
    new.user_id := old.user_id;
  end if;
  new.server_updated_at := clock_timestamp();
  return new;
end $$;
drop trigger if exists alarms_before_write on public.alarms;
create trigger alarms_before_write before insert or update on public.alarms
  for each row execute function public.alarms_before_write();

-- alarms: only your own
alter table public.alarms enable row level security;
drop policy if exists "alarms: own rows" on public.alarms;
create policy "alarms: own rows" on public.alarms for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

do $$ begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'alarms') then
    alter publication supabase_realtime add table public.alarms;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tasks') then
    alter publication supabase_realtime add table public.tasks;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'completion_log') then
    alter publication supabase_realtime add table public.completion_log;
  end if;
end $$;

notify pgrst, 'reload schema';
