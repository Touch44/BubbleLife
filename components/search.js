/**
 * FamilyHub v2.0 — components/search.js
 * Global search overlay + command palette.
 * Blueprint §5.4, Phase 1-D
 *
 * Public API:
 *   initSearch()    — wire all search behaviour; call once after DOM ready
 *   openSearch()    — open and focus the search overlay
 *   closeSearch()   — close the overlay
 */

import { getAllEntityTypes, getEntityTypeConfig } from '../core/graph-engine.js';
import { getEntitiesByType, getSetting, setSetting } from '../core/db.js';
import { navigate, VIEW_KEYS }                         from '../core/router.js';
import { emit, on, EVENTS }                        from '../core/events.js';
import { openForm }                                from './entity-form.js';
import { filterByContext }                         from '../core/context.js';

// ── DOM refs ──────────────────────────────────────────────── //
let _overlay, _input, _results;

// ── State ─────────────────────────────────────────────────── //
let _selectedIndex  = -1;
let _currentItems   = [];   // flat list of rendered result items for keyboard nav
let _searchTimeout  = null;

// ── Faceted search state (P-17) ───────────────────────────── //
/** Active facet chips: [{type, label, value, color}] */
let _facets = [];
let _facetBar = null;  // chip container element

// ── Recent entities key ───────────────────────────────────── //
const RECENT_KEY    = 'recentEntities';
const RECENT_MAX    = 10;

// ════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════

export function initSearch() {
  _overlay = document.getElementById('search-overlay');
  _input   = document.getElementById('search-input');
  _results = document.getElementById('search-results');

  if (!_overlay || !_input || !_results) {
    console.warn('[search] Search DOM not found — skipping init.');
    return;
  }

  // ── Search button in topbar (falls back gracefully if button removed) ─────
  // topbar-search is now the faceted search bar container (P-17)
  // Cmd+K via hotkeyService is the primary trigger
  document.getElementById('topbar-search-btn')
    ?.addEventListener('click', openSearch);

  // ── Click outside palette closes overlay ─────────────────
  _overlay.addEventListener('click', (e) => {
    if (e.target === _overlay) closeSearch();
  });

  // ── Facet bar (P-17): chip container above input ─────────────
  _facetBar = document.createElement('div');
  _facetBar.className = 'search-facet-bar';
  _input.parentNode.insertBefore(_facetBar, _input);
  _facetBar.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;padding:0 var(--space-3);min-height:0;';

  // ── Input: trigger search or command mode ─────────────────
  _input.addEventListener('input', () => {
    clearTimeout(_searchTimeout);
    // Command mode (starts with >) renders immediately — no debounce needed
    if (_input.value.trimStart().startsWith('>')) {
      _render();
    } else {
      _searchTimeout = setTimeout(_render, 120);
    }
  });

  // ── Backspace removes last facet chip when input empty (P-17) ──
  _input.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && _input.value === '' && _facets.length > 0) {
      _facets.pop();
      _renderFacetBar();
      _render();
    }
  });

  // ── Keyboard navigation ───────────────────────────────────
  _input.addEventListener('keydown', _handleInputKey);

  // Cmd+K and Escape are handled by hotkeyService (P-07).
  // search.js exposes openSearch()/closeSearch() which hotkeyService calls.

  // ── Track opened entities for recents ────────────────────
  on(EVENTS.PANEL_OPENED, ({ entityId } = {}) => {
    if (entityId) _trackRecent(entityId);
  });

  // BUG-A fix: close search overlay on any view navigation
  on(EVENTS.VIEW_CHANGED, () => {
    if (_overlay?.classList.contains('open')) closeSearch();
  });

  console.log('[search] Initialised.');
}

// ════════════════════════════════════════════════════════════
// OPEN / CLOSE
// ════════════════════════════════════════════════════════════

export function openSearch() {
  if (!_overlay) return;
  _overlay.classList.add('open');
  _overlay.setAttribute('aria-hidden', 'false');
  _overlay.removeAttribute('inert');
  _input.value = '';
  _selectedIndex = -1;
  _render();
  // Small delay so animation starts before focus
  setTimeout(() => _input.focus(), 30);
}

export function closeSearch() {
  if (!_overlay) return;
  _overlay.classList.remove('open');
  _overlay.setAttribute('aria-hidden', 'true');
  _overlay.setAttribute('inert', '');
  _selectedIndex = -1;
  _currentItems  = [];
}

// ════════════════════════════════════════════════════════════
// RENDER DISPATCHER
// ════════════════════════════════════════════════════════════

async function _render() {
  const query = _input.value.trim();

  if (_input.value.trimStart().startsWith('>')) {
    _renderCommands(query.replace(/^>/, '').trim());
  } else if (query.length === 0) {
    await _renderRecents();
  } else {
    await _renderSearchResults(query);
  }
}

// ════════════════════════════════════════════════════════════
// RECENT ENTITIES
// ════════════════════════════════════════════════════════════

async function _renderRecents() {
  _results.innerHTML = '';
  _currentItems      = [];
  _selectedIndex     = -1;

  let recents = [];
  try {
    recents = (await getSetting(RECENT_KEY)) || [];
  } catch { recents = []; }

  if (recents.length === 0) {
    _results.innerHTML = `
      <div style="padding: var(--space-4) var(--space-5); color: var(--color-text-muted);
                  font-size: var(--text-sm); text-align: center;">
        Start typing to search, or type <kbd>></kbd> for commands
      </div>`;
    return;
  }

  const section = _makeSection('Recent');
  _results.appendChild(section.header);

  for (const rec of recents) {
    const cfg  = getEntityTypeConfig(rec.type);
    const item = _makeResultItem({
      icon:      cfg?.icon || '📎',
      title:     _getDisplayTitle(rec),
      detail:    cfg?.label || rec.type,
      color:     cfg?.color,
      onActivate: () => {
        closeSearch();
        emit(EVENTS.PANEL_OPENED, { entityId: rec.id });
      },
    });
    _results.appendChild(item.el);
    _currentItems.push(item);
  }
}

// ════════════════════════════════════════════════════════════
// ENTITY SEARCH
// ════════════════════════════════════════════════════════════

async function _renderSearchResults(query) {
  _results.innerHTML = `
    <div style="padding: var(--space-3) var(--space-5); color: var(--color-text-muted);
                font-size: var(--text-xs);">Searching…</div>`;
  _currentItems  = [];
  _selectedIndex = -1;

  const lq       = query.toLowerCase();
  const types    = getAllEntityTypes();
  const allMatches = []; // flat: { entity, config, score }

  /** SR-01: Strip HTML tags for richtext field matching */
  function _stripHtml(html) {
    if (!html) return '';
    return String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /** SR-01: Compute relevance score for a matched entity */
  function _scoreEntity(entity, cfg, titleMatch) {
    let score = 0;
    const now = Date.now();
    const updatedAt = entity.updatedAt ? new Date(entity.updatedAt).getTime() : 0;
    const ageMs = now - updatedAt;

    // Recency bonus
    if (ageMs < 7 * 86400000)  score += 20;
    else if (ageMs < 30 * 86400000) score += 10;
    else if (ageMs < 90 * 86400000) score += 5;

    // Title match quality
    const title = (entity.title || entity.name || entity.label || '').toLowerCase();
    if (title === lq)               score += 30;
    else if (title.startsWith(lq))  score += 20;
    else if (titleMatch)            score += 10;

    // Type priority
    const typePriority = { task: 15, event: 10, note: 8, project: 6 };
    score += typePriority[cfg.key] || 0;

    // Overdue task urgency — use local date string to avoid UTC offset shift
    if (cfg.key === 'task' && entity.dueDate) {
      const dueDate = entity.dueDate.slice(0, 10);
      const d = new Date();
      const today = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      if (dueDate < today && entity.status !== 'Done' && entity.status !== 'done') {
        score += 25;
      }
    }

    return score;
  }

  // Search all types in parallel
  await Promise.all(types.map(async (cfg) => {
    let entities = [];
    try { entities = await getEntitiesByType(cfg.key); } catch { return; }

    // SR-01: Include richtext in detail fields; expand slice limit to 5
    const detailFields = cfg.fields.filter(f =>
      !f.isTitle && ['text', 'select', 'date', 'email', 'phone', 'url', 'richtext'].includes(f.type)
    ).slice(0, 5);

    for (const e of entities) {
      if (e.deleted) continue;

      const displayTitle = _getDisplayTitle(e).toLowerCase();
      const titleMatch   = displayTitle.includes(lq);

      // SR-01: Strip HTML from richtext fields before matching
      const detailMatch = detailFields.some(f => {
        const val = e[f.key];
        if (!val) return false;
        const text = f.type === 'richtext' ? _stripHtml(val) : String(val);
        return text.toLowerCase().includes(lq);
      });

      if (!titleMatch && !detailMatch) continue;

      allMatches.push({
        entity: e,
        config: cfg,
        score:  _scoreEntity(e, cfg, titleMatch),
      });
    }
  }));

  // SR-01: Apply context filtering
  const contextFiltered = filterByContext(allMatches.map(m => m.entity));
  const filteredIds     = new Set(contextFiltered.map(e => e.id));
  const contextMatches  = allMatches.filter(m => filteredIds.has(m.entity.id));

  _results.innerHTML = '';

  if (contextMatches.length === 0) {
    _results.innerHTML = `
      <div style="padding: var(--space-6) var(--space-5); color: var(--color-text-muted);
                  font-size: var(--text-sm); text-align: center;">
        No results for "<strong>${_esc(query)}</strong>"
      </div>`;
    return;
  }

  // SR-01: Sort by score descending (unified ranked list, not grouped by type)
  contextMatches.sort((a, b) => b.score - a.score);

  // Cap at 20 results
  const ranked = contextMatches.slice(0, 20);

  const section = _makeSection(`Results (${ranked.length})`);
  _results.appendChild(section.header);

  for (const { entity, config, score: _s } of ranked) {
    const title = _getDisplayTitle(entity);
    // Detail: prefer date/select/text field, but also show richtext snippet
    const detailField = config.fields.find(f =>
      !f.isTitle && ['date', 'select', 'text', 'email'].includes(f.type) && entity[f.key]
    );
    let detail = detailField
      ? `${detailField.label}: ${_formatFieldValue(entity[detailField.key], detailField.type)}`
      : '';
    // If no short detail, try richtext snippet
    if (!detail) {
      const rtField = config.fields.find(f => f.type === 'richtext' && entity[f.key]);
      if (rtField) {
        const plain = String(entity[rtField.key] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (plain.length > 0) detail = plain.slice(0, 60) + (plain.length > 60 ? '…' : '');
      }
    }
    // SR-01: Append type label to detail line so the icon slot is not repeated in the title
    const typeSuffix = config.label || config.key;
    const detailWithType = detail ? `${detail} · ${typeSuffix}` : typeSuffix;

    const item = _makeResultItem({
      icon:      config.icon,
      title,
      detail:    detailWithType,
      color:     config.color,
      onActivate: () => {
        closeSearch();
        emit(EVENTS.PANEL_OPENED, { entityId: entity.id });
      },
    });
    _results.appendChild(item.el);
    _currentItems.push(item);
  }
}

// ════════════════════════════════════════════════════════════
// COMMAND MODE  (input starts with ">")
// ════════════════════════════════════════════════════════════

const COMMANDS = [
  {
    label:   'Daily Review',
    detail:  'Go to Daily Review',
    icon:    '📋',
    keys:    ['daily', 'review'],
    action:  () => { closeSearch(); navigate(VIEW_KEYS.DAILY); },
  },
  {
    label:   'Kanban / Tasks',
    detail:  'Go to Kanban board',
    icon:    '✅',
    keys:    ['kanban', 'task', 'tasks'],
    action:  () => { closeSearch(); navigate(VIEW_KEYS.KANBAN); },
  },
  {
    label:   'Calendar',
    detail:  'Go to Calendar',
    icon:    '📅',
    keys:    ['calendar', 'events'],
    action:  () => { closeSearch(); navigate(VIEW_KEYS.CALENDAR); },
  },
  {
    label:   'Knowledge Graph',
    detail:  'Go to Knowledge Graph',
    icon:    '🕸️',
    keys:    ['graph', 'knowledge'],
    action:  () => { closeSearch(); navigate(VIEW_KEYS.GRAPH); },
  },
  {
    label:   'Family Wall',
    detail:  'Go to Family Wall',
    icon:    '🏡',
    keys:    ['family', 'wall', 'post'],
    action:  () => { closeSearch(); navigate(VIEW_KEYS.FAMILY_WALL); },
  },
  {
    label:   'Settings',
    detail:  'Open Settings',
    icon:    '⚙️',
    keys:    ['settings', 'preferences'],
    action:  () => { closeSearch(); navigate(VIEW_KEYS.SETTINGS); },
  },
  {
    label:   'New Task',
    detail:  'Open new task form',
    icon:    '✅',
    keys:    ['new task', 'task', 'create task', 'add task'],
    action:  () => { closeSearch(); openForm('task'); },
  },
  {
    label:   'New Note',
    detail:  'Open new note form',
    icon:    '📝',
    keys:    ['new note', 'note', 'create note'],
    action:  () => { closeSearch(); openForm('note'); },
  },
  {
    label:   'New Event',
    detail:  'Open new event form',
    icon:    '📅',
    keys:    ['new event', 'event', 'create event'],
    action:  () => { closeSearch(); openForm('event'); },
  },
  {
    label:   'New Person',
    detail:  'Open new person form',
    icon:    '👤',
    keys:    ['new person', 'person', 'add person', 'add member'],
    action:  () => { closeSearch(); openForm('person'); },
  },
  {
    label:   'Sync Now',
    detail:  'Trigger Notion sync',
    icon:    '🔄',
    keys:    ['sync', 'notion', 'sync now'],
    action:  () => { closeSearch(); emit(EVENTS.SYNC_TRIGGER); },
  },
  {
    label:   'Dark Mode',
    detail:  'Toggle dark / light theme',
    icon:    '🌙',
    keys:    ['dark', 'light', 'theme', 'mode'],
    action:  () => {
      closeSearch();
      const current = document.documentElement.getAttribute('data-theme') || 'light';
      const next    = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('fh_theme', next);
      emit(EVENTS.THEME_CHANGED, { theme: next });
    },
  },
  {
    label:   'Keyboard Shortcuts',
    detail:  'Show all keyboard shortcuts',
    icon:    '⌨️',
    keys:    ['shortcuts', 'keyboard', 'help', 'keys'],
    action:  () => {
      closeSearch();
      const so = document.getElementById('shortcuts-overlay');
      if (so) {
        so.classList.add('open');
        so.setAttribute('aria-hidden', 'false');
        so.removeAttribute('inert');
      }
    },
  },
];

function _renderCommands(query) {
  _results.innerHTML = '';
  _currentItems      = [];
  _selectedIndex     = -1;

  // Use commandService if available (P-11), fall back to hardcoded COMMANDS
  const cmdService = window._fhEnv?.services?.command;

  let matches;
  if (cmdService) {
    // Use commandService.search() — returns [{cmd, score}] sorted by score
    const results = cmdService.search(query);
    matches = results.map(r => ({
      icon:       r.cmd.icon || '◈',
      label:      r.cmd.label,
      detail:     r.cmd.description || r.cmd.category,
      action:     () => cmdService.execute(r.cmd.id, window._fhEnv),
      category:   r.cmd.category,
    }));
  } else {
    // Fallback: hardcoded COMMANDS array
    const lq = query.toLowerCase();
    const raw = query.length === 0
      ? COMMANDS
      : COMMANDS.filter(cmd =>
          cmd.label.toLowerCase().includes(lq) ||
          cmd.keys.some(k => k.includes(lq))
        );
    matches = raw.map(cmd => ({
      icon:     cmd.icon,
      label:    cmd.label,
      detail:   cmd.detail,
      action:   cmd.action,
      category: 'Commands',
    }));
  }

  if (matches.length === 0) {
    _results.innerHTML = `
      <div style="padding: var(--space-4) var(--space-5); color: var(--color-text-muted);
                  font-size: var(--text-sm);">No commands match "<strong>${_esc(query)}</strong>"</div>`;
    return;
  }

  // Group by category if commandService is in use
  if (window._fhEnv?.services?.command) {
    const groups = new Map();
    for (const cmd of matches) {
      const cat = cmd.category || 'General';
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(cmd);
    }
    for (const [cat, cmds] of groups) {
      const section = _makeSection(cat);
      _results.appendChild(section.header);
      for (const cmd of cmds) {
        const item = _makeResultItem({
          icon:       cmd.icon,
          title:      cmd.label,
          detail:     cmd.detail,
          onActivate: cmd.action,
        });
        _results.appendChild(item.el);
        _currentItems.push(item);
      }
    }
  } else {
    const section = _makeSection('Commands');
    _results.appendChild(section.header);
    for (const cmd of matches) {
      const item = _makeResultItem({
        icon:       cmd.icon,
        title:      cmd.label,
        detail:     cmd.detail,
        onActivate: cmd.action,
      });
      _results.appendChild(item.el);
      _currentItems.push(item);
    }
  }
}

// ════════════════════════════════════════════════════════════
// FACETED SEARCH (P-17)
// ════════════════════════════════════════════════════════════

/**
 * Render facet chips into the facet bar.
 */
function _renderFacetBar() {
  if (!_facetBar) return;
  _facetBar.innerHTML = '';

  for (let i = 0; i < _facets.length; i++) {
    const f = _facets[i];
    const chip = document.createElement('div');
    chip.className = 'search-facet-chip';
    chip.style.cssText = `
      display:inline-flex;align-items:center;gap:4px;
      padding:2px 8px;border-radius:999px;font-size:12px;font-weight:500;
      background:${f.color || 'var(--color-accent)'};color:#fff;
      cursor:default;white-space:nowrap;
    `;

    const label = document.createElement('span');
    label.textContent = `${f.type}: ${f.label}`;

    const del = document.createElement('button');
    del.textContent = '×';
    del.setAttribute('aria-label', `Remove ${f.label} filter`);
    del.style.cssText = 'background:none;border:none;color:inherit;cursor:pointer;font-size:14px;line-height:1;padding:0;opacity:0.8;';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      _facets.splice(i, 1);
      _renderFacetBar();
      _render();
    });

    chip.appendChild(label);
    chip.appendChild(del);
    _facetBar.appendChild(chip);
  }

  // Update input placeholder
  _input.placeholder = _facets.length > 0 ? 'Add more filters…' : 'Search or type > for commands';
  _facetBar.style.paddingBottom = _facets.length > 0 ? '4px' : '0';
}

/**
 * Add a facet chip programmatically.
 * Views call this to pre-filter the search.
 * @param {{type: string, label: string, value: string, color?: string}} facet
 */
export function addFacet(facet) {
  // Deduplicate by type+value
  const exists = _facets.some(f => f.type === facet.type && f.value === facet.value);
  if (!exists) {
    _facets.push(facet);
    _renderFacetBar();
    openSearch();
  }
}

/**
 * Clear all facet chips.
 */
export function clearFacets() {
  _facets.length = 0;
  _renderFacetBar();
}

/**
 * Get active facets (for views that respond to search state).
 * @returns {{type: string, label: string, value: string}[]}
 */
export function getFacets() {
  return [..._facets];
}

// ════════════════════════════════════════════════════════════
// KEYBOARD NAVIGATION
// ════════════════════════════════════════════════════════════

function _handleInputKey(e) {
  switch (e.key) {
    case 'Escape':
      e.preventDefault();
      closeSearch();
      break;

    case 'ArrowDown':
      e.preventDefault();
      _moveSelection(1);
      break;

    case 'ArrowUp':
      e.preventDefault();
      _moveSelection(-1);
      break;

    case 'Enter':
      e.preventDefault();
      if (_selectedIndex >= 0 && _currentItems[_selectedIndex]) {
        _currentItems[_selectedIndex].activate();
      } else if (_currentItems.length > 0) {
        _currentItems[0].activate();
      }
      break;

    case 'Tab':
      e.preventDefault();
      _moveSelection(e.shiftKey ? -1 : 1);
      break;
  }
}

function _moveSelection(delta) {
  const count = _currentItems.length;
  if (count === 0) return;

  // Deselect current
  if (_selectedIndex >= 0 && _currentItems[_selectedIndex]) {
    _currentItems[_selectedIndex].deselect();
  }

  _selectedIndex = (_selectedIndex + delta + count) % count;
  _currentItems[_selectedIndex].select();
  _currentItems[_selectedIndex].el.scrollIntoView({ block: 'nearest' });
}

// ════════════════════════════════════════════════════════════
// DOM HELPERS
// ════════════════════════════════════════════════════════════

function _makeSection(label) {
  const header = document.createElement('div');
  header.style.cssText = `
    padding: var(--space-2) var(--space-5) var(--space-1);
    font-size: var(--text-xs); font-weight: var(--weight-semibold);
    color: var(--color-text-muted); text-transform: uppercase;
    letter-spacing: 0.06em; border-top: 1px solid var(--color-border);
    margin-top: var(--space-1);
  `;
  // First section has no top border
  if (_results.children.length === 0) {
    header.style.borderTop = 'none';
    header.style.marginTop = '0';
  }
  header.textContent = label;
  return { header };
}

/**
 * Create a single clickable result row.
 * Returns { el, select(), deselect(), activate() }
 */
function _makeResultItem({ icon, title, detail, color, onActivate }) {
  const el = document.createElement('div');
  el.setAttribute('role', 'option');
  el.style.cssText = `
    display: flex; align-items: center; gap: var(--space-3);
    padding: var(--space-2-5) var(--space-5);
    cursor: pointer; transition: background var(--transition-fast);
    border-radius: 0;
  `;

  // Icon
  const iconEl = document.createElement('span');
  iconEl.textContent = icon;
  iconEl.style.cssText = 'font-size: 1rem; flex-shrink: 0; width: 20px; text-align: center;';
  el.appendChild(iconEl);

  // Text block
  const textEl = document.createElement('div');
  textEl.style.cssText = 'flex: 1; min-width: 0;';

  const titleEl = document.createElement('div');
  titleEl.textContent = title;
  titleEl.style.cssText = `
    font-size: var(--text-sm); font-weight: var(--weight-medium);
    color: var(--color-text); overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
  `;
  textEl.appendChild(titleEl);

  if (detail) {
    const detailEl = document.createElement('div');
    detailEl.textContent = detail;
    detailEl.style.cssText = `
      font-size: var(--text-xs); color: var(--color-text-muted);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    `;
    textEl.appendChild(detailEl);
  }
  el.appendChild(textEl);

  // Color dot (for entity results)
  if (color) {
    const dot = document.createElement('span');
    dot.style.cssText = `
      width: 8px; height: 8px; border-radius: var(--radius-full);
      background: ${color}; flex-shrink: 0;
    `;
    el.appendChild(dot);
  }

  const activate = () => { if (onActivate) onActivate(); };

  el.addEventListener('click', activate);
  el.addEventListener('mouseenter', () => {
    el.style.background = 'var(--color-surface-2)';
  });
  el.addEventListener('mouseleave', () => {
    // Only un-highlight if not keyboard-selected
    if (!el.classList.contains('sr-selected')) {
      el.style.background = 'none';
    }
  });

  const select = () => {
    el.classList.add('sr-selected');
    el.style.background = 'var(--color-surface-2)';
    el.setAttribute('aria-selected', 'true');
  };

  const deselect = () => {
    el.classList.remove('sr-selected');
    el.style.background = 'none';
    el.setAttribute('aria-selected', 'false');
  };

  return { el, select, deselect, activate };
}

// ════════════════════════════════════════════════════════════
// RECENT ENTITIES TRACKING
// ════════════════════════════════════════════════════════════

async function _trackRecent(entityId) {
  if (!entityId) return;
  try {
    // We need a minimal record — fetch from any available entity data
    // We rely on the panel having the entity; search for it across all types
    const types  = getAllEntityTypes();
    let found    = null;

    for (const cfg of types) {
      if (found) break;
      try {
        const entities = await getEntitiesByType(cfg.key);
        const match    = entities.find(e => e.id === entityId && !e.deleted);
        if (match) {
          found = {
            id:    match.id,
            type:  match.type,
            title: _getDisplayTitle(match),
          };
        }
      } catch { /* skip */ }
    }

    if (!found) return;

    let recents = [];
    try { recents = (await getSetting(RECENT_KEY)) || []; } catch { recents = []; }

    // Remove if already in list, add to front
    recents = recents.filter(r => r.id !== entityId);
    recents.unshift(found);
    recents = recents.slice(0, RECENT_MAX);

    await setSetting(RECENT_KEY, recents);
  } catch (err) {
    console.warn('[search] _trackRecent failed:', err);
  }
}

// ════════════════════════════════════════════════════════════
// UTIL
// ════════════════════════════════════════════════════════════

function _esc(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _formatFieldValue(value, type) {
  if (!value) return '';
  if (type === 'date' || type === 'datetime') {
    try {
      return new Date(value).toLocaleDateString(undefined, {
        month: 'short', day: 'numeric', year: 'numeric',
      });
    } catch { return value; }
  }
  return String(value);
}

/** Get display title for any entity (derives from body for types without isTitle) */
function _getDisplayTitle(entity) {
  if (!entity) return 'Untitled';
  const cfg = getEntityTypeConfig(entity.type);
  if (!cfg) return entity.title || entity.name || 'Untitled';
  const tf = cfg.fields.find(f => f.isTitle);
  if (tf) return entity[tf.key] || 'Untitled';
  const bodyField = cfg.fields.find(f => f.type === 'richtext' || f.type === 'text');
  if (bodyField && entity[bodyField.key]) {
    const plain = String(entity[bodyField.key]).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    if (plain.length > 40) return plain.slice(0, 40) + '…';
    if (plain) return plain;
  }
  return entity.title || entity.name || 'Untitled';
}
