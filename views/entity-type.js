/**
 * FamilyHub v3 — views/entity-type.js
 * [MAJOR] 2-A — Generic Entity Type View (Collections)
 *
 * Used for sidebar Collection items:
 *   Ideas, Research, Books, Trips, Places, Web Links, Goals, Habits, etc.
 *
 * Receives params.entityType (e.g. 'idea', 'book') from the router.
 * Reads the entity type config from graph-engine.js to render appropriate
 * fields, sorting, and labels.
 *
 * Modes: List (default) | Grid — toggled via view-switcher component.
 *
 * Registration: registerView('entity-type', renderEntityTypeView)
 */

import { registerView, navigate }              from '../core/router.js';
import { on, emit, EVENTS }               from '../core/events.js';
import { getEntitiesByType }               from '../core/db.js';
import { getEntityTypeConfig }             from '../core/graph-engine.js';
import { openForm }                        from '../components/entity-form.js';
import { createViewSwitcher }              from '../components/view-switcher.js';

// ── Module state ─────────────────────────────────────────────────
let _currentType = null;   // entityType currently rendered
let _currentMode = 'list'; // mode currently rendered ('list' | 'grid')
let _unsubList   = [];     // event unsub functions

// ── Inject CSS once ──────────────────────────────────────────────
(function _injectStyles() {
  if (document.getElementById('entity-type-view-styles')) return;
  const s = document.createElement('style');
  s.id = 'entity-type-view-styles';
  s.textContent = `
    /* ── View shell ──────────────────────────────────────── */
    #view-entity-type.active {
      padding: 0;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
    }

    /* ── Header bar ──────────────────────────────────────── */
    .etv-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--space-4) var(--space-6) var(--space-3);
      border-bottom: 1px solid var(--color-border);
      background: var(--color-bg);
      position: sticky;
      top: 0;
      z-index: 10;
      flex-shrink: 0;
      gap: var(--space-3);
      flex-wrap: wrap;
    }

    .etv-title {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      font-size: var(--text-xl);
      font-weight: var(--weight-bold);
      color: var(--color-text);
    }

    .etv-header-right {
      display: flex;
      align-items: center;
      gap: var(--space-3);
    }

    .etv-new-btn {
      display: flex;
      align-items: center;
      gap: var(--space-1);
      padding: 6px 14px;
      background: var(--color-accent);
      color: #fff;
      border: none;
      border-radius: var(--radius-md);
      font-size: var(--text-sm);
      font-weight: var(--weight-semibold);
      cursor: pointer;
      transition: opacity 0.15s;
      white-space: nowrap;
    }
    .etv-new-btn:hover { opacity: 0.88; }

    /* ── Content area ────────────────────────────────────── */
    .etv-body {
      flex: 1;
      padding: var(--space-4) var(--space-6);
      overflow-y: auto;
    }

    /* ── Empty state ─────────────────────────────────────── */
    .etv-empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: var(--space-10) var(--space-4);
      text-align: center;
      gap: var(--space-3);
    }
    .etv-empty-icon {
      font-size: 3rem;
      opacity: 0.5;
    }
    .etv-empty-title {
      font-size: var(--text-lg);
      font-weight: var(--weight-semibold);
      color: var(--color-text);
    }
    .etv-empty-sub {
      font-size: var(--text-sm);
      color: var(--color-text-muted);
    }
    .etv-empty-btn {
      margin-top: var(--space-2);
      padding: 8px 20px;
      background: var(--color-accent);
      color: #fff;
      border: none;
      border-radius: var(--radius-md);
      font-size: var(--text-sm);
      font-weight: var(--weight-semibold);
      cursor: pointer;
    }
    .etv-empty-btn:hover { opacity: 0.88; }

    /* ── List view ───────────────────────────────────────── */
    .etv-list {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }

    .etv-list-item {
      display: flex;
      align-items: flex-start;
      gap: var(--space-3);
      padding: var(--space-3) var(--space-4);
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
    }
    .etv-list-item:hover {
      border-color: var(--color-accent);
      background: var(--color-surface-2, var(--color-surface));
    }

    .etv-list-icon {
      font-size: 1.25rem;
      flex-shrink: 0;
      margin-top: 1px;
    }

    .etv-list-content {
      flex: 1;
      min-width: 0;
    }

    .etv-list-title {
      font-size: var(--text-sm);
      font-weight: var(--weight-semibold);
      color: var(--color-text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .etv-list-meta {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      margin-top: 3px;
    }

    .etv-list-field {
      font-size: var(--text-xs);
      color: var(--color-text-muted);
      display: flex;
      align-items: center;
      gap: 3px;
    }

    .etv-tag {
      display: inline-block;
      padding: 1px 6px;
      background: var(--color-accent-muted);
      color: var(--color-accent);
      border-radius: var(--radius-full);
      font-size: var(--text-xs);
      font-weight: var(--weight-medium);
    }

    .etv-list-date {
      font-size: var(--text-xs);
      color: var(--color-text-muted);
      flex-shrink: 0;
      white-space: nowrap;
      align-self: flex-start;
      margin-top: 2px;
    }

    /* ── Grid view ───────────────────────────────────────── */
    .etv-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: var(--space-3);
    }

    .etv-grid-card {
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-lg);
      padding: var(--space-4);
      cursor: pointer;
      transition: border-color 0.15s, transform 0.1s;
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
    .etv-grid-card:hover {
      border-color: var(--color-accent);
      transform: translateY(-1px);
    }

    .etv-grid-icon {
      font-size: 1.75rem;
    }

    .etv-grid-title {
      font-size: var(--text-sm);
      font-weight: var(--weight-bold);
      color: var(--color-text);
      line-height: 1.35;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .etv-grid-fields {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .etv-grid-field {
      font-size: var(--text-xs);
      color: var(--color-text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .etv-grid-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: auto;
    }

    .etv-mode-toggle {
      display: flex;
      gap: 2px;
      align-items: center;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      padding: 2px;
    }
    .etv-mode-btn {
      padding: 4px 8px;
      border: none;
      border-radius: calc(var(--radius-md) - 2px);
      background: transparent;
      color: var(--color-text-muted);
      font-size: var(--text-sm);
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
      line-height: 1;
    }
    .etv-mode-btn.active {
      background: var(--color-accent);
      color: #fff;
    }
    .etv-mode-btn:not(.active):hover {
      background: var(--color-surface-2, rgba(255,255,255,0.06));
      color: var(--color-text);
    }

    /* ── Count badge ─────────────────────────────────────── */
    .etv-count {
      display: inline-block;
      padding: 1px 7px;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-full);
      font-size: var(--text-xs);
      color: var(--color-text-muted);
      margin-left: var(--space-2);
    }
  `;
  document.head.appendChild(s);
})();

// ── Helpers ───────────────────────────────────────────────────────

function _esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Format a date string for display */
function _fmtDate(str) {
  if (!str) return '';
  try {
    const d = new Date(str + (str.length === 10 ? 'T00:00:00' : ''));
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return str; }
}

/** Sort entities by a field. Prefix '-' for descending. */
function _sortEntities(entities, defaultSort) {
  if (!defaultSort) return entities;
  const desc = defaultSort.startsWith('-');
  const field = desc ? defaultSort.slice(1) : defaultSort;
  return [...entities].sort((a, b) => {
    const va = a[field] ?? '';
    const vb = b[field] ?? '';
    if (va < vb) return desc ? 1 : -1;
    if (va > vb) return desc ? -1 : 1;
    return 0;
  });
}

/** Get the title field value for an entity */
function _getTitle(entity, config) {
  const titleField = config?.fields?.find(f => f.isTitle !== false && f.key === 'title')
    || config?.fields?.find(f => f.isTitle !== false && ['name', 'title', 'question', 'heading'].includes(f.key))
    || config?.fields?.[0];
  return titleField ? (entity[titleField.key] || '') : '';
}

/** Get 2-3 key scalar fields to show in list/grid (non-title, non-richtext) */
function _getKeyFields(entity, config) {
  if (!config?.fields) return [];
  const skipKeys = new Set(['title', 'name', 'tags', 'photoUrl', 'imageUrl']);
  return config.fields
    .filter(f => !skipKeys.has(f.key) && !['richtext', 'relation', 'multirelation'].includes(f.type))
    .slice(0, 3)
    .map(f => {
      const val = entity[f.key];
      if (!val && val !== 0) return null;
      let display = val;
      if (f.type === 'date') display = _fmtDate(String(val));
      else if (typeof val === 'boolean') display = val ? 'Yes' : 'No';
      else display = String(val);
      return { label: f.label || f.key, value: display };
    })
    .filter(Boolean)
    .slice(0, 3);
}

/** Extract tags array from entity */
function _getTags(entity) {
  const raw = entity.tags;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.slice(0, 4);
  if (typeof raw === 'string') return raw.split(',').map(t => t.trim()).filter(Boolean).slice(0, 4);
  return [];
}

// ── Render: List mode ─────────────────────────────────────────────

function _renderList(entities, config) {
  if (entities.length === 0) return '';

  const rows = entities.map(entity => {
    const title = _esc(_getTitle(entity, config));
    const fields = _getKeyFields(entity, config);
    const tags   = _getTags(entity);

    const metaHtml = fields.map(f =>
      `<span class="etv-list-field">${_esc(f.label)}: <strong style="color:var(--color-text)">${_esc(f.value)}</strong></span>`
    ).join('');

    const tagsHtml = tags.map(t => `<span class="etv-tag">${_esc(t)}</span>`).join('');

    const updatedAt = entity.updatedAt
      ? `<span class="etv-list-date">${_fmtDate(entity.updatedAt.toString().slice(0, 10))}</span>`
      : '';

    return `
      <div class="etv-list-item" data-entity-id="${_esc(entity.id)}">
        <div class="etv-list-icon">${_esc(config.icon || '◇')}</div>
        <div class="etv-list-content">
          <div class="etv-list-title">${title || '(Untitled)'}</div>
          ${metaHtml || tagsHtml ? `
            <div class="etv-list-meta">
              ${metaHtml}
              ${tagsHtml}
            </div>
          ` : ''}
        </div>
        ${updatedAt}
      </div>
    `;
  }).join('');

  return `<div class="etv-list">${rows}</div>`;
}

// ── Render: Grid mode ─────────────────────────────────────────────

function _renderGrid(entities, config) {
  if (entities.length === 0) return '';

  const cards = entities.map(entity => {
    const title  = _esc(_getTitle(entity, config));
    const fields = _getKeyFields(entity, config).slice(0, 2);
    const tags   = _getTags(entity);

    const fieldsHtml = fields.map(f =>
      `<div class="etv-grid-field"><span style="color:var(--color-text-muted)">${_esc(f.label)}:</span> ${_esc(f.value)}</div>`
    ).join('');

    const tagsHtml = tags.length
      ? `<div class="etv-grid-tags">${tags.map(t => `<span class="etv-tag">${_esc(t)}</span>`).join('')}</div>`
      : '';

    return `
      <div class="etv-grid-card" data-entity-id="${_esc(entity.id)}">
        <div class="etv-grid-icon">${_esc(config.icon || '◇')}</div>
        <div class="etv-grid-title">${title || '(Untitled)'}</div>
        ${fieldsHtml ? `<div class="etv-grid-fields">${fieldsHtml}</div>` : ''}
        ${tagsHtml}
      </div>
    `;
  }).join('');

  return `<div class="etv-grid">${cards}</div>`;
}

// ── Render: Empty state ───────────────────────────────────────────

function _renderEmpty(config, entityType) {
  const label   = config?.label        || entityType;
  const plural  = config?.labelPlural  || label + 's';
  const icon    = config?.icon         || '◇';
  return `
    <div class="etv-empty">
      <div class="etv-empty-icon">${_esc(icon)}</div>
      <div class="etv-empty-title">No ${_esc(plural)} yet</div>
      <div class="etv-empty-sub">Create your first ${_esc(label)} to get started.</div>
      <button class="etv-empty-btn" id="etv-empty-new-btn">+ New ${_esc(label)}</button>
    </div>
  `;
}

// ── Wire click events ─────────────────────────────────────────────

function _wireClicks(el, entityType) {
  el.addEventListener('click', e => {
    // Mode toggle (List / Grid)
    const modeBtn = e.target.closest('[data-mode]');
    if (modeBtn && modeBtn.closest('.etv-mode-toggle')) {
      const newMode = modeBtn.dataset.mode;
      // Update URL hash so back/forward and refresh preserve mode
      navigate('entity-type', { entityType, mode: newMode }, undefined, true);
      return;
    }

    // Entity item / card clicks → open panel
    const item = e.target.closest('[data-entity-id]');
    if (item) {
      emit(EVENTS.PANEL_OPENED, { entityId: item.dataset.entityId });
      return;
    }

    // New button (header)
    if (e.target.closest('#etv-new-btn')) {
      openForm(entityType);
      return;
    }

    // New button (empty state)
    if (e.target.closest('#etv-empty-new-btn')) {
      openForm(entityType);
      return;
    }
  });
}

// ── Main render ───────────────────────────────────────────────────

async function renderEntityTypeView(params = {}) {
  const el = document.getElementById('view-entity-type');
  if (!el) return;

  const entityType = params.entityType || 'idea';
  const mode       = params.mode || 'list';   // 'list' | 'grid'

  // Guard: if type AND mode unchanged and already rendered, skip full re-render
  const modeChanged = mode !== _currentMode;
  if (_currentType === entityType && el.dataset.stubKey === entityType && !modeChanged && !params._force) {
    return;
  }

  _currentType = entityType;
  _currentMode = mode;
  el.dataset.stubKey = entityType;

  // Tear down old listeners
  _unsubList.forEach(fn => fn());
  _unsubList = [];

  // Get type config
  const config = getEntityTypeConfig(entityType) || {
    label:       entityType,
    labelPlural: entityType + 's',
    icon:        '◇',
    defaultSort: '-createdAt',
    fields:      [{ key: 'title', label: 'Title', type: 'text', isTitle: true }],
  };

  const label  = config.label       || entityType;
  const plural = config.labelPlural || label + 's';
  const icon   = config.icon        || '◇';

  // Load entities
  let rawEntities = [];
  try {
    rawEntities = await getEntitiesByType(entityType);
  } catch (err) {
    console.error('[entity-type] failed to load entities:', err);
  }

  const entities = _sortEntities(
    rawEntities.filter(e => !e.deleted),
    config.defaultSort || '-createdAt'
  );

  // ── Build HTML ────────────────────────────────────────────────
  el.innerHTML = `
    <div class="etv-header">
      <div class="etv-title">
        <span>${_esc(icon)}</span>
        <span>${_esc(plural)}</span>
        <span class="etv-count" id="etv-count">${entities.length}</span>
      </div>
      <div class="etv-header-right">
        <div class="etv-mode-toggle" role="group" aria-label="View mode">
          <button class="etv-mode-btn${mode === 'list' ? ' active' : ''}" data-mode="list" title="List view">☰</button>
          <button class="etv-mode-btn${mode === 'grid' ? ' active' : ''}" data-mode="grid" title="Grid view">⊞</button>
        </div>
        <div id="etv-switcher-mount"></div>
        <button class="etv-new-btn" id="etv-new-btn">
          + New ${_esc(label)}
        </button>
      </div>
    </div>
    <div class="etv-body" id="etv-body">
      ${entities.length === 0
        ? _renderEmpty(config, entityType)
        : mode === 'grid'
          ? _renderGrid(entities, config)
          : _renderList(entities, config)
      }
    </div>
  `;

  // Mount view switcher
  const switcherMount = el.querySelector('#etv-switcher-mount');
  if (switcherMount) {
    try {
      const switcher = createViewSwitcher({ entityType, currentMode: mode });
      switcherMount.appendChild(switcher);
    } catch (e) {
      // view-switcher not critical — continue
    }
  }

  // Wire clicks
  _wireClicks(el, entityType);

  // ── Listen for entity saves → refresh ────────────────────────
  const unsub = on(EVENTS.ENTITY_SAVED, ({ entity } = {}) => {
    if (entity?.type === _currentType) {
      renderEntityTypeView({ entityType: _currentType, mode: _currentMode, _force: true });
    }
  });
  _unsubList.push(unsub);
}

// ── Register view ─────────────────────────────────────────────────
registerView('entity-type', renderEntityTypeView);
