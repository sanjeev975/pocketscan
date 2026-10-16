/* PocketScan service worker
 * - App shell is precached on install (install fails loudly if a shell file is missing).
 * - CDN / vendor libraries are precached best-effort (so one online visit is enough).
 * - Same-origin: stale-while-revalidate. Cross-origin (CDN, OCR data): cache-first.
 * - Navigations: network-first with a short timeout, falling back to the cached shell.
 * Bump VERSION whenever you change any cached file.
 */
const VERSION = 'v1.0.0';
const SHELL_CACHE = `pocketscan-shell-${VERSION}`;
const RUNTIME_CACHE = `pocketscan-runtime-${VERSION}`;

const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png'
];

// Keep in sync with LIBS in app.js
const OPTIONAL = [
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
  './vendor/manifest.json',
  './vendor/jspdf.umd.min.js',
  './vendor/jszip.min.js',
  './vendor/tesseract/tesseract.min.js',
  './vendor/tesseract/worker.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    await shell.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })));
    const rt = await caches.open(RUNTIME_CACHE);
    await Promise.allSettled(OPTIONAL.map(async url => {
      const res = await fetch(url, { mode: url.startsWith('http') ? 'cors' : 'same-origin' });
      if (res.ok) await rt.put(url, res);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, RUNTIME_CACHE]);
    for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });

const match = req => caches.match(req, { ignoreVary: true });

async function networkFirstNavigation(req) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(req, { signal: ctrl.signal });
    clearTimeout(t);
    if (res.ok) { (await caches.open(SHELL_CACHE)).put('./index.html', res.clone()); }
    return res;
  } catch {
    return (await match('./index.html')) || (await match('./')) || Response.error();
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await match(req);
  const refresh = fetch(req).then(res => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return cached || (await refresh) || new Response('Offline', { status: 503, statusText: 'Offline' });
}

async function cacheFirst(req) {
  const cached = await match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.ok) (await caches.open(RUNTIME_CACHE)).put(req, res.clone());
    return res;
  } catch {
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (req.headers.has('range')) return;
  if (req.mode === 'navigate') return event.respondWith(networkFirstNavigation(req));
  event.respondWith(url.origin === self.location.origin ? staleWhileRevalidate(req) : cacheFirst(req));
});
