// mushnote service worker for pwa installability --------------------
const CACHE_NAME = 'mushnote-v1'

self.addEventListener('install', (e) => {
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim())
})

// network first fallback for api and pages --------------------
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return
  e.respondWith(
    fetch(e.request).catch(async () => (await caches.match(e.request)) || Response.error())
  )
})

// handle incoming push notification --------------------
self.addEventListener('push', (e) => {
  let data = {}
  try {
    data = e.data ? e.data.json() : {}
  } catch {
    data = { body: e.data ? e.data.text() : '' }
  }

  const title = data.title || 'mushnote'
  const options = {
    body: data.body || 'new notification from mushnote',
    icon: data.icon || '/applogo-192.png',
    badge: data.badge || '/logo.png',
    data: data.data || {}
  }

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientlist) => {
      // check if user has app open and focused --------------------
      const activeclient = clientlist.find(c => c.visibilityState === 'visible' || c.focused)
      if (activeclient) {
        // block system push notification and deliver in-app toast instead --------------------
        activeclient.postMessage({
          type: 'in_app_toast',
          title,
          body: options.body,
          note: options.data?.note
        })
        return
      }
      return self.registration.showNotification(title, options)
    })
  )
})

// handle notification click and open note --------------------
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const note = e.notification.data?.note
  const targeturl = note ? `/mobile?open=${encodeURIComponent(note)}` : '/mobile'

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientlist) => {
      for (const client of clientlist) {
        if ('focus' in client) {
          client.focus()
          if (note) {
            client.postMessage({ type: 'open_note', note_id: note })
          }
          return
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targeturl)
      }
    })
  )
})
