/**
 * FamilyHub v3 — views/graph-view.js
 * [MAJOR] CS-06 — Knowledge Graph View with Context Filter Chips
 *
 * Mounts the graph-canvas inside the #view-graph container and adds:
 *   - Context filter chips (All / Family / Personal / Business)
 *   - Entity type filter toggle chips (matching graphVisible types)
 *   - Re-renders graph on context:changed
 *
 * Architecture:
 *   - Context chips set a LOCAL context override (like daily.js D-04)
 *   - graph-canvas.js already calls filterByContext(entities) in _buildGraph
 *     so changing context then calling refreshGraph() is sufficient
 *   - Type chips call setActiveTypes() on the graph-canvas
 *
 * Registration: registerView('graph', renderGraph)
 */

import { registerView }         from '../core/router.js';
import { on, emit, EVENTS }     from '../core/events.js';
import { getAllEntityTypes, getEntityTypeConfig } from '../core/graph-engine.js';
import {
  getActiveContext, setActiveContext,
} from '../core/context.js';
import {
  initGraph, destroyGraph, setActiveTypes,
  refreshGraph, getAllGraphVisibleTypes, getActiveNodeTypes, setFocusId, zoomBy,
} from '../components/graph-canvas.js';

// ── Module state ───────────────────────────────────────────────
let _mounted       = false;       // true after first initGraph() call
let _graphEl       = null;        // #view-graph container
let _canvasEl      = null;        // <canvas> inside view
let _savedTypeSet  = null;        // persists active type selections across re-navigation

// ── Constants ──────────────────────────────────────────────────
const CONTEXT_CHIPS = [
  { key: 'all',      label: 'All',      icon: '🌐' },
  { key: 'family',   label: 'Family',   icon: '🏠' },
  { key: 'personal', label: 'Personal', icon: '👤' },
  { key: 'business', label: 'Business', icon: '💼' },
];

// ── Inject styles once ─────────────────────────────────────────
(function _injectStyles() {
  if (document.getElementById('graph-view-styles')) return;
  const s = document.createElement('style');
  s.id = 'graph-view-styles';
  s.textContent = `
    /* ── Graph view shell — height/flex owned by layout.css ── */

    /* ── Graph toolbar ─────────────────────────────── */
    .gv-toolbar {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      flex-wrap: wrap;
      padding: var(--space-2-5) var(--space-4);
      border-bottom: 1px solid var(--color-border);
      background: var(--color-bg);
      flex-shrink: 0;
      z-index: 5;
    }

    /* ── Context chips ─────────────────────────────── */
    .gv-ctx-chips {
      display: flex;
      gap: var(--space-1);
      align-items: center;
    }
    .gv-ctx-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 10px;
      border-radius: 999px;
      border: 1.5px solid var(--color-border);
      background: var(--color-surface);
      color: var(--color-text-muted);
      font-size: var(--text-xs);
      font-weight: var(--weight-semibold);
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s, color 0.15s;
      white-space: nowrap;
      line-height: 1;
    }
    .gv-ctx-chip:hover {
      border-color: var(--color-accent);
      color: var(--color-accent);
    }
    .gv-ctx-chip.active {
      background: var(--color-accent);
      border-color: var(--color-accent);
      color: #fff;
    }

    .gv-divider {
      width: 1px;
      height: 20px;
      background: var(--color-border);
      flex-shrink: 0;
    }

    /* ── Type filter chips ─────────────────────────── */
    .gv-type-chips {
      display: flex;
      gap: var(--space-1);
      flex-wrap: wrap;
      align-items: center;
      flex: 1;
    }
    .gv-type-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 10px 3px 7px;
      border-radius: 999px;
      border: 1.5px solid var(--color-border);
      background: var(--color-surface);
      color: var(--color-text-muted);
      font-size: var(--text-xs);
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s, color 0.15s, opacity 0.15s;
      white-space: nowrap;
      opacity: 0.45;
      font-weight: var(--weight-medium);
    }
    .gv-type-chip:hover {
      opacity: 0.75;
      border-color: var(--color-text-muted);
      color: var(--color-text);
    }
    .gv-type-chip.active {
      opacity: 1;
      border-color: var(--gv-chip-color, var(--color-accent));
      background: var(--gv-chip-color, var(--color-accent));
      color: #fff;
      font-weight: var(--weight-semibold);
    }
    .gv-type-chip .gv-type-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
      transition: background 0.15s;
    }
    /* When active: dot becomes white so it's visible on the colored background */
    .gv-type-chip.active .gv-type-dot {
      background: rgba(255,255,255,0.55) !important;
      outline: 1.5px solid rgba(255,255,255,0.35);
      outline-offset: 0px;
    }

    /* ── Focus search ──────────────────────────────── */
    .gv-focus-wrap {
      position: relative;
      flex-shrink: 0;
    }
    .gv-focus-input {
      padding: 4px 10px;
      font-size: var(--text-xs);
      border: 1.5px solid var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-surface);
      color: var(--color-text);
      width: 180px;
      outline: none;
      transition: border-color 0.15s;
    }
    .gv-focus-input:focus { border-color: var(--color-accent); }
    .gv-focus-suggestions {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      min-width: 220px;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      box-shadow: 0 4px 16px rgba(0,0,0,0.18);
      z-index: 100;
      overflow: hidden;
    }
    .gv-focus-option {
      padding: 6px 12px;
      font-size: var(--text-xs);
      color: var(--color-text);
      cursor: pointer;
    }
    .gv-focus-option:hover { background: var(--color-surface-2, rgba(255,255,255,0.05)); }

    /* ── Zoom buttons ──────────────────────────────── */
    .gv-zoom-btns {
      display: flex;
      gap: 2px;
      align-items: center;
      flex-shrink: 0;
    }
    .gv-zoom-btn {
      width: 28px;
      height: 28px;
      border: 1.5px solid var(--color-border);
      border-radius: var(--radius-sm);
      background: var(--color-surface);
      color: var(--color-text);
      font-size: 1rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: border-color 0.15s, background 0.15s;
    }
    .gv-zoom-btn:hover { border-color: var(--color-accent); background: var(--color-surface-2, rgba(255,255,255,0.05)); }
    .gv-zoom-reset { font-size: 0.9rem; }

    /* ── Canvas container ──────────────────────────── */
    .gv-canvas-wrap {
      flex: 1;
      position: relative;
      overflow: hidden;
      min-height: 0;
    }
    .gv-canvas-wrap canvas {
      display: block;
      width: 100%;
      height: 100%;
    }

    /* ── Empty state ───────────────────────────────── */
    .gv-empty {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: var(--color-text-muted);
      font-size: var(--text-sm);
      gap: var(--space-2);
      pointer-events: none;
    }
    .gv-empty-icon {
      font-size: 2.5rem;
      opacity: 0.3;
    }
  `;
  document.head.appendChild(s);
})();

// ── Helpers ────────────────────────────────────────────────────

function _esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Build toolbar ──────────────────────────────────────────────

function _buildToolbar(container, activeTypeSet) {
  const toolbar = document.createElement('div');
  toolbar.className = 'gv-toolbar';
  toolbar.id = 'gv-toolbar';

  // ── Context chips
  const ctxRow = document.createElement('div');
  ctxRow.className = 'gv-ctx-chips';
  ctxRow.setAttribute('role', 'group');
  ctxRow.setAttribute('aria-label', 'Context filter');

  const currentCtx = getActiveContext();

  for (const chip of CONTEXT_CHIPS) {
    const btn = document.createElement('button');
    btn.className = 'gv-ctx-chip' + (chip.key === currentCtx ? ' active' : '');
    btn.dataset.ctx = chip.key;
    btn.setAttribute('aria-pressed', String(chip.key === currentCtx));
    btn.title = `Show ${chip.label} context`;
    btn.innerHTML = `${chip.icon} <span>${chip.label}</span>`;

    btn.addEventListener('click', async () => {
      const prevCtx = getActiveContext();
      // Update chip UI optimistically
      ctxRow.querySelectorAll('.gv-ctx-chip').forEach(b => {
        const isActive = b.dataset.ctx === chip.key;
        b.classList.toggle('active', isActive);
        b.setAttribute('aria-pressed', String(isActive));
      });
      setActiveContext(chip.key);
      // context:changed event triggers refreshGraph — but if it fails, revert chip
      try {
        await refreshGraph();
        _updateEmptyState();
      } catch (err) {
        console.warn('[graph-view] context refresh failed:', err);
        // Revert context and chip state
        setActiveContext(prevCtx);
        ctxRow.querySelectorAll('.gv-ctx-chip').forEach(b => {
          const isActive = b.dataset.ctx === prevCtx;
          b.classList.toggle('active', isActive);
          b.setAttribute('aria-pressed', String(isActive));
        });
      }
    });

    ctxRow.appendChild(btn);
  }
  toolbar.appendChild(ctxRow);

  // ── Divider
  const div = document.createElement('div');
  div.className = 'gv-divider';
  toolbar.appendChild(div);

  // ── Type chips
  const typeRow = document.createElement('div');
  typeRow.className = 'gv-type-chips';
  typeRow.setAttribute('role', 'group');
  typeRow.setAttribute('aria-label', 'Entity type filter');

  const allTypes = getAllEntityTypes().filter(t => t.graphVisible);

  for (const typeConfig of allTypes) {
    const isActive = activeTypeSet.has(typeConfig.key);
    const btn = document.createElement('button');
    btn.className = 'gv-type-chip' + (isActive ? ' active' : '');
    btn.dataset.typeKey = typeConfig.key;
    btn.setAttribute('aria-pressed', String(isActive));
    btn.title = isActive ? `Hide ${typeConfig.label}` : `Show ${typeConfig.label}`;
    // Set CSS variable for this chip's entity-type color
    if (typeConfig.color) {
      btn.style.setProperty('--gv-chip-color', typeConfig.color);
    }
    btn.innerHTML = `
      <span class="gv-type-dot" style="background:${typeConfig.color || 'var(--color-border)'}"></span>
      <span>${_esc(typeConfig.icon || '')} ${_esc(typeConfig.label)}</span>
    `;

    btn.addEventListener('click', () => {
      const wasActive = btn.classList.contains('active');
      btn.classList.toggle('active', !wasActive);
      btn.setAttribute('aria-pressed', String(!wasActive));
      // Fix 7: update title tooltip to reflect new state
      btn.title = wasActive ? `Show ${typeConfig.label}` : `Hide ${typeConfig.label}`;

      // Collect current active types and update graph + persist for re-navigation
      const active = new Set(
        [...typeRow.querySelectorAll('.gv-type-chip.active')].map(b => b.dataset.typeKey)
      );
      _savedTypeSet = active;
      setActiveTypes(active);
    });

    typeRow.appendChild(btn);
  }
  toolbar.appendChild(typeRow);

  // ── Divider before action buttons
  const div2 = document.createElement('div');
  div2.className = 'gv-divider';
  toolbar.appendChild(div2);

  // ── Focus search input
  const focusWrap = document.createElement('div');
  focusWrap.className = 'gv-focus-wrap';
  focusWrap.innerHTML = `
    <input
      type="search"
      id="gv-focus-input"
      class="gv-focus-input"
      placeholder="Focus on entity…"
      autocomplete="off"
      aria-label="Focus graph on entity"
    />
    <div id="gv-focus-suggestions" class="gv-focus-suggestions" hidden></div>
  `;
  toolbar.appendChild(focusWrap);

  // Wire focus input: on Enter or selection → setFocusId
  const focusInput = focusWrap.querySelector('#gv-focus-input');
  const focusSugg  = focusWrap.querySelector('#gv-focus-suggestions');

  let _focusDebounce = null;
  focusInput.addEventListener('input', () => {
    clearTimeout(_focusDebounce);
    const q = focusInput.value.trim().toLowerCase();
    if (!q) { focusSugg.hidden = true; focusSugg.innerHTML = ''; return; }
    _focusDebounce = setTimeout(async () => {
      try {
        const { getEntitiesByType } = await import('../core/db.js');
        const allTypes = getAllEntityTypes().filter(t => t.graphVisible).map(t => t.key);
        const allEntities = (await Promise.all(allTypes.map(t => getEntitiesByType(t).catch(() => [])))).flat();
        const matches = allEntities
          .filter(e => !e.deleted && (e.title || e.name || '').toLowerCase().includes(q))
          .slice(0, 8);
        if (!matches.length) { focusSugg.hidden = true; return; }
        focusSugg.innerHTML = matches.map(e => {
          const cfg = getEntityTypeConfig(e.type) || {};
          return `<div class="gv-focus-option" data-entity-id="${_esc(e.id)}">${_esc(cfg.icon || '')} ${_esc(e.title || e.name || '(Untitled)')}</div>`;
        }).join('');
        focusSugg.hidden = false;
      } catch { focusSugg.hidden = true; }
    }, 200);
  });

  focusSugg.addEventListener('click', async e => {
    const opt = e.target.closest('.gv-focus-option');
    if (!opt) return;
    focusInput.value = opt.textContent.trim();
    focusSugg.hidden = true;
    try {
      await setFocusId(opt.dataset.entityId);
    } catch (err) {
      console.warn('[graph-view] setFocusId failed:', err);
    }
  });

  focusInput.addEventListener('blur', () => setTimeout(() => { focusSugg.hidden = true; }, 150));

  // Also close on outside click (catches cases where blur doesn't fire)
  const _closeFocusSugg = (e) => {
    if (!focusWrap.contains(e.target)) focusSugg.hidden = true;
  };
  document.addEventListener('click', _closeFocusSugg);
  // Clean up listener when graph view unmounts
  const _origUnmount = window._gvCleanup || null;
  window._gvCleanup = () => {
    document.removeEventListener('click', _closeFocusSugg);
    if (_origUnmount) _origUnmount();
  };

  // ── Divider
  const div3 = document.createElement('div');
  div3.className = 'gv-divider';
  toolbar.appendChild(div3);

  // ── Zoom + Reset buttons
  const zoomWrap = document.createElement('div');
  zoomWrap.className = 'gv-zoom-btns';
  zoomWrap.innerHTML = `
    <button class="gv-zoom-btn" id="gv-zoom-in"  title="Zoom in">+</button>
    <button class="gv-zoom-btn" id="gv-zoom-out" title="Zoom out">−</button>
    <button class="gv-zoom-btn gv-zoom-reset" id="gv-zoom-reset" title="Reset layout">↺</button>
  `;
  toolbar.appendChild(zoomWrap);

  // Use direct zoomBy API for clean, reliable zooming
  const _doZoom = (zoomIn) => {
    const steps = 6;
    let i = 0;
    const factor = zoomIn ? 1.10 : 0.91;
    const step = () => {
      zoomBy(factor);
      if (++i < steps) requestAnimationFrame(step);
    };
    step();
  };
  zoomWrap.querySelector('#gv-zoom-in').addEventListener('click',  () => _doZoom(true));
  zoomWrap.querySelector('#gv-zoom-out').addEventListener('click', () => _doZoom(false));
  zoomWrap.querySelector('#gv-zoom-reset').addEventListener('click', async () => {
    _savedTypeSet = null; // clear type selection → next render restores all types
    try { await refreshGraph(); } catch { /* ignore */ }
  });

  container.appendChild(toolbar);
}

// ── Main render ────────────────────────────────────────────────

async function renderGraph(params = {}) {
  _graphEl = document.getElementById('view-graph');
  if (!_graphEl) return;

  // Determine initial active types — restore user's previous selection if any
  const allVisibleTypes = _savedTypeSet || getAllGraphVisibleTypes();

  // On first mount build the full UI; on subsequent calls just refresh the graph
  if (!params._internal || !_mounted) {
    _graphEl.innerHTML = '';
    _mounted = false;

    // Toolbar
    _buildToolbar(_graphEl, allVisibleTypes);

    // Canvas wrap
    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'gv-canvas-wrap';
    canvasWrap.id = 'gv-canvas-wrap';

    _canvasEl = document.createElement('canvas');
    _canvasEl.id = 'gv-canvas';
    canvasWrap.appendChild(_canvasEl);

    // Empty state (shown by graph-canvas when no nodes)
    const emptyEl = document.createElement('div');
    emptyEl.className = 'gv-empty';
    emptyEl.id = 'gv-empty';
    emptyEl.innerHTML = `
      <div class="gv-empty-icon">🔮</div>
      <div>No entities to show in this context.</div>
      <div style="font-size:var(--text-xs);">Try switching context or adding entities first.</div>
    `;
    canvasWrap.appendChild(emptyEl);

    _graphEl.appendChild(canvasWrap);

    try {
      await initGraph(_canvasEl, { activeTypes: allVisibleTypes });
      _mounted = true;
      // Hide empty state if nodes loaded
      _updateEmptyState();
    } catch (err) {
      console.error('[graph-view] initGraph failed:', err);
    }
  } else {
    // Internal re-render (context change) — just rebuild the graph data
    try {
      await refreshGraph();
      _updateEmptyState();
    } catch (err) {
      console.warn('[graph-view] refreshGraph failed:', err);
    }
  }
}

function _updateEmptyState() {
  const emptyEl = document.getElementById('gv-empty');
  if (!emptyEl) return;
  // Fix 1: use getActiveNodeTypes() from graph-canvas (synchronous, always current)
  try {
    const nodeCount = getActiveNodeTypes().size;
    emptyEl.style.display = nodeCount === 0 ? 'flex' : 'none';
  } catch {
    emptyEl.style.display = 'none'; // on error, assume nodes exist
  }
}

// ── Module-level listeners ─────────────────────────────────────

// Fix 2: clean up graph when navigating away to prevent RAF leak
on(EVENTS.VIEW_CHANGED, ({ viewKey } = {}) => {
  if (viewKey !== 'graph' && _mounted) {
    try { destroyGraph(); } catch { /* ignore */ }
    _mounted = false;
    // Clean up any global event listeners added during graph view
    try { window._gvCleanup?.(); window._gvCleanup = null; } catch { /* ignore */ }
  }
});

// CS-06: Re-render graph on context change
on('context:changed', () => {
  if (_graphEl?.classList.contains('active')) {
    // Update context chip UI
    const currentCtx = getActiveContext();
    document.querySelectorAll('.gv-ctx-chip').forEach(b => {
      const isActive = b.dataset.ctx === currentCtx;
      b.classList.toggle('active', isActive);
      b.setAttribute('aria-pressed', String(isActive));
    });
    // Rebuild graph with new context filter
    renderGraph({ _internal: true });
  }
});

// Re-render when entities change
// ENTITY_SAVED: graph-canvas already has a debounced 800ms refreshGraph listener.
// graph-view only needs to update the empty-state indicator after refresh settles.
// Removing redundant immediate refreshGraph() call to avoid double rebuild.
on(EVENTS.ENTITY_SAVED, () => {
  const graphEl = _graphEl || document.getElementById('view-graph');
  if (_mounted && graphEl?.classList.contains('active')) {
    // Let canvas debounce handle the rebuild; just refresh empty state after delay
    setTimeout(_updateEmptyState, 900);
  }
});

on(EVENTS.ENTITY_DELETED, () => {
  const graphEl = _graphEl || document.getElementById('view-graph');
  if (_mounted && graphEl?.classList.contains('active')) {
    setTimeout(_updateEmptyState, 900);
  }
});

// ── Node click → open entity panel (sidebar graph view) ────────
// entity-panel.js handles these when _graphViewActive (opened from entity panel).
// When user navigates to graph via sidebar, we handle them here instead.
// Guard: if entity-panel is in graph-mode, it owns the events — don't double-handle.
function _isEntityPanelGraphMode() {
  return document.getElementById('entity-panel')?.classList.contains('graph-mode') ?? false;
}

on('graph:nodeSelected', ({ id } = {}) => {
  if (!id) return;
  if (!_graphEl?.classList.contains('active')) return;
  if (_isEntityPanelGraphMode()) return; // entity-panel.js handles it
  emit(EVENTS.PANEL_OPENED, { entityId: id });
});

on('graph:nodeFocused', ({ id } = {}) => {
  if (!id) return;
  // Double-click: graph-canvas already calls setFocusId internally.
  // We just need to open the panel for the focused node.
  if (!_graphEl?.classList.contains('active')) return;
  if (_isEntityPanelGraphMode()) return; // entity-panel.js handles it
  emit(EVENTS.PANEL_OPENED, { entityId: id });
});

// ── Registration ───────────────────────────────────────────────
registerView('graph', renderGraph);

export { renderGraph };
