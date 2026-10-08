const CACHE = "cottage-shell-v5";
const SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icons/favicon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
  "/fonts/noto-sans-georgian-georgian-400-normal.woff2",
  "/fonts/noto-sans-georgian-latin-400-normal.woff2",
  "/fonts/noto-sans-georgian-latin-ext-400-normal.woff2",
  "/fonts/noto-sans-georgian-georgian-500-normal.woff2",
  "/fonts/noto-sans-georgian-latin-500-normal.woff2",
  "/fonts/noto-sans-georgian-latin-ext-500-normal.woff2",
  "/fonts/noto-sans-georgian-georgian-600-normal.woff2",
  "/fonts/noto-sans-georgian-latin-600-normal.woff2",
  "/fonts/noto-sans-georgian-latin-ext-600-normal.woff2",
  "/fonts/noto-sans-georgian-georgian-700-normal.woff2",
  "/fonts/noto-sans-georgian-latin-700-normal.woff2",
  "/fonts/noto-sans-georgian-latin-ext-700-normal.woff2"
];
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter(
                (key) => key.startsWith("cottage-shell-") && key !== CACHE
              )
              .map((key) => caches.delete(key))
          )
        ),
      self.clients.claim()
    ])
  );
});
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Never cache API responses or websocket requests.
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/")
  )
    return;
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() => caches.match("/index.html"))
    );
    return;
  }
  if (SHELL.includes(url.pathname)) {
    // New deployments become visible on the next open, even if this worker's
    // source did not change. Offline fallback contains only the public shell.
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(event.request, { cache: "no-cache" });
          if (response.ok) {
            const cache = await caches.open(CACHE);
            event.waitUntil(cache.put(event.request, response.clone()));
          }
          return response;
        } catch {
          return (await caches.match(event.request)) || Response.error();
        }
      })()
    );
  }
});
