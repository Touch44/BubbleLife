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
import { on, EVENTS }           from '../core/events.js';
import { getAllEntityTypes }     from '../core/graph-engine.js';
import {
  getActiveContext, setActiveContext,
} from '../core/context.js';
import {
  initGraph, destroyGraph, setActiveTypes,
  refreshGraph, getAllGraphVisibleTypes, getActiveNodeTypes,
} from '../components/graph-canvas.js';

// ── Module state ───────────────────────────────────────────────
let _mounted       = false;       // true after first initGraph() call
let _graphEl       = null;        // #view-graph container
let _canvasEl      = null;        // <canvas> inside view

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
    #view-graph.active {
      padding: 0;
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }

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
      gap: 3px;
      padding: 3px 9px;
      border-radius: 999px;
      border: 1.5px solid var(--color-border);
      background: var(--color-surface);
      color: var(--color-text-muted);
      font-size: var(--text-xs);
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s, color 0.15s;
      white-space: nowrap;
    }
    .gv-type-chip:hover {
      border-color: var(--color-text-muted);
      color: var(--color-text);
    }
    .gv-type-chip.active {
      border-color: var(--color-border);
      background: var(--color-surface-2);
      color: var(--color-text);
    }
    .gv-type-chip .gv-type-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
    }

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

    btn.addEventListener('click', () => {
      // Update active context globally — graph-canvas filterByContext will pick it up
      setActiveContext(chip.key);
      // Update chip UI immediately (context:changed will also trigger refresh)
      ctxRow.querySelectorAll('.gv-ctx-chip').forEach(b => {
        const isActive = b.dataset.ctx === chip.key;
        b.classList.toggle('active', isActive);
        b.setAttribute('aria-pressed', String(isActive));
      });
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

      // Collect current active types and update graph
      const active = new Set(
        [...typeRow.querySelectorAll('.gv-type-chip.active')].map(b => b.dataset.typeKey)
      );
      setActiveTypes(active);
    });

    typeRow.appendChild(btn);
  }
  toolbar.appendChild(typeRow);

  container.appendChild(toolbar);
}

// ── Main render ────────────────────────────────────────────────

async function renderGraph(params = {}) {
  _graphEl = document.getElementById('view-graph');
  if (!_graphEl) return;

  // Determine initial active types
  const allVisibleTypes = getAllGraphVisibleTypes();

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
      <div class="gv-empty-icon">◎</div>
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
on(EVENTS.ENTITY_SAVED, () => {
  if (_mounted && _graphEl?.classList.contains('active')) {
    refreshGraph().then(_updateEmptyState).catch(() => {});
  }
});

on(EVENTS.ENTITY_DELETED, () => {
  if (_mounted && _graphEl?.classList.contains('active')) {
    refreshGraph().then(_updateEmptyState).catch(() => {});
  }
});

// ── Registration ───────────────────────────────────────────────
registerView('graph', renderGraph);

export { renderGraph };
