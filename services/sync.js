/**
 * FamilyHub v3.0 — services/sync.js
 * BroadcastChannel multi-tab sync service.
 * Implements Prompt 27 spec exactly.
 *
 * Registered as env.services.sync via serviceRegistry.
 *
 * On start():
 *   1. Opens BroadcastChannel 'familyhub-sync'
 *   2. Starts 30s presence heartbeat (stable tab ID from sessionStorage)
 *   3. Maintains activeTabs signal (count of open FamilyHub tabs)
 *
 * Public API:
 *   broadcast(store, id, action)  — post to channel ('create'|'update'|'delete')
 *   activeTabs                    — reactive signal: number of active tabs
 *   tabId                         — this tab's stable ID
 *
 * On receiving a message:
 *   - Emits 'sync:{store}' on env.bus with payload so views refresh
 *
 * Graceful degradation:
 *   - BroadcastChannel not supported → sync service no-ops, app works normally
 *   - Safari private mode → same no-op behaviour
 *
 * Integration:
 *   - dataService wires calls to sync.broadcast() after successful mutations
 */

import { signal } from '../core/signals.js';

const CHANNEL_NAME     = 'familyhub-sync';
const HEARTBEAT_MS     = 30_000;
const PRESENCE_TTL_MS  = 45_000;   // miss 1.5 heartbeats → tab considered gone

/** @type {BroadcastChannel|null} */
let _channel = null;

/** @type {string} stable per-session tab ID */
let _tabId = '';

/** Tracks last-seen timestamp per tab: Map<tabId, timestamp> */
const _tabPresence = new Map();

/** Reactive count of active tabs (including this one) */
export const activeTabs = signal(1);

// ── Tab ID ────────────────────────────────────────────────── //

function _getTabId() {
  if (typeof sessionStorage === 'undefined') return `tab-${Math.random().toString(36).slice(2)}`;
  let id = sessionStorage.getItem('fh_tab_id');
  if (!id) {
    id = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem('fh_tab_id', id);
  }
  return id;
}

// ── Presence ─────────────────────────────────────────────── //

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

// ── Service factory ───────────────────────────────────────── //

export function createSyncService(env) {
  const bus = env?.bus;
  _tabId = _getTabId();

  // Register this tab in presence map immediately
  _updatePresence(_tabId);

  // ── BroadcastChannel setup ────────────────────────────── //
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      _channel = new BroadcastChannel(CHANNEL_NAME);

      _channel.onmessage = (event) => {
        const msg = event.data;
        if (!msg?.type) return;

        if (msg.type === 'presence') {
          _updatePresence(msg.tabId);
          return;
        }

        if (msg.type === 'sync' && msg.store) {
          // Emit on env bus so views can re-fetch
          bus?.emit(`sync:${msg.store}`, {
            store:  msg.store,
            id:     msg.id,
            action: msg.action,
            tabId:  msg.tabId,
          });
          return;
        }
      };

      _channel.onmessageerror = (err) => {
        console.warn('[sync] Message error:', err);
      };

    } catch (err) {
      // Safari private mode or unsupported — graceful no-op
      console.warn('[sync] BroadcastChannel unavailable:', err.message);
      _channel = null;
    }
  } else {
    console.info('[sync] BroadcastChannel not supported — single-tab mode');
  }

  // ── Presence heartbeat ────────────────────────────────── //
  let _heartbeatTimer = null;

  function _sendHeartbeat() {
    if (_channel) {
      try {
        _channel.postMessage({ type: 'presence', tabId: _tabId, ts: Date.now() });
      } catch { /* channel closed */ }
    }
    // Update our own presence
    _updatePresence(_tabId);
  }

  _sendHeartbeat(); // immediate first beat
  _heartbeatTimer = setInterval(_sendHeartbeat, HEARTBEAT_MS);

  // Cleanup on page unload
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
      clearInterval(_heartbeatTimer);
      _channel?.close();
    });
  }

  // ── Public API ────────────────────────────────────────── //

  /**
   * Broadcast a data mutation to all other tabs.
   * @param {string} store  — entity store name (e.g. 'task', 'event')
   * @param {string} id     — entity ID
   * @param {'create'|'update'|'delete'} action
   */
  function broadcast(store, id, action) {
    if (!_channel) return; // no-op when unavailable

    try {
      _channel.postMessage({
        type:   'sync',
        store,
        id,
        action,
        tabId:  _tabId,
        ts:     Date.now(),
      });
    } catch (err) {
      console.warn('[sync] broadcast failed:', err);
    }
  }

  return { broadcast, activeTabs, tabId: _tabId };
}

// ── Service descriptor ────────────────────────────────────── //

export const syncServiceDescriptor = {
  dependencies: [],
  start(env) {
    return createSyncService(env);
  },
};
