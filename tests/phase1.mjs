// Phase 1 checks: tasks, streak, offline reload, console errors — desktop + mobile, light + dark.
// Run: node tests/phase1.mjs   (screenshots land in tests/shots/)
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(root, 'tests', 'shots');
await fs.mkdir(shots, { recursive: true });

// Static server that mimics GitHub Pages serving the app from a subfolder.
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/hustl/')) { res.writeHead(404); return res.end(); }
  let p = decodeURIComponent(url.pathname.slice('/hustl/'.length)) || 'index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/hustl/`;

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); if (!cond) failures++; };
const pad = n => String(n).padStart(2, '0');
const key = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return key(d); };

const browser = await chromium.launch();
const combos = [
  { name: 'desktop', viewport: { width: 1280, height: 800 } },
  { name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
];

for (const combo of combos) for (const scheme of ['light', 'dark']) {
  const tag = `${combo.name}-${scheme}`;
  console.log(`\n▶ ${tag}`);
  const ctx = await browser.newContext({ viewport: combo.viewport, isMobile: combo.isMobile, hasTouch: combo.hasTouch,
    deviceScaleFactor: combo.deviceScaleFactor || 1, colorScheme: scheme });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));

  await page.goto(BASE);
  await page.evaluate(() => window.Hustl.ready);

  // Empty state
  ok(await page.locator('#emptyState').isVisible(), 'empty state shows on first run');
  if (scheme === 'light') await page.screenshot({ path: path.join(shots, `${tag}-0-empty.png`) });

  // --- Seeded 3-day log ending yesterday → "at risk" with 3
  await page.evaluate(log => window.Hustl.mergeData({ log }), { [daysAgo(3)]: 2, [daysAgo(2)]: 4, [daysAgo(1)]: 1, [daysAgo(6)]: 3 });
  await page.reload(); await page.evaluate(() => window.Hustl.ready);
  ok(await page.locator('#streakCard').getAttribute('data-state') === 'at-risk', 'seeded 3-day log ending yesterday → at-risk');
  ok((await page.locator('#streakNum').textContent()) === '3', 'streak number is 3');
  ok(/Complete a task today or lose it! \(\d+h left\)/.test(await page.locator('#streakMsg').textContent()), 'at-risk message with hours left');
  await page.screenshot({ path: path.join(shots, `${tag}-1-at-risk.png`) });

  // --- Add tasks (Enter adds, newest on top)
  const tasks = ['Restring the old guitar', 'Pay the electricity bill', 'Call grandma <b>back</b>', 'Write three pages of the novel', 'Water the fern by the record player'];
  for (const t of tasks) { await page.fill('#taskInput', t); await page.press('#taskInput', 'Enter'); }
  await page.waitForFunction(n => document.querySelectorAll('.task').length === n, tasks.length, { timeout: 3000 }).catch(() => {});
  ok((await page.locator('.task').count()) === 5, 'five tasks added');
  ok((await page.locator('.task .task-text').first().textContent()) === tasks[4], 'newest task is on top');
  ok((await page.locator('.task b').count()) === 0, 'task text is escaped (no HTML injection)');

  // --- Complete one → streak goes up to 4 and becomes active
  await page.locator('.task').nth(4).locator('.task-check').click();
  await page.waitForTimeout(100);
  ok(await page.locator('#streakCard').getAttribute('data-state') === 'active', 'completing a task → active');
  ok((await page.locator('#streakNum').textContent()) === '4', 'streak went up to 4');
  ok((await page.locator('#statToday').textContent()) === '1', 'Done today = 1');
  await page.locator('.task').nth(1).locator('.task-check').click();
  await page.waitForTimeout(1400);
  ok((await page.locator('.task').count()) === 3, 'completed tasks leave the Active tab');
  ok((await page.locator('#leftCount').textContent()) === '3 tasks left', 'footer shows 3 tasks left');

  // --- All tab for the hero screenshot
  await page.click('.ftab[data-filter="all"]');
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(shots, `${tag}-2-active.png`), fullPage: combo.name === 'mobile' });

  // --- Un-check → log −1 on the day completed; then delete; Clear completed keeps the log
  await page.locator('.task.done').first().locator('.task-check').click();
  await page.waitForFunction(() => document.querySelector('#statToday').textContent === '1', null, { timeout: 3000 }).catch(() => {});
  ok((await page.locator('#statToday').textContent()) === '1', 'un-checking takes 1 off today');
  await page.locator('.task').first().locator('.task-del').click();
  await page.waitForTimeout(600);
  ok((await page.locator('.task').count()) === 4, 'delete removes the card');
  await page.click('#clearDone');
  await page.waitForTimeout(300);
  ok((await page.locator('#statToday').textContent()) === '1', 'Clear completed does not change the log');
  ok(await page.locator('#streakCard').getAttribute('data-state') === 'active', 'streak still active after clearing');

  // --- Settings + chats screenshots (light only, to keep the set small)
  if (scheme === 'dark' || combo.name === 'desktop') {
    await page.click('.radio-key[data-screen="settings"]');
    await page.screenshot({ path: path.join(shots, `${tag}-3-settings.png`) });
    await page.click('.radio-key[data-screen="tasks"]');
  }

  // --- Offline reload
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) { await page.reload(); await page.evaluate(() => window.Hustl.ready); }
  ok(await page.evaluate(() => !!navigator.serviceWorker.controller), 'service worker controls the page');
  await ctx.setOffline(true);
  await page.reload();
  await page.evaluate(() => window.Hustl.ready);
  ok((await page.locator('.task').count()) >= 1, 'offline reload still shows tasks');
  ok((await page.locator('#onair').getAttribute('data-state')) === 'offline', 'ON AIR light is grey offline');
  ok(await page.evaluate(() => document.fonts.check('16px "Inter"')), 'bundled fonts load offline');
  await ctx.setOffline(false);

  ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await ctx.close();
}

// Reduced motion: the record must not spin
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto(BASE); await page.evaluate(() => window.Hustl.ready);
  await page.fill('#taskInput', 'Test'); await page.press('#taskInput', 'Enter');
  await page.locator('.task-check').first().click();
  ok(await page.locator('#record').evaluate(el => getComputedStyle(el).animationName) === 'none', '\nreduced motion: record does not spin');
  await ctx.close();
}

await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
