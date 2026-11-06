// Hustl AI tab on a phone: signed out / offline states, suggestions, sending what the app knows,
// carrying out the assistant's actions (task, daily task, priority, tick, reminder, delete) with cards, photos,
// errors and the daily limit, saved chat, safe text. The "ai" function is a scripted stand-in here.
// Run: node tests/ai.mjs
import { chromium, devices } from 'playwright';
import path from 'node:path';
import { startServer, checker, device as makeDevice, signIn, shots } from './harness.mjs';
import { createFakeServer } from './fake-server.mjs';

const { server, base } = await startServer();
const fake = createFakeServer();
const { ok, state } = checker();
const browser = await chromium.launch();
const errors = [];
const { defaultBrowserType, ...pixel } = devices['Pixel 7'];
const until = (page, fn, arg, ms = 6000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);
const bubbles = page => page.locator('#aiLog .ai-msg:not(.typing) p').allTextContents();
const cards = page => page.locator('#aiLog .ai-card').allTextContents();

const { page, ctx } = await makeDevice(browser, { name: 'phone', base, fake, errors, ...pixel, colorScheme: 'light' });

console.log('\n▶ the AI tab');
ok(await page.locator('.radio-key[data-screen="ai"]').isVisible(), 'an "AI" button in the bottom menu');
await page.click('.radio-key[data-screen="ai"]');
ok(await page.locator('#screen-ai').isVisible(), 'it opens the Hustl AI tab');
ok(await page.locator('#aiSignedOut').isVisible(), 'signed out → asks you to sign in first');
const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
ok(fits, 'four menu buttons still fit the phone screen');

await signIn(page, 'akash');
await page.waitForSelector('#acctSignedIn:not([hidden])');
await page.click('.radio-key[data-screen="ai"]');
ok(await page.locator('#aiChat').isVisible() && (await bubbles(page))[0].includes('I’m Hustl AI'), 'signed in → a greeting');
ok(await page.locator('#aiSuggest .chip').count() === 4, 'with suggestions to tap');
await page.screenshot({ path: path.join(shots, 'phone-android-ai-start.png') });

console.log('\n▶ "Plan my day" (a suggestion)');
await page.evaluate(() => window.Hustl.addTask('Buy milk'));
fake.ai = body => ({ json: { text: 'Here’s a plan:\n- **Buy milk** first\n- Then rest', actions: [], remaining: 999 } });
await page.click('#aiSuggest .chip[data-say="Plan my day"]');
ok(await until(page, () => document.querySelectorAll('#aiLog .ai-msg.bot:not(.hello):not(.typing)').length === 1), 'the answer appears');
const call = fake.aiCalls.at(-1);
ok(call.auth === 'Bearer tok-' + fake.db.users.get('akash@hustl.invalid').id, 'sent signed in (for the daily limit)');
ok(call.body.messages.at(-1).text === 'Plan my day' && call.body.context.tasks.some(t => t.text === 'Buy milk'), 'with your message and your tasks');
ok(/[+-]\d\d:\d\d$/.test(call.body.context.now) && call.body.context.tz, `and your local time and time zone (${call.body.context.now}, ${call.body.context.tz})`);
ok(await page.locator('#aiLog .ai-msg.bot b', { hasText: 'Buy milk' }).count() === 1, '**bold** shows as bold');
ok((await bubbles(page)).at(-1).includes('• Then rest'), 'bullets show as •');
ok(await page.locator('#aiSuggest').isHidden(), 'suggestions step aside once you are chatting');

console.log('\n▶ it changes your lists');
const milk = await page.evaluate(() => window.Hustl.state.tasks.find(t => t.text === 'Buy milk').id);
fake.ai = body => {
  const due = new Date(Date.now() + 3 * 3600e3).toISOString();
  return { json: { text: 'All set!', remaining: 998, actions: [
    { name: 'add_task', args: { text: 'Call the plumber' } },
    { name: 'add_task', args: { text: '10 push-ups', daily: true } },
    { name: 'add_task', args: { text: 'Finish report', priority: true } },
    { name: 'complete_task', args: { task_id: milk } },
    { name: 'add_reminder', args: { text: 'Drink water', due_at: due } },
    { name: 'complete_task', args: { task_id: 'no-such-task' } },
  ] } };
};
await page.fill('#aiText', 'Add plumber, daily push-ups, report as priority, tick milk and remind me to drink water in 3 hours');
await page.click('#aiSend');
ok(await until(page, () => document.querySelectorAll('#aiLog .ai-card').length >= 6), 'each action shows as a card');
const c = await cards(page);
ok(c.some(x => x === '✓ Task added: Call the plumber'), '✓ Task added');
ok(c.some(x => x === '↻ Daily task added: 10 push-ups'), '↻ Daily task added');
ok(c.some(x => x === '⚡ Top priority: Finish report'), '⚡ Top priority');
ok(c.some(x => x === '☑ Ticked: Buy milk'), '☑ Ticked');
ok(c.some(x => x.startsWith('⏰ Reminder set: Drink water ·')), '⏰ Reminder set (with its time)');
ok(c.some(x => x.startsWith('⚠') && x.includes('Couldn’t find that task')), 'something it got wrong shows as a warning, not a crash');
const s = await page.evaluate(() => ({
  plumber: window.Hustl.state.tasks.find(t => t.text === 'Call the plumber'), push: window.Hustl.state.tasks.find(t => t.text === '10 push-ups'),
  report: window.Hustl.state.tasks.find(t => t.text === 'Finish report'), milkDone: window.Hustl.isDone(window.Hustl.state.tasks.find(t => t.text === 'Buy milk')),
  water: window.Hustl.state.alarms.find(a => a.text === 'Drink water'),
}));
ok(s.plumber && !s.plumber.daily && s.push && s.push.daily && s.report && s.report.priority && s.milkDone && s.water, 'the lists really changed (task, daily task, priority, tick, alarm)');
await page.click('.radio-key[data-screen="tasks"]');
ok(await page.locator('#taskList .task', { hasText: '10 push-ups' }).locator('.daily-tag').isVisible(), 'and the Tasks page shows them');
await page.click('.radio-key[data-screen="ai"]');
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(shots, 'phone-android-ai-actions.png') });

console.log('\n▶ what the model is told next time');
fake.ai = body => ({ json: { text: 'You did great today.', actions: [] } });
await page.fill('#aiText', 'How am I doing?'); await page.click('#aiSend');
await until(page, () => [...document.querySelectorAll('#aiLog .ai-msg.bot p')].some(p => p.textContent === 'You did great today.'));
const hist = fake.aiCalls.at(-1).body.messages;
ok(hist.some(m => m.role === 'model' && m.text.includes('[✓ Task added: Call the plumber')), 'its earlier actions are written into the history, so it knows what was done');

console.log('\n▶ errors and limits');
fake.ai = () => ({ status: 429, json: { error: 'limit', message: 'That’s today’s 1000 Hustl AI messages. More tomorrow!' } });
await page.fill('#aiText', 'One more?'); await page.click('#aiSend');
ok(await until(page, () => [...document.querySelectorAll('#aiLog .ai-msg.error p')].some(p => p.textContent.includes('More tomorrow'))), 'daily limit reached → "More tomorrow!"');
fake.ai = () => ({ status: 503, json: { error: 'not_configured', message: 'Hustl AI isn’t set up yet.' } });
await page.fill('#aiText', 'Hello?'); await page.click('#aiSend');
ok(await until(page, () => [...document.querySelectorAll('#aiLog .ai-msg.error p')].some(p => p.textContent.includes('isn’t set up yet'))), 'not set up on the server → says so');
ok(!fake.aiCalls.at(-1).body.messages.some(m => m.text.includes('More tomorrow')), 'error messages are not sent back to the model');
await ctx.setOffline(true);
ok(await until(page, () => !document.querySelector('#aiOffline').hidden), 'offline → "needs an internet connection"');
const before = fake.aiCalls.length;
await page.fill('#aiText', 'Are you there?'); await page.click('#aiSend');
await page.waitForTimeout(300);
ok(fake.aiCalls.length === before, 'and nothing is sent while offline');
await ctx.setOffline(false);

console.log('\n▶ safe text');
fake.ai = () => ({ json: { text: '<img src=x onerror="window.__pwned=1"> **hi**', actions: [] } });
await page.fill('#aiText', '<b>bold?</b>'); await page.click('#aiSend');
await until(page, () => [...document.querySelectorAll('#aiLog .ai-msg.bot p')].some(p => p.textContent.includes('<img')));
ok(!(await page.evaluate(() => window.__pwned)) && await page.locator('#aiLog img').count() === 0, 'HTML from the AI or from you is shown as text, never run');

console.log('\n▶ saved on the device');
const n = (await bubbles(page)).length;
await page.reload(); await page.evaluate(() => window.Hustl.ready);
await page.click('.radio-key[data-screen="ai"]');
ok(await until(page, n => document.querySelectorAll('#aiLog .ai-msg p').length === n, n), 'the conversation is still there after reopening');
await page.click('#aiClear');
ok(await until(page, () => document.querySelectorAll('#aiLog .ai-msg').length === 1 && !document.querySelector('#aiSuggest').hidden), '"Clear chat" starts fresh');

console.log('\n▶ photos');
ok(await page.locator('#aiCamera').isVisible(), 'a camera button next to the message box');
ok(await page.locator('#aiPhotoInput').getAttribute('accept') === 'image/*' && !(await page.locator('#aiPhotoInput').getAttribute('capture')),
  'it lets the phone offer "Take photo" or the gallery');
// a real 3000×2000 PNG, made in the page
const png = Buffer.from(await page.evaluate(() => {
  const c = document.createElement('canvas'); c.width = 3000; c.height = 2000;
  const g = c.getContext('2d'); g.fillStyle = '#2a6'; g.fillRect(0, 0, 3000, 2000); g.fillStyle = '#fff'; g.font = '200px sans-serif'; g.fillText('Buy eggs', 300, 1000);
  return c.toDataURL('image/png').split(',')[1];
}), 'base64');
await page.setInputFiles('#aiPhotoInput', { name: 'list.png', mimeType: 'image/png', buffer: png });
ok(await until(page, () => !document.querySelector('#aiAttach').hidden && document.querySelector('#aiAttachImg').src.startsWith('data:image/jpeg')), 'after taking a photo it shows a preview before sending');
await page.screenshot({ path: path.join(shots, 'phone-android-ai-photo-ready.png') });
await page.click('#aiAttachRemove');
ok(await page.locator('#aiAttach').isHidden() && (await page.evaluate(() => window.HustlAI.photo)) === null, '✕ removes it again');

await page.setInputFiles('#aiPhotoInput', { name: 'list.png', mimeType: 'image/png', buffer: png });
await until(page, () => !document.querySelector('#aiAttach').hidden);
fake.ai = body => ({ json: { text: 'It says **Buy eggs**. Want me to add it as a task?', actions: [] } });
let callsBefore = fake.aiCalls.length;
await page.fill('#aiText', 'What does this say?'); await page.click('#aiSend');
await until(page, () => [...document.querySelectorAll('#aiLog .ai-msg.bot p')].some(p => p.textContent.includes('Buy eggs')));
let sent = fake.aiCalls.at(-1).body;
ok(fake.aiCalls.length === callsBefore + 1 && sent.image && sent.image.mime === 'image/jpeg' && sent.image.data.startsWith('/9j/'), 'the photo is sent with the message (as a JPEG)');
const size = await page.evaluate(d => new Promise(r => { const i = new Image(); i.onload = () => r([i.naturalWidth, i.naturalHeight]); i.src = 'data:image/jpeg;base64,' + d; }), sent.image.data);
ok(size[0] === 1280 && size[1] === 853, `shrunk on the phone first (3000×2000 → ${size.join('×')})`);
ok(sent.image.data.length < 1_000_000, `small enough to send quickly (${Math.round(sent.image.data.length * 0.75 / 1024)} KB)`);
ok(sent.messages.at(-1).text === '[photo] What does this say?', 'the question goes with it');
ok(await page.locator('#aiLog .ai-msg.me img.ai-photo').count() === 1 && await page.locator('#aiAttach').isHidden(), 'your bubble shows the photo, and the preview clears');
await page.screenshot({ path: path.join(shots, 'phone-android-ai-photo.png') });

await page.setInputFiles('#aiPhotoInput', { name: 'list.png', mimeType: 'image/png', buffer: png });
await until(page, () => !document.querySelector('#aiAttach').hidden);
fake.ai = () => ({ json: { text: 'A green card with the words "Buy eggs".', actions: [] } });
await page.click('#aiSend');
ok(await until(page, () => document.querySelectorAll('#aiLog .ai-msg.me.photo-only').length === 1), 'a photo can be sent without typing anything');
sent = fake.aiCalls.at(-1).body;
ok(sent.messages.at(-1).text === '[photo]' && sent.image && sent.messages.filter(m => m.text.startsWith('[photo]')).length === 2, 'older photos are sent only as "[photo]", just the newest one itself');

fake.ai = () => ({ json: { text: 'Okay.', actions: [] } });
await page.fill('#aiText', 'Thanks'); await page.click('#aiSend');
await until(page, () => [...document.querySelectorAll('#aiLog .ai-msg.bot p')].some(p => p.textContent === 'Okay.'));
ok(!fake.aiCalls.at(-1).body.image, 'the next message doesn’t send the photo again');

callsBefore = fake.aiCalls.length;
await page.setInputFiles('#aiPhotoInput', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
await page.waitForTimeout(200);
ok(await page.locator('#aiAttach').isHidden() && await until(page, () => [...document.querySelectorAll('.toast')].some(t => t.textContent.includes('Please choose a photo'))), 'something that isn’t a photo → "Please choose a photo"');

await page.locator('#aiLog img.ai-photo').first().click();
ok(await until(page, () => document.querySelector('#photoView').open && document.querySelector('#photoViewImg').src.startsWith('data:image/jpeg')), 'tap a photo → it opens full screen');
await page.click('#photoViewClose');

await page.reload(); await page.evaluate(() => window.Hustl.ready);
await page.click('.radio-key[data-screen="ai"]');
ok(await until(page, () => document.querySelectorAll('#aiLog img.ai-photo').length === 2), 'photos stay in the chat after reopening the app');
await page.click('#aiClear');
await until(page, () => document.querySelectorAll('#aiLog .ai-msg').length === 1);

console.log('\n▶ computer (minimal use)');
const { page: desk } = await makeDevice(browser, { name: 'desktop', base, fake, errors, viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
await signIn(desk, 'akash'); await desk.waitForSelector('#acctSignedIn:not([hidden])');
await desk.click('.radio-key[data-screen="ai"]');
fake.ai = () => ({ json: { text: 'Sure! Added it.', actions: [{ name: 'add_task', args: { text: 'Laptop task' } }] } });
await desk.fill('#aiText', 'Add laptop task'); await desk.press('#aiText', 'Enter');
ok(await until(desk, () => [...document.querySelectorAll('#aiLog .ai-card')].some(c => c.textContent.includes('Laptop task'))), 'works in a computer browser too (Enter sends)');
await desk.screenshot({ path: path.join(shots, 'desktop-dark-ai.png') });

// the 429 / 503 above were scripted on purpose; the browser logs failed responses as errors
const real = errors.filter(e => !/status of (429|503)/.test(e));
ok(real.length === 0, 'no console errors' + (real.length ? ': ' + real.join(' | ') : ''));
await browser.close();
server.close();
console.log(state.failures ? `\n${state.failures} check(s) failed` : '\nAll checks passed');
process.exit(state.failures ? 1 : 0);
