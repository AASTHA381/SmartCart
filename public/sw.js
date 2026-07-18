const CACHE = "sib-v6";
const ASSETS = ["./manifest.json", "./icons/icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Never touch API calls (LLM provider or our own backend).
  if (url.hostname.endsWith("anthropic.com") || url.hostname.endsWith("groq.com") || url.pathname.startsWith("/api/")) {
    return;
  }

  // Network-first for the HTML document so code updates always show up.
  if (e.request.mode === "navigate" || e.request.destination === "document") {
    e.respondWith(
      fetch(e.request)
        .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
        .catch(() => caches.match(e.request).then((c) => c || caches.match("./app.html")))
    );
    return;
  }

  // Cache-first for static assets.
  e.respondWith(caches.match(e.request).then((cached) => cached || fetch(e.request)));
});
