/**
 * FamilyHub v3 — views/generic-list.js
 * [MAJOR] V-04 — Generic List View Factory
 *
 * Factory function that creates list views for entity types that
 * don't need a custom view. Handles:
 *   budget (budgetEntry), recipes (recipe), documents (document),
 *   contacts (contact), gallery (document), family-matters (goal)
 *
 * Each view: header with icon + name + count + "+ New" button,
 * grid of entity cards, empty state, context filtering,
 * click → entity panel.
 */

import { registerView } from '../core/router.js';
import { getEntitiesByType } from '../core/db.js';
import { getEntityTypeConfig } from '../core/graph-engine.js';
import { emit, on, EVENTS } from '../core/events.js';
import { filterByContext, getActiveContext } from '../core/context.js';
import { openForm } from '../components/entity-form.js';

// ── View-specific config ───────────────────────────────────────
const VIEW_CONFIG = {
  budget:          { entityType: 'budgetEntry', icon: '💰', label: 'Budget',         plural: 'entries' },
  recipes:         { entityType: 'recipe',      icon: '🍳', label: 'Recipes',        plural: 'recipes' },
  documents:       { entityType: 'document',    icon: '📄', label: 'Documents',      plural: 'documents' },
  contacts:        { entityType: 'contact',     icon: '👥', label: 'Contacts',       plural: 'contacts' },
  gallery:         { entityType: 'document',    icon: '🖼️', label: 'Gallery',        plural: 'items',
                     filter: e => e.category === 'Photo' || e.category === 'Image' || e.category === 'Gallery' },
  'family-matters':{ entityType: 'goal',        icon: '🏠', label: 'Family Matters', plural: 'goals' },
};

// ── Helpers ────────────────────────────────────────────────────
function _esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function _relativeTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

function _getTitle(entity) {
  return entity.title || entity.name || entity.description || entity.label || 'Untitled';
}

function _getSubtitle(entity) {
  // Try to build a useful subtitle from available fields
  const parts = [];
  if (entity.category) parts.push(entity.category);
  if (entity.cuisine) parts.push(entity.cuisine);
  if (entity.status) parts.push(entity.status);
  if (entity.type === 'budgetEntry' && entity.amount != null) {
    const prefix = entity.budgetType === 'Income' ? '+' : '-';
    parts.push(`${prefix}$${Number(entity.amount).toFixed(2)}`);
  }
  if (entity.dueDate || entity.date || entity.deadline) {
    parts.push(entity.dueDate || entity.date || entity.deadline);
  }
  return parts.join(' · ');
}

// ── Factory Function ───────────────────────────────────────────
function makeListView(viewKey, entityTypeKey) {
  const config = VIEW_CONFIG[viewKey] || { entityType: entityTypeKey, icon: '📌', label: viewKey, plural: 'items' };

  return async function _renderGenericList(params = {}) {
    const el = document.getElementById(`view-${viewKey}`);
    if (!el) return;

    // Load and filter data
    let entities = await getEntitiesByType(config.entityType);
    entities = filterByContext(entities.filter(e => !e.deleted));
    if (config.filter) entities = entities.filter(config.filter);

    // Sort by updatedAt desc
    entities.sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));

    el.innerHTML = '';

    // ── Header ────────────────────────────────────────────────
    const header = document.createElement('div');
    header.style.cssText = `
      padding:var(--space-4) var(--space-5);display:flex;align-items:center;justify-content:space-between;
      border-bottom:1px solid var(--color-border);
    `;
    header.innerHTML = `
      <div style="display:flex;align-items:center;gap:var(--space-2);">
        <span style="font-size:1.3em;">${config.icon}</span>
        <span style="font-weight:var(--weight-bold);font-size:var(--text-lg);color:var(--color-text);">${_esc(config.label)}</span>
        <span style="font-size:var(--text-sm);color:var(--color-text-muted);">(${entities.length} ${config.plural})</span>
      </div>
    `;

    const newBtn = document.createElement('button');
    newBtn.textContent = '+ New';
    newBtn.style.cssText = `
      padding:6px 14px;font-size:var(--text-sm);font-weight:var(--weight-semibold);
      background:var(--color-accent);color:#fff;border:none;border-radius:var(--radius-md);cursor:pointer;
    `;
    newBtn.addEventListener('click', () => {
      const ctx = getActiveContext();
      openForm(config.entityType, { context: ctx === 'all' ? 'family' : ctx });
    });
    header.appendChild(newBtn);
    el.appendChild(header);

    // ── Empty State ───────────────────────────────────────────
    if (entities.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = `
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        min-height:40vh;color:var(--color-text-muted);text-align:center;padding:var(--space-6);
      `;
      empty.innerHTML = `
        <div style="font-size:2.5rem;margin-bottom:var(--space-3);opacity:0.3;">${config.icon}</div>
        <div style="font-size:var(--text-base);font-weight:var(--weight-semibold);color:var(--color-text);">No ${config.plural} yet</div>
        <div style="font-size:var(--text-sm);margin-top:var(--space-1);">Click "+ New" to create your first one.</div>
      `;
      el.appendChild(empty);
      return;
    }

    // ── Grid of Cards ─────────────────────────────────────────
    const grid = document.createElement('div');
    grid.style.cssText = `
      display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:var(--space-4);
      padding:var(--space-5);
    `;

    for (const entity of entities) {
      const card = document.createElement('div');
      card.style.cssText = `
        padding:var(--space-4);background:var(--color-bg);border:1px solid var(--color-border);
        border-radius:var(--radius-lg);cursor:pointer;transition:box-shadow 0.15s,border-color 0.15s;
      `;
      card.addEventListener('mouseenter', () => { card.style.borderColor = 'var(--color-accent)'; card.style.boxShadow = '0 2px 8px rgba(0,0,0,0.06)'; });
      card.addEventListener('mouseleave', () => { card.style.borderColor = 'var(--color-border)'; card.style.boxShadow = 'none'; });

      const title = _getTitle(entity);
      const subtitle = _getSubtitle(entity);
      const time = _relativeTime(entity.updatedAt || entity.createdAt);

      // Context badge
      const ctxEmoji = { family: '🏠', personal: '👤', business: '💼', all: '🌐' };
      const ctxBadge = entity.context && entity.context !== 'family'
        ? `<span style="font-size:10px;margin-left:var(--space-1);">${ctxEmoji[entity.context] || ''}</span>`
        : '';

      card.innerHTML = `
        <div style="font-weight:var(--weight-semibold);font-size:var(--text-sm);color:var(--color-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          ${_esc(title)}${ctxBadge}
        </div>
        ${subtitle ? `<div style="font-size:var(--text-xs);color:var(--color-text-muted);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_esc(subtitle)}</div>` : ''}
        <div style="font-size:10px;color:var(--color-text-muted);margin-top:6px;">${time}</div>
      `;

      card.addEventListener('click', () => {
        emit(EVENTS.PANEL_OPENED, { entityId: entity.id });
      });

      grid.appendChild(card);
    }

    el.appendChild(grid);
  };
}

// ── Register all generic list views ────────────────────────────
for (const [viewKey, config] of Object.entries(VIEW_CONFIG)) {
  registerView(viewKey, makeListView(viewKey, config.entityType));
}

// ── Module-level listeners ─────────────────────────────────────
// Re-render any active generic list view on entity changes or context change

function _refreshActiveGenericView() {
  for (const viewKey of Object.keys(VIEW_CONFIG)) {
    const el = document.getElementById(`view-${viewKey}`);
    if (el?.classList.contains('active')) {
      const renderFn = makeListView(viewKey, VIEW_CONFIG[viewKey].entityType);
      renderFn();
      break;
    }
  }
}

on(EVENTS.ENTITY_SAVED, _refreshActiveGenericView);
on(EVENTS.ENTITY_DELETED, _refreshActiveGenericView);
on('context:changed', _refreshActiveGenericView);
