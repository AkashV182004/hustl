// Delivers real push messages into the app's service worker (via the Chrome DevTools Protocol) and checks
// what happens: with Hustl open and in front, and with Hustl closed (a notification with Snooze / Done).
// Also: tapping Snooze / Done on a notification while Hustl was closed. Run: node tests/push.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, checker } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { server, base } = await startServer();
const { ok, state } = checker();
// the full Chromium build: the lightweight headless one can't show notifications
const browser = await chromium.launch({ channel: 'chromium' });
const errors = [];

const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.grantPermissions(['notifications'], { origin: base });
await ctx.route('**/vendor/supabase.js', r => r.fulfill({ path: path.join(root, 'tests', 'fake-supabase.js'), contentType: 'text/javascript' }));
await ctx.route('**/config.js*', r => r.fulfill({ contentType: 'text/javascript', body: "window.HUSTL_CONFIG = {};" }));   // offline-only: just the app and its service worker
const open = async (url = base) => {
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(url);
  await page.evaluate(() => window.Hustl.ready);
  return page;
};

let page = await open();
await page.evaluate(() => navigator.serviceWorker.ready);
if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) { await page.reload(); await page.evaluate(() => window.Hustl.ready); }
ok(await page.evaluate(() => !!navigator.serviceWorker.controller), 'service worker is running');

// DevTools connection on a blank page that stays open, so it survives closing Hustl
const anchor = await ctx.newPage();
await anchor.goto('about:blank');
const cdp = await ctx.newCDPSession(anchor);
const regs = [];
cdp.on('ServiceWorker.workerRegistrationUpdated', e => regs.push(...e.registrations));
await cdp.send('ServiceWorker.enable');
await page.waitForTimeout(300);
const reg = regs.find(r => base.startsWith(r.scopeURL.replace(/\/$/, '')) || r.scopeURL.startsWith(base));
ok(!!reg, 'found its registration');
const push = data => cdp.send('ServiceWorker.deliverPushMessage', { origin: new URL(base).origin, registrationId: reg.registrationId, data: JSON.stringify(data) });
const notes = (p, tag) => p.evaluate(async t => (await (await navigator.serviceWorker.ready).getNotifications(t ? { tag: t } : {})).map(n => ({ title: n.title, body: n.body, tag: n.tag, actions: (n.actions || []).map(a => a.action), data: n.data })), tag);

console.log('\n▶ Hustl open and in front');
await page.bringToFront();
await page.evaluate(() => { window.__pushMsgs = []; navigator.serviceWorker.addEventListener('message', e => { if (e.data && e.data.type === 'push') window.__pushMsgs.push(e.data.data); }); });
await push({ kind: 'due', title: '⏰ Reminder', body: 'In front\nnow', tag: 'alarm-front', alarm: 'front' });
ok(await page.waitForFunction(() => window.__pushMsgs.some(m => m.alarm === 'front'), null, { timeout: 5000 }).then(() => true, () => false), 'the push is handed to the open app (it rings there)');
ok((await notes(page, 'alarm-front')).length === 0, 'no duplicate system notification');

console.log('\n▶ Hustl closed');
// a reminder this device knows about, so Done can be tested afterwards
const id = await page.evaluate(async () => (await window.Hustl.addAlarm('Feed the cat', new Date(Date.now() + 3600e3))).alarm.id);
await page.close();
await push({ kind: 'due', title: '⏰ Reminder', body: 'Feed the cat\nSat 7 Nov, 19:00', tag: 'alarm-' + id, alarm: id });
await new Promise(r => setTimeout(r, 800));
const probe = await open();   // reopen Hustl to look at the notifications that were shown while it was closed
const shown = await probe.evaluate(async t => (await (await navigator.serviceWorker.getRegistration('./')).getNotifications({ tag: t })).map(n => ({ title: n.title, body: n.body, actions: (n.actions || []).map(a => a.action), data: n.data, requireInteraction: n.requireInteraction })), 'alarm-' + id).catch(e => 'error: ' + e.message);
ok(Array.isArray(shown) && shown.length === 1, 'with Hustl closed, a system notification is shown' + (Array.isArray(shown) ? '' : ` (${shown})`));
if (Array.isArray(shown) && shown[0]) {
  ok(shown[0].title === '⏰ Reminder' && shown[0].body.startsWith('Feed the cat'), 'it says "⏰ Reminder" and what to do');
  ok(JSON.stringify(shown[0].actions) === '["snooze","done"]', 'with Snooze and Done buttons');
  ok(shown[0].requireInteraction === true, 'and it stays until you deal with it');
}
await probe.close();   // closed again before the next push
await push({ kind: 'added', title: '⏰ New reminder', body: 'Buy strings\nSun 8 Nov, 10:00', tag: 'alarm-new-x', alarm: 'x' });
await new Promise(r => setTimeout(r, 500));
const probe2 = await open();
const added = await probe2.evaluate(async () => (await (await navigator.serviceWorker.getRegistration('./')).getNotifications({ tag: 'alarm-new-x' })).map(n => ({ title: n.title, actions: (n.actions || []).length })));
ok(added.length === 1 && added[0].title === '⏰ New reminder' && added[0].actions === 0, '"New reminder" from another device shows too (no buttons needed)');
await probe2.close();

console.log('\n▶ Done tapped on the notification while Hustl was closed');
page = await open(`${base}?alarm=${id}&do=done#tasks`);
ok(await page.waitForFunction(i => !!window.Hustl.state.alarms.find(a => a.id === i)?.done_at, id, { timeout: 5000 }).then(() => true, () => false), 'Hustl opens and marks the reminder done');
ok(!page.url().includes('alarm='), 'and tidies the address');
const id2 = await page.evaluate(async () => (await window.Hustl.addAlarm('Stretch', new Date(Date.now() + 60e3))).alarm.id);
await page.close();
page = await open(`${base}?alarm=${id2}&do=snooze#tasks`);
const later = await page.evaluate(i => (Date.parse(window.Hustl.state.alarms.find(a => a.id === i).due_at) - Date.now()) / 60000, id2);
ok(later > 9 && later <= 10, `Snooze from the notification moves it 10 minutes later (${later.toFixed(1)} min)`);

ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
server.close();
console.log(state.failures ? `\n${state.failures} check(s) failed` : '\nAll checks passed');
process.exit(state.failures ? 1 : 0);
