-- Hustl update 2.9 (Hustl AI; daily tasks, reminder alarms, push): run once in Supabase → SQL Editor → New query → Run. Safe to run again.
-- Adds: daily tasks; "Important Reminders" with a date and time (alarms), synced between your devices; the device list for
-- notifications that arrive even when Hustl is closed; and live updates for tasks and the streak.
-- (Already in supabase.sql for new projects. The every-30-seconds schedule is in supabase-push-schedule.sql.)


-- Daily tasks: a daily task comes back every day until removed; any other task belongs to one day
-- (the "day" it was added for) and is cleared after that day.
alter table public.tasks add column if not exists daily boolean not null default false;
alter table public.tasks add column if not exists day date;


-- ---------------------------------------------------------------------
-- HUSTL AI — how many assistant messages each person sent today (the "ai" Edge Function enforces a daily limit).
-- Only the server function (service key) can use this; the app has no access.
-- ---------------------------------------------------------------------
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day     date not null,
  count   integer not null default 0,
  primary key (user_id, day)
);
alter table public.ai_usage enable row level security;
revoke all on public.ai_usage from anon, authenticated;

-- Counts one message for today (UTC) and returns the new count, or null when the limit is already reached.
create or replace function public.ai_take_message(p_user uuid, p_limit integer)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  insert into public.ai_usage as u (user_id, day, count) values (p_user, (now() at time zone 'utc')::date, 1)
  on conflict (user_id, day) do update set count = u.count + 1
    where u.count < p_limit
  returning u.count into n;
  delete from public.ai_usage where day < (now() at time zone 'utc')::date - 7;   -- keep a week
  return n;
end $$;
revoke all on function public.ai_take_message(uuid, integer) from public, anon, authenticated;
grant execute on function public.ai_take_message(uuid, integer) to service_role;

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


-- ---------------------------------------------------------------------
-- PUSH — devices that get reminder alarms even when Hustl is closed (Web Push).
-- The app saves its device through save_push_subscription(); only the "push" Edge Function
-- (server side, service key) reads this table. pushed_at stops a reminder going out twice.
-- ---------------------------------------------------------------------
alter table public.alarms add column if not exists pushed_at timestamptz;

create table if not exists public.push_subscriptions (
  endpoint   text primary key,                       -- the browser's push address (unique per device + browser)
  user_id    uuid not null references auth.users (id) on delete cascade,
  p256dh     text not null,
  auth       text not null,
  tz         text,                                   -- so the notification shows the person's own time
  user_agent text,
  updated_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);
alter table public.push_subscriptions enable row level security;   -- no policies: no direct access from the app
revoke all on public.push_subscriptions from anon, authenticated;

create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_tz text, p_user_agent text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_endpoint !~ '^https://' or char_length(p_endpoint) > 1000
     or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then
    raise exception 'invalid subscription' using errcode = '22023';
  end if;
  -- the device now belongs to whoever is signed in on it
  insert into public.push_subscriptions (endpoint, user_id, p256dh, auth, tz, user_agent, updated_at)
  values (p_endpoint, auth.uid(), left(p_p256dh, 200), left(p_auth, 100), left(p_tz, 64), left(p_user_agent, 200), now())
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
        tz = excluded.tz, user_agent = excluded.user_agent, updated_at = now();
  -- keep at most 10 devices per person (drop the oldest)
  delete from public.push_subscriptions where endpoint in (
    select endpoint from public.push_subscriptions where user_id = auth.uid() order by updated_at desc offset 10);
end $$;

create or replace function public.remove_push_subscription(p_endpoint text)
returns void language sql security definer set search_path = public as $$
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
$$;
revoke all on function public.save_push_subscription(text, text, text, text, text) from public, anon;
revoke all on function public.remove_push_subscription(text) from public, anon;
grant execute on function public.save_push_subscription(text, text, text, text, text) to authenticated;
grant execute on function public.remove_push_subscription(text) to authenticated;

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
