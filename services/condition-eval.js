/**
 * FamilyHub v5.0.0 — services/condition-eval.js
 * Async rule-tree condition evaluator.
 *
 * IMPORTANT: This function is ASYNC — the 'includes' operator calls getEdgesFrom()
 * which is an async IDB operation. Always await in scheduler tick.
 *
 * conditionJson in IDB is always a JSON string — pass string or parsed object, both handled.
 *
 * Public API:
 *   evaluateCondition(condition, entity, accountId) → Promise<boolean>
 */

import { getEdgesFrom } from '../core/db.js';

/**
 * Evaluate a condition rule tree against an entity.
 * @param {object|string} condition
 * @param {object}        entity
 * @param {string}        accountId   - account.id (for audit/logging)
 * @param {string}        [memberId]  - H-07 fix: person entity ID for 'me' resolution
 *                                      Defaults to accountId if not provided (fallback only)
 */
export async function evaluateCondition(condition, entity, accountId, memberId) {
  if (!condition) return true;
  const rule = typeof condition === 'string' ? _safeParse(condition) : condition;
  if (!rule) return true;
  // H-07 fix: pass memberId (person entity ID) for 'me' resolution in 'includes' operator
  return _eval(rule, entity, memberId || accountId);
}

function _safeParse(str) {
  try { return JSON.parse(str); }
  catch { console.warn('[condition-eval] Failed to parse:', str); return null; }
}

async function _eval(rule, entity, accountId) {
  if (!rule || typeof rule !== 'object') return true;
  const { op } = rule;

  if (op === 'and') {
    for (const c of (rule.conditions || [])) {
      if (!(await _eval(c, entity, accountId))) return false;
    }
    return true;
  }
  if (op === 'or') {
    for (const c of (rule.conditions || [])) {
      if (await _eval(c, entity, accountId)) return true;
    }
    return false;
  }
  if (op === 'not') {
    const c = rule.condition || rule.conditions?.[0];
    return c ? !(await _eval(c, entity, accountId)) : true;
  }

  const { field, value } = rule;
  const raw = entity?.[field];

  switch (op) {
    case 'equals':       return _loose(raw) === _loose(value);
    case 'not_equals':   return _loose(raw) !== _loose(value);
    case 'contains':     return String(raw ?? '').toLowerCase().includes(String(value ?? '').toLowerCase());
    case 'not_contains': return !String(raw ?? '').toLowerCase().includes(String(value ?? '').toLowerCase());
    case 'greater_than': return Number(raw) > Number(value);
    case 'less_than':    return Number(raw) < Number(value);
    case 'is_empty':     return raw == null || raw === '' || (Array.isArray(raw) && !raw.length);
    case 'is_not_empty': return raw != null && raw !== '' && !(Array.isArray(raw) && !raw.length);
    case 'before':       return raw ? _date(raw) < _date(value) : false;
    case 'after':        return raw ? _date(raw) > _date(value) : false;
    case 'within_days': {
      if (!raw) return false;
      const days  = Number(value) || 0;
      const now   = new Date();
      const limit = new Date(now.getTime() + days * 86400000);
      const d     = _date(raw);
      return d >= now && d <= limit;
    }
    case 'is_overdue': {
      if (!raw) return false;
      const done = new Set(['done','Done','Completed','completed']);
      if (done.has(entity?.status ?? '')) return false;
      return _date(raw) < new Date();
    }
    case 'includes': {
      // 'me' resolves to accountId; checks relation edges via IDB
      const resolved = value === 'me' ? accountId : value;
      if (!resolved || !entity?.id) return false;
      try {
        const edges = await getEdgesFrom(entity.id, field);
        return edges.some(e => e.toId === resolved);
      } catch { return false; }
    }
    case 'ref': {
      // Cross-field comparison
      return _loose(raw) === _loose(entity?.[value]);
    }
    default:
      console.warn('[condition-eval] Unknown operator:', op);
      return true;
  }
}

function _loose(v) { return v == null ? '' : String(v).trim().toLowerCase(); }
function _date(v) {
  if (!v) return new Date(NaN);
  const s = String(v);
  return new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T00:00:00' : s);
}
