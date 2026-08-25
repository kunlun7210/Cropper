const CACHE_NAME = "screenshot-trimmer-v6";
const ASSETS = ["./", "./index.html", "./styles.css", "./app.js", "./manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;

  const refresh = fetch(event.request).then((response) => {
    if (!response.ok) return response;

    const copy = response.clone();
    return caches.open(CACHE_NAME)
      .then((cache) => cache.put(event.request, copy))
      .then(() => response);
  });

  event.waitUntil(refresh.then(() => undefined, () => undefined));
  event.respondWith(caches.match(event.request, { ignoreSearch: true }).then((cached) => {
    if (cached) return cached;

    return refresh.catch(() => (
      event.request.mode === "navigate" ? caches.match("./") : Response.error()
    ));
  }));
});
