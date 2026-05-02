/**
 * FamilyHub v4.2 — core/signals.js
 * Reactive signal system — signal, computed, effect, batch, peek.
 * Inspired by Solid.js / Preact Signals. Zero dependencies.
 *
 * Public API:
 *   signal(initialValue)     → { value (get/set), peek() }
 *   computed(fn)             → { value (read-only), peek() }
 *   effect(fn)               → cleanup function
 *   batch(fn)                → run fn, defer all notifications until done
 *   peek(signal)             → read value without tracking dependency
 *
 * Key design decisions:
 *   - Global tracking stack (not WeakMap) so computed/effect detect reads during execution
 *   - Lazy computed: value recomputes only when read after a dependency changes
 *   - Effects support cleanup: if fn returns a function, it's called before next re-run
 *   - batch() prevents redundant subscriber calls (one notify per signal per batch)
 */

// ══════════════════════════════════════════════════════════════
// Tracking Stack
// ══════════════════════════════════════════════════════════════

/** @type {(Set<Function>|null)[]} — stack of active subscriber sets being tracked */
const _trackingStack = [];

/** @type {boolean} — true while inside a batch() call */
let _batching = false;

/** @type {Set<Function>} — effects/computeds queued during a batch */
const _pendingNotifications = new Set();

// ══════════════════════════════════════════════════════════════
// signal()
// ══════════════════════════════════════════════════════════════

/**
 * Create a reactive signal.
 * Reading .value inside a computed() or effect() automatically tracks the dependency.
 * Setting .value notifies all subscribers synchronously (or deferred in batch).
 *
 * @template T
 * @param {T} initialValue
 * @returns {{ value: T, peek(): T }}
 *
 * @example
 * const count = signal(0);
 * effect(() => console.log(count.value));  // logs 0
 * count.value = 1;                          // logs 1
 */
export function signal(initialValue) {
  let _value = initialValue;
  /** @type {Set<Function>} */
  const _subscribers = new Set();

  const sig = {
    get value() {
      // Track this signal as a dependency of the current computed/effect
      _track(_subscribers);
      return _value;
    },
    set value(newValue) {
      if (Object.is(_value, newValue)) return; // no-op if same value
      _value = newValue;
      _notify(_subscribers);
    },
    /** Read the value without tracking (like peek()) */
    peek() {
      return _value;
    },
    /** For debugging */
    toString() {
      return String(_value);
    },
  };

  return sig;
}

// ══════════════════════════════════════════════════════════════
// computed()
// ══════════════════════════════════════════════════════════════

/**
 * Create a derived read-only signal whose value is computed from fn.
 * Recomputes lazily when any dependency changes.
 * Caches value between reads if no dependency has changed.
 *
 * @template T
 * @param {() => T} fn  — pure function that reads signals
 * @returns {{ value: T, peek(): T }}
 *
 * @example
 * const a = signal(2);
 * const b = signal(3);
 * const sum = computed(() => a.value + b.value);
 * console.log(sum.value); // 5
 * a.value = 10;
 * console.log(sum.value); // 13
 */
export function computed(fn) {
  let _cachedValue;
  let _dirty = true;
  const _subscribers = new Set();

  /** Re-run fn, tracking any signals read during execution */
  function _recompute() {
    // Track signals read during fn execution
    const ownDeps = new Set();
    _trackingStack.push(ownDeps);
    try {
      _cachedValue = fn();
    } finally {
      _trackingStack.pop();
    }

    // Subscribe to each dep so we know when to go dirty
    for (const depSubscribers of ownDeps) {
      depSubscribers.add(_invalidate);
    }

    _dirty = false;
  }

  /** Called when any dependency changes */
  function _invalidate() {
    if (!_dirty) {
      _dirty = true;
      _notify(_subscribers);
    }
  }

  // Initial computation to wire up dependencies
  _recompute();

  const comp = {
    get value() {
      if (_dirty) _recompute();
      _track(_subscribers);
      return _cachedValue;
    },
    peek() {
      if (_dirty) _recompute();
      return _cachedValue;
    },
    toString() {
      return String(this.value);
    },
  };

  return comp;
}

// ══════════════════════════════════════════════════════════════
// effect()
// ══════════════════════════════════════════════════════════════

/**
 * Run fn immediately, tracking all signal reads.
 * Re-runs fn whenever any tracked signal changes.
 * If fn returns a function, it's called as cleanup before the next re-run.
 *
 * @param {() => (void | (() => void))} fn
 * @returns {() => void}  cleanup — call to stop the effect permanently
 *
 * @example
 * const name = signal('Alice');
 * const stop = effect(() => {
 *   document.title = name.value;
 * });
 * name.value = 'Bob'; // document.title updates
 * stop();             // effect stops, title won't update again
 */
export function effect(fn) {
  let _cleanup = null;
  let _active = true;
  let _ownDeps = new Set();

  function _run() {
    if (!_active) return;

    // Call cleanup from previous run
    if (typeof _cleanup === 'function') {
      try { _cleanup(); } catch (e) { console.error('[effect] cleanup threw:', e); }
      _cleanup = null;
    }

    // Unsubscribe from old deps
    for (const depSubs of _ownDeps) {
      depSubs.delete(_run);
    }
    _ownDeps = new Set();

    // Run fn and collect new deps
    _trackingStack.push(_ownDeps);
    try {
      const result = fn();
      if (typeof result === 'function') _cleanup = result;
    } catch (e) {
      console.error('[effect] fn threw:', e);
    } finally {
      _trackingStack.pop();
    }

    // Subscribe to new deps
    for (const depSubs of _ownDeps) {
      depSubs.add(_run);
    }
  }

  // Initial run
  _run();

  // Return cleanup function
  return function stop() {
    _active = false;
    if (typeof _cleanup === 'function') {
      try { _cleanup(); } catch (e) { console.error('[effect] cleanup threw:', e); }
    }
    for (const depSubs of _ownDeps) {
      depSubs.delete(_run);
    }
    _ownDeps.clear();
  };
}

// ══════════════════════════════════════════════════════════════
// batch()
// ══════════════════════════════════════════════════════════════

/**
 * Run fn, deferring all subscriber notifications until fn completes.
 * Each subscriber fires at most once per batch, even if multiple signals changed.
 * Prevents redundant re-renders when updating multiple signals at once.
 *
 * @param {() => void} fn
 *
 * @example
 * const x = signal(1);
 * const y = signal(2);
 * effect(() => console.log(x.value, y.value)); // logs "1 2"
 * batch(() => {
 *   x.value = 10;
 *   y.value = 20;
 * }); // effect fires once, logs "10 20"
 */
export function batch(fn) {
  if (_batching) {
    // Already in a batch — just run
    fn();
    return;
  }

  _batching = true;
  try {
    fn();
  } finally {
    _batching = false;
    // Flush pending notifications — each subscriber runs once
    const toNotify = new Set(_pendingNotifications);
    _pendingNotifications.clear();
    for (const sub of toNotify) {
      try { sub(); } catch (e) { console.error('[batch] subscriber threw:', e); }
    }
  }
}

// ══════════════════════════════════════════════════════════════
// peek()
// ══════════════════════════════════════════════════════════════

/**
 * Read a signal's current value WITHOUT tracking it as a dependency.
 * Use inside effects/computeds when you need the value but don't
 * want re-runs when it changes.
 *
 * @template T
 * @param {{ value: T, peek(): T }} sig
 * @returns {T}
 *
 * @example
 * const count = signal(0);
 * const name  = signal('Alice');
 * effect(() => {
 *   // Only re-runs when name changes, not when count changes:
 *   console.log(name.value, peek(count));
 * });
 */
export function peek(sig) {
  return sig.peek();
}

// ══════════════════════════════════════════════════════════════
// Internal helpers
// ══════════════════════════════════════════════════════════════

/**
 * Add the current tracking context (top of stack) to the given subscriber set.
 * Called by signal.value getter and computed.value getter.
 * @param {Set<Function>} subscribers
 */
function _track(subscribers) {
  if (_trackingStack.length === 0) return;
  const context = _trackingStack[_trackingStack.length - 1];
  if (context) context.add(subscribers);
}

/**
 * Notify all subscribers of a signal or computed.
 * In batch mode, queues them for later. Otherwise runs immediately.
 * @param {Set<Function>} subscribers
 */
function _notify(subscribers) {
  if (_batching) {
    for (const sub of subscribers) _pendingNotifications.add(sub);
    return;
  }
  // Copy before iterating — subscribers may add/remove during notify
  for (const sub of [...subscribers]) {
    try { sub(); } catch (e) { console.error('[signal] subscriber threw:', e); }
  }
}
