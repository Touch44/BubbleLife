/**
 * FamilyHub v3 — services/sync.js
 * [MAJOR] 3-C — BroadcastChannel multi-tab sync + MySQL server sync
 *
 * Registered as env.services.sync via serviceRegistry.
 *
 * ── BroadcastChannel (unchanged from baseline) ─────────────────
 * On start():
 *   1. Opens BroadcastChannel 'familyhub-sync'
 *   2. Starts 30s presence heartbeat (stable tab ID from sessionStorage)
 *   3. Maintains activeTabs signal (count of open FamilyHub tabs)
 *
 * ── MySQL Sync (new in 3-C) ────────────────────────────────────
 * Auto-syncs dirty entities/edges to api/sync.php every MYSQL_SYNC_MS.
 * Uses the dirty queues (dirtyEntities, dirtyEdges) in IDB settings.
 * Performs a pull after each successful push to receive remote changes.
 * Last-write-wins by updatedAt timestamp.
 *
 * Topbar indicator (#topbar-sync-indicator):
 *   circle  idle (default)
 *   arrows  syncing (accent colour)
 *   check   success (green, fades after 3s)
 *   cross   error (red, persists until next sync)
 *
 * Public API (via env.services.sync):
 *   broadcast(store, id, action)  — post to BroadcastChannel
 *   syncNow()                     — trigger immediate MySQL sync
 *   activeTabs                    — reactive signal: number of active tabs
 *   tabId                         — this tab's stable ID
 *   syncEnabled                   — signal: true if MySQL sync is configured
 *   lastSyncAt                    — signal: ms timestamp of last successful sync
 */

import { signal }    from '../core/signals.js';
import { showToast } from '../core/toast.js';

// ── Config ─────────────────────────────────────────────────────
const CHANNEL_NAME         = 'familyhub-sync';
const HEARTBEAT_MS         = 30_000;
const PRESENCE_TTL_MS      = 45_000;
const MYSQL_SYNC_MS        = 60_000;
const MYSQL_BOOT_DELAY_MS  = 5_000;
const SYNC_API_PATH        = './api/sync.php';
const SETTING_DIRTY_ENT    = 'dirtyEntities';
const SETTING_DIRTY_EDGE   = 'dirtyEdges';
const SETTING_LAST_PULL_MS = 'mysqlLastPullMs';
const SETTING_FAMILY_ID    = 'mysqlFamilyId';

// ── Module-level signals ───────────────────────────────────────
/** @type {BroadcastChannel|null} */
let _channel = null;

/** @type {string} stable per-session tab ID */
let _tabId = '';

/** Tracks last-seen timestamp per tab: Map<tabId, timestamp> */
const _tabPresence = new Map();

/** Reactive count of active tabs (including this one) */
export const activeTabs = signal(1);

/** true when MySQL sync is enabled and endpoint is reachable */
export const syncEnabled = signal(false);

/** ms timestamp of last successful MySQL sync (0 = never) */
export const lastSyncAt = signal(0);

/** true while a MySQL sync is in flight */
export const syncInProgress = signal(false);

// ── Tab ID ────────────────────────────────────────────────────
function _getTabId() {
  if (typeof sessionStorage === 'undefined') return 'tab-' + Math.random().toString(36).slice(2);
  let id = sessionStorage.getItem('fh_tab_id');
  if (!id) {
    id = 'tab-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    sessionStorage.setItem('fh_tab_id', id);
  }
  return id;
}

// ── Presence ──────────────────────────────────────────────────
function _updatePresence(tabId) {
  _tabPresence.set(tabId, Date.now());
  _prunePresence();
}

function _prunePresence() {
  const now = Date.now();
  for (const [id, ts] of _tabPresence) {
    if (now - ts > PRESENCE_TTL_MS) _tabPresence.delete(id);
  }
  activeTabs.value = _tabPresence.size;
}

// ── Topbar sync indicator ─────────────────────────────────────
const _indicator = {
  _el: null,
  _fadeTimer: null,
  _getEl() {
    if (!this._el) this._el = document.getElementById('topbar-sync-indicator');
    return this._el;
  },
  _set(icon, cssClass, ariaLabel, title) {
    const el = this._getEl(); if (!el) return;
    clearTimeout(this._fadeTimer);
    el.textContent = icon;
    // Use CSS class so layout.css animations (spin on .syncing) apply correctly
    el.className = cssClass ? cssClass : '';
    el.setAttribute('aria-label', ariaLabel);
    el.title = title;
  },
  idle() {
    this._set('\u25CB', '', 'Sync status: idle', 'Sync: idle');
  },
  syncing() {
    this._set('\u21BB', 'syncing', 'Sync status: syncing', 'Sync: syncing\u2026');
  },
  success() {
    this._set('\u2713', 'success', 'Sync status: up to date',
      'Sync: up to date (' + new Date().toLocaleTimeString() + ')');
    this._fadeTimer = setTimeout(() => this.idle(), 3000);
  },
  error(msg) {
    this._set('\u2715', 'error', 'Sync status: error',
      'Sync error: ' + (msg || 'unknown'));
  },
};

// ── Lazy DB/Auth imports ───────────────────────────────────────
// Imported lazily to avoid circular dependency at module init time.
let _dbMod   = null;
let _authMod = null;

async function _getDb() {
  if (!_dbMod) _dbMod = await import('../core/db.js');
  return _dbMod;
}
async function _getAuth() {
  if (!_authMod) _authMod = await import('../core/auth.js');
  return _authMod;
}

// ── API helper ─────────────────────────────────────────────────
async function _apiPost(payload) {
  const res = await fetch(SYNC_API_PATH, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });
  // 404 = no PHP file deployed (static host like GitHub Pages)
  // 405 = Method Not Allowed (static host rejecting POST)
  // Permanently disable sync so we don't keep hammering the host
  if (res.status === 404 || res.status === 405) {
    _mysqlAvailable = false;
    _indicator.idle();
    console.info('[sync] MySQL sync disabled — api/sync.php not available on this host (HTTP ' + res.status + ')');
    throw new Error('SYNC_UNAVAILABLE');
  }
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'Server error');
  return json;
}

// ── Family ID ──────────────────────────────────────────────────
async function _getFamilyId() {
  const db = await _getDb();
  let id = await db.getSetting(SETTING_FAMILY_ID);
  if (!id) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const hex   = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    id = hex.slice(0,8) + '-' + hex.slice(8,12) + '-' + hex.slice(12,16) + '-' + hex.slice(16,20) + '-' + hex.slice(20);
    await db.setSetting(SETTING_FAMILY_ID, id);
  }
  return id;
}

// ── Dirty queue helpers ────────────────────────────────────────
async function _readDirtyQueues() {
  const db = await _getDb();
  const [entRec, edgeRec] = await Promise.all([
    db.getSetting(SETTING_DIRTY_ENT).catch(() => []),
    db.getSetting(SETTING_DIRTY_EDGE).catch(() => []),
  ]);
  return {
    entityIds: Array.isArray(entRec)  ? entRec  : [],
    edgeIds:   Array.isArray(edgeRec) ? edgeRec : [],
  };
}

async function _clearDirtyQueues() {
  const db = await _getDb();
  await Promise.all([
    db.setSetting(SETTING_DIRTY_ENT,  []),
    db.setSetting(SETTING_DIRTY_EDGE, []),
  ]);
}

async function _loadDirtyEntities(entityIds) {
  if (!entityIds.length) return [];
  const db      = await _getDb();
  const results = await Promise.all(
    entityIds.map(id => db.getEntity(id).catch(() => null))
  );
  return results.filter(Boolean);
}

async function _loadDirtyEdges(edgeIds) {
  // dirtyEdges stores the edge's own ID, not a fromId — use getEdge()
  if (!edgeIds.length) return [];
  const db      = await _getDb();
  const results = await Promise.all(
    edgeIds.map(id => db.getEdge(id).catch(() => null))
  );
  return results.filter(Boolean);
}

// ── Merge pulled entities into IDB ─────────────────────────────
async function _mergeEntities(serverEntities) {
  if (!serverEntities || !serverEntities.length) return;
  const db      = await _getDb();
  const authMod = await _getAuth();
  const account = authMod.getAccount ? authMod.getAccount() : {};
  let   merged    = 0;
  let   conflicts = 0;

  const mergedEntities = [];  // track actually-written entities for ENTITY_SAVED events
  for (const se of serverEntities) {
    if (!se || !se.id) continue;
    try {
      const local = await db.getEntity(se.id).catch(() => null);
      if (local) {
        const localTs  = Number(local.updatedAt)  || 0;
        const serverTs = Number(se.updatedAt) || 0;
        if (serverTs <= localTs) continue;  // local is newer — skip
        conflicts++;
      }
      await db.saveEntity(se, account.id || '');
      mergedEntities.push(se);
      merged++;
    } catch (err) {
      console.warn('[sync] merge entity failed:', se.id, err);
    }
  }

  if (conflicts > 0) {
    showToast('Sync: ' + conflicts + ' conflict(s) resolved (server wins)', 'info');
  }

  if (merged > 0) {
    try {
      const evMod = await import('../core/events.js');
      // Only emit for entities that were actually written to IDB (mergedIds tracks them)
      for (const entity of mergedEntities) {
        if (entity && entity.type) {
          evMod.emit(evMod.EVENTS.ENTITY_SAVED, { entity, isNew: false });
        }
      }
    } catch (e) { /* non-critical */ }
  }
}

// ── Core MySQL sync ────────────────────────────────────────────
let _syncLock = false;
// Set to false permanently if server returns 404/405 (static host — no PHP)
let _mysqlAvailable = true;

async function _doMysqlSync() {
  if (_syncLock || !_mysqlAvailable) return;
  _syncLock = true;
  syncInProgress.value = true;
  _indicator.syncing();

  try {
    const authMod = await _getAuth();
    const session = authMod.getSession ? authMod.getSession() : null;

    if (!session || !session.sid) {
      _indicator.idle();
      return;
    }

    const db       = await _getDb();
    const familyId = await _getFamilyId();
    const token    = session.sid;

    // Step 1: Handshake — register/renew session on server
    try {
      await _apiPost({
        action:    'handshake',
        token,
        accountId: session.accountId || '',
        familyId,
        expiresAt: session.expiresAt || (Date.now() + 86400000),
      });
    } catch (hsErr) {
      console.warn('[sync] handshake failed:', hsErr.message);
      // Non-fatal for push — push will get a 401 if truly invalid
    }

    // Step 2: Push dirty entities and edges
    const { entityIds, edgeIds } = await _readDirtyQueues();
    const entities = await _loadDirtyEntities(entityIds);
    const edges    = await _loadDirtyEdges(edgeIds);

    if (entities.length || edges.length) {
      await _apiPost({ action: 'push', token, entities, edges });
      await _clearDirtyQueues();
    }

    // Step 3: Pull changes from server since last sync
    const lastPullMs = (await db.getSetting(SETTING_LAST_PULL_MS).catch(() => 0)) || 0;
    const pullRes = await _apiPost({ action: 'pull', token, since_ms: lastPullMs });

    if (pullRes.entities && pullRes.entities.length) {
      await _mergeEntities(pullRes.entities);
    }

    // Save server timestamp as next since_ms baseline
    await db.setSetting(SETTING_LAST_PULL_MS, pullRes.server_time_ms || Date.now());

    syncEnabled.value = true;
    lastSyncAt.value  = Date.now();
    _indicator.success();

  } catch (err) {
    // Don't show error indicator for static-host unavailability (already logged as info)
    if (err.message !== 'SYNC_UNAVAILABLE') {
      console.warn('[sync] MySQL sync failed:', err.message);
      _indicator.error(err.message);
    }
    // Silent failure — retry on next timer tick (unless permanently disabled)
  } finally {
    _syncLock = false;
    syncInProgress.value = false;
  }
}

// ── Service factory ───────────────────────────────────────────
export function createSyncService(env) {
  const bus = env && env.bus;
  _tabId = _getTabId();
  _updatePresence(_tabId);

  // ── BroadcastChannel ────────────────────────────────────────
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      _channel = new BroadcastChannel(CHANNEL_NAME);

      _channel.onmessage = function(event) {
        const msg = event.data;
        if (!msg || !msg.type) return;

        if (msg.type === 'presence') {
          _updatePresence(msg.tabId);
          return;
        }

        if (msg.type === 'sync' && msg.store) {
          if (bus) {
            bus.emit('sync:' + msg.store, {
              store:  msg.store,
              id:     msg.id,
              action: msg.action,
              tabId:  msg.tabId,
            });
          }
          return;
        }
      };

      _channel.onmessageerror = function(err) {
        console.warn('[sync] Message error:', err);
      };

    } catch (err) {
      console.warn('[sync] BroadcastChannel unavailable:', err.message);
      _channel = null;
    }
  } else {
    console.info('[sync] BroadcastChannel not supported — single-tab mode');
  }

  // ── Presence heartbeat ───────────────────────────────────────
  let _heartbeatTimer = null;

  function _sendHeartbeat() {
    if (_channel) {
      try {
        _channel.postMessage({ type: 'presence', tabId: _tabId, ts: Date.now() });
      } catch(e) { /* channel closed */ }
    }
    _updatePresence(_tabId);
  }

  _sendHeartbeat();
  _heartbeatTimer = setInterval(_sendHeartbeat, HEARTBEAT_MS);

  // ── MySQL auto-sync loop ─────────────────────────────────────
  let _mysqlTimer = null;

  var _bootTimeout = setTimeout(function() {
    _doMysqlSync().catch(function() {});
    _mysqlTimer = setInterval(function() {
      _doMysqlSync().catch(function() {});
    }, MYSQL_SYNC_MS);
  }, MYSQL_BOOT_DELAY_MS);

  // ── Cleanup ─────────────────────────────────────────────────
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', function() {
      clearTimeout(_bootTimeout);
      clearInterval(_heartbeatTimer);
      clearInterval(_mysqlTimer);
      if (_channel) _channel.close();
    });
  }

  // ── Public API ───────────────────────────────────────────────

  function broadcast(store, id, action) {
    if (!_channel) return;
    try {
      _channel.postMessage({ type: 'sync', store: store, id: id, action: action, tabId: _tabId, ts: Date.now() });
    } catch (err) {
      console.warn('[sync] broadcast failed:', err);
    }
  }

  function syncNow() {
    return _doMysqlSync();
  }

  return {
    broadcast,
    syncNow,
    activeTabs,
    syncEnabled,
    lastSyncAt,
    syncInProgress,
    tabId: _tabId,
  };
}

// ── Service descriptor ────────────────────────────────────────
export const syncServiceDescriptor = {
  dependencies: [],
  start: function(env) {
    return createSyncService(env);
  },
};
