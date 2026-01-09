const CACHE_NAME = "nexoraai-v1";

const ASSETS_TO_CACHE = [
  "/",
  "/index.html",
  "/app",
  "/painel.html",
  "/checkout",
  "/css/nexoraai-panel.css",
  "/js/nexoraai-panel.js",
  "/checkout.html",
  "/manifest.json"
  // adicione aqui outros arquivos estáticos importantes
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    )
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).catch(() => cached);
    })
  );
});
