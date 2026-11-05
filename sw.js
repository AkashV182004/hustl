/* Hustl service worker — cache-first app shell, versioned cache.
   Bump VERSION on every deploy so clients pick up the new files (and the ?v= tags in index.html: tests/version.mjs checks they match). */
const VERSION = 'hustl-v2.4.1';
const ASSETS = [
  './', './index.html', './styles.css', './app.js', './sync.js', './chat.js', './lock.js', './config.js',
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
