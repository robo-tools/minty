// Service worker: lets Minty install as an app and open its pages offline.
// It caches only Minty's own static files (pages, styles, scripts, icons), network first so
// updates land at once. API responses (transactions, balances, everything with data) are
// never touched or cached: they always go to the network, behind Cloudflare Access.
const CACHE = "minty-v2";             // v2: the pages' scripts moved to files (security step 4)
const SHELL = ["/", "/connect", "/add-user", "/bills", "/bills.js", "/bills.css", "/bills-format.js", "/card-names.js", "/theme.js", "/app.js", "/connect.js", "/add-user.js", "/abc.js", "/abc.css", "/lock.js", "/lock.css",
               "/manifest.webmanifest", "/favicon.svg",
               "/favicon-32.png", "/apple-touch-icon.png", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-512.png"];
const isShell = (url) => url.origin === self.location.origin && SHELL.includes(url.pathname);

self.addEventListener("install", (e) => { self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || !isShell(url)) return;          // the API and everything else: untouched
  e.respondWith(fetch(e.request).then((res) => {
    // only real pages from this origin; a redirect to the Access sign-in is never cached
    if (res.ok && res.type === "basic" && !res.redirected) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
    }
    return res;
  }).catch(() => caches.match(e.request).then((hit) => hit || Response.error())));
});
