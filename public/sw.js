/**
 * The service worker, which exists for two reasons and must not acquire a
 * third.
 *
 * Chrome's install criteria want one before it will build a WebAPK — the thing
 * that gives an Android launcher icon its own task, no browser UI, and a real
 * app identity rather than a bookmark that opens a tab. And once there is one,
 * the game loads with no network at all, which for something you keep on a home
 * screen is the difference between a game and a website.
 *
 * The third reason it must not acquire is caching policy of its own devising.
 * A service worker is the easiest way in the world to serve a build from last
 * month forever, and this project just spent an afternoon establishing which
 * build is on screen; a cache-first worker would hand that problem straight
 * back. So the split below is deliberate and is the whole design:
 *
 *   - `/assets/*` is content-hashed by Vite. A given URL's bytes can never
 *     change, so cache-first is not a staleness risk — it is just free.
 *   - Everything else, index.html above all, is a stable URL whose contents
 *     change every deploy. Network-first: the cache is a fallback for being
 *     offline, never a substitute for asking.
 *
 * The version comes from the `?v=` on the worker's own URL, which the page sets
 * to the build SHA. A new build is therefore a new worker script, which
 * installs, claims its clients, and drops every older cache on the way past.
 */

const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev'
const CACHE = `worldcreator-${VERSION}`

// Take over immediately rather than idling until every tab is closed. A phone
// app is never "closed" in the sense that would otherwise trigger this, so the
// polite version means the update lands days late.
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== CACHE && key.startsWith('worldcreator-')) await caches.delete(key)
      }
      await self.clients.claim()
    })(),
  )
})

/** Immutable by construction — Vite puts the content hash in the filename. */
function isHashedAsset(url) {
  return url.pathname.includes('/assets/')
}

async function cacheFirst(request) {
  const hit = await caches.match(request)
  if (hit) return hit
  const response = await fetch(request)
  if (response.ok) (await caches.open(CACHE)).put(request, response.clone())
  return response
}

async function networkFirst(request) {
  try {
    const response = await fetch(request)
    if (response.ok) (await caches.open(CACHE)).put(request, response.clone())
    return response
  } catch (err) {
    const hit = await caches.match(request)
    if (hit) return hit
    throw err
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  // Anything else is not ours to answer for: a POST has side effects, and a
  // cross-origin request belongs to whoever serves it.
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  event.respondWith(isHashedAsset(url) ? cacheFirst(request) : networkFirst(request))
})
