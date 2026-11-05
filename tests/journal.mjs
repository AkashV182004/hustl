// Daily Track page checks: Month/Date, Tasks to Complete, Top Priorities (up to 6), Notes & Ideas,
// Important Reminders — saved on the device, synced between devices, and still working on a database
// that hasn't had supabase-update.sql run yet. Run: node tests/journal.mjs
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
const device = (name, opts) => makeDevice(browser, { name, base, fake, errors, ...opts });
const until = (page, fn, arg, ms = 6000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);
const names = (page, list) => page.locator(`#${list} .task .task-text span`).allTextContents();
async function add(page, text, prio = false) {
  const input = prio ? '#prioInput' : '#taskInput';
  await page.fill(input, text); await page.press(input, 'Enter');
  await page.waitForFunction(t => window.Hustl.state.tasks.some(x => x.text === t), text);
}
const row = (page, list, text) => page.locator(`#${list} .task`, { hasText: text });

console.log('\n▶ the page');
const A = await device('laptop', { viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
ok((await A.page.locator('#journalTitle').textContent()).trim() === 'Daily Track', 'Tasks tab is the "Daily Track" page');
const month = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(new Date());
ok((await A.page.locator('#jMonth').textContent()) === month, `Month is filled in (${month})`);
ok((await A.page.locator('#jDate').textContent()).includes(String(new Date().getDate())), 'Date is filled in');
for (const label of ['Tasks to Complete', 'Top Priorities', 'Notes & Ideas', 'Important Reminders']) {
  ok(await A.page.getByRole('heading', { name: label }).isVisible(), `"${label}" section`);
}
ok(await A.page.locator('#taskList .j-blank').count() >= 3, 'empty ruled lines like a paper page');

console.log('\n▶ tasks and top priorities');
await add(A.page, 'Buy guitar strings');
await add(A.page, 'Email the band');
await add(A.page, 'Book the studio', true);
ok(await until(A.page, () => JSON.stringify([...document.querySelectorAll('#prioList .task-text span')].map(s => s.textContent)) === '["Book the studio"]'), 'a task added on the Top Priorities line lands there');
ok(!(await names(A.page, 'taskList')).includes('Book the studio'), 'and not under Tasks to Complete');
await row(A.page, 'taskList', 'Email the band').locator('.task-prio').click();
ok(await until(A.page, () => [...document.querySelectorAll('#prioList .task-text span')].some(s => s.textContent === 'Email the band')
  && ![...document.querySelectorAll('#taskList .task-text span')].some(s => s.textContent === 'Email the band')), '⚡ moves a task to Top Priorities');
await row(A.page, 'prioList', 'Email the band').locator('.task-prio').click();
ok(await until(A.page, () => [...document.querySelectorAll('#taskList .task-text span')].some(s => s.textContent === 'Email the band')), '⚡ again moves it back');

for (const t of ['P2', 'P3', 'P4', 'P5', 'P6']) await add(A.page, t, true);
ok(await until(A.page, () => document.querySelector('#prioForm').hidden), 'after 6 priorities the add line goes away');
ok((await A.page.locator('#prioHint').textContent()).includes('All six lines are taken'), 'and explains why');
await row(A.page, 'taskList', 'Email the band').locator('.task-prio').click();
ok(await A.page.locator('.toast', { hasText: 'holds six' }).count() > 0 && (await names(A.page, 'taskList')).includes('Email the band'), 'a 7th priority is refused with a friendly message');

const before = Number(await A.page.locator('#statToday').textContent());
await row(A.page, 'prioList', 'Book the studio').locator('.task-check').click();
ok(await until(A.page, () => document.querySelector('#statToday').textContent !== '0'), 'ticking a priority counts towards today');
ok(Number(await A.page.locator('#statToday').textContent()) === before + 1, 'done today +1 (streak)');
ok(await until(A.page, () => { const n = [...document.querySelectorAll('#prioList .task .task-text span')].map(s => s.textContent); return n.at(-1) === 'Book the studio'; }), 'a done priority stays on the page, struck through, below the open ones');
ok(await until(A.page, () => !document.querySelector('#prioForm').hidden), 'finishing one frees a line');

console.log('\n▶ notes and reminders');
await A.page.fill('#notesText', 'Idea: vinyl stickers for the merch table\nIdea 2: acoustic set');
await A.page.fill('#remindText', 'Call mum at 6');
await A.page.locator('#taskInput').focus();   // leaving the box saves straight away
ok(await until(A.page, () => window.Hustl.state.notes.notes.body.startsWith('Idea: vinyl') && window.Hustl.state.notes.reminders.body === 'Call mum at 6'), 'Notes & Ideas and Important Reminders are saved');
ok(await A.page.locator('.j-saved.on').count() > 0, '"Saved ✓" shows');
await A.page.fill('#notesText', 'Idea: vinyl stickers for the merch table\nIdea 2: acoustic set\nIdea 3: zine');
ok(await until(A.page, () => window.Hustl.state.notes.notes.body.endsWith('zine'), null, 3000), 'typing saves by itself after a moment');
await A.page.reload(); await A.page.evaluate(() => window.Hustl.ready);
ok((await A.page.inputValue('#notesText')).endsWith('Idea 3: zine') && (await A.page.inputValue('#remindText')) === 'Call mum at 6', 'they are still there after reopening the app');
ok((await names(A.page, 'prioList')).length === 6, 'priorities are kept too');
await A.page.screenshot({ path: path.join(shots, 'desktop-light-20-daily-track.png'), fullPage: true });

console.log('\n▶ sync between devices');
await signIn(A.page, 'akash');
await A.page.waitForSelector('#acctSignedIn:not([hidden])');
ok(await until(A.page, () => document.querySelector('#onair').dataset.state === 'synced'), 'signed in and synced');
const akashId = db.users.get('akash@hustl.invalid').id;
ok(db.notes.get(akashId + ':notes')?.body.endsWith('Idea 3: zine') && db.notes.get(akashId + ':reminders')?.body === 'Call mum at 6', 'notes and reminders reached the server');
ok([...db.tasks.values()].filter(t => t.priority && !t.deleted).length === 6, 'priority flags reached the server');

const B = await device('phone', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: 'dark' });
await signIn(B.page, 'akash');
await B.page.click('.radio-key[data-screen="tasks"]');
ok(await until(B.page, () => document.querySelector('#remindText').value === 'Call mum at 6'), 'the phone gets the reminders');
ok((await B.page.inputValue('#notesText')).endsWith('Idea 3: zine'), 'and the notes');
ok((await names(B.page, 'prioList')).length === 6, 'and the six top priorities');
const prioTop = await B.page.locator('.j-prio').boundingBox(), tasksTop = await B.page.locator('.j-tasks').boundingBox();
ok(prioTop.y < tasksTop.y, 'on a phone, Top Priorities comes first');
await B.page.screenshot({ path: path.join(shots, 'mobile-dark-16-daily-track.png'), fullPage: true });

await B.page.fill('#remindText', 'Call mum at 6\nPick up the dry cleaning');
await B.page.locator('#taskInput').focus();
ok(await until(A.page, () => document.querySelector('#remindText').value.includes('dry cleaning'), null, 8000), 'a change on the phone shows up on the laptop live');
await row(B.page, 'prioList', 'P6').locator('.task-prio').click();
ok(await until(A.page, () => [...document.querySelectorAll('#taskList .task-text span')].some(s => s.textContent === 'P6'), null, 8000), 'moving a priority back syncs too');

console.log('\n▶ typing is never overwritten');
await A.page.click('.radio-key[data-screen="tasks"]');
const kept = await A.page.evaluate(async () => {
  const el = document.querySelector('#notesText');
  el.focus(); el.value += ' (draft)';
  await window.Hustl.mergeNotes([{ kind: 'notes', body: 'From the phone', updated_at: new Date(Date.now() + 1000).toISOString() }]);
  return document.activeElement === el && el.value.includes('(draft)') && window.Hustl.state.notes.notes.body === 'From the phone';
});
ok(kept, 'a sync arriving while you type does not replace what you are typing');
await A.page.evaluate(() => document.querySelector('#notesText').blur());
ok(await A.page.evaluate(() => document.querySelector('#notesText').value === 'From the phone'), 'once you leave the box, the newer text shows');

console.log('\n▶ a database without the update (supabase-update.sql not run yet)');
fake.oldSchema = true;
const C = await device('old-db', { viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
await signIn(C.page, 'maya');
await C.page.waitForSelector('#acctSignedIn:not([hidden])');
await C.page.click('.radio-key[data-screen="tasks"]');
await add(C.page, 'Old-db task');
await add(C.page, 'Old-db priority', true);
await C.page.fill('#notesText', 'Kept on this device'); await C.page.locator('#taskInput').focus();
await C.page.evaluate(() => window.HustlSync.syncNow());
ok(await until(C.page, () => document.querySelector('#onair').dataset.state === 'synced'), 'sync still works (ON AIR "Synced")');
ok([...db.tasks.values()].some(t => t.text === 'Old-db task'), 'tasks still reach the server');
ok(await C.page.evaluate(() => window.Hustl.state.tasks.find(t => t.text === 'Old-db priority').priority) === true, 'priorities and notes stay on this device until the update is run');
await C.page.screenshot({ path: path.join(shots, 'desktop-dark-21-daily-track.png') });
fake.oldSchema = false;

ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
server.close();
console.log(state.failures ? `\n${state.failures} check(s) failed` : '\nAll checks passed');
process.exit(state.failures ? 1 : 0);
