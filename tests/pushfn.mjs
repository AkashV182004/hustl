// The "push" server function's logic (supabase/functions/push/core.mjs) with a stand-in database.
// Run: node tests/pushfn.mjs
import { handle, whenText } from '../supabase/functions/push/core.mjs';

let failures = 0;
const ok = (c, m) => { console.log(`${c ? '  ✓' : '  ✗'} ${m}`); if (!c) failures++; };

const NOW = new Date('2026-11-07T19:00:30Z');
const iso = (mins) => new Date(NOW.getTime() + mins * 60000).toISOString();
const alarms = [
  { id: 'a1', user_id: 'u1', text: 'Leave for the gig', due_at: iso(-0.5), pushed_at: null, done_at: null, deleted: false },
  { id: 'a2', user_id: 'u1', text: 'Later today', due_at: iso(60), pushed_at: null, done_at: null, deleted: false },
  { id: 'a3', user_id: 'u2', text: 'Maya: call home', due_at: iso(-1), pushed_at: null, done_at: null, deleted: false },
  { id: 'a4', user_id: 'u1', text: 'Snoozed', due_at: iso(-0.2), pushed_at: iso(-10), done_at: null, deleted: false },   // pushed before its snooze
];
let subs = [
  { user_id: 'u1', endpoint: 'https://push.example/laptop', p256dh: 'k', auth: 'a', tz: 'Asia/Kolkata' },
  { user_id: 'u1', endpoint: 'https://push.example/phone', p256dh: 'k', auth: 'a', tz: 'Asia/Kolkata' },
  { user_id: 'u1', endpoint: 'https://push.example/old', p256dh: 'k', auth: 'a', tz: 'UTC' },
  { user_id: 'u2', endpoint: 'https://push.example/maya', p256dh: 'k', auth: 'a', tz: 'Europe/London' },
];
const db = {
  async dueAlarms(nowISO) { return alarms.filter(a => !a.done_at && !a.deleted && a.due_at <= nowISO).map(a => ({ ...a })); },
  async markPushed(id, at) { alarms.find(a => a.id === id).pushed_at = at; },
  async subscriptionsFor(u) { return subs.filter(s => s.user_id === u); },
  async deleteSubscription(e) { subs = subs.filter(s => s.endpoint !== e); },
  async userFromToken(t) { return t === 'good-token-u1' ? { id: 'u1' } : null; },
  async alarmFor(id, u) { return alarms.find(a => a.id === id && a.user_id === u) || null; },
};
let pushes = [];
const send = async (sub, msg) => { pushes.push({ to: sub.endpoint, ...msg }); return { status: sub.endpoint.endsWith('/old') ? 410 : 201, gone: sub.endpoint.endsWith('/old') }; };
const ctx = { db, send, env: { CRON_SECRET: 's3cret' }, now: () => NOW };
const call = (body, headers = {}) => handle(new Request('https://fn.example/push', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }), ctx);

console.log('\n▶ the schedule (due reminders)');
ok((await call({ type: 'due' })).status === 403, 'without the schedule secret: refused');
ok((await call({ type: 'due' }, { 'x-cron-secret': 'wrong' })).status === 403, 'with a wrong secret: refused');
let r = await (await call({ type: 'due' }, { 'x-cron-secret': 's3cret' })).json();
const to = id => pushes.filter(p => p.alarm === id).map(p => p.to).sort();
ok(JSON.stringify(to('a1')) === JSON.stringify(['https://push.example/laptop', 'https://push.example/old', 'https://push.example/phone']), 'a due reminder goes to every device of its owner');
ok(JSON.stringify(to('a3')) === '["https://push.example/maya"]', "and only theirs (Maya's reminder reaches only Maya)");
ok(to('a2').length === 0, 'reminders not yet due are not sent');
ok(JSON.stringify(to('a4')) === JSON.stringify(['https://push.example/laptop', 'https://push.example/phone']), 'a snoozed reminder is sent again at its new time (the removed device is skipped)');
const msg = pushes.find(p => p.alarm === 'a1' && p.to.endsWith('/phone'));
ok(msg.kind === 'due' && msg.title === '⏰ Reminder' && msg.tag === 'alarm-a1' && msg.body.startsWith('Leave for the gig\n'), 'message: "⏰ Reminder", the text, and a tag that matches the app');
ok(msg.body.includes(whenText(alarms[0].due_at, 'Asia/Kolkata')) && /00:30|0:30/.test(msg.body), `the time is shown in the person's own time zone (${msg.body.split('\n')[1]})`);
ok(!subs.some(s => s.endpoint.endsWith('/old')), 'a device that no longer exists is removed');
ok(r.sent === 5, `count of messages delivered (${r.sent})`);
pushes = [];
r = await (await call({ type: 'due' }, { 'x-cron-secret': 's3cret' })).json();
ok(pushes.length === 0, 'the next run does not send the same reminders again');

console.log('\n▶ "new reminder" for your other devices');
ok((await call({ type: 'added', alarm_id: 'a2' })).status === 401, 'not signed in: refused');
ok((await call({ type: 'added', alarm_id: 'a3' }, { authorization: 'Bearer good-token-u1' })).status === 404, "someone else's reminder: not found");
pushes = [];
r = await (await call({ type: 'added', alarm_id: 'a2', endpoint: 'https://push.example/laptop' }, { authorization: 'Bearer good-token-u1' })).json();
ok(JSON.stringify(pushes.map(p => p.to)) === '["https://push.example/phone"]', 'goes to your other devices, not the one that added it');
ok(pushes[0].title === '⏰ New reminder' && pushes[0].kind === 'added' && pushes[0].body.startsWith('Later today'), 'message: "⏰ New reminder" with the text and time');

console.log('\n▶ browsers calling it');
const pre = await handle(new Request('https://fn.example/push', { method: 'OPTIONS' }), ctx);
ok(pre.status === 200 && pre.headers.get('Access-Control-Allow-Origin') === '*', 'answers the browser pre-flight (CORS)');
ok((await handle(new Request('https://fn.example/push'), ctx)).status === 405, 'only POST');

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
