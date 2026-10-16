const CACHE_NAME = 'cycle-tracker-v1';
const APP_SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/db.js',
  './js/supabase-config.js',
  './js/sync.js',
  './manifest.json',
  './icons/icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});

// Best-effort background check. Periodic Background Sync is an experimental,
// Chrome-on-Android-only API that only fires for installed PWAs that are
// used fairly regularly — it is NOT a guaranteed push notification. For
// guaranteed delivery even when the app is closed for a long time, you'd
// need a real push server (see README).
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'cycle-check') {
    event.waitUntil(checkPrediction());
  }
});

function openMetaDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('cycle-tracker-db', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('meta', { keyPath: 'key' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function checkPrediction() {
  try {
    const db = await openMetaDB();
    const info = await new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readonly');
      const req = tx.objectStore('meta').get('prediction');
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror = () => reject(req.error);
    });
    if (!info || !info.lastStart) return;
    const next = new Date(info.lastStart + 'T00:00:00');
    next.setDate(next.getDate() + Math.round(info.avgCycle));
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const daysUntil = Math.round((next - today) / 86400000);
    if (daysUntil >= 0 && daysUntil <= 2) {
      self.registration.showNotification('Period expected soon', {
        body: `Your next period is predicted around ${next.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}.`,
        icon: 'icons/icon.svg'
      });
    }
  } catch (e) {
    // IndexedDB not reachable or empty — nothing to do
  }
}

// Real Web Push: fires even if the app isn't open, as long as the device
// has network and the OS allows it. Requires the notify edge function +
// VAPID keys from the README to actually be sending pushes.
self.addEventListener('push', (event) => {
  let data = { title: 'Cycle Tracker', body: 'You have an update.' };
  try { data = event.data.json(); } catch (e) { /* use default */ }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Cycle Tracker', {
      body: data.body || '',
      icon: 'icons/icon.svg'
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./index.html');
    })
  );
});
