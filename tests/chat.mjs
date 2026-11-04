// Phase 4 checks: chat between mutual follows — live delivery, unread badges, read receipts,
// offline outbox, device cache, escaping, and the "follow each other" lock.
// Uses the in-memory fake Supabase (tests/fake-server.mjs). Run: node tests/chat.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import { startServer, checker, device as makeDevice, signIn, shots } from './harness.mjs';
import { createFakeServer } from './fake-server.mjs';

const { server, base } = await startServer();
const fake = createFakeServer();
const db = fake.db;
const { ok, state } = checker();
// A fake webcam, so the camera window can be tested without real hardware.
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const errors = [];
const device = (name, opts) => makeDevice(browser, { name, base, fake, errors, ...opts });
const handleOf = name => db.profiles.get(db.users.get(name + '@hustl.invalid').id).handle;
const notes = page => page.locator('#noteList .note-msg .note-body').allTextContents();
const lastStatus = page => page.locator('#noteList .note-msg.mine .note-status').last().textContent();
const serverBodies = () => db.messages.map(m => m.body);
const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 5000 }).then(() => true, () => false);

async function chats(page) {
  if (await page.locator('#convoBack').isVisible()) await page.click('#convoBack'); // phone: leave an open chat first
  await page.click('.radio-key[data-screen="chats"]');
  await page.evaluate(() => window.HustlChat.refresh());
}
async function openChat(page, name) {
  await chats(page);
  await page.locator('#friendsList .person, #requestsList .person, #waitingList .person', { hasText: name })
    .locator('.person-open').click();
  await page.waitForSelector('#convo:not([hidden])');
}
async function type(page, text) {
  await page.fill('#composerText', text);
  await page.press('#composerText', 'Enter');
}

console.log('\n▶ two friends');
const A = await device('akash', { viewport: { width: 1280, height: 800 }, colorScheme: 'light', permissions: ['camera'] });
const B = await device('maya', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: 'dark' });
await signIn(A.page, 'akash'); await A.page.waitForSelector('#profileBox:not([hidden])');
await signIn(B.page, 'maya'); await B.page.waitForSelector('#profileBox:not([hidden])');
await A.page.fill('#displayName', 'Akash'); await A.page.locator('#nameForm button[type="submit"]').click();
await B.page.fill('#displayName', 'Maya'); await B.page.locator('#nameForm button[type="submit"]').click();
await A.page.waitForTimeout(200);
await chats(A.page);
await A.page.click('#addFriendBtn'); await A.page.fill('#friendId', handleOf('maya')); await A.page.click('#addFriendGo');
await A.page.waitForSelector('#addFriendDlg:not([open])', { state: 'attached' });

console.log('\n▶ not friends yet → chat is locked');
await chats(A.page);
ok(await A.page.locator('#convoPlaceholder').isVisible(), 'computer: chat column says "Pick a friend" when there are no friends yet');
await openChat(A.page, 'Maya');
ok(await A.page.locator('#convoLocked').isVisible(), '"Follow each other to start chatting" shows');
ok(await A.page.locator('#composer').isHidden(), 'no message box until you follow each other');

await chats(B.page);
await B.page.locator('#requestsList .person', { hasText: 'Akash' }).getByRole('button', { name: 'Follow back' }).click();
ok(await until(B.page, () => !document.querySelector('#convo').hidden && document.querySelector('#convoName').textContent === 'Akash'), 'Follow back opens the chat with your new friend');
ok(await B.page.locator('#composerText').isVisible(), 'phone: the message box is right there');
await B.page.click('#convoBack');
ok(await B.page.locator('#convo').isHidden(), 'phone: back button closes the chat');
await B.page.locator('#friendsList .person', { hasText: 'Akash' }).getByRole('button', { name: 'Message Akash' }).click();
ok(await B.page.locator('#convo').isVisible(), 'phone: the Message button opens the chat');
await B.page.goBack();
ok(await B.page.locator('#convo').isHidden(), 'phone: the browser/phone Back closes the chat');

console.log('\n▶ send a note');
await chats(A.page);
ok(await until(A.page, () => !document.querySelector('#convo').hidden && document.querySelector('#convoName').textContent === 'Maya'), 'computer: opening Chats shows the chat beside the list');
ok(await A.page.locator('#composerText').isVisible() && await A.page.locator('#convoLocked').isHidden(), 'friends → the message box is visible straight away');
ok(await A.page.locator('#friendsList .person').isVisible() && await A.page.locator('#convoBack').isHidden(), 'computer: friends list stays visible beside the chat');
ok((await A.page.locator('.ttl-note').textContent()).includes('7 days'), 'chat explains notes disappear after 7 days');
ok((await A.page.locator('.note-hint').textContent()).includes('Say hello'), 'empty chat invites you to say hello');
await type(A.page, 'Hey Maya! 🎸');
ok(JSON.stringify(await notes(A.page)) === '["Hey Maya! 🎸"]', 'Enter sends on a keyboard; note appears right away');
ok(await until(A.page, () => document.querySelector('#noteList .note-msg.mine .note-status')?.textContent === '✓ Sent'), 'status turns "✓ Sent"');
ok(JSON.stringify(serverBodies()) === '["Hey Maya! 🎸"]', 'saved on the server');
ok((await A.page.inputValue('#composerText')) === '', 'message box cleared');

console.log('\n▶ it arrives live');
ok(await until(B.page, () => document.querySelector('.radio-key[data-screen="chats"] .nav-badge')?.textContent === '1'), 'Maya gets an unread badge on Chats without refreshing');
ok(await B.page.locator('.toast', { hasText: 'Akash: Hey Maya!' }).count() > 0, 'and a "new note" toast');
await B.page.click('.radio-key[data-screen="chats"]');
const row = B.page.locator('#friendsList .person', { hasText: 'Akash' });
ok((await row.locator('.person-sub').textContent()).includes('Hey Maya!'), 'chats list shows the last message');
ok((await row.locator('.unread').textContent()) === '1', 'chats list shows 1 unread');
await B.page.screenshot({ path: path.join(shots, 'mobile-dark-12-chats-list.png') });

console.log('\n▶ read receipts');
await row.locator('.person-open').click();
await B.page.waitForSelector('#convo:not([hidden])');
ok(JSON.stringify(await notes(B.page)) === '["Hey Maya! 🎸"]', 'Maya opens the chat and sees the note');
ok(await until(B.page, () => !document.querySelector('.radio-key[data-screen="chats"] .nav-badge')), 'unread badge clears once read');
ok(!!db.messages[0].read_at, 'read time saved on the server');
ok(await until(A.page, () => document.querySelector('#noteList .note-msg.mine .note-status')?.textContent === '✓✓ Read'), 'Akash sees "✓✓ Read" live');

console.log('\n▶ reply (phone: Enter makes a new line, the button sends)');
await B.page.fill('#composerText', 'Hi!');
await B.page.press('#composerText', 'Enter');
await B.page.type('#composerText', 'Coffee later? ☕');
ok((await B.page.inputValue('#composerText')) === 'Hi!\nCoffee later? ☕', 'Enter adds a new line on a phone');
await B.page.click('#composerSend');
ok(await until(A.page, () => [...document.querySelectorAll('#noteList .note-body')].some(n => n.textContent === 'Hi!\nCoffee later? ☕')), 'Akash sees the reply live in the open chat');
ok(await until(A.page, () => !document.querySelector('.radio-key[data-screen="chats"] .nav-badge')), 'no unread badge for a chat you are looking at');
await A.page.waitForTimeout(200);
await A.page.screenshot({ path: path.join(shots, 'desktop-light-14-chat.png') });
await B.page.waitForTimeout(200);
await B.page.screenshot({ path: path.join(shots, 'mobile-dark-13-chat.png') });

console.log('\n▶ text is shown as text');
await type(A.page, '<img src=x onerror="window.__pwned=1"> <b>bold?</b>');
await A.page.waitForTimeout(300);
ok(await B.page.locator('#noteList img').count() === 0 && !(await B.page.evaluate(() => window.__pwned)), 'HTML in a message is not run or rendered');
ok((await notes(B.page)).includes('<img src=x onerror="window.__pwned=1"> <b>bold?</b>'), 'it shows literally');

console.log('\n▶ offline outbox');
await A.ctx.setOffline(true);
await type(A.page, 'Sent while offline 📻');
ok((await lastStatus(A.page)) === '⏳ waiting to send', 'offline note shows "⏳ waiting to send"');
ok(!serverBodies().includes('Sent while offline 📻'), 'not on the server yet');
ok((await A.page.locator('#friendsList .person', { hasText: 'Maya' }).locator('.person-sub').textContent()).startsWith('⏳ You: Sent while offline'), 'chats list shows it waiting');
await A.page.screenshot({ path: path.join(shots, 'desktop-light-15-chats-offline.png') });
// Reload with the server unreachable (in the real app the service worker serves the page offline).
await A.ctx.setOffline(false);
fake.down = true;
await A.page.reload();
await A.page.evaluate(() => window.Hustl.ready);
await openChat(A.page, 'Maya');
ok((await notes(A.page)).length === 4, 'after reloading with no connection, the chat is still there (saved on the device)');
ok((await lastStatus(A.page)) === '⏳ waiting to send', 'and the note is still waiting');
fake.down = false;
await A.page.evaluate(() => window.HustlChat.refresh());
ok(await until(A.page, () => document.querySelector('#noteList .note-msg.mine:last-of-type .note-status')?.textContent.startsWith('✓')), 'back online → it sends by itself');
ok(serverBodies().filter(b => b === 'Sent while offline 📻').length === 1, 'sent exactly once');
ok(await until(B.page, () => [...document.querySelectorAll('#noteList .note-body')].some(n => n.textContent === 'Sent while offline 📻')), 'Maya receives it');

console.log('\n▶ a retry never duplicates');
const dupe = await A.page.evaluate(async () => {
  const m = window.HustlChat.messages.find(x => x.body === 'Sent while offline 📻');
  const { error } = await window.HustlSync.client.from('messages').insert({ id: m.id, sender_id: m.sender_id, recipient_id: m.recipient_id, body: m.body });
  return error && error.code;
});
ok(dupe === '23505' && serverBodies().filter(b => b === 'Sent while offline 📻').length === 1, 'resending the same note id is refused by the server');

console.log('\n▶ unfollow locks the chat');
await A.ctx.setOffline(true);
await type(A.page, 'This one will not go');
await B.page.click('#convoBack');
await chats(B.page);
await B.page.locator('#friendsList .person', { hasText: 'Akash' }).getByRole('button', { name: 'Unfollow Akash' }).click();
await B.page.click('#confirmOk');
await B.page.waitForTimeout(300);
await A.ctx.setOffline(false);
await A.page.evaluate(() => window.HustlChat.refresh());
await A.page.waitForTimeout(300);
ok(await A.page.locator('#convoLocked').isVisible() && await A.page.locator('#composer').isHidden(), 'chat locks once they unfollow');
ok((await lastStatus(A.page).catch(() => '')).startsWith('Not sent'), 'a note queued before that is marked "Not sent"');
ok(!serverBodies().includes('This one will not go'), 'and the server refused it');
ok(!(await notes(A.page)).includes('Hey Maya! 🎸'), 'old notes are hidden until you follow each other again');
await A.page.screenshot({ path: path.join(shots, 'desktop-light-16-chat-locked.png') });

console.log('\n▶ notes disappear after 7 days');
await chats(B.page);
await B.page.locator('#waitingList .person, #requestsList .person', { hasText: 'Akash' }).first().getByRole('button', { name: /Follow back/ }).click().catch(() => {});
await chats(A.page);
await openChat(A.page, 'Maya');
const old = db.messages.find(m => m.body === 'Hey Maya! 🎸');
old.created_at = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
await A.page.evaluate(() => window.HustlChat.refresh());
await A.page.waitForTimeout(200);
ok(!(await notes(A.page)).includes('Hey Maya! 🎸'), 'a note older than 7 days disappears from the chat');
ok((await notes(A.page)).includes('Hi!\nCoffee later? ☕'), 'newer notes stay');
ok(await A.page.evaluate(() => !window.HustlChat.messages.some(m => m.body === 'Hey Maya! 🎸')), 'and from the copy saved on the device');
await A.page.reload();
await A.page.evaluate(() => window.Hustl.ready);
await chats(A.page);
ok(!db.messages.some(m => m.body === 'Hey Maya! 🎸'), 'opening the app asks the server to delete expired notes');

console.log('\n▶ photos: camera button');
await chats(B.page);
await B.page.locator('#requestsList .person', { hasText: 'Akash' }).getByRole('button', { name: 'Follow back' }).click().catch(() => {});
await chats(A.page);
await openChat(A.page, 'Maya');
ok(await A.page.locator('#composer #cameraBtn').isVisible(), 'camera button sits next to Send');
ok((await A.page.getAttribute('#cameraBtn', 'aria-label')) === 'Take a picture', 'it is labelled "Take a picture"');

console.log('\n▶ computer: take a picture with the webcam');
await A.page.click('#cameraBtn');
ok(await A.page.locator('#cameraDlg[open]').isVisible(), 'the camera window opens');
ok(await until(A.page, () => document.querySelector('#cameraVideo').videoWidth > 0), 'live camera preview shows');
await A.page.screenshot({ path: path.join(shots, 'desktop-light-18-camera.png') });
await A.page.click('#cameraSnap');
ok(await until(A.page, () => !document.querySelector('#cameraShot').hidden && !document.querySelector('#cameraSend').hidden && !document.querySelector('#cameraRetake').hidden), 'Capture shows the picture with Send photo / Retake');
await A.page.click('#cameraRetake');
ok(await A.page.locator('#cameraVideo').isVisible(), 'Retake goes back to the live camera');
await A.page.click('#cameraSnap');
await A.page.locator('#cameraSend').waitFor();
await A.page.click('#cameraSend');
ok(await A.page.locator('#cameraDlg').evaluate(d => !d.open), 'the camera window closes after sending');
ok(await until(A.page, () => !!document.querySelector('#noteList .note-msg.mine.photo .polaroid img')), 'the photo appears in the chat as a polaroid');
ok(await until(A.page, () => document.querySelector('#noteList .note-msg.mine.photo:last-of-type .note-status')?.textContent.startsWith('✓')), 'and is sent');
const photoMsg = db.messages.find(m => m.media_type === 'image');
const akashId = db.users.get('akash@hustl.invalid').id, mayaId = db.users.get('maya@hustl.invalid').id;
ok(!!photoMsg && photoMsg.media_path.startsWith(`${akashId}/${mayaId}/`) && db.files.has(photoMsg.media_path), 'file stored privately at {sender}/{recipient}/…jpg');
ok(db.files.get(photoMsg.media_path).contentType === 'image/jpeg', 'saved as a JPEG');
ok(await A.page.evaluate(() => !!document.querySelector('#cameraVideo').srcObject) === false, 'camera is switched off after sending');

console.log('\n▶ the friend receives it');
await B.page.locator('#friendsList .person', { hasText: 'Akash' }).locator('.person-open').click();
ok(await until(B.page, () => { const i = document.querySelector('#noteList .note-msg.photo .polaroid img'); return i && i.naturalWidth > 0; }), 'Maya sees the photo');
await B.page.locator('#noteList .note-msg.photo .polaroid').last().click();
ok(await B.page.locator('#photoView[open]').isVisible(), 'tapping the photo opens it full screen');
await B.page.screenshot({ path: path.join(shots, 'mobile-dark-14-photo-full.png') });
await B.page.click('#photoViewClose');
ok(await B.page.locator('#photoView').evaluate(d => !d.open), 'and closes again');

console.log('\n▶ phone: the camera button opens the phone camera');
ok((await B.page.getAttribute('#cameraInput', 'capture')) === 'environment' && (await B.page.getAttribute('#cameraInput', 'accept')) === 'image/*', 'phone camera input (capture=environment, photos only)');
const big = await B.page.evaluate(async () => {   // a 3200×2400 "camera photo"
  const c = document.createElement('canvas'); c.width = 3200; c.height = 2400;
  const g = c.getContext('2d'); const gr = g.createLinearGradient(0, 0, 3200, 2400); gr.addColorStop(0, '#c8642b'); gr.addColorStop(1, '#4f7c79');
  g.fillStyle = gr; g.fillRect(0, 0, 3200, 2400); g.fillStyle = '#fff'; g.font = '300px sans-serif'; g.fillText('HUSTL', 900, 1300);
  const b = await new Promise(r => c.toBlob(r, 'image/png'));
  return Array.from(new Uint8Array(await b.arrayBuffer()));
});
const [chooser] = await Promise.all([B.page.waitForEvent('filechooser'), B.page.click('#cameraBtn')]);
await chooser.setFiles({ name: 'IMG_0042.png', mimeType: 'image/png', buffer: Buffer.from(big) });
ok(await until(B.page, () => [...document.querySelectorAll('#noteList .note-msg.mine.photo .note-status')].some(s => s.textContent.startsWith('✓'))), 'the phone photo is sent');
const phonePhoto = db.messages.filter(m => m.media_type === 'image').at(-1);
const dims = await A.page.evaluate(async src => { const i = new Image(); i.src = src; await i.decode(); return [i.naturalWidth, i.naturalHeight]; },
  `data:image/jpeg;base64,${db.files.get(phonePhoto.media_path).data}`);
ok(dims[0] === 1600 && dims[1] === 1200, `big photo shrunk to 1600px before upload (${dims.join('×')})`);
ok(Buffer.from(db.files.get(phonePhoto.media_path).data, 'base64').length < big.length, 'and is smaller than the original');
ok(await until(A.page, () => document.querySelectorAll('#noteList .note-msg.photo .polaroid img').length === 2), 'Akash receives it live');
await A.page.waitForTimeout(300);
await A.page.screenshot({ path: path.join(shots, 'desktop-light-19-photos.png') });
await B.page.waitForTimeout(300);
await B.page.screenshot({ path: path.join(shots, 'mobile-dark-15-photos.png') });

console.log('\n▶ photos offline');
await A.ctx.setOffline(true);
await A.page.click('#cameraBtn');
await until(A.page, () => document.querySelector('#cameraVideo').videoWidth > 0);
await A.page.click('#cameraSnap'); await A.page.locator('#cameraSend').waitFor(); await A.page.click('#cameraSend');
ok(await until(A.page, () => document.querySelector('#noteList .note-msg.mine.photo:last-of-type .note-status')?.textContent === '⏳ waiting to send'), 'a photo taken offline waits to send');
ok(await A.page.locator('#noteList .note-msg.mine.photo').last().locator('img').count() === 1, 'and still shows in the chat');
const filesBefore = db.files.size;
await A.ctx.setOffline(false);
await A.page.evaluate(() => window.HustlChat.refresh());
ok(await until(A.page, () => document.querySelector('#noteList .note-msg.mine.photo:last-of-type .note-status')?.textContent.startsWith('✓')), 'back online → it uploads and sends');
ok(db.files.size === filesBefore + 1 && db.messages.filter(m => m.media_type === 'image').length === 3, 'uploaded exactly once');

console.log('\n▶ only photos');
const [chooser2] = await Promise.all([B.page.waitForEvent('filechooser'), B.page.click('#cameraBtn')]);
await chooser2.setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
ok(await until(B.page, () => [...document.querySelectorAll('.toast')].some(t => t.textContent.includes('Please choose a photo'))), 'a non-photo file is refused');

console.log('\n▶ photos disappear after 7 days');
const oldPath = photoMsg.media_path;
db.files.get(oldPath).created_at = new Date(Date.now() - 8 * 864e5).toISOString();
photoMsg.created_at = new Date(Date.now() - 8 * 864e5).toISOString();
await A.page.evaluate(() => window.Hustl.store.set('photoCleanup', 0));
await A.page.reload();
await A.page.evaluate(() => window.Hustl.ready);
await chats(A.page);
ok(await until(A.page, () => true) && await new Promise(r => setTimeout(() => r(!db.files.has(oldPath)), 800)), "the sender's app deletes its expired photo file");
ok(db.files.size === 2, 'newer photos are kept');

console.log('\n▶ sign out clears chats');
await A.page.click('.radio-key[data-screen="settings"]');
await A.page.click('#acctSignOut');
ok(await until(A.page, () => window.HustlChat.messages.length === 0), 'messages are cleared from memory on sign-out');

ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
server.close();
console.log(state.failures ? `\n${state.failures} check(s) failed` : '\nAll checks passed');
process.exit(state.failures ? 1 : 0);
