// خدمة التطبيق: تسريع التحميل وفتح الواجهة بدون إنترنت. لا تلمس أي طلب لـ /api أبداً.
const V = "fahes-v1", SHELL = ["/", "/manifest.json", "/icon-192.png", "/icon-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== "GET" || u.origin !== self.location.origin || u.pathname.startsWith("/api/")) return;
  if (r.mode === "navigate") { // الصفحة: الأحدث من الشبكة أولاً، ولو مفيش إنترنت النسخة المحفوظة
    e.respondWith(fetch(r).then(res => { if (res.ok) { const cp = res.clone(); caches.open(V).then(c => c.put("/", cp)); } return res; }).catch(() => caches.match("/")));
    return;
  }
  e.respondWith(caches.match(r).then(hit => hit || fetch(r).then(res => { if (res.ok) { const cp = res.clone(); caches.open(V).then(c => c.put(r, cp)); } return res; })));
});
