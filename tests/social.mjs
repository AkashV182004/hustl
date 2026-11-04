// Phase 3 checks: User IDs, display names, Add friend, follow back, unfollow — two people on two devices.
// Uses the in-memory fake Supabase (tests/fake-server.mjs). Run: node tests/social.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import { startServer, checker, device as makeDevice, signIn, shots } from './harness.mjs';
import { createFakeServer } from './fake-server.mjs';

const { server, base } = await startServer();
const fake = createFakeServer();
const { ok, state } = checker();
const browser = await chromium.launch();
const errors = [];
const device = (name, opts) => makeDevice(browser, { name, base, fake, errors, ...opts });

const profileOf = name => fake.db.profiles.get(fake.db.users.get(name + '@hustl.invalid').id);
const names = (page, list) => page.locator(`#${list} .person-main b`).allTextContents();
async function chats(page) {
  if (await page.locator('#convoBack').isVisible()) await page.click('#convoBack'); // phone: leave an open chat first
  await page.click('.radio-key[data-screen="chats"]');
  await page.evaluate(() => window.HustlChat.refresh());
}
async function addFriend(page, id) {
  await page.click('#addFriendBtn');
  await page.fill('#friendId', id);
  await page.click('#addFriendGo');
  await page.waitForTimeout(250);
}

console.log('\n▶ signed out');
const A = await device('akash', { viewport: { width: 1280, height: 800 }, colorScheme: 'light', permissions: ['clipboard-read', 'clipboard-write'] });
await A.page.click('.radio-key[data-screen="chats"]');
ok(await A.page.locator('#chatsSignedOut').isVisible(), 'Chats asks you to sign in first');
ok(!(await A.page.locator('#addFriendBtn').isVisible()), 'no Add friend button while signed out');

console.log('\n▶ User ID and display name');
await signIn(A.page, 'akash');
await A.page.waitForSelector('#profileBox:not([hidden])');
const pa = profileOf('akash');
ok((await A.page.locator('#profileBox [data-my-handle]').textContent()) === pa.handle, `Settings shows your User ID (${pa.handle})`);
ok(/^[a-z]+-[a-z]+-\d{4}$/.test(pa.handle), 'User ID looks like vinyl-fox-4821');
await A.page.locator('#profileBox [data-copy-handle]').click();
ok((await A.page.evaluate(() => navigator.clipboard.readText())) === pa.handle, 'Copy puts the User ID on the clipboard');
await A.page.fill('#displayName', '  Akash   A. ');
await A.page.locator('#nameForm button[type="submit"]').click();
await A.page.waitForTimeout(250);
ok(profileOf('akash').display_name === 'Akash A.', 'display name saved (spaces tidied)');
await A.page.locator('#accountPanel').scrollIntoViewIfNeeded();
await A.page.screenshot({ path: path.join(shots, 'desktop-light-10-profile.png') });

console.log('\n▶ Add friend');
const B = await device('maya', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: 'dark' });
await signIn(B.page, 'maya');
await B.page.waitForSelector('#profileBox:not([hidden])');
await B.page.fill('#displayName', 'Maya');
await B.page.locator('#nameForm button[type="submit"]').click();
await B.page.waitForTimeout(250);
const pb = profileOf('maya');

await chats(A.page);
ok(await A.page.locator('#peopleEmpty').isVisible(), 'empty state before you have friends');
ok((await A.page.locator('#chatsSignedIn [data-my-handle]').textContent()) === pa.handle, 'Chats shows your User ID to share');
await A.page.screenshot({ path: path.join(shots, 'desktop-light-11-chats-empty.png') });

await addFriend(A.page, 'not an id');
ok((await A.page.locator('#addFriendMsg').textContent()).includes("doesn't look like a User ID"), 'rejects text that is not a User ID');
await A.page.fill('#friendId', pa.handle); await A.page.click('#addFriendGo'); await A.page.waitForTimeout(200);
ok((await A.page.locator('#addFriendMsg').textContent()).includes("That's you"), "can't follow yourself");
await A.page.fill('#friendId', 'velvet-owl-0000'); await A.page.click('#addFriendGo'); await A.page.waitForTimeout(250);
ok((await A.page.locator('#addFriendMsg').textContent()).includes('No one has that User ID'), 'unknown User ID → friendly message');
await A.page.screenshot({ path: path.join(shots, 'desktop-light-12-add-friend.png') });
await A.page.fill('#friendId', '  ' + pb.handle.toUpperCase() + ' '); await A.page.click('#addFriendGo');
await A.page.waitForSelector('#addFriendDlg:not([open])', { state: 'attached' });
await A.page.waitForTimeout(250);
ok(JSON.stringify(await names(A.page, 'waitingList')) === '["Maya"]', 'Maya appears under "Waiting for them" (ID matched despite caps/spaces)');
ok(await A.page.locator('#friendsSec').isHidden(), 'not friends yet');

console.log('\n▶ Follow back');
await chats(B.page);
ok(JSON.stringify(await names(B.page, 'requestsList')) === '["Akash A."]', 'Maya sees Akash under "Follows you"');
ok((await B.page.locator('#requestsSec .note').textContent()).includes('Follow each other to start chatting'), 'explains the mutual-follow rule');
await B.page.screenshot({ path: path.join(shots, 'mobile-dark-9-follows-you.png') });
await B.page.locator('#requestsList .person', { hasText: 'Akash A.' }).getByRole('button', { name: 'Follow back' }).click();
await B.page.waitForTimeout(300);
ok(JSON.stringify(await names(B.page, 'friendsList')) === '["Akash A."]', 'after Follow back they are Friends');
ok(await B.page.locator('.toast', { hasText: 'now friends' }).count() > 0, 'friendly "now friends" message');
await chats(A.page);
ok(JSON.stringify(await names(A.page, 'friendsList')) === '["Maya"]', 'Akash sees Maya as a friend too');
await A.page.screenshot({ path: path.join(shots, 'desktop-light-13-friends.png') });
await B.page.screenshot({ path: path.join(shots, 'mobile-dark-10-friends.png') });

console.log('\n▶ offline');
await A.ctx.setOffline(true);
await A.page.waitForTimeout(100);
ok(await A.page.locator('#socialOffline').isVisible(), '"Radio\'s off… reconnect to chat" shows');
ok(JSON.stringify(await names(A.page, 'friendsList')) === '["Maya"]', 'saved friends list still shows offline');
await A.page.click('#addFriendBtn');
ok(await A.page.locator('.toast', { hasText: "Radio's off" }).count() > 0, 'Add friend offline → friendly message');
ok(await A.page.locator('#addFriendDlg:not([open])').count() === 1, 'dialog does not open offline');
await A.ctx.setOffline(false);

console.log('\n▶ Unfollow');
await chats(A.page);
await A.page.locator('#friendsList .person', { hasText: 'Maya' }).getByRole('button', { name: 'Unfollow Maya' }).click();
await A.page.waitForSelector('#confirmDlg[open]');
await A.page.click('#confirmOk');
await A.page.waitForTimeout(300);
ok(await A.page.locator('#friendsSec').isHidden(), 'no longer friends after unfollowing');
ok(JSON.stringify(await names(A.page, 'requestsList')) === '["Maya"]', 'Maya still follows Akash → shows under "Follows you"');
await chats(B.page);
ok(JSON.stringify(await names(B.page, 'waitingList')) === '["Akash A."]', 'Maya now sees Akash under "Waiting for them"');

console.log('\n▶ 50 following / 50 followers');
await chats(A.page);
const countsText = () => A.page.locator('#followCounts').textContent();
ok(/^Following \d+\/50 · Followers \d+\/50$/.test(await countsText()), 'Chats shows "Following n/50 · Followers n/50" (' + await countsText() + ')');
const akashId = fake.db.users.get('akash@hustl.invalid').id, mayaId = fake.db.users.get('maya@hustl.invalid').id;
// Maya gets 50 followers
const mayaFollowers = fake.db.follows.filter(f => f.followee_id === mayaId).length;
for (let i = mayaFollowers; i < 50; i++) fake.db.follows.push({ follower_id: fake.addPerson(), followee_id: mayaId, created_at: new Date().toISOString() });
await A.page.click('#addFriendBtn'); await A.page.fill('#friendId', pb.handle); await A.page.click('#addFriendGo');
await A.page.waitForTimeout(300);
ok((await A.page.locator('#addFriendMsg').textContent()).includes('already has 50 followers'), "can't follow someone who already has 50 followers");
await A.page.locator('#addFriendDlg [data-close]').first().click();
fake.db.follows = fake.db.follows.filter(f => !(f.followee_id === mayaId && f.follower_id !== akashId));
// Akash follows 50 people
const already = fake.db.follows.filter(f => f.follower_id === akashId).length;
for (let i = already; i < 50; i++) fake.db.follows.push({ follower_id: akashId, followee_id: fake.addPerson(), created_at: new Date().toISOString() });
await chats(A.page);
ok((await countsText()).startsWith('Following 50/50'), 'counts show Following 50/50');
await A.page.click('#addFriendBtn'); await A.page.fill('#friendId', pb.handle); await A.page.click('#addFriendGo');
await A.page.waitForTimeout(300);
ok((await A.page.locator('#addFriendMsg').textContent()).includes('already follow 50 people'), "at 50 you can't follow anyone new");
await A.page.screenshot({ path: path.join(shots, 'desktop-light-17-follow-limit.png') });
await A.page.locator('#addFriendDlg [data-close]').first().click();

console.log('\n▶ sign out clears the friends screen');
await B.page.click('.radio-key[data-screen="settings"]');
await B.page.click('#acctSignOut');
await B.page.click('.radio-key[data-screen="chats"]');
ok(await B.page.locator('#chatsSignedOut').isVisible(), 'signed out → Chats asks to sign in again');

ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
server.close();
console.log(state.failures ? `\n${state.failures} check(s) failed` : '\nAll checks passed');
process.exit(state.failures ? 1 : 0);
