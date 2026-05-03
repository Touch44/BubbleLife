/**
 * FamilyHub v4.4 — components/search.js
 * [MAJOR] True Global Deep Search — searches ALL entities, ALL fields, ALL content.
 *
 * Architecture:
 *   - Single queryEntities({}) call fetches all entities at once
 *   - _buildIndex() iterates EVERY property on every entity (title, text, richtext,
 *     tags, checklist items, multiselect, numbers, booleans, dates, email, url)
 *   - Type config looked up FRESH per-entity via getEntityTypeConfig() — NOT from a
 *     stale map built at init time — so custom types always work
 *   - Entities with unrecognised types fall back to generic string-field scanning
 *   - Scoring: title exact > prefix > contains; recency; type priority; overdue boost
 *   - Snippet shows which field matched and surrounding context
 *   - Cache invalidated on ENTITY_SAVED / ENTITY_DELETED
 *   - Errors surface as console.warn (never silently empty)
 *
 * Public API:
 *   initSearch()    — wire all search behaviour; call once after DOM ready
 *   openSearch()    — open and focus the search overlay
 *   closeSearch()   — close the overlay
 *   addFacet(f)     — pre-filter from views
 *   clearFacets()   — clear all facet chips
 *   getFacets()     — get active facets
 */

import { getEntityTypeConfig, getAllEntityTypes } from '../core/graph-engine.js';
import { queryEntities, getSetting, setSetting }  from '../core/db.js';
import { navigate, VIEW_KEYS }                    from '../core/router.js';
import { emit, on, EVENTS }                       from '../core/events.js';
import { openForm }                               from './entity-form.js';

// ── DOM refs ────────────────────────────────────────────────── //
let _overlay, _input, _results;

// ── State ───────────────────────────────────────────────────── //
let _selectedIndex = -1;
let _currentItems  = [];
let _searchTimeout = null;

// ── Entity cache ─────────────────────────────────────────────── //
/** @type {object[]|null} */
let _entityCache = null;
let _cacheStale  = true;

// ── Faceted search ────────────────────────────────────────────── //
let _facets   = [];
let _facetBar = null;

// ── Recent entities ───────────────────────────────────────────── //
const RECENT_KEY = 'recentEntities';
const RECENT_MAX = 10;

// ════════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════════

export function initSearch() {
  _overlay = document.getElementById('search-overlay');
  _input   = document.getElementById('search-input');
  _results = document.getElementById('search-results');

  if (!_overlay || !_input || !_results) {
    console.warn('[search] DOM not found — skipping init.');
    return;
  }

  // Wire Cmd+K button if present (optional — search-bar.js focus handler is the primary trigger)
  document.getElementById('topbar-search-btn')?.addEventListener('click', openSearch);

  // Click outside → close
  _overlay.addEventListener('click', (e) => {
    if (e.target === _overlay) closeSearch();
  });

  // Facet bar (above input)
  _facetBar = document.createElement('div');
  _facetBar.className = 'search-facet-bar';
  _facetBar.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;padding:0 var(--space-3);min-height:0;';
  _input.parentNode.insertBefore(_facetBar, _input);

  // Input handler — commands immediate, entity search debounced 80ms
  _input.addEventListener('input', () => {
    clearTimeout(_searchTimeout);
    if (_input.value.trimStart().startsWith('>')) {
      _render();
    } else {
      _searchTimeout = setTimeout(_render, 80);
    }
  });

  // Backspace removes last facet chip when input is empty
  _input.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && _input.value === '' && _facets.length > 0) {
      _facets.pop();
      _renderFacetBar();
      _render();
    }
  });

  _input.addEventListener('keydown', _handleInputKey);

  // Track recently opened entities for the recent list
  on(EVENTS.PANEL_OPENED, ({ entityId } = {}) => {
    if (entityId) _trackRecent(entityId);
  });

  // Close on any navigation
  on(EVENTS.VIEW_CHANGED, () => {
    if (_overlay?.classList.contains('open')) closeSearch();
  });

  // Invalidate entity cache on any change — next search fetches fresh from DB
  on(EVENTS.ENTITY_SAVED,   () => { _cacheStale = true; });
  on(EVENTS.ENTITY_DELETED, () => { _cacheStale = true; });

  console.log('[search] Initialised (deep-search v4.4).');
}

// ════════════════════════════════════════════════════════════════
// OPEN / CLOSE
// ════════════════════════════════════════════════════════════════

export function openSearch() {
  if (!_overlay) return;
  _overlay.classList.add('open');
  _overlay.setAttribute('aria-hidden', 'false');
  _overlay.removeAttribute('inert');
  _input.value   = '';
  _selectedIndex = -1;
  _render();
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

// ════════════════════════════════════════════════════════════════
// ENTITY CACHE — loaded once, invalidated by events
// ════════════════════════════════════════════════════════════════

async function _getEntities() {
  if (!_cacheStale && _entityCache !== null) return _entityCache;

  try {
    const all    = await queryEntities({ includeDeleted: false });
    _entityCache = all || [];
    _cacheStale  = false;
    console.log(`[search] Cache loaded: ${_entityCache.length} entities.`);
  } catch (err) {
    console.warn('[search] queryEntities failed:', err);
    // Return stale cache if available, otherwise empty — never undefined
    _entityCache = _entityCache || [];
  }
  return _entityCache;
}

// ════════════════════════════════════════════════════════════════
// DEEP INDEX — searches ALL properties on every entity
// ════════════════════════════════════════════════════════════════

const SKIP_KEYS = new Set([
  'id', 'type', 'deleted', 'createdBy', 'createdAt', 'updatedAt',
  '_authorName', '_authorColor', '_authorPersonId', 'context',
]);

/** Strip HTML tags and collapse whitespace */
function _stripHtml(s) {
  return String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Build a searchable blob for an entity by iterating ALL its own properties.
 * Uses fresh getEntityTypeConfig() per entity — never a stale pre-init map.
 * Falls back to generic string scanning for entities with unknown type configs.
 *
 * @returns {{ title: string, blob: string, parts: {label:string,text:string}[] }}
 */
function _buildIndex(entity) {
  // Always look up config fresh — handles custom types loaded after init
  const cfg    = getEntityTypeConfig(entity.type);
  const fields = cfg?.fields || [];

  // Determine title
  const titleField = fields.find(f => f.isTitle);
  const title = (titleField
    ? (entity[titleField.key] || '')
    : (entity.title || entity.name || entity.label || '')
  ).trim();

  const parts = []; // [{label, text}] — for snippet generation

  for (const [k, v] of Object.entries(entity)) {
    if (SKIP_KEYS.has(k) || v == null || v === '') continue;

    const fieldCfg = fields.find(f => f.key === k);
    const label    = fieldCfg?.label || k;

    if (typeof v === 'string') {
      // Strip HTML for richtext fields
      const clean = (fieldCfg?.type === 'richtext' || k === 'body' || k === 'content')
        ? _stripHtml(v)
        : v;
      const trimmed = clean.trim();
      if (trimmed) parts.push({ label, text: trimmed });

    } else if (typeof v === 'number' && !isNaN(v)) {
      parts.push({ label, text: String(v) });

    } else if (typeof v === 'boolean') {
      parts.push({ label, text: v ? 'yes' : 'no' });

    } else if (Array.isArray(v) && v.length > 0) {
      if (typeof v[0] === 'string') {
        // tags / multiselect
        parts.push({ label, text: v.join(' ') });
      } else if (typeof v[0] === 'object' && v[0] !== null && 'text' in v[0]) {
        // checklist items: [{id, text, done}]
        const itemText = v.map(i => String(i.text || '')).filter(Boolean).join(' ');
        if (itemText) parts.push({ label, text: itemText });
      }
    }
  }

  const blob = (title + ' ' + parts.map(p => p.text).join(' ')).toLowerCase();
  return { title: title || 'Untitled', blob, parts };
}

/**
 * Find the best matching snippet to display under the result title.
 * Returns "FieldLabel: …context around match…" or '' if match is in title.
 */
function _findSnippet(parts, lq) {
  for (const { label, text } of parts) {
    const lower = text.toLowerCase();
    const idx   = lower.indexOf(lq);
    if (idx === -1) continue;
    const start   = Math.max(0, idx - 28);
    const end     = Math.min(text.length, idx + lq.length + 40);
    let   snippet = text.slice(start, end).trim();
    if (start > 0)          snippet = '…' + snippet;
    if (end < text.length)  snippet = snippet + '…';
    return `${label}: ${snippet}`;
  }
  return '';
}

/** Relevance scoring — higher = ranked first */
function _score(entity, cfg, titleLower, lq, titleMatch) {
  let s = 0;

  // Recency bonus
  const age = Date.now() - (entity.updatedAt ? new Date(entity.updatedAt).getTime() : 0);
  if      (age < 7  * 86400000) s += 20;
  else if (age < 30 * 86400000) s += 12;
  else if (age < 90 * 86400000) s += 5;

  // Title match quality
  if      (titleLower === lq)              s += 50;
  else if (titleLower.startsWith(lq))      s += 35;
  else if (titleMatch)                     s += 15;

  // Type priority
  const prio = { task: 14, event: 10, note: 9, project: 7, person: 6 };
  s += (cfg ? (prio[cfg.key] || 0) : 0);

  // Overdue task urgent boost
  if (cfg?.key === 'task' && entity.dueDate) {
    const now   = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    if (entity.dueDate.slice(0, 10) < today && entity.status !== 'Done') s += 25;
  }

  return s;
}

// ════════════════════════════════════════════════════════════════
// RENDER DISPATCHER
// ════════════════════════════════════════════════════════════════

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

// ════════════════════════════════════════════════════════════════
// ENTITY SEARCH
// ════════════════════════════════════════════════════════════════

async function _renderSearchResults(query) {
  _results.innerHTML = `<div style="padding:var(--space-3) var(--space-5);color:var(--color-text-muted);font-size:var(--text-xs);">Searching…</div>`;
  _currentItems  = [];
  _selectedIndex = -1;

  const lq       = query.toLowerCase();
  const entities = await _getEntities();

  const matches = [];

  for (const entity of entities) {
    if (entity.deleted) continue;

    // Build index — works for ALL types including custom, falls back gracefully
    const { title, blob, parts } = _buildIndex(entity);

    // Fast path: reject if query not anywhere in blob
    if (!blob.includes(lq)) continue;

    // Fresh config lookup (never stale)
    const cfg        = getEntityTypeConfig(entity.type);
    const titleLower = title.toLowerCase();
    const titleMatch = titleLower.includes(lq);
    const score      = _score(entity, cfg, titleLower, lq, titleMatch);
    const snippet    = titleMatch ? (cfg?.label || entity.type) : _findSnippet(parts, lq);

    matches.push({ entity, cfg, score, title, snippet });
  }

  matches.sort((a, b) => b.score - a.score);
  const ranked = matches.slice(0, 30);

  _results.innerHTML = '';

  if (ranked.length === 0) {
    _results.innerHTML = `<div style="padding:var(--space-6) var(--space-5);color:var(--color-text-muted);font-size:var(--text-sm);text-align:center;">No results for "<strong>${_esc(query)}</strong>"<br><span style="font-size:var(--text-xs);">Try a different spelling or shorter term</span></div>`;
    return;
  }

  const section = _makeSection(`${ranked.length} result${ranked.length === 1 ? '' : 's'}`);
  _results.appendChild(section.header);

  for (const { entity, cfg, title, snippet } of ranked) {
    const item = _makeResultItem({
      icon:       cfg?.icon || '📎',
      title,
      detail:     snippet || (cfg?.label || entity.type),
      color:      cfg?.color,
      onActivate: () => {
        closeSearch();
        emit(EVENTS.PANEL_OPENED, { entityId: entity.id });
      },
    });
    _results.appendChild(item.el);
    _currentItems.push(item);
  }
}

// ════════════════════════════════════════════════════════════════
// RECENT ENTITIES
// ════════════════════════════════════════════════════════════════

async function _renderRecents() {
  _results.innerHTML = '';
  _currentItems  = [];
  _selectedIndex = -1;

  let recents = [];
  try { recents = (await getSetting(RECENT_KEY)) || []; } catch { recents = []; }

  if (recents.length === 0) {
    _results.innerHTML = `<div style="padding:var(--space-4) var(--space-5);color:var(--color-text-muted);font-size:var(--text-sm);text-align:center;">Start typing to search all ${_getTotalEntityCount()} entities<br><span style="font-size:var(--text-xs);opacity:0.7;">or type <kbd>&gt;</kbd> for commands</span></div>`;
    return;
  }

  _results.appendChild(_makeSection('Recent').header);

  for (const rec of recents) {
    const cfg  = getEntityTypeConfig(rec.type);
    const item = _makeResultItem({
      icon:       cfg?.icon || '📎',
      title:      rec.title || 'Untitled',
      detail:     cfg?.label || rec.type,
      color:      cfg?.color,
      onActivate: () => {
        closeSearch();
        emit(EVENTS.PANEL_OPENED, { entityId: rec.id });
      },
    });
    _results.appendChild(item.el);
    _currentItems.push(item);
  }
}

function _getTotalEntityCount() {
  return _entityCache ? _entityCache.length : '…';
}

// ════════════════════════════════════════════════════════════════
// COMMAND MODE  (input starts with ">")
// ════════════════════════════════════════════════════════════════

const COMMANDS = [
  { label:'Dashboard',      detail:'Go to Dashboard',        icon:'🏠',  keys:['dashboard','home'],
    action:()=>{ closeSearch(); navigate(VIEW_KEYS.DASHBOARD||'dashboard'); } },
  { label:'Daily Review',   detail:'Go to Daily Review',     icon:'📋',  keys:['daily','review'],
    action:()=>{ closeSearch(); navigate(VIEW_KEYS.DAILY); } },
  { label:'Kanban / Tasks', detail:'Go to Kanban board',     icon:'✅',  keys:['kanban','task','tasks'],
    action:()=>{ closeSearch(); navigate(VIEW_KEYS.KANBAN); } },
  { label:'Calendar',       detail:'Go to Calendar',         icon:'📅',  keys:['calendar','events'],
    action:()=>{ closeSearch(); navigate(VIEW_KEYS.CALENDAR); } },
  { label:'Knowledge Graph',detail:'Go to Knowledge Graph',  icon:'🕸️', keys:['graph','knowledge'],
    action:()=>{ closeSearch(); navigate(VIEW_KEYS.GRAPH); } },
  { label:'Family Wall',    detail:'Go to Family Wall',      icon:'🏡',  keys:['family','wall','post'],
    action:()=>{ closeSearch(); navigate(VIEW_KEYS.ACTIVITY_CENTER); } },
  { label:'Settings',       detail:'Open Settings',          icon:'⚙️', keys:['settings','prefs'],
    action:()=>{ closeSearch(); navigate(VIEW_KEYS.SETTINGS); } },
  { label:'New Task',       detail:'Open new task form',     icon:'✅',  keys:['new task','task','create task'],
    action:()=>{ closeSearch(); openForm('task'); } },
  { label:'New Note',       detail:'Open new note form',     icon:'📝',  keys:['new note','note','create note'],
    action:()=>{ closeSearch(); openForm('note'); } },
  { label:'New Event',      detail:'Open new event form',    icon:'📅',  keys:['new event','event'],
    action:()=>{ closeSearch(); openForm('event'); } },
  { label:'New Person',     detail:'Open new person form',   icon:'👤',  keys:['new person','person','member'],
    action:()=>{ closeSearch(); openForm('person'); } },
  { label:'Sync Now',       detail:'Trigger Notion sync',    icon:'🔄',  keys:['sync','notion'],
    action:()=>{ closeSearch(); emit(EVENTS.SYNC_TRIGGER); } },
  { label:'Dark Mode',      detail:'Toggle dark/light theme',icon:'🌙',  keys:['dark','light','theme','mode'],
    action:()=>{
      closeSearch();
      const cur  = document.documentElement.getAttribute('data-theme') || 'light';
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('fh_theme', next); } catch {}
      emit(EVENTS.THEME_CHANGED, { theme: next });
    } },
  { label:'Keyboard Shortcuts', detail:'Show all shortcuts', icon:'⌨️', keys:['shortcuts','keyboard','help'],
    action:()=>{
      closeSearch();
      const so = document.getElementById('shortcuts-overlay');
      if (so) { so.classList.add('open'); so.setAttribute('aria-hidden','false'); so.removeAttribute('inert'); }
    } },
];

function _renderCommands(query) {
  _results.innerHTML = '';
  _currentItems  = [];
  _selectedIndex = -1;

  const cmdService = window._fhEnv?.services?.command;
  let matches;

  if (cmdService) {
    matches = cmdService.search(query).map(r => ({
      icon:   r.cmd.icon || '⚡',
      label:  r.cmd.label,
      detail: r.cmd.description || r.cmd.category,
      action: () => cmdService.execute(r.cmd.id, window._fhEnv),
    }));
  } else {
    const lq = query.toLowerCase();
    matches = (query.length === 0
      ? COMMANDS
      : COMMANDS.filter(c => c.label.toLowerCase().includes(lq) || c.keys.some(k => k.includes(lq)))
    ).map(c => ({ icon:c.icon, label:c.label, detail:c.detail, action:c.action }));
  }

  if (matches.length === 0) {
    _results.innerHTML = `<div style="padding:var(--space-4) var(--space-5);color:var(--color-text-muted);font-size:var(--text-sm);">No commands match "<strong>${_esc(query)}</strong>"</div>`;
    return;
  }

  _results.appendChild(_makeSection('Commands').header);
  for (const cmd of matches) {
    const item = _makeResultItem({ icon:cmd.icon, title:cmd.label, detail:cmd.detail, onActivate:cmd.action });
    _results.appendChild(item.el);
    _currentItems.push(item);
  }
}

// ════════════════════════════════════════════════════════════════
// FACETED SEARCH
// ════════════════════════════════════════════════════════════════

function _renderFacetBar() {
  if (!_facetBar) return;
  _facetBar.innerHTML = '';
  for (let i = 0; i < _facets.length; i++) {
    const f    = _facets[i];
    const chip = document.createElement('div');
    chip.className = 'search-facet-chip';
    chip.style.cssText = `display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:500;background:${f.color||'var(--color-accent)'};color:#fff;cursor:default;white-space:nowrap;`;
    const lbl = document.createElement('span');
    lbl.textContent = `${f.type}: ${f.label}`;
    const del = document.createElement('button');
    del.textContent = '×';
    del.setAttribute('aria-label', `Remove ${f.label} filter`);
    del.style.cssText = 'background:none;border:none;color:inherit;cursor:pointer;font-size:14px;line-height:1;padding:0;opacity:0.8;';
    del.addEventListener('click', (e) => { e.stopPropagation(); _facets.splice(i,1); _renderFacetBar(); _render(); });
    chip.appendChild(lbl);
    chip.appendChild(del);
    _facetBar.appendChild(chip);
  }
  _input.placeholder = _facets.length > 0 ? 'Add more filters…' : 'Search or type > for commands';
  _facetBar.style.paddingBottom = _facets.length > 0 ? '4px' : '0';
}

export function addFacet(facet) {
  if (!_facets.some(f => f.type === facet.type && f.value === facet.value)) {
    _facets.push(facet);
    _renderFacetBar();
    openSearch();
  }
}

export function clearFacets() { _facets.length = 0; _renderFacetBar(); }
export function getFacets()   { return [..._facets]; }

// ════════════════════════════════════════════════════════════════
// KEYBOARD NAVIGATION
// ════════════════════════════════════════════════════════════════

function _handleInputKey(e) {
  switch (e.key) {
    case 'Escape':    e.preventDefault(); closeSearch(); break;
    case 'ArrowDown': e.preventDefault(); _moveSelection(1);  break;
    case 'ArrowUp':   e.preventDefault(); _moveSelection(-1); break;
    case 'Enter':
      e.preventDefault();
      (_currentItems[_selectedIndex] || _currentItems[0])?.activate();
      break;
    case 'Tab': e.preventDefault(); _moveSelection(e.shiftKey ? -1 : 1); break;
  }
}

function _moveSelection(delta) {
  const count = _currentItems.length;
  if (!count) return;
  if (_selectedIndex >= 0) _currentItems[_selectedIndex]?.deselect();
  _selectedIndex = (_selectedIndex + delta + count) % count;
  _currentItems[_selectedIndex].select();
  _currentItems[_selectedIndex].el.scrollIntoView({ block: 'nearest' });
}

// ════════════════════════════════════════════════════════════════
// DOM HELPERS
// ════════════════════════════════════════════════════════════════

function _makeSection(label) {
  const h = document.createElement('div');
  h.style.cssText = `padding:var(--space-2) var(--space-5) var(--space-1);font-size:var(--text-xs);font-weight:var(--weight-semibold);color:var(--color-text-muted);text-transform:uppercase;letter-spacing:0.06em;border-top:1px solid var(--color-border);margin-top:var(--space-1);`;
  if (!_results.children.length) { h.style.borderTop='none'; h.style.marginTop='0'; }
  h.textContent = label;
  return { header: h };
}

function _makeResultItem({ icon, title, detail, color, onActivate }) {
  const el = document.createElement('div');
  el.setAttribute('role', 'option');
  el.style.cssText = 'display:flex;align-items:center;gap:var(--space-3);padding:var(--space-2-5) var(--space-5);cursor:pointer;transition:background var(--transition-fast);';

  const iconEl = document.createElement('span');
  iconEl.textContent = icon || '📎';
  iconEl.style.cssText = 'font-size:1rem;flex-shrink:0;width:20px;text-align:center;';
  el.appendChild(iconEl);

  const textEl = document.createElement('div');
  textEl.style.cssText = 'flex:1;min-width:0;';

  const titleEl = document.createElement('div');
  titleEl.textContent = title;
  titleEl.style.cssText = 'font-size:var(--text-sm);font-weight:var(--weight-medium);color:var(--color-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  textEl.appendChild(titleEl);

  if (detail) {
    const detailEl = document.createElement('div');
    detailEl.textContent = detail;
    detailEl.style.cssText = 'font-size:var(--text-xs);color:var(--color-text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    textEl.appendChild(detailEl);
  }
  el.appendChild(textEl);

  if (color) {
    const dot = document.createElement('span');
    dot.style.cssText = `width:8px;height:8px;border-radius:var(--radius-full);background:${color};flex-shrink:0;`;
    el.appendChild(dot);
  }

  const activate = () => onActivate?.();
  el.addEventListener('click', activate);
  el.addEventListener('mouseenter', () => { el.style.background = 'var(--color-surface-2)'; });
  el.addEventListener('mouseleave', () => {
    if (!el.classList.contains('sr-selected')) el.style.background = 'none';
  });

  const select   = () => { el.classList.add('sr-selected'); el.style.background='var(--color-surface-2)'; el.setAttribute('aria-selected','true'); };
  const deselect = () => { el.classList.remove('sr-selected'); el.style.background='none'; el.setAttribute('aria-selected','false'); };

  return { el, select, deselect, activate };
}

// ════════════════════════════════════════════════════════════════
// RECENT TRACKING
// ════════════════════════════════════════════════════════════════

async function _trackRecent(entityId) {
  if (!entityId) return;
  try {
    // Use cache if fresh, otherwise do a targeted lookup
    const entities = await _getEntities();
    const entity   = entities.find(e => e.id === entityId && !e.deleted);
    if (!entity) return;

    const cfg   = getEntityTypeConfig(entity.type);
    const tf    = cfg?.fields?.find(f => f.isTitle);
    const title = tf ? (entity[tf.key] || 'Untitled') : (entity.title || entity.name || 'Untitled');

    let recents = [];
    try { recents = (await getSetting(RECENT_KEY)) || []; } catch { recents = []; }

    recents = recents.filter(r => r.id !== entityId);
    recents.unshift({ id: entity.id, type: entity.type, title });
    recents = recents.slice(0, RECENT_MAX);
    await setSetting(RECENT_KEY, recents);
  } catch (err) {
    console.warn('[search] _trackRecent failed:', err);
  }
}

// ════════════════════════════════════════════════════════════════
// UTIL
// ════════════════════════════════════════════════════════════════

function _esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
