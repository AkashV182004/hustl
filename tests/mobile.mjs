// Phone checks: Hustl on an Android phone (Pixel 7) and an iPhone 14 — fits the screen, big enough to tap,
// no zoom when typing, the install / "turn on alarms" card, Back closes pop-ups and returns to the list,
// home-screen shortcut, manifest. Run: node tests/mobile.mjs
import { chromium, devices } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, checker, device as makeDevice, shots } from './harness.mjs';
import { createFakeServer } from './fake-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { server, base } = await startServer();
const fake = createFakeServer();
const { ok, state } = checker();
const browser = await chromium.launch();
const errors = [];
const until = (page, fn, arg, ms = 6000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);
const phone = (name, preset, opts = {}) => {
  const { defaultBrowserType, ...d } = devices[preset];
  return makeDevice(browser, { name, base, fake, errors, ...d, ...opts });
};

console.log('\n▶ manifest');
const man = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
ok(man.display === 'standalone' && man.orientation === 'portrait', 'opens full screen, in portrait, like a phone app');
ok(man.shortcuts?.some(s => s.url.includes('go=reminder')), 'long-press the app icon → "Set a reminder" shortcut');
ok(man.icons.some(i => i.purpose === 'maskable'), 'icon that fits Android icon shapes (maskable)');

for (const [label, preset] of [['Android', 'Pixel 7'], ['iPhone', 'iPhone 14']]) {
  console.log(`\n▶ ${label} (${preset})`);
  const { page } = await phone(label, preset, { colorScheme: label === 'iPhone' ? 'dark' : 'light' });

  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
  ok(fits, 'fits the screen width (no sideways scrolling)');
  ok(await page.locator('#screen-tasks').isVisible(), 'opens on the to-do page');

  const card = await page.locator('#phoneCard').isVisible() && await page.locator('#phoneCardTitle').textContent();
  ok(label === 'iPhone' ? card === 'Add Hustl to your Home Screen' : card === 'Install Hustl on your phone', `top card: "${card}"`);
  await page.click('#phoneCardGo');
  ok(await until(page, l => [...document.querySelectorAll('.toast')].some(t => t.textContent.includes(l)), label === 'iPhone' ? 'Add to Home Screen' : 'Install app'), 'its button explains how to install');
  await page.click('#phoneCardClose');
  ok(await page.locator('#phoneCard').isHidden(), '"Not now" hides it');
  await page.reload(); await page.evaluate(() => window.Hustl.ready);
  ok(await page.locator('#phoneCard').isHidden(), 'and it stays hidden after reopening');

  // inputs: 16px or more, so iPhone doesn't zoom in when you tap one
  const small = await page.evaluate(() => [...document.querySelectorAll('input:not([type=hidden]):not([type=file]), textarea')]
    .filter(el => el.offsetParent !== null && parseFloat(getComputedStyle(el).fontSize) < 16).map(el => el.id || el.className));
  ok(small.length === 0, 'every text box is 16px+ (no zoom-in when typing)' + (small.length ? `: ${small.join(', ')}` : ''));

  // tap targets on the page you use most
  const tiny = await page.evaluate(() => [...document.querySelectorAll('#screen-tasks button, .radio-nav button')]
    .filter(b => b.offsetParent !== null && !b.closest('[hidden]'))
    .map(b => { const r = b.getBoundingClientRect(); return { id: b.id || b.className || b.textContent.trim().slice(0, 20), h: r.height, w: r.width }; })
    .filter(r => r.h < 36 || r.w < 36));
  ok(tiny.length === 0, 'buttons are big enough to tap (36px+)' + (tiny.length ? ': ' + JSON.stringify(tiny.slice(0, 4)) : ''));

  await page.fill('#taskInput', 'Phone task'); await page.press('#taskInput', 'Enter');
  ok(await until(page, () => window.Hustl.state.tasks.some(t => t.text === 'Phone task')), 'adding a task works with the phone keyboard');

  console.log('  — Back button');
  await page.click('.radio-key[data-screen="settings"]');
  ok(await page.locator('#screen-settings').isVisible(), 'Settings opens');
  await page.goBack();
  ok(await until(page, () => !document.querySelector('#screen-tasks').hidden), 'Back returns to the to-do page (instead of leaving the app)');
  await page.evaluate(() => window.Hustl.addAlarm('Back button test', new Date(Date.now() + 1500)));
  ok(await until(page, () => document.querySelector('#alarmDlg').open), 'a reminder pops up');
  await page.goBack();
  ok(await until(page, () => !document.querySelector('#alarmDlg').open), 'Back closes the pop-up');
  ok(await page.locator('#screen-tasks').isVisible() && page.url().startsWith(base), 'and you are still in the app, on the to-do page');

  console.log('  — home-screen shortcut');
  await page.goto(base + '?go=reminder#tasks'); await page.evaluate(() => window.Hustl.ready);
  ok(await until(page, () => document.activeElement && document.activeElement.id === 'alarmText'), '"Set a reminder" opens straight on the reminder box');
  ok(!page.url().includes('go='), 'and tidies the address');
  await page.screenshot({ path: path.join(shots, `phone-${label.toLowerCase()}-reminder-shortcut.png`) });

  await page.goto(base); await page.evaluate(() => window.Hustl.ready);
  await page.screenshot({ path: path.join(shots, `phone-${label.toLowerCase()}-tasks.png`) });
}

console.log('\n▶ turning on reminder alarms (installed app)');
// pretend to be the installed app (standalone) with notifications not decided yet
const installed = () => {
  const mm = window.matchMedia.bind(window);
  window.matchMedia = q => (q.includes('display-mode: standalone') ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} } : mm(q));
  window.__asked = 0;
  window.Notification = class { static permission = 'default'; static async requestPermission() { window.__asked++; window.Notification.permission = 'granted'; return 'granted'; } constructor() {} close() {} };
};
const { page: app } = await makeDevice(browser, { name: 'installed', base, fake, errors, ...(({ defaultBrowserType, ...d }) => d)(devices['Pixel 7']), init: installed });
ok((await app.locator('#phoneCardTitle').textContent()) === 'Turn on reminder alarms', 'installed app: the card asks to turn on reminder alarms');
await app.screenshot({ path: path.join(shots, 'phone-android-turn-on-alarms.png') });
await app.click('#phoneCardGo');
ok(await until(app, () => window.__asked === 1), 'tapping "Turn on" asks for notification permission');
ok(await until(app, () => document.querySelector('#phoneCard').hidden), 'once allowed, the card goes away');

ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
server.close();
console.log(state.failures ? `\n${state.failures} check(s) failed` : '\nAll checks passed');
process.exit(state.failures ? 1 : 0);
