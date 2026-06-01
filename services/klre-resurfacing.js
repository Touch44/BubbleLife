/**
 * services/klre-resurfacing.js
 * KLRE — Proactive resurfacing engine.
 * Computes items for the Knowledge Pulse widget and Daily Review context panel.
 * [v6.6.0]
 */

import { getAllEntityTypes } from '../core/graph-engine.js';
import { getEntitiesByType, getKlreSuggestions } from '../core/db.js';
// getSuggestions is only needed for getDailyContext (small N — 3-5 date-matching entities)
import { getSuggestions } from './klre-engine.js';

// ── In-memory pulse cache (S2: prevents O(N) scan on every dashboard render) ─ //
let _pulseCache   = null;   // {items: Array, builtAt: number}
const PULSE_TTL   = 300000; // 5 minutes

// ── Constants ─────────────────────────────────────────────── //
const RESURFACING_MIN_DAYS = 7;
const RESURFACING_MAX_DAYS = 30;
const PULSE_MAX            = 5;
const DAILY_CONTEXT_MAX    = 5;

// ── Private helpers ───────────────────────────────────────── //

/**
 * Days elapsed since an ISO timestamp.
 * Uses getTime() arithmetic — never toISOString().
 * @param {string|null} isoStr
 * @returns {number} float days, or Infinity if null/invalid
 */
function _daysSince(isoStr) {
  if (!isoStr) return Infinity;
  const t = new Date(isoStr).getTime();
  if (isNaN(t)) return Infinity;
  return (Date.now() - t) / 86400000;
}

/**
 * Compute a 'YYYY-MM-DD' date string for a date offset by N days.
 * Uses LOCAL time — never toISOString().
 * @param {Date} baseDate
 * @param {number} offsetDays
 * @returns {string}
 */
function _localDateStr(baseDate, offsetDays = 0) {
  const d = new Date(baseDate);
  d.setDate(d.getDate() + offsetDays);
  return (
    d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0')
  );
}

/**
 * Check if an entity's date fields match a YYYY-MM-DD string.
 * Each entity type uses different date field names (from codebase inspection):
 *   event/appointment: entity.date  (datetime field — compare date portion)
 *   task: entity.dueDate, entity.executionDate  (plain date fields)
 *   others: check entity.date, entity.startDate, entity.dueDate
 * @param {Object} entity
 * @param {string} dateStr - 'YYYY-MM-DD'
 * @returns {boolean}
 */
function _entityMatchesDate(entity, dateStr) {
  const fields = [
    entity.date,
    entity.dueDate,
    entity.executionDate,
    entity.startDate,
  ];
  return fields.some(f => f && String(f).startsWith(dateStr));
}

// ── Public: Knowledge Pulse items ─────────────────────────── //

/**
 * Compute items to surface in the Knowledge Pulse widget.
 * Uses cache-only reads (getKlreSuggestions) — no heavy compute.
 * @param {number} [maxItems=PULSE_MAX]
 * @returns {Promise<Array>}
 */
export async function getPulseItems(maxItems = PULSE_MAX) {
  // S2: Serve from in-memory cache if fresh (< 5 minutes)
  if (_pulseCache && (Date.now() - _pulseCache.builtAt) < PULSE_TTL) {
    return _pulseCache.items.slice(0, maxItems);
  }

  const typeKeys    = getAllEntityTypes().map(t => t.key);
  const allEntities = (
    await Promise.all(typeKeys.map(k => getEntitiesByType(k)))
  ).flat().filter(e => !e.deleted && !e._isSystemPost);

  const today    = new Date();
  const todayTs  = today.getTime();

  // Build the "recently active tags" set for TAG_ACTIVATED scoring
  const twoDaysAgo  = todayTs - 172800000;
  const recentTagSet = new Set(
    allEntities
      .filter(e => {
        const ts = new Date(e.updatedAt || e.createdAt).getTime();
        return !isNaN(ts) && ts > twoDaysAgo;
      })
      .flatMap(e => Array.isArray(e.tags) ? e.tags : [])
  );

  // S1/E5: Pre-load ALL suggestion caches in parallel before the loop.
  // Eliminates sequential IDB reads — turns O(N) sequential into one batch.
  const allSuggestionCaches = await Promise.all(allEntities.map(e => getKlreSuggestions(e.id)));
  const suggestionCacheMap  = new Map(allEntities.map((e, i) => [e.id, allSuggestionCaches[i]]));

  const scored = [];

  for (const entity of allEntities) {
    let pulseScore = 0;
    let pulseType  = null;

    // ── a) FORGOTTEN_RELEVANT ───────────────────────────────
    const daysSinceUpdate = _daysSince(entity.updatedAt || entity.createdAt);
    if (daysSinceUpdate >= RESURFACING_MIN_DAYS && daysSinceUpdate <= RESURFACING_MAX_DAYS) {
      // Use pre-loaded cache — no IDB read needed here
      const cached = suggestionCacheMap.get(entity.id);
      const hasRelevantSuggestion = cached?.suggestions?.some(s => s.score >= 0.20);
      if (hasRelevantSuggestion) {
        const score = 0.8 + (daysSinceUpdate - RESURFACING_MIN_DAYS) /
          (RESURFACING_MAX_DAYS - RESURFACING_MIN_DAYS) * 0.2;
        if (score > pulseScore) {
          pulseScore = score;
          pulseType  = 'FORGOTTEN_RELEVANT';
        }
      }
    }

    // ── b) DATE_ADJACENT ────────────────────────────────────
    // Check entity date fields against today and tomorrow (local dates)
    for (let offset = 0; offset <= 2; offset++) {
      const checkDate = _localDateStr(today, offset);
      if (_entityMatchesDate(entity, checkDate)) {
        if (0.9 > pulseScore) {
          pulseScore = 0.9;
          pulseType  = 'DATE_ADJACENT';
        }
        break;
      }
    }

    // ── c) TAG_ACTIVATED ────────────────────────────────────
    if (Array.isArray(entity.tags) && entity.tags.length > 0) {
      const hasRecentTag = entity.tags.some(t => recentTagSet.has(t));
      if (hasRecentTag && 0.6 > pulseScore) {
        pulseScore = 0.6;
        pulseType  = 'TAG_ACTIVATED';
      }
    }

    // ── d) STALE_TASK ───────────────────────────────────────
    // B02: Check both 'Completed' and 'Done' statuses (FamilyHub uses both)
    // B14: Use updatedAt for staleness check — an entity updated recently isn't stale
    if (
      entity.type === 'task' &&
      entity.status !== 'Completed' &&
      entity.status !== 'Done' &&
      _daysSince(entity.updatedAt || entity.createdAt) > 60
    ) {
      if (0.5 > pulseScore) {
        pulseScore = 0.5;
        pulseType  = 'STALE_TASK';
      }
    }

    if (pulseScore > 0 && pulseType) {
      const days   = Math.round(daysSinceUpdate);
      const matchedTag = Array.isArray(entity.tags) && entity.tags.find(t => recentTagSet.has(t));

      const reasonMap = {
        FORGOTTEN_RELEVANT: `Not seen in ${days} days · related to active content`,
        DATE_ADJACENT:      'Due soon · related to upcoming event',
        TAG_ACTIVATED:      matchedTag ? `Tag "${matchedTag}" matches recent activity` : 'Tag matches recent activity',
        STALE_TASK:         (() => { const d = _daysSince(entity.createdAt); return isFinite(d) ? `Created ${Math.round(d)} days ago · never completed` : 'Old incomplete task · never completed'; })(),
      };

      scored.push({
        entityId:   entity.id,
        entityType: entity.type,
        title:      entity.title || entity.name || '(untitled)',
        pulseScore,
        reason:     reasonMap[pulseType],
        pulseType,
      });
    }
  }

  scored.sort((a, b) => b.pulseScore - a.pulseScore);
  const result = scored.slice(0, maxItems);

  // S2: Cache the full sorted list for PULSE_TTL
  _pulseCache = { items: result, builtAt: Date.now() };

  return result;
}

/** Invalidate pulse cache — call when entities are saved */
export function invalidatePulseCache() {
  _pulseCache = null;
}

// ── Public: Daily context ─────────────────────────────────── //

/**
 * Get contextually relevant items for a specific day.
 * Finds entities with date fields on dateStr, then gets their KLRE suggestions.
 * @param {string} dateStr - 'YYYY-MM-DD' using LOCAL date arithmetic
 * @returns {Promise<Array>}
 */
export async function getDailyContext(dateStr) {
  if (!dateStr) return [];

  const typeKeys    = getAllEntityTypes().map(t => t.key);
  const allEntities = (
    await Promise.all(typeKeys.map(k => getEntitiesByType(k)))
  ).flat().filter(e => !e.deleted && !e._isSystemPost);

  // A) Find entities whose date fields match dateStr
  // event/appointment: entity.date; task: entity.dueDate/executionDate
  const dateMatchers = allEntities.filter(e => _entityMatchesDate(e, dateStr));
  if (!dateMatchers.length) return [];

  // S9: Process all triggers in parallel (small N — typically 1-5 date matchers)
  const triggerResults = await Promise.all(dateMatchers.map(async (trigger) => {
    let suggestions = null;
    const cached = await getKlreSuggestions(trigger.id);
    if (cached?.suggestions?.length > 0) {
      suggestions = cached.suggestions.slice(0, 5);
    } else {
      try {
        suggestions = await getSuggestions(trigger.id, { maxResults: 5 });
      } catch {
        suggestions = [];
      }
    }
    return { trigger, suggestions: suggestions || [] };
  }));

  const contextItems = [];
  const seenIds = new Set();

  for (const { trigger, suggestions } of triggerResults) {
    for (const s of suggestions) {
      const cid = s.candidateId;
      if (!cid || seenIds.has(cid) || cid === trigger.id) continue;
      seenIds.add(cid);
      contextItems.push({
        entityId:      cid,
        entityType:    s.candidateType,
        title:         s.candidateTitle,
        score:         s.score,
        triggerEntity: { id: trigger.id, title: trigger.title || trigger.name || '(untitled)', type: trigger.type },
        reason: `Related to: ${trigger.title || trigger.name || '(untitled)'}`,
      });
    }
  }

  // Sort by score, return top N
  contextItems.sort((a, b) => b.score - a.score);
  return contextItems.slice(0, DAILY_CONTEXT_MAX);
}
