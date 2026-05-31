/**
 * components/related-panel.js
 * KLRE — "Related" section rendered at the bottom of the entity panel.
 * Fetches suggestions from klre-engine, renders confirmed/suggested groups,
 * handles user confirm/dismiss actions.
 * [v6.6.0]
 */

import { getSuggestions, confirmSuggestion, dismissSuggestion } from '../services/klre-engine.js';
// openPanel loaded dynamically to break circular dep with entity-panel.js
import { getSetting } from '../core/db.js';
import { on, EVENTS } from '../core/events.js';

// ── Module state ──────────────────────────────────────────── //
let _currentEntityId    = null;
let _container          = null; // DOM reference for refresh()
let _listenersRegistered = false;
let _refreshTimer       = null; // debounce handle — prevents rapid re-renders

// ── HTML escaping (defined locally — never import) ─────────── //
function _esc(str) {
  return String(str || '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}

// ── Panel navigation (dynamic import breaks circular dependency) ─ //
/** Open an entity panel. Loaded lazily to avoid entity-panel ↔ related-panel cycle. */
async function _openPanel(entityId) {
  try {
    const { openPanel } = await import('../components/entity-panel.js');
    openPanel(entityId);
  } catch (e) {
    console.warn('[KLRE] Could not open panel:', e);
    // H1: Give user visible feedback instead of silent failure
    const toast = document.createElement('div');
    toast.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#f06a5a;color:#fff;' +
      'padding:10px 16px;border-radius:8px;font-size:13px;z-index:9999;pointer-events:none;';
    toast.textContent = 'Could not open item — try refreshing';
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }
}

// ── Style injection ───────────────────────────────────────── //
function _injectStyles() {
  if (document.getElementById('klre-related-styles')) return;
  const style = document.createElement('style');
  style.id = 'klre-related-styles';
  style.textContent = `
    .klre-related-section{margin-top:24px;padding-top:20px;border-top:1px solid var(--color-border)}
    .klre-section-header{display:flex;align-items:center;justify-content:space-between;
      margin-bottom:12px;cursor:pointer;user-select:none}
    .klre-section-label{font-size:12px;font-weight:700;text-transform:uppercase;
      letter-spacing:.07em;color:var(--color-text-muted);display:flex;align-items:center;gap:6px}
    .klre-count-badge{background:var(--color-bg-3);border:1px solid var(--color-border);
      border-radius:100px;font-size:11px;padding:1px 7px;color:var(--color-text-muted)}
    .klre-toggle{font-size:11px;color:var(--color-text-muted)}
    .klre-group-label{font-size:10px;font-weight:700;text-transform:uppercase;
      letter-spacing:.08em;margin:10px 0 6px;display:flex;align-items:center;gap:8px}
    .klre-group-label::after{content:'';flex:1;height:1px;background:var(--color-border)}
    .klre-confirmed-label{color:#3ecfb0}
    .klre-suggested-label{color:var(--color-accent)}
    .klre-item{display:flex;align-items:flex-start;gap:10px;padding:9px 10px;
      border-radius:8px;border:1px solid var(--color-border);margin-bottom:6px;
      cursor:pointer;transition:border-color .15s;background:var(--color-bg-2)}
    .klre-item:hover{border-color:var(--color-accent)}
    .klre-item.confirmed{border-color:rgba(62,207,176,.35)}
    .klre-item-type{font-size:10px;font-weight:700;text-transform:uppercase;
      letter-spacing:.06em;color:var(--color-text-muted);min-width:58px;flex-shrink:0;padding-top:1px}
    .klre-item-body{flex:1;min-width:0}
    .klre-item-title{font-size:13px;color:var(--color-text);font-weight:500;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .klre-item-reason{font-size:11px;color:var(--color-text-muted);margin-top:2px}
    .klre-score-bar{height:2px;border-radius:1px;background:rgba(255,255,255,.08);
      margin-top:5px;overflow:hidden}
    .klre-score-high{height:100%;background:#3ecfb0;border-radius:1px}
    .klre-score-mid {height:100%;background:#f0b429;border-radius:1px}
    .klre-score-low {height:100%;background:#888;border-radius:1px}
    .klre-actions{display:flex;flex-direction:column;gap:4px;flex-shrink:0}
    .klre-btn{font-size:11px;padding:3px 8px;border-radius:6px;border:1px solid;
      cursor:pointer;background:transparent;transition:background .15s;white-space:nowrap}
    .klre-btn-link{border-color:rgba(62,207,176,.4);color:#3ecfb0}
    .klre-btn-link:hover{background:rgba(62,207,176,.1)}
    .klre-btn-dismiss{border-color:var(--color-border);color:var(--color-text-muted)}
    .klre-btn-dismiss:hover{background:var(--color-bg-3)}
    .klre-empty{font-size:13px;color:var(--color-text-muted);text-align:center;padding:16px 0}
    .klre-show-more{font-size:12px;color:var(--color-accent);cursor:pointer;
      text-align:center;padding:6px 0}
    .klre-skeleton-line{height:14px;border-radius:4px;background:var(--color-bg-3);
      margin-bottom:8px;animation:klre-shimmer 1.2s ease infinite}
    @keyframes klre-shimmer{0%{opacity:.5}50%{opacity:1}100%{opacity:.5}}
  `;
  document.head.appendChild(style);
}

// ── Public: init ──────────────────────────────────────────── //

/**
 * Initialise listeners. Call once from initEntityPanel().
 */
export function initRelatedPanel() {
  if (_listenersRegistered) return;
  _listenersRegistered = true;

  // Refresh when the currently-viewed entity is saved
  on(EVENTS.ENTITY_SAVED, (entity) => {
    if (entity && entity.id === _currentEntityId) refresh();
  });

  // Refresh when any entity's index is updated. Debounced 300ms.
  on(EVENTS.KLRE_INDEX_UPDATED, () => {
    if (!_container || !_currentEntityId) return;
    clearTimeout(_refreshTimer);
    _refreshTimer = setTimeout(() => refresh(), 300);
  });

  // C1: Also refresh when the full index build completes (KLRE_INDEX_READY).
  // Users who open Related tab before index builds get stale "no items" result.
  // A 500ms debounce avoids triggering while index is still writing final chunks.
  on(EVENTS.KLRE_INDEX_READY, () => {
    if (!_container || !_currentEntityId) return;
    clearTimeout(_refreshTimer);
    _refreshTimer = setTimeout(() => refresh(), 500);
  });
}

// ── Public: render ────────────────────────────────────────── //

/**
 * Render the Related section into containerEl for the given entityId.
 * Clears any existing content, shows a skeleton while loading.
 * @param {HTMLElement} containerEl
 * @param {string} entityId
 */
export async function renderRelatedPanel(containerEl, entityId) {
  // H2: Guard against invalid inputs
  if (!containerEl || !entityId || typeof entityId !== 'string') return;

  // Check master panel toggle
  const enabled = await getSetting('klre_panel_enabled');
  if (enabled === false) return;

  _injectStyles();

  // Store references for refresh()
  _currentEntityId = entityId;
  _container       = containerEl;

  // Clear any stale content
  containerEl.innerHTML = '';

  // Show skeleton immediately
  const skeleton = document.createElement('div');
  skeleton.className = 'klre-related-section';
  skeleton.innerHTML = `
    <div class="klre-section-label" style="margin-bottom:12px;">
      Related <span class="klre-count-badge">…</span>
    </div>
    <div class="klre-skeleton-line" style="width:80%"></div>
    <div class="klre-skeleton-line" style="width:60%"></div>
    <div class="klre-skeleton-line" style="width:70%"></div>
  `;
  containerEl.appendChild(skeleton);

  // Fetch suggestions async (panel is already showing skeleton)
  let items;
  try {
    items = await getSuggestions(entityId, { maxResults: 8, includeConfirmed: true });
  } catch (e) {
    console.warn('[KLRE] renderRelatedPanel: getSuggestions failed:', e);
    containerEl.innerHTML = '<div class="klre-empty">Could not load related items.</div>';
    return;
  }

  // Guard: entity may have changed while we were awaiting
  if (_currentEntityId !== entityId) return;

  _renderItems(containerEl, entityId, items);
}

// ── Private: render items ─────────────────────────────────── //

function _renderItems(containerEl, entityId, items) {
  containerEl.innerHTML = '';

  const confirmed = items.filter(i => i.status === 'confirmed');
  const suggested = items.filter(i => i.status === 'suggested');
  const total = confirmed.length + suggested.length;

  // Collapsed state
  const isCollapsed = localStorage.getItem('klre_collapsed') === 'true';

  const section = document.createElement('div');
  section.className = 'klre-related-section';

  // ── Header (toggle) ──────────────────────────────────────
  const header = document.createElement('div');
  header.className = 'klre-section-header';
  header.innerHTML = `
    <span class="klre-section-label">
      Related <span class="klre-count-badge">${total}</span>
    </span>
    <span class="klre-toggle">${isCollapsed ? '▸' : '▾'}</span>
  `;
  header.addEventListener('click', () => {
    const collapsed = localStorage.getItem('klre_collapsed') === 'true';
    localStorage.setItem('klre_collapsed', String(!collapsed));
    // B16: Use refresh() instead of _renderItems(items) to get fresh suggestions
    // when expanding. The closure `items` could be stale if entities were saved
    // while the panel was collapsed.
    if (!collapsed) {
      // Was expanded, now collapsing — re-render collapsed state locally (fast)
      _renderItems(containerEl, entityId, items);
    } else {
      // Was collapsed, now expanding — fetch fresh suggestions
      renderRelatedPanel(containerEl, entityId);
    }
  });
  section.appendChild(header);

  if (isCollapsed) {
    containerEl.appendChild(section);
    return;
  }

  const body = document.createElement('div');

  // ── Confirmed group ──────────────────────────────────────
  if (confirmed.length) {
    const confirmedLabel = document.createElement('div');
    confirmedLabel.className = 'klre-group-label klre-confirmed-label';
    confirmedLabel.textContent = '✓ Linked';
    body.appendChild(confirmedLabel);

    for (const item of confirmed) {
      const row = document.createElement('div');
      row.className = 'klre-item confirmed';
      row.innerHTML = `
        <div class="klre-item-type">${_esc(item.candidateType)}</div>
        <div class="klre-item-body">
          <div class="klre-item-title">${_esc(item.candidateTitle)}</div>
        </div>
      `;
      row.addEventListener('click', () => _openPanel(item.candidateId));
      body.appendChild(row);
    }
  }

  // ── Suggested group ──────────────────────────────────────
  if (suggested.length) {
    const suggestedLabel = document.createElement('div');
    suggestedLabel.className = 'klre-group-label klre-suggested-label';
    suggestedLabel.textContent = '✦ Suggested';
    body.appendChild(suggestedLabel);

    for (const item of suggested) {
      const scoreClass = item.score >= 0.7 ? 'klre-score-high'
                       : item.score >= 0.4 ? 'klre-score-mid'
                       : 'klre-score-low';
      const scoreWidth = Math.round((item.score || 0) * 100);

      const row = document.createElement('div');
      row.className = 'klre-item';

      const bodyDiv = document.createElement('div');
      bodyDiv.className = 'klre-item-body';
      bodyDiv.innerHTML = `
        <div class="klre-item-title">${_esc(item.candidateTitle)}</div>
        ${item.reasonText ? `<div class="klre-item-reason">${_esc(item.reasonText)}</div>` : ''}
        <div class="klre-score-bar"><div class="${scoreClass}" style="width:${scoreWidth}%"></div></div>
      `;
      bodyDiv.addEventListener('click', () => _openPanel(item.candidateId));

      const typeDiv = document.createElement('div');
      typeDiv.className = 'klre-item-type';
      typeDiv.textContent = item.candidateType;

      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'klre-actions';

      const linkBtn = document.createElement('button');
      linkBtn.className = 'klre-btn klre-btn-link';
      linkBtn.textContent = '+ Link';
      linkBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        linkBtn.disabled = true;
        linkBtn.textContent = '…';
        await confirmSuggestion(entityId, item.candidateId);
        // Re-render with fresh suggestions
        renderRelatedPanel(containerEl, entityId);
      });

      const dismissBtn = document.createElement('button');
      dismissBtn.className = 'klre-btn klre-btn-dismiss';
      dismissBtn.textContent = '✕';
      dismissBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        dismissBtn.disabled = true;
        await dismissSuggestion(entityId, item.candidateId);
        // B15: Safe fade-out — check row is still in DOM before removing
        row.style.transition = 'opacity 0.2s';
        row.style.opacity = '0';
        setTimeout(() => {
          // row.isConnected is true only when attached to the live DOM
          if (row.isConnected) row.remove();
        }, 220);
      });

      actionsDiv.appendChild(linkBtn);
      actionsDiv.appendChild(dismissBtn);

      row.appendChild(typeDiv);
      row.appendChild(bodyDiv);
      row.appendChild(actionsDiv);
      body.appendChild(row);
    }

    // Show-more link if suggested items hit the maxResults cap (8)
    if (suggested.length >= 7) {
      const moreLink = document.createElement('div');
      moreLink.className = 'klre-show-more';
      moreLink.textContent = 'Show more →';
      moreLink.addEventListener('click', async () => {
        moreLink.textContent = 'Loading…';
        // S5: Force recompute with no type cap to surface all possible suggestions
        const moreItems = await getSuggestions(entityId, {
          maxResults: 50,
          includeConfirmed: true,
          forceRecompute: true,
          minScore: 0.05,
        });
        _renderItems(containerEl, entityId, moreItems);
      });
      body.appendChild(moreLink);
    }
  }

  // ── Empty state ──────────────────────────────────────────
  if (total === 0) {
    const empty = document.createElement('div');
    empty.className = 'klre-empty';
    empty.textContent = 'No related items found yet.';
    body.appendChild(empty);
  }

  section.appendChild(body);
  containerEl.appendChild(section);
}

// ── Public: refresh ───────────────────────────────────────── //

/**
 * Re-render the related panel using the stored container and entityId.
 */
export function refresh() {
  // C5: Only refresh if container is still attached to the live document
  if (_container && _currentEntityId && document.contains(_container)) {
    renderRelatedPanel(_container, _currentEntityId);
  } else if (_container && !document.contains(_container)) {
    // Container is detached — clear references to prevent memory leak
    _container       = null;
    _currentEntityId = null;
  }
}
