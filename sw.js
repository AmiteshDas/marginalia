const CACHE = "marginalia-shell-v1";
const BASE = "/marginalia";
const SHELL_ASSETS = [
  `${BASE}/index.html`,
  `${BASE}/capture.html`,
  `${BASE}/styles.css`,
  `${BASE}/app.js`,
  `${BASE}/idb-queue.js`,
  `${BASE}/manifest.json`,
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// App-shell: cache-first for static assets, network-first for everything else
// (Supabase API calls always go to the network — they're never cached).
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (SHELL_ASSETS.includes(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
  }
});

// Background Sync API — supported on Android/Chrome, NOT on iOS Safari.
// iOS falls back to the "sync on visibility/online" listener in app.js instead.
self.addEventListener("sync", (event) => {
  if (event.tag === "sync-pending-notes") {
    event.waitUntil(
      self.clients.matchAll().then((clients) => {
        clients.forEach((client) => client.postMessage({ type: "TRY_SYNC" }));
      })
    );
  }
});

// Web Push — the Saturday digest notification lands here
self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || "This week's digest is ready";
  const options = {
    body: data.body || "See what connected across your notes this week.",
    icon: `${BASE}/icons/icon-192.png`,
    badge: `${BASE}/icons/icon-192.png`,
    data: { url: data.url || `${BASE}/index.html#digest` },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url));
});
