/* Central Pet Scheduler — shell service worker
 *
 * Speeds return visits by caching the app shell (HTML/JS/CSS/assets).
 * Schedule data lives in IndexedDB (see ux/schedule-cache.js); this SW does
 * not store auth tokens or API payloads.
 *
 * Bump CACHE_NAME when shell assets change in a way that must invalidate.
 */
const CACHE_NAME = 'cp-shell-v1.1.8';
const PRECACHE = [
  '/',
  '/shiftday.html',
  '/dashboard.html',
  '/rep.html',
  '/signin.html',
  '/styles.css',
  '/hotfix.js',
  '/overscroll-guard.js',
  '/auth-gate.js',
  '/shared.js',
  '/shiftday.js',
  '/dashboard.js',
  '/app-version.json',
  '/assets/bufferingcat.gif',
  '/assets/buffering_light.gif',
  '/ux/buffering.js',
  '/ux/app-shell.js',
  '/ux/theme.js',
  '/ux/prod-sync.js',
  '/ux/offline-store.js',
  '/ux/schedule-cache.js',
  '/ux/nav-guard.js',
];

function isApi(url) {
  return url.pathname.startsWith('/api/');
}

function isVersionManifest(url) {
  return url.pathname.endsWith('/app-version.json');
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE).catch(() => undefined))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (isApi(url)) return; // never cache authenticated API

  // Version manifest + HTML: network-first so hotfix reload stays honest.
  if (isVersionManifest(url) || req.mode === 'navigate' || url.pathname.endsWith('.html')) {
    event.respondWith(networkFirst(req));
    return;
  }

  // JS/CSS/assets: stale-while-revalidate for snappy field navigation.
  if (/\.(js|css|gif|png|jpg|jpeg|webp|svg|woff2?)$/i.test(url.pathname) || url.pathname.startsWith('/ux/')) {
    event.respondWith(staleWhileRevalidate(req));
  }
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) cache.put(req, fresh.clone());
    return fresh;
  } catch {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw new Error('offline');
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  return hit || (await network) || Response.error();
}
