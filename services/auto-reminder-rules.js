/**
 * FamilyHub v5.2.0 — services/auto-reminder-rules.js
 * [MAJOR] Phase 3: Auto-rules engine — fires reminders and actions automatically
 * when entity events match configured rules.
 *
 * Architecture:
 *   - Rules are 'rule' entities stored in IDB.
 *   - On ENTITY_SAVED / ENTITY_CREATED events, matching rules are evaluated.
 *   - Matching rules execute their configured action (currently: create:reminder).
 *   - Condition evaluation reuses condition-eval.js (same as reminder conditions).
 *   - Debounced per entity to prevent rapid multi-save flooding.
 *
 * Exports:
 *   initAutoRulesEngine()   — wire event listeners; call once from index.html
 *
 * Rule entity fields:
 *   name, triggerType, targetType, conditionJson, actionType, actionConfig,
 *   enabled, lastFiredAt, fireCount
 */

import { on, EVENTS }                              from '../core/events.js';
import { getEntitiesByType, getEntity,
         saveEntity }                           from '../core/db.js';
import { getAccount }                           from '../core/auth.js';
import { evaluateCondition }                    from './condition-eval.js';

// ── Constants ─────────────────────────────────────────────────── //

/** Minimum ms between rule evaluations for the same entity (debounce) */
const DEBOUNCE_MS = 2000;

/** Maximum rules processed per event to prevent runaway loops */
const MAX_RULES_PER_EVENT = 50;

// ── State ──────────────────────────────────────────────────────── //

/** Cache of enabled rules, refreshed on ENTITY_SAVED for type 'rule' */
let _ruleCache     = [];
let _cacheStale    = true;
let _initialized   = false;

/** Debounce map: entityId → lastEvaluatedAt */
const _debounce    = new Map();

// ── Rule cache ─────────────────────────────────────────────────── //

async function _loadRules() {
  try {
    const all = await getEntitiesByType('rule');
    _ruleCache = all.filter(r => !r.deleted && r.enabled !== false);
    _cacheStale = false;
    _firedOnce.clear(); // reset fired-once tracking when rules change
    console.log(`[auto-rules] loaded ${_ruleCache.length} rule(s)`);
  } catch (err) {
    console.error('[auto-rules] Failed to load rules:', err);
    _ruleCache = [];
  }
}

// ── Condition check ────────────────────────────────────────────── //

async function _checkConditions(rule, entity) {
  if (!rule.conditionJson) return true;   // no conditions → always match
  try {
    const condObj = typeof rule.conditionJson === 'string'
      ? JSON.parse(rule.conditionJson)
      : rule.conditionJson;
    return await evaluateCondition(condObj, entity, getAccount()?.id, getAccount()?.memberId);
  } catch (err) {
    console.warn('[auto-rules] Condition eval failed:', err);
    return false;
  }
}

// ── Target type matching ───────────────────────────────────────── //

function _matchesTarget(rule, entity) {
  if (!rule.targetType || rule.targetType === 'any') return true;
  return entity.type === rule.targetType;
}

// ── Trigger matching ───────────────────────────────────────────── //

/** Tracks entity+rule pairs that already fired this session (clears on rule cache reload) */
const _firedOnce = new Set();

function _matchesTrigger(rule, event) {
  switch (rule.triggerType) {
    case 'entity:saved':   return true;
    case 'entity:created': return event.isNew === true;
    case 'status:changed': return event.prevStatus !== undefined && event.prevStatus !== event.entity?.status;
    case 'due:overdue': {
      // Only fire once per entity+rule combo per session to avoid flood on every save
      const key = `${rule.id}:${event.entity?.id}`;
      if (_firedOnce.has(key)) return false;
      const overdue = _isOverdue(event.entity);
      if (overdue) _firedOnce.add(key);
      return overdue;
    }
    default: return false;
  }
}

function _isOverdue(entity) {
  if (!entity?.dueDate) return false;
  const dd = entity.dueDate;
  const ddStr = typeof dd === 'string' ? dd : (dd instanceof Date ? dd.toISOString() : String(dd));
  const due = new Date(ddStr.includes('T') ? ddStr : ddStr + 'T00:00:00');
  return !isNaN(due.getTime()) && due < new Date();
}

// ── Action execution ───────────────────────────────────────────── //

async function _executeAction(rule, entity) {
  const config = (() => {
    if (!rule.actionConfig) return {};
    try {
      return typeof rule.actionConfig === 'string'
        ? JSON.parse(rule.actionConfig)
        : rule.actionConfig;
    } catch { return {}; }
  })();

  switch (rule.actionType) {
    case 'create:reminder': {
      try {
        const { createReminder, getEntitiesByType: _getAll } = await import('./reminder.js');
        // Dedup: skip if an active reminder already exists for this entity+rule combination
        const existing = await _getAll('reminder').catch(() => []);
        const alreadyExists = existing.some(r =>
          !r.deleted && r.status === 'active' &&
          r.notes?.includes(`entity: ${entity.id}`) &&
          r.notes?.includes(`rule "${rule.name}"`)
        );
        if (alreadyExists) {
          console.debug(`[auto-rules] Skipping create:reminder — duplicate already exists for ${entity.id}`);
          break;
        }

        const offsetMs  = (config.offsetDays || 0) * 86400000 +
                          (config.offsetHours || 0) * 3600000 +
                          (config.offsetMins  || 0) * 60000;
        const now       = new Date();
        const fireDate  = new Date(now.getTime() + (offsetMs || 3600000)); // default: 1h
        const p2        = n => String(n).padStart(2, '0');
        const fireAt    = `${fireDate.getFullYear()}-${p2(fireDate.getMonth()+1)}-${p2(fireDate.getDate())}` +
                          `T${p2(fireDate.getHours())}:${p2(fireDate.getMinutes())}:00`;

        const reminderTitle = config.title
          ? config.title.replace('{{entity.title}}', entity.title || entity.name || '')
          : `⚙️ Rule: ${rule.name || 'Auto-reminder'} — ${entity.title || entity.name || entity.type}`;

        await createReminder({
          title:      reminderTitle,
          fireAt,
          nextFireAt: fireAt,
          status:     'active',
          priority:   config.priority || 'Normal',
          notes:      `Auto-created by rule "${rule.name}" (entity: ${entity.id})`,
        }, entity.id);

        console.log(`[auto-rules] Created reminder for rule "${rule.name}" on entity ${entity.id}`);
      } catch (err) {
        console.error('[auto-rules] create:reminder action failed:', err);
      }
      break;
    }

    case 'set:status': {
      if (!config.status) break;
      try {
        const fresh = await getEntity(entity.id);
        // Only save if status would actually change — prevents self-triggering loops
        if (fresh && fresh.status !== config.status) {
          // Mark entity as rule-modified to allow the auto-rules engine to skip it
          await saveEntity({ ...fresh, status: config.status, _ruleModified: rule.id }, getAccount()?.id);
          console.log(`[auto-rules] Set status of ${entity.id} → "${config.status}"`);
        }
      } catch (err) {
        console.error('[auto-rules] set:status action failed:', err);
      }
      break;
    }

    case 'notify': {
      try {
        if (Notification.permission === 'granted') {
          new Notification(rule.name || 'FamilyHub Rule', {
            body: `Rule triggered on: ${entity.title || entity.name || entity.type}`,
            icon: '/icons/icon-192.png',
            tag:  `rule-${rule.id}-${entity.id}`,
          });
        }
      } catch (err) {
        console.warn('[auto-rules] notify action failed:', err);
      }
      break;
    }

    default:
      console.warn('[auto-rules] Unknown actionType:', rule.actionType);
  }
}

// ── Core evaluation ────────────────────────────────────────────── //

async function _evaluateRules(event) {
  const entity = event.entity;
  if (!entity?.id || !entity?.type) return;
  // Skip internal types and entities just modified by a rule (prevents loops)
  const SKIP_RULE_TYPES = new Set(['rule', 'reminderLog', 'reminder', 'activityLog', 'post', 'comment']);
  if (SKIP_RULE_TYPES.has(entity.type)) return;
  if (entity._ruleModified) return; // set:status action marks entities to prevent re-triggering

  // Debounce: skip if this entity was just evaluated
  const now = Date.now();
  const last = _debounce.get(entity.id);
  if (last && now - last < DEBOUNCE_MS) return;
  _debounce.set(entity.id, now);

  // Prune stale debounce entries (> 30s old) to prevent unbounded map growth
  if (_debounce.size > 500) {
    for (const [id, ts] of _debounce) {
      if (now - ts > 30000) _debounce.delete(id);
    }
  }

  if (_cacheStale) await _loadRules();
  if (!_ruleCache.length) return;

  // Collect all matching rules first, then execute in parallel for speed
  const matchingRules = [];
  for (const rule of _ruleCache) {
    if (matchingRules.length >= MAX_RULES_PER_EVENT) break;
    if (!_matchesTarget(rule, entity))  continue;
    if (!rule.actionType)               continue;
    if (!_matchesTrigger(rule, event))  continue;
    const condMatch = await _checkConditions(rule, entity);
    if (!condMatch) continue;
    matchingRules.push(rule);
    console.debug(`[auto-rules] Rule "${rule.name}" matched entity ${entity.id} (${entity.type})`);
  }

  if (!matchingRules.length) return;

  // Execute all matching rule actions in parallel
  await Promise.all(matchingRules.map(async rule => {
    await _executeAction(rule, entity);
    // Update rule stats (non-fatal)
    try {
      const fresh = await getEntity(rule.id);
      if (fresh) {
        const localNow = new Date();
        const p2 = n => String(n).padStart(2,'0');
        const localISO = `${localNow.getFullYear()}-${p2(localNow.getMonth()+1)}-${p2(localNow.getDate())}T${p2(localNow.getHours())}:${p2(localNow.getMinutes())}:${p2(localNow.getSeconds())}`;
        await saveEntity({ ...fresh, lastFiredAt: localISO, fireCount: (fresh.fireCount||0)+1 }, getAccount()?.id);
      }
    } catch {}
  }));
}

// ── Public API ─────────────────────────────────────────────────── //

/**
 * Initialize the auto-rules engine.
 * Call once from index.html after IDB and graph-engine are ready.
 */
export function initAutoRulesEngine() {
  if (_initialized) return;
  _initialized = true;

  // Evaluate rules on every entity save
  on(EVENTS.ENTITY_SAVED, (event) => {
    // Invalidate cache when a rule itself is saved
    if (event.entity?.type === 'rule') { _cacheStale = true; return; }
    // Evaluate rules asynchronously — non-blocking
    _evaluateRules(event).catch(err => console.error('[auto-rules] Evaluation error:', err));
  });

  // Load rules eagerly on init (warm cache)
  _loadRules().catch(err => console.warn('[auto-rules] Initial rule load failed:', err));

  console.log('[auto-rules] Auto-rules engine initialized');
}

/** Manually refresh the rule cache (e.g. after bulk import) */
export function invalidateRuleCache() {
  _cacheStale = true;
}

/** Get current loaded rules (for debugging / analytics) */
export function getLoadedRules() {
  return [..._ruleCache];
}
