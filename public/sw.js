const CACHE = "fitsup-v23";
const PREFIX = "fitsup-";
const FILES = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png"];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
// «anim-fitsup» era la cache delle animazioni 3D della vecchia Guida: si libera lo spazio
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => (k.indexOf(PREFIX) === 0 && k !== CACHE) || k === "anim-fitsup").map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  if (new URL(e.request.url).pathname.indexOf("/api/") === 0) return; // l'API va sempre in rete
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request)));
});
