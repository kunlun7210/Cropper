const CACHE_NAME = "screenshot-trimmer-v15";
const ASSETS = [
  "./", "./index.html", "./styles.css", "./app.js", "./manifest.json",
  "./icons/favicon-cai-v1.ico", "./icons/icon-cai-v1.svg",
  "./icons/icon-cai-v1-16.png", "./icons/icon-cai-v1-32.png", "./icons/icon-cai-v1-48.png",
  "./icons/icon-cai-v1-180.png", "./icons/icon-cai-v1-192.png", "./icons/icon-cai-v1-512.png",
  "./favicon-qu-32.png", "./favicon-qu-48.png", "./apple-touch-icon-qu.png",
  "./icon-qu-192.png", "./icon-qu-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("screenshot-trimmer-") && key !== CACHE_NAME).map((key) => caches.delete(key)))));
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
