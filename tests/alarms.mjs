// Reminder alarms: set a reminder with a date & time in Important Reminders; when it's due it rings
// (pop-up with Snooze / Done, system notification), syncs between devices, and still works on a database
// without the update. Run: node tests/alarms.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import { startServer, checker, device as makeDevice, signIn, shots } from './harness.mjs';
import { createFakeServer } from './fake-server.mjs';

const { server, base } = await startServer();
const fake = createFakeServer();
const db = fake.db;
const { ok, state } = checker();
const browser = await chromium.launch();
const errors = [];
// A stand-in for the browser's notifications (always allowed), and a window that isn't focused,
// so the app also sends a system notification.
const fakeNotifications = () => {
  window.__notes = [];
  window.Notification = class { static permission = 'granted'; static requestPermission() { return Promise.resolve('granted'); }
    constructor(title, o) { window.__notes.push({ title, body: o && o.body }); } close() {} };
  document.hasFocus = () => false;
};
const device = (name, opts) => makeDevice(browser, { name, base, fake, errors, init: fakeNotifications, ...opts });
const until = (page, fn, arg, ms = 8000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);
const soon = (page, seconds, text) => page.evaluate(([s, t]) => window.Hustl.addAlarm(t, new Date(Date.now() + s * 1000)), [seconds, text]);
const listTexts = page => page.locator('#alarmList .alarm .alarm-main b').allTextContents();
const dialogOpen = (page, text) => until(page, t => { const d = document.querySelector('#alarmDlg'); return d.open && document.querySelector('#alarmDlgText').textContent === t; }, text);

console.log('\n▶ setting a reminder');
const A = await device('laptop', { viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
ok(await A.page.locator('#alarmText').isVisible() && await A.page.locator('#alarmAt').isVisible(), 'Important Reminders has "Remind me to…" and a date & time box');
const suggested = await A.page.inputValue('#alarmAt');
ok(/T\d\d:00$/.test(suggested) && new Date(suggested) > new Date(), `the date & time box suggests the next whole hour (${suggested})`);
await A.page.click('.alarm-set');
ok(await A.page.locator('.toast', { hasText: 'What should we remind you about' }).count() > 0, 'empty reminder → friendly message');
await A.page.fill('#alarmText', 'Too late');
await A.page.fill('#alarmAt', '2020-01-01T09:00');
await A.page.click('.alarm-set');
ok(await A.page.locator('.toast', { hasText: 'already passed' }).count() > 0, 'a time in the past is refused');
const inTwoHours = new Date(Date.now() + 2 * 3600e3);
const local = new Date(inTwoHours - inTwoHours.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
await A.page.fill('#alarmText', 'Call the venue');
await A.page.fill('#alarmAt', local);
await A.page.click('.alarm-set');
ok(await until(A.page, () => [...document.querySelectorAll('#alarmList .alarm-main b')].some(b => b.textContent === 'Call the venue')), 'the reminder is listed');
ok((await A.page.locator('#alarmList .alarm', { hasText: 'Call the venue' }).locator('time').textContent()).includes('in 2 hours'), 'with its date, time and "in 2 hours"');
ok(await A.page.locator('.toast', { hasText: 'Alarm set for' }).count() > 0, '"Alarm set" confirmation');
ok((await A.page.inputValue('#alarmText')) === '', 'the box is cleared for the next one');

console.log('\n▶ it rings');
await soon(A.page, 2, 'Take the cake out');
ok(await dialogOpen(A.page, 'Take the cake out'), 'when it is due, the reminder pops up');
ok((await A.page.locator('#alarmDlgKind').textContent()).includes('Reminder'), 'labelled "⏰ Reminder"');
ok(await A.page.evaluate(() => window.__notes.some(n => n.title.includes('Reminder') && n.body.includes('Take the cake out'))), 'and a system notification is sent');
await A.page.screenshot({ path: path.join(shots, 'desktop-light-22-alarm.png') });
await A.page.click('#alarmDone');
ok(await A.page.locator('#alarmDlg').evaluate(d => !d.open), 'Done closes it');
ok(await until(A.page, () => window.Hustl.state.alarms.find(a => a.text === 'Take the cake out').done_at), 'and marks it done');
ok(await until(A.page, () => [...document.querySelectorAll('#alarmList .alarm.done b')].some(b => b.textContent === 'Take the cake out')), 'shown crossed out in the list');

await soon(A.page, 1.5, 'Stretch break');
ok(await dialogOpen(A.page, 'Stretch break'), 'another reminder rings');
await A.page.click('#alarmSnooze');
await until(A.page, () => { const a = window.Hustl.state.alarms.find(x => x.text === 'Stretch break'); return Date.parse(a.due_at) > Date.now() + 60000; });
const snoozed = await A.page.evaluate(() => window.Hustl.state.alarms.find(a => a.text === 'Stretch break'));
const mins = (Date.parse(snoozed.due_at) - Date.now()) / 60000;
ok(!snoozed.done_at && mins > 9 && mins <= 10, `Snooze moves it 10 minutes later (${mins.toFixed(1)} min)`);
ok(await until(A.page, () => [...document.querySelectorAll('.toast')].some(t => t.textContent.includes('Snoozed'))), '"Snoozed" confirmation');

console.log('\n▶ missed while the app was closed');
await A.page.evaluate(() => window.Hustl.mergeAlarms([
  { id: crypto.randomUUID(), text: 'Water the plants', due_at: new Date(Date.now() - 5 * 60000).toISOString(), updated_at: new Date().toISOString() },
  { id: crypto.randomUUID(), text: 'Old thing', due_at: new Date(Date.now() - 3 * 864e5).toISOString(), updated_at: new Date().toISOString() },
]));
ok(await dialogOpen(A.page, 'Water the plants'), 'a reminder missed in the last day rings when you open the app');
ok((await A.page.locator('#alarmDlgKind').textContent()) === 'Missed reminder', 'labelled "Missed reminder"');
await A.page.click('#alarmDone');
await A.page.waitForTimeout(300);
ok(await A.page.locator('#alarmDlg').evaluate(d => !d.open), 'an older one (3 days ago) does not ring');
ok((await A.page.locator('#alarmList .alarm.due', { hasText: 'Old thing' }).locator('time').textContent()).includes('overdue'), 'it is shown as overdue in the list instead');
await A.page.locator('#alarmList .alarm', { hasText: 'Old thing' }).locator('.task-del').click();
ok(await until(A.page, () => ![...document.querySelectorAll('#alarmList .alarm-main b')].some(b => b.textContent === 'Old thing')), 'reminders can be deleted');

console.log('\n▶ saved on the device');
await A.page.reload(); await A.page.evaluate(() => window.Hustl.ready);
ok((await listTexts(A.page)).includes('Call the venue') && (await listTexts(A.page)).includes('Stretch break'), 'reminders are still there after reopening');
await A.page.waitForTimeout(500);
ok(await A.page.locator('#alarmDlg').evaluate(d => !d.open), 'and ones already dealt with do not ring again');
await A.page.locator('.j-remind').scrollIntoViewIfNeeded();
await A.page.screenshot({ path: path.join(shots, 'desktop-light-23-reminders.png') });

console.log('\n▶ two devices');
await signIn(A.page, 'akash');
await A.page.waitForSelector('#acctSignedIn:not([hidden])');
ok(await until(A.page, () => document.querySelector('#onair').dataset.state === 'synced'), 'laptop synced');
const akashId = db.users.get('akash@hustl.invalid').id;
ok([...db.alarms.values()].some(a => a.user_id === akashId && a.text === 'Call the venue'), 'reminders reached the server');
const B = await device('phone', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: 'dark' });
await signIn(B.page, 'akash');
await B.page.click('.radio-key[data-screen="tasks"]');
ok(await until(B.page, () => [...document.querySelectorAll('#alarmList .alarm-main b')].some(b => b.textContent === 'Call the venue')), 'the phone gets the reminders');
await A.page.click('.radio-key[data-screen="tasks"]');
await soon(A.page, 3, 'Leave for the gig');
ok(await dialogOpen(B.page, 'Leave for the gig'), 'a reminder set on the laptop rings on the phone');
ok(await dialogOpen(A.page, 'Leave for the gig'), 'and on the laptop');
await B.page.screenshot({ path: path.join(shots, 'mobile-dark-17-alarm.png') });
await B.page.click('#alarmDone');
ok(await until(A.page, () => !document.querySelector('#alarmDlg').open, null, 8000), 'Done on the phone stops it ringing on the laptop');
ok(await until(A.page, () => !!window.Hustl.state.alarms.find(a => a.text === 'Leave for the gig').done_at), 'and it shows as done there');
await B.page.locator('.j-remind').scrollIntoViewIfNeeded();
await B.page.screenshot({ path: path.join(shots, 'mobile-dark-18-reminders.png') });

console.log('\n▶ a database without the update');
fake.oldSchema = true;
const C = await device('old-db', { viewport: { width: 1280, height: 800 } });
await signIn(C.page, 'maya');
await C.page.waitForSelector('#acctSignedIn:not([hidden])');
await C.page.click('.radio-key[data-screen="tasks"]');
await soon(C.page, 2, 'Old database alarm');
ok(await dialogOpen(C.page, 'Old database alarm'), 'alarms still ring on this device');
await C.page.click('#alarmDone');
await C.page.evaluate(() => window.HustlSync.syncNow());
ok(await until(C.page, () => document.querySelector('#onair').dataset.state === 'synced'), 'and sync stays green');
fake.oldSchema = false;

ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
server.close();
console.log(state.failures ? `\n${state.failures} check(s) failed` : '\nAll checks passed');
process.exit(state.failures ? 1 : 0);
