/**
 * FamilyHub v3.0 — core/utils.js
 * Pure utility functions. No dependencies on other FamilyHub modules.
 * Used by command palette, search, data service, and views.
 *
 * Public API:
 *   memoize(fn)
 *   fuzzyMatch(query, target) → score 0–1
 *   groupBy(array, keyFn) → Map<key, item[]>
 *   debounce(fn, ms) → debounced fn
 *   formatDate(dateStr, style?) → string
 *   parseLocalDate(dateStr) → Date (local time, no UTC shift)
 *   generateId() → string
 */

// ── memoize ───────────────────────────────────────────────── //

/**
 * Returns a memoized version of fn.
 * Cache is keyed on JSON.stringify of arguments.
 * Suitable for pure functions with JSON-serializable args.
 * @template T
 * @param {(...args: any[]) => T} fn
 * @returns {(...args: any[]) => T}
 */
export function memoize(fn) {
  const cache = new Map();
  return function (...args) {
    const key = JSON.stringify(args);
    if (cache.has(key)) return cache.get(key);
    const result = fn.apply(this, args);
    cache.set(key, result);
    return result;
  };
}

// ── fuzzyMatch ────────────────────────────────────────────── //

/**
 * Fuzzy match score between query and target strings.
 * Returns a score from 0 (no match) to 1 (perfect match).
 * Consecutive character matches score higher.
 * Case-insensitive.
 *
 * @param {string} query
 * @param {string} target
 * @returns {number} 0–1
 */
export function fuzzyMatch(query, target) {
  if (!query || !target) return 0;

  const q = query.toLowerCase();
  const t = target.toLowerCase();

  // Exact match = perfect score
  if (t === q) return 1;

  // Contains match = high score
  if (t.includes(q)) return 0.9 - (t.indexOf(q) / t.length) * 0.1;

  // Character-by-character fuzzy
  let qi = 0;
  let consecutiveBonus = 0;
  let score = 0;
  let lastMatchIdx = -1;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      // Consecutive match gets a bonus
      if (lastMatchIdx === ti - 1) {
        consecutiveBonus += 0.05;
      } else {
        consecutiveBonus = 0;
      }
      score += (1 + consecutiveBonus) / t.length;
      lastMatchIdx = ti;
      qi++;
    }
  }

  // All query chars must match
  if (qi < q.length) return 0;

  return Math.min(score, 0.85); // cap below contains-match score
}

// ── groupBy ───────────────────────────────────────────────── //

/**
 * Groups array items into a Map by the result of keyFn.
 * Items with the same key are collected in order.
 *
 * @template T
 * @param {T[]} array
 * @param {(item: T) => string} keyFn
 * @returns {Map<string, T[]>}
 */
export function groupBy(array, keyFn) {
  const map = new Map();
  for (const item of array) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

// ── debounce ──────────────────────────────────────────────── //

/**
 * Returns a debounced version of fn.
 * fn is called only after ms milliseconds of inactivity.
 *
 * @param {Function} fn
 * @param {number} ms
 * @returns {Function}
 */
export function debounce(fn, ms) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, ms);
  };
}

// ── throttle ──────────────────────────────────────────────── //

/**
 * Leading-edge throttle: fn fires immediately on first call,
 * then is suppressed for ms milliseconds.
 *
 * @param {Function} fn
 * @param {number} ms
 * @returns {Function}
 */
export function throttle(fn, ms) {
  let lastCall = 0;
  let timer = null;
  return function (...args) {
    const now = Date.now();
    const remaining = ms - (now - lastCall);
    if (remaining <= 0) {
      if (timer) { clearTimeout(timer); timer = null; }
      lastCall = now;
      fn.apply(this, args);
    } else if (!timer) {
      timer = setTimeout(() => {
        lastCall = Date.now();
        timer = null;
        fn.apply(this, args);
      }, remaining);
    }
  };
}

// ── sortBy ────────────────────────────────────────────────── //

/**
 * Stable sort array by a key function.
 * Does not mutate the original array — returns a new sorted array.
 *
 * @template T
 * @param {T[]} arr
 * @param {(item: T) => any} keyFn — value to sort by (string, number, etc.)
 * @param {'asc'|'desc'} [dir='asc']
 * @returns {T[]}
 *
 * @example
 * sortBy(tasks, t => t.dueDate, 'asc')
 * sortBy(people, p => p.name.toLowerCase())
 */
export function sortBy(arr, keyFn, dir = 'asc') {
  const sign = dir === 'desc' ? -1 : 1;
  return [...arr].sort((a, b) => {
    const ka = keyFn(a);
    const kb = keyFn(b);
    if (ka < kb) return -sign;
    if (ka > kb) return  sign;
    return 0;
  });
}

// ── formatDate ────────────────────────────────────────────── //

/**
 * Format a YYYY-MM-DD string for display.
 * Parses as local time (no UTC shift) via parseLocalDate().
 *
 * @param {string} dateStr  — YYYY-MM-DD
 * @param {'short'|'long'|'relative'} [style='short']
 * @returns {string}
 *
 * style='short'    → "Apr 26"
 * style='long'     → "Sunday, April 26, 2026"
 * style='relative' → "Today" | "Yesterday" | "Tomorrow" | "In 3 days" | "3 days ago" | falls back to short
 */
export function formatDate(dateStr, style = 'short') {
  if (!dateStr) return '';

  const date = parseLocalDate(dateStr);
  if (isNaN(date.getTime())) return dateStr;

  if (style === 'relative') {
    const today = _todayLocal();
    const diffMs = date.getTime() - today.getTime();
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0)  return 'Today';
    if (diffDays === -1) return 'Yesterday';
    if (diffDays === 1)  return 'Tomorrow';
    if (diffDays > 1 && diffDays <= 7)  return `In ${diffDays} days`;
    if (diffDays < -1 && diffDays >= -7) return `${Math.abs(diffDays)} days ago`;
    // Fall through to short for dates further away
    return formatDate(dateStr, 'short');
  }

  if (style === 'long') {
    return date.toLocaleDateString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }

  // short (default)
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Returns a Date at midnight local time for today.
 * @returns {Date}
 */
function _todayLocal() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

// ── parseLocalDate ────────────────────────────────────────── //

/**
 * Parse a YYYY-MM-DD string as LOCAL midnight — not UTC.
 * Using `new Date('2026-04-26')` interprets as UTC midnight, which
 * shifts the date back one day in UTC-negative timezones (e.g. US/Pacific).
 * This function prevents that bug.
 *
 * @param {string} dateStr  — YYYY-MM-DD
 * @returns {Date}
 */
export function parseLocalDate(dateStr) {
  if (!dateStr) return new Date(NaN);
  const parts = dateStr.split('-');
  if (parts.length !== 3) return new Date(NaN);
  const [y, m, d] = parts.map(Number);
  if (isNaN(y) || isNaN(m) || isNaN(d)) return new Date(NaN);
  // Month is 0-indexed in Date constructor
  return new Date(y, m - 1, d);
}

// ── generateId ────────────────────────────────────────────── //

/**
 * Generate a collision-resistant unique ID.
 * Uses crypto.randomUUID() when available (all modern browsers),
 * falls back to timestamp + random hex.
 *
 * @returns {string}
 */
export function generateId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback: base36 timestamp + random hex
  const ts  = Date.now().toString(36);
  const rnd = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `${ts}-${rnd}`;
}
