// Phase 2 checks: email sign-in + offline-first sync between two devices (laptop + phone).
// The Supabase client is swapped for tests/fake-supabase.js, backed by an in-memory server here that
// follows the same rules as supabase.sql (own rows only, last write wins, larger log count wins).
// Run: node tests/sync.mjs   (screenshots land in tests/shots/)
import { chromium } from 'playwright';
import path from 'node:path';
import { startServer, checker, device as makeDevice, signIn, shots } from './harness.mjs';
import { createFakeServer } from './fake-server.mjs';

const { server, base: BASE } = await startServer();
const fake = createFakeServer();
const db = fake.db;
const { ok, state } = checker();
const browser = await chromium.launch();
const errors = [];
const device = (name, opts) => makeDevice(browser, { name, base: BASE, fake, errors, ...opts });
const air = page => page.locator('#onair').getAttribute('data-state');
const airLabel = page => page.locator('#onair .onair-label').textContent();
const texts = page => page.evaluate(() => window.Hustl.state.tasks.filter(t => !t.deleted).map(t => t.text).sort());
const task = (page, text) => page.evaluate(t => window.Hustl.state.tasks.find(x => x.text === t), text);
async function add(page, text) {
  await page.fill('#taskInput', text); await page.press('#taskInput', 'Enter');
  await page.waitForFunction(t => window.Hustl.state.tasks.some(x => x.text === t), text);
}
async function card(page, text) {
  await page.click('.radio-key[data-screen="tasks"]');
  await page.click('.ftab[data-filter="all"]');
  return page.locator('.task', { hasText: text });
}
// Synced and settled: green with nothing queued, and still so a moment later (live updates can start another round).
async function synced(page) {
  const done = () => page.waitForFunction(() => document.querySelector('#onair').dataset.state === 'synced' && window.HustlSync.pending === 0, null, { timeout: 8000 }).catch(() => {});
  await done(); await page.waitForTimeout(400); await done();
  return (await air(page)) === 'synced';
}
async function syncNow(page) { await page.evaluate(() => window.HustlSync.syncNow()); return synced(page); }
const serverTexts = () => [...db.tasks.values()].filter(t => !t.deleted).map(t => t.text).sort();
const serverToday = () => { const d = new Date(); const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; return [...db.log.values()].find(r => r.day === k)?.count || 0; };

/* ---------------- Scenario ---------------- */
console.log('\n▶ laptop: works without an account');
const A = await device('laptop', { viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
ok((await air(A.page)) === 'offline' && (await airLabel(A.page)) === 'Local', 'ON AIR shows "Local" before signing in');
await add(A.page, 'Buy vinyl cleaner');
await add(A.page, 'Plan the setlist');
await (await card(A.page, 'Plan the setlist')).locator('.task-check').click();
ok((await texts(A.page)).length === 2, 'tasks saved locally with no account');

console.log('\n▶ laptop: create an account');
await A.page.click('.radio-key[data-screen="settings"]');
await A.page.locator('#accountPanel').scrollIntoViewIfNeeded();
await A.page.screenshot({ path: path.join(shots, 'desktop-light-7-signin.png') });
ok(await A.page.locator('#acctUser').isVisible() && await A.page.locator('#acctPassword').isVisible(), 'username and password boxes shown');
await A.page.fill('#acctUser', 'a b');
await A.page.fill('#acctPassword', 'hustl-pass-1');
await A.page.click('#acctCreate');
ok(await A.page.locator('.toast', { hasText: '3–20 letters' }).count() > 0, 'bad username → friendly message');
await A.page.fill('#acctUser', 'akash');
await A.page.fill('#acctPassword', 'short');
await A.page.click('#acctCreate');
ok(await A.page.locator('.toast', { hasText: 'at least 8 characters' }).count() > 0, 'short password → friendly message');
await A.page.fill('#acctPassword', 'hustl-pass-1');
await A.page.click('#acctCreate');
await A.page.waitForSelector('#acctSignedIn:not([hidden])');
ok(await synced(A.page), 'signed in → ON AIR turns green (synced)');
ok(JSON.stringify(serverTexts()) === JSON.stringify(['Buy vinyl cleaner', 'Plan the setlist']), 'local tasks were uploaded on first sign-in');
ok(serverToday() === 1, "today's completion count was uploaded");
await A.page.locator('#accountPanel').scrollIntoViewIfNeeded();
await A.page.screenshot({ path: path.join(shots, 'desktop-light-8-synced.png') });

console.log('\n▶ phone: signs in and gets the list');
const B = await device('phone', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: 'dark' });
await add(B.page, 'Phone-only task');
await signIn(B.page, 'akash');
await B.page.waitForSelector('#acctSignedIn:not([hidden])');
ok(await synced(B.page), 'phone synced');
ok(JSON.stringify(await texts(B.page)) === JSON.stringify(['Buy vinyl cleaner', 'Phone-only task', 'Plan the setlist']), 'phone has laptop tasks + its own');
ok(!!(await task(B.page, 'Plan the setlist')).done_at, 'completed state came across');
ok((await B.page.locator('#statToday').textContent()) === '1', "phone shows today's count from the laptop");
await (await card(B.page, 'Buy vinyl cleaner')).locator('.task-check').click();
ok(await syncNow(B.page), 'phone pushes its changes');
ok(serverToday() === 2, 'server log now has 2 for today');

console.log('\n▶ laptop picks up phone changes');
ok(await syncNow(A.page), 'laptop synced');
ok((await texts(A.page)).includes('Phone-only task'), "laptop sees the phone's new task");
ok(!!(await task(A.page, 'Buy vinyl cleaner')).done_at, 'laptop sees the task completed on the phone');
await A.page.click('.radio-key[data-screen="tasks"]');
ok((await A.page.locator('#statToday').textContent()) === '2', 'laptop streak stats updated (Done today = 2)');

console.log('\n▶ offline on the laptop');
await A.ctx.setOffline(true);
await A.page.waitForTimeout(100);
ok((await air(A.page)) === 'offline' && (await airLabel(A.page)) === 'Offline', 'ON AIR goes grey "Offline"');
await add(A.page, 'Written on the train');
ok((await texts(A.page)).includes('Written on the train'), 'adding a task offline works instantly');
ok(await A.page.waitForFunction(() => window.HustlSync.pending > 0, null, { timeout: 3000 }).then(() => true, () => false), 'the change is queued');
await A.page.click('.radio-key[data-screen="settings"]');
ok(await A.page.locator('#acctOffline').isVisible(), 'settings says "Radio\'s off… reconnect"');
await A.page.screenshot({ path: path.join(shots, 'desktop-light-9-offline.png') });
await A.ctx.setOffline(false);
ok(await synced(A.page), 'back online → syncs automatically');
ok(serverTexts().includes('Written on the train'), 'the offline task reached the server');
ok(await syncNow(B.page) && (await texts(B.page)).includes('Written on the train'), 'and the phone gets it');

console.log('\n▶ conflict: last write wins');
await A.ctx.setOffline(true);
await (await card(A.page, 'Plan the setlist')).locator('.task-del').click();   // laptop deletes (earlier)
await A.page.waitForTimeout(600);
await B.page.waitForTimeout(50);
await (await card(B.page, 'Plan the setlist')).locator('.task-check').click(); // phone un-checks (later)
ok(await syncNow(B.page), 'phone syncs its later edit');
await A.ctx.setOffline(false);
ok(await synced(A.page), 'laptop comes back online and syncs');
const p1 = await task(A.page, 'Plan the setlist');
ok(p1 && !p1.deleted && !p1.done_at, "the phone's later edit won on the laptop (not deleted, not done)");
const s1 = [...db.tasks.values()].find(t => t.text === 'Plan the setlist');
ok(!s1.deleted && !s1.done_at, 'server kept the later edit');
await syncNow(B.page); await syncNow(A.page);
ok(JSON.stringify(await texts(A.page)) === JSON.stringify(await texts(B.page)), 'both devices end up with the same list');
ok((await A.page.locator('#statToday').textContent()) === (await B.page.locator('#statToday').textContent()), 'both devices agree on the log (larger count per day)');

console.log('\n▶ sign out');
await B.page.click('.radio-key[data-screen="settings"]');
await B.page.locator('#accountPanel').scrollIntoViewIfNeeded();
await B.page.waitForTimeout(300);
await B.page.screenshot({ path: path.join(shots, 'mobile-dark-8-synced.png') });
await B.page.click('#acctSignOut');
await B.page.waitForSelector('#acctSignin:not([hidden])');
ok((await airLabel(B.page)) === 'Local', 'ON AIR back to "Local"');
ok((await texts(B.page)).length >= 3, 'tasks stay on the device after signing out');

console.log('\n▶ sign in again on the phone');
await B.page.fill('#acctUser', 'Akash');
await B.page.fill('#acctPassword', 'hustl-pass-1');
await B.page.click('#acctCreate');
ok(await B.page.locator('.toast', { hasText: 'username is taken' }).count() > 0, 'Create account with a taken username → "taken"');
await B.page.fill('#acctPassword', 'wrong-pass-1');
await B.page.press('#acctPassword', 'Enter');
await B.page.waitForSelector('.toast:has-text("Wrong username or password")');
ok(await B.page.locator('#acctSignin').isVisible(), 'wrong password → "Wrong username or password.", still signed out');
await B.page.screenshot({ path: path.join(shots, 'mobile-dark-11-signin.png') });
await B.page.fill('#acctPassword', 'hustl-pass-1');
await B.page.click('#acctGo');
await B.page.waitForSelector('#acctSignedIn:not([hidden])');
ok(await synced(B.page), 'right password → signed in, ON AIR "Synced"');
ok((await B.page.textContent('#acctEmailShow')) === 'akash', 'shows "Signed in as akash"');
ok((await B.page.inputValue('#acctPassword')) === '', 'password cleared from the form');

console.log('\n▶ a different account on the same phone');
await B.page.click('.radio-key[data-screen="settings"]');
await B.page.click('#acctSignOut');
await signIn(B.page, 'maya');
await B.page.waitForSelector('#acctSignedIn:not([hidden])');
ok(await synced(B.page), 'second account syncs (not stuck on "Paused")');

ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
server.close();
console.log(state.failures ? `\n${state.failures} check(s) failed` : '\nAll checks passed');
process.exit(state.failures ? 1 : 0);
