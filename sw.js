/* Hustl service worker — cache-first app shell, versioned cache.
   Bump VERSION on every deploy so clients pick up the new files (and the ?v= tags in index.html: tests/version.mjs checks they match). */
const VERSION = 'hustl-v2.9.0';
const ASSETS = [
  './', './index.html', './styles.css', './app.js', './sync.js', './chat.js', './ai.js', './lock.js', './config.js',
  './manifest.webmanifest', './vendor/supabase.js',
  './fonts/playfair.woff2', './fonts/playfair-italic.woff2', './fonts/special-elite.woff2', './fonts/caveat.woff2', './fonts/inter.woff2',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png', './icons/favicon.png',
];

self.addEventListener('install', event => {
  // cache: 'reload' skips the browser's HTTP cache, so a new version never picks up an old file.
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('hustl-') && k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase API, storage, realtime: straight to network

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(VERSION);
      return (await cache.match('./index.html')) || fetch(req);
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch (err) {
      return new Response('', { status: 504, statusText: 'Offline' });
    }
  })());
});

// A push from the server (supabase/functions/push): a reminder is due, or one was added on another device.
// If Hustl is open and in front, it rings there instead; otherwise show a notification, even with Hustl closed.
self.addEventListener('push', event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { title: 'Hustl', body: event.data ? event.data.text() : '' }; }
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const front = wins.find(w => w.focused && w.visibilityState === 'visible');
    if (front) { front.postMessage({ type: 'push', data: d }); return; }
    const due = d.kind === 'due';
    await self.registration.showNotification(d.title || 'Hustl', {
      body: d.body || '', tag: d.tag || 'hustl', renotify: true, requireInteraction: due,
      icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', vibrate: due ? [300, 150, 300, 150, 600] : [120],
      data: { alarm: d.alarm || null, kind: d.kind || null },
      actions: due ? [{ action: 'snooze', title: 'Snooze 10 min' }, { action: 'done', title: 'Done' }] : [],
    });
  })());
});

// Tapping a reminder notification: open (or focus) Hustl and pass on Snooze / Done.
self.addEventListener('notificationclick', event => {
  const id = event.notification.data && event.notification.data.alarm;
  const action = event.action === 'done' || event.action === 'snooze' ? event.action : null;
  event.notification.close();
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length) {
      const win = wins[0];
      if (win.focus) await win.focus().catch(() => {});
      if (id && action) win.postMessage({ type: 'alarm', id, action });
      return;
    }
    // Hustl was closed: open it and let it carry out the action once it has loaded
    await self.clients.openWindow(id && action ? `./?alarm=${encodeURIComponent(id)}&do=${action}#tasks` : './#tasks');
  })());
});
