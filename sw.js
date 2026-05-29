/**
 * FamilyHub v5.3.1 — Service Worker (sw.js)
 * [minor] Phase 2: condition UI, quiet hours, timer in form, reminder badges, template library
 */
'use strict';

const APP_VERSION   = '6.5.3'; // [v6.2.1] Bug audit: timer listener leaks x3, badge CSS, panel open UX, entity-panel plannedDuration pre-select, getSession ref // [v6.2.0] Tab pinning (per-account), floating timer panel, task period overlap checking, context banner fix, dashboard timer widget // [v6.1.1] Text cutoff fixes + auto-deadline + complete project flow + smart duplication (4-tab modal, velocity chart, heatmap, leaderboard, badges)
const CACHE_SHELL   = `fh-shell-v${APP_VERSION}`;
const CACHE_DYNAMIC = `fh-dynamic-v${APP_VERSION}`;
const ALL_CACHES    = [CACHE_SHELL, CACHE_DYNAMIC];

const SHELL_FILES = [
  './', './index.html', `./manifest.json?v=${APP_VERSION}`, // 3P-L-02: version-bust manifest
  `./styles/tokens.css?v=${APP_VERSION}`, `./styles/layout.css?v=${APP_VERSION}`,
  `./styles/components.css?v=${APP_VERSION}`, `./styles/dark.css?v=${APP_VERSION}`,
  './core/registry.js', './core/env.js', './core/utils.js', './core/errors.js',
  './core/i18n.js', './core/signals.js', './core/toast.js', './core/events.js',
  './core/router.js', './core/db.js', './core/auth.js', './core/graph-engine.js',
  './core/context.js', './core/object-type-registry.js', './core/tabs.js',
  './core/banner.js',      // [v6.0.2] global context+focus banner
  './services/gamification.js', // [v6.1.0] gamification engine
  './services/notification.js', './services/dialog.js', './services/hotkey.js',
  './services/history.js', './services/command.js', './services/effects.js',
  './services/theme.js', './services/sync.js', './services/activity.js',
  './services/time-tracker.js',
  './services/overlap-detector.js',
  './services/auto-reminder-rules.js', // [v5.2.7] Phase 3: auto-rules engine
  './views/reminder-analytics.js',     // [v5.2.7] Phase 3: reminder analytics view
  './components/entity-panel.js', './components/entity-form.js', './components/fab.js',
  './components/search.js', './components/search-bar.js', './components/command-palette.js',
  './components/systray.js', './components/graph-canvas.js',
  './components/activity-stream.js', './components/view-switcher.js',
  './components/type-editor-modal.js', './components/timer-panel.js',
  './core/debug.js', './core/tour.js', './core/pwa.js',
  './views/daily.js', './views/kanban.js', './views/calendar.js',
  './views/family-wall.js', './views/stub-views.js',
  './views/notes.js', './views/projects.js', './views/messages.js', './views/settings.js',
  './views/generic-list.js',
  './views/dashboard.js',
  './views/entity-type.js', './views/object-studio.js',
  // [v5.0.0] Reminder system files
  './views/reminders.js',
  './services/reminder.js', './services/rrule-lite.js', './services/condition-eval.js',
  './services/recurrence.js',  // [v5.3.1] Ghost instance scheduler
  './components/alert-card.js', './components/reminder-form.js',
  './icons/icon-192.png', './icons/icon-192-maskable.png',
  './icons/icon-512.png', './icons/icon-512-maskable.png',
  './icons/shortcut-daily.png', './icons/shortcut-task.png',
  './screenshots/daily-desktop.png', './screenshots/kanban-mobile.png',
  // [v6.0.0] Self-hosted fonts (offline-first — no Google Fonts CDN)
  './assets/fonts/PlusJakartaSans-300.woff2',
  './assets/fonts/PlusJakartaSans-400.woff2',
  './assets/fonts/PlusJakartaSans-500.woff2',
  './assets/fonts/PlusJakartaSans-600.woff2',
  './assets/fonts/PlusJakartaSans-700.woff2',
  // [v6.0.0] Vendored idb library (no jsdelivr CDN dependency)
  './core/vendor/idb.js',
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

// [v5.0.0] Reminder insurance timers — cleared on SW termination (primary = in-page scheduler)
const _pendingReminders = new Map();

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const { action }      = event;
  const { reminderId, targetId } = event.notification.data || {};

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
      const client = cs.find(c => c.focused) || cs[0];
      if (client) {
        // Send action back to in-page handler
        client.postMessage({ type: 'NOTIF_ACTION', action, reminderId, targetId });
        return client.focus();
      }
      // No open window — open with deep link
      const openUrl = targetId ? `/?open=reminder:${reminderId}` : '/';
      return self.clients.openWindow(openUrl);
    })
  );
});

// MESSAGE
self.addEventListener('message', event => {
  if (!event.data) return;
  const { type, reminderId, msUntilFire, title, body, data } = event.data;

  if (type === 'SKIP_WAITING') { self.skipWaiting(); return; }

  if (type === 'CACHE_URLS' && Array.isArray(event.data.urls)) {
    caches.open(CACHE_DYNAMIC).then(c => c.addAll(event.data.urls)).catch(() => {});
    return;
  }

  // [v5.0.0] Reminder SW insurance timers
  if (type === 'SCHEDULE_REMINDER' && reminderId && msUntilFire > 0) {
    if (_pendingReminders.has(reminderId)) clearTimeout(_pendingReminders.get(reminderId));
    const tid = setTimeout(() => {
      self.registration.showNotification(title || 'Reminder', {
        body:    body || '',
        icon:    './icons/icon-192.png',
        badge:   './icons/icon-192.png',
        tag:     reminderId,
        data:    data || { reminderId },
        actions: [
          { action: 'snooze',  title: 'Snooze 10m' },
          { action: 'dismiss', title: 'Dismiss' },
        ],
        vibrate: [100, 50, 100],
      });
      _pendingReminders.delete(reminderId);
    }, Math.min(msUntilFire, 2147483647)); // clamp to max setTimeout
    _pendingReminders.set(reminderId, tid);
    return;
  }

  if (type === 'CANCEL_REMINDER' && reminderId) {
    clearTimeout(_pendingReminders.get(reminderId));
    _pendingReminders.delete(reminderId);
    return;
  }

  if (type === 'SHOW_NOTIFICATION' && title) {
    // H-03 fix: add tag (deduplication) and consistent vibrate; extract reminderId from data
    const _snTag = (data && data.reminderId) ? data.reminderId : ('fh-notif-' + Date.now());
    self.registration.showNotification(title, {
      body:    body || '',
      icon:    './icons/icon-192.png',
      badge:   './icons/icon-192.png',
      tag:     _snTag,
      data:    data || {},
      actions: [
        { action: 'snooze',  title: 'Snooze 10m' },
        { action: 'dismiss', title: 'Dismiss' },
      ],
      vibrate: [100, 50, 100],
    });
    return;
  }
});
