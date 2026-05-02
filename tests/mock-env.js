/**
 * FamilyHub v4.2 — tests/mock-env.js
 * Build a complete mock env using in-memory implementations.
 * No IndexedDB, no DOM, no service worker.
 *
 * Usage:
 *   import { buildMockEnv } from './mock-env.js';
 *   const env = await buildMockEnv();
 *   env.services.data.saveEntity({ type:'task', title:'Test' });
 */

// ── In-memory DB ──────────────────────────────────────────── //

let _store = {};
let _idSeq  = 0;

function _uid() { return `mock-${++_idSeq}`; }

function _now() { return new Date().toISOString(); }

/** Minimal in-memory implementation of the data service API */
const mockData = {
  _entities:  new Map(),
  _edges:     new Map(),
  _settings:  new Map(),

  async saveEntity(entity, byAccountId) {
    const isNew = !entity.id;
    const saved = {
      ...entity,
      id:        entity.id || _uid(),
      createdAt: entity.createdAt || _now(),
      updatedAt: _now(),
      createdBy: entity.createdBy || byAccountId || null,
    };
    this._entities.set(saved.id, saved);
    return saved;
  },

  async getEntity(id) {
    const e = this._entities.get(id);
    return (e && !e.deleted) ? e : null;
  },

  async getEntitiesByType(type) {
    return [...this._entities.values()].filter(e => e.type === type && !e.deleted);
  },

  async queryEntities(filter = {}) {
    let results = [...this._entities.values()];
    if (!filter.includeDeleted) results = results.filter(e => !e.deleted);
    if (filter.type) results = results.filter(e => e.type === filter.type);
    if (filter.createdBy) results = results.filter(e => e.createdBy === filter.createdBy);
    return results;
  },

  async deleteEntity(id) {
    const e = this._entities.get(id);
    if (e) this._entities.set(id, { ...e, deleted: true, updatedAt: _now() });
  },

  async saveEdge(edge, byAccountId) {
    const saved = { ...edge, id: edge.id || _uid(), createdAt: edge.createdAt || _now(), createdBy: byAccountId || null };
    this._edges.set(saved.id, saved);
    return saved;
  },

  async getEdge(id)                        { return this._edges.get(id) ?? null; },
  async getEdgesFrom(entityId, relation)   { return [...this._edges.values()].filter(e => e.fromId === entityId && (!relation || e.relation === relation)); },
  async getEdgesTo(entityId, relation)     { return [...this._edges.values()].filter(e => e.toId   === entityId && (!relation || e.relation === relation)); },
  async deleteEdge(id)                     { this._edges.delete(id); },

  async getSetting(key)                    { return this._settings.get(key); },
  async setSetting(key, value)             { this._settings.set(key, value); },
  async getSettings(keys)                  { const r={}; for (const k of keys) r[k]=this._settings.get(k); return r; },

  async exportAll()                        { return { entities:[...this._entities.values()], edges:[...this._edges.values()], settings:{} }; },
  async importAll(data)                    { for (const e of data.entities??[]) this._entities.set(e.id,e); return { entitiesImported: data.entities?.length??0, edgesImported: 0 }; },
  uid()                                    { return _uid(); },

  _reset() { this._entities.clear(); this._edges.clear(); this._settings.clear(); _idSeq = 0; },
};

// ── No-op services ────────────────────────────────────────── //

const mockNotification = {
  info:    (msg) => console.log('[mock:notif:info]', msg),
  success: (msg) => console.log('[mock:notif:success]', msg),
  warning: (msg) => console.log('[mock:notif:warning]', msg),
  danger:  (msg) => console.log('[mock:notif:danger]', msg),
  warn:    (msg) => console.log('[mock:notif:warn]', msg),
  error:   (msg) => console.log('[mock:notif:error]', msg),
  dismiss: ()    => {},
};

const mockDialog = {
  confirm: async () => true,
  add:     () => () => {},
  closeAll: () => {},
};

const mockHotkey = {
  add:    () => {},
  remove: () => {},
  getAll: () => [],
};

const mockHistory = {
  push:    async () => {},
  undo:    async () => {},
  redo:    async () => {},
  canUndo: () => false,
  canRedo: () => false,
};

const mockCommand = {
  add:     () => {},
  remove:  () => {},
  execute: async () => {},
  getAll:  () => [],
  search:  () => [],
};

const mockTheme = {
  setTheme: async () => {},
  getPrefs: () => ({ mode: 'light' }),
};

const mockEffects = {
  play: () => {},
  register: () => {},
};

const mockSync = {
  broadcast: () => {},
  tabId: 'mock-tab',
};

// ── Mock event bus ────────────────────────────────────────── //

function buildMockBus() {
  const _listeners = new Map();
  return {
    on(event, handler) {
      if (!_listeners.has(event)) _listeners.set(event, new Set());
      _listeners.get(event).add(handler);
      return () => _listeners.get(event)?.delete(handler);
    },
    off(event, handler) { _listeners.get(event)?.delete(handler); },
    emit(event, data) {
      _listeners.get(event)?.forEach(h => { try { h(data); } catch {} });
    },
    once(event, handler) {
      const wrapper = (d) => { handler(d); _listeners.get(event)?.delete(wrapper); };
      this.on(event, wrapper);
    },
  };
}

// ── buildMockEnv ──────────────────────────────────────────── //

/**
 * Build and return a complete mock env.
 * All services are in-memory; no DOM or IDB required.
 * @returns {Promise<object>} mock env
 */
export async function buildMockEnv() {
  const bus = buildMockBus();

  const services = Object.freeze({
    data:         mockData,
    notification: mockNotification,
    dialog:       mockDialog,
    hotkey:       mockHotkey,
    history:      mockHistory,
    command:      mockCommand,
    theme:        mockTheme,
    effects:      mockEffects,
    sync:         mockSync,
  });

  return Object.freeze({
    services,
    bus,
    version: '3.0.0',
    debug:   true,
  });
}

/** Reset all mock data between tests. */
export function resetMockData() {
  mockData._reset();
}
