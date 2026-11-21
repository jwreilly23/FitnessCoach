const CACHE = 'fitnesscoach-v3';
const STATIC = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/exercises.json',
  '/manifest.json',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Cache-first for static assets, network-first for exercise GIFs
  const url = new URL(e.request.url);
  if (url.origin === self.location.origin && e.request.method === 'GET') {
    // Network-first for app files so updates show up; cache is the offline fallback.
    // cache:'no-cache' makes the browser revalidate with the server instead of
    // silently reusing a stale HTTP-cached copy.
    e.respondWith(
      fetch(e.request.url, { cache: 'no-cache' }).then(resp => {
        if (resp.ok) caches.open(CACHE).then(c => c.put(e.request, resp.clone()));
        return resp;
      }).catch(() => caches.match(e.request))
    );
  } else {
    e.respondWith(
      caches.match(e.request).then(r => r || fetch(e.request))
    );
  }
});
