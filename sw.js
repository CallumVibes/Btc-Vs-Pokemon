// Bitcoin vs Pokémon — service worker.
// Shell is cached so the app opens instantly and works offline.
// Price feeds are never cached: a stale price is worse than no price.

const VERSION = "v1";
const SHELL = "shell-" + VERSION;
const FONTS = "fonts-" + VERSION;
const DATA  = "data-" + VERSION;

const SHELL_FILES = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png"
];

// Live price APIs — always straight to the network, never stored.
const LIVE_HOSTS = [
  "api.coingecko.com",
  "api.coinbase.com",
  "api.pokemontcg.io"
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(SHELL)
      .then(c => c.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => ![SHELL, FONTS, DATA].includes(k)).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", e => {
  if (e.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // 1. Price feeds: network only. Don't touch them.
  if (LIVE_HOSTS.includes(url.hostname)) return;

  // 2. Card images from the TCG CDN: cache-first, they never change.
  if (url.hostname.endsWith("pokemontcg.io")) {
    e.respondWith(cacheFirst(req, DATA));
    return;
  }

  // 3. The committed snapshot file: network first, fall back to the last copy.
  if (url.pathname.endsWith("history.json")) {
    e.respondWith(networkFirst(req, DATA));
    return;
  }

  // 4. Google Fonts: cache-first, long-lived.
  if (url.hostname.includes("fonts.googleapis.com") || url.hostname.includes("fonts.gstatic.com")) {
    e.respondWith(cacheFirst(req, FONTS));
    return;
  }

  // 5. Everything same-origin: cache-first, refreshed in the background.
  if (url.origin === self.location.origin) {
    e.respondWith(staleWhileRevalidate(req, SHELL));
  }
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    return hit || Response.error();
  }
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(req);
    return hit || Response.error();
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const fetching = fetch(req)
    .then(res => { if (res && res.ok) cache.put(req, res.clone()); return res; })
    .catch(() => null);
  return hit || (await fetching) || Response.error();
}
