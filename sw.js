/**
 * FamilyHub v4.7.4 — Service Worker (sw.js)
 * Implements Prompt 05 spec: Cache-First shell, Network-First 3s timeout, update detection, offline fallback.
 */
'use strict';

const APP_VERSION   = '4.7.4'; // [minor] BUG-60 fix: bump to match release
const CACHE_SHELL   = `fh-shell-v${APP_VERSION}`;
const CACHE_DYNAMIC = `fh-dynamic-v${APP_VERSION}`;
const ALL_CACHES    = [CACHE_SHELL, CACHE_DYNAMIC];

const SHELL_FILES = [
  './', './index.html', './manifest.json',
  './styles/tokens.css?v=4.7.4', './styles/layout.css?v=4.7.4',
  './styles/components.css?v=4.7.4', './styles/dark.css?v=4.7.4',
  './core/registry.js', './core/env.js', './core/utils.js', './core/errors.js',
  './core/i18n.js', './core/signals.js', './core/toast.js', './core/events.js',
  './core/router.js', './core/db.js', './core/auth.js', './core/graph-engine.js',
  './core/context.js', './core/object-type-registry.js', './core/tabs.js',
  './services/notification.js', './services/dialog.js', './services/hotkey.js',
  './services/history.js', './services/command.js', './services/effects.js',
  './services/theme.js', './services/sync.js', './services/activity.js',
  './components/entity-panel.js', './components/entity-form.js', './components/fab.js',
  './components/search.js', './components/search-bar.js', './components/command-palette.js',
  './components/systray.js', './components/graph-canvas.js',
  './components/activity-stream.js', './components/view-switcher.js',
  './components/type-editor-modal.js',
  './core/debug.js', './core/tour.js', './core/pwa.js',
  './views/daily.js', './views/kanban.js', './views/calendar.js',
  './views/family-wall.js', './views/stub-views.js',
  './views/notes.js', './views/projects.js', './views/messages.js', './views/settings.js',
  './views/generic-list.js',
  './views/dashboard.js',
  './views/entity-type.js', './views/graph-view.js', './views/object-studio.js',
  './icons/icon-192.png', './icons/icon-192-maskable.png',
  './icons/icon-512.png', './icons/icon-512-maskable.png',
  './icons/shortcut-daily.png', './icons/shortcut-task.png',
  './screenshots/daily-desktop.png', './screenshots/kanban-mobile.png',
];

const NETWORK_ONLY = [
  /api\.notion\.com/, /\/sync\/notion-proxy\.php/,
  /\/sync\/notion-cron\.php/, /\/sync\/save-data\.php/,
];

function _isShellFile(url) {
  try {
    const path = new URL(url).pathname;
    return SHELL_FILES.some(sf => {
      const sfPath = sf.split('?')[0];
      return sfPath === path || path.endsWith(sfPath.replace('./', '/'));
    });
  } catch { return false; }
}

// INSTALL: pre-cache shell, skipWaiting
self.addEventListener('install', event => {
  console.log('[SW] Installing v' + APP_VERSION);
  event.waitUntil(
    caches.open(CACHE_SHELL).then(cache =>
      Promise.allSettled(
        SHELL_FILES.map(url => cache.add(url).catch(e => console.warn('[SW] skip', url, e.message)))
      )
    ).then(() => self.skipWaiting())
  );
});

// ACTIVATE: delete old caches, claim clients, postMessage SW_UPDATED
self.addEventListener('activate', event => {
  console.log('[SW] Activating v' + APP_VERSION);
  event.waitUntil(
    Promise.all([
      caches.keys().then(keys =>
        Promise.all(keys.filter(k => !ALL_CACHES.includes(k)).map(k => caches.delete(k)))
      ),
      self.clients.claim(),
    ]).then(() =>
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
        clients.forEach(c => c.postMessage({ type: 'SW_UPDATED', version: APP_VERSION }));
        console.log('[SW] Notified ' + clients.length + ' client(s)');
      })
    )
  );
});

// FETCH: Network-First for ALL assets.
// Shell files go through network-first too so deploys take effect without waiting for SW update.
// Falls back to cache on network failure (offline support preserved).
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (NETWORK_ONLY.some(p => p.test(req.url))) { event.respondWith(fetch(req)); return; }
  if (!req.url.startsWith(self.location.origin)) return;

  // Network-first for everything — navigate, JS, CSS, images
  event.respondWith(_networkFirst(req, 4000));
});


async function _networkFirst(req, ms) {
  const timeout = new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms));
  try {
    const res = await Promise.race([fetch(req), timeout]);
    if (res.ok) (await caches.open(CACHE_DYNAMIC)).put(req, res.clone());
    return res;
  } catch {
    const hit = await caches.match(req);
    return hit || _offline();
  }
}

function _offline() {
  return new Response('{"error":"offline"}', {
    status: 503, headers: { 'Content-Type': 'application/json' }
  });
}

// BACKGROUND SYNC
self.addEventListener('sync', event => {
  if (event.tag === 'familyhub-sync') {
    event.waitUntil(
      self.clients.matchAll({ type: 'window' }).then(cs =>
        cs.forEach(c => c.postMessage({ type: 'BG_SYNC_TRIGGER' }))
      )
    );
  }
});

// PUSH
self.addEventListener('push', event => {
  if (!event.data) return;
  let d; try { d = event.data.json(); } catch { d = { title: 'FamilyHub', body: event.data.text() }; }
  event.waitUntil(
    self.registration.showNotification(d.title || 'FamilyHub', {
      body: d.body || '', icon: './icons/icon-192.png', badge: './icons/icon-192.png',
      tag: d.tag || 'fh', data: d.url || '/', vibrate: [100, 50, 100],
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
      const ex = cs.find(c => c.url.includes(self.location.origin));
      if (ex) { ex.focus(); ex.navigate(url); return; }
      return self.clients.openWindow(url);
    })
  );
});

// MESSAGE
self.addEventListener('message', event => {
  if (!event.data) return;
  if (event.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data.type === 'CACHE_URLS' && Array.isArray(event.data.urls)) {
    caches.open(CACHE_DYNAMIC).then(c => c.addAll(event.data.urls)).catch(() => {});
  }
});
