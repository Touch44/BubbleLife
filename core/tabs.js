/**
 * FamilyHub v4.3 — core/tabs.js
 * [MAJOR] Tab system — multi-view tab bar with persistence, drag-to-reorder,
 * and deep router integration.
 *
 * Design goals:
 *   - No circular imports (tabs.js does NOT import router.js)
 *   - Ctrl/Cmd+click on any nav item → open in new tab
 *   - Middle-click on tab → close tab
 *   - Drag tabs to reorder
 *   - Persisted to localStorage (survives reload)
 *   - Deduplication: clicking a view that's already open focuses its tab
 *   - Min 1 tab always open; "+" button duplicates current view
 *
 * Public API:
 *   initTabs({ navigate, getCurrentView })
 *   openTab(viewKey, params?, label?, forceNew?)  → Tab
 *   switchTab(tabId)
 *   closeTab(tabId)
 *   getActiveTab()   → Tab | null
 *   getAllTabs()      → Tab[]
 *   updateActiveTab(viewKey, params, label)        ← called by router
 *   restoreScrollPos()                             ← called by router after view switch
 */

import { on, emit, EVENTS } from './events.js';

// ── Tab Events ─────────────────────────────────────────── //
/** @readonly */
export const TAB_EVENTS = Object.freeze({
  TAB_OPENED:     'tab:opened',
  TAB_CLOSED:     'tab:closed',
  TAB_SWITCHED:   'tab:switched',
  TAB_UPDATED:    'tab:updated',
  TABS_REORDERED: 'tabs:reordered',
});

// ── Constants ──────────────────────────────────────────── //
const STORAGE_KEY = 'fh_tabs_v1';
const MAX_TABS    = 12;

// ── Module State ───────────────────────────────────────── //

/** @type {{ id:string, viewKey:string, params:object, label:string, icon:string, scrollPos:number, createdAt:number }[]} */
let _tabs = [];
let _activeTabId = null;

/** Stored reference to router's navigate function — set by initTabs */
let _navigateFn = null;

/** Icon cache: cacheKey → emoji string */
const _iconCache = new Map();

// ── Helpers ────────────────────────────────────────────── //

function _uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function _esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Look up the icon emoji for a view from the sidebar DOM.
 * Cached after first lookup. Falls back to generic '📄'.
 */
function _getIcon(viewKey, entityType) {
  const cacheKey = entityType ? `${viewKey}:${entityType}` : viewKey;
  if (_iconCache.has(cacheKey)) return _iconCache.get(cacheKey);

  const selector = entityType
    ? `.nav-item[data-view="${viewKey}"][data-entity-type="${entityType}"]`
    : `.nav-item[data-view="${viewKey}"]:not([data-entity-type])`;
  const el   = document.querySelector(selector);
  const icon = el?.querySelector('.nav-item-icon')?.textContent?.trim() || '📄';
  _iconCache.set(cacheKey, icon);
  return icon;
}

function _paramsKey(params) {
  if (!params) return '';
  const { date, entityType } = params;
  return JSON.stringify({ date: date || null, entityType: entityType || null });
}

function _makeTab(viewKey, params = {}, label = '') {
  return {
    id:         _uid(),
    viewKey,
    params:     { ...params },
    label:      label || viewKey,
    icon:       _getIcon(viewKey, params.entityType),
    scrollPos:  0,
    createdAt:  Date.now(),
  };
}

// ── Persistence ────────────────────────────────────────── //

function _save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      tabs:        _tabs,
      activeTabId: _activeTabId,
    }));
  } catch (_) { /* quota exceeded — ignore */ }
}

function _load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

// ── Public API ─────────────────────────────────────────── //

/**
 * Get the currently active tab.
 * @returns {{ id, viewKey, params, label, icon, scrollPos } | null}
 */
export function getActiveTab() {
  return _tabs.find(t => t.id === _activeTabId) || null;
}

/** @returns {Tab[]} Shallow copy of tab list */
export function getAllTabs() { return [..._tabs]; }

/**
 * Open a view in a new tab, or focus an existing tab with the same view+params.
 *
 * @param {string}  viewKey
 * @param {Object}  [params={}]
 * @param {string}  [label='']
 * @param {boolean} [forceNew=false]  Skip dedup — always create a new tab
 * @returns {Tab}
 */
export function openTab(viewKey, params = {}, label = '', forceNew = false) {
  if (!forceNew) {
    const pk       = _paramsKey(params);
    const existing = _tabs.find(t =>
      t.viewKey === viewKey && _paramsKey(t.params) === pk
    );
    if (existing) {
      switchTab(existing.id, true); // focus without re-render delay
      return existing;
    }
  }

  // Enforce max tab count — evict oldest non-active tab
  if (_tabs.length >= MAX_TABS) {
    const oldest = _tabs.find(t => t.id !== _activeTabId);
    if (oldest) closeTab(oldest.id, true /* silent */);
  }

  const tab = _makeTab(viewKey, params, label);
  _tabs.push(tab);
  _activeTabId = tab.id;
  _renderTabBar();
  _save();
  emit(TAB_EVENTS.TAB_OPENED, { tab });

  // Ask router to navigate to this view
  _navigateFn?.(viewKey, params, label);
  return tab;
}

/**
 * Switch to a tab by id, saving the current tab's scroll position first.
 * @param {string}  tabId
 * @param {boolean} [skipNavigate=false] — used internally after openTab already calls navigateFn
 */
export function switchTab(tabId, skipNavigate = false) {
  const tab = _tabs.find(t => t.id === tabId);
  if (!tab || tab.id === _activeTabId) return;

  // Persist scroll of departing tab
  const main    = document.getElementById('main');
  const current = getActiveTab();
  if (current && main) current.scrollPos = main.scrollTop;

  _activeTabId = tabId;
  _renderTabBar();
  _save();
  emit(TAB_EVENTS.TAB_SWITCHED, { tab });

  if (!skipNavigate) {
    _navigateFn?.(tab.viewKey, tab.params, tab.label);
  }
}

/**
 * Close a tab. Cannot close the last tab.
 * @param {string}  tabId
 * @param {boolean} [silent=false] — suppress event (internal use)
 */
export function closeTab(tabId, silent = false) {
  if (_tabs.length <= 1) return; // last tab is permanent

  const idx       = _tabs.findIndex(t => t.id === tabId);
  if (idx === -1) return;

  const wasActive = _activeTabId === tabId;
  _tabs.splice(idx, 1);

  if (wasActive) {
    // Focus nearest remaining tab — prefer left, fall back to right
    const newIdx    = Math.min(idx, _tabs.length - 1);
    _activeTabId    = _tabs[newIdx].id;
    const nextTab   = _tabs[newIdx];
    _navigateFn?.(nextTab.viewKey, nextTab.params, nextTab.label);
  }

  _renderTabBar();
  _save();
  if (!silent) emit(TAB_EVENTS.TAB_CLOSED, { tabId });
}

/** Pending update queued before initTabs() runs — applied on first render */
let _pendingUpdate = null;

/**
 * Called by router.js on every navigate() to keep active tab in sync.
 * This is the single source of truth update — no re-navigate triggered.
 */
export function updateActiveTab(viewKey, params, label) {
  const tab = getActiveTab();
  if (!tab) {
    // Queue: tabs not yet initialised (auth navigate fires before initTabs)
    _pendingUpdate = { viewKey, params: { ...(params || {}) }, label: label || viewKey };
    return;
  }
  tab.viewKey   = viewKey;
  tab.params    = { ...(params || {}) };
  tab.label     = label || viewKey;
  tab.icon      = _getIcon(viewKey, params?.entityType);
  _renderTabBar();
  _save();
  emit(TAB_EVENTS.TAB_UPDATED, { tab });
}

/**
 * Restore the active tab's saved scroll position.
 * Called by router after view render completes (requestAnimationFrame).
 */
export function restoreScrollPos() {
  const tab  = getActiveTab();
  const main = document.getElementById('main');
  if (!tab || !main) return;
  requestAnimationFrame(() => { main.scrollTop = tab.scrollPos || 0; });
}

// ── Initialisation ─────────────────────────────────────── //

/**
 * Bootstrap the tab system.
 * Must be called once after auth completes and the app shell is visible.
 *
 * @param {{ navigate: Function, getCurrentView: Function }} opts
 */
export function initTabs({ navigate, getCurrentView }) {
  _navigateFn = navigate;

  // Load persisted state
  const saved = _load();

  if (saved?.tabs?.length) {
    _tabs        = saved.tabs.map(t => ({ ...t })); // deep-ish clone
    _activeTabId = saved.activeTabId || _tabs[0].id;
    // Guard: ensure activeTabId references a real tab
    if (!_tabs.find(t => t.id === _activeTabId)) _activeTabId = _tabs[0].id;
  } else {
    // First launch — create one placeholder; will be synced by first VIEW_CHANGED
    const tab    = _makeTab('dashboard', {}, 'Dashboard');
    _tabs        = [tab];
    _activeTabId = tab.id;
  }

  _renderTabBar();
  console.log('[tabs] Initialised —', _tabs.length, 'tab(s) restored.');

  // Apply any pending updateActiveTab() call that arrived before initTabs ran
  // (auth calls navigate() → updateActiveTab() fires before initTabs is ready)
  if (_pendingUpdate) {
    const tab = getActiveTab();
    if (tab) {
      tab.viewKey = _pendingUpdate.viewKey;
      tab.params  = _pendingUpdate.params;
      tab.label   = _pendingUpdate.label;
      tab.icon    = _getIcon(_pendingUpdate.viewKey, _pendingUpdate.params?.entityType);
      _renderTabBar();
      _save();
    }
    _pendingUpdate = null;
  }

  // ── Init sync: intercept the first VIEW_CHANGED fired by auth._showApp() ──
  // auth.js calls navigate() asynchronously, so we can't rely on getCurrentView()
  // being populated when initTabs runs. We listen for the first VIEW_CHANGED to:
  //   a) Restore stored tab view (if stored & no hash override), OR
  //   b) Sync the placeholder tab to whatever auth navigated to.
  let _syncDone = false;
  const _unsub  = on(EVENTS.VIEW_CHANGED, ({ viewKey, params, label }) => {
    if (_syncDone) {
      // Subsequent navigates: just keep active tab in sync (done by router calling updateActiveTab)
      return;
    }
    _syncDone = true;
    _unsub(); // fire once

    const hasHash = !!window.location.hash.slice(1);
    const active  = getActiveTab();

    if (saved?.tabs?.length && !hasHash && active) {
      // Stored state exists and no URL hash override — restore stored view
      if (active.viewKey !== viewKey ||
          _paramsKey(active.params) !== _paramsKey(params || {})) {
        // Navigate to stored active tab (supersedes auth's default dashboard)
        navigate(active.viewKey, active.params, active.label);
        return;
      }
    }

    // Either no stored state, OR hash is present, OR stored view matches current:
    // Sync active tab to match what auth navigated to
    if (active) {
      active.viewKey = viewKey;
      active.params  = { ...(params || {}) };
      active.label   = label || viewKey;
      active.icon    = _getIcon(viewKey, params?.entityType);
      _renderTabBar();
      _save();
    }
  });

  // ── Keyboard shortcuts ──────────────────────────────────
  _wireKeyboardShortcuts();
}

// ── Keyboard Shortcuts ─────────────────────────────────── //

function _wireKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Skip when typing
    if (e.target.closest('input, textarea, [contenteditable="true"], .ef-overlay, .search-palette')) return;

    const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);
    const mod   = isMac ? e.metaKey : e.ctrlKey;

    // Ctrl/Cmd+W — close active tab
    if (mod && e.key === 'w' && !e.shiftKey && !e.altKey) {
      // Only intercept if we have more than 1 tab (don't fight browser Ctrl+W)
      if (_tabs.length > 1) {
        e.preventDefault();
        e.stopPropagation();
        closeTab(_activeTabId);
      }
      return;
    }

    // Ctrl/Cmd+[ — previous tab
    if (mod && (e.key === '[' || e.key === 'ArrowLeft') && e.altKey) {
      e.preventDefault();
      const idx = _tabs.findIndex(t => t.id === _activeTabId);
      if (idx > 0) switchTab(_tabs[idx - 1].id);
      return;
    }

    // Ctrl/Cmd+] — next tab
    if (mod && (e.key === ']' || e.key === 'ArrowRight') && e.altKey) {
      e.preventDefault();
      const idx = _tabs.findIndex(t => t.id === _activeTabId);
      if (idx < _tabs.length - 1) switchTab(_tabs[idx + 1].id);
      return;
    }
  });
}

// ── Tab Bar DOM Rendering ──────────────────────────────── //


// ── Tab Context Menu ──────────────────────────────────────── //

/** Active context menu element */
let _ctxMenu = null;

/** Dismiss the tab context menu */
function _dismissContextMenu() {
  if (_ctxMenu) { _ctxMenu._cleanup?.(); _ctxMenu.remove(); _ctxMenu = null; }
}

function _showTabContextMenu(tab, x, y) {
  _dismissContextMenu();
  const menu = document.createElement('div');
  _ctxMenu = menu;
  menu.className = 'tab-ctx-menu';
  menu.style.cssText = [
    'position:fixed;z-index:var(--z-modal);',
    `left:${x}px;top:${y}px;`,
    'background:var(--color-bg);border:1px solid var(--color-border);',
    'border-radius:var(--radius-md);box-shadow:var(--shadow-lg);',
    'padding:var(--space-1) 0;min-width:190px;',
  ].join('');

  const canClose = _tabs.length > 1;
  const tabIdx   = _tabs.findIndex(t => t.id === tab.id);
  const others   = _tabs.filter(t => t.id !== tab.id);
  const toRight  = _tabs.slice(tabIdx + 1);

  const menuDef = [
    { label: '🔗 Duplicate tab',
      handler: () => openTab(tab.viewKey, { ...tab.params }, tab.label, true) },
    { divider: true },
    { label: '✕ Close tab',          disabled: !canClose,          handler: () => closeTab(tab.id) },
    { label: '✕ Close other tabs',   disabled: others.length === 0,
      handler: () => { if (tab.id !== _activeTabId) switchTab(tab.id); [...others].forEach(t => closeTab(t.id, true)); _renderTabBar(); _save(); } },
    { label: '✕ Close tabs to right',disabled: toRight.length === 0,
      handler: () => { [...toRight].forEach(t => closeTab(t.id, true)); _renderTabBar(); _save(); } },
  ];

  for (const item of menuDef) {
    if (item.divider) {
      const hr = document.createElement('div');
      hr.style.cssText = 'height:1px;background:var(--color-border);margin:var(--space-1) 0;';
      menu.appendChild(hr); continue;
    }
    const btn = document.createElement('button');
    btn.textContent = item.label;
    btn.style.cssText = [
      'display:block;width:100%;text-align:left;',
      'padding:var(--space-1-5) var(--space-3);background:none;border:none;',
      `color:${item.disabled ? 'var(--color-text-muted)' : 'var(--color-text)'};`,
      `cursor:${item.disabled ? 'default' : 'pointer'};opacity:${item.disabled ? '0.45' : '1'};`,
      'font-size:var(--text-sm);font-family:var(--font-body);transition:background var(--transition-fast);',
    ].join('');
    if (!item.disabled) {
      btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--color-surface)'; });
      btn.addEventListener('mouseleave', () => { btn.style.background = 'none'; });
      btn.addEventListener('click', () => { _dismissContextMenu(); item.handler(); });
    }
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  requestAnimationFrame(() => {
    const r = menu.getBoundingClientRect();
    if (r.right  > window.innerWidth)  menu.style.left = `${window.innerWidth  - r.width  - 8}px`;
    if (r.bottom > window.innerHeight) menu.style.top  = `${window.innerHeight - r.height - 8}px`;
  });
  const onDown = (e) => { if (!menu.contains(e.target)) _dismissContextMenu(); };
  const onKey  = (e) => { if (e.key === 'Escape') _dismissContextMenu(); };
  setTimeout(() => {
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown',   onKey, { once: true });
    menu._cleanup = () => { document.removeEventListener('mousedown', onDown); };
  }, 0);
}

/** Drag state */
let _dragTabId = null;

function _renderTabBar() {
  const bar = document.getElementById('tab-bar');
  if (!bar) return;

  bar.innerHTML = '';

  // ── Tab strip (scrollable) ──
  const strip = document.createElement('div');
  strip.className = 'tab-strip';
  strip.setAttribute('role', 'tablist');
  strip.setAttribute('aria-label', 'Open views');

  for (const tab of _tabs) {
    strip.appendChild(_buildTabEl(tab));
  }

  // ── "+" new-tab button ──
  const addBtn = document.createElement('button');
  addBtn.className    = 'tab-add-btn';
  addBtn.textContent  = '+';
  addBtn.title        = 'Open new tab — duplicates current view\nCtrl/⌘+click any sidebar item to open in a new tab';
  addBtn.setAttribute('aria-label', 'Open new tab');
  addBtn.addEventListener('click', () => {
    const active = getActiveTab();
    if (active) openTab(active.viewKey, { ...active.params }, active.label, true);
  });

  bar.appendChild(strip);
  bar.appendChild(addBtn);

  // Scroll active tab into view
  requestAnimationFrame(() => {
    strip.querySelector('.tab-item.active')
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  });
}

function _buildTabEl(tab) {
  const isActive = tab.id === _activeTabId;
  const canClose = _tabs.length > 1;

  const el = document.createElement('div');
  el.className = `tab-item${isActive ? ' active' : ''}`;
  el.setAttribute('role', 'tab');
  el.setAttribute('aria-selected', String(isActive));
  el.dataset.tabId = tab.id;
  el.title    = tab.label;
  el.draggable = true;

  // Icon
  const iconSpan = document.createElement('span');
  iconSpan.className   = 'tab-icon';
  iconSpan.setAttribute('aria-hidden', 'true');
  iconSpan.textContent = tab.icon || '📄';

  // Label
  const labelSpan = document.createElement('span');
  labelSpan.className   = 'tab-label';
  labelSpan.textContent = tab.label;

  el.appendChild(iconSpan);
  el.appendChild(labelSpan);

  // ⋯ Dots menu button — visible on hover, opens context menu
  // More discoverable than right-click; always present for accessibility
  const dotsBtn = document.createElement('button');
  dotsBtn.className   = 'tab-dots';
  dotsBtn.textContent = '⋯';
  dotsBtn.setAttribute('aria-label', `Tab options for ${tab.label}`);
  dotsBtn.title = 'Tab options';
  dotsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const rect = dotsBtn.getBoundingClientRect();
    _showTabContextMenu(tab, rect.left, rect.bottom + 2);
  });
  el.appendChild(dotsBtn);

  // Close button (hidden when only one tab remains)
  if (canClose) {
    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close';
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('aria-label', `Close ${tab.label}`);
    closeBtn.title = 'Close tab  (Ctrl+W or middle-click)';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });
    el.appendChild(closeBtn);
  }

  // Left-click → switch tab (skip button clicks)
  el.addEventListener('click', (e) => {
    if (e.target.closest('.tab-close, .tab-dots')) return;
    if (tab.id !== _activeTabId) switchTab(tab.id);
  });

  // Middle-click → close tab
  el.addEventListener('mousedown', (e) => {
    if (e.button === 1) { e.preventDefault(); closeTab(tab.id); }
  });

  // Right-click → same context menu
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    _showTabContextMenu(tab, e.clientX, e.clientY);
  });

  // ── Drag to reorder ──
  el.addEventListener('dragstart', (e) => {
    _dragTabId = tab.id;
    el.classList.add('tab-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tab.id);
  });

  el.addEventListener('dragend', () => {
    el.classList.remove('tab-dragging');
    document.querySelectorAll('.tab-item').forEach(t => t.classList.remove('tab-drag-over'));
    _dragTabId = null;
  });

  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (_dragTabId && _dragTabId !== tab.id) {
      document.querySelectorAll('.tab-item').forEach(t => t.classList.remove('tab-drag-over'));
      el.classList.add('tab-drag-over');
    }
  });

  el.addEventListener('dragleave', () => { el.classList.remove('tab-drag-over'); });

  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('tab-drag-over');
    if (!_dragTabId || _dragTabId === tab.id) return;
    const fromIdx = _tabs.findIndex(t => t.id === _dragTabId);
    const toIdx   = _tabs.findIndex(t => t.id === tab.id);
    if (fromIdx === -1 || toIdx === -1) return;
    const [moved] = _tabs.splice(fromIdx, 1);
    _tabs.splice(toIdx, 0, moved);
    _renderTabBar();
    _save();
    emit(TAB_EVENTS.TABS_REORDERED, { tabs: [..._tabs] });
  });

  return el;
}
