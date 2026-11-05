// Checks: the app opens on the to-do list (list first on phones), and the fingerprint/face/PIN app lock.
// Uses Chrome's virtual WebAuthn authenticator in place of a real fingerprint reader.
// Run: node tests/lock.mjs   (screenshots land in tests/shots/)
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(root, 'tests', 'shots');
await fs.mkdir(shots, { recursive: true });

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/hustl/')) { res.writeHead(404); return res.end(); }
  const file = path.join(root, decodeURIComponent(url.pathname.slice(7)) || 'index.html');
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  try { const body = await fs.readFile(file); res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
// WebAuthn does not accept IP addresses as the relying party, so use "localhost".
const BASE = `http://localhost:${server.address().port}/hustl/`;

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); if (!cond) failures++; };
const browser = await chromium.launch();

for (const combo of [
  { name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { name: 'desktop', viewport: { width: 1280, height: 800 } },
]) {
  console.log(`\n▶ ${combo.name}`);
  const ctx = await browser.newContext({ ...combo, colorScheme: combo.name === 'mobile' ? 'light' : 'dark' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));

  // --- Opens on the to-do list, even with another screen in the URL
  await page.goto(BASE + '#settings');
  await page.evaluate(() => window.Hustl.ready);
  ok(await page.locator('#screen-tasks').isVisible(), 'app opens on the Tasks screen');
  ok(!(await page.locator('html').getAttribute('class') || '').includes('locked'), 'no lock screen when the lock is off');
  if (combo.name === 'mobile') {
    const list = await page.locator('.journal').boundingBox();
    const streak = await page.locator('#streakCard').boundingBox();
    ok(list.y < streak.y, 'on phones the Daily Track page comes before the turntable');
    ok(list.y < 844, 'the Daily Track page is visible on the first screen');
    ok(await page.locator('#heroStreak').isVisible(), 'header shows the streak chip on phones');
    await page.screenshot({ path: path.join(shots, 'mobile-light-4-list-first.png') });
  }

  // --- Virtual fingerprint reader
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true } });

  // --- Turn the lock on in Settings
  await page.click('.radio-key[data-screen="settings"]');
  await page.locator('#lockPanel .toggle').click();
  await page.waitForFunction(() => !!localStorage.getItem('hustl:lock'), null, { timeout: 5000 }).catch(() => {});
  ok(await page.evaluate(() => !!localStorage.getItem('hustl:lock')), 'lock turns on after the device verifies');
  ok(await page.locator('#lockToggle').isChecked(), 'toggle shows the lock is on');
  await page.click('[data-lock-after="0"]');
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem('hustl:lock')).after) === 0, '"Immediately" is saved');
  await page.locator('#lockPanel').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, `${combo.name}-5-lock-settings.png`) });

  // --- Reopen the app with a failed fingerprint: stays locked and content is hidden
  await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
  await page.reload();
  await page.waitForTimeout(800);
  ok((await page.locator('html').getAttribute('class') || '').includes('locked'), 'reopening the app shows the lock screen');
  ok(await page.locator('#lockScreen').isVisible(), 'lock screen is visible');
  ok(!(await page.locator('#taskInput').isVisible()), 'task list is hidden while locked');
  await page.click('#unlockBtn');
  await page.waitForTimeout(600);
  ok((await page.locator('html').getAttribute('class') || '').includes('locked'), 'a failed fingerprint keeps it locked');
  ok((await page.locator('#lockError').textContent()).length > 0, 'shows a friendly retry message');
  await page.screenshot({ path: path.join(shots, `${combo.name}-6-locked.png`) });

  // --- Correct fingerprint unlocks
  await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: true });
  await page.click('#unlockBtn');
  await page.waitForFunction(() => !document.documentElement.classList.contains('locked'), null, { timeout: 5000 }).catch(() => {});
  ok(!(await page.locator('html').getAttribute('class') || '').includes('locked'), 'a verified fingerprint unlocks the app');
  ok(await page.locator('#screen-tasks').isVisible(), 'unlocks straight into the to-do list');

  // --- Leaving the app with "Immediately" locks it again
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  ok((await page.locator('html').getAttribute('class') || '').includes('locked'), 'leaving the app locks it immediately');
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => !document.documentElement.classList.contains('locked'), null, { timeout: 5000 }).catch(() => {});
  ok(!(await page.locator('html').getAttribute('class') || '').includes('locked'), 'coming back asks for the fingerprint and unlocks');

  // --- Turning the lock off needs verification too
  await page.click('.radio-key[data-screen="settings"]');
  await page.locator('#lockPanel .toggle').click();
  await page.waitForFunction(() => !localStorage.getItem('hustl:lock'), null, { timeout: 5000 }).catch(() => {});
  ok(await page.evaluate(() => !localStorage.getItem('hustl:lock')), 'lock turns off after verifying');

  ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await ctx.close();
}

await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
