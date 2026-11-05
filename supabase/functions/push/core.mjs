// The "push" function's logic, kept free of Supabase/Deno specifics so tests/pushfn.mjs can run it in Node.
//
//   POST {"type":"due"}    — from the database's schedule (every 30 s), with the x-cron-secret header:
//                            push every reminder that has just come due to all of its owner's devices.
//   POST {"type":"added", "alarm_id", "endpoint"} — from the app, signed in: tell the owner's other devices
//                            that a reminder was added (the device that added it is left out).
//
// ctx = { db, send(subscription, message), env: { CRON_SECRET }, now() }
// db  = { dueAlarms(nowISO), markPushed(id, atISO), subscriptionsFor(userId), deleteSubscription(endpoint),
//         userFromToken(jwt), alarmFor(id, userId) }

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// The reminder's time, written the way the person reads it (their device told us its time zone).
export function whenText(iso, tz) {
  try {
    return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz || 'UTC' }).format(new Date(iso));
  } catch {
    return new Date(iso).toUTCString();
  }
}

async function pushToAll(ctx, subs, message) {
  let sent = 0;
  for (const sub of subs) {
    try {
      const r = await ctx.send(sub, { ...message, body: message.body.replace('{when}', whenText(message.due_at, sub.tz)) });
      if (r.gone) await ctx.db.deleteSubscription(sub.endpoint);
      else if (r.status >= 200 && r.status < 300) sent++;
    } catch (e) {
      console.error('push failed', e && e.message);
    }
  }
  return sent;
}

export async function sendDue(ctx) {
  const now = ctx.now();
  const due = await ctx.db.dueAlarms(now.toISOString());
  let sent = 0;
  for (const a of due) {
    if (a.pushed_at && a.pushed_at >= a.due_at) continue;           // already sent for this due time (a snooze sets a new one)
    await ctx.db.markPushed(a.id, now.toISOString());                // first, so a slow send can't make it go out twice
    const subs = await ctx.db.subscriptionsFor(a.user_id);
    sent += await pushToAll(ctx, subs, { kind: 'due', title: '⏰ Reminder', body: `${a.text}\n{when}`, due_at: a.due_at, tag: 'alarm-' + a.id, alarm: a.id });
  }
  return { due: due.length, sent };
}

export async function handle(req, ctx) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad request' }, 400); }

  if (body.type === 'due') {
    if (!ctx.env.CRON_SECRET || req.headers.get('x-cron-secret') !== ctx.env.CRON_SECRET) return json({ error: 'forbidden' }, 403);
    return json(await sendDue(ctx));
  }

  if (body.type === 'added') {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const user = token ? await ctx.db.userFromToken(token) : null;
    if (!user) return json({ error: 'sign in first' }, 401);
    const a = typeof body.alarm_id === 'string' ? await ctx.db.alarmFor(body.alarm_id, user.id) : null;
    if (!a) return json({ error: 'not found' }, 404);
    if (a.done_at || a.deleted) return json({ sent: 0 });
    const subs = (await ctx.db.subscriptionsFor(user.id)).filter(s => s.endpoint !== body.endpoint);
    const sent = await pushToAll(ctx, subs, { kind: 'added', title: '⏰ New reminder', body: `${a.text}\n{when}`, due_at: a.due_at, tag: 'alarm-new-' + a.id, alarm: a.id });
    return json({ sent });
  }

  return json({ error: 'unknown type' }, 400);
}
