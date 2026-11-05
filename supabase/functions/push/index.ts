// Supabase Edge Function "push": sends reminder alarms to people's devices, even when Hustl is closed.
// Deploy:  npx supabase functions deploy push --project-ref <ref> --no-verify-jwt --use-api
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, CRON_SECRET  (npx supabase secrets set ...)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase; the service key stays on the server.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handle } from './core.mjs';
import { sendPush } from './webpush.mjs';

const env = (k: string) => Deno.env.get(k) ?? '';
const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
const vapid = { publicKey: env('VAPID_PUBLIC_KEY'), privateKey: env('VAPID_PRIVATE_KEY'), subject: env('VAPID_SUBJECT') };

const must = <T>({ data, error }: { data: T; error: unknown }) => { if (error) throw error; return data; };

const db = {
  // reminders due now (from the last day), not dismissed
  async dueAlarms(nowISO: string) {
    const since = new Date(Date.parse(nowISO) - 24 * 3600 * 1000).toISOString();
    return must(await sb.from('alarms').select('id,user_id,text,due_at,pushed_at')
      .is('done_at', null).eq('deleted', false).lte('due_at', nowISO).gt('due_at', since).limit(500));
  },
  async markPushed(id: string, at: string) { must(await sb.from('alarms').update({ pushed_at: at }).eq('id', id)); },
  async subscriptionsFor(userId: string) {
    return must(await sb.from('push_subscriptions').select('endpoint,p256dh,auth,tz').eq('user_id', userId));
  },
  async deleteSubscription(endpoint: string) { await sb.from('push_subscriptions').delete().eq('endpoint', endpoint); },
  async userFromToken(jwt: string) { const { data } = await sb.auth.getUser(jwt); return data?.user ?? null; },
  async alarmFor(id: string, userId: string) {
    const { data } = await sb.from('alarms').select('id,text,due_at,done_at,deleted').eq('id', id).eq('user_id', userId).maybeSingle();
    return data;
  },
};

Deno.serve(req => handle(req, {
  db,
  env: { CRON_SECRET: env('CRON_SECRET') },
  send: (sub: { endpoint: string; p256dh: string; auth: string }, message: unknown) => sendPush(sub, message, vapid),
  now: () => new Date(),
}));
