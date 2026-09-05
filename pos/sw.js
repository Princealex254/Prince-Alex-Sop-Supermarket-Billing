/* ==================================================================
   RetailFlow POS — Service Worker (pos/sw.js)
   ------------------------------------------------------------------
   Gives the POS terminal an offline app-shell: HTML, CSS, JS and
   module dependencies are cached so the terminal loads and renders
   even with no network. API (Worker) requests always go to the
   network — the client-side offline-store.js handles read fallback
   from IndexedDB and write queueing, so the SW stays simple and
   cache-first for static content.

   Scope: /pos/  (only the POS terminal is affected).
   ================================================================== */

const CACHE_NAME = "retailflow-pos-v1";
const SW_SCOPE = "/pos/";

/* App-shell entries relative to the SW scope root (/). */
const APP_SHELL = [
  SW_SCOPE + "index.html",
  SW_SCOPE + "css/pos.css",
  SW_SCOPE + "js/pos.js",
  SW_SCOPE + "js/offline-store.js",
  "/firebase/firebase-config.js",
  "/js/business-types.js",
  "/js/app.js"
];

/* External CDN assets that the app imports at runtime. */
const CDN_ASSETS = [
  "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css",
  "https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700;800&family=Inter:wght@400;500;600;700&display=swap",
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js",
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js",
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js"
];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      /* Add each asset individually so a single failure (blocked CDN,
         offline first-paint) doesn't abort the whole install. */
      Promise.all(
        [...APP_SHELL, ...CDN_ASSETS].map((url) =>
          cache.add(url).catch(() => { /* skip unreachable asset */ })
        )
      )
    )
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((names) => Promise.all(
      names.map((n) => n !== CACHE_NAME ? caches.delete(n) : null)
    ))
  );
  self.clients.claim();
});

/* Cross-origin API requests must pass through to the network untouched —
   the client-side offline-store handles reads (IndexedDB) and writes
   (pending queue). We never intercept or cache these. */
const API_ORIGIN = "retailflow-api.princealexdigital.workers.dev";

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  /* Only cache GET requests — POST/PUT/DELETE are writes handled by the
     client-side offline store, not by the service worker. */
  if (e.request.method !== "GET") return;

  /* Never intercept Worker API traffic (dynamic data + auth). */
  if (url.hostname === API_ORIGIN) return;

  /* Static assets & module imports (same-origin + CDN): cache-first so
     the app shell works offline. Cross-origin CDN responses are cached
     during install, and runtime-cached when their type permits. */
  e.respondWith(
    caches.match(e.request, { ignoreSearch: url.origin === location.origin })
      .then((cached) => {
        if (cached) return cached;
        return fetch(e.request).then((resp) => {
          /* Only runtime-cache same-origin "basic" responses (our HTML/CSS/JS),
             never opaque cross-origin payloads. */
          if (resp && resp.status === 200 && resp.type === "basic" && url.origin === location.origin) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
          }
          return resp;
        }).catch(() => {
          /* Offline and not cached — best-effort fall back to the app shell. */
          if (url.origin === location.origin) return caches.match(SW_SCOPE + "index.html");
          return Response.error();
        });
      })
  );
});

/* Listen for the "sync" event to trigger background sync of the pending
   write queue when connectivity returns. (Falls back gracefully if the
   Background Sync API is unavailable — the client also listens for the
   "online" event directly.) */
self.addEventListener("sync", (e) => {
  if (e.tag === "retailflow-sync-pending") {
    e.waitUntil(
      self.clients.matchAll({ type: "window" }).then((clients) => {
        clients.forEach((c) => c.postMessage({ type: "SYNC_PENDING" }));
      })
    );
  }
});
