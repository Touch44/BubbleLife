/**
 * FamilyHub v3.0 — components/search-bar.js
 * Faceted Search Bar — chips inside input, filter suggestions, searchModel.
 * Implements Prompt 10 spec exactly.
 *
 * Features:
 *   1. Active filters rendered as colored chips inside the input area
 *   2. Typing filters current view's data via searchModel.setDomain()
 *   3. Facet types: text (free text), assignee, status, dateRange
 *   4. Backspace on empty text removes the last chip
 *   5. Chips have × button to remove individually
 *   6. Dropdown shows filter suggestions as user types
 *   7. Search state stored in router action so it persists across view switches
 *   8. searchModel.setDomain(facets) applies filters to views
 *
 * Usage:
 *   import { initSearchBar, searchModel } from './components/search-bar.js';
 *   initSearchBar(); // call once after DOM ready
 *
 * Views integrate by listening to searchModel changes:
 *   import { searchModel } from './components/search-bar.js';
 *   searchModel.onChange(facets => { /* re-filter data *\/ });
 */

import { emit, on, EVENTS } from '../core/events.js';
import { getState, navigate } from '../core/router.js';

// ── Facet types ───────────────────────────────────────────── //

export const FACET_TYPES = {
  TEXT:       'text',
  ASSIGNEE:   'assignee',
  STATUS:     'status',
  DATE_RANGE: 'dateRange',
};

const FACET_COLORS = {
  text:      'var(--color-accent)',
  assignee:  '#4caf7d',
  status:    '#f7c948',
  dateRange: '#f97316',
};

const FACET_ICONS = {
  text:      '🔍',
  assignee:  '👤',
  status:    '◉',
  dateRange: '📅',
};

// ── Internal state ────────────────────────────────────────── //

/** @type {{ type: string, label: string, value: string }[]} */
let _facets = [];
let _inputEl = null;
let _chipsEl = null;
let _wrapEl  = null;
let _dropEl  = null;
let _listeners = [];

// ── searchModel (public interface for views) ──────────────── //

export const searchModel = {
  /**
   * Current facets array.
   * @returns {{ type: string, label: string, value: string }[]}
   */
  getFacets() {
    return [..._facets];
  },

  /**
   * Set the facets programmatically and notify views.
   * @param {{ type: string, label: string, value: string }[]} facets
   */
  setDomain(facets) {
    _facets = [...(facets || [])];
    _renderChips();
    _notifyListeners();
    _persistToRouter();
  },

  /**
   * Add a change listener called whenever facets change.
   * @param {(facets: object[]) => void} fn
   * @returns {() => void} unsubscribe
   */
  onChange(fn) {
    _listeners.push(fn);
    return () => {
      _listeners = _listeners.filter(f => f !== fn);
    };
  },

  /**
   * Add a single facet.
   * @param {{ type: string, label: string, value: string }} facet
   */
  addFacet(facet) {
    // Avoid duplicate text facets
    if (facet.type === FACET_TYPES.TEXT) {
      _facets = _facets.filter(f => f.type !== FACET_TYPES.TEXT);
    }
    _facets.push(facet);
    _renderChips();
    _notifyListeners();
    _persistToRouter();
  },

  /**
   * Remove a facet by index.
   */
  removeFacet(index) {
    _facets.splice(index, 1);
    _renderChips();
    _notifyListeners();
    _persistToRouter();
  },

  /** Clear all facets. */
  clear() {
    _facets = [];
    _renderChips();
    _notifyListeners();
    _persistToRouter();
  },
};

// ── Internal helpers ──────────────────────────────────────── //

function _notifyListeners() {
  for (const fn of _listeners) {
    try { fn([..._facets]); } catch {}
  }
  // Also emit on bus for views that use events
  emit('search:facets', { facets: [..._facets] });
}

function _persistToRouter() {
  // Store search state in router action (P-17 spec req 7)
  const state = getState();
  if (!state) return;

  const params = { ...state.params };
  if (_facets.length) {
    params._searchFacets = JSON.stringify(_facets);
  } else {
    // Remove the key entirely when cleared — don't persist empty string
    delete params._searchFacets;
  }
  navigate(state.view, params, state.label, true /* replace */);
}

function _restoreFromRouter() {
  const state = getState();
  if (state?.params?._searchFacets) {
    try {
      _facets = JSON.parse(state.params._searchFacets);
      _renderChips();
    } catch { _facets = []; }
  }
}

// ── Chip rendering ────────────────────────────────────────── //

function _renderChips() {
  if (!_chipsEl) return;
  _chipsEl.innerHTML = '';

  _facets.forEach((facet, idx) => {
    const chip = document.createElement('span');
    chip.className = 'sb-chip';
    chip.style.setProperty('--chip-color', FACET_COLORS[facet.type] || 'var(--color-accent)');

    chip.innerHTML = `
      <span class="sb-chip-icon" aria-hidden="true">${FACET_ICONS[facet.type] || '🔍'}</span>
      <span class="sb-chip-label">${_esc(facet.label)}</span>
      <button class="sb-chip-remove" aria-label="Remove ${_esc(facet.label)} filter">×</button>
    `;

    chip.querySelector('.sb-chip-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      searchModel.removeFacet(idx);
    });

    _chipsEl.appendChild(chip);
  });
}

// ── Dropdown suggestions ──────────────────────────────────── //

const FILTER_SUGGESTIONS = [
  { type: FACET_TYPES.STATUS,    label: 'Status: Todo',       value: 'todo' },
  { type: FACET_TYPES.STATUS,    label: 'Status: In Progress', value: 'in_progress' },
  { type: FACET_TYPES.STATUS,    label: 'Status: Done',        value: 'done' },
  { type: FACET_TYPES.STATUS,    label: 'Status: Blocked',     value: 'blocked' },
  { type: FACET_TYPES.DATE_RANGE, label: 'Due: Today',          value: 'today' },
  { type: FACET_TYPES.DATE_RANGE, label: 'Due: This week',      value: 'this_week' },
  { type: FACET_TYPES.DATE_RANGE, label: 'Due: Overdue',        value: 'overdue' },
];

function _showDropdown(query) {
  if (!_dropEl) return;

  const lq = query.toLowerCase().trim();
  const matches = lq
    ? FILTER_SUGGESTIONS.filter(s => s.label.toLowerCase().includes(lq))
    : FILTER_SUGGESTIONS.slice(0, 6);

  if (matches.length === 0) {
    // Show text search option
    _dropEl.innerHTML = `
      <div class="sb-drop-item" data-action="text">
        <span class="sb-drop-icon">${FACET_ICONS.text}</span>
        <span>Search for "<strong>${_esc(query)}</strong>"</span>
      </div>`;
  } else {
    _dropEl.innerHTML = matches.map(s => `
      <div class="sb-drop-item" data-type="${s.type}" data-value="${_esc(s.value)}" data-label="${_esc(s.label)}">
        <span class="sb-drop-icon">${FACET_ICONS[s.type] || '🔍'}</span>
        <span>${_esc(s.label)}</span>
      </div>
    `).join('');

    if (lq) {
      _dropEl.innerHTML += `
        <div class="sb-drop-item sb-drop-divider" data-action="text">
          <span class="sb-drop-icon">${FACET_ICONS.text}</span>
          <span>Search for "<strong>${_esc(query)}</strong>"</span>
        </div>`;
    }
  }

  _dropEl.querySelectorAll('.sb-drop-item').forEach(item => {
    item.addEventListener('mousedown', (e) => {
      e.preventDefault(); // prevent input blur
      const { action, type, value, label } = item.dataset;

      if (action === 'text' && query.trim()) {
        searchModel.addFacet({ type: FACET_TYPES.TEXT, label: `"${query}"`, value: query.trim() });
        if (_inputEl) _inputEl.value = '';
      } else if (type) {
        searchModel.addFacet({ type, label, value });
        if (_inputEl) _inputEl.value = '';
      }
      _hideDropdown();
    });
  });

  _dropEl.style.display = '';
}

function _hideDropdown() {
  if (_dropEl) _dropEl.style.display = 'none';
}

// ── Init ──────────────────────────────────────────────────── //

/**
 * Initialize the faceted search bar.
 * Finds or creates the search bar DOM elements.
 * @param {string} [containerId='topbar-search'] — ID of the container element
 */
export function initSearchBar(containerId = 'topbar-search') {
  const container = document.getElementById(containerId);
  if (!container) {
    console.warn('[search-bar] Container not found:', containerId);
    return;
  }

  // Build the chip+input structure inside the container
  container.innerHTML = `
    <div class="sb-wrap" role="search">
      <span class="sb-icon" aria-hidden="true">🔍</span>
      <div class="sb-chips" aria-label="Active filters"></div>
      <input class="sb-input" type="text" placeholder="Search or filter…"
             autocomplete="off" spellcheck="false" aria-label="Search">
      <button class="sb-clear" aria-label="Clear all filters" style="display:none">✕</button>
    </div>
    <div class="sb-dropdown" role="listbox" aria-label="Filter suggestions" style="display:none"></div>
  `;

  _wrapEl  = container.querySelector('.sb-wrap');
  _chipsEl = container.querySelector('.sb-chips');
  _inputEl = container.querySelector('.sb-input');
  _dropEl  = container.querySelector('.sb-dropdown');
  const clearBtn = container.querySelector('.sb-clear');

  // ── Input events ──────────────────────────────────────── //
  _inputEl.addEventListener('input', () => {
    const val = _inputEl.value;
    clearBtn.style.display = (val || _facets.length) ? '' : 'none';

    if (val.trim()) {
      _showDropdown(val.trim());
    } else {
      _hideDropdown();
      // Empty input = live text search cleared
      searchModel.setDomain(_facets.filter(f => f.type !== FACET_TYPES.TEXT));
    }
  });

  _inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !_inputEl.value && _facets.length > 0) {
      // Remove last chip on backspace with empty input
      searchModel.removeFacet(_facets.length - 1);
    }
    if (e.key === 'Enter' && _inputEl.value.trim()) {
      e.preventDefault();
      searchModel.addFacet({ type: FACET_TYPES.TEXT, label: `"${_inputEl.value.trim()}"`, value: _inputEl.value.trim() });
      _inputEl.value = '';
      _hideDropdown();
    }
    if (e.key === 'Escape') {
      _hideDropdown();
      _inputEl.blur();
    }
  });

  _inputEl.addEventListener('focus', () => {
    if (_inputEl.value.trim()) _showDropdown(_inputEl.value.trim());
  });

  _inputEl.addEventListener('blur', () => {
    // Slight delay so mousedown on dropdown items fires first
    setTimeout(_hideDropdown, 150);
  });

  clearBtn.addEventListener('click', () => {
    searchModel.clear();
    _inputEl.value = '';
    clearBtn.style.display = 'none';
    _inputEl.focus();
  });

  // Restore state from router on view change
  on(EVENTS.VIEW_CHANGED, () => {
    _restoreFromRouter();
    clearBtn.style.display = _facets.length ? '' : 'none';
  });

  _renderChips();
}

function _esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
