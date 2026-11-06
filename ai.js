/* Hustl AI — an assistant tab, answered by Google Gemini through the "ai" Edge Function
   (supabase/functions/ai). It sees your tasks and reminders and can change them: every change it asks for is
   carried out here on the device (so it works with offline storage and sync) and shown as a card.
   Photos: the camera button opens a live camera (capture, then "Ask about it" or "Search it") or the gallery; the
   photo is shrunk on the device and sent with the next message for Gemini to look at. Only a small copy is kept
   in the chat on this device. "Search it" asks Hustl AI what it is; it answers and gives a Google search button.
   Needs a connection and a signed-in account (for the daily message limit). */
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const cfg = window.HUSTL_CONFIG || {};
  const KEEP = 60;   // messages kept on the device

  let H = null, session = null;
  let log = [];      // [{ role: 'user' | 'model', text, photo?: dataURL, cards?: [{ ok, label }], error?, at }]
  let photo = null;  // the photo waiting to be sent: { data: base64 JPEG, thumb: small dataURL }
  let busy = false;

  const els = {
    screen: $('#screen-ai'), log: $('#aiLog'), form: $('#aiForm'), text: $('#aiText'), send: $('#aiSend'),
    signedOut: $('#aiSignedOut'), chat: $('#aiChat'), left: $('#aiLeft'), suggest: $('#aiSuggest'),
    clear: $('#aiClear'), goSignIn: $('#aiGoSignIn'), offline: $('#aiOffline'),
    camera: $('#aiCamera'), photoInput: $('#aiPhotoInput'), attach: $('#aiAttach'), attachImg: $('#aiAttachImg'),
    attachRemove: $('#aiAttachRemove'), photoView: $('#photoView'), photoImg: $('#photoViewImg'),
    camMenu: $('#aiCamMenu'), camLive: $('#aiCamLive'), camPick: $('#aiCamPick'),
    lens: $('#lensDlg'), lensVideo: $('#lensVideo'), lensShot: $('#lensShot'), lensMsg: $('#lensMsg'), lensClose: $('#lensClose'),
    lensFlip: $('#lensFlip'), lensLive: $('#lensLive'), lensAfter: $('#lensAfter'), lensGallery: $('#lensGallery'), lensSnap: $('#lensSnap'),
    lensRetake: $('#lensRetake'), lensAsk: $('#lensAsk'), lensSearch: $('#lensSearch'),
  };

  /* ---------------- Saved conversation ---------------- */
  const key = () => 'ai:' + (session ? session.user.id : 'none');
  async function load() { log = session ? (await H.store.get(key(), [])) || [] : []; render(); }
  const save = () => session && Promise.resolve(H.store.set(key(), log.slice(-KEEP))).catch(e => console.warn('Hustl AI chat not saved:', e && e.message));

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
  // A message that had a photo is sent as "[photo] …" (only the newest photo itself goes to the model).
  const history = () => log.filter(m => !m.error).slice(-20).map(m => ({
    role: m.role,
    text: m.role === 'model' && m.cards && m.cards.length ? `${m.text}\n[${m.cards.map(c => c.label).join('; ')}]`
      : m.photo ? `[photo] ${m.text || ''}`.trim() : m.text,
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
    if (name === 'search_web') {
      const q = String(args.query || '').trim().replace(/\s+/g, ' ').slice(0, 120);
      return q ? { ok: true, label: `🔍 Search Google: ${q}`, search: q } : { ok: false, label: 'Couldn’t make a search for that' };
    }
    return { ok: false, label: 'Skipped something I can’t do' };
  }

  /* ---------------- Photos ---------------- */
  const MAX_INPUT = 30 * 1024 * 1024;   // what we accept from the phone; it is shrunk well below this
  const SEND_SIDE = 1280, KEEP_SIDE = 640;
  async function readImage(file) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch {
      return new Promise((res, rej) => {
        const img = new Image(); const url = URL.createObjectURL(file);
        img.onload = () => { URL.revokeObjectURL(url); res(img); };
        img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('unreadable image')); };
        img.src = url;
      });
    }
  }
  // The picture as a JPEG data URL no bigger than `side` px on its longest edge.
  function jpeg(src, side, quality) {
    const w = src.width || src.naturalWidth, h = src.height || src.naturalHeight;
    if (!w || !h) throw new Error('empty image');
    const k = Math.min(1, side / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);   // transparent PNGs get a white background
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  }
  // What gets sent (up to 1280px) and the small copy kept in the chat (640px).
  function makePhoto(src) {
    const big = jpeg(src, SEND_SIDE, 0.82), thumb = jpeg(src, KEEP_SIDE, 0.72);
    return { data: big.slice(big.indexOf(',') + 1), thumb };
  }
  async function usePhoto(file) {
    if (!file) return;
    if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name || '')) return H.toast('Please choose a photo.');
    if (file.size > MAX_INPUT) return H.toast('That photo is too large (over 30 MB).');
    try {
      const src = await readImage(file);
      photo = makePhoto(src);
      if (src.close) src.close();
    } catch { photo = null; return H.toast('Couldn’t read that photo. Try a JPEG or PNG.'); }
    showAttach();
    els.text.focus({ preventScroll: true });
  }
  function showAttach() {
    els.attach.hidden = !photo;
    if (photo) els.attachImg.src = photo.thumb; else els.attachImg.removeAttribute('src');
  }
  function viewPhoto(src) {
    if (!els.photoView || !els.photoImg) return;
    els.photoImg.src = src; els.photoImg.alt = 'Your photo';
    els.photoView.showModal();
  }

  /* ---------------- Live camera ---------------- */
  const canLive = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  let lensStream = null, facing = 'environment', shot = null;
  function menu(open) {
    els.camMenu.hidden = !open;
    els.camera.setAttribute('aria-expanded', String(!!open));
  }
  function stopLens() {
    if (lensStream) { lensStream.getTracks().forEach(t => t.stop()); lensStream = null; }
    els.lensVideo.srcObject = null;
  }
  function lensState(captured) {
    els.lensVideo.hidden = captured; els.lensShot.hidden = !captured;
    els.lensLive.hidden = captured; els.lensAfter.hidden = !captured;
    els.lensFlip.disabled = captured;
  }
  async function startLens() {
    stopLens();
    els.lensMsg.hidden = true; els.lensSnap.disabled = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false });
      if (!els.lens.open) { stream.getTracks().forEach(t => t.stop()); return; }   // closed while we were asking
      lensStream = stream;
      els.lensVideo.srcObject = stream;
      els.lensVideo.classList.toggle('mirror', facing === 'user');
      await els.lensVideo.play().catch(() => {});
      els.lensSnap.disabled = false;
      const cams = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter(d => d.kind === 'videoinput');
      els.lensFlip.hidden = cams.length < 2;
    } catch {
      els.lensMsg.textContent = 'Couldn’t open the camera. Allow camera access for Hustl in your phone’s settings, or choose a photo from the gallery.';
      els.lensMsg.hidden = false;
    }
  }
  async function openLens() {
    menu(false);
    if (!canLive()) { els.photoInput.value = ''; els.photoInput.click(); return; }
    shot = null; lensState(false);
    els.lens.showModal();
    await startLens();
  }
  function snapLens() {
    const v = els.lensVideo;
    if (!v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);   // as the camera sees it (text stays readable)
    try { shot = makePhoto(c); } catch { return H.toast('Couldn’t take the picture. Please try again.'); }
    els.lensShot.src = shot.thumb;
    lensState(true);
    stopLens();
    els.lensSearch.focus();
  }
  function useShot(then) {
    if (!shot) return;
    photo = shot; shot = null;
    els.lens.close();
    showAttach();
    then();
  }

  /* ---------------- Talking to it ---------------- */
  async function send(textIn) {
    const text = String(textIn ?? els.text.value).trim().slice(0, 2000);
    const pic = textIn == null ? photo : null;   // suggestion chips never carry the waiting photo
    if ((!text && !pic) || busy) return;
    if (!session) return render();
    if (!navigator.onLine) return H.toast('Hustl AI needs an internet connection.');
    if (textIn == null) { els.text.value = ''; grow(); }
    if (pic) { photo = null; showAttach(); }
    log.push({ role: 'user', text, ...(pic ? { photo: pic.thumb } : {}), at: new Date().toISOString() });
    busy = true; render({ scroll: true });
    let reply;
    try {
      const res = await fetch(cfg.SUPABASE_URL + '/functions/v1/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: cfg.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + session.access_token },
        body: JSON.stringify({ messages: history(), context: context(), ...(pic ? { image: { mime: 'image/jpeg', data: pic.data } } : {}) }),
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
    if (m.photo) {
      const img = document.createElement('img');
      img.className = 'ai-photo'; img.src = m.photo; img.alt = 'Your photo'; img.loading = 'lazy';
      img.addEventListener('click', () => viewPhoto(m.photo));
      li.appendChild(img);
      if (!m.text) li.classList.add('photo-only');
    }
    if (m.text || !m.photo) {
      const p = document.createElement('p');
      if (m.role === 'user') p.textContent = m.text; else richText(p, m.text);
      li.appendChild(p);
    }
    for (const c of m.cards || []) {
      const card = document.createElement('div');
      card.className = 'ai-card' + (c.ok ? '' : ' fail') + (c.ok && c.search ? ' search' : '');
      if (c.ok && c.search) {
        const a = document.createElement('a');
        a.className = 'ai-search-link';
        a.href = 'https://www.google.com/search?q=' + encodeURIComponent(String(c.search).slice(0, 120));
        a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.textContent = '🔍 Search Google: ' + c.search;
        card.appendChild(a);
      } else card.textContent = c.ok ? c.label : '⚠ ' + c.label;
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
      p.textContent = 'Hi! I’m Hustl AI. I can plan your day, add tasks and daily tasks, set reminders with alarms, and tick things off. Tap 📷 to show me a photo. What do you need?';
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
    els.camera.disabled = busy;
    if (opts.scroll) requestAnimationFrame(() => els.log.lastElementChild && els.log.lastElementChild.scrollIntoView({ block: 'end', behavior: 'smooth' }));
  }
  function grow() { els.text.style.height = 'auto'; els.text.style.height = Math.min(els.text.scrollHeight, 140) + 'px'; }

  /* ---------------- Boot ---------------- */
  async function onAuth(s) {
    const was = session && session.user.id;
    session = s || null;
    if (session && session.user.id === was) return;
    photo = null; showAttach();
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
    // Phones offer "Take photo" or the gallery here; computers open a file picker.
    els.camera.setAttribute('aria-haspopup', 'menu');
    els.camera.addEventListener('click', e => {
      e.stopPropagation();
      if (busy) return;
      if (!canLive()) { els.photoInput.value = ''; els.photoInput.click(); return; }   // no live camera here: just the picker
      menu(els.camMenu.hidden);
    });
    els.camLive.addEventListener('click', openLens);
    els.camPick.addEventListener('click', () => { menu(false); els.photoInput.value = ''; els.photoInput.click(); });
    document.addEventListener('click', e => { if (!els.camMenu.hidden && !els.camMenu.contains(e.target)) menu(false); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !els.camMenu.hidden) { menu(false); els.camera.focus(); } });
    els.lensSnap.addEventListener('click', snapLens);
    els.lensClose.addEventListener('click', () => els.lens.close());
    els.lens.addEventListener('close', () => { stopLens(); shot = null; });
    els.lensFlip.addEventListener('click', () => { facing = facing === 'environment' ? 'user' : 'environment'; startLens(); });
    els.lensRetake.addEventListener('click', () => { shot = null; lensState(false); startLens(); });
    els.lensGallery.addEventListener('click', () => { els.lens.close(); els.photoInput.value = ''; els.photoInput.click(); });
    els.lensAsk.addEventListener('click', () => useShot(() => els.text.focus({ preventScroll: true })));
    els.lensSearch.addEventListener('click', () => useShot(() => {
      if (!els.text.value.trim()) els.text.value = 'What is this? Search it for me.';
      send();
    }));
    els.photoInput.addEventListener('change', () => usePhoto(els.photoInput.files && els.photoInput.files[0]));
    els.attachRemove.addEventListener('click', () => { photo = null; showAttach(); });
    els.goSignIn.addEventListener('click', () => { H.showScreen('settings'); setTimeout(() => $('#accountPanel').scrollIntoView({ block: 'start' }), 50); });
    addEventListener('online', () => render());
    addEventListener('offline', () => render());
    H.on((type, detail) => { if (type === 'screen' && detail === 'ai') render({ scroll: true }); });
    await onAuth(window.HustlSync && window.HustlSync.session);
  }

  window.HustlAI = { send, usePhoto, openLens, get log() { return log; }, get photo() { return photo; } };
  init();
})();
