// App code cache: bump the version when precached files change.
const CACHE = 'fitnesscoach-v10';
// Exercise photos live in their own cache so app updates don't re-download them.
const IMAGE_CACHE = 'fitnesscoach-images-v1';
const KEEP = [CACHE, IMAGE_CACHE];

const STATIC = [
  // Relative to sw.js, so the app works at a domain root or in a subfolder
  './',
  'index.html',
  'style.css',
  'app.js',
  'exercises.json',
  'manifest.json',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

const isExerciseImage = url => url.pathname.includes('/images/exercises/');

// Download every exercise photo listed in exercises.json that isn't cached yet.
// Best-effort: one failed photo doesn't stop the rest or the install.
async function precacheImages() {
  const cache = await caches.open(IMAGE_CACHE);
  const data = await (await fetch('exercises.json', { cache: 'no-cache' })).json();
  const urls = [...new Set(data.days.flatMap(d => d.exercises.flatMap(e => e.images || [])))];
  await Promise.allSettled(urls.map(async u => {
    if (await cache.match(u)) return;
    const resp = await fetch(u);
    if (resp.ok) await cache.put(u, resp);
  }));
}

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(STATIC))
      .then(() => precacheImages().catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => !KEEP.includes(k)).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || e.request.method !== 'GET') {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
    return;
  }

  if (isExerciseImage(url)) {
    // Cache-first: photos never change at the same URL, so skip the network
    e.respondWith(
      caches.open(IMAGE_CACHE).then(async cache => {
        const hit = await cache.match(e.request);
        if (hit) return hit;
        const resp = await fetch(e.request);
        if (resp.ok) cache.put(e.request, resp.clone());
        return resp;
      })
    );
    return;
  }

  // Network-first for app files so updates show up; cache is the offline fallback.
  // cache:'no-cache' makes the browser revalidate with the server instead of
  // silently reusing a stale HTTP-cached copy.
  e.respondWith(
    fetch(e.request.url, { cache: 'no-cache' }).then(resp => {
      if (resp.ok) caches.open(CACHE).then(c => c.put(e.request, resp.clone()));
      return resp;
    }).catch(async () =>
      // Offline: ignore ?query strings, and serve the app shell for any page load
      (await caches.match(e.request, { ignoreSearch: true })) ||
      (e.request.mode === 'navigate' ? caches.match('index.html') : undefined)
    )
  );
});
