// AI Town Planner web app: caches the app shell only (page, scripts, styles, icons) so it opens fast and
// installs as an app. API answers (/api/), map tiles and other sites always go to the network.
const SHELL = "atp-shell-v1";
const CORE = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/admin/") || url.pathname === "/healthz") return;
  if (req.mode === "navigate") {
    // Page: network first (new versions show at once), the cached shell when offline
    e.respondWith(
      fetch(req)
        .then((r) => { if (r.ok) { const copy = r.clone(); caches.open(SHELL).then((c) => c.put("/", copy)); } return r; })
        .catch(() => caches.match("/"))
    );
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    // Hashed build files never change: cache first
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((r) => {
        if (r.ok) { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); }
        return r;
      }))
    );
    return;
  }
  if (CORE.includes(url.pathname)) {
    // Icons and manifest: cached copy, refreshed in the background
    e.respondWith(
      caches.match(req).then((hit) => {
        const net = fetch(req)
          .then((r) => { if (r.ok) { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); } return r; })
          .catch(() => hit);
        return hit || net;
      })
    );
  }
});
