/* Hustl — User IDs, follows and chat.
   Two people can chat only when they follow each other; the database enforces that (supabase.sql).
   Messages are saved on the device, sent through an outbox (so offline notes go out later, never twice),
   and arrive live through Supabase Realtime, with a refresh on open/focus/reconnect as a backstop.
   Notes last 7 days: the server stops showing them after that and deletes them, and so does this device.
   Photos: taken with the camera (or chosen), shrunk to 1600px JPEG, uploaded to the private "chat-media" bucket,
   and shown through short-lived signed links. They follow the same 7-day rule. */
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const HANDLE_RE = /^[a-z]+-[a-z]+-\d{4}$/;
  const OFFLINE = "Radio's off… reconnect to chat.";
  const AVATAR_COLORS = ['#c8642b', '#b8921c', '#4f7c79', '#6b7a3a', '#8a4a2c', '#7a5c8a'];
  const KEEP = 500;            // messages kept on the device (newest first)
  const MAX_LEN = 4000;        // matches the check in supabase.sql
  const MSG_COLS = 'id,sender_id,recipient_id,body,media_path,media_type,created_at,read_at';
  const TTL_MS = 7 * 24 * 60 * 60 * 1000; // notes disappear after 7 days (matches supabase.sql)

  let H = null, sb = null, session = null;
  let me = null;        // { id, handle, display_name }
  let people = [];      // [{ id, handle, display_name, iFollow, followsMe }]
  let msgs = [];        // every message we know about, oldest first; mine carry status 'pending' | 'failed' until sent
  let openId = null;    // the conversation on screen
  let live = null;      // Realtime channel
  let inflight = null, rerun = false; // one refresh at a time; a call made mid-refresh runs it once more
  let flushing = false;
  let purged = false;   // asked the server to delete expired notes this session

  const els = {
    signedOut: $('#chatsSignedOut'), signedIn: $('#chatsSignedIn'), addBtn: $('#addFriendBtn'), goSignIn: $('#goSignIn'),
    offline: $('#socialOffline'), empty: $('#peopleEmpty'),
    friendsSec: $('#friendsSec'), requestsSec: $('#requestsSec'), waitingSec: $('#waitingSec'),
    friends: $('#friendsList'), requests: $('#requestsList'), waiting: $('#waitingList'),
    profileBox: $('#profileBox'), nameForm: $('#nameForm'), nameInput: $('#displayName'),
    dlg: $('#addFriendDlg'), form: $('#addFriendForm'), friendId: $('#friendId'), msg: $('#addFriendMsg'), go: $('#addFriendGo'),
    confirm: $('#confirmDlg'), confirmText: $('#confirmText'), confirmOk: $('#confirmOk'),
    convo: $('#convo'), back: $('#convoBack'), cAvatar: $('#convoAvatar'), cName: $('#convoName'), cSub: $('#convoSub'),
    notes: $('#noteList'), locked: $('#convoLocked'), composer: $('#composer'), text: $('#composerText'), send: $('#composerSend'),
    navKey: $('.radio-key[data-screen="chats"]'), placeholder: $('#convoPlaceholder'), screen: $('#screen-chats'),
    counts: $('#followCounts'),
    camBtn: $('#cameraBtn'), camInput: $('#cameraInput'), pick: $('#photoPick'),
    camDlg: $('#cameraDlg'), camVideo: $('#cameraVideo'), camShot: $('#cameraShot'), camMsg: $('#cameraMsg'),
    camSnap: $('#cameraSnap'), camSend: $('#cameraSend'), camRetake: $('#cameraRetake'), camCancel: $('#cameraCancel'), camPick: $('#cameraPick'),
    photoView: $('#photoView'), photoImg: $('#photoViewImg'), photoClose: $('#photoViewClose'),
  };
  const wide = () => matchMedia('(min-width: 900px)').matches; // computer: list and chat side by side

  const otherOf = m => (m.sender_id === (me && me.id) ? m.recipient_id : m.sender_id);
  const isMutual = p => !!(p && p.iFollow && p.followsMe);
  const personById = id => people.find(p => p.id === id);
  const byTime = (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);

  /* ---------------- Device cache ---------------- */
  async function loadCache() {
    const c = await H.store.get('social', null);
    if (c && session && c.uid === session.user.id) { me = c.me; people = c.people || []; msgs = c.msgs || []; prune(); }
  }

  // Drop notes older than 7 days. Unsent ones stay: the server stamps them with the time they actually go out.
  function prune() {
    const cutoff = Date.now() - TTL_MS;
    const before = msgs.length;
    msgs = msgs.filter(m => m.status === 'pending' || Date.parse(m.created_at) > cutoff);
    return msgs.length !== before;
  }
  const saveCache = () => session && H.store.set('social', { uid: session.user.id, me, people, msgs: msgs.slice(-KEEP) });

  /* ---------------- Loading ---------------- */
  function refresh() {
    if (!sb || !session || !navigator.onLine) { render(); return Promise.resolve(); }
    if (inflight) { rerun = true; return inflight; }
    inflight = (async () => {
      do { rerun = false; await load(); } while (rerun && session);
      inflight = null;
    })();
    return inflight;
  }

  async function load() {
    try {
      const { data: prof, error: pe } = await sb.rpc('ensure_profile');
      if (pe) throw pe;
      me = Array.isArray(prof) ? prof[0] : prof;

      const { data: rows, error: fe } = await sb.from('follows').select('follower_id,followee_id');
      if (fe) throw fe;
      const map = new Map();
      for (const r of rows) {
        const other = r.follower_id === me.id ? r.followee_id : r.follower_id;
        const p = map.get(other) || { id: other, iFollow: false, followsMe: false };
        if (r.follower_id === me.id) p.iFollow = true; else p.followsMe = true;
        map.set(other, p);
      }
      const ids = [...map.keys()];
      if (ids.length) {
        const { data: profs, error } = await sb.from('profiles').select('id,handle,display_name').in('id', ids);
        if (error) throw error;
        profs.forEach(p => Object.assign(map.get(p.id), p));
      }
      people = [...map.values()].filter(p => p.handle)
        .sort((a, b) => a.display_name.localeCompare(b.display_name, undefined, { sensitivity: 'base' }));

      // Recent messages. The server only returns conversations that are still mutual.
      const since = new Date(Date.now() - TTL_MS).toISOString();
      const { data: recent, error: me2 } = await sb.from('messages').select(MSG_COLS).gt('created_at', since)
        .order('created_at', { ascending: false }).limit(KEEP);
      if (me2) throw me2;
      const unsent = msgs.filter(m => m.status === 'pending' || m.status === 'failed');
      const fromServer = new Set(recent.map(m => m.id));
      msgs = [...recent.map(clean), ...unsent.filter(m => !fromServer.has(m.id))].sort(byTime);
      prune();
      await saveCache();
      if (!purged) { purged = true; sb.rpc('purge_expired_messages').then(() => {}, () => {}); removeExpiredPhotos(); } // backstops for the server's own clean-up
      goLive();
      flushOutbox();
      markRead();
    } catch (e) {
      console.warn('Hustl chat refresh failed:', e && (e.message || e));
    } finally {
      render();
    }
  }

  const iso = v => (v ? new Date(v).toISOString() : null);
  const clean = m => ({
    id: m.id, sender_id: m.sender_id, recipient_id: m.recipient_id, body: m.body == null ? null : String(m.body),
    media_path: m.media_path || null, media_type: m.media_type || null,
    created_at: iso(m.created_at), read_at: iso(m.read_at),
  });

  // A message from the server (Realtime or a refresh): add it, or update the copy we have.
  function upsertMsg(row) {
    const m = clean(row);
    const i = msgs.findIndex(x => x.id === m.id);
    if (i >= 0) msgs[i] = { ...msgs[i], ...m, status: undefined };
    else { msgs.push(m); msgs.sort(byTime); }
    return i < 0;
  }

  /* ---------------- Live updates (Supabase Realtime) ---------------- */
  function goLive() {
    if (live || !session || !me || typeof sb.channel !== 'function') return;
    const onRow = ({ new: row }) => {
      if (!row || !row.id) return;
      const isNew = upsertMsg(row);
      if (isNew && row.sender_id !== me.id) {
        const p = personById(row.sender_id);
        if (openId !== row.sender_id || document.hidden) H.toast(`✉️ ${p ? p.display_name : 'New note'}: ${preview(row)}`);
      }
      saveCache(); markRead(); render();
    };
    live = sb.channel('hustl-chat-' + me.id)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: 'recipient_id=eq.' + me.id }, onRow)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: 'sender_id=eq.' + me.id }, onRow)   // my other devices
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: 'sender_id=eq.' + me.id }, onRow)   // read receipts
      .subscribe();
  }
  function stopLive() { if (live) { sb.removeChannel(live); live = null; } }

  /* ---------------- Sending ---------------- */
  async function send(e) {
    e.preventDefault();
    const p = personById(openId);
    const body = els.text.value.replace(/\s+$/, '').replace(/^\s*\n/, '');
    if (!body.trim() || !me || !isMutual(p)) return;
    if (body.length > MAX_LEN) return H.toast(`Notes can be up to ${MAX_LEN} characters.`);
    msgs.push({ id: H.uuid(), sender_id: me.id, recipient_id: p.id, body, media_path: null, media_type: null,
      created_at: new Date().toISOString(), read_at: null, status: 'pending' });
    els.text.value = ''; growText();
    render({ scroll: true });   // show it at once; saving to the device happens just after
    await saveCache();
    flushOutbox();
  }

  // Sends queued notes in order. Each note has its own id, so a retry after a dropped connection can't duplicate it.
  async function flushOutbox() {
    if (flushing || !sb || !session || !me || !navigator.onLine) return;
    flushing = true;
    try {
      for (const m of msgs.filter(x => x.status === 'pending')) {
        if (m.media_path && !m.uploaded) {                                                  // photo: upload the file first
          const up = await uploadPhoto(m);
          if (up === 'retry') break;
          if (up === 'failed') { m.status = 'failed'; continue; }
          m.uploaded = true;
        }
        const { error } = await sb.from('messages').insert({ id: m.id, sender_id: m.sender_id, recipient_id: m.recipient_id, body: m.body,
          media_path: m.media_path || null, media_type: m.media_type || null });
        if (!error || error.code === '23505') { m.status = undefined; if (m.media_path) forgetBlob(m.id); continue; } // 23505: it already arrived
        if (error.code === '42501') { m.status = 'failed'; continue; }                     // no longer following each other
        console.warn('Hustl send paused:', error.message || error);
        break;                                                                              // network trouble: try again later
      }
    } finally {
      flushing = false;
      await saveCache();
      render();
    }
  }

  // Tell the server the open conversation has been read (only the recipient can set read_at).
  async function markRead() {
    if (!openId || !me || document.hidden || els.convo.hidden) return;
    const unread = msgs.filter(m => m.sender_id === openId && m.recipient_id === me.id && !m.read_at);
    if (!unread.length) return;
    const now = new Date().toISOString();
    unread.forEach(m => { m.read_at = now; });
    render(); saveCache();
    if (!navigator.onLine) return;
    const { error } = await sb.from('messages').update({ read_at: now })
      .eq('sender_id', openId).eq('recipient_id', me.id).is('read_at', null);
    if (error) console.warn('Hustl mark-read failed:', error.message || error);
  }

  /* ---------------- Photos ---------------- */
  const BUCKET = 'chat-media';
  const MAX_SIDE = 1600, QUALITY = 0.8, MAX_INPUT = 30 * 1024 * 1024;
  const blobs = new Map();      // photo id → Blob still to upload (also kept in the device store, for offline)
  const localUrls = new Map();  // photo id → object URL of a photo taken on this device
  const signed = new Map();     // storage path → { url, until } short-lived link to a friend's photo
  const loaded = new Map();     // photo id → <img> already loaded (so re-drawing the chat doesn't flicker)
  const blobKey = id => 'chatblob:' + id;
  // The photo still waiting to upload: in memory, or saved on the device (only real Blobs count).
  const pendingBlob = async id => {
    if (blobs.has(id)) return blobs.get(id);
    const b = await H.store.get(blobKey(id), null).catch(() => null);
    return b instanceof Blob ? b : null;
  };
  const forgetBlob = id => { blobs.delete(id); H.store.set(blobKey(id), null).catch(() => {}); };

  // Any picture → JPEG no bigger than 1600px on its longest side (about 80% quality).
  async function shrink(file) {
    let src;
    try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch {
      src = await new Promise((res, rej) => {
        const img = new Image(); const url = URL.createObjectURL(file);
        img.onload = () => { URL.revokeObjectURL(url); res(img); };
        img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('unreadable image')); };
        img.src = url;
      });
    }
    const w = src.width || src.naturalWidth, h = src.height || src.naturalHeight;
    const k = Math.min(1, MAX_SIDE / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);   // transparent PNGs get a white background
    ctx.drawImage(src, 0, 0, c.width, c.height);
    if (src.close) src.close();
    return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('could not encode'))), 'image/jpeg', QUALITY));
  }

  async function sendPhoto(blob) {
    const p = personById(openId);
    if (!blob || !me || !isMutual(p)) return;
    const id = H.uuid();
    blobs.set(id, blob);
    localUrls.set(id, URL.createObjectURL(blob));
    try { await H.store.set(blobKey(id), blob); } catch { /* kept in memory until sent */ }
    msgs.push({ id, sender_id: me.id, recipient_id: p.id, body: null, media_path: `${me.id}/${p.id}/${id}.jpg`, media_type: 'image',
      created_at: new Date().toISOString(), read_at: null, status: 'pending', uploaded: false });
    render({ scroll: true });
    await saveCache();
    flushOutbox();
  }

  // 'ok' | 'retry' (network trouble) | 'failed' (not allowed, or the photo is gone)
  async function uploadPhoto(m) {
    const blob = await pendingBlob(m.id);
    if (!blob) { m.lost = true; return 'failed'; }
    const { error } = await sb.storage.from(BUCKET).upload(m.media_path, blob, { contentType: 'image/jpeg', upsert: false });
    if (!error) return 'ok';
    const why = `${error.statusCode || ''} ${error.message || ''}`;
    if (/409|exists|duplicate/i.test(why)) return 'ok';                       // uploaded already (an earlier try got through)
    if (/403|security|policy|unauthori[sz]ed/i.test(why)) return 'failed';     // no longer following each other
    console.warn('Hustl photo upload paused:', why);
    return 'retry';
  }

  async function photoUrl(m) {
    if (localUrls.has(m.id)) return localUrls.get(m.id);
    if (m.status === 'pending') {
      const b = await pendingBlob(m.id);
      if (b) { const u = URL.createObjectURL(b); localUrls.set(m.id, u); return u; }
      return null;
    }
    const c = signed.get(m.media_path);
    if (c && c.until > Date.now()) return c.url;
    if (!navigator.onLine || !sb) return null;
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(m.media_path, 3600);
    if (error || !data) return null;
    signed.set(m.media_path, { url: data.signedUrl, until: Date.now() + 50 * 60 * 1000 });
    return data.signedUrl;
  }

  function polaroidEl(m, mine) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'polaroid';
    btn.setAttribute('aria-label', 'Open photo');
    const ready = loaded.get(m.id);
    if (ready) btn.appendChild(ready);
    else {
      const wait = document.createElement('span');
      wait.className = 'ph-wait';
      wait.textContent = 'Loading photo…';
      btn.appendChild(wait);
      photoUrl(m).then(url => {
        if (!url) { wait.textContent = navigator.onLine ? 'Photo unavailable' : '📷 Photo: connect to see it'; return; }
        const img = new Image();
        img.alt = mine ? 'Your photo' : `Photo from ${(personById(m.sender_id) || {}).display_name || 'your friend'}`;
        img.decoding = 'async';
        img.onload = () => { loaded.set(m.id, img); if (wait.isConnected) wait.replaceWith(img); };
        img.onerror = () => { wait.textContent = 'Photo unavailable'; };
        img.src = url;
      });
    }
    btn.addEventListener('click', () => {
      const img = btn.querySelector('img');
      if (!img) return;
      els.photoImg.src = img.src; els.photoImg.alt = img.alt;
      els.photoView.showModal();
    });
    return btn;
  }

  // Your own photos past 7 days: ask the server which, then delete the files (at most every 6 hours).
  async function removeExpiredPhotos() {
    try {
      if (Date.now() - (await H.store.get('photoCleanup', 0)) < 6 * 3600 * 1000) return;
      await H.store.set('photoCleanup', Date.now());
      const { data, error } = await sb.rpc('my_expired_media');
      if (error || !data || !data.length) return;
      const names = data.map(x => (typeof x === 'string' ? x : x.my_expired_media || x.name)).filter(Boolean);
      if (names.length) await sb.storage.from(BUCKET).remove(names);
    } catch (e) { console.warn('Hustl photo clean-up skipped:', e && (e.message || e)); }
  }

  /* ---------------- Camera ---------------- */
  let camStream = null, camBlob = null;

  async function useFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name || '')) return H.toast('Please choose a photo.');
    if (file.size > MAX_INPUT) return H.toast('That photo is too large (over 30 MB).');
    try { await sendPhoto(await shrink(file)); }
    catch { H.toast("Couldn't read that photo. Try a JPEG or PNG."); }
  }

  function camState(shot) {
    els.camVideo.hidden = shot; els.camShot.hidden = !shot;
    els.camSnap.hidden = shot; els.camRetake.hidden = !shot; els.camSend.hidden = !shot;
  }
  function stopCamera() {
    if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
    els.camVideo.srcObject = null;
    if (els.camShot.src) URL.revokeObjectURL(els.camShot.src);
    els.camShot.removeAttribute('src');
    camBlob = null;
  }

  async function openCamera() {
    if (!isMutual(personById(openId))) return;
    // Phones (and anything without a webcam API): the phone's own camera app takes the picture.
    if (matchMedia('(pointer: coarse)').matches || !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
      els.camInput.value = ''; els.camInput.click();
      return;
    }
    camState(false);
    els.camMsg.hidden = true; els.camSnap.disabled = true;
    els.camDlg.showModal();
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false });
      if (!els.camDlg.open) return stopCamera();   // closed while we were asking
      els.camVideo.srcObject = camStream;
      await els.camVideo.play().catch(() => {});
      els.camSnap.disabled = false;
    } catch {
      els.camMsg.textContent = "Couldn't open a camera. Allow camera access for this site, or choose a photo instead.";
      els.camMsg.hidden = false;
    }
  }

  function snap() {
    const v = els.camVideo;
    if (!v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    const ctx = c.getContext('2d');
    ctx.translate(c.width, 0); ctx.scale(-1, 1);   // keep it the way the mirrored preview looked
    ctx.drawImage(v, 0, 0, c.width, c.height);
    c.toBlob(b => {
      if (!b) return H.toast("Couldn't take the picture. Please try again.");
      camBlob = b;
      els.camShot.src = URL.createObjectURL(b);
      camState(true);
      els.camSend.focus();
    }, 'image/jpeg', 0.9);
  }

  /* ---------------- Formatting ---------------- */
  const initials = name => (name || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const colorFor = id => AVATAR_COLORS[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % AVATAR_COLORS.length];
  const preview = m => (m.body ? m.body.replace(/\s+/g, ' ').slice(0, 80) : m.media_type === 'video' ? '🎬 Video' : '📷 Photo');
  const fmtTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const fmtDay = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const fmtShort = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
  const dayKey = d => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  function whenShort(isoStr) {
    const d = new Date(isoStr), now = new Date(), y = new Date(now); y.setDate(now.getDate() - 1);
    if (dayKey(d) === dayKey(now)) return fmtTime.format(d);
    if (dayKey(d) === dayKey(y)) return 'Yesterday';
    return fmtShort.format(d);
  }
  function dayLabel(d) {
    const now = new Date(), y = new Date(now); y.setDate(now.getDate() - 1);
    return dayKey(d) === dayKey(now) ? 'Today' : dayKey(d) === dayKey(y) ? 'Yesterday' : fmtDay.format(d);
  }

  function avatarEl(p) {
    const a = document.createElement('span');
    a.className = 'avatar';
    a.style.setProperty('--av', colorFor(p.id));
    a.textContent = initials(p.display_name);
    a.setAttribute('aria-hidden', 'true');
    return a;
  }

  /* ---------------- Chats list ---------------- */
  const ICON_CHAT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h16v10H9l-5 4z"/><path d="M8 9.5h8M8 12.5h5"/></svg>';
  const ICON_UNFOLLOW = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="8" r="3.5"/><path d="M3.5 19.5c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5M16 11h6"/></svg>';

  function threadInfo(id) {
    let last = null, unread = 0;
    for (const m of msgs) {
      if (otherOf(m) !== id) continue;
      last = m;
      if (m.sender_id === id && !m.read_at) unread++;
    }
    return { last, unread };
  }

  function personEl(p, kind) {
    const li = document.createElement('li');
    li.className = 'person' + (kind === 'friend' ? ' thread' : '') + (p.id === openId ? ' active' : '');
    li.dataset.id = p.id;

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'person-open';
    open.setAttribute('aria-label', (kind === 'friend' ? 'Open chat with ' : 'Open ') + p.display_name);
    open.addEventListener('click', () => openConvo(p.id));

    const main = document.createElement('span');
    main.className = 'person-main';
    const name = document.createElement('b'); name.textContent = p.display_name;
    const sub = document.createElement('span'); sub.className = 'person-sub';
    const { last, unread } = threadInfo(p.id);
    if (kind === 'friend' && last) {
      const mine = last.sender_id === me.id;
      sub.textContent = (last.status === 'pending' ? '⏳ ' : '') + (mine ? 'You: ' : '') + preview(last);
    } else {
      sub.textContent = p.handle + (kind === 'friend' ? ' · ' : '');
      if (kind === 'friend') { const ok = document.createElement('span'); ok.className = 'badge-ok'; ok.textContent = 'Friends ✓'; sub.appendChild(ok); }
    }
    main.append(name, sub);
    open.append(avatarEl(p), main);

    const actions = document.createElement('span');
    actions.className = 'person-actions';
    if (kind === 'friend' && last) {
      const meta = document.createElement('span');
      meta.className = 'thread-meta';
      const t = document.createElement('time'); t.dateTime = last.created_at; t.textContent = whenShort(last.created_at);
      meta.appendChild(t);
      if (unread) {
        const b = document.createElement('span'); b.className = 'unread'; b.textContent = unread > 99 ? '99+' : unread;
        b.setAttribute('aria-label', `${unread} unread`);
        meta.appendChild(b);
      }
      actions.appendChild(meta);
    }
    if (kind === 'friend') {
      const b = document.createElement('button');
      b.className = 'icon-plain msg-btn'; b.type = 'button'; b.innerHTML = ICON_CHAT;
      b.title = 'Message'; b.setAttribute('aria-label', 'Message ' + p.display_name);
      b.addEventListener('click', () => openConvo(p.id));
      actions.appendChild(b);
    }
    if (kind === 'request') {
      const b = document.createElement('button');
      b.className = 'btn small'; b.type = 'button'; b.textContent = 'Follow back';
      b.addEventListener('click', () => follow(p));
      actions.appendChild(b);
    } else {
      const b = document.createElement('button');
      b.className = 'icon-plain'; b.type = 'button'; b.innerHTML = ICON_UNFOLLOW;
      b.title = 'Unfollow'; b.setAttribute('aria-label', 'Unfollow ' + p.display_name);
      b.addEventListener('click', () => unfollow(p));
      actions.appendChild(b);
    }
    li.append(open, actions);
    return li;
  }

  function renderNavBadge() {
    let badge = els.navKey.querySelector('.nav-badge');
    const total = me ? msgs.filter(m => m.recipient_id === me.id && !m.read_at && isMutual(personById(m.sender_id))).length : 0;
    H.setBadge && H.setBadge('chat', total);
    if (!total) { if (badge) badge.remove(); return; }
    if (!badge) { badge = document.createElement('span'); badge.className = 'nav-badge'; els.navKey.appendChild(badge); }
    badge.textContent = total > 99 ? '99+' : total;
    badge.setAttribute('aria-label', `${total} unread`);
  }

  function render(opts) {
    const signedIn = !!(sb && session);
    els.signedOut.hidden = signedIn;
    els.signedIn.hidden = !signedIn;
    els.addBtn.hidden = !signedIn;
    els.profileBox.hidden = !(signedIn && me);
    renderNavBadge();
    if (!signedIn) { if (openId) closeConvo(); return; }

    els.offline.hidden = navigator.onLine;
    $$('[data-my-handle]').forEach(el => { el.textContent = me ? me.handle : '…'; });
    if (me && document.activeElement !== els.nameInput) els.nameInput.value = me.display_name;

    const lastAt = id => (threadInfo(id).last || {}).created_at || '';
    const friends = people.filter(isMutual).sort((a, b) => lastAt(b.id).localeCompare(lastAt(a.id)));
    const requests = people.filter(p => p.followsMe && !p.iFollow);
    const waiting = people.filter(p => p.iFollow && !p.followsMe);
    els.friends.replaceChildren(...friends.map(p => personEl(p, 'friend')));
    els.requests.replaceChildren(...requests.map(p => personEl(p, 'request')));
    els.waiting.replaceChildren(...waiting.map(p => personEl(p, 'waiting')));
    els.friendsSec.hidden = !friends.length;
    els.requestsSec.hidden = !requests.length;
    els.waitingSec.hidden = !waiting.length;
    els.empty.hidden = people.length > 0;
    const c = counts();
    els.counts.textContent = `Following ${c.following}/${LIMIT} · Followers ${c.followers}/${LIMIT}`;

    // On a computer the chat sits beside the list, so open the most recent friend's chat straight away.
    const onChats = !els.screen.hidden;
    if (wide() && onChats && !openId && friends.length) return openConvo(friends[0].id, { quiet: true });
    els.placeholder.hidden = !(wide() && onChats && !openId);
    if (openId) renderConvo(opts);
  }

  /* ---------------- Conversation ---------------- */
  function openConvo(id, { quiet = false } = {}) {
    const p = personById(id);
    if (!p) return;
    const wasOpen = !!openId;
    if (id !== openId) { els.text.value = ''; growText(); }
    openId = id;
    els.convo.hidden = false;
    els.placeholder.hidden = true;
    document.body.classList.add('convo-open');
    if (!wasOpen && !wide()) history.pushState({ convo: id }, '');   // phone: Back closes the chat
    render({ scroll: true });
    markRead();
    if (quiet) return;
    if (isMutual(p) && matchMedia('(pointer: fine)').matches) els.text.focus();
    else if (!wide()) els.back.focus();
  }

  function closeConvo(fromHistory) {
    if (!openId) return;
    openId = null;
    els.convo.hidden = true;
    document.body.classList.remove('convo-open');
    if (!fromHistory && history.state && history.state.convo) history.back();
    render();
  }

  function noteEl(m) {
    const mine = m.sender_id === me.id;
    const li = document.createElement('li');
    li.className = 'note-msg' + (mine ? ' mine' : '') + (m.status ? ' ' + m.status : '');
    li.dataset.id = m.id;
    const body = document.createElement('p');
    body.className = 'note-body';
    body.textContent = m.body || preview(m);
    if (m.media_path) { li.classList.add('photo'); li.appendChild(polaroidEl(m, mine)); if (!m.body) body.hidden = true; }
    if (mine && m.media_path && m.status === 'pending' && navigator.onLine) {
      const bar = document.createElement('div'); bar.className = 'upload-bar'; bar.setAttribute('aria-label', 'Uploading photo'); li.appendChild(bar);
    }
    const meta = document.createElement('span');
    meta.className = 'note-meta';
    const t = document.createElement('time'); t.dateTime = m.created_at; t.textContent = fmtTime.format(new Date(m.created_at));
    meta.appendChild(t);
    if (mine) {
      const s = document.createElement('span');
      s.className = 'note-status';
      s.textContent = m.status === 'pending' ? (m.media_path && navigator.onLine ? '⏳ sending photo…' : '⏳ waiting to send')
        : m.status === 'failed' ? (m.lost ? 'Not sent: the photo was lost, please take it again' : 'Not sent: follow each other to chat')
          : m.read_at ? '✓✓ Read' : '✓ Sent';
      meta.appendChild(s);
    }
    li.append(body, meta);
    return li;
  }

  function renderConvo(opts = {}) {
    const p = personById(openId);
    if (!p) return closeConvo();
    els.cAvatar.replaceWith(els.cAvatar = Object.assign(avatarEl(p), { id: 'convoAvatar' }));
    els.cName.textContent = p.display_name;
    els.cSub.textContent = isMutual(p) ? p.handle + ' · Friends ✓' : p.handle;

    const nearBottom = els.notes.scrollHeight - els.notes.scrollTop - els.notes.clientHeight < 80;
    const ttl = document.createElement('li');
    ttl.className = 'ttl-note';
    ttl.textContent = '⏳ Notes disappear 7 days after they’re sent.';
    const items = [ttl];
    let lastDay = '';
    const thread = msgs.filter(m => otherOf(m) === p.id);
    for (const m of thread) {
      const d = new Date(m.created_at);
      if (dayKey(d) !== lastDay) {
        lastDay = dayKey(d);
        const sep = document.createElement('li');
        sep.className = 'day-sep';
        sep.textContent = dayLabel(d);
        items.push(sep);
      }
      items.push(noteEl(m));
    }
    if (!thread.length) {
      const hint = document.createElement('li');
      hint.className = 'note-hint';
      hint.textContent = isMutual(p) ? `Say hello to ${p.display_name} 👋` : '';
      items.push(hint);
    }
    els.notes.replaceChildren(...items);

    const mutual = isMutual(p);
    els.composer.hidden = !mutual;
    els.locked.hidden = mutual;
    els.send.disabled = !mutual;
    if (opts.scroll || nearBottom) els.notes.scrollTop = els.notes.scrollHeight;
  }

  function growText() {
    els.text.style.height = 'auto';
    els.text.style.height = Math.min(els.text.scrollHeight, 160) + 'px';
  }

  /* ---------------- Follows ---------------- */
  const generic = 'Something went wrong. Please try again.';

  const LIMIT = 50;   // most people you can follow, and most followers you can have (enforced in supabase.sql)
  const counts = () => ({ following: people.filter(p => p.iFollow).length, followers: people.filter(p => p.followsMe).length });
  const FULL_MSG = `You already follow ${LIMIT} people, the most allowed. Unfollow someone to add a new friend.`;

  // say: where to show a problem (a toast, or the Add friend dialog's message line).
  async function follow(target, say = H.toast) {
    if (!navigator.onLine) { say(OFFLINE); return false; }
    if (counts().following >= LIMIT) { say(FULL_MSG); return false; }
    const { error } = await sb.from('follows').insert({ follower_id: me.id, followee_id: target.id });
    if (error && error.code !== '23505') {   // 23505 = already following
      const m = error.message || '';
      say(/follower limit/.test(m) ? `${target.display_name} already has ${LIMIT} followers, the most allowed, so they can't take new ones.`
        : /follow limit/.test(m) ? FULL_MSG : generic);
      return false;
    }
    const mutual = people.some(p => p.id === target.id && p.followsMe);
    H.toast(mutual ? `You and ${target.display_name} are now friends 🎶` : `Following ${target.display_name}. You can chat once they follow you back.`);
    await refresh();
    if (mutual) openConvo(target.id);   // straight into the chat with your new friend
    return true;
  }

  async function unfollow(p) {
    if (!navigator.onLine) return H.toast(OFFLINE);
    const yes = await confirmBox(`Unfollow ${p.display_name}? You won't be able to chat until you follow each other again.`, 'Unfollow');
    if (!yes) return;
    const { error } = await sb.from('follows').delete().eq('follower_id', me.id).eq('followee_id', p.id);
    if (error) return H.toast(generic);
    H.toast(`Unfollowed ${p.display_name}`);
    await refresh();
  }

  function setMsg(text, good = false) { els.msg.textContent = text; els.msg.classList.toggle('good', good); }

  async function addFriend(e) {
    e.preventDefault();
    const handle = els.friendId.value.trim().toLowerCase().replace(/^@/, '');
    if (!navigator.onLine) return setMsg(OFFLINE);
    if (!HANDLE_RE.test(handle)) return setMsg("That doesn't look like a User ID. It looks like vinyl-fox-4821.");
    if (me && handle === me.handle) return setMsg("That's you! Share your ID with a friend instead.");
    els.go.disabled = true;
    try {
      const { data, error } = await sb.rpc('lookup_profile', { p_handle: handle });
      if (error) return setMsg(generic);
      const target = (data || [])[0];
      if (!target) return setMsg('No one has that User ID. Check the spelling and try again.');
      if (people.some(p => p.id === target.id && p.iFollow)) return setMsg(`You already follow ${target.display_name}.`);
      if (await follow(target, setMsg)) els.dlg.close();
    } finally { els.go.disabled = false; }
  }

  async function saveName(e) {
    e.preventDefault();
    const name = els.nameInput.value.trim().replace(/\s+/g, ' ');
    if (!name || name.length > 40) return H.toast('Display name must be 1–40 characters.');
    if (!navigator.onLine) return H.toast("Radio's off… reconnect to save your name.");
    const { error } = await sb.from('profiles').update({ display_name: name }).eq('id', me.id);
    if (error) return H.toast(generic);
    me.display_name = name;
    await saveCache();
    els.nameInput.blur();
    H.toast('Name saved ✓');
    render();
  }

  async function copyHandle() {
    if (!me) return;
    try { await navigator.clipboard.writeText(me.handle); H.toast('User ID copied 📋'); }
    catch { H.toast('Your User ID: ' + me.handle); }
  }

  function confirmBox(text, okLabel = 'OK') {
    return new Promise(resolve => {
      els.confirmText.textContent = text;
      els.confirmOk.textContent = okLabel;
      const done = v => { els.confirm.close(); els.confirmOk.onclick = null; resolve(v); };
      els.confirmOk.onclick = () => done(true);
      els.confirm.onclose = () => resolve(false);
      els.confirm.showModal();
    });
  }

  /* ---------------- Boot ---------------- */
  async function onAuth(s) {
    const was = session && session.user.id;
    session = s || null;
    sb = window.HustlSync && window.HustlSync.client;
    if (session && session.user.id === was) return;
    stopLive();
    me = null; people = []; msgs = [];
    signed.clear(); loaded.clear();
    if (session) { await loadCache(); render(); refresh(); }
    else render();
  }
  // Listen right away so the first sign-in event isn't missed.
  addEventListener('hustl:auth', e => { if (H) onAuth(e.detail.session); });

  async function init() {
    H = window.Hustl;
    await H.ready;

    els.addBtn.addEventListener('click', () => {
      if (!navigator.onLine) return H.toast(OFFLINE);
      els.friendId.value = ''; setMsg('');
      els.dlg.showModal();
      els.friendId.focus();
    });
    els.form.addEventListener('submit', addFriend);
    els.friendId.addEventListener('input', () => setMsg(''));
    $$('.dlg [data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
    els.goSignIn.addEventListener('click', () => { H.showScreen('settings'); setTimeout(() => $('#accountPanel').scrollIntoView({ block: 'start' }), 50); });
    els.nameForm.addEventListener('submit', saveName);
    $$('[data-copy-handle]').forEach(b => b.addEventListener('click', copyHandle));

    els.composer.addEventListener('submit', send);
    els.camBtn.addEventListener('click', openCamera);
    els.camInput.addEventListener('change', () => useFile(els.camInput.files[0]));
    els.pick.addEventListener('change', () => useFile(els.pick.files[0]));
    els.camSnap.addEventListener('click', snap);
    els.camRetake.addEventListener('click', () => { if (els.camShot.src) URL.revokeObjectURL(els.camShot.src); els.camShot.removeAttribute('src'); camBlob = null; camState(false); });
    els.camSend.addEventListener('click', async () => { const b = camBlob; camBlob = null; els.camDlg.close(); if (b) { try { await sendPhoto(await shrink(b)); } catch { H.toast("Couldn't send that photo."); } } });
    els.camCancel.addEventListener('click', () => els.camDlg.close());
    els.camPick.addEventListener('click', () => { els.camDlg.close(); els.pick.value = ''; els.pick.click(); });
    els.camDlg.addEventListener('close', stopCamera);
    els.photoClose.addEventListener('click', () => els.photoView.close());
    els.photoView.addEventListener('click', e => { if (e.target === els.photoView) els.photoView.close(); });
    els.text.addEventListener('input', growText);
    els.text.addEventListener('keydown', e => {
      // Enter sends on a keyboard; on a phone Enter makes a new line and the button sends.
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) {
        e.preventDefault(); els.composer.requestSubmit();
      }
    });
    els.back.addEventListener('click', () => closeConvo());
    addEventListener('popstate', () => { if (openId && !(history.state && history.state.convo)) closeConvo(true); });
    addEventListener('keydown', e => { if (e.key === 'Escape' && openId && !document.querySelector('dialog[open]')) closeConvo(); });

    H.on((type, detail) => {
      if (type === 'screen') { if (openId) closeConvo(true); if (detail === 'chats') refresh(); }
    });
    addEventListener('online', refresh);
    addEventListener('offline', render);
    addEventListener('focus', () => { if (!$('#screen-chats').hidden || openId) refresh(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { markRead(); if (session) refresh(); } });
    setInterval(() => { if (prune()) { saveCache(); render(); } }, 60 * 1000);   // expire notes while the app stays open
    matchMedia('(min-width: 900px)').addEventListener('change', () => render());

    await onAuth(window.HustlSync && window.HustlSync.session);
  }

  window.HustlChat = {
    refresh, open: openConvo, close: () => closeConvo(),
    get me() { return me; }, get people() { return people; }, get messages() { return msgs; },
  };
  init();
})();
