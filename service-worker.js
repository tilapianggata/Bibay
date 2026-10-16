const CACHE_NAME = 'cycle-tracker-v2';
const APP_SHELL = [
  './', './index.html', './css/style.css',
  './js/app.js', './js/db.js', './js/supabase-config.js', './js/sync.js',
  './manifest.json', './icons/icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Network-first: always get the latest code when online, fall back to the
// cache when offline. (Cache-first made installed apps stick to old versions.)
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req))
  );
});

// Best-effort background reminder (Chrome on Android, installed PWA only).
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'cycle-check') event.waitUntil(checkPrediction());
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
      const req = db.transaction('meta', 'readonly').objectStore('meta').get('prediction');
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror = () => reject(req.error);
    });
    if (!info || !info.lastStart) return;
    const [y, m, d] = info.lastStart.split('-').map(Number);
    const next = new Date(y, m - 1, d + Math.round(info.avgCycle));
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const daysUntil = Math.round((next - today) / 86400000);
    if (daysUntil >= 0 && daysUntil <= 2) {
      self.registration.showNotification('Period expected soon', {
        body: `Your next period is predicted around ${next.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}.`,
        icon: 'icons/icon.svg'
      });
    }
  } catch (e) { /* nothing to do */ }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      for (const client of clients) if ('focus' in client) return client.focus();
      if (self.clients.openWindow) return self.clients.openWindow('./index.html');
    })
  );
});
