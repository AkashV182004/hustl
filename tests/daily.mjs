// Daily tasks vs "just today" tasks, across midnight (with a controllable clock), on a phone.
// Run: node tests/daily.mjs
import { chromium, devices } from 'playwright';
import path from 'node:path';
import { startServer, checker, device as makeDevice, signIn, shots } from './harness.mjs';
import { createFakeServer } from './fake-server.mjs';

const { server, base } = await startServer();
const fake = createFakeServer();
const db = fake.db;
const { ok, state } = checker();
const browser = await chromium.launch();
const errors = [];
const { defaultBrowserType, ...pixel } = devices['Pixel 7'];
const device = (name, opts = {}) => makeDevice(browser, { name, base, fake, errors, ...pixel, ...opts });
const until = (page, fn, arg, ms = 6000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);
const names = page => page.evaluate(() => [...document.querySelectorAll('#taskList .task .task-text > span:first-child')].map(s => s.textContent));
const task = (page, text) => page.evaluate(t => window.Hustl.state.tasks.find(x => x.text === t && !x.deleted) || null, text);
const tick = async (page, text) => { await page.locator('#taskList .task', { hasText: text }).locator('.task-check').click(); await page.waitForTimeout(900); };
const showAll = page => page.click('.ftab[data-filter="all"]');

const { page } = await device('phone');
// start the day at 10:00 on Fri 6 Nov 2026 (local time), with a clock the test can move forward
await page.clock.install({ time: new Date(2026, 10, 6, 10, 0, 0) });
// a task saved by an older version (no "day"), added 3 days ago and not finished
await page.evaluate(() => window.Hustl.store.putTasks([{ id: crypto.randomUUID(), text: 'Old unfinished task', created_at: new Date(Date.now() - 3 * 864e5).toISOString(),
  done_at: null, updated_at: new Date(Date.now() - 3 * 864e5).toISOString(), deleted: false }]));
await page.reload(); await page.evaluate(() => window.Hustl.ready);

console.log('\n▶ adding: "Just today" or "Daily task"');
ok((await names(page)).includes('Old unfinished task'), 'a task from before this update is still there today (nothing is wiped)');
await page.click('#taskInput');
await page.fill('#taskInput', 'Morning run');
ok(await page.locator('.kind-row').isVisible(), 'while you write a task it asks: "Add as: Just today / ↻ Daily task"');
ok((await page.getAttribute('.kind-btn[data-kind="once"]', 'aria-checked')) === 'true', '"Just today" is the default');
await page.screenshot({ path: path.join(shots, 'phone-android-add-daily.png') });
await page.click('.kind-btn[data-kind="daily"]');
ok(await until(page, () => window.Hustl.state.tasks.some(t => t.text === 'Morning run' && t.daily)), 'tapping "↻ Daily task" adds it as a daily task');
ok(await until(page, () => [...document.querySelectorAll('#taskList .task.daily')].some(li => li.textContent.includes('Morning run') && li.querySelector('.daily-tag'))), 'it shows a "↻ Daily" tag');
ok(await until(page, () => [...document.querySelectorAll('.toast')].some(t => t.textContent.includes('every day until you remove it'))), 'and says it will be there every day');
ok(await until(page, () => document.querySelector('.kind-btn[data-kind="once"]').getAttribute('aria-checked') === 'true'), 'the choice goes back to "Just today" for the next task');
await page.fill('#taskInput', 'Buy milk'); await page.press('#taskInput', 'Enter');
ok(await until(page, () => window.Hustl.state.tasks.some(t => t.text === 'Buy milk' && !t.daily && t.day === '2026-11-06')), 'Enter adds a "just today" task (for today, 6 Nov)');
await page.fill('#taskInput', 'Stretch'); await page.click('.kind-btn[data-kind="daily"]');
await until(page, () => window.Hustl.state.tasks.some(t => t.text === 'Stretch' && t.daily));

console.log('\n▶ ticking them today');
await tick(page, 'Morning run'); await tick(page, 'Buy milk');
ok((await page.locator('#statToday').textContent()) === '2', 'both count towards today');
await showAll(page);
await page.screenshot({ path: path.join(shots, 'phone-android-daily-today.png') });

console.log('\n▶ the next day (midnight passes)');
await page.clock.fastForward('14:01:00');   // → Sat 7 Nov, 00:01
ok(await until(page, () => !window.Hustl.state.tasks.some(t => t.text === 'Buy milk' && !t.deleted)), '"Buy milk" (just today) has vanished');
ok(!(await names(page)).includes('Old unfinished task'), 'so has the old one-off task');
const run = await task(page, 'Morning run');
ok(!!run && !(await page.evaluate(id => window.Hustl.isDone(window.Hustl.state.tasks.find(t => t.id === id)), run.id)), '"Morning run" (daily) is back, unticked');
ok((await names(page)).includes('Stretch') && (await names(page)).includes('Morning run'), 'every daily task is on the list');
ok(await page.evaluate(() => window.Hustl.state.log['2026-11-06']) === 2, "yesterday's 2 ticks stay in your streak history");
ok((await page.locator('#jDate').textContent()).includes('7'), 'the page shows the new date');
await tick(page, 'Morning run');
ok(await page.evaluate(() => window.Hustl.state.log['2026-11-07']) === 1, 'ticking it again counts for today');
ok((await page.locator('#heroStreakText').textContent()).includes('2-day streak'), 'and the streak goes on (2 days)');
ok(await page.locator('#clearDone').isDisabled(), '"Clear completed" leaves daily tasks alone (nothing to clear)');
ok(!!(await task(page, 'Morning run')), 'the ticked daily task stays on the list');

console.log('\n▶ removing a daily task');
await page.locator('#taskList .task', { hasText: 'Stretch' }).locator('.task-del').click();
ok(await until(page, () => [...document.querySelectorAll('.toast')].some(t => t.textContent.includes('won’t come back'))), 'removing it says it won’t come back');
await page.locator('.toast', { hasText: 'won’t come back' }).getByRole('button', { name: 'Undo' }).click();
ok(await until(page, () => [...document.querySelectorAll('#taskList .task-text > span:first-child')].some(s => s.textContent === 'Stretch')), 'Undo puts it back');
await page.waitForTimeout(500);
await page.locator('#taskList .task', { hasText: 'Stretch' }).locator('.task-del').click();
await page.waitForTimeout(600);
await page.clock.fastForward('24:00:00');   // → Sun 8 Nov
ok(await until(page, () => !!window.Hustl.state.tasks.find(t => t.text === 'Morning run' && !t.deleted)) && !(await names(page)).includes('Stretch'), 'a removed daily task does not come back the next day; the others do');
await page.screenshot({ path: path.join(shots, 'phone-android-daily-next-day.png') });

console.log('\n▶ on your other devices');
await signIn(page, 'akash');
await page.waitForSelector('#acctSignedIn:not([hidden])');
ok(await until(page, () => document.querySelector('#onair').dataset.state === 'synced'), 'synced');
ok([...db.tasks.values()].some(t => t.text === 'Morning run' && t.daily === true && !t.deleted), 'the daily task is saved on the server as daily');
const { page: p2 } = await device('tablet');
await signIn(p2, 'akash');
await p2.click('.radio-key[data-screen="tasks"]');
ok(await until(p2, () => !!document.querySelector('#taskList .task.daily')), 'another device shows it as a daily task too');

console.log('\n▶ a database without the update');
fake.oldSchema = true;
const { page: p3 } = await device('old-db');
await signIn(p3, 'maya');
await p3.waitForSelector('#acctSignedIn:not([hidden])');
await p3.click('.radio-key[data-screen="tasks"]');
await p3.fill('#taskInput', 'Water plants'); await p3.click('.kind-btn[data-kind="daily"]');
await until(p3, () => window.Hustl.state.tasks.some(t => t.text === 'Water plants'));
await p3.evaluate(() => window.HustlSync.syncNow());
ok(await until(p3, () => document.querySelector('#onair').dataset.state === 'synced'), 'sync still works');
ok([...db.tasks.values()].some(t => t.text === 'Water plants'), 'the task reaches the server');
ok(await p3.evaluate(() => window.Hustl.state.tasks.find(t => t.text === 'Water plants').daily) === true, 'and stays daily on this device until the update is run');
fake.oldSchema = false;

ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
server.close();
console.log(state.failures ? `\n${state.failures} check(s) failed` : '\nAll checks passed');
process.exit(state.failures ? 1 : 0);
