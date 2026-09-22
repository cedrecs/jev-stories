// Service worker: caches the app shell so the PWA installs and opens fast.
// Game traffic (/ws/*, /api/*) never goes through the cache.
const VERSION = 'jev-yarn-v4';
const SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/fonts/bagel-fat-one-latin.woff2',
  '/fonts/lexend-latin.woff2',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) return;

  // Network first for everything: the game needs a live connection anyway, so
  // fresh code always wins. The cache only serves the shell when offline.
  // Every game address (/, a room link) shares that one shell; the terms and
  // privacy pages are kept under their own addresses so they never replace it.
  const ownPage = /^\/(terms|privacy)(\.html)?$/.test(url.pathname);
  const cacheKey = req.mode === 'navigate' && !ownPage ? '/index.html' : req;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(cacheKey, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(cacheKey)),
  );
});
