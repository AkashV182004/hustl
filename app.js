/* Hustl — core app: local storage, tasks, streak, UI. Works with no network and no account. */
(() => {
  'use strict';

  const APP_VERSION = '2.9.0';
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

  // A daily task comes back unticked every day: it only counts as done on the day it was ticked.
  const isDone = t => !!t.done_at && (!t.daily || dayKey(new Date(t.done_at)) === dayKey());
  const openPriorities = () => visibleTasks().filter(t => t.priority && !isDone(t)).length;

  async function addTask(text, { priority = false, daily = false } = {}) {
    text = String(text || '').trim().slice(0, 500);
    if (!text) return null;
    const ts = nowISO();
    const t = { id: uuid(), text, created_at: ts, done_at: null, updated_at: ts, deleted: false, priority: !!priority,
      daily: !!daily, day: daily ? null : dayKey() };
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
    if (!isDone(t)) {
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
    if (!t.priority && !isDone(t) && openPriorities() >= PRIORITY_MAX) return { full: true };
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
      if (!local.updated_at || at > local.updated_at) {
        if (r.kind === 'reminders' && Date.now() - Date.parse(at) < RECENT_MS) {
          const had = new Set(local.body.split('\n').map(l => l.trim()));
          const added = r.body.split('\n').map(l => l.trim()).filter(l => l && !had.has(l));
          if (added.length) notifyAdded('📝 Important Reminders', added.slice(0, 3).join('\n'), 'reminders-text', `📝 Added to Important Reminders: ${added[0]}`);
        }
        state.notes[r.kind] = { body: r.body.slice(0, 5000), updated_at: at }; changed = true;
      }
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
    const a = { id: uuid(), text, due_at: at.toISOString(), done_at: null, deleted: false, updated_at: ts, announce: true };
    state.alarms.push(a);
    await saveAlarms();
    emit('alarms', [a]);
    renderAlarms(); scheduleAlarms();
    notifyAdded('⏰ Reminder set', `${a.text}\n${fmtAlarmTime(a.due_at)}`, 'alarm-set-' + a.id);
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
    const arrived = [];
    for (const r of rows) {
      if (!r || typeof r.id !== 'string' || typeof r.text !== 'string' || !r.due_at || !r.updated_at) continue;
      const clean = { id: r.id, text: r.text.slice(0, 200), due_at: new Date(r.due_at).toISOString(), done_at: r.done_at ? new Date(r.done_at).toISOString() : null,
        deleted: !!r.deleted, updated_at: new Date(r.updated_at).toISOString() };
      const local = byId.get(clean.id);
      if (!local) {
        state.alarms.push(clean); byId.set(clean.id, clean); changed = true;
        if (!clean.done_at && !clean.deleted && Date.parse(clean.due_at) > Date.now() && Date.now() - Date.parse(clean.updated_at) < RECENT_MS) arrived.push(clean);
      }
      else if (clean.updated_at > local.updated_at) { Object.assign(local, clean); changed = true; }
    }
    if (changed) {
      await saveAlarms();
      // a reminder dismissed on another device stops ringing here too
      if (ringing) { const a = byId.get(ringing); if (!a || a.done_at || a.deleted || ringKey(a) !== els.alarmDlg.dataset.key) closeAlarm(); }
      renderAlarms(); scheduleAlarms();
      applyPendingAlarmAction();
      for (const a of arrived.slice(0, 3)) {
        notifyAdded('⏰ New reminder', `${a.text}\n${fmtAlarmTime(a.due_at)}`, 'alarm-new-' + a.id, `⏰ New reminder: ${a.text} · ${fmtAlarmTime(a.due_at)}`);
      }
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

  // A system notification (when the person has allowed them). alarmId adds Snooze / Done buttons.
  async function systemNotify(title, body, { tag, alarmId = null, sticky = false } = {}) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const opts = { body, tag, renotify: true, requireInteraction: sticky, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
      data: alarmId ? { alarm: alarmId } : {} };
    try {
      const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
      if (reg) return await reg.showNotification(title, alarmId
        ? { ...opts, actions: [{ action: 'snooze', title: `Snooze ${SNOOZE_MIN} min` }, { action: 'done', title: 'Done' }] } : opts);
    } catch {}
    try { const n = new Notification(title, opts); n.onclick = () => { window.focus(); n.close(); }; } catch {}
  }

  function notifyAlarm(a, missed) {
    if (document.visibilityState === 'visible' && document.hasFocus()) return;   // the pop-up is already in front of you
    systemNotify(missed ? 'Missed reminder' : '⏰ Reminder', `${a.text}\n${fmtAlarmTime(a.due_at)}`, { tag: 'alarm-' + a.id, alarmId: a.id, sticky: true });
  }

  // Something new in Important Reminders: say so (here, or when it arrives from another device).
  const RECENT_MS = 10 * 60 * 1000;   // only things added in the last few minutes, not old ones arriving at sign-in
  function notifyAdded(title, body, tag, inApp) {
    if (inApp) toast(inApp);
    systemNotify(title, body, { tag });
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
    setBadge('alarms', open.filter(a => Date.parse(a.due_at) <= now).length);
  }

  function renderAlarmHint() {
    const has = 'Notification' in window, perm = has ? Notification.permission : 'unsupported';
    els.alarmHintText.textContent = isIOS() && !isStandalone() ? 'On iPhone, add Hustl to your Home Screen so reminders can reach you when it’s closed.'
      : perm === 'granted' && pushActive ? 'Alarms reach you even when Hustl is closed.'
      : perm === 'granted' ? 'Alarms ring while Hustl is open or in the background, with a notification.'
      : perm === 'denied' ? 'Alarms ring while Hustl is open. Notifications are blocked in your browser settings.'
      : perm === 'unsupported' ? 'Alarms ring while Hustl is open.'
      : 'Alarms ring while Hustl is open or in the background.';
    els.alarmAllow.hidden = perm !== 'default';
  }
  async function askNotifications() {
    if (!('Notification' in window) || Notification.permission !== 'default') return;
    try { await Notification.requestPermission(); } catch {}
    renderAlarmHint(); renderPhoneCard();
    if (Notification.permission === 'granted') dispatchEvent(new Event('hustl:notify-allowed'));   // sync.js registers this device for push
  }
  let pushActive = false;
  function setPushActive(on) { pushActive = !!on; renderAlarmHint(); }

  // Snooze / Done tapped on a notification while Hustl was closed: it opens with ?alarm=…&do=…
  let pendingAlarmAction = null;
  function takeUrlAction() {
    const q = new URLSearchParams(location.search);
    if (q.get('go') === 'reminder') {   // the "Set a reminder" home-screen shortcut
      history.replaceState(null, '', location.pathname + '#tasks');
      setTimeout(() => { els.alarmText.scrollIntoView({ block: 'center' }); els.alarmText.focus(); }, 300);
      return;
    }
    if (!q.get('alarm') || !['done', 'snooze'].includes(q.get('do'))) return;
    pendingAlarmAction = { id: q.get('alarm'), action: q.get('do') };
    history.replaceState(null, '', location.pathname + '#tasks');
    applyPendingAlarmAction();
  }
  async function applyPendingAlarmAction() {
    const p = pendingAlarmAction;
    if (!p || !state.alarms.some(a => a.id === p.id)) return;   // not here yet: tried again when the reminders arrive
    pendingAlarmAction = null;
    if (ringing === p.id) closeAlarm();
    if (p.action === 'done') { await completeAlarm(p.id); toast('Reminder done ✓'); }
    else { await snoozeAlarm(p.id); toast(`Snoozed for ${SNOOZE_MIN} minutes 💤`); }
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
    const changed = state.tasks.filter(t => !t.deleted && !t.daily && t.done_at);
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
        daily: !!r.daily, day: r.day ? String(r.day).slice(0, 10) : null,
      };
      const local = byId.get(clean.id);
      // a server without these newer columns sends none: keep what this device has
      clean.priority = r.priority === undefined ? !!(local && local.priority) : !!r.priority;
      if (r.daily === undefined && local) clean.daily = !!local.daily;
      if (r.day === undefined) clean.day = local ? local.day || null : (clean.daily ? null : dayKey(new Date(clean.created_at)));
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
    await rollOver();
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
    const done = isDone(t);
    li.className = 'task' + (done ? ' done' : '') + (t.daily ? ' daily' : '');
    li.dataset.id = t.id;
    li.innerHTML = `
      <button class="task-check" type="button" aria-pressed="${done ? 'true' : 'false'}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path class="box" d="${SVG_BOX}"/><path class="tick" d="${SVG_TICK}"/></svg>
      </button>
      <div class="task-text"><span></span></div>
      <button class="task-prio" type="button" aria-pressed="${t.priority ? 'true' : 'false'}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${SVG_BOLT}"/></svg></button>
      <button class="task-del" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg></button>`;
    $('.task-text span', li).textContent = t.text; // textContent: never interpreted as HTML
    if (t.daily) {
      const tag = document.createElement('span');
      tag.className = 'daily-tag'; tag.textContent = '↻ Daily'; tag.title = 'Comes back every day';
      $('.task-text', li).appendChild(tag);
    }
    $('.task-check', li).setAttribute('aria-label', (done ? 'Mark not done: ' : 'Mark done: ') + t.text);
    const prio = $('.task-prio', li);
    prio.setAttribute('aria-label', (t.priority ? 'Move back to tasks: ' : 'Make top priority: ') + t.text);
    prio.title = t.priority ? 'Move back to tasks' : 'Make it a top priority';
    $('.task-del', li).setAttribute('aria-label', 'Delete: ' + t.text);
    return li;
  }

  function matchesFilter(t) {
    return state.filter === 'all' || (state.filter === 'done' ? isDone(t) : !isDone(t));
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
    const prio = visibleTasks().filter(t => t.priority).sort((a, b) => isDone(a) - isDone(b));
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
    const left = visibleTasks().filter(t => !isDone(t)).length;
    els.left.textContent = `${left} task${left === 1 ? '' : 's'} left`;
    els.clear.disabled = !visibleTasks().some(t => !t.daily && t.done_at);
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
    const pct = vis.length ? Math.round(vis.filter(isDone).length / vis.length * 100) : 0;
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
  // Back (Android button / gesture) works like an app: Chats or Settings → back to the to-do list.
  let screenPushed = false;
  function showScreen(name, { nav = false } = {}) {
    if (!['tasks', 'chats', 'ai', 'settings'].includes(name)) name = 'tasks';
    if (nav && name === 'tasks' && screenPushed && history.state && history.state.screen) { screenPushed = false; history.back(); return; }
    if (nav && name !== 'tasks' && !screenPushed && location.hash !== '#' + name) {
      history.pushState({ screen: name }, '', '#' + name);
      screenPushed = true;
    }
    if (name === 'tasks') screenPushed = false;
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
    addEventListener('appinstalled', () => { deferredPrompt = null; updateInstallUI(); toast('Installed. Find "Hustl" with your apps 🎧'); });
    els.install.addEventListener('click', promptInstall);
    els.install2.addEventListener('click', promptInstall);
    updateInstallUI();
  }

  /* ---------------- Phone app: install card, Back button, keyboard, badge, haptics ---------------- */
  const isPhone = () => matchMedia('(pointer: coarse)').matches || /android|iphone|ipad|ipod/i.test(navigator.userAgent);
  const buzz = ms => { try { if (isPhone()) navigator.vibrate?.(ms); } catch {} };

  // The card at the top of Tasks: first install Hustl (phones), then allow notifications so alarms
  // reach you even when it's closed. "Not now" hides that step for a week.
  function phoneStep() {
    const perm = 'Notification' in window ? Notification.permission : 'unsupported';
    if (isPhone() && !isStandalone()) {
      if (isIOS()) return { key: 'install-ios', title: 'Add Hustl to your Home Screen', go: 'How?',
        text: 'It opens like an app and works offline. On iPhone, reminders can only reach you when Hustl is closed if it’s installed.' };
      return { key: 'install', title: 'Install Hustl on your phone', go: deferredPrompt ? 'Install' : 'How?',
        text: 'It opens like an app, works offline, and reminder alarms reach you even when it’s closed.' };
    }
    if (perm === 'default') return { key: 'notify', title: 'Turn on reminder alarms', go: 'Turn on',
      text: 'Allow notifications so your reminders ring even when Hustl is closed.' };
    if (perm === 'denied') return { key: 'denied', title: 'Reminder alarms are blocked', go: 'OK',
      text: isPhone() ? 'Turn on notifications for Hustl in your phone’s Settings → Apps → Notifications.' : 'Allow notifications for this site in your browser’s settings.' };
    return null;
  }
  function renderPhoneCard() {
    if (!els.phoneCard) return;
    const step = phoneStep();
    let hidden = !step;
    if (step) { try { hidden = Date.now() < Number(localStorage.getItem('hustl:card:' + step.key) || 0); } catch {} }
    els.phoneCard.hidden = hidden;
    if (hidden) return;
    els.phoneCard.dataset.step = step.key;
    els.phoneTitle.textContent = step.title;
    els.phoneText.textContent = step.text;
    els.phoneGo.textContent = step.go;
  }
  async function phoneCardGo() {
    const key = els.phoneCard.dataset.step;
    if (key === 'install' && deferredPrompt) await promptInstall();
    else if (key === 'install') toast('In Chrome, tap ⋮ (top right) → Install app (or Add to Home screen).', { sticky: true, actionLabel: 'Got it', action: () => {} });
    else if (key === 'install-ios') toast('In Safari, tap Share (the square with ↑), scroll down, tap Add to Home Screen, then Add.', { sticky: true, actionLabel: 'Got it', action: () => {} });
    else if (key === 'notify') await askNotifications();
    else if (key === 'denied') hidePhoneCard();
    renderPhoneCard();
  }
  function hidePhoneCard() {
    try { localStorage.setItem('hustl:card:' + els.phoneCard.dataset.step, String(Date.now() + 7 * 864e5)); } catch {}
    renderPhoneCard();
  }

  // App icon badge: unread chats + overdue reminders (where the phone supports it).
  const badgeParts = {};
  function setBadge(part, n) {
    badgeParts[part] = n || 0;
    const total = Object.values(badgeParts).reduce((a, b) => a + b, 0);
    try { if (total) navigator.setAppBadge?.(total); else navigator.clearAppBadge?.(); } catch {}
  }

  function setupPhone() {
    els.phoneGo.addEventListener('click', phoneCardGo);
    els.phoneClose.addEventListener('click', hidePhoneCard);
    addEventListener('appinstalled', renderPhoneCard);
    addEventListener('beforeinstallprompt', () => setTimeout(renderPhoneCard, 0));
    renderPhoneCard();

    // Back closes the open pop-up first (instead of leaving the app).
    const show = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function () {
      show.call(this);
      if (this.dataset.hist) return;
      this.dataset.hist = '1';
      history.pushState({ ...(history.state || {}), dlg: this.id }, '');
      this.addEventListener('close', () => {
        delete this.dataset.hist;
        if (history.state && history.state.dlg === this.id) history.back();
      }, { once: true });
    };
    addEventListener('popstate', () => {
      const top = [...document.querySelectorAll('dialog[open]')].pop();
      if (top && top.dataset.hist && !(history.state && history.state.dlg === top.id)) top.close();
    });

    // On-screen keyboard open → hide the bottom menu so the box you type in stays visible.
    const vv = window.visualViewport;
    if (vv) {
      const kb = () => document.body.classList.toggle('kb-open', isPhone() && innerHeight - vv.height > 150);
      vv.addEventListener('resize', kb);
      addEventListener('focusout', () => setTimeout(kb, 300));
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
    midnightTimer = setTimeout(() => { rollOver(); render(); scheduleMidnight(); }, next - now + 1000);
  }

  // A new day: "just today" tasks from earlier days vanish (daily ones come back unticked by themselves).
  // Removed with a sync-able delete, so every device agrees. The streak log is untouched.
  async function rollOver() {
    const today = dayKey(), ts = nowISO();
    const gone = state.tasks.filter(t => !t.deleted && !t.daily && t.day && t.day < today);
    gone.forEach(t => { t.deleted = true; t.updated_at = ts; });
    if (gone.length) { await store.putTasks(gone); emit('tasks', gone); }
    return gone.length;
  }

  // Tasks from before daily tasks existed have no day: give them today, so the update clears nothing.
  async function giveTasksADay() {
    const today = dayKey();
    const old = state.tasks.filter(t => !t.deleted && !t.daily && !t.day);
    old.forEach(t => { t.day = today; });
    if (old.length) await store.putTasks(old);
  }

  /* ---------------- Events ---------------- */
  function bind() {
    const onAdd = (form, input, opts) => form.addEventListener('submit', async e => {
      e.preventDefault();
      const text = input.value;
      input.value = '';
      if (opts.priority && openPriorities() >= PRIORITY_MAX) { toast('Top Priorities holds six. Finish one first ✒️'); return; }
      const t = await addTask(text, { priority: !!opts.priority, daily: !!opts.daily });
      if (!t) { input.focus(); return; }
      if (state.filter === 'done') setFilter('active', false);
      render(t.id);
      // ready for the next one, unless you've already moved on to another box
      if (document.activeElement === document.body || form.contains(document.activeElement)) input.focus();
    });
    // Adding a task asks: just for today, or every day?
    let kind = 'once';
    const setKind = k => { kind = k; els.kinds.forEach(b => b.setAttribute('aria-checked', String(b.dataset.kind === k))); };
    els.kinds.forEach(b => b.addEventListener('click', () => {
      setKind(b.dataset.kind);
      if (els.input.value.trim()) els.form.requestSubmit(); else els.input.focus();
    }));
    els.form.addEventListener('submit', () => {
      const daily = kind === 'daily';
      setTimeout(() => setKind('once'), 0);   // back to "Just today" for the next one (after the task is saved)
      if (daily && els.input.value.trim()) toast('↻ Daily task added: it’ll be here every day until you remove it.');
    });
    onAdd(els.form, els.input, { get daily() { return kind === 'daily'; } });
    // keep the choice on screen while there's text (a tap on it can take focus away on iPhone)
    els.input.addEventListener('input', () => els.form.classList.toggle('has-text', !!els.input.value.trim()));
    els.form.addEventListener('submit', () => setTimeout(() => els.form.classList.toggle('has-text', !!els.input.value.trim()), 0));
    onAdd(els.prioForm, els.prioInput, { priority: true });

    const onListClick = async e => {
      const li = e.target.closest('.task'); if (!li) return;
      const id = li.dataset.id;
      const inPrio = !!li.closest('#prioList');
      if (e.target.closest('.task-check')) {
        const r = await toggleTask(id); if (!r) return;
        const nowDone = isDone(r.task);
        li.classList.toggle('done', nowDone);
        const btn = $('.task-check', li);
        btn.setAttribute('aria-pressed', String(nowDone));
        btn.setAttribute('aria-label', (nowDone ? 'Mark not done: ' : 'Mark done: ') + r.task.text);
        if (nowDone) { inkSplash(li); sound.strum(); buzz(12); }
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
        const t = state.tasks.find(x => x.id === id);
        await deleteTask(id);
        if (t && t.daily) toast(`Daily task removed: it won’t come back tomorrow.`, { actionLabel: 'Undo', duration: 6000, action: async () => {
          t.deleted = false; t.updated_at = nowISO(); await store.putTasks([t]); emit('tasks', [t]); render(t.id);
        } });
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
      await askNotifications();   // the first reminder is a good moment to ask (it needs a tap)
      const r = await addAlarm(els.alarmText.value, els.alarmAt.value);
      if (r.error) return toast(r.error);
      els.alarmText.value = '';
      toast(`⏰ Alarm set for ${fmtAlarmTime(r.alarm.due_at)}`);
      buzz(20);
      renderPhoneCard();
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
      if (m.type === 'push') {   // a push arrived while Hustl is open and in front: ring here / fetch the new reminder
        scheduleAlarms();
        if (window.HustlSync) window.HustlSync.syncNow();
        return;
      }
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

    $$('.radio-key').forEach(b => b.addEventListener('click', () => showScreen(b.dataset.screen, { nav: true })));
    addEventListener('hashchange', () => showScreen(location.hash.slice(1)));
    els.heroStreak.addEventListener('click', () => els.card.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' }));

    els.lamp.addEventListener('click', () => setSettings({ theme: isDark() ? 'light' : 'dark' }));
    $$('[data-theme-choice]').forEach(b => b.addEventListener('click', () => setSettings({ theme: b.dataset.themeChoice })));
    darkMQ.addEventListener?.('change', applyTheme);
    els.sound.addEventListener('change', () => { setSettings({ sound: els.sound.checked }); if (els.sound.checked) sound.strum(); });

    $('#exportBtn').addEventListener('click', exportJSON);
    $('#importFile').addEventListener('change', e => { importJSON(e.target.files[0]); e.target.value = ''; });

    document.addEventListener('visibilitychange', async () => { if (document.visibilityState === 'visible') { await rollOver(); render(); scheduleMidnight(); scheduleAlarms(); } });
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
      jMonth: $('#jMonth'), jDate: $('#jDate'), kinds: $$('#addForm .kind-btn'),
      phoneCard: $('#phoneCard'), phoneTitle: $('#phoneCardTitle'), phoneText: $('#phoneCardText'), phoneGo: $('#phoneCardGo'), phoneClose: $('#phoneCardClose'),
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
    await giveTasksADay();
    await rollOver();

    els.sound.checked = !!state.settings.sound;
    applyTheme();
    bind();
    showScreen('tasks'); // the app always opens on the to-do list
    render();
    scheduleMidnight();
    scheduleAlarms();
    takeUrlAction();
    setupInstall();
    setupPhone();
    setupSW();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

    window.dispatchEvent(new CustomEvent('hustl:ready'));
  }

  /* Public API for sync.js / chat.js (and debugging). */
  window.Hustl = {
    version: APP_VERSION, store, state, toast, render, mergeData, mergeNotes, setNote, togglePriority, mergeAlarms, addAlarm, deleteAlarm, setPushActive, setBadge, rollOver, isDone, addTask, toggleTask, deleteTask, rekeyTasks, showScreen, escapeHTML, uuid, dayKey,
    streakInfo, currentStreak, bestStreak,
    on: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    ready: new Promise(res => addEventListener('hustl:ready', res, { once: true })),
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
