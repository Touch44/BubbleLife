/**
 * FamilyHub v3 — core/context.js
 * [MAJOR] CS-01 — Global Context State
 *
 * Manages the active context (Family / Personal / Business / All).
 * Persists to localStorage. Emits 'context:changed' when switched.
 * filterByContext() is the central gatekeeper for all view data loading.
 *
 * Imports only from events.js and auth.js — no circular deps.
 */

import { emit } from './events.js';
import { getAccount } from './auth.js';

// ── Constants ──────────────────────────────────────────────────
/** @readonly */
export const CONTEXTS = Object.freeze({
  ALL:      'all',
  FAMILY:   'family',
  PERSONAL: 'personal',
  BUSINESS: 'business',
});

/** Entity types that are NEVER filtered — always visible regardless of context */
export const ALWAYS_SHARED_TYPES = new Set(['person', 'dailyReview', 'place', 'tag', 'activity']);

/** Entity types that ONLY appear in family context */
export const FAMILY_ONLY_TYPES = new Set(['recipe', 'mealPlan', 'shoppingItem']);
// post/comment removed: entity.context field now controls their visibility.

/** Entity types that ONLY appear in personal context (and only to their creator) */
export const ALWAYS_PERSONAL_TYPES = new Set(['medication']);

/** Context accent colours — applied as CSS --color-accent */
const CONTEXT_COLORS = Object.freeze({
  all:      '#0a7b6c',
  family:   '#0891b2',
  personal: '#7c3aed',
  business: '#b45309',
});

const STORAGE_KEY = 'fh_active_context';
const VALID_CONTEXTS = new Set(Object.values(CONTEXTS));

// ── Module state ───────────────────────────────────────────────
let _activeContext = CONTEXTS.ALL;

// ── Public API ─────────────────────────────────────────────────

/**
 * Returns the current active context key.
 * @returns {'all'|'family'|'personal'|'business'}
 */
export function getActiveContext() {
  return _activeContext;
}

/**
 * Set the active context.
 * Validates input, persists to localStorage, updates CSS accent, emits event.
 * @param {'all'|'family'|'personal'|'business'} ctx
 */
export function setActiveContext(ctx) {
  if (!VALID_CONTEXTS.has(ctx)) {
    console.warn(`[context] Invalid context "${ctx}", ignoring.`);
    return;
  }
  _activeContext = ctx;

  // Persist
  try {
    localStorage.setItem(STORAGE_KEY, ctx);
  } catch (e) {
    console.warn('[context] localStorage write failed:', e);
  }

  // Update CSS accent colour
  const color = CONTEXT_COLORS[ctx] || CONTEXT_COLORS.all;
  document.documentElement.style.setProperty('--color-accent', color);

  // Emit event — views listen at module level and re-render
  emit('context:changed', { context: ctx });
}

/**
 * Filter an array of entities according to the active context.
 * This is the single gatekeeper — called in every view's _loadData().
 *
 * Rules:
 *  1. 'all' mode → return everything (no filter)
 *  2. ALWAYS_SHARED_TYPES → always pass through
 *  3. FAMILY_ONLY_TYPES → only visible when active context is 'family'
 *  4. ALWAYS_PERSONAL_TYPES → only visible when context is 'personal' AND entity belongs to current user
 *  5. Personal entities (entity.context === 'personal') → only visible to their creator
 *  6. Cross-context entities (entity.context === 'all') → always visible
 *  7. Legacy entities (no context field) → default to 'family'
 *  8. Normal match: entity.context === activeContext
 *
 * @param {Array} entities
 * @param {string} [overrideContext] — optional context override (used by daily view chips)
 * @returns {Array} filtered entities
 */
export function filterByContext(entities, overrideContext) {
  if (!Array.isArray(entities)) return [];

  const ctx = overrideContext || _activeContext;

  // 'all' mode — return everything, but still enforce personal privacy
  if (ctx === CONTEXTS.ALL) {
    const account = getAccount();
    const accountId = account?.id;
    return entities.filter(e => {
      // Personal entities are private to their creator even in 'all' mode
      if (e.context === 'personal' && e.createdBy && e.createdBy !== accountId) {
        return false;
      }
      return true;
    });
  }

  const account = getAccount();
  const accountId = account?.id;

  return entities.filter(e => {
    const entityType = e.type || '';  // B6: guard against undefined type

    // Rule 2: Always-shared types pass through unconditionally
    if (ALWAYS_SHARED_TYPES.has(entityType)) {
      return true;
    }

    // Rule 3: Family-only types only visible in family context
    if (FAMILY_ONLY_TYPES.has(entityType)) {
      return ctx === CONTEXTS.FAMILY;
    }

    // Rule 4: Always-personal types only in personal context, only to creator
    if (ALWAYS_PERSONAL_TYPES.has(entityType)) {
      return ctx === CONTEXTS.PERSONAL && e.createdBy === accountId;
    }

    // Determine the entity's context (default legacy entities to 'family')
    const entityCtx = e.context || 'family';

    // Rule 5: Personal entities only visible to creator
    if (entityCtx === 'personal') {
      return ctx === CONTEXTS.PERSONAL && e.createdBy === accountId;
    }

    // Rule 6: Cross-context entities (entity.context === 'all') always visible
    if (entityCtx === 'all') {
      return true;
    }

    // Rule 8: Normal match
    return entityCtx === ctx;
  });
}

/**
 * Initialise context from localStorage.
 * Call once in initApp(), AFTER initAuth().
 */
export function initContext() {
  let stored = CONTEXTS.ALL;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && VALID_CONTEXTS.has(raw)) {
      stored = raw;
    }
  } catch (e) {
    console.warn('[context] localStorage read failed:', e);
  }

  // Apply without emitting — views haven't mounted their listeners yet
  _activeContext = stored;
  const color = CONTEXT_COLORS[stored] || CONTEXT_COLORS.all;
  document.documentElement.style.setProperty('--color-accent', color);

  console.log(`[context] Initialised: ${stored}`);
}
