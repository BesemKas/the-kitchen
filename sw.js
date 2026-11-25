/* Kitchen Budget service worker: keeps the app shell and static files on the phone so the app
 * opens with no signal. Data (api.php) is never cached here; the app keeps its own copy of the
 * last data it saw and queues changes until it's back online. */
const SHELL = 'kitchen-shell-v1';
const STATIC = 'kitchen-static-v1';
const NAV_TIMEOUT = 4000;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(STATIC).then((c) => c.addAll([
    'manifest.webmanifest', 'assets/icon.svg', 'assets/icon-180.png', 'assets/icon-192.png', 'assets/zxing-browser.min.js',
  ]).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (![SHELL, STATIC].includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

/** Store a static file; drop older versions of the same file (app.js?v=7 when app.js?v=8 arrives). */
async function putStatic(req, res) {
  const c = await caches.open(STATIC);
  const url = new URL(req.url);
  if (url.search) {
    for (const old of await c.keys()) {
      const o = new URL(old.url);
      if (o.pathname === url.pathname && o.search !== url.search) await c.delete(old);
    }
  }
  await c.put(req, res);
}

self.addEventListener('message', (e) => {
  const msg = e.data || {};
  if (msg.type === 'cache' && Array.isArray(msg.urls)) {
    // the page tells us what it loaded before we were controlling it
    e.waitUntil(Promise.all(msg.urls.map(async (u) => {
      const url = new URL(u, self.registration.scope);
      if (url.origin !== location.origin || !url.pathname.includes('/assets/')) return;
      const c = await caches.open(STATIC);
      if (await c.match(url.href)) return;
      try { const res = await fetch(url.href); if (res.ok) await putStatic(new Request(url.href), res); } catch { /* offline */ }
    })));
  }
  if (msg.type === 'clear') e.waitUntil(caches.delete(SHELL));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                 // api.php is POST: straight to the network
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (req.mode === 'navigate') {
    e.respondWith(navigate(req));
    return;
  }
  if (url.pathname.includes('/assets/') || url.pathname.endsWith('.webmanifest')) {
    // versioned or rarely-changing files: cache first
    e.respondWith((async () => {
      const hit = await caches.match(req, { cacheName: STATIC });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) await putStatic(req, res.clone());
      return res;
    })());
  }
});

/** Network first (so logins and updates work), fall back to the last app page we saw. */
async function navigate(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), NAV_TIMEOUT)),
    ]);
    // only keep the logged-in app page, never the login form or an error
    if (res.ok && res.headers.get('X-Kitchen-Shell') === '1') await cache.put('shell', res.clone());
    return res;
  } catch {
    const hit = await cache.match('shell');
    if (hit) return hit;
    return new Response('<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:sans-serif;background:#0e1110;color:#eef2ee;padding:24px"><h1>Offline</h1><p>Open the app once with signal so it can work offline next time.</p>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
}
