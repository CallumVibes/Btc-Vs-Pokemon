// Bitcoin vs Pokémon — service worker.
// Shell is cached so the app opens instantly and works offline.
// Price feeds are never cached: a stale price is worse than no price.

const VERSION = "v4";
const SHELL = "shell-" + VERSION;
const FONTS = "fonts-" + VERSION;
const DATA  = "data-" + VERSION;

const SHELL_FILES = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./apple-touch-icon.png",
  "./favicon-32.png"
];

// Live price APIs — always straight to the network, never stored.
const LIVE_HOSTS = [
  "api.coingecko.com",
  "api.coinbase.com",
  "api.pokemontcg.io"
];

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // Cached one at a time: addAll fails entirely if a single file 404s,
    // which would leave the app with no shell cache at all.
    await Promise.all(SHELL_FILES.map(f =>
      cache.add(f).catch(err => console.warn("skipped caching", f, err))
    ));
    await self.skipWaiting();
  })());
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

  // 2. Card images: straight to the network. If these get cached from a plain
  // <img> request, a later canvas read with crossOrigin fails CORS and the
  // share image loses its artwork.
  if (url.hostname.endsWith("pokemontcg.io") || url.hostname === "images.weserv.nl") return;

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

  // 5. The page itself: network-first. Cache-first here means an installed app
  // keeps showing an old build long after you've pushed a new one.
  if (req.mode === "navigate" || url.pathname.endsWith("/") || url.pathname.endsWith(".html")) {
    e.respondWith(networkFirst(req, SHELL));
    return;
  }

  // 6. Other same-origin assets: cache-first, refreshed in the background.
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
