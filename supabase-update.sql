-- Hustl update (Nov 2026): run once in Supabase → SQL Editor → New query → Run. Safe to run again.
-- 1) Chat notes disappear after 7 days.  2) Follow limits: follow up to 50 people, have up to 50 followers.
-- 3) Chat photos: hidden after 7 days, you can always delete your own, and the app can find expired ones to delete.
-- (Both are already in supabase.sql for new projects.)

drop policy if exists "messages: read mutual" on public.messages;
create policy "messages: read mutual" on public.messages for select to authenticated
  using ((sender_id = (select auth.uid()) or recipient_id = (select auth.uid()))
         and public.is_mutual(sender_id, recipient_id)
         and created_at > now() - interval '7 days');

drop policy if exists "messages: mark read" on public.messages;
create policy "messages: mark read" on public.messages for update to authenticated
  using (recipient_id = (select auth.uid()) and public.is_mutual(sender_id, recipient_id)
         and created_at > now() - interval '7 days')
  with check (recipient_id = (select auth.uid()));

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

notify pgrst, 'reload schema';
