/* Hustl — sign-in (username + password) and offline-first sync with Supabase.
   The app never waits for the network: every change is saved locally first, queued in an outbox,
   and pushed when online (on the "online" event, every 60s, on focus, and shortly after each change).
   Tasks: last write wins by updated_at (the server enforces it too). Completion log: larger count per day wins.
   Daily Track notes (Notes & Ideas, Important Reminders): last write wins by updated_at, like tasks. */
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const cfg = window.HUSTL_CONFIG || {};

  const PAGE = 500;
  const PULL_OVERLAP_MS = 5000;   // re-read a few seconds back; merging is idempotent
  const INTERVAL_MS = 60 * 1000;

  const air = $('#onair'), airLabel = air.querySelector('.onair-label');
  const ui = {
    unconfigured: $('#acctUnconfigured'), signin: $('#acctSignin'), user: $('#acctUser'), password: $('#acctPassword'),
    go: $('#acctGo'), create: $('#acctCreate'),
    signedIn: $('#acctSignedIn'), who: $('#acctEmailShow'), last: $('#acctLastSync'),
    syncNow: $('#acctSyncNow'), signOut: $('#acctSignOut'), offline: $('#acctOffline'),
  };

  let H = null;          // window.Hustl, once ready
  let sb = null;         // Supabase client
  let session = null;
  let syncing = false, again = false, lastError = null, lastSync = null;
  let debounce = null;
  // Set when the database doesn't have the Daily Track additions yet (supabase-update.sql not run):
  // priorities and notes then stay on this device, and everything else keeps syncing.
  let noNotesTable = false, noAlarmsTable = false;
  // Task columns added in later updates; any the database doesn't have yet are left out (they stay on this device).
  const OPTIONAL_COLS = ['priority', 'daily', 'day'];
  const missingCols = new Set();
  const missingColumn = e => {
    if (!e || !(e.code === '42703' || e.code === 'PGRST204')) return null;
    const m = String(e.message || '').match(/'(\w+)' column|column \w+\.(\w+) does not exist|column "(\w+)"/);
    const col = m && (m[1] || m[2] || m[3]);
    return OPTIONAL_COLS.includes(col) && !missingCols.has(col) ? col : null;
  };
  const missingTable = e => e && (e.code === '42P01' || e.code === 'PGRST205' || /not find the table|does not exist/.test(e.message || ''));
  let live = null;          // Realtime channels (one per table): tell this device the moment another device saves
  const outbox = new Set(); // ids of tasks changed locally and not yet pushed

  /* ---------------- ON AIR light ---------------- */
  function setAir(state, label, title) {
    air.dataset.state = state;
    airLabel.textContent = label;
    air.title = title;
  }
  function updateAir() {
    if (!navigator.onLine) return setAir('offline', 'Offline', 'Offline — changes are saved on this device and sync when you reconnect');
    if (!session) return setAir('offline', 'Local', sb ? 'Saved on this device — sign in to sync' : 'Saved on this device');
    if (syncing) return setAir('syncing', 'Syncing', 'Syncing…');
    if (lastError) return setAir('offline', 'Paused', 'Sync paused — retrying soon. Your changes are safe on this device.');
    if (outbox.size) return setAir('syncing', 'Queued', 'Changes waiting to sync');
    setAir('synced', 'Synced', 'Everything is synced');
  }

  /* ---------------- Account panel ---------------- */
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  function ago(iso) {
    const s = Math.round((new Date(iso) - Date.now()) / 1000);
    if (Math.abs(s) < 45) return 'just now';
    const m = Math.round(s / 60); if (Math.abs(m) < 60) return rtf.format(m, 'minute');
    const h = Math.round(m / 60); if (Math.abs(h) < 24) return rtf.format(h, 'hour');
    return rtf.format(Math.round(h / 24), 'day');
  }
  function renderAccount() {
    const online = navigator.onLine;
    ui.unconfigured.hidden = !!sb;
    ui.signedIn.hidden = !(sb && session);
    ui.signin.hidden = !(sb && !session);
    ui.offline.hidden = online || !sb;
    ui.go.disabled = ui.create.disabled = !online;
    ui.syncNow.disabled = !online || syncing;
    if (session) {
      ui.who.textContent = usernameOf(session.user);
      ui.last.textContent = lastError ? 'Sync paused — will retry automatically.'
        : syncing ? 'Syncing…' : lastSync ? `Last synced ${ago(lastSync)}.` : 'Not synced yet.';
    }
  }

  /* ---------------- Outbox ---------------- */
  const saveOutbox = () => H.store.set('outbox', [...outbox]);
  function schedule(ms = 300) { clearTimeout(debounce); debounce = setTimeout(syncNow, ms); }

  /* ---------------- Sync ---------------- */
  const iso = v => (v ? new Date(v).toISOString() : null); // Postgres "+00:00" → JS "Z" so comparisons are exact
  const fromRow = r => ({ id: r.id, text: r.text, created_at: iso(r.created_at), done_at: iso(r.done_at), updated_at: iso(r.updated_at), deleted: !!r.deleted,
    ...(r.priority === undefined ? {} : { priority: !!r.priority }),
    ...(r.daily === undefined ? {} : { daily: !!r.daily }), ...(r.day === undefined ? {} : { day: r.day }) });
  const toRow = (t, uid) => {
    const row = { id: t.id, user_id: uid, text: t.text, created_at: t.created_at, done_at: t.done_at, updated_at: t.updated_at, deleted: !!t.deleted,
      priority: !!t.priority, daily: !!t.daily, day: t.day || null };
    missingCols.forEach(c => delete row[c]);
    return row;
  };
  const TASK_COLS = () => ['id', 'text', 'created_at', 'done_at', 'updated_at', 'deleted', 'server_updated_at', ...OPTIONAL_COLS.filter(c => !missingCols.has(c))].join(',');

  async function syncNow() {
    if (!sb || !session || !navigator.onLine) { updateAir(); renderAccount(); return; }
    if (syncing) { again = true; return; }
    syncing = true; updateAir(); renderAccount();
    const uid = session.user.id;
    const cursorKey = 'syncCursor:' + uid;
    try {
      let cursor = await H.store.get(cursorKey, null);
      if (!cursor) { // first sync of this account on this device: upload everything we have
        const owner = await H.store.get('syncOwner', null);
        if (owner && owner !== uid) { await H.rekeyTasks(); outbox.clear(); } // list came from another account
        await H.store.set('syncOwner', uid);
        H.state.tasks.forEach(t => outbox.add(t.id));
        await saveOutbox();
      }

      // 1) Pull tasks that changed on the server since our cursor.
      let since = cursor ? new Date(new Date(cursor).getTime() - PULL_OVERLAP_MS).toISOString() : '1970-01-01T00:00:00.000Z';
      for (;;) {
        let { data, error } = await sb.from('tasks')
          .select(TASK_COLS())
          .gt('server_updated_at', since).order('server_updated_at', { ascending: true }).limit(PAGE);
        const gone = missingColumn(error);
        if (gone) { missingCols.add(gone); continue; }
        if (error) throw error;
        if (data.length) {
          await H.mergeData({ tasks: data.map(fromRow) });
          since = data[data.length - 1].server_updated_at;
          cursor = since;
        }
        if (data.length < PAGE) break;
      }

      // 2) Push local changes (the server ignores any that are older than what it has).
      const ids = [...outbox];
      const byId = new Map(H.state.tasks.map(t => [t.id, t]));
      const rows = ids.map(id => byId.get(id)).filter(Boolean).map(t => toRow(t, uid));
      for (let i = 0; i < rows.length; i += PAGE) {
        let { error } = await sb.from('tasks').upsert(rows.slice(i, i + PAGE), { onConflict: 'id' });
        for (let col = missingColumn(error); col; col = missingColumn(error)) {   // drop columns the database doesn't have yet
          missingCols.add(col);
          rows.forEach(r => { delete r[col]; });
          ({ error } = await sb.from('tasks').upsert(rows.slice(i, i + PAGE), { onConflict: 'id' }));
        }
        if (error) throw error;
      }
      ids.forEach(id => outbox.delete(id));
      await saveOutbox();

      // 3) Completion log: take the larger count per day, both ways.
      const { data: logRows, error: logErr } = await sb.from('completion_log').select('day,count');
      if (logErr) throw logErr;
      const remote = {};
      logRows.forEach(r => { remote[r.day] = r.count; });
      await H.mergeData({ log: remote });
      const upLog = Object.entries(H.state.log)
        .filter(([day, n]) => n > (remote[day] || 0))
        .map(([day, count]) => ({ user_id: uid, day, count }));
      if (upLog.length) {
        const { error } = await sb.from('completion_log').upsert(upLog, { onConflict: 'user_id,day' });
        if (error) throw error;
      }

      // 4) Daily Track notes: newer side wins, both ways.
      if (!noNotesTable) {
        const { data: noteRows, error: nErr } = await sb.from('notes').select('kind,body,updated_at');
        if (nErr && missingTable(nErr)) noNotesTable = true;
        else if (nErr) throw nErr;
        else {
          await H.mergeNotes(noteRows);
          const remote = Object.fromEntries(noteRows.map(r => [r.kind, iso(r.updated_at)]));
          const up = Object.entries(H.state.notes)
            .filter(([kind, n]) => n.updated_at && (!remote[kind] || n.updated_at > remote[kind]))
            .map(([kind, n]) => ({ user_id: uid, kind, body: n.body, updated_at: n.updated_at }));
          if (up.length) {
            const { error } = await sb.from('notes').upsert(up, { onConflict: 'user_id,kind' });
            if (error) throw error;
          }
        }
      }

      // 5) Reminder alarms: newer side wins per alarm, both ways.
      if (!noAlarmsTable) {
        const { data: aRows, error: aErr } = await sb.from('alarms').select('id,text,due_at,done_at,deleted,updated_at');
        if (aErr && missingTable(aErr)) noAlarmsTable = true;
        else if (aErr) throw aErr;
        else {
          await H.mergeAlarms(aRows);
          const remote = Object.fromEntries(aRows.map(r => [r.id, iso(r.updated_at)]));
          const up = H.state.alarms.filter(a => !remote[a.id] || a.updated_at > remote[a.id])
            .map(a => ({ id: a.id, user_id: uid, text: a.text, due_at: a.due_at, done_at: a.done_at, deleted: !!a.deleted, updated_at: a.updated_at }));
          if (up.length) {
            const { error } = await sb.from('alarms').upsert(up, { onConflict: 'id' });
            if (error) throw error;
          }
        }
      }

      if (cursor) await H.store.set(cursorKey, cursor);
      lastSync = new Date().toISOString();
      await H.store.set('lastSync', lastSync);
      lastError = null;
      await announceAdded();
      ensurePush();
    } catch (e) {
      lastError = e;
      console.warn('Hustl sync paused:', e && (e.message || e));
      schedule(15000); // retry soon; the 60s timer is the backstop
    } finally {
      syncing = false;
      updateAir(); renderAccount();
      if (again) { again = false; schedule(300); }
    }
  }

  /* ---------------- Sign-in ---------------- */
  // Accounts are Supabase Auth users whose address is "<username>@hustl.invalid" (see register_user in supabase.sql).
  const DOMAIN = '@hustl.invalid';
  const usernameOf = user => (user.user_metadata && user.user_metadata.username) || String(user.email || '').replace(DOMAIN, '') || 'your account';

  const friendly = e => {
    const m = String(e && (e.message || e) || '');
    console.warn('[hustl] auth:', e && e.code, m);
    if (/fetch|network/i.test(m)) return "Radio's off… reconnect to sign in.";
    if (/invalid login credentials/i.test(m)) return 'Wrong username or password.';
    if (/username taken/i.test(m)) return 'That username is taken. Try another, or sign in.';
    if (/invalid username/i.test(m)) return 'Usernames are 3–20 letters, numbers or _.';
    if (/weak password/i.test(m)) return 'Password must be at least 8 characters.';
    if (/register_user|could not find the function/i.test(m)) return 'Run the latest supabase.sql in Supabase first (see README).';
    const secs = m.match(/after (\d+) seconds?/i);
    if (secs) return `Too many tries. Please wait ${secs[1]} seconds.`;
    if (/rate limit|too many/i.test(m)) return 'Too many tries. Please wait a few minutes.';
    return 'Sign-in didn’t work. Please try again.';
  };

  // Read and check the form; returns null (after pointing at the problem) if it isn't ready.
  function credentials() {
    if (!navigator.onLine) { H.toast("Radio's off… reconnect to sign in."); return null; }
    const username = ui.user.value.trim().toLowerCase();
    const password = ui.password.value;
    if (!/^[a-z0-9_]{3,20}$/.test(username)) { ui.user.focus(); H.toast('Usernames are 3–20 letters, numbers or _.'); return null; }
    if (password.length < 8) { ui.password.focus(); H.toast('Password must be at least 8 characters.'); return null; }
    return { username, password };
  }

  // Supabase checks the password against its stored bcrypt hash and only then issues a session.
  async function signIn(e) {
    if (e) e.preventDefault();
    const c = credentials(); if (!c) return;
    ui.go.disabled = ui.create.disabled = true;
    const { error } = await sb.auth.signInWithPassword({ email: c.username + DOMAIN, password: c.password });
    ui.go.disabled = ui.create.disabled = false;
    if (error) return H.toast(friendly(error));
    ui.password.value = '';
  }

  async function createAccount() {
    const c = credentials(); if (!c) return;
    ui.go.disabled = ui.create.disabled = true;
    const { error } = await sb.rpc('register_user', { p_username: c.username, p_password: c.password });
    ui.go.disabled = ui.create.disabled = false;
    if (error) return H.toast(friendly(error));
    await signIn();
  }

  /* ---------------- Live updates ---------------- */
  // Supabase Realtime pings us when our own rows change on the server (RLS limits it to this user),
  // and we pull straight away. The 60s timer and focus checks stay as a backstop.
  function goLive() {
    if (live || !session || typeof sb.channel !== 'function') return;
    const filter = 'user_id=eq.' + session.user.id;
    // Skip pings about changes this device already has (usually the echo of its own push).
    const onTask = ({ new: r }) => {
      const t = r && H.state.tasks.find(x => x.id === r.id);
      if (!t || iso(r.updated_at) !== t.updated_at) schedule(150);
    };
    const onLog = ({ new: r }) => { if (!r || (H.state.log[r.day] || 0) < r.count) schedule(150); };
    const onNote = ({ new: r }) => { const n = r && H.state.notes[r.kind]; if (!n || iso(r.updated_at) !== n.updated_at) schedule(150); };
    const onAlarm = ({ new: r }) => { const a = r && H.state.alarms.find(x => x.id === r.id); if (!a || iso(r.updated_at) !== a.updated_at) schedule(150); };
    // One channel per table: if a table isn't set up for live updates yet, Supabase refuses that channel
    // only, and the others keep working (the 60-second refresh covers the rest).
    const caughtUp = status => { if (status === 'SUBSCRIBED' && (!lastSync || Date.now() - Date.parse(lastSync) > 5000)) schedule(150); };
    live = [['tasks', onTask], ['completion_log', onLog], ['notes', onNote], ['alarms', onAlarm]].map(([table, fn]) =>
      sb.channel(`hustl-${table}-${session.user.id}`)
        .on('postgres_changes', { event: '*', schema: 'public', table, filter }, fn)
        .subscribe(caughtUp));
  }
  function stopLive() {
    if (live) { live.forEach(ch => sb.removeChannel(ch)); live = null; }
  }

  /* ---------------- Push: reminder alarms even when Hustl is closed ---------------- */
  // With notifications allowed, each signed-in device registers its push address (save_push_subscription);
  // the "push" Edge Function then sends due reminders to it. Signing out removes this device again.
  let pushEndpoint = null, noPush = false, pushBusy = false;
  const keyBytes = k => Uint8Array.from(atob(k.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((k.length + 3) % 4)), c => c.charCodeAt(0));
  const sameKey = (buf, k) => { try { const a = new Uint8Array(buf), b = keyBytes(k); return a.length === b.length && a.every((x, i) => x === b[i]); } catch { return false; } };
  const canPush = () => !!(cfg.VAPID_PUBLIC_KEY && 'PushManager' in window && navigator.serviceWorker && window.Notification && Notification.permission === 'granted');
  const swReg = () => Promise.race([navigator.serviceWorker.ready, new Promise(res => setTimeout(() => res(null), 4000))]);

  async function ensurePush() {
    if (pushBusy || noPush || !sb || !session || !navigator.onLine || !canPush()) return;
    pushBusy = true;
    try {
      const reg = await swReg();
      if (!reg || !reg.pushManager) return;
      let sub = await reg.pushManager.getSubscription();
      if (sub && sub.options && sub.options.applicationServerKey && !sameKey(sub.options.applicationServerKey, cfg.VAPID_PUBLIC_KEY)) { await sub.unsubscribe(); sub = null; }
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(cfg.VAPID_PUBLIC_KEY) });
      const j = sub.toJSON();
      const { error } = await sb.rpc('save_push_subscription', {
        p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth,
        p_tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', p_user_agent: navigator.userAgent.slice(0, 200),
      });
      if (error) { if (error.code === 'PGRST202' || /could not find the function/i.test(error.message || '')) noPush = true; else console.warn('Hustl push not saved:', error.message || error); return; }
      pushEndpoint = j.endpoint;
      H.setPushActive(true);
    } catch (e) {
      console.warn('Hustl push setup skipped:', e && (e.message || e));
    } finally { pushBusy = false; }
  }

  async function dropPush() {
    try {
      const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();   // instant: never hold up signing out
      const sub = reg && reg.pushManager && await reg.pushManager.getSubscription();
      if (sub) {
        if (sb && session) await sb.rpc('remove_push_subscription', { p_endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
    } catch {}
    pushEndpoint = null;
    H.setPushActive(false);
  }

  // Reminders added on this device: ask the server to tell your other devices (even closed ones).
  async function announceAdded() {
    const list = H.state.alarms.filter(a => a.announce);
    if (!list.length || !session) return;
    for (const a of list) {
      if (!noPush) {
        try {
          const res = await fetch(cfg.SUPABASE_URL + '/functions/v1/push', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', apikey: cfg.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + session.access_token },
            body: JSON.stringify({ type: 'added', alarm_id: a.id, endpoint: pushEndpoint }),
          });
          if (res.status >= 500 || res.status === 401) continue;   // try again on the next sync
        } catch { break; }                                          // offline: try again later
      }
      delete a.announce;
    }
    await H.store.set('alarms', H.state.alarms);
  }
  addEventListener('hustl:notify-allowed', () => ensurePush());

  async function signOut() {
    stopLive();
    await dropPush();
    await sb.auth.signOut({ scope: 'local' }).catch(() => {});
    session = null; lastError = null;
    renderAccount(); updateAir();
    H.toast('Signed out. Your list stays on this device.');
  }

  function onSession(event, s) {
    const was = session && session.user.id;
    session = s || null;
    if (session) {
      if (!was) { if (event === 'SIGNED_IN') H.toast('Signed in — syncing your list 🎶'); syncNow(); }
      goLive();
    } else stopLive();
    renderAccount(); updateAir();
    window.dispatchEvent(new CustomEvent('hustl:auth', { detail: { session } }));
  }

  /* ---------------- Boot ---------------- */
  async function init() {
    H = window.Hustl;
    await H.ready;

    (await H.store.get('outbox', [])).forEach(id => outbox.add(id));
    lastSync = await H.store.get('lastSync', null);

    // Queue every local change.
    H.on((type, detail) => {
      if (type === 'tasks') { detail.forEach(t => outbox.add(t.id)); saveOutbox(); updateAir(); schedule(); }
      else if (type === 'log' || type === 'notes' || type === 'alarms') schedule();
    });

    if (cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && window.supabase) {
      sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'hustl-auth' },
      });

      sb.auth.onAuthStateChange((event, s) => setTimeout(() => onSession(event, s), 0));
      const { data } = await sb.auth.getSession();
      onSession('INITIAL_SESSION', data.session);

      ui.signin.addEventListener('submit', signIn);
      ui.create.addEventListener('click', createAccount);
      ui.syncNow.addEventListener('click', () => syncNow());
      ui.signOut.addEventListener('click', signOut);
    }

    addEventListener('online', () => { updateAir(); renderAccount(); syncNow(); });
    addEventListener('offline', () => { updateAir(); renderAccount(); });
    addEventListener('focus', () => syncNow());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
    setInterval(() => { syncNow(); renderAccount(); }, INTERVAL_MS);

    updateAir(); renderAccount();
  }

  window.HustlSync = {
    syncNow,
    get client() { return sb; },
    get session() { return session; },
    get pending() { return outbox.size; },
  };
  init();
})();
