/**
 * services/klre-engine.js
 * KLRE — Core orchestrator. Single public-facing KLRE service.
 * All UI components import from here.
 * [v6.6.0]
 */

import {
  uid, getSetting, setSetting,
  getEntity, getEntitiesByType, saveEdge,
  getKlreSuggestions, saveKlreSuggestions,
  logKlreAccess, isDismissed, setDismissed,
} from '../core/db.js';

import {
  getNeighbors, getBacklinks, getEdgesFrom,
  getEntityTypeConfig, getAllEntityTypes,
} from '../core/graph-engine.js';

import { emit, on, EVENTS } from '../core/events.js';
import { getAccount } from '../core/auth.js';
import { buildFullIndex, updateEntityIndex, getIndexEntry } from './klre-index.js';
import * as Signals from './klre-signals.js';

// ── Module-level state ────────────────────────────────────── //
// All state declared here — never re-declared inside functions.
let _initialised       = false;
let _listenersRegistered = false;
const _sessionId       = uid();   // generated ONCE at module load — do not regenerate
let _accessWindow      = [];      // [{entityId, ts}] rolling 30-min co-access window
let _learnedWeights    = { w1: 1, w2: 1, w3: 1, w4: 1, w6: 1, w7: 1 }; // no w5 — S5 is a multiplier
let _tagFrequencyMap   = {};      // {tag: entityCount} — built after index ready
let _totalEntityCount  = 0;       // total indexed entities for S4 rarity %
let _lastBuiltAt       = null;    // ISO string, set when index completes

// Health boost configuration
const HEALTH_TYPES = new Set(['medication', 'appointment']);
const HEALTH_TAGS  = new Set(['health', 'medical', 'doctor', 'hospital', 'dentist', 'pharmacy']);

// Suggestion cache max-age
const CACHE_MAX_AGE_MS = 3600000; // 1 hour

// ── Public: init ──────────────────────────────────────────── //

/**
 * Initialise KLRE. Loads persisted weights, registers listeners, kicks off index build.
 * Must be called once during app boot (after initDB + initAuth).
 * Index build is deferred to requestIdleCallback — non-blocking.
 */
export async function initKLRE() {
  if (_initialised) return;

  // Load persisted learned weights from settings store
  try {
    const saved = await getSetting('klre_weights');
    if (saved && typeof saved === 'object') {
      // Merge saved weights, keeping defaults for any missing keys
      Object.keys(_learnedWeights).forEach(k => {
        if (typeof saved[k] === 'number') _learnedWeights[k] = saved[k];
      });
    }
  } catch (e) {
    console.warn('[KLRE] Could not load saved weights:', e);
  }

  // Register event listeners (guarded — register exactly once)
  if (!_listenersRegistered) {
    _listenersRegistered = true;

    // On entity save: re-index the changed entity, invalidate its suggestion cache
    on(EVENTS.ENTITY_SAVED, async (entity) => {
      if (!entity || !entity.id) return;
      try {
        await updateEntityIndex(entity);
        // Invalidate focal entity's cache
        await saveKlreSuggestions({ entityId: entity.id, suggestions: [], updatedAt: null });
        // Invalidate direct neighbors' caches (their suggestions may have changed)
        const neighbors = await getNeighbors(entity.id);
        await Promise.all(neighbors.map(n =>
          saveKlreSuggestions({ entityId: n.entityId, suggestions: [], updatedAt: null })
        ));
      } catch (e) {
        console.warn('[KLRE] ENTITY_SAVED handler failed:', e);
      }
    });

    // On panel open: log co-access and update rolling window
    on(EVENTS.PANEL_OPENED, ({ entityId } = {}) => {
      if (!entityId) return;
      const now = Date.now();
      _accessWindow.push({ entityId, ts: now });
      // Prune entries older than 30 min, keep max 50 entries
      _accessWindow = _accessWindow.filter(e => now - e.ts < 1800000).slice(-50);
      logKlreAccess(entityId, _sessionId); // fire and forget
    });

    // Learning loop listeners
    on(EVENTS.KLRE_SUGGESTION_CONFIRMED, ({ fromId, toId, signals }) => {
      _onConfirm(fromId, toId, signals || {});
    });
    on(EVENTS.KLRE_SUGGESTION_DISMISSED, ({ fromId, toId, signals }) => {
      _onDismiss(fromId, toId, signals || {});
    });

    // Build tagFrequencyMap once the index is ready
    on(EVENTS.KLRE_INDEX_READY, async ({ count }) => {
      _totalEntityCount = count;
      _lastBuiltAt = new Date().toISOString();
      try {
        const typeKeys    = getAllEntityTypes().map(t => t.key);
        const allEntities = (await Promise.all(typeKeys.map(k => getEntitiesByType(k)))).flat();
        _tagFrequencyMap  = {};
        for (const e of allEntities) {
          for (const tag of (Array.isArray(e.tags) ? e.tags : [])) {
            _tagFrequencyMap[tag] = (_tagFrequencyMap[tag] || 0) + 1;
          }
        }
      } catch (e) {
        console.warn('[KLRE] tagFrequencyMap build failed:', e);
      }
    });
  }

  _initialised = true;

  // Kick off index build asynchronously — never blocks the UI
  if (typeof requestIdleCallback !== 'undefined') {
    requestIdleCallback(() => buildFullIndex().catch(e => console.warn('[KLRE] index build failed:', e)));
  } else {
    setTimeout(() => buildFullIndex().catch(e => console.warn('[KLRE] index build failed:', e)), 0);
  }
}

// ── Public: getSuggestions ────────────────────────────────── //

/**
 * Get related item suggestions for an entity.
 * Checks cache first (1-hour TTL), computes if stale.
 * @param {string} entityId
 * @param {Object} opts
 * @param {number} [opts.maxResults=8]
 * @param {boolean} [opts.includeConfirmed=true]
 * @param {number} [opts.minScore] - defaults to getSetting('klre_min_score') || 0.18
 * @param {string[]|null} [opts.typeFilter=null]
 * @returns {Promise<Array>}
 */
export async function getSuggestions(entityId, opts = {}) {
  // Check master toggle first
  const enabled = await getSetting('klre_enabled');
  if (enabled === false) return [];

  const maxResults      = opts.maxResults     ?? 8;
  const includeConfirmed = opts.includeConfirmed ?? true;
  const minScore        = opts.minScore       ?? (await getSetting('klre_min_score')) ?? 0.18;
  const typeFilter      = opts.typeFilter     ?? null;

  // A) Load focal entity
  const focalEntity = await getEntity(entityId);
  if (!focalEntity || focalEntity.deleted) return [];

  // B) Cache check — use cached list if fresh, applying caller-requested filters
  const cached = await getKlreSuggestions(entityId);
  const cacheAge = cached?.updatedAt
    ? (Date.now() - new Date(cached.updatedAt).getTime())
    : Infinity;

  let suggestions = [];

  if (cacheAge < CACHE_MAX_AGE_MS && cached.suggestions && cached.suggestions.length > 0) {
    // Cache hit — filter by caller's minScore and typeFilter before returning
    suggestions = cached.suggestions
      .filter(s => s.score >= minScore)
      .filter(s => !typeFilter || typeFilter.includes(s.candidateType));
  } else {
    // C) Compute suggestions
    suggestions = await _computeSuggestions(entityId, focalEntity, minScore);
    // Apply typeFilter to saved list too (but save the full list to cache)
    if (typeFilter) {
      suggestions = suggestions.filter(s => typeFilter.includes(s.candidateType));
    }
  }

  // D) Cap 3 per entity type in the returned list
  const typeCounts = {};
  const capped = suggestions.filter(s => {
    typeCounts[s.candidateType] = (typeCounts[s.candidateType] || 0) + 1;
    return typeCounts[s.candidateType] <= 3;
  });

  // E) Prepend confirmed edges (both directions) if requested
  let result = capped;
  if (includeConfirmed) {
    const confirmedItems = await _getConfirmedItems(entityId);
    result = [...confirmedItems, ...capped];
  }

  return result.slice(0, maxResults);
}

/**
 * Compute suggestion scores for all candidate entities.
 * @private
 */
async function _computeSuggestions(entityId, focalEntity, minScore) {
  const focalIndexEntry = await getIndexEntry(entityId);
  const rawNeighborsA   = await getNeighbors(entityId);

  // CRITICAL: getNeighbors() has no entityType — enrich via batch entity fetch
  const neighborIds = [...new Set(rawNeighborsA.map(n => n.entityId))];
  const neighborEntities = await Promise.all(neighborIds.map(id => getEntity(id)));
  const typeMap = new Map(neighborEntities.filter(Boolean).map(e => [e.id, e.type]));
  const neighborsA = rawNeighborsA.map(n => ({
    ...n,
    entityType: typeMap.get(n.entityId) ?? 'unknown',
  }));

  // Create enriched focal for S6
  const enrichedFocal = { ...focalEntity, searchBlob: focalIndexEntry?.searchBlob ?? '' };

  // Load all candidate entities across all types
  const typeKeys    = getAllEntityTypes().map(t => t.key);
  const allEntities = (await Promise.all(typeKeys.map(k => getEntitiesByType(k)))).flat();

  // ── Performance: batch pre-load index entries + dismissed status ──────
  // Pre-loading in parallel eliminates N sequential IDB reads in the main loop.
  const [allIndexEntries, allDismissed] = await Promise.all([
    Promise.all(allEntities.map(e => getIndexEntry(e.id))),
    Promise.all(allEntities.map(e => isDismissed(entityId, e.id))),
  ]);
  const indexMap    = new Map(allEntities.map((e, i) => [e.id, allIndexEntries[i]]));
  const dismissedSet = new Set(allEntities.filter((e, i) => allDismissed[i]).map(e => e.id));

  const computed = [];

  for (const candidateEntity of allEntities) {
    // Skip self, deleted, taskInstance type
    if (candidateEntity.id === entityId) continue;
    if (candidateEntity.deleted) continue;
    if (candidateEntity.type === 'taskInstance') continue;
    // Skip dismissed pairs (pre-loaded above — no per-candidate await)
    if (dismissedSet.has(candidateEntity.id)) continue;

    const candidateIndexEntry = indexMap.get(candidateEntity.id);
    if (!candidateIndexEntry) continue; // not yet indexed — skip

    // Enrich candidate neighbors (still per-candidate, but batched internally)
    const rawNeighborsB = await getNeighbors(candidateEntity.id);
    const neighborIdsB  = [...new Set(rawNeighborsB.map(n => n.entityId))];
    const neighborEntitiesB = await Promise.all(neighborIdsB.map(id => getEntity(id)));
    const typeMapB = new Map(neighborEntitiesB.filter(Boolean).map(e => [e.id, e.type]));
    const neighborsB = rawNeighborsB.map(n => ({
      ...n,
      entityType: typeMapB.get(n.entityId) ?? 'unknown',
    }));

    // Enriched candidate for S6
    const enrichedCandidate = { ...candidateEntity, searchBlob: candidateIndexEntry.searchBlob ?? '' };

    // Co-access: count sessions where both entities were opened within 30 min of each other
    let coCount = 0;
    const accessesA = _accessWindow.filter(a => a.entityId === entityId);
    const accessesB = _accessWindow.filter(a => a.entityId === candidateEntity.id);
    for (const a of accessesA) {
      for (const b of accessesB) {
        if (Math.abs(a.ts - b.ts) < 1800000) { coCount++; break; }
      }
    }

    // Compute all 7 signals
    const signals = {
      s1: focalIndexEntry
        ? Signals.computeS1_textCosine(focalIndexEntry.vector, candidateIndexEntry.vector) : 0,
      s2: Signals.computeS2_sharedPerson(neighborsA, neighborsB),
      s3: Signals.computeS3_sharedProject(
        neighborsA, neighborsB,
        focalEntity.context ?? null,
        candidateEntity.context ?? null
      ),
      s4: Signals.computeS4_tagJaccard(
        focalEntity.tags    || [],
        candidateEntity.tags || [],
        _tagFrequencyMap,
        _totalEntityCount || 1
      ),
      s5: Signals.computeS5_temporalDecay(focalEntity.createdAt, candidateEntity.createdAt),
      s6: Signals.computeS6_urlDomain(enrichedFocal, enrichedCandidate),
      s7: Signals.computeS7_coAccess(coCount),
    };

    // Health and recency boosts
    const isHealth = HEALTH_TYPES.has(candidateEntity.type)
      || (candidateEntity.tags || []).some(t => HEALTH_TAGS.has(t));
    const isRecent = candidateEntity.createdAt
      ? (Date.now() - new Date(candidateEntity.createdAt).getTime()) < 172800000 // 48h
      : false;

    const score = Signals.computeComposite(signals, _learnedWeights, {
      health: isHealth, recency: isRecent,
    });

    if (score >= minScore) {
      computed.push({
        candidateId:    candidateEntity.id,
        candidateType:  candidateEntity.type,
        candidateTitle: candidateEntity.title || candidateEntity.name || '(untitled)',
        score,
        signals,
        status:     'suggested',
        reasonText: _buildReasonText(signals, focalEntity, candidateEntity),
      });
    }
  }

  // Sort descending, save top 20 to cache
  computed.sort((a, b) => b.score - a.score);
  const top20 = computed.slice(0, 20);

  await saveKlreSuggestions({
    entityId,
    suggestions: top20,
    updatedAt:   new Date().toISOString(),
  });

  return top20;
}

/**
 * Get confirmed (linked) items for an entity.
 * @private
 */
async function _getConfirmedItems(entityId) {
  try {
    const [outgoing, backlinks] = await Promise.all([
      getEdgesFrom(entityId),
      getBacklinks(entityId),
    ]);
    // Only show edges that were explicitly confirmed via KLRE (metadata.klre === true)
    // This prevents task→project or person assignment edges from appearing as "Linked"
    const confirmedIds = new Set([
      ...outgoing.filter(e => e.metadata?.klre === true).map(e => e.toId),
      ...backlinks.map(e => e.entityId),  // backlinks are always KLRE (only KLRE creates reverse)
    ]);
    const items = [];
    for (const cid of confirmedIds) {
      const ce = await getEntity(cid);
      if (!ce || ce.deleted) continue;
      items.push({
        candidateId:    cid,
        candidateType:  ce.type,
        candidateTitle: ce.title || ce.name || '(untitled)',
        score:      1.0,
        signals:    {},
        status:     'confirmed',
        reasonText: 'Linked',
      });
    }
    return items;
  } catch (e) {
    console.warn('[KLRE] _getConfirmedItems failed:', e);
    return [];
  }
}

/**
 * Build a human-readable reason string for a suggestion.
 * Uses the top 2 contributing signals.
 * @private
 */
function _buildReasonText(signals, entityA, entityB) {
  const candidates = [
    { key: 's1', val: signals.s1, text: 'Text match: shared keywords' },
    { key: 's2', val: signals.s2, text: 'Same person' },
    { key: 's3', val: signals.s3, text: 'Same project' },
    { key: 's4', val: signals.s4, text: (() => {
        const shared = (entityA.tags || []).filter(t => (entityB.tags || []).includes(t));
        return shared.length ? `Shared tags: ${shared.slice(0, 2).join(', ')}` : 'Shared tags';
      })()
    },
    { key: 's6', val: signals.s6, text: 'Matching web domain' },
    { key: 's7', val: signals.s7, text: `Co-accessed ${Math.round((signals.s7 || 0) * 5)} times` },
  ]
    .filter(c => (c.val || 0) > 0)
    .sort((a, b) => b.val - a.val);

  return candidates.slice(0, 2).map(c => c.text).join(' · ').slice(0, 60) || 'Related content';
}

// ── Public: confirm / dismiss ─────────────────────────────── //

/**
 * Confirm a KLRE suggestion — creates a real edge between entities.
 * Reads signals from cache BEFORE emitting so the learning loop can update weights.
 * @param {string} fromId
 * @param {string} toId
 */
export async function confirmSuggestion(fromId, toId) {
  // Read signals from cache BEFORE emitting (critical for weight learning)
  const cached  = await getKlreSuggestions(fromId);
  const match   = cached?.suggestions?.find(s => s.candidateId === toId);
  const signals = match?.signals || {};

  // Create confirmed edge (with creator info for audit trail)
  const _account = getAccount();
  await saveEdge({
    fromId, toId,
    relation: 'related to',
    metadata: { klre: true, confirmedAt: new Date().toISOString() },
  }, _account?.id);

  // Invalidate cache so the confirmed item moves to the Linked section on next load
  await saveKlreSuggestions({ entityId: fromId, suggestions: [], updatedAt: null });

  // Emit with signals payload so _onConfirm can update weights
  emit(EVENTS.KLRE_SUGGESTION_CONFIRMED, { fromId, toId, signals });
}

/**
 * Dismiss a KLRE suggestion — prevents it from showing again.
 * Reads signals from cache BEFORE emitting so learning loop can update weights.
 * @param {string} fromId
 * @param {string} toId
 */
export async function dismissSuggestion(fromId, toId) {
  // Read signals from cache BEFORE dismissing
  const cached  = await getKlreSuggestions(fromId);
  const match   = cached?.suggestions?.find(s => s.candidateId === toId);
  const signals = match?.signals || {};

  await setDismissed(fromId, toId);

  // Remove from cached list
  if (cached?.suggestions) {
    const updated = { ...cached, suggestions: cached.suggestions.filter(s => s.candidateId !== toId) };
    await saveKlreSuggestions(updated);
  }

  emit(EVENTS.KLRE_SUGGESTION_DISMISSED, { fromId, toId, signals });
}

// ── Private: learning loop ────────────────────────────────── //

/**
 * Update weights upward when a suggestion is confirmed.
 * Only updates weights for signals that actually contributed (score > 0).
 * @private
 */
function _onConfirm(fromId, toId, signals) {
  const keyMap = { s1: 'w1', s2: 'w2', s3: 'w3', s4: 'w4', s6: 'w6', s7: 'w7' };
  for (const [sKey, wKey] of Object.entries(keyMap)) {
    if ((signals[sKey] || 0) > 0) {
      _learnedWeights[wKey] = Math.min(1.4, (_learnedWeights[wKey] || 1) + 0.05);
    }
  }
  setSetting('klre_weights', _learnedWeights); // fire and forget
}

/**
 * Decrease weights when a suggestion is dismissed.
 * Only decrements weights for signals that contributed (score > 0).
 * @private
 */
function _onDismiss(fromId, toId, signals) {
  const keyMap = { s1: 'w1', s2: 'w2', s3: 'w3', s4: 'w4', s6: 'w6', s7: 'w7' };
  for (const [sKey, wKey] of Object.entries(keyMap)) {
    if ((signals[sKey] || 0) > 0) {
      _learnedWeights[wKey] = Math.max(0.6, (_learnedWeights[wKey] || 1) - 0.03);
    }
  }
  setSetting('klre_weights', _learnedWeights);
}

// ── Public: status / weights ──────────────────────────────── //

/**
 * Get the current KLRE index and weight status.
 * @returns {Object}
 */
export function getIndexStatus() {
  return {
    built:         _totalEntityCount > 0,
    entityCount:   _totalEntityCount,
    lastBuilt:     _lastBuiltAt,
    weightProfile: { ..._learnedWeights },
  };
}

/**
 * Get a copy of the current learned weights (not a reference).
 * @returns {Object}
 */
export function getLearnedWeights() {
  return { ..._learnedWeights };
}

/**
 * Reset all learned weights to defaults (all 1.0) and persist.
 */
export function resetLearnedWeights() {
  _learnedWeights = { w1: 1, w2: 1, w3: 1, w4: 1, w6: 1, w7: 1 };
  setSetting('klre_weights', _learnedWeights);
}
