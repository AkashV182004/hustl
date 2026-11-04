# Hustl · My To-Do

An offline-first to-do list with a vinyl-record daily streak, in an "acoustic vintage" style.
It installs on desktop and mobile, works fully offline, and syncs between your devices when you sign in.

- Plain HTML + CSS + JavaScript, no build step.
- Data is saved on the device first (IndexedDB), then synced to Supabase when online.
- Optional app lock with your device's fingerprint, face or PIN.

## Live app
**https://akashv182004.github.io/hustl/**

## Install it
The app installs like a normal app (its own icon and window) and keeps working offline.

**Windows or Mac: Chrome or Edge**
1. Open the link above.
2. Click the **install icon** at the right end of the address bar (a screen with a ↓ arrow), or use
   **Settings → Install** inside the app.
   - Chrome menu: **⋮ → Cast, save and share → Install page as app…**
   - Edge menu: **⋯ → Apps → Install this site as an app**
3. Click **Install**. It appears in the Start menu / Applications and can be pinned to the taskbar or Dock.

**Android: Chrome**
1. Open the link in **Chrome**.
2. Tap **Install** on the banner, or **⋮ → Install app** (on some phones: **Add to Home screen**).
3. Tap **Install**. The **To-Do** icon appears on your home screen.

**iPhone or iPad: Safari**
1. Open the link in **Safari** (other browsers on iPhone can't install apps).
2. Tap the **Share** button (square with an ↑ arrow).
3. Scroll down and tap **Add to Home Screen** (on newer iOS it may be under **More**), then **Add**.
4. Open it from the **To-Do** icon. Sign in inside the installed app; it doesn't share sign-ins with Safari.

**Updates:** when a new version is published, the app shows **"Update available"**; tap it to refresh.

## Publish a change
Edit the files, bump the version (see *Releasing an update* below), then:
```bash
git add -A && git commit -m "Describe the change" && git push
```
GitHub Pages republishes the site within a minute or two.

## Set up sync (Supabase)

The to-do list works without any of this. You need it only for syncing between devices (and, later, for chat).

### 1. Create a Supabase project
1. Go to <https://supabase.com>, sign in, and click **New project**.
2. Pick a name (e.g. `hustl`), set a database password (save it somewhere safe), choose the region closest to you, and create the project.

### 2. Run the database script
1. In the project, open **SQL Editor → New query**.
2. Paste the whole of [`supabase.sql`](supabase.sql) and click **Run**. It should say "Success. No rows returned".
   It creates the tables (profiles, tasks, completion_log, follows, messages), Row Level Security policies,
   and the private `chat-media` storage bucket. It's safe to run again.

### 3. Sign-in: username + password
Nothing to switch on. People pick a **username** and **password** in the app (**Create account**), then **Sign in**.

- `register_user` in `supabase.sql` creates a normal Supabase Auth account for the username.
  The password is stored only as a **bcrypt hash**, never as plain text.
- **Sign in** sends the username and password to Supabase Auth, which checks the password against the hash
  and only then gives the app a session. Every Row Level Security rule uses that session.
- Usernames are 3–20 letters, numbers or `_` (not case-sensitive). Passwords are at least 8 characters.
- Supabase Auth limits repeated failed sign-ins, which slows down password guessing.
- There's no email, so a forgotten password can't be reset by the user. You can delete the account under
  **Authentication → Users** in Supabase and they can create it again (their synced list is lost).
- Make sure **Authentication → Sign In / Providers → Email** stays **enabled** (it's what checks passwords).

### 4. Paste your project details into `config.js`
Open **Project Settings → API** (or **Data API**) and copy:
- **Project URL** → `SUPABASE_URL`
- **anon / public** key (labelled "publishable" in newer projects) → `SUPABASE_ANON_KEY`

```js
window.HUSTL_CONFIG = {
  SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOi…',
};
```

The anon key is designed to be public: Row Level Security is what protects the data.
**Never** put the `service_role` / secret key in this file.

### 5. Try it
Open the app → **Settings → Sync & account** → type a username and password → **Create account**
the first time (**Sign in** after that, on any device) → the **ON AIR** light turns green.

| ON AIR light | Meaning |
|---|---|
| Green "Synced" | Everything is saved on the server |
| Amber "Syncing" / "Queued" | Changes are being sent |
| Grey "Offline" / "Local" / "Paused" | Saved on this device; it will sync when it can |

## How sync works
- Every change is saved on the device instantly and added to an outbox.
- The outbox is sent when you come back online, every 60 seconds, when you return to the app, and shortly after each change.
- **Tasks:** the most recent edit wins (by `updated_at`); the server enforces this too. Deleted tasks are kept as "deleted" so the deletion syncs.
- **Streak log:** for each day, the larger count wins. (So un-ticking a task on one device may not lower the count on another.)
- Signing out keeps your list on the device.

## How chat works
- Add a friend by their **User ID** (Chats → Add friend). You can chat once you **follow each other**;
  the database enforces this, so nobody else can read or send to your conversations.
- Notes arrive instantly through Supabase Realtime. Unread notes show a badge on **Chats** and in the list.
- Sent notes show **✓ Sent**, then **✓✓ Read** once your friend opens the chat.
- Offline, a note shows **⏳ waiting to send** and goes out by itself when you reconnect (never twice).
  Your recent chats are saved on the device, so they open without a connection.
- On a computer the chat (and its message box) sits beside your friends list; on a phone, tap a friend
  (or the 💬 button) to open the chat full screen. **Follow back** opens the chat with your new friend.
- **Photos:** tap the 📷 camera button next to Send. On a phone it opens the phone's camera; on a computer it opens
  the webcam (Capture → Send photo), or *Choose a photo instead*. Photos are shrunk to 1600px JPEG, stored in the
  private `chat-media` bucket, and opened through short-lived private links; tap one to see it full screen.
  Taken offline, a photo waits and sends itself later. Photos disappear after 7 days, like notes.
- **Limits:** you can follow up to **50** people and have up to **50** followers (the database enforces both).
  Chats shows your counts, e.g. *Following 12/50 · Followers 9/50*.
- **Notes disappear after 7 days.** The server hides them at once and deletes them with an hourly job
  (`pg_cron`); the app also asks for a clean-up when it opens, and removes them from the device.
- If either of you unfollows, the chat locks ("Follow each other to start chatting") until you both follow again.

## Run locally
Any static server works, for example:

```bash
npx http-server -p 8080 -c-1
```

Then open <http://localhost:8080/>.

## Tests
```bash
npm install
npx playwright install chromium
npm test
```

- `tests/sql.mjs`: runs `supabase.sql` in real Postgres (PGlite) and checks every security rule.
- `tests/phase1.mjs`: tasks, streak, offline reload, desktop + mobile, light + dark.
- `tests/lock.mjs`: list-first layout and the fingerprint / PIN app lock (using a virtual authenticator).
- `tests/sync.mjs`: sign-in and two-device sync, offline queue and conflicts (using an in-memory fake Supabase).
- `tests/social.mjs`: User IDs, display names, Add friend, Follow back and unfollow between two people.
- `tests/chat.mjs`: chat between friends: live delivery, unread badges, read receipts, offline outbox, saved chats, the follow-each-other lock, and photos (webcam, phone camera, shrinking, offline, 7-day clean-up).
- `tests/version.mjs`: one version number in every file, so browsers never mix old and new files.

## Releasing an update
Bump the version in `app.js`, `package.json`, `sw.js` and the `?v=` tags in `index.html` (all the same number; `node tests/version.mjs` checks). Installed apps then fetch the new files and show "Update available, tap to refresh".
