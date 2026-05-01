/**
 * FamilyHub v3.0 — views/stub-views.js
 * Placeholder renderers for views not yet implemented.
 * Prevents blank/broken screens when user navigates to these views.
 * Each stub shows a friendly "coming soon" state with the view name.
 *
 * Views covered:
 *   family-matters, notes, projects, graph, budget, recipes,
 *   documents, contacts, gallery, settings, entity-type
 */

import { registerView } from '../core/router.js';
import { createViewSwitcher } from '../components/view-switcher.js';

/** Views that are already implemented — skip stubbing these */
const IMPLEMENTED = new Set(['daily', 'kanban', 'calendar', 'activity-center', 'notes', 'projects', 'settings',
  'budget', 'recipes', 'documents', 'contacts', 'gallery', 'family-matters', 'graph', 'entity-type',
  'object-studio', 'dashboard']);

/**
 * Human-readable names for stub views.
 */
const VIEW_NAMES = {
  'family-matters': 'Family Matters',
  'notes':          'Notes',
  'projects':       'Projects',
  'graph':          'Knowledge Graph',
  'budget':         'Budget',
  'recipes':        'Recipes',
  'documents':      'Documents',
  'contacts':       'Contacts',
  'gallery':        'Gallery',
  'settings':       'Settings',
  'entity-type':    'Collections',
};

/**
 * Icons for stub views.
 */
const VIEW_ICONS = {
  'family-matters': '⌂',
  'notes':          '≡',
  'projects':       '⊞',
  'graph':          '◎',
  'budget':         '◷',
  'recipes':        '⊛',
  'documents':      '⊟',
  'contacts':       '⊕',
  'gallery':        '▣',
  'settings':       '⊙',
  'entity-type':    '◇',
};

/**
 * Render a "coming soon" placeholder for an unimplemented view.
 * @param {string} viewKey
 * @param {object} [params]
 */
function _renderStub(viewKey, params = {}) {
  const el = document.getElementById(`view-${viewKey}`);
  if (!el) return;

  // Only re-render if not already showing a stub for this view
  if (el.dataset.stubKey === viewKey && !params.entityType) return;
  el.dataset.stubKey = viewKey;

  const name = viewKey === 'entity-type'
    ? (params.entityTypeLabel || _cap(params.entityType) || 'Collections')
    : (VIEW_NAMES[viewKey] || _cap(viewKey));

  const icon = viewKey === 'entity-type'
    ? '◇'
    : (VIEW_ICONS[viewKey] || '◈');

  el.innerHTML = `
    <div style="
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 60dvh;
      padding: var(--space-8) var(--space-4);
      text-align: center;
      color: var(--color-text-muted);
    ">
      <div style="
        font-size: 3rem;
        margin-bottom: var(--space-4);
        opacity: 0.4;
        line-height: 1;
      " aria-hidden="true">${_esc(icon)}</div>

      <h2 style="
        font-family: var(--font-heading);
        font-size: var(--text-xl);
        font-weight: var(--weight-semibold);
        color: var(--color-text);
        margin-bottom: var(--space-2);
      ">${_esc(name)}</h2>

      <p style="
        font-size: var(--text-sm);
        color: var(--color-text-muted);
        max-width: 320px;
        line-height: 1.5;
        margin-bottom: var(--space-6);
      ">
        This view is being built. It will be available in a future update.
      </p>

      <div style="
        display: inline-flex;
        align-items: center;
        gap: var(--space-2);
        padding: var(--space-2) var(--space-4);
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        color: var(--color-text-muted);
        letter-spacing: 0.03em;
      ">
        <span aria-hidden="true">🚧</span>
        Coming soon
      </div>
    </div>
  `;

  // BUG-5 fix: mount view switcher AFTER innerHTML is set (was wiped before)
  if (viewKey === 'entity-type' && params.entityType) {
    const switcher = createViewSwitcher({ entityType: params.entityType, currentMode: 'list' });
    const switcherWrap = document.createElement('div');
    switcherWrap.style.cssText = 'display:flex;justify-content:flex-end;padding:var(--space-3) var(--space-4) 0;';
    switcherWrap.appendChild(switcher);
    el.insertBefore(switcherWrap, el.firstChild);
  }
}

function _esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function _cap(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ── Register stub renderers for all unimplemented views ───── //

for (const [viewKey, name] of Object.entries(VIEW_NAMES)) {
  if (IMPLEMENTED.has(viewKey)) continue;

  // Capture viewKey in closure
  const key = viewKey;
  registerView(key, (params) => _renderStub(key, params));
}
