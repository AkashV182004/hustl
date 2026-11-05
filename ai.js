/* Hustl AI — an assistant tab, answered by Google Gemini through the "ai" Edge Function
   (supabase/functions/ai). It sees your tasks and reminders and can change them: every change it asks for is
   carried out here on the device (so it works with offline storage and sync) and shown as a card.
   Needs a connection and a signed-in account (for the daily message limit). */
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const cfg = window.HUSTL_CONFIG || {};
  const KEEP = 60;   // messages kept on the device

  let H = null, session = null;
  let log = [];      // [{ role: 'user' | 'model', text, cards?: [{ ok, label }], error?, at }]
  let busy = false;

  const els = {
    screen: $('#screen-ai'), log: $('#aiLog'), form: $('#aiForm'), text: $('#aiText'), send: $('#aiSend'),
    signedOut: $('#aiSignedOut'), chat: $('#aiChat'), left: $('#aiLeft'), suggest: $('#aiSuggest'),
    clear: $('#aiClear'), goSignIn: $('#aiGoSignIn'), offline: $('#aiOffline'),
  };

  /* ---------------- Saved conversation ---------------- */
  const key = () => 'ai:' + (session ? session.user.id : 'none');
  async function load() { log = session ? (await H.store.get(key(), [])) || [] : []; render(); }
  const save = () => session && H.store.set(key(), log.slice(-KEEP));

  /* ---------------- What the assistant sees ---------------- */
  // Local time with the UTC offset, e.g. 2026-11-06T10:00:00+05:30 — so "at 6 pm" means 6 pm here.
  function localISO(d = new Date()) {
    const off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-', abs = Math.abs(off);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  }
  function context() {
    const tasks = H.state.tasks.filter(t => !t.deleted).map(t => ({ id: t.id, text: t.text, done: H.isDone(t), daily: !!t.daily, priority: !!t.priority }));
    const dayAgo = Date.now() - 864e5;
    const reminders = H.state.alarms.filter(a => !a.deleted && (!a.done_at || Date.parse(a.done_at) > dayAgo))
      .map(a => ({ id: a.id, text: a.text, due_at: localISO(new Date(a.due_at)), done: !!a.done_at }));
    return { now: localISO(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone || '', tasks, reminders };
  }
  // History for the model: plain text, with what was actually done written underneath its own answers.
  const history = () => log.filter(m => !m.error).slice(-20).map(m => ({
    role: m.role,
    text: m.role === 'model' && m.cards && m.cards.length ? `${m.text}\n[${m.cards.map(c => c.label).join('; ')}]` : m.text,
  }));

  /* ---------------- Carrying out what it asked for ---------------- */
  const fmtWhen = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const taskById = id => H.state.tasks.find(t => t.id === id && !t.deleted);
  async function act({ name, args = {} }) {
    const text = String(args.text || '').trim().replace(/\s+/g, ' ').slice(0, 200);
    if (name === 'add_task') {
      if (!text) return { ok: false, label: 'Couldn’t add a task with no text' };
      let priority = !!args.priority;
      const full = priority && H.state.tasks.filter(t => !t.deleted && t.priority && !H.isDone(t)).length >= 6;
      if (full) priority = false;
      const t = await H.addTask(text, { daily: !!args.daily, priority });
      return t ? { ok: true, label: `${priority ? '⚡ Top priority' : args.daily ? '↻ Daily task added' : '✓ Task added'}: ${t.text}${full ? ' (Top Priorities was full)' : ''}` }
        : { ok: false, label: 'Couldn’t add that task' };
    }
    if (name === 'complete_task') {
      const t = taskById(args.task_id);
      if (!t) return { ok: false, label: 'Couldn’t find that task' };
      if (!H.isDone(t)) await H.toggleTask(t.id);
      return { ok: true, label: `☑ Ticked: ${t.text}` };
    }
    if (name === 'set_priority') {
      const t = taskById(args.task_id);
      if (!t) return { ok: false, label: 'Couldn’t find that task' };
      if (!!t.priority !== !!args.priority) {
        const r = await H.togglePriority(t.id);
        if (r && r.full) return { ok: false, label: `Top Priorities is full (6), so “${t.text}” stayed where it is` };
      }
      return { ok: true, label: `${args.priority ? '⚡ Top priority' : 'Moved back to tasks'}: ${t.text}` };
    }
    if (name === 'delete_task') {
      const t = taskById(args.task_id);
      if (!t) return { ok: false, label: 'Couldn’t find that task' };
      await H.deleteTask(t.id);
      return { ok: true, label: `🗑 Removed: ${t.text}` };
    }
    if (name === 'add_reminder') {
      const due = new Date(args.due_at);
      if (!text || isNaN(due)) return { ok: false, label: 'Couldn’t set that reminder (no clear time)' };
      const r = await H.addAlarm(text, due);
      return r.error ? { ok: false, label: r.error } : { ok: true, label: `⏰ Reminder set: ${r.alarm.text} · ${fmtWhen.format(due)}` };
    }
    if (name === 'delete_reminder') {
      const a = H.state.alarms.find(x => x.id === args.reminder_id && !x.deleted);
      if (!a) return { ok: false, label: 'Couldn’t find that reminder' };
      await H.deleteAlarm(a.id);
      return { ok: true, label: `🗑 Reminder removed: ${a.text}` };
    }
    return { ok: false, label: 'Skipped something I can’t do' };
  }

  /* ---------------- Talking to it ---------------- */
  async function send(textIn) {
    const text = String(textIn ?? els.text.value).trim().slice(0, 2000);
    if (!text || busy) return;
    if (!session) return render();
    if (!navigator.onLine) return H.toast('Hustl AI needs an internet connection.');
    els.text.value = ''; grow();
    log.push({ role: 'user', text, at: new Date().toISOString() });
    busy = true; render({ scroll: true });
    let reply;
    try {
      const res = await fetch(cfg.SUPABASE_URL + '/functions/v1/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: cfg.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + session.access_token },
        body: JSON.stringify({ messages: history(), context: context() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) reply = { role: 'model', error: true, text: data.message || (res.status === 404 ? 'Hustl AI isn’t set up yet.' : 'Hustl AI had a problem. Please try again.') };
      else {
        const cards = [];
        for (const a of Array.isArray(data.actions) ? data.actions.slice(0, 10) : []) cards.push(await act(a));
        if (cards.some(c => c.ok)) H.render();
        reply = { role: 'model', text: String(data.text || '').trim() || (cards.length ? 'Done.' : '…'), cards };
        if (typeof data.remaining === 'number') els.left.textContent = data.remaining <= 50 ? `${data.remaining} left today` : '';
      }
    } catch {
      reply = { role: 'model', error: true, text: 'Couldn’t reach Hustl AI. Check your connection and try again.' };
    }
    reply.at = new Date().toISOString();
    log.push(reply);
    busy = false;
    await save();
    render({ scroll: true });
  }

  /* ---------------- Drawing ---------------- */
  // Light formatting without HTML: **bold** and "- " / "* " bullets. Everything is set as text.
  function richText(el, text) {
    for (const [i, line] of String(text).split('\n').entries()) {
      if (i) el.appendChild(document.createElement('br'));
      const l = line.replace(/^\s*[-*]\s+/, '• ');
      l.split(/(\*\*[^*]+\*\*)/).forEach(seg => {
        if (/^\*\*[^*]+\*\*$/.test(seg)) { const b = document.createElement('b'); b.textContent = seg.slice(2, -2); el.appendChild(b); }
        else if (seg) el.appendChild(document.createTextNode(seg.replace(/\*\*/g, '')));
      });
    }
  }
  function bubble(m) {
    const li = document.createElement('li');
    li.className = 'ai-msg ' + (m.role === 'user' ? 'me' : 'bot') + (m.error ? ' error' : '');
    const p = document.createElement('p');
    if (m.role === 'user') p.textContent = m.text; else richText(p, m.text);
    li.appendChild(p);
    for (const c of m.cards || []) {
      const card = document.createElement('div');
      card.className = 'ai-card' + (c.ok ? '' : ' fail');
      card.textContent = c.ok ? c.label : '⚠ ' + c.label;
      li.appendChild(card);
    }
    return li;
  }
  function render(opts = {}) {
    const signedIn = !!session;
    els.signedOut.hidden = signedIn;
    els.chat.hidden = !signedIn;
    els.offline.hidden = navigator.onLine;
    if (!signedIn) return;
    const items = log.map(bubble);
    if (!log.length) {
      const hi = document.createElement('li');
      hi.className = 'ai-msg bot hello';
      const p = document.createElement('p');
      p.textContent = 'Hi! I’m Hustl AI. I can plan your day, add tasks and daily tasks, set reminders with alarms, and tick things off. What do you need?';
      hi.appendChild(p);
      items.push(hi);
    }
    if (busy) {
      const t = document.createElement('li');
      t.className = 'ai-msg bot typing';
      t.setAttribute('aria-label', 'Hustl AI is thinking');
      t.innerHTML = '<span></span><span></span><span></span>';
      items.push(t);
    }
    els.log.replaceChildren(...items);
    els.suggest.hidden = log.length > 0 || busy;
    els.send.disabled = busy;
    if (opts.scroll) requestAnimationFrame(() => els.log.lastElementChild && els.log.lastElementChild.scrollIntoView({ block: 'end', behavior: 'smooth' }));
  }
  function grow() { els.text.style.height = 'auto'; els.text.style.height = Math.min(els.text.scrollHeight, 140) + 'px'; }

  /* ---------------- Boot ---------------- */
  async function onAuth(s) {
    const was = session && session.user.id;
    session = s || null;
    if (session && session.user.id === was) return;
    await load();
  }
  addEventListener('hustl:auth', e => { if (H) onAuth(e.detail.session); });

  async function init() {
    H = window.Hustl;
    await H.ready;
    els.form.addEventListener('submit', e => { e.preventDefault(); send(); });
    els.text.addEventListener('input', grow);
    els.text.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) { e.preventDefault(); send(); }
    });
    els.suggest.addEventListener('click', e => { const b = e.target.closest('[data-say]'); if (b) send(b.dataset.say); });
    els.clear.addEventListener('click', async () => { log = []; await save(); render(); H.toast('Chat cleared'); });
    els.goSignIn.addEventListener('click', () => { H.showScreen('settings'); setTimeout(() => $('#accountPanel').scrollIntoView({ block: 'start' }), 50); });
    addEventListener('online', () => render());
    addEventListener('offline', () => render());
    H.on((type, detail) => { if (type === 'screen' && detail === 'ai') render({ scroll: true }); });
    await onAuth(window.HustlSync && window.HustlSync.session);
  }

  window.HustlAI = { send, get log() { return log; } };
  init();
})();
