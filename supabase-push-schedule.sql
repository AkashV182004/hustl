-- Hustl: check for due reminders every 30 seconds and push them (Edge Function "push").
-- Needs the "push" function deployed with the same CRON_SECRET. Replace the two placeholders, then run it once
-- in Supabase → SQL Editor. Safe to run again (it replaces the old schedule).
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

select cron.schedule(
  'hustl-push-alarms',
  '30 seconds',
  $$ select net.http_post(
       url := 'https://__PROJECT_REF__.supabase.co/functions/v1/push',
       headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '__CRON_SECRET__'),
       body := '{"type":"due"}'::jsonb,
       timeout_milliseconds := 20000) $$
);
