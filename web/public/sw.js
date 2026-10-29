// Codinger's service worker: it shows the push notifications that web.codinger.app sends
// (remote/src/push.ts), and a click on one opens its session (web/src/push.ts).

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('push', (e) => {
  let d = {}
  try { d = e.data ? e.data.json() : {} } catch { /* not JSON */ }
  // One notification for each session: a new one takes the place of the old.
  e.waitUntil(self.registration.showNotification(d.title || 'Codinger', {
    body: d.body || '',
    // The session's critter; an iPhone shows the app's icon in its place.
    ...(d.icon ? { icon: d.icon } : {}),
    tag: `${d.machine}~${d.session}`,
    renotify: true,
    data: { machine: d.machine || '', session: d.session || '' },
  }))
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const { machine, session } = e.notification.data || {}
  e.waitUntil((async () => {
    const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const page = pages.find((c) => new URL(c.url).origin === self.location.origin)
    if (page) {
      page.postMessage({ type: 'codinger-push', machine, session })
      return page.focus()
    }
    return self.clients.openWindow(`/?push=${encodeURIComponent(`${machine}~${session}`)}`)
  })())
})
