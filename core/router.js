/**
 * FamilyHub v4.2 — core/router.js
 * View routing, navigation history, breadcrumbs, URL hash
 * Blueprint §4.1 — upgraded to use viewRegistry (P-01)
 * P-15 — action-based router: full action serialized to URL hash as query params
 *
 * Public API:
 *   import { navigate, back, forward, getCurrentView, getHistory } from './router.js';
 */

import { emit, EVENTS } from './events.js';
import { viewRegistry } from './registry.js';
// [MAJOR] Tab integration — updateActiveTab keeps the tab bar in sync with every navigate()
import { updateActiveTab, openTab as _openTabFn } from './tabs.js';

// ── Constants ────────────────────────────────────────────── //

/** All routable view keys */
export const VIEW_KEYS = Object.freeze({
  DASHBOARD:        'dashboard',
  DAILY:            'daily',
  KANBAN:           'kanban',
  CALENDAR:         'calendar',
  ACTIVITY_CENTER:  'activity-center',
  FAMILY_MATTERS:   'family-matters',
  NOTES:            'notes',
  PROJECTS:         'projects',
  GRAPH:            'graph',
  BUDGET:           'budget',
  RECIPES:          'recipes',
  DOCUMENTS:        'documents',
  CONTACTS:         'contacts',
  GALLERY:          'gallery',
  SETTINGS:         'settings',
  // Generic entity-type view
  ENTITY_TYPE:      'entity-type',
});

/** Human-readable labels for breadcrumbs */
const VIEW_LABELS = {
  'dashboard':       'Dashboard',
  'daily':           'Daily Review',
  'kanban':          'Tasks',
  'calendar':        'Calendar',
  'activity-center': 'Activity Center',
  'family-matters':  'Family Matters',
  'notes':           'Notes',
  'projects':        'Projects',
  'graph':           'Knowledge Graph',
  'budget':          'Budget',
  'recipes':         'Recipes',
  'documents':       'Documents',
  'contacts':        'Contacts',
  'gallery':         'Gallery',
  'settings':        'Settings',
  'entity-type':     'Entities',
};

// ── Router State ─────────────────────────────────────────── //

/**
 * @typedef {Object} HistoryEntry
 * @property {string} viewKey       - e.g. 'kanban', 'entity-type'
 * @property {Object} params        - e.g. { entityType: 'idea' }
 * @property {string} label         - Human-readable label for breadcrumb
 */

/** @type {HistoryEntry[]} */
let _history = [];

/** Current position in _history (0 = oldest, _history.length-1 = newest) */
let _cursor = -1;

// ── Registration ─────────────────────────────────────────── //

/**
 * Register a view's render function (eager) or a lazy import path (P-16).
 * Delegates to viewRegistry (P-01).
 *
 * @param {string} viewKey
 * @param {Function|string} renderFnOrPath
 *   - Function: eager view, called immediately on navigate
 *   - string:   lazy view — dynamic import path (e.g. './views/budget/budget.js')
 */
export function registerView(viewKey, renderFnOrPath) {
  if (typeof renderFnOrPath === 'string') {
    // Lazy view: store as { lazy: true, path, cachedModule }
    viewRegistry.add(viewKey, { lazy: true, path: renderFnOrPath, cachedModule: null });
    return;
  }
  if (typeof renderFnOrPath !== 'function') {
    throw new TypeError(`[router] renderFn for "${viewKey}" must be a function or import path string`);
  }
  viewRegistry.add(viewKey, renderFnOrPath);
}

/** Module cache for lazy views: viewKey → renderFn */
const _lazyCache = new Map();

/**
 * Skeleton screen templates for lazy views (P-16).
 * Shown while the module loads.
 */
const SKELETONS = {
  graph:     _skeletonGraph,
  budget:    _skeletonGrid,
  gallery:   _skeletonGrid,
  documents: _skeletonList,
};

function _skeletonPulse() {
  return 'skeleton-pulse';
}

function _skeletonGraph() {
  return `<div class="skeleton-wrap" aria-label="Loading…" aria-busy="true">
    <div class="skeleton-graph-canvas ${_skeletonPulse()}"></div>
    <div class="skeleton-graph-panel">${Array(6).fill('<div class="skeleton-line"></div>').join('')}</div>
  </div>`;
}

function _skeletonGrid() {
  return `<div class="skeleton-wrap" aria-label="Loading…" aria-busy="true">
    <div class="skeleton-grid">${Array(9).fill('<div class="skeleton-card"></div>').join('')}</div>
  </div>`;
}

function _skeletonList() {
  return `<div class="skeleton-wrap" aria-label="Loading…" aria-busy="true">
    <div class="skeleton-list">${Array(8).fill('<div class="skeleton-row"></div>').join('')}</div>
  </div>`;
}

function _defaultSkeleton() {
  return `<div class="skeleton-wrap" aria-label="Loading…" aria-busy="true">
    <div class="skeleton-list">${Array(5).fill('<div class="skeleton-row"></div>').join('')}</div>
  </div>`;
}

// ── Navigation ───────────────────────────────────────────── //

/**
 * Navigate to a view, optionally with params.
 * Pushes to history stack and updates URL hash.
 *
 * @param {string} viewKey        - e.g. 'kanban' or 'entity-type'
 * @param {Object} [params={}]    - e.g. { entityType: 'idea' }
 * @param {string} [label]        - Override breadcrumb label
 * @param {boolean} [replace=false] - Replace current history entry instead of pushing
 */
/**
 * Navigate to a view.
 * Supports two call signatures:
 *   navigate(viewKey, params?, label?, replace?)   — positional (legacy)
 *   navigate({ view, entityType?, filter?, entityId?, label? })  — action object (P-15)
 */
export function navigate(viewKeyOrAction, params = {}, label, replace = false) {
  // P-15: accept action object { view, entityType?, filter?, entityId?, label? }
  let viewKey = viewKeyOrAction;
  if (viewKeyOrAction && typeof viewKeyOrAction === 'object') {
    const action = viewKeyOrAction;
    viewKey  = action.view;
    params   = {};
    if (action.entityType) params.entityType = action.entityType;
    if (action.filter)     params.filter     = action.filter;
    if (action.entityId)   params.entityId   = action.entityId;
    if (action.date)       params.date       = action.date;
    label    = action.label;
    replace  = action.replace ?? false;
  }
  const resolvedLabel = label || _resolveLabel(viewKey, params);

  const entry = { viewKey, params, label: resolvedLabel };

  let _skipApplyView = false;
  if (replace && _cursor >= 0) {
    // Replace current position — skip re-render if same view key (e.g. search-bar URL update)
    _skipApplyView = _history[_cursor]?.viewKey === entry.viewKey;
    _history[_cursor] = entry;
  } else {
    // Deduplicate: if the new entry is the same view+params as current, replace it.
    // This prevents consecutive identical entries when the user re-navigates to
    // the same view (e.g. clicking Daily Review sidebar repeatedly, or internal
    // re-renders that go through navigate()).
    const cur = _cursor >= 0 ? _history[_cursor] : null;
    const isSameView = cur &&
      cur.viewKey === entry.viewKey &&
      _paramsKey(cur.params) === _paramsKey(entry.params);

    if (isSameView) {
      // Replace in-place — update label only; view already rendered with these params
      _history[_cursor] = entry;
      // _skipApplyView already false — keep it false so _applyView runs on param changes.
      // When params are identical the view is idempotent so a re-render is harmless.
    } else {
      // Truncate forward history, then push
      _history = _history.slice(0, _cursor + 1);
      _history.push(entry);
      // Cap history to prevent memory leak on long sessions
      // [minor] Bug 2 fix: shift() removes element at index 0 — cursor must be decremented
      // to keep pointing at the same entry (now at index cursor-1 after shift).
      if (_history.length > 100) { _history.shift(); _cursor = Math.max(0, _cursor - 1); }
      _cursor = _history.length - 1;
    }
  }

  if (!_skipApplyView) _applyView(entry);
  _updateHash(viewKey, params);
  _renderBreadcrumbs();

  // [MAJOR] Keep active tab label/icon in sync with every navigation
  updateActiveTab(viewKey, params, resolvedLabel);

  emit(EVENTS.VIEW_CHANGED, { viewKey, params, label: resolvedLabel });
}

/**
 * Navigate to an entity panel view via URL deep link.
 * Hash pattern: #entity/{type}/{id}
 * @param {string} entityType
 * @param {string} entityId
 */
export function navigateToEntity(entityType, entityId) {
  // Don't push a view navigation — just update hash and fire panel:opened
  window.location.hash = `entity/${entityType}/${entityId}`;
  emit(EVENTS.PANEL_OPENED, { entityType, entityId });
}

/**
 * Navigate back one step in history.
 * @returns {boolean} Whether navigation happened
 */
export function back() {
  if (_cursor <= 0) return false;
  _cursor--;
  const entry = _history[_cursor];
  _applyView(entry);
  _updateHash(entry.viewKey, entry.params);
  _renderBreadcrumbs();
  emit(EVENTS.VIEW_CHANGED, { viewKey: entry.viewKey, params: entry.params, label: entry.label });
  return true;
}

/**
 * Navigate forward one step in history.
 * @returns {boolean} Whether navigation happened
 */
export function forward() {
  if (_cursor >= _history.length - 1) return false;
  _cursor++;
  const entry = _history[_cursor];
  _applyView(entry);
  _updateHash(entry.viewKey, entry.params);
  _renderBreadcrumbs();
  emit(EVENTS.VIEW_CHANGED, { viewKey: entry.viewKey, params: entry.params, label: entry.label });
  return true;
}

/**
 * Jump directly to a specific cursor position (avoids calling _applyView multiple times).
 * Used by breadcrumb multi-step navigation.
 * @param {number} targetCursor
 */
export function jumpTo(targetCursor) {
  if (targetCursor < 0 || targetCursor >= _history.length) return false;
  if (targetCursor === _cursor) return false;
  _cursor = targetCursor;
  const entry = _history[_cursor];
  _applyView(entry);
  _updateHash(entry.viewKey, entry.params);
  _renderBreadcrumbs();
  emit(EVENTS.VIEW_CHANGED, { viewKey: entry.viewKey, params: entry.params, label: entry.label });
  return true;
}

/**
 * Returns the current view entry.
 * @returns {HistoryEntry|null}
 */
export function getCurrentView() {
  return _cursor >= 0 ? _history[_cursor] : null;
}

/**
 * Returns the current router state as an action object.
 * P-08: used by hotkeyService to determine active scope,
 * and by views that need to read their own URL params.
 *
 * Shape: { view: string, params: object, label: string }
 * @returns {{ view: string, params: object, label: string }|null}
 */
/**
 * Returns the current router action (P-15 full action shape).
 * Shape: { view, params, entityType?, filter?, entityId?, date?, label? }
 */
export function getState() {
  const cur = getCurrentView();
  if (!cur) return null;
  const p = cur.params || {};
  return {
    view:       cur.viewKey,
    params:     p,
    entityType: p.entityType || null,
    filter:     p.filter     || null,
    entityId:   p.entityId   || null,
    date:       p.date       || null,
    label:      cur.label    || '',
  };
}

/**
 * Returns the full history stack (read-only copy).
 * @returns {HistoryEntry[]}
 */
export function getHistory() {
  return [..._history];
}

/** @returns {boolean} */
export function canGoBack()    { return _cursor > 0; }
/** @returns {boolean} */
export function canGoForward() { return _cursor < _history.length - 1; }

/**
 * showView — alias for navigate(). Satisfies Blueprint §4.1 naming convention
 * used by views that call showView(viewKey) or showView(viewKey, params).
 * Identical behaviour: hides all views, shows target, pushes history,
 * updates URL hash, updates breadcrumbs, fires EVENTS.VIEW_CHANGED.
 *
 * @param {string} viewKey
 * @param {Object} [params={}]
 * @param {string} [label]
 */
export function showView(viewKey, params = {}, label) {
  navigate(viewKey, params, label);
}

/**
 * Open a view in a new tab (or focus existing tab with matching view+params).
 * Called by wireNavItems on Ctrl/Cmd+click or middle-click.
 *
 * @param {string} viewKey
 * @param {Object} [params={}]
 * @param {string} [label]
 */
export function openInNewTab(viewKey, params = {}, label) {
  _openTabFn(viewKey, params, label || _resolveLabel(viewKey, params));
}

// ── Internal Helpers ─────────────────────────────────────── //

/**
 * Show the correct view div and call its render function.
 * @param {HistoryEntry} entry
 */
function _applyView(entry) {
  const { viewKey, params } = entry;

  // Hide all views
  document.querySelectorAll('.view').forEach(el => {
    el.classList.remove('active');
    el.setAttribute('aria-hidden', 'true');
  });

  // Remove graph-active from main (Blueprint §9.2)
  const main = document.getElementById('main');
  if (main) main.classList.remove('graph-active');

  // Show target view
  const viewEl = document.getElementById(`view-${viewKey}`);
  if (viewEl) {
    viewEl.classList.add('active');
    viewEl.setAttribute('aria-hidden', 'false');
  }

  // Graph view triggers special layout (Blueprint §9.2)
  if (viewKey === VIEW_KEYS.GRAPH && main) {
    main.classList.add('graph-active');
  }

  // Update active nav item
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.remove('active');
    if (el.dataset.view === viewKey) {
      // Check params too for entity-type views
      if (viewKey === 'entity-type') {
        if (el.dataset.entityType === params.entityType) {
          el.classList.add('active');
        }
      } else {
        el.classList.add('active');
      }
    }
  });

  // Resolve view from viewRegistry — handles both eager and lazy (P-01, P-16)
  if (viewRegistry.has(viewKey)) {
    const registered = viewRegistry.get(viewKey);

    if (typeof registered === 'function') {
      // Eager view: call directly
      try {
        registered(params);
      } catch (err) {
        console.error(`[router] Error rendering view "${viewKey}":`, err);
      }

    } else if (registered?.lazy) {
      // Lazy view: show skeleton, dynamic import, mount, fade in
      _loadLazyView(viewKey, registered, params, viewEl);
    }
  }
}


/**
 * Dynamically load a lazy view module, show skeleton while loading (P-16).
 * Caches the module so second navigation is instant.
 * @param {string} viewKey
 * @param {{ lazy: true, path: string, cachedModule: any }} registration
 * @param {object} params
 * @param {HTMLElement|null} viewEl
 */
async function _loadLazyView(viewKey, registration, params, viewEl) {
  if (!viewEl) return;

  // Check cache first
  if (_lazyCache.has(viewKey)) {
    try {
      _lazyCache.get(viewKey)(params);
    } catch (err) {
      console.error(`[router] Cached lazy view "${viewKey}" error:`, err);
    }
    return;
  }

  // Show skeleton while loading
  const skelFn = SKELETONS[viewKey] || _defaultSkeleton;
  viewEl.innerHTML = skelFn();

  try {
    const mod = await import(/* @vite-ignore */ registration.path);
    const renderFn = mod.default || mod[`render${viewKey.charAt(0).toUpperCase() + viewKey.slice(1)}`] || Object.values(mod).find(v => typeof v === 'function');

    if (typeof renderFn !== 'function') {
      throw new Error(`Lazy module at "${registration.path}" exports no render function`);
    }

    // Cache for future navigations
    _lazyCache.set(viewKey, renderFn);
    registration.cachedModule = renderFn;

    // Fade out skeleton, mount view
    viewEl.style.transition = 'opacity 0.1s ease';
    viewEl.style.opacity    = '0';
    await new Promise(r => setTimeout(r, 100));
    viewEl.innerHTML = '';
    renderFn(params);
    viewEl.style.opacity = '1';

  } catch (err) {
    console.error(`[router] Failed to load lazy view "${viewKey}":`, err);
    viewEl.innerHTML = `
      <div class="lazy-error" role="alert">
        <p>Failed to load this section.</p>
        <button class="btn btn-primary lazy-retry">Retry</button>
      </div>`;
    viewEl.querySelector('.lazy-retry')?.addEventListener('click', () => {
      _lazyCache.delete(viewKey);
      _loadLazyView(viewKey, registration, params, viewEl);
    });
  }
}

/**
 * Update the browser URL hash — serializes the full action as URL params (P-15).
 * Format: #view=kanban&entityType=tasks&filter=overdue
 * Maintains backward-compatible path-style hashes for common patterns.
 */
function _updateHash(viewKey, params) {
  _suppressHashChange = true;
  try {
    // Build query-style hash for rich state
    const parts = [`view=${encodeURIComponent(viewKey)}`];
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null && v !== '' && k !== '_internal') {
        parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
      }
    }
    window.location.hash = parts.join('&');
  } finally {
    _suppressHashChange = false;
  }
}

/**
 * Parse a URL hash string into an action object (P-15).
 * Supports:
 *   #view=kanban&entityType=tasks&filter=overdue  (new action-style)
 *   #kanban                                        (legacy plain view)
 *   #entity-type/idea                              (legacy entity-type)
 *   #daily/2026-04-26                              (legacy daily+date)
 */
function _parseHash(hash) {
  if (!hash) return null;

  // New action-style: starts with 'view='
  if (hash.startsWith('view=')) {
    const params = {};
    for (const part of hash.split('&')) {
      // [minor] Bug 19 fix: split only on the FIRST '=' so values containing '=' are preserved
      const eqIdx = part.indexOf('=');
      if (eqIdx === -1) continue;
      const k = decodeURIComponent(part.slice(0, eqIdx));
      const v = decodeURIComponent(part.slice(eqIdx + 1));
      if (k) params[k] = v;
    }
    const { view, ...rest } = params;
    return view ? { viewKey: view, params: rest } : null;
  }

  // Legacy: entity panel #entity/{type}/{id}
  const entityMatch = hash.match(/^entity\/([^/]+)\/([^/]+)$/);
  if (entityMatch) return { viewKey: '__entity_panel__', params: { entityType: entityMatch[1], entityId: entityMatch[2] } };

  // Legacy: entity-type #entity-type/{typeKey}
  const typeMatch = hash.match(/^entity-type\/([^/]+)$/);
  if (typeMatch) return { viewKey: 'entity-type', params: { entityType: typeMatch[1] } };

  // Legacy: daily with date #daily/YYYY-MM-DD
  const dailyMatch = hash.match(/^daily\/(\d{4}-\d{2}-\d{2})$/);
  if (dailyMatch) return { viewKey: 'daily', params: { date: dailyMatch[1] } };

  // Legacy: plain view #kanban
  if (Object.values(VIEW_KEYS).includes(hash)) return { viewKey: hash, params: {} };

  return null;
}

let _suppressHashChange = false;

/**
 * Render the breadcrumb row from current history state.
 * Blueprint §4.1 — "Home > Project > Entity chain"
 */
function _renderBreadcrumbs() {
  const row = document.getElementById('breadcrumb-row');
  if (!row) return;

  const backBtn = document.getElementById('breadcrumb-back-btn');
  if (backBtn) {
    backBtn.disabled = !canGoBack();
  }
  const fwdBtn = document.getElementById('breadcrumb-fwd-btn');
  if (fwdBtn) {
    fwdBtn.disabled = !canGoForward();
  }

  // Build breadcrumb trail — show last 4 entries max
  const trail = _history.slice(Math.max(0, _cursor - 3), _cursor + 1);
  const trailContainer = document.getElementById('breadcrumb-trail');
  if (!trailContainer) return;

  trailContainer.innerHTML = '';

  trail.forEach((entry, i) => {
    const isLast = i === trail.length - 1;
    const isClickable = !isLast;

    // Separator before (except first)
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'breadcrumb-sep';
      sep.textContent = '›';
      trailContainer.appendChild(sep);
    }

    const item = document.createElement('span');
    item.className = `breadcrumb-item${isLast ? ' active' : ''}`;
    item.textContent = entry.label;

    if (isClickable) {
      const targetCursor = _cursor - (trail.length - 1 - i);
      item.addEventListener('click', () => {
        jumpTo(targetCursor);
      });
    }

    trailContainer.appendChild(item);
  });
}

/**
 * Resolve a human-readable label for a nav entry.
 */
function _resolveLabel(viewKey, params) {
  if (viewKey === 'entity-type' && params.entityType) {
    // Capitalise entity type key — will be overridden by graph-engine when available
    return params.entityTypeLabel || _capitalise(params.entityType);
  }
  // Enrich Daily Review breadcrumb label with the specific date when present
  if (viewKey === 'daily' && params.date) {
    const [y, m, d] = params.date.split('-');
    return `Daily Review — ${m}-${d}-${y}`;
  }
  return VIEW_LABELS[viewKey] || _capitalise(viewKey);
}

function _capitalise(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Produce a stable string key from a params object for deduplication.
 * Only includes fields relevant to view identity (ignores ephemeral flags).
 */
function _paramsKey(params) {
  if (!params) return '';
  // [minor] Bug 5 fix: include all non-ephemeral params so that two navigations
  // to the same viewKey with different params (e.g. highlightId, focusEntityId)
  // are correctly treated as distinct history entries.
  const { _internal, ...rest } = params;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

// ── Hash-Based Deep Linking ───────────────────────────────── //

/**
 * Parse the current URL hash and navigate accordingly (P-15 action-based router).
 * Supports both new action-style (#view=kanban&filter=overdue) and all legacy formats.
 */
export function handleInitialHash() {
  const hash = window.location.hash.slice(1);
  if (!hash) return false;

  const action = _parseHash(hash);
  if (!action) return false;

  // Special case: entity panel deep link
  if (action.viewKey === '__entity_panel__') {
    navigate(VIEW_KEYS.DAILY);
    emit(EVENTS.PANEL_OPENED, action.params);
    return true;
  }

  navigate(action.viewKey, action.params);
  return true;
}

/**
 * Listen for browser back/forward (popstate-equivalent via hashchange).
 * Guard for non-browser environments (Node.js, SSR).
 */
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    if (_suppressHashChange) return;
    handleInitialHash();
  });
}

// ── Sidebar Nav Click Wiring ──────────────────────────────── //

/**
 * Wire all .nav-item elements in the sidebar to the router.
 * Called by index.html after DOM ready.
 */
export function wireNavItems() {
  // Use event delegation on .sidebar-nav so dynamically-added custom type
  // nav items work automatically without re-calling wireNavItems().
  const nav = document.querySelector('.sidebar-nav');
  if (!nav || nav._delegated) return;  // idempotent
  nav._delegated = true;

  // ── Helper: extract view/params/label from a nav item element ──
  function _navItemData(el) {
    const view       = el.dataset.view;
    const entityType = el.dataset.entityType;
    const label      = el.dataset.label || el.querySelector('.nav-item-label')?.textContent?.trim();
    const params     = (view === 'entity-type' && entityType) ? { entityType } : {};
    return { view, params, label };
  }

  // ── Inject ⋮ dots button into every sidebar nav item ─────────
  // Shows on hover; click opens the item in a new tab.
  // Works for static items and dynamically-added custom type items.
  function _injectDotsButton(navItemEl) {
    if (navItemEl._dotsInjected) return; // idempotent
    navItemEl._dotsInjected = true;

    const btn = document.createElement('button');
    btn.type      = 'button';
    btn.className = 'nav-item-dots';
    btn.textContent = '⋮';
    btn.setAttribute('aria-label', 'Open in new tab');
    btn.title = 'Open in new tab';

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const { view, params, label } = _navItemData(navItemEl);
      if (!view) return;
      const resolvedLabel = label || _resolveLabel(view, params);
      console.log('[nav-dots] Opening in new tab:', view, params, resolvedLabel);
      _openTabFn(view, params, resolvedLabel);
    });

    navItemEl.appendChild(btn);
  }

  // Inject into all current nav items
  nav.querySelectorAll('.nav-item[data-view]').forEach(_injectDotsButton);

  // Watch for dynamically added nav items (custom types added after init)
  const _observer = new MutationObserver((mutations) => {
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (node.nodeType !== 1) continue;
        // Node itself might be a nav-item
        if (node.matches?.('.nav-item[data-view]')) _injectDotsButton(node);
        // Or it might be a container with nav-items inside (e.g. <li> wrapping a button)
        node.querySelectorAll?.('.nav-item[data-view]').forEach(_injectDotsButton);
      }
    }
  });
  _observer.observe(nav, { childList: true, subtree: true });

  // ── Left-click: navigate (or Ctrl/Cmd+click: new tab) ──
  nav.addEventListener('click', (e) => {
    // Dots button handled by its own listener — skip here
    if (e.target.closest('.nav-item-dots')) return;
    const el = e.target.closest('.nav-item[data-view]');
    if (!el) return;

    const { view, params, label } = _navItemData(el);

    // [MAJOR] Ctrl/Cmd + click → open in new tab
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      _openTabFn(view, params, label || _resolveLabel(view, params));
    } else {
      if (view === 'entity-type' && params.entityType) {
        navigate(view, params, label);
      } else {
        navigate(view, {}, label);
      }
    }

    // Close mobile sidebar on nav
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    if (sidebar) sidebar.classList.remove('open');
    if (overlay) overlay.classList.remove('visible');
  });

  // ── Middle-click: open in new tab ──
  nav.addEventListener('mousedown', (e) => {
    if (e.button !== 1) return;
    const el = e.target.closest('.nav-item[data-view]');
    if (!el) return;
    e.preventDefault(); // prevent scroll-panning
    const { view, params, label } = _navItemData(el);
    _openTabFn(view, params, label || _resolveLabel(view, params));
  });

  // Also wire sidebar-footer nav items (Settings) via delegation on the footer
  const footer = document.querySelector('.sidebar-footer');
  if (footer && !footer._fhFooterDelegated) {
    footer._fhFooterDelegated = true;

    // Inject dots into footer items too
    footer.querySelectorAll('.nav-item[data-view]').forEach(_injectDotsButton);

    footer.addEventListener('click', (e) => {
      if (e.target.closest('.nav-item-dots')) return;
      const el = e.target.closest('.nav-item[data-view]');
      if (!el) return;
      const { view, params, label } = _navItemData(el);

      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        _openTabFn(view, params, label || _resolveLabel(view, params));
      } else {
        navigate(view, params);
      }

      const sidebar = document.getElementById('sidebar');
      const overlay2 = document.getElementById('sidebar-overlay');
      if (sidebar) sidebar.classList.remove('open');
      if (overlay2) overlay2.classList.remove('visible');
    });

    footer.addEventListener('mousedown', (e) => {
      if (e.button !== 1) return;
      const el = e.target.closest('.nav-item[data-view]');
      if (!el) return;
      e.preventDefault();
      const { view, params, label } = _navItemData(el);
      _openTabFn(view, params, label || _resolveLabel(view, params));
    });
  }

  // Back / Forward breadcrumb buttons
  document.getElementById('breadcrumb-back-btn')?.addEventListener('click', () => back());
  document.getElementById('breadcrumb-fwd-btn')?.addEventListener('click', () => forward());
}
