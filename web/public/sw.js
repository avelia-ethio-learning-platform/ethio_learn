/* EthiopiaLearn service worker — offline-tolerant app shell + read cache.
 *
 * Strategy (deliberately conservative):
 *  - Navigations: network first, fall back to the cached copy of that page,
 *    then to /offline. Every visited page is cached, so a course you opened
 *    while online opens again on a bus with no signal.
 *  - Next.js static assets (/_next/static): cache first (content-hashed).
 *  - API GET reads (courses, enrollments, progress…): network first with a
 *    cache fallback so the lesson list, summaries and your progress render
 *    offline. Writes are never cached here — the app queues them (offline-queue.ts).
 *  - Video and signed R2 URLs are NEVER cached: they are 15-minute signed
 *    links and caching them would both break and leak content.
 */
const VERSION = 'el-sw-v1';
const SHELL = `${VERSION}-shell`;
const API = `${VERSION}-api`;
const STATIC = `${VERSION}-static`;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/offline'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// The app tells us to forget personal data on logout (shared devices).
self.addEventListener('message', (event) => {
  if (event.data === 'el-clear-api-cache') caches.delete(API);
});

function isApiRead(url) {
  return /\/api\/v1\/(courses|enrollments|progress|assessments|attempts\/mine|me\/certificates|notifications|wallet|sponsorships|referrals)(\/|\?|$)/.test(url.pathname + url.search)
    && !/stream-url|download|chat\b/.test(url.pathname);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never touch media / signed storage URLs.
  if (/r2\.cloudflarestorage\.com|\.m3u8|\.mp4|\.ts$|minio|:9000/.test(url.href)) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(req, copy));
          return res;
        })
        .catch(async () => (await caches.match(req)) || (await caches.match('/offline'))),
    );
    return;
  }

  if (url.origin === self.location.origin && url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(STATIC).then((c) => c.put(req, copy));
            return res;
          }),
      ),
    );
    return;
  }

  if (isApiRead(url)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(API).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(async () => {
          const hit = await caches.match(req);
          return hit || new Response(JSON.stringify({ statusCode: 503, message: 'You are offline and this data is not cached yet.' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
        }),
    );
  }
});
