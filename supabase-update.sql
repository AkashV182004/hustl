-- Hustl update 2.4 (Daily Track page): run once in Supabase → SQL Editor → New query → Run. Safe to run again.
-- Adds: Top Priorities (a priority flag on tasks) and synced Notes & Ideas / Important Reminders.
-- (Already included in supabase.sql for new projects.)

-- Top Priorities on the Daily Track page: a task can be marked as a priority.
alter table public.tasks add column if not exists priority boolean not null default false;

-- ---------------------------------------------------------------------
-- NOTES — the Daily Track page's "Notes & Ideas" and "Important Reminders" (one of each per person).
-- Synced like tasks: last write wins by updated_at.
-- ---------------------------------------------------------------------
create table if not exists public.notes (
  user_id           uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind              text not null check (kind in ('notes', 'reminders')),
  body              text not null default '' check (char_length(body) <= 5000),
  updated_at        timestamptz not null,
  server_updated_at timestamptz not null default clock_timestamp(),
  primary key (user_id, kind)
);

create or replace function public.notes_before_write()
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
drop trigger if exists notes_before_write on public.notes;
create trigger notes_before_write before insert or update on public.notes
  for each row execute function public.notes_before_write();

-- notes: only your own
alter table public.notes enable row level security;
drop policy if exists "notes: own rows" on public.notes;
create policy "notes: own rows" on public.notes for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

do $$ begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notes') then
    alter publication supabase_realtime add table public.notes;
  end if;
end $$;

notify pgrst, 'reload schema';
