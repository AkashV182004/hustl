-- =====================================================================
-- Hustl — Supabase schema, Row Level Security and storage policies.
-- Run this whole file once in Supabase → SQL Editor → New query → Run.
-- It is safe to run again (everything is "create if not exists" / replace).
-- =====================================================================


-- ---------------------------------------------------------------------
-- PROFILES — one per user, with a public "User ID" handle like vinyl-fox-4821
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  handle       text not null unique check (handle ~ '^[a-z]+-[a-z]+-[0-9]{4}$'),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 40),
  created_at   timestamptz not null default now()
);

-- Creates a profile with a random, unique handle for the given user (no-op if one exists).
create or replace function public.create_profile_for(uid uuid)
returns public.profiles
language plpgsql security definer set search_path = public as $$
declare
  adj  text[] := array['vinyl','velvet','amber','mellow','groovy','golden','dusty','smoky','electric','acoustic','cosmic','funky','silver','lucky','quiet','wild','rosy','misty','sunny','jazzy'];
  noun text[] := array['fox','owl','tiger','raven','otter','lynx','sparrow','wolf','heron','badger','falcon','panda','whale','moth','hare','crane','finch','bison','koala','gecko'];
  a text; n text; p public.profiles; tries int := 0;
begin
  select * into p from public.profiles where id = uid;
  if found then return p; end if;
  loop
    a := adj[1 + floor(random() * array_length(adj, 1))::int];
    n := noun[1 + floor(random() * array_length(noun, 1))::int];
    begin
      insert into public.profiles (id, handle, display_name)
      values (uid, a || '-' || n || '-' || lpad(floor(random() * 10000)::int::text, 4, '0'), initcap(a || ' ' || n))
      returning * into p;
      return p;
    exception when unique_violation then
      tries := tries + 1;
      if tries > 25 then raise; end if;
    end;
  end loop;
end $$;
revoke all on function public.create_profile_for(uuid) from public, anon, authenticated;

-- New sign-ups get a profile automatically (named after their username, if they have one).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.create_profile_for(new.id);
  if coalesce(new.raw_user_meta_data ->> 'username', '') <> '' then
    update public.profiles set display_name = new.raw_user_meta_data ->> 'username' where id = new.id;
  end if;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- The app calls this after login so users created before this file was run also get a profile.
create or replace function public.ensure_profile()
returns public.profiles language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  return public.create_profile_for(auth.uid());
end $$;
revoke all on function public.ensure_profile() from public, anon;
grant execute on function public.ensure_profile() to authenticated;

-- ---------------------------------------------------------------------
-- USERNAME ACCOUNTS — people sign up and sign in with a username + password.
-- The account is a normal Supabase Auth user, so Supabase checks the password and issues the session,
-- and every security rule in this file keeps working. The username maps to an internal address
-- "<username>@hustl.invalid" (".invalid" can never receive email; nothing is ever sent).
-- The password is stored only as a bcrypt hash, never as plain text.
-- ---------------------------------------------------------------------
create or replace function public.register_user(p_username text, p_password text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  u    text := lower(btrim(coalesce(p_username, '')));
  uid  uuid := gen_random_uuid();
  addr text;
begin
  if u !~ '^[a-z0-9_]{3,20}$' then raise exception 'invalid username' using errcode = '22023'; end if;
  if char_length(coalesce(p_password, '')) not between 8 and 72 then raise exception 'weak password' using errcode = '22023'; end if;
  addr := u || '@hustl.invalid';
  if exists (select 1 from auth.users where lower(email) = addr) then raise exception 'username taken' using errcode = '23505'; end if;

  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, recovery_token, email_change_token_new, email_change)
  values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', addr,
          extensions.crypt(p_password, extensions.gen_salt('bf', 10)), now(),
          '{"provider":"email","providers":["email"]}', jsonb_build_object('username', u), now(), now(),
          '', '', '', '');
  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), uid, uid::text,
          jsonb_build_object('sub', uid::text, 'email', addr, 'email_verified', true), 'email', now(), now(), now());
end $$;
revoke all on function public.register_user(text, text) from public;
grant execute on function public.register_user(text, text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- TASKS — synced between a user's own devices. Last write wins by updated_at.
-- ---------------------------------------------------------------------
create table if not exists public.tasks (
  id                uuid primary key,
  user_id           uuid not null default auth.uid() references auth.users (id) on delete cascade,
  text              text not null check (char_length(text) between 1 and 500),
  created_at        timestamptz not null,
  done_at           timestamptz,
  updated_at        timestamptz not null,
  deleted           boolean not null default false,
  server_updated_at timestamptz not null default clock_timestamp()  -- set by the server; used as the pull cursor
);
create index if not exists tasks_user_server_updated_idx on public.tasks (user_id, server_updated_at);

create or replace function public.tasks_before_write()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.updated_at < old.updated_at then
      return null;               -- an older edit arrived late: keep the newer one (last write wins)
    end if;
    new.user_id := old.user_id;  -- a task can never move to another account
  end if;
  new.server_updated_at := clock_timestamp();
  return new;
end $$;
drop trigger if exists tasks_before_write on public.tasks;
create trigger tasks_before_write before insert or update on public.tasks
  for each row execute function public.tasks_before_write();

-- ---------------------------------------------------------------------
-- COMPLETION LOG — { day: count } per user. Merged by keeping the larger count.
-- ---------------------------------------------------------------------
create table if not exists public.completion_log (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  day        date not null,
  count      integer not null check (count between 0 and 100000),
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

create or replace function public.completion_log_before_update()
returns trigger language plpgsql as $$
begin
  new.count := greatest(new.count, old.count);
  new.user_id := old.user_id;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists completion_log_before_update on public.completion_log;
create trigger completion_log_before_update before update on public.completion_log
  for each row execute function public.completion_log_before_update();

-- ---------------------------------------------------------------------
-- FOLLOWS — chatting needs a mutual follow
-- ---------------------------------------------------------------------
create table if not exists public.follows (
  follower_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  followee_id uuid not null references public.profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, followee_id),
  check (follower_id <> followee_id)
);
create index if not exists follows_followee_idx on public.follows (followee_id);

-- Limits: each person can follow at most 50 people and have at most 50 followers.
-- The locks stop two follows at the same moment from slipping past the limit together.
create or replace function public.follows_limit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Always lock the two people in the same order, so two people following each other at once can't deadlock.
  perform pg_advisory_xact_lock(hashtext('hustl-follow:' || least(new.follower_id, new.followee_id)::text));
  perform pg_advisory_xact_lock(hashtext('hustl-follow:' || greatest(new.follower_id, new.followee_id)::text));
  if (select count(*) from public.follows where follower_id = new.follower_id) >= 50 then
    raise exception 'follow limit: you can follow up to 50 people' using errcode = 'P0001';
  end if;
  if (select count(*) from public.follows where followee_id = new.followee_id) >= 50 then
    raise exception 'follower limit: this person already has 50 followers' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists follows_limit on public.follows;
create trigger follows_limit before insert on public.follows
  for each row execute function public.follows_limit();

create or replace function public.is_mutual(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.follows where follower_id = a and followee_id = b)
     and exists (select 1 from public.follows where follower_id = b and followee_id = a);
$$;
revoke all on function public.is_mutual(uuid, uuid) from public, anon;
grant execute on function public.is_mutual(uuid, uuid) to authenticated;

-- Look up someone by their User ID (handle) so you can follow them.
create or replace function public.lookup_profile(p_handle text)
returns table (id uuid, handle text, display_name text)
language sql stable security definer set search_path = public as $$
  select p.id, p.handle, p.display_name from public.profiles p
  where auth.uid() is not null and p.handle = lower(btrim(p_handle));
$$;
revoke all on function public.lookup_profile(text) from public, anon;
grant execute on function public.lookup_profile(text) to authenticated;

-- ---------------------------------------------------------------------
-- MESSAGES — only between two users who follow each other
-- ---------------------------------------------------------------------
create table if not exists public.messages (
  id           uuid primary key default gen_random_uuid(),   -- the app sends its own id so offline retries never duplicate
  sender_id    uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  body         text check (char_length(body) <= 4000),
  media_path   text,
  media_type   text check (media_type in ('image', 'video')),
  created_at   timestamptz not null default now(),
  read_at      timestamptz,
  check (sender_id <> recipient_id),
  check (body is not null or media_path is not null),
  check ((media_path is null) = (media_type is null))
);
create index if not exists messages_pair_idx on public.messages (sender_id, recipient_id, created_at desc);
create index if not exists messages_recipient_idx on public.messages (recipient_id, created_at desc);

create or replace function public.messages_before_insert()
returns trigger language plpgsql as $$
begin
  new.created_at := now();   -- server time, never the client's
  new.read_at := null;
  return new;
end $$;
drop trigger if exists messages_before_insert on public.messages;
create trigger messages_before_insert before insert on public.messages
  for each row execute function public.messages_before_insert();

-- Real-time delivery (Supabase Realtime respects the RLS policies below).
do $$ begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages') then
    alter publication supabase_realtime add table public.messages;
  end if;
  -- Tasks and the streak log too, so a change on one device shows up on the others straight away.
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tasks') then
    alter publication supabase_realtime add table public.tasks;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'completion_log') then
    alter publication supabase_realtime add table public.completion_log;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- ---------------------------------------------------------------------
alter table public.profiles       enable row level security;
alter table public.tasks          enable row level security;
alter table public.completion_log enable row level security;
alter table public.follows        enable row level security;
alter table public.messages       enable row level security;

-- Column-level limits: users may only change their display name, and only mark messages read.
revoke update on public.profiles from anon, authenticated;
grant  update (display_name) on public.profiles to authenticated;
revoke update on public.messages from anon, authenticated;
grant  update (read_at) on public.messages to authenticated;

-- profiles: see yourself, and anyone you follow or who follows you
drop policy if exists "profiles: read self and connections" on public.profiles;
create policy "profiles: read self and connections" on public.profiles for select to authenticated
  using (id = (select auth.uid())
         or exists (select 1 from public.follows f
                    where (f.follower_id = (select auth.uid()) and f.followee_id = profiles.id)
                       or (f.followee_id = (select auth.uid()) and f.follower_id = profiles.id)));
drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- tasks: only your own
drop policy if exists "tasks: own rows" on public.tasks;
create policy "tasks: own rows" on public.tasks for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- completion log: only your own
drop policy if exists "completion_log: own rows" on public.completion_log;
create policy "completion_log: own rows" on public.completion_log for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- follows: see the ones involving you; create/delete only your own
drop policy if exists "follows: read mine" on public.follows;
create policy "follows: read mine" on public.follows for select to authenticated
  using (follower_id = (select auth.uid()) or followee_id = (select auth.uid()));
drop policy if exists "follows: follow" on public.follows;
create policy "follows: follow" on public.follows for insert to authenticated
  with check (follower_id = (select auth.uid()));
drop policy if exists "follows: unfollow" on public.follows;
create policy "follows: unfollow" on public.follows for delete to authenticated
  using (follower_id = (select auth.uid()));

-- messages: read/send only within a mutual follow; recipient may mark as read.
-- Notes last 7 days: older ones are hidden at once and deleted by purge_expired_messages().
drop policy if exists "messages: read mutual" on public.messages;
create policy "messages: read mutual" on public.messages for select to authenticated
  using ((sender_id = (select auth.uid()) or recipient_id = (select auth.uid()))
         and public.is_mutual(sender_id, recipient_id)
         and created_at > now() - interval '7 days');
drop policy if exists "messages: send mutual" on public.messages;
create policy "messages: send mutual" on public.messages for insert to authenticated
  with check (sender_id = (select auth.uid())
              and public.is_mutual(sender_id, recipient_id)
              and (media_path is null
                   or media_path like (sender_id::text || '/' || recipient_id::text || '/%')));
drop policy if exists "messages: mark read" on public.messages;
create policy "messages: mark read" on public.messages for update to authenticated
  using (recipient_id = (select auth.uid()) and public.is_mutual(sender_id, recipient_id)
         and created_at > now() - interval '7 days')
  with check (recipient_id = (select auth.uid()));

-- ---------------------------------------------------------------------
-- STORAGE — private bucket "chat-media", files at {sender}/{recipient}/{uuid}.{ext}
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-media', 'chat-media', false, 52428800,
        array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.chat_media_access(object_name text, writing boolean)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  parts text[] := storage.foldername(object_name);
  me uuid := auth.uid();
  a uuid; b uuid;
begin
  if me is null or coalesce(array_length(parts, 1), 0) < 2 then return false; end if;
  begin
    a := parts[1]::uuid; b := parts[2]::uuid;
  exception when others then return false;
  end;
  if writing then return a = me and public.is_mutual(a, b); end if;
  return (me = a or me = b) and public.is_mutual(a, b);
end $$;
revoke all on function public.chat_media_access(text, boolean) from public, anon;
grant execute on function public.chat_media_access(text, boolean) to authenticated;

drop policy if exists "chat-media: read mutual" on storage.objects;
create policy "chat-media: read mutual" on storage.objects for select to authenticated
  using (bucket_id = 'chat-media' and public.chat_media_access(name, false)
         and created_at > now() - interval '7 days');   -- photos disappear with their notes
drop policy if exists "chat-media: read own" on storage.objects;   -- you always see your own uploads (needed to delete them)
create policy "chat-media: read own" on storage.objects for select to authenticated
  using (bucket_id = 'chat-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "chat-media: upload mutual" on storage.objects;
create policy "chat-media: upload mutual" on storage.objects for insert to authenticated
  with check (bucket_id = 'chat-media' and public.chat_media_access(name, true));
drop policy if exists "chat-media: delete own" on storage.objects;
create policy "chat-media: delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'chat-media' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- Your own photos that are past 7 days. The app deletes these through the Storage API
-- (deleting rows here with SQL would leave the actual files behind).
create or replace function public.my_expired_media()
returns setof text language sql stable security definer set search_path = public as $$
  select name from storage.objects
  where bucket_id = 'chat-media' and (storage.foldername(name))[1] = auth.uid()::text
    and created_at < now() - interval '7 days'
  order by created_at limit 1000;
$$;
revoke all on function public.my_expired_media() from public, anon;
grant execute on function public.my_expired_media() to authenticated;

-- ---------------------------------------------------------------------
-- DISAPPEARING NOTES — chat messages are deleted 7 days after they're sent.
-- An hourly job does it (pg_cron); the app also calls the function once per session as a backstop.
-- ---------------------------------------------------------------------
create or replace function public.purge_expired_messages()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from public.messages where created_at < now() - interval '7 days';
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.purge_expired_messages() from public, anon;
grant execute on function public.purge_expired_messages() to authenticated;

do $$ begin
  create extension if not exists pg_cron;
  perform cron.schedule('hustl-purge-expired-messages', '7 * * * *', 'select public.purge_expired_messages()');
exception when others then
  raise notice 'pg_cron is not available, so old notes are hidden right away and deleted when someone opens the app.';
end $$;
