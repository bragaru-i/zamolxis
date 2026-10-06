// Zamolxis service worker (#47): makes the app installable and shows an offline page.
// It deliberately caches nothing else. API calls (Convex, auth) and app data always go
// to the network and are never stored; only a page navigation that fails because the
// device is offline is answered with the static /offline.html.
const CACHE = "zamolxis-offline-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: "reload" })))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  // Everything except top-level page loads is left to the browser untouched.
  if (request.mode !== "navigate" || request.method !== "GET") return;
  event.respondWith(
    fetch(request).catch(() =>
      caches.match(OFFLINE_URL).then((response) => response || Response.error()),
    ),
  );
});
