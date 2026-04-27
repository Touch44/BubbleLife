/**
 * FamilyHub v3.0 — services/hotkey.js
 * HotkeyService — scoped, normalized keyboard shortcut management.
 *
 * Shortcut format: 'ctrl+k', 'cmd+z', 'escape', 'n', 'alt+1'
 *   - 'cmd' and 'ctrl' are treated identically (normalized for Mac/Win)
 *   - 'shift' is a modifier
 *   - bare letter = no modifier required (checked only outside text fields)
 *
 * Scope:
 *   'global'   — fires regardless of current view (default)
 *   '<viewKey>' — only fires when that view is active
 *
 * Public API (service instance):
 *   add(shortcut, handler, options?)   — register a shortcut
 *   remove(shortcut, scope?)           — deregister
 *   getAll()                           — all registered shortcuts (debug)
 *
 * Wire-in: buildEnv() starts this service; it attaches a single
 * document keydown listener and routes to the correct handler.
 */

// getState is accessed via dynamic import below (avoids window dep at module load)

/** @typedef {{ handler: Function, scope: string, allowRepeat: boolean, description?: string }} HotkeyEntry */

/** @type {Map<string, HotkeyEntry[]>} normalized-shortcut → entries */
const _registry = new Map();

/** Whether the global listener is attached */
let _listening = false;

/** Cached current view key — updated by events to avoid synchronous router import */
let _currentView = '';

// ── Normalization ─────────────────────────────────────────── //

/**
 * Normalize a shortcut string to a canonical key.
 * 'Cmd+K', 'ctrl+k', 'CTRL+K' → 'ctrl+k'
 * 'Escape', 'escape', 'ESC' → 'escape'
 * @param {string} shortcut
 * @returns {string}
 */
function _normalize(shortcut) {
  return shortcut
    .toLowerCase()
    .replace(/\bcmd\b/g, 'ctrl')   // Mac Cmd → ctrl
    .replace(/\bmeta\b/g, 'ctrl')  // Meta → ctrl
    .split('+')
    .map(s => s.trim())
    .sort((a, b) => {
      // Sort modifiers before key: ctrl, shift, alt < key
      const order = { ctrl: 0, shift: 1, alt: 2 };
      const ao = order[a] ?? 3;
      const bo = order[b] ?? 3;
      return ao - bo;
    })
    .join('+');
}

/**
 * Derive the canonical shortcut string from a KeyboardEvent.
 * @param {KeyboardEvent} e
 * @returns {string}
 */
function _eventKey(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey)   parts.push('alt');

  const key = (e.key ?? '').toLowerCase();
  if (!key) return '';  // ignore events with no key (media keys, synthetic events)
  // Normalize common aliases
  const aliases = {
    ' ': 'space', 'esc': 'escape',
    'arrowup': 'up', 'arrowdown': 'down',
    'arrowleft': 'left', 'arrowright': 'right',
  };
  parts.push(aliases[key] ?? key);

  return parts.sort((a, b) => {
    const order = { ctrl: 0, shift: 1, alt: 2 };
    return (order[a] ?? 3) - (order[b] ?? 3);
  }).join('+');
}

// ── Global keydown handler ────────────────────────────────── //

function _onKeydown(e) {
  // BUG-A fix: never fire shortcuts when auth screen is visible (#app hidden)
  const appEl = document.getElementById('app');
  if (appEl && appEl.getAttribute('aria-hidden') === 'true') return;

  // Never fire on repeat unless handler allows it
  const normalized = _eventKey(e);
  if (!normalized) return;  // no key (media key, synthetic event)
  const entries    = _registry.get(normalized);
  if (!entries?.length) return;

  const inTextField = e.target.matches('input, textarea, [contenteditable="true"], select');
  // Use cached state — updated by VIEW_CHANGED event subscription
  const currentViewKey = _currentView;

  for (const entry of entries) {
    // Scope check
    if (entry.scope !== 'global' && entry.scope !== currentViewKey) continue;

    // Repeat check
    if (e.repeat && !entry.allowRepeat) continue;

    // Bare letter shortcuts (no modifiers) must not fire inside text fields
    const hasMod = normalized.includes('ctrl') || normalized.includes('alt');
    if (!hasMod && inTextField) continue;

    e.preventDefault();
    try {
      entry.handler(e);
    } catch (err) {
      console.error(`[hotkey] Handler error for "${normalized}":`, err);
    }
    // First matching scoped handler wins; global handler still fires
    // (intentional: scope-specific handlers take priority but global still runs)
  }
}

// ── Service factory ───────────────────────────────────────── //

/**
 * Create the hotkey service.
 * @param {object} env
 * @returns {object}
 */
export function createHotkeyService(env) {

  /**
   * Register a keyboard shortcut.
   * @param {string}   shortcut           — e.g. 'ctrl+k', 'escape', 'n'
   * @param {Function} handler            — called with the KeyboardEvent
   * @param {object}   [options]
   * @param {string}   [options.scope='global']
   * @param {boolean}  [options.allowRepeat=false]
   * @param {string}   [options.description]
   */
  function add(shortcut, handler, options = {}) {
    if (!shortcut || typeof handler !== 'function') {
      throw new Error('[hotkey] shortcut and handler are required');
    }

    const key   = _normalize(shortcut);
    const entry = {
      handler,
      scope:       options.scope       ?? 'global',
      allowRepeat: options.allowRepeat ?? false,
      description: options.description ?? '',
    };

    if (!_registry.has(key)) _registry.set(key, []);
    _registry.get(key).push(entry);
  }

  /**
   * Remove a registered shortcut.
   * If scope is provided, only removes handlers for that scope.
   * If no scope, removes ALL handlers for the shortcut.
   * @param {string} shortcut
   * @param {string} [scope]
   */
  function remove(shortcut, scope) {
    const key = _normalize(shortcut);
    if (!_registry.has(key)) return;

    if (!scope) {
      _registry.delete(key);
      return;
    }

    const filtered = _registry.get(key).filter(e => e.scope !== scope);
    if (filtered.length === 0) {
      _registry.delete(key);
    } else {
      _registry.set(key, filtered);
    }
  }

  /**
   * Get all registered shortcuts (for debugging / display).
   * @returns {{ shortcut: string, scope: string, description: string }[]}
   */
  function getAll() {
    const result = [];
    for (const [shortcut, entries] of _registry) {
      for (const entry of entries) {
        result.push({ shortcut, scope: entry.scope, description: entry.description });
      }
    }
    return result;
  }

  // ── Track current view for scope checking ──────────────── //
  // Listen for VIEW_CHANGED events to keep _currentView in sync
  import('../core/events.js').then(({ on, EVENTS }) => {
    on(EVENTS.VIEW_CHANGED, ({ viewKey } = {}) => {
      _currentView = viewKey || '';
    });
  }).catch(() => {});

  // Pre-import heavy modules to eliminate async delay on first keypress (BUG-E fix)
  const _searchModule = import('../components/search.js').catch(() => ({ openSearch(){}, closeSearch(){} }));
  const _panelModule  = import('../components/entity-panel.js').catch(() => ({ closePanel(){} }));

  // ── Attach global listener ────────────────────────────── //
  if (!_listening) {
    document.addEventListener('keydown', _onKeydown);
    _listening = true;
  }

  // ── Seed built-in shortcuts ──────────────────────────── //
  _seedBuiltins(add, env, _searchModule, _panelModule);

  return { add, remove, getAll };
}

/**
 * Wire built-in shortcuts.
 * These replace the hardcoded keydown handler in index.html.
 * index.html can keep its Cmd+Z handler for undo (it runs before hotkey service).
 */
function _seedBuiltins(add, env, _searchModule, _panelModule) {

  // ⌘K — open search/command palette (BUG-B fix: use openSearch() not raw DOM)
  add('ctrl+k', (e) => {
    e.preventDefault();
    // Use search.js exported openSearch/closeSearch for correct state management
    _searchModule.then(({ openSearch, closeSearch }) => {
      const overlay = document.getElementById('search-overlay');
      if (overlay?.classList.contains('open')) {
        closeSearch();
      } else {
        openSearch();
      }
    });
  }, { description: 'Open command palette' });

  // Escape — close any open overlay
  add('escape', () => {
    // Search overlay — use closeSearch() to reset internal state properly
    const searchOverlay = document.getElementById('search-overlay');
    if (searchOverlay?.classList.contains('open')) {
      _searchModule.then(({ closeSearch }) => closeSearch());
      return;
    }
    // Shortcuts overlay
    const shortcutsOverlay = document.getElementById('shortcuts-overlay');
    if (shortcutsOverlay?.classList.contains('open')) {
      shortcutsOverlay.classList.remove('open');
      shortcutsOverlay.setAttribute('aria-hidden', 'true');
      shortcutsOverlay.setAttribute('inert', '');
      return;
    }
    // Entity panel — use closePanel() from module
    _panelModule.then(({ closePanel }) => closePanel());
  }, { description: 'Close open overlay or panel' });

  // Navigation shortcuts (bare letters — won't fire inside text fields)
  const NAV = [
    ['d', 'daily',       'Go to Daily Review'],
    ['k', 'kanban',      'Go to Kanban'],
    ['c', 'calendar',    'Go to Calendar'],
    ['g', 'graph',       'Go to Knowledge Graph'],
  ];

  for (const [key, view, description] of NAV) {
    const v = view;
    add(key, async () => {
      const { navigate } = await import('../core/router.js');
      navigate(v);
    }, { description });
  }

  // ? — show shortcuts overlay (bare key)
  add('?', () => {
    const so = document.getElementById('shortcuts-overlay');
    if (so) {
      so.classList.add('open');
      so.setAttribute('aria-hidden', 'false');
      so.removeAttribute('inert');
    }
  }, { description: 'Show keyboard shortcuts' });

  // E — new event
  add('e', async () => {
    const { emit, EVENTS } = await import('../core/events.js');
    emit(EVENTS.FAB_CREATE, { entityType: 'event' });
  }, { description: 'Create new event' });

  // Alt+1..9 — navigate to nth sidebar nav item
  for (let i = 1; i <= 9; i++) {
    const n = i;
    add(`alt+${n}`, () => {
      const items = [...document.querySelectorAll('.nav-item[data-view]')];
      const item  = items[n - 1];
      if (item) item.click();
    }, { description: `Navigate to sidebar item ${n}` });
  }
}

// ── Service descriptor for serviceRegistry ────────────────── //

export const hotkeyServiceDescriptor = {
  dependencies: [],
  start(env) {
    return createHotkeyService(env);
  },
};
