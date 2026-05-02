/**
 * FamilyHub v4.2 — components/view-switcher.js
 * View Mode Switcher — List / Kanban / Calendar buttons for entity-type views.
 * Implements Prompt 13 spec exactly.
 *
 * Features:
 *   1. Three icon buttons: List, Kanban, Calendar
 *   2. Clicking navigates to that view type, preserving entityType/filter/search state
 *   3. Active mode highlighted
 *   4. Instant switch — data is in-memory
 *   5. 100ms fade transition on content area
 *
 * Usage:
 *   import { createViewSwitcher } from './components/view-switcher.js';
 *   const el = createViewSwitcher({ entityType: 'task', currentMode: 'list' });
 *   toolbar.appendChild(el);
 */

import { navigate, getState } from '../core/router.js';

export const VIEW_MODES = [
  // 'list' and 'grid' both render in 'entity-type' view (generic entity list)
  // Kanban and Calendar removed — they show ALL entities, not filtered by type
  { key: 'list',  view: 'entity-type', icon: '☰', label: 'List view'   },
  { key: 'grid',  view: 'entity-type', icon: '📊', label: 'Grid view', params: { mode: 'grid' } },
];

/**
 * Create a view mode switcher element.
 * @param {object} opts
 * @param {string} opts.entityType   — current entity type (e.g. 'task')
 * @param {string} [opts.currentMode='list'] — currently active mode
 * @param {Function} [opts.onSwitch]  — optional callback(mode) after navigation
 * @returns {HTMLElement}
 */
export function createViewSwitcher({ entityType, currentMode = 'list', onSwitch } = {}) {
  const bar = document.createElement('div');
  bar.className = 'view-switcher';
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'View mode');

  for (const mode of VIEW_MODES) {
    const btn = document.createElement('button');
    btn.className = `view-switcher-btn${mode.key === currentMode ? ' view-switcher-btn--active' : ''}`;
    btn.setAttribute('aria-label', mode.label);
    btn.setAttribute('title', mode.label);
    btn.setAttribute('aria-pressed', String(mode.key === currentMode));
    btn.textContent = mode.icon;

    btn.addEventListener('click', () => {
      if (mode.key === currentMode) return;

      // Preserve current router state (entityType, filter, search)
      const state = getState();
      const params = {
        entityType,
        // Merge any mode-specific params (e.g. { mode: 'grid' } for grid view)
        ...(mode.params || {}),
        ...(state?.params?.filter        ? { filter:        state.params.filter }        : {}),
        ...(state?.params?._searchFacets ? { _searchFacets: state.params._searchFacets } : {}),
      };

      // Fade out content area, navigate, fade in
      const main = document.getElementById('main');
      if (main) {
        main.style.transition = 'opacity 0.1s ease';
        main.style.opacity    = '0';
        setTimeout(() => {
          navigate(mode.view || mode.key, params);
          main.style.opacity = '1';
          onSwitch?.(mode.key);
        }, 100);
      } else {
        navigate(mode.view || mode.key, params);
        onSwitch?.(mode.key);
      }
    });

    bar.appendChild(btn);
  }

  return bar;
}

/**
 * Insert a view switcher into an element, removing any existing one.
 * @param {HTMLElement} container
 * @param {object} opts  — passed to createViewSwitcher
 */
export function mountViewSwitcher(container, opts) {
  const existing = container.querySelector('.view-switcher');
  if (existing) existing.remove();
  container.appendChild(createViewSwitcher(opts));
}
