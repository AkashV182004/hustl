/* Hustl — core app: local storage, tasks, streak, UI. Works with no network and no account. */
(() => {
  'use strict';

  const APP_VERSION = '2.5.0';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* ---------------- Utilities ---------------- */
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = crypto.getRandomValues(new Uint8Array(1))[0] & 15;
        return (c === 'x' ? r : (r & 3) | 8).toString(16);
      }));
  const nowISO = () => new Date().toISOString();
  const pad = n => String(n).padStart(2, '0');
  const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseDay = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const escapeHTML = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------------- Storage: IndexedDB with localStorage fallback ---------------- */
  const store = (() => {
    let db = null;
    const LS = 'hustl:';
    const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const lsGet = (k, d) => { try { const v = localStorage.getItem(LS + k); return v == null ? d : JSON.parse(v); } catch { return d; } };
    const lsSet = (k, v) => { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch {} };

    async function init() {
      if (!('indexedDB' in window)) return;
      try {
        db = await new Promise((res, rej) => {
          const r = indexedDB.open('hustl', 1);
          r.onupgradeneeded = () => {
            const d = r.result;
            if (!d.objectStoreNames.contains('tasks')) d.createObjectStore('tasks', { keyPath: 'id' });
            if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
            if (!d.objectStoreNames.contains('messages')) d.createObjectStore('messages', { keyPath: 'id' });
          };
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
          r.onblocked = () => rej(new Error('blocked'));
        });
      } catch (e) { db = null; }
    }
    const os = (name, mode = 'readonly') => db.transaction(name, mode).objectStore(name);

    return {
      init,
      get usingIDB() { return !!db; },
      async allTasks() {
        if (db) return req(os('tasks').getAll());
        return Object.values(lsGet('tasks', {}));
      },
      async putTasks(list) {
        if (!list.length) return;
        if (db) {
          const tx = db.transaction('tasks', 'readwrite');
          list.forEach(t => tx.objectStore('tasks').put(t));
          return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
        }
        const all = lsGet('tasks', {}); list.forEach(t => { all[t.id] = t; }); lsSet('tasks', all);
      },
      async replaceTasks(list) {
        if (db) {
          const tx = db.transaction('tasks', 'readwrite'), s = tx.objectStore('tasks');
          s.clear(); list.forEach(t => s.put(t));
          return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
        }
        lsSet('tasks', Object.fromEntries(list.map(t => [t.id, t])));
      },
      async get(key, fallback) {
        if (db) { const v = await req(os('kv').get(key)); return v === undefined ? fallback : v; }
        return lsGet('kv:' + key, fallback);
      },
      async set(key, val) {
        if (db) return req(os('kv', 'readwrite').put(val, key));
        lsSet('kv:' + key, val);
      },
      // raw access for sync/chat modules
      os: name => (db ? os(name, 'readwrite') : null),
    };
  })();

  /* ---------------- State ---------------- */
  const state = {
    tasks: [],          // includes soft-deleted
    log: {},            // { 'YYYY-MM-DD': count }
    settings: { theme: 'auto', sound: false },
    filter: 'active',
    notes: { notes: { body: '', updated_at: null }, reminders: { body: '', updated_at: null } },  // Daily Track text boxes
    alarms: [],         // Important Reminders with a date & time: { id, text, due_at, done_at, deleted, updated_at }
  };
  const PRIORITY_MAX = 6;   // Top Priorities has six lines
  const NOTE_KINDS = ['notes', 'reminders'];
  const listeners = new Set();
  const emit = (type, detail) => listeners.forEach(fn => { try { fn(type, detail); } catch (e) { console.error(e); } });

  const visibleTasks = () => state.tasks.filter(t => !t.deleted);
  const sortTasks = () => state.tasks.sort((a, b) => (b.created_at > a.created_at ? 1 : b.created_at < a.created_at ? -1 : 0));

  /* ---------------- Streak math ---------------- */
  function currentStreak(log, now = new Date()) {
    let d = new Date(now);
    if (!(log[dayKey(d)] > 0)) d = addDays(d, -1);
    let n = 0;
    while (log[dayKey(d)] > 0) { n++; d = addDays(d, -1); }
    return n;
  }
  function bestStreak(log) {
    const days = Object.keys(log).filter(k => log[k] > 0).sort();
    let best = 0, run = 0, prev = null;
    for (const k of days) {
      run = prev && dayKey(addDays(parseDay(prev), 1)) === k ? run + 1 : 1;
      best = Math.max(best, run); prev = k;
    }
    return best;
  }
  function streakInfo(now = new Date()) {
    const streak = currentStreak(state.log, now);
    const best = Math.max(bestStreak(state.log), streak);
    const doneToday = (state.log[dayKey(now)] || 0) > 0;
    const status = streak > 0 ? (doneToday ? 'active' : 'at-risk') : 'lost';
    const midnight = addDays(new Date(now.getFullYear(), now.getMonth(), now.getDate()), 1);
    const hoursLeft = Math.max(1, Math.ceil((midnight - now) / 3600000));
    return { streak, best, status, hoursLeft, hadStreak: bestStreak(state.log) > 0 };
  }

  /* ---------------- Mutations (save locally first, always) ---------------- */
  async function saveLog() { await store.set('log', state.log); }

  const openPriorities = () => visibleTasks().filter(t => t.priority && !t.done_at).length;

  async function addTask(text, { priority = false } = {}) {
    text = String(text || '').trim().slice(0, 500);
    if (!text) return null;
    const ts = nowISO();
    const t = { id: uuid(), text, created_at: ts, done_at: null, updated_at: ts, deleted: false, priority: !!priority };
    state.tasks.unshift(t);
    await store.putTasks([t]);
    emit('tasks', [t]);
    return t;
  }

  async function toggleTask(id) {
    const t = state.tasks.find(x => x.id === id);
    if (!t) return null;
    const before = currentStreak(state.log);
    const ts = nowISO();
    if (!t.done_at) {
      t.done_at = ts;
      const k = dayKey();
      state.log[k] = (state.log[k] || 0) + 1;
    } else {
      const k = dayKey(new Date(t.done_at));
      state.log[k] = Math.max(0, (state.log[k] || 0) - 1);
      if (!state.log[k]) delete state.log[k];
      t.done_at = null;
    }
    t.updated_at = ts;
    await Promise.all([store.putTasks([t]), saveLog()]);
    emit('tasks', [t]); emit('log', state.log);
    return { task: t, streakUp: currentStreak(state.log) > before };
  }

  // Move a task onto (or off) the Top Priorities list. Returns { full: true } when all six lines are taken.
  async function togglePriority(id) {
    const t = state.tasks.find(x => x.id === id);
    if (!t) return null;
    if (!t.priority && !t.done_at && openPriorities() >= PRIORITY_MAX) return { full: true };
    t.priority = !t.priority; t.updated_at = nowISO();
    await store.putTasks([t]);
    emit('tasks', [t]);
    return { task: t };
  }

  // Notes & Ideas / Important Reminders: saved on the device at once, synced like tasks (last write wins).
  async function setNote(kind, body) {
    if (!NOTE_KINDS.includes(kind)) return;
    body = String(body || '').slice(0, 5000);
    if (state.notes[kind].body === body) return;
    state.notes[kind] = { body, updated_at: nowISO() };
    await store.set('notes', state.notes);
    emit('notes', kind);
  }

  async function mergeNotes(rows = []) {
    let changed = false;
    for (const r of rows) {
      if (!r || !NOTE_KINDS.includes(r.kind) || typeof r.body !== 'string' || !r.updated_at) continue;
      const at = new Date(r.updated_at).toISOString(), local = state.notes[r.kind];
      if (!local.updated_at || at > local.updated_at) { state.notes[r.kind] = { body: r.body.slice(0, 5000), updated_at: at }; changed = true; }
    }
    if (changed) { await store.set('notes', state.notes); renderNotes(); }
    return changed;
  }

  /* ---------------- Alarms: Important Reminders with a date & time ---------------- */
  // They ring on every device where Hustl is open (or running in the background): a chime, a vibration,
  // a pop-up with Snooze / Done, and a system notification when allowed. Dismissing one syncs, so the
  // other devices stop too. (A closed web app can't ring without a push server.)
  const ALARM_MAX = 30, SNOOZE_MIN = 10, MISSED_MS = 24 * 3600 * 1000;
  const liveAlarms = () => state.alarms.filter(a => !a.deleted);
  const ringKey = a => a.id + '@' + a.due_at;        // a snoozed alarm gets a new due time, so it can ring again
  let rung = new Set(), alarmTimer = null, ringing = null;
  const alarmQueue = [];
  const saveAlarms = () => store.set('alarms', state.alarms);
  const saveRung = () => store.set('alarmsRung', [...rung].slice(-300));

  async function addAlarm(text, due) {
    text = String(text || '').trim().replace(/\s+/g, ' ').slice(0, 200);
    const at = due instanceof Date ? due : new Date(due);
    if (!text) return { error: 'What should we remind you about?' };
    if (isNaN(at)) return { error: 'Pick a date and time.' };
    if (at.getTime() < Date.now() - 30 * 1000) return { error: 'That time has already passed. Pick a time in the future.' };
    if (liveAlarms().filter(a => !a.done_at).length >= ALARM_MAX) return { error: `You can have up to ${ALARM_MAX} alarms set.` };
    const ts = nowISO();
    const a = { id: uuid(), text, due_at: at.toISOString(), done_at: null, deleted: false, updated_at: ts };
    state.alarms.push(a);
    await saveAlarms();
    emit('alarms', [a]);
    renderAlarms(); scheduleAlarms();
    return { alarm: a };
  }

  async function changeAlarm(id, changes) {
    const a = state.alarms.find(x => x.id === id);
    if (!a) return null;
    Object.assign(a, changes, { updated_at: nowISO() });
    await saveAlarms();
    emit('alarms', [a]);
    renderAlarms(); scheduleAlarms();
    return a;
  }
  const completeAlarm = id => changeAlarm(id, { done_at: nowISO() });
  const deleteAlarm = id => changeAlarm(id, { deleted: true });
  const snoozeAlarm = (id, minutes = SNOOZE_MIN) => changeAlarm(id, { done_at: null, due_at: new Date(Date.now() + minutes * 60000).toISOString() });

  /** Alarms from another device: last write wins by updated_at. */
  async function mergeAlarms(rows = []) {
    const byId = new Map(state.alarms.map(a => [a.id, a]));
    let changed = false;
    for (const r of rows) {
      if (!r || typeof r.id !== 'string' || typeof r.text !== 'string' || !r.due_at || !r.updated_at) continue;
      const clean = { id: r.id, text: r.text.slice(0, 200), due_at: new Date(r.due_at).toISOString(), done_at: r.done_at ? new Date(r.done_at).toISOString() : null,
        deleted: !!r.deleted, updated_at: new Date(r.updated_at).toISOString() };
      const local = byId.get(clean.id);
      if (!local) { state.alarms.push(clean); byId.set(clean.id, clean); changed = true; }
      else if (clean.updated_at > local.updated_at) { Object.assign(local, clean); changed = true; }
    }
    if (changed) {
      await saveAlarms();
      // a reminder dismissed on another device stops ringing here too
      if (ringing) { const a = byId.get(ringing); if (!a || a.done_at || a.deleted || ringKey(a) !== els.alarmDlg.dataset.key) closeAlarm(); }
      renderAlarms(); scheduleAlarms();
    }
    return changed;
  }

  // Check for due alarms now, then again when the next one is due (at least every minute).
  function scheduleAlarms() {
    clearTimeout(alarmTimer);
    const now = Date.now();
    let next = Infinity;
    for (const a of liveAlarms()) {
      if (a.done_at) continue;
      const due = Date.parse(a.due_at);
      if (due > now) { next = Math.min(next, due); continue; }
      if (rung.has(ringKey(a))) continue;
      rung.add(ringKey(a));
      if (now - due > MISSED_MS) continue;   // long gone: just show it as overdue in the list
      ring(a, now - due > 60 * 1000);
    }
    saveRung();
    alarmTimer = setTimeout(scheduleAlarms, Math.max(250, Math.min(next - now, 60 * 1000)));
    renderAlarms();
  }

  function ring(a, missed) {
    alarmQueue.push({ id: a.id, missed });
    chime();
    try { navigator.vibrate && navigator.vibrate([300, 150, 300, 150, 600]); } catch {}
    notifyAlarm(a, missed);
    showNextAlarm();
  }

  function showNextAlarm() {
    if (ringing || els.alarmDlg.open) return;
    while (alarmQueue.length) {
      const { id, missed } = alarmQueue.shift();
      const a = state.alarms.find(x => x.id === id);
      if (!a || a.done_at || a.deleted) continue;
      ringing = id;
      els.alarmDlg.dataset.key = ringKey(a);
      els.alarmKind.textContent = missed ? 'Missed reminder' : '⏰ Reminder';
      els.alarmDlgText.textContent = a.text;
      els.alarmWhen.textContent = fmtAlarmTime(a.due_at);
      els.alarmDlg.showModal();
      els.alarmDone.focus();
      return;
    }
  }
  function closeAlarm() {
    ringing = null;
    if (els.alarmDlg.open) els.alarmDlg.close();
    setTimeout(showNextAlarm, 0);
  }

  async function notifyAlarm(a, missed) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (document.visibilityState === 'visible' && document.hasFocus()) return;   // the pop-up is already in front of you
    const title = missed ? 'Missed reminder' : '⏰ Reminder';
    const opts = { body: `${a.text}\n${fmtAlarmTime(a.due_at)}`, tag: 'alarm-' + a.id, renotify: true, requireInteraction: true,
      icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { alarm: a.id } };
    try {
      const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
      if (reg) return await reg.showNotification(title, { ...opts, actions: [{ action: 'snooze', title: `Snooze ${SNOOZE_MIN} min` }, { action: 'done', title: 'Done' }] });
    } catch {}
    try { const n = new Notification(title, opts); n.onclick = () => { window.focus(); n.close(); }; } catch {}
  }

  // A soft three-note bell, three times. Alarms ring even with sound effects switched off.
  let alarmAudio = null;
  function chime() {
    try {
      const c = alarmAudio ||= new (window.AudioContext || window.webkitAudioContext)();
      c.resume?.();
      const t0 = c.currentTime + .05;
      for (let r = 0; r < 3; r++) [880, 1108.7, 1318.5].forEach((f, i) => {
        const t = t0 + r * 1.1 + i * .18, o = c.createOscillator(), g = c.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.22, t + .01); g.gain.exponentialRampToValueAtTime(.001, t + .9);
        o.connect(g).connect(c.destination); o.start(t); o.stop(t + 1);
      });
    } catch {}
  }

  const fmtAlarm = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const fmtAlarmTime = iso => fmtAlarm.format(new Date(iso));
  function relAlarm(iso) {
    const mins = Math.round((Date.parse(iso) - Date.now()) / 60000);
    if (Math.abs(mins) < 1) return 'now';
    if (Math.abs(mins) < 60) return rtf.format(mins, 'minute');
    const h = Math.round(mins / 60);
    if (Math.abs(h) < 48) return rtf.format(h, 'hour');
    return rtf.format(Math.round(h / 24), 'day');
  }
  const localInputValue = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

  const ICON_BELL = '<path d="M12 3.5a5.5 5.5 0 0 0-5.5 5.5v4L4.5 16.5h15L17.5 13V9A5.5 5.5 0 0 0 12 3.5z"/><path d="M10 19a2 2 0 0 0 4 0"/>';
  function renderAlarms() {
    if (!els.alarmList) return;
    const now = Date.now(), dayAgo = now - MISSED_MS;
    const open = liveAlarms().filter(a => !a.done_at).sort((a, b) => a.due_at.localeCompare(b.due_at));
    const done = liveAlarms().filter(a => a.done_at && Date.parse(a.done_at) > dayAgo).sort((a, b) => b.done_at.localeCompare(a.done_at)).slice(0, 3);
    els.alarmList.replaceChildren(...[...open, ...done].map(a => {
      const li = document.createElement('li');
      const due = !a.done_at && Date.parse(a.due_at) <= now;
      li.className = 'alarm' + (a.done_at ? ' done' : '') + (due ? ' due' : '');
      li.dataset.id = a.id;
      li.innerHTML = `<svg class="alarm-ico" viewBox="0 0 24 24" aria-hidden="true">${ICON_BELL}</svg>
        <span class="alarm-main"><b></b><time></time></span>
        <button class="task-del" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg></button>`;
      $('b', li).textContent = a.text;
      const t = $('time', li);
      t.dateTime = a.due_at;
      t.textContent = a.done_at ? `Done · ${fmtAlarmTime(a.due_at)}` : `${fmtAlarmTime(a.due_at)} · ${due ? 'overdue' : relAlarm(a.due_at)}`;
      $('.task-del', li).setAttribute('aria-label', 'Delete reminder: ' + a.text);
      return li;
    }));
    // date & time box: never in the past, and suggest the next whole hour
    const minVal = localInputValue(new Date());
    els.alarmAt.min = minVal;
    if (!els.alarmAt.value || (document.activeElement !== els.alarmAt && els.alarmAt.value < minVal)) {
      const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1);
      els.alarmAt.value = localInputValue(d);
    }
    renderAlarmHint();
  }

  function renderAlarmHint() {
    const has = 'Notification' in window, perm = has ? Notification.permission : 'unsupported';
    els.alarmHintText.textContent = perm === 'granted' ? 'Alarms ring while Hustl is open or in the background, with a notification.'
      : perm === 'denied' ? 'Alarms ring while Hustl is open. Notifications are blocked in your browser settings.'
      : perm === 'unsupported' ? 'Alarms ring while Hustl is open.'
      : 'Alarms ring while Hustl is open or in the background.';
    els.alarmAllow.hidden = perm !== 'default';
  }
  async function askNotifications() {
    if (!('Notification' in window) || Notification.permission !== 'default') return;
    try { await Notification.requestPermission(); } catch {}
    renderAlarmHint();
  }

  async function deleteTask(id) {
    const t = state.tasks.find(x => x.id === id);
    if (!t) return;
    t.deleted = true; t.updated_at = nowISO();
    await store.putTasks([t]);
    emit('tasks', [t]);
  }

  async function clearCompleted() {
    const ts = nowISO();
    const changed = state.tasks.filter(t => !t.deleted && t.done_at);
    changed.forEach(t => { t.deleted = true; t.updated_at = ts; });
    await store.putTasks(changed);
    if (changed.length) emit('tasks', changed);
    return changed.length;
  }

  /** Merge tasks/log from elsewhere (sync or backup): last-write-wins by updated_at, log = max per day. */
  async function mergeData({ tasks = [], log = {} } = {}) {
    const byId = new Map(state.tasks.map(t => [t.id, t]));
    const changed = [];
    for (const r of tasks) {
      if (!r || typeof r.id !== 'string' || typeof r.text !== 'string') continue;
      const clean = {
        id: r.id, text: r.text.slice(0, 500), created_at: r.created_at || nowISO(),
        done_at: r.done_at || null, updated_at: r.updated_at || r.created_at || nowISO(), deleted: !!r.deleted,
      };
      const local = byId.get(clean.id);
      // a server without the priority column sends none: keep what this device has
      clean.priority = r.priority === undefined ? !!(local && local.priority) : !!r.priority;
      if (!local) { state.tasks.push(clean); byId.set(clean.id, clean); changed.push(clean); }
      else if (clean.updated_at > local.updated_at) { Object.assign(local, clean); changed.push(local); }
    }
    let logChanged = false;
    for (const [k, v] of Object.entries(log || {})) {
      const n = Number(v) | 0;
      if (/^\d{4}-\d{2}-\d{2}$/.test(k) && n > (state.log[k] || 0)) { state.log[k] = n; logChanged = true; }
    }
    sortTasks();
    await store.putTasks(changed);
    if (logChanged) await saveLog();
    render();
    return { tasks: changed.length, logChanged };
  }

  // Give every task a fresh id. Used when a different account signs in on this device:
  // the old ids belong to the previous account on the server, so the list is copied under new ones.
  async function rekeyTasks() {
    state.tasks.forEach(t => { t.id = uuid(); });
    await store.replaceTasks(state.tasks);
    render();
  }

  /* ---------------- Sound (Web Audio, synthesized — no files) ---------------- */
  const sound = (() => {
    let ctx = null;
    const ac = () => (ctx ||= new (window.AudioContext || window.webkitAudioContext)());
    function pluck(c, freq, t0, gain) {
      const sr = c.sampleRate, N = Math.floor(sr * 1.8), p = Math.round(sr / freq);
      const buf = c.createBuffer(1, N, sr), out = buf.getChannelData(0);
      const ring = new Float32Array(p).map(() => Math.random() * 2 - 1);
      for (let i = 0, j = 0; i < N; i++) {
        const nxt = (j + 1) % p;
        out[i] = ring[j];
        ring[j] = (ring[j] + ring[nxt]) * 0.4985; // Karplus–Strong string
        j = nxt;
      }
      const src = c.createBufferSource(); src.buffer = buf;
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2600;
      const g = c.createGain(); g.gain.value = gain;
      src.connect(lp).connect(g).connect(c.destination); src.start(t0);
    }
    function crackle(c, t0, dur = .7, level = .05) {
      const sr = c.sampleRate, N = Math.floor(sr * dur);
      const buf = c.createBuffer(1, N, sr), d = buf.getChannelData(0);
      for (let i = 0; i < N; i++) {
        const hiss = (Math.random() * 2 - 1) * 0.08;
        d[i] = (Math.random() < 0.0009 ? (Math.random() * 2 - 1) : hiss) * (1 - i / N);
      }
      const src = c.createBufferSource(); src.buffer = buf;
      const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 900;
      const g = c.createGain(); g.gain.value = level;
      src.connect(hp).connect(g).connect(c.destination); src.start(t0);
    }
    return {
      strum() {
        if (!state.settings.sound) return;
        try {
          const c = ac(); c.resume?.(); const t = c.currentTime + .02;
          [196.0, 246.94, 293.66, 392.0, 493.88, 587.33].forEach((f, i) => pluck(c, f, t + i * .03, .11)); // G major
          crackle(c, t, .6, .04);
        } catch {}
      },
      needleDrop() {
        if (!state.settings.sound) return;
        try {
          const c = ac(); c.resume?.(); const t = c.currentTime + .01;
          const o = c.createOscillator(), g = c.createGain();
          o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(50, t + .15);
          g.gain.setValueAtTime(.25, t); g.gain.exponentialRampToValueAtTime(.001, t + .2);
          o.connect(g).connect(c.destination); o.start(t); o.stop(t + .22);
          crackle(c, t + .05, 1.2, .07);
        } catch {}
      },
    };
  })();

  /* ---------------- Rendering ---------------- */
  const els = {};
  const SVG_BOX = 'M4.5 4.5h15v15h-15z';
  const SVG_TICK = 'M7.5 12.5l3.2 3.2 6.3-7.4';
  const SVG_BOLT = 'M13.5 2L5 13.5h6L9.5 22 19 9.5h-6.2z';

  function taskEl(t) {
    const li = document.createElement('li');
    li.className = 'task' + (t.done_at ? ' done' : '');
    li.dataset.id = t.id;
    li.innerHTML = `
      <button class="task-check" type="button" aria-pressed="${t.done_at ? 'true' : 'false'}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path class="box" d="${SVG_BOX}"/><path class="tick" d="${SVG_TICK}"/></svg>
      </button>
      <div class="task-text"><span></span></div>
      <button class="task-prio" type="button" aria-pressed="${t.priority ? 'true' : 'false'}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${SVG_BOLT}"/></svg></button>
      <button class="task-del" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg></button>`;
    $('.task-text span', li).textContent = t.text; // textContent: never interpreted as HTML
    $('.task-check', li).setAttribute('aria-label', (t.done_at ? 'Mark not done: ' : 'Mark done: ') + t.text);
    const prio = $('.task-prio', li);
    prio.setAttribute('aria-label', (t.priority ? 'Move back to tasks: ' : 'Make top priority: ') + t.text);
    prio.title = t.priority ? 'Move back to tasks' : 'Make it a top priority';
    $('.task-del', li).setAttribute('aria-label', 'Delete: ' + t.text);
    return li;
  }

  function matchesFilter(t) {
    return state.filter === 'all' || (state.filter === 'done' ? !!t.done_at : !t.done_at);
  }

  // Empty ruled lines, so the page always looks like a journal page.
  const blankRows = n => Array.from({ length: Math.max(0, n) }, () => {
    const li = document.createElement('li'); li.className = 'j-blank'; li.setAttribute('aria-hidden', 'true'); return li;
  });
  const withFlip = flipId => t => {
    const li = taskEl(t);
    if (t.id === flipId && !reducedMotion()) li.classList.add('flip-in');
    return li;
  };

  function renderList(flipId) {
    // Tasks to Complete: everything that isn't a top priority (filtered); Top Priorities: open ones first, then done.
    const list = visibleTasks().filter(t => !t.priority).filter(matchesFilter);
    const prio = visibleTasks().filter(t => t.priority).sort((a, b) => !!a.done_at - !!b.done_at);
    els.list.replaceChildren(...list.map(withFlip(flipId)), ...blankRows(4 - list.length));
    const open = openPriorities();
    els.prioList.replaceChildren(...prio.map(withFlip(flipId)), ...blankRows(PRIORITY_MAX - 1 - prio.length));
    els.prioForm.hidden = open >= PRIORITY_MAX;
    els.prioHint.textContent = open >= PRIORITY_MAX ? 'All six lines are taken. Finish one, or tap ⚡ to move it back.'
      : 'Tap ⚡ on any task to make it a top priority (up to 6).';
    const total = visibleTasks().filter(t => !t.priority).length;
    els.empty.hidden = list.length > 0;
    els.empty.textContent = total === 0 ? 'Quiet page… write your first task above ✒️'
      : state.filter === 'done' ? 'Nothing ticked off yet. You’ve got this ✒️'
      : state.filter === 'active' ? 'Every task done. Encore? 🎸' : 'Quiet page… write your first task above ✒️';
    renderFooter();
  }

  // Leave a text box alone while someone is typing in it.
  function renderNotes() {
    for (const [kind, el] of [['notes', els.notesText], ['reminders', els.remindText]]) {
      if (document.activeElement !== el && el.value !== state.notes[kind].body) el.value = state.notes[kind].body;
    }
  }

  function renderFooter() {
    const left = visibleTasks().filter(t => !t.done_at).length;
    els.left.textContent = `${left} task${left === 1 ? '' : 's'} left`;
    els.clear.disabled = !visibleTasks().some(t => t.done_at);
  }

  function renderStreak() {
    const s = streakInfo();
    els.card.dataset.state = s.status;
    els.streakNum.textContent = s.streak;
    els.streakUnit.textContent = s.streak === 1 ? 'day' : 'days';
    els.best.textContent = s.best;
    let msg;
    if (s.status === 'active') msg = s.streak >= 2 && s.streak >= s.best ? 'New personal best! 💪' : 'Streak safe for today ✅';
    else if (s.status === 'at-risk') msg = `⌛ Complete a task today or lose it! (${s.hoursLeft}h left)`;
    else msg = s.hadStreak ? 'Streak lost. Drop the needle again!' : 'Finish a task today to start a streak.';
    els.streakMsg.textContent = msg;
    els.heroStreak.dataset.state = s.status;
    els.heroStreakText.textContent = s.status === 'active' ? `${s.streak}-day streak · safe`
      : s.status === 'at-risk' ? `${s.streak}-day streak · ${s.hoursLeft}h left` : 'Start a streak';
  }

  function renderStats() {
    const today = state.log[dayKey()] || 0;
    const daysActive = Object.values(state.log).filter(n => n > 0).length;
    const vis = visibleTasks();
    const pct = vis.length ? Math.round(vis.filter(t => t.done_at).length / vis.length * 100) : 0;
    els.statToday.textContent = today;
    els.statDays.textContent = daysActive;
    els.statPct.textContent = pct + '%';

    // 7-day VU meter
    const SEGS = 10;
    const days = Array.from({ length: 7 }, (_, i) => addDays(new Date(), i - 6));
    const counts = days.map(d => state.log[dayKey(d)] || 0);
    const max = Math.max(5, ...counts);
    const fmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
    els.vu.replaceChildren(...days.map((d, i) => {
      const col = document.createElement('div');
      col.className = 'vu-col' + (i === 6 ? ' today' : '');
      const lit = counts[i] ? Math.max(1, Math.round(counts[i] / max * SEGS)) : 0;
      const segs = Array.from({ length: SEGS }, (_, s) => `<span class="vu-seg${s < lit ? ' on' : ''}${s < lit && s >= SEGS - 2 ? ' hot' : ''}"></span>`).join('');
      col.innerHTML = `<span class="vu-count">${counts[i] || ''}</span><div class="vu-bar">${segs}</div><span class="vu-day">${escapeHTML(fmt.format(d).slice(0, 2))}</span>`;
      return col;
    }));
    els.vu.setAttribute('aria-label', 'Tasks completed, last 7 days: ' + days.map((d, i) => `${fmt.format(d)} ${counts[i]}`).join(', '));
  }

  function renderDate() {
    const d = new Date();
    els.ticketDay.textContent = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(d).toUpperCase();
    els.ticketDate.textContent = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(d);
    els.jMonth.textContent = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(d);
    els.jDate.textContent = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric' }).format(d);
  }

  function render(flipId) {
    renderDate(); renderList(flipId); renderNotes(); renderAlarms(); renderStreak(); renderStats();
  }

  function popStreak() {
    if (reducedMotion()) return;
    els.card.classList.remove('pop'); void els.card.offsetWidth; els.card.classList.add('pop');
    setTimeout(() => els.card.classList.remove('pop'), 800);
    sound.needleDrop();
  }

  function inkSplash(li) {
    if (reducedMotion()) return;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100'); svg.setAttribute('class', 'splash'); svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = '<path d="M50 28C60 18 66 34 74 30C84 26 86 40 78 46C90 52 84 66 72 62C70 76 58 80 52 70C44 82 30 76 34 64C20 66 16 52 28 48C18 38 28 26 38 34C40 22 46 22 50 28Z" opacity=".55"/>'
      + '<circle cx="18" cy="22" r="4"/><circle cx="84" cy="30" r="3"/><circle cx="80" cy="80" r="5"/><circle cx="22" cy="78" r="3"/><circle cx="52" cy="10" r="2.5"/>';
    li.appendChild(svg);
    setTimeout(() => svg.remove(), 800);
  }

  /* ---------------- Toasts ---------------- */
  function toast(msg, { action, actionLabel, sticky = false, duration = 3500, onTap } = {}) {
    const el = document.createElement('div');
    el.className = 'toast' + (onTap ? ' tap' : '');
    el.setAttribute('role', 'status');
    const span = document.createElement('span'); span.textContent = msg; el.appendChild(span);
    if (action) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = actionLabel || 'OK';
      b.addEventListener('click', e => { e.stopPropagation(); action(); el.remove(); });
      el.appendChild(b);
    }
    if (onTap) el.addEventListener('click', () => { onTap(); el.remove(); });
    els.toasts.appendChild(el);
    if (!sticky) setTimeout(() => el.remove(), duration);
    return el;
  }

  /* ---------------- Theme ---------------- */
  const darkMQ = matchMedia('(prefers-color-scheme: dark)');
  const isDark = () => state.settings.theme === 'dark' || (state.settings.theme === 'auto' && darkMQ.matches);
  function applyTheme() {
    const t = state.settings.theme;
    if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
    try { localStorage.setItem('hustl:theme', t); } catch {}
    const dark = isDark();
    $('meta[name="theme-color"]').setAttribute('content', dark ? '#1d1510' : '#f7f0df');
    els.lamp.setAttribute('aria-pressed', String(dark));
    els.lamp.setAttribute('aria-label', dark ? 'Switch to daylight mode' : 'Switch to late night mode');
    $$('[data-theme-choice]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.themeChoice === t)));
  }
  async function setSettings(patch) {
    Object.assign(state.settings, patch);
    await store.set('settings', state.settings);
    applyTheme();
  }

  /* ---------------- Navigation ---------------- */
  function showScreen(name) {
    if (!['tasks', 'chats', 'settings'].includes(name)) name = 'tasks';
    $$('.screen').forEach(s => { s.hidden = s.id !== 'screen-' + name; });
    $$('.radio-key').forEach(b => {
      if (b.dataset.screen === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
    window.scrollTo(0, 0);
    emit('screen', name);
  }

  /* ---------------- Backup ---------------- */
  function exportJSON() {
    const data = { app: 'hustl', version: 2, exported_at: nowISO(), tasks: state.tasks, log: state.log, notes: state.notes, alarms: state.alarms };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `hustl-backup-${dayKey()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Backup saved 📼');
  }
  async function importJSON(file) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return toast('That file is too large for a backup.');
    try {
      const data = JSON.parse(await file.text());
      if (!data || !Array.isArray(data.tasks) || typeof data.log !== 'object') throw new Error('bad');
      const r = await mergeData(data);
      if (Array.isArray(data.alarms)) await mergeAlarms(data.alarms);
      if (data.notes && typeof data.notes === 'object') await mergeNotes(NOTE_KINDS.map(kind => ({ kind, ...(data.notes[kind] || {}) })));
      toast(`Imported ${r.tasks} task${r.tasks === 1 ? '' : 's'} 🎶`);
    } catch { toast("Couldn't read that backup file."); }
  }

  /* ---------------- Install experience ---------------- */
  let deferredPrompt = null;
  const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  function updateInstallUI() {
    const can = !!deferredPrompt && !isStandalone();
    els.install.hidden = !can; els.install2.hidden = !can;
    if (isStandalone()) els.installNote.textContent = 'Installed — you\'re running Hustl as an app. 🎧';
    else if (isIOS()) els.installNote.textContent = 'On iPhone/iPad: tap Share → Add to Home Screen.';
  }
  async function promptInstall() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    try { await deferredPrompt.userChoice; } catch {}
    deferredPrompt = null; updateInstallUI();
  }
  function setupInstall() {
    addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; updateInstallUI(); });
    addEventListener('appinstalled', () => { deferredPrompt = null; updateInstallUI(); toast('Installed. Find "To-Do" with your apps 🎧'); });
    els.install.addEventListener('click', promptInstall);
    els.install2.addEventListener('click', promptInstall);
    updateInstallUI();
    if (isIOS() && !isStandalone()) {
      let seen = false; try { seen = localStorage.getItem('hustl:iosHint') === '1'; } catch {}
      if (!seen) {
        setTimeout(() => toast('Install: tap Share → Add to Home Screen', { sticky: true, action: () => {}, actionLabel: 'Got it' }), 1500);
        try { localStorage.setItem('hustl:iosHint', '1'); } catch {}
      }
    }
  }

  /* ---------------- Service worker + update toast ---------------- */
  function setupSW() {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
    // Reload only when the user accepted an update (not when the first SW claims the page).
    let updateAccepted = false, refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (updateAccepted && !refreshing) { refreshing = true; location.reload(); }
    });
    navigator.serviceWorker.register('./sw.js').then(reg => {
      const offer = w => toast('Update available, tap to refresh', { sticky: true, onTap: () => { updateAccepted = true; w.postMessage('SKIP_WAITING'); } });
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw && nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) offer(nw);
        });
      });
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    }).catch(err => console.warn('SW registration failed', err));
  }

  /* ---------------- Day rollover ---------------- */
  let midnightTimer = null;
  function scheduleMidnight() {
    clearTimeout(midnightTimer);
    const now = new Date();
    const next = addDays(new Date(now.getFullYear(), now.getMonth(), now.getDate()), 1);
    midnightTimer = setTimeout(() => { render(); scheduleMidnight(); }, next - now + 1000);
  }

  /* ---------------- Events ---------------- */
  function bind() {
    const onAdd = (form, input, opts) => form.addEventListener('submit', async e => {
      e.preventDefault();
      const text = input.value;
      input.value = '';
      if (opts.priority && openPriorities() >= PRIORITY_MAX) { toast('Top Priorities holds six. Finish one first ✒️'); return; }
      const t = await addTask(text, opts);
      if (!t) { input.focus(); return; }
      if (state.filter === 'done') setFilter('active', false);
      render(t.id);
      input.focus();
    });
    onAdd(els.form, els.input, {});
    onAdd(els.prioForm, els.prioInput, { priority: true });

    const onListClick = async e => {
      const li = e.target.closest('.task'); if (!li) return;
      const id = li.dataset.id;
      const inPrio = !!li.closest('#prioList');
      if (e.target.closest('.task-check')) {
        const r = await toggleTask(id); if (!r) return;
        li.classList.toggle('done', !!r.task.done_at);
        const btn = $('.task-check', li);
        btn.setAttribute('aria-pressed', String(!!r.task.done_at));
        btn.setAttribute('aria-label', (r.task.done_at ? 'Mark not done: ' : 'Mark done: ') + r.task.text);
        if (r.task.done_at) { inkSplash(li); sound.strum(); }
        renderStreak(); renderStats();
        if (r.streakUp) popStreak();
        if (inPrio || !matchesFilter(r.task)) {
          // let the tick and the ink show, then tidy the list (done priorities move below open ones)
          const delay = reducedMotion() ? 0 : 750;
          setTimeout(() => {
            if (!inPrio && !reducedMotion()) li.classList.add('fade-out');
            setTimeout(() => renderList(), inPrio || reducedMotion() ? 0 : 420);
          }, delay);
        } else renderFooter();
      } else if (e.target.closest('.task-prio')) {
        const r = await togglePriority(id);
        if (r && r.full) return toast('Top Priorities holds six. Finish one, or move one back first ✒️');
        render(id);
      } else if (e.target.closest('.task-del')) {
        await deleteTask(id);
        if (reducedMotion()) { render(); return; }
        li.classList.add('leaving');
        setTimeout(render, 430);
      }
    };
    els.list.addEventListener('click', onListClick);
    els.prioList.addEventListener('click', onListClick);

    // Notes & Ideas / Important Reminders: save shortly after typing stops, and straight away on leaving the box.
    for (const [kind, el, saved] of [['notes', els.notesText, els.notesSaved], ['reminders', els.remindText, els.remindSaved]]) {
      let timer = null, hide = null;
      const save = async () => {
        clearTimeout(timer); timer = null;
        await setNote(kind, el.value);
        saved.textContent = 'Saved ✓'; saved.classList.add('on');
        clearTimeout(hide); hide = setTimeout(() => saved.classList.remove('on'), 1600);
      };
      el.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(save, 600); });
      el.addEventListener('blur', () => { if (timer) save(); else renderNotes(); });
    }

    $$('.ftab').forEach(b => b.addEventListener('click', () => setFilter(b.dataset.filter)));
    // Important Reminders: set an alarm
    els.alarmForm.addEventListener('submit', async e => {
      e.preventDefault();
      if (!els.alarmText.value.trim()) { els.alarmText.focus(); return toast('What should we remind you about?'); }
      const r = await addAlarm(els.alarmText.value, els.alarmAt.value);
      if (r.error) return toast(r.error);
      els.alarmText.value = '';
      toast(`⏰ Alarm set for ${fmtAlarmTime(r.alarm.due_at)}`);
      askNotifications();   // the first alarm is a good moment to ask (it needs a tap)
    });
    els.alarmText.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); els.alarmForm.requestSubmit(); } });
    els.alarmAllow.addEventListener('click', askNotifications);
    els.alarmList.addEventListener('click', async e => {
      const li = e.target.closest('.alarm');
      if (li && e.target.closest('.task-del')) { await deleteAlarm(li.dataset.id); toast('Reminder deleted'); }
    });
    els.alarmDone.addEventListener('click', async () => { const id = ringing; closeAlarm(); if (id) await completeAlarm(id); });
    els.alarmSnooze.addEventListener('click', async () => {
      const id = ringing; closeAlarm();
      if (id) { await snoozeAlarm(id); toast(`Snoozed for ${SNOOZE_MIN} minutes 💤`); }
    });
    els.alarmDlg.addEventListener('cancel', () => { ringing = null; setTimeout(showNextAlarm, 0); });   // Esc: leave it overdue in the list
    // Snooze / Done tapped on a system notification (sent here by the service worker)
    navigator.serviceWorker?.addEventListener('message', async e => {
      const m = e.data || {};
      if (m.type !== 'alarm' || !m.id) return;
      if (ringing === m.id) closeAlarm();
      if (m.action === 'done') await completeAlarm(m.id);
      else if (m.action === 'snooze') await snoozeAlarm(m.id);
    });
    // Unlock audio on the first tap, so an alarm can sound later.
    addEventListener('pointerdown', () => { try { (alarmAudio ||= new (window.AudioContext || window.webkitAudioContext)()).resume?.(); } catch {} }, { once: true });

    els.clear.addEventListener('click', async () => {
      const n = await clearCompleted();
      render();
      if (n) toast(`Cleared ${n} finished task${n === 1 ? '' : 's'}. Your streak is untouched.`);
    });

    $$('.radio-key').forEach(b => b.addEventListener('click', () => showScreen(b.dataset.screen)));
    addEventListener('hashchange', () => showScreen(location.hash.slice(1)));
    els.heroStreak.addEventListener('click', () => els.card.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' }));

    els.lamp.addEventListener('click', () => setSettings({ theme: isDark() ? 'light' : 'dark' }));
    $$('[data-theme-choice]').forEach(b => b.addEventListener('click', () => setSettings({ theme: b.dataset.themeChoice })));
    darkMQ.addEventListener?.('change', applyTheme);
    els.sound.addEventListener('change', () => { setSettings({ sound: els.sound.checked }); if (els.sound.checked) sound.strum(); });

    $('#exportBtn').addEventListener('click', exportJSON);
    $('#importFile').addEventListener('change', e => { importJSON(e.target.files[0]); e.target.value = ''; });

    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { render(); scheduleMidnight(); scheduleAlarms(); } });
    setInterval(renderStreak, 60 * 1000); // keep "Xh left" fresh
  }

  function setFilter(f, rerender = true) {
    state.filter = f;
    $$('.ftab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.filter === f)));
    if (rerender) renderList();
  }

  /* ---------------- Boot ---------------- */
  async function boot() {
    Object.assign(els, {
      form: $('#addForm'), input: $('#taskInput'), list: $('#taskList'), empty: $('#emptyState'),
      prioForm: $('#prioForm'), prioInput: $('#prioInput'), prioList: $('#prioList'), prioHint: $('#prioHint'),
      notesText: $('#notesText'), remindText: $('#remindText'), notesSaved: $('#notesSaved'), remindSaved: $('#remindSaved'),
      alarmList: $('#alarmList'), alarmForm: $('#alarmForm'), alarmText: $('#alarmText'), alarmAt: $('#alarmAt'),
      alarmHintText: $('#alarmHintText'), alarmAllow: $('#alarmAllow'), alarmDlg: $('#alarmDlg'), alarmKind: $('#alarmDlgKind'),
      alarmDlgText: $('#alarmDlgText'), alarmWhen: $('#alarmDlgWhen'), alarmDone: $('#alarmDone'), alarmSnooze: $('#alarmSnooze'),
      jMonth: $('#jMonth'), jDate: $('#jDate'),
      left: $('#leftCount'), clear: $('#clearDone'), card: $('#streakCard'), streakNum: $('#streakNum'),
      streakUnit: $('#streakUnit'), streakMsg: $('#streakMsg'), best: $('#bestNum'), heroStreak: $('#heroStreak'), heroStreakText: $('#heroStreakText'),
      statToday: $('#statToday'), statDays: $('#statDays'), statPct: $('#statPct'), vu: $('#vuMeter'),
      ticketDay: $('#ticketDay'), ticketDate: $('#ticketDate'), toasts: $('#toasts'), lamp: $('#lampBtn'),
      sound: $('#soundToggle'), install: $('#installBtn'), install2: $('#installBtn2'), installNote: $('#installNote'),
    });
    $('#appVersion').textContent = APP_VERSION;

    await store.init();
    const [tasks, log, settings, notes] = await Promise.all([store.allTasks(), store.get('log', {}), store.get('settings', null), store.get('notes', null)]);
    state.tasks = tasks || [];
    state.log = log || {};
    if (notes) NOTE_KINDS.forEach(k => { if (notes[k] && typeof notes[k].body === 'string') state.notes[k] = notes[k]; });
    const [alarms, rungList] = await Promise.all([store.get('alarms', []), store.get('alarmsRung', [])]);
    state.alarms = Array.isArray(alarms) ? alarms : [];
    rung = new Set(Array.isArray(rungList) ? rungList : []);
    if (settings) Object.assign(state.settings, settings);
    else { try { const t = localStorage.getItem('hustl:theme'); if (t) state.settings.theme = t; } catch {} }
    sortTasks();

    els.sound.checked = !!state.settings.sound;
    applyTheme();
    bind();
    showScreen('tasks'); // the app always opens on the to-do list
    render();
    scheduleMidnight();
    scheduleAlarms();
    setupInstall();
    setupSW();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

    window.dispatchEvent(new CustomEvent('hustl:ready'));
  }

  /* Public API for sync.js / chat.js (and debugging). */
  window.Hustl = {
    version: APP_VERSION, store, state, toast, render, mergeData, mergeNotes, setNote, togglePriority, mergeAlarms, addAlarm, rekeyTasks, showScreen, escapeHTML, uuid, dayKey,
    streakInfo, currentStreak, bestStreak,
    on: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    ready: new Promise(res => addEventListener('hustl:ready', res, { once: true })),
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
