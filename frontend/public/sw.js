const CACHE_NAME = 'zenload-shell-v8'
const BASE_PATH = self.registration.scope ? new URL(self.registration.scope).pathname.replace(/\/+$/, '') : '/zenload'

const SHELL = [
  `${BASE_PATH}/`,
  `${BASE_PATH}/index.html`,
  `${BASE_PATH}/manifest.json`,
  `${BASE_PATH}/favicon-32.png`,
  `${BASE_PATH}/icon-192.png`,
  `${BASE_PATH}/icon-512.png`,
  `${BASE_PATH}/icon-maskable-512.png`,
  `${BASE_PATH}/apple-touch-icon.png`,
  `${BASE_PATH}/fonts/outfit-400.woff2`,
  `${BASE_PATH}/fonts/outfit-500.woff2`,
  `${BASE_PATH}/fonts/outfit-600.woff2`,
  `${BASE_PATH}/fonts/outfit-700.woff2`,
  `${BASE_PATH}/fonts/noto-sans-thai-400.woff2`,
  `${BASE_PATH}/fonts/noto-sans-thai-500.woff2`,
  `${BASE_PATH}/fonts/noto-sans-thai-600.woff2`,
  `${BASE_PATH}/fonts/noto-sans-thai-700.woff2`
]

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL))
      .catch(err => console.warn('SW cache.addAll error:', err))
  )
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_NAME && (key.startsWith('download-everything-cache-') || key.startsWith('zenload-shell-')))
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)

  // 1. Never intercept non-GET, external origins, API routes, or health checks
  if (
    event.request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.includes('/api/') ||
    url.pathname.endsWith('/health')
  ) {
    return
  }

  // 2. Static hashed assets & fonts: Cache-first with background revalidation & cache population
  if (url.pathname.includes('/assets/') || url.pathname.includes('/fonts/')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached
        return fetch(event.request).then(response => {
          if (response && response.ok) {
            const clone = response.clone()
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone))
          }
          return response
        })
      })
    )
    return
  }

  // 3. Navigation requests: Network-first with cache fallback
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(async response => {
          if (response.ok) {
            const cache = await caches.open(CACHE_NAME)
            await cache.put(`${BASE_PATH}/`, response.clone())
          }
          return response
        })
        .catch(async () => {
          return (
            (await caches.match(`${BASE_PATH}/`)) ||
            (await caches.match(`${BASE_PATH}/index.html`)) ||
            Response.error()
          )
        })
    )
    return
  }
})
