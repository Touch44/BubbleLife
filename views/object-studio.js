/**
 * FamilyHub v3 — views/object-studio.js
 * [MAJOR] Capacities-Inspired Object Studio
 *
 * Hub for all entity/object type management:
 *   • Displays all Basic Object Types (built-in, non-deletable)
 *   • Displays all Custom Object Types (user-created)
 *   • "+ New Type" quick-create wizard
 *   • Click card → navigate to entity-type view
 *   • ⚙ on custom card → open type editor drawer
 *   • Left rail filter: All / Basic / Custom
 *   • Live search across type names and descriptions
 *   • Object counts per type via countByType()
 *
 * Registration: registerView('object-studio', renderObjectStudio)
 * Container:    #view-object-studio
 */

import { registerView, navigate }    from '../core/router.js';
import { on, EVENTS }                from '../core/events.js';
import { countByType }               from '../core/db.js';
import {
  getAllObjectTypes,
  saveCustomObjectType,
}                                    from '../core/object-type-registry.js';
import { openTypeEditor }            from '../components/type-editor-modal.js';

// ── Module state ──────────────────────────────────────────────────
let _unsubList    = [];
let _activeFilter = 'all'; // 'all' | 'builtin' | 'custom'
let _searchQ      = '';

// ── Inject styles ─────────────────────────────────────────────────
(function _injectStyles() {
  if (document.getElementById('object-studio-styles')) return;
  const s = document.createElement('style');
  s.id = 'object-studio-styles';
  s.textContent = `
    #view-object-studio.active {
      padding:0; display:flex; flex-direction:column; overflow:hidden;
    }
    /* Topbar */
    .os-topbar {
      display:flex; align-items:center; justify-content:space-between;
      padding:var(--space-4) var(--space-6); border-bottom:1px solid var(--color-border);
      background:var(--color-bg); flex-shrink:0; gap:var(--space-3); flex-wrap:wrap;
    }
    .os-topbar-left { display:flex; align-items:center; gap:var(--space-3); }
    .os-studio-title {
      font-size:var(--text-xl); font-weight:var(--weight-bold); color:var(--color-text);
      display:flex; align-items:center; gap:var(--space-2);
    }
    .os-studio-badge {
      font-size:var(--text-xs); color:var(--color-text-muted);
      background:var(--color-surface-2); border:1px solid var(--color-border);
      border-radius:var(--radius-full); padding:1px 8px;
    }
    .os-search-wrap { position:relative; }
    .os-search-wrap::before {
      content:'⌕'; position:absolute; left:9px; top:50%; transform:translateY(-50%);
      color:var(--color-text-muted); font-size:16px; pointer-events:none;
    }
    .os-search {
      padding:6px 12px 6px 32px; border:1px solid var(--color-border);
      border-radius:var(--radius-md); background:var(--color-surface);
      color:var(--color-text); font-size:var(--text-sm); width:200px;
    }
    .os-search:focus { outline:none; border-color:var(--color-accent); }
    .os-new-btn {
      display:flex; align-items:center; gap:var(--space-1);
      padding:7px 16px; background:var(--color-accent); color:#fff; border:none;
      border-radius:var(--radius-md); font-size:var(--text-sm);
      font-weight:var(--weight-semibold); cursor:pointer; white-space:nowrap;
    }
    .os-new-btn:hover { opacity:0.88; }
    /* Body layout */
    .os-body { display:flex; flex:1; overflow:hidden; }
    /* Rail */
    .os-rail {
      width:180px; flex-shrink:0; border-right:1px solid var(--color-border);
      background:var(--color-surface); padding:var(--space-3) 0; overflow-y:auto;
    }
    .os-rail-section {
      padding:var(--space-1) var(--space-3) var(--space-0-5);
      font-size:10px; font-weight:var(--weight-bold); letter-spacing:0.1em;
      text-transform:uppercase; color:var(--color-text-muted); margin-top:var(--space-2);
    }
    .os-rail-btn {
      display:flex; align-items:center; gap:var(--space-2); width:100%;
      padding:6px var(--space-3); background:none; border:none;
      border-left:2px solid transparent; color:var(--color-text-muted);
      font-size:var(--text-sm); cursor:pointer; text-align:left; transition:all 0.12s;
    }
    .os-rail-btn:hover { color:var(--color-text); background:var(--color-surface-2); }
    .os-rail-btn.active {
      color:var(--color-accent); border-left-color:var(--color-accent);
      background:var(--color-accent-muted);
    }
    .os-rail-count {
      margin-left:auto; font-size:10px; background:var(--color-surface-2);
      border:1px solid var(--color-border); border-radius:var(--radius-full); padding:0 5px;
      color:var(--color-text-muted);
    }
    /* Main */
    .os-main { flex:1; overflow-y:auto; padding:var(--space-5) var(--space-6); }
    /* Section header */
    .os-section-header {
      display:flex; align-items:center; gap:var(--space-2); margin-bottom:var(--space-3);
    }
    .os-section-title { font-size:var(--text-base); font-weight:var(--weight-semibold); color:var(--color-text); }
    .os-section-count {
      font-size:var(--text-xs); color:var(--color-text-muted);
      background:var(--color-surface); border:1px solid var(--color-border);
      border-radius:var(--radius-full); padding:1px 7px;
    }
    /* Type grid */
    .os-grid {
      display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr));
      gap:var(--space-3); margin-bottom:var(--space-6);
    }
    /* Type card */
    .os-type-card {
      position:relative; background:var(--color-surface);
      border:1.5px solid var(--color-border); border-radius:var(--radius-lg);
      padding:var(--space-4); cursor:pointer; overflow:hidden;
      transition:border-color 0.15s, transform 0.12s, box-shadow 0.15s;
      display:flex; flex-direction:column; gap:var(--space-2);
    }
    .os-type-card::before {
      content:''; position:absolute; top:0; left:0; right:0; height:3px;
      background:var(--card-accent, var(--color-border)); transition:background 0.15s;
    }
    .os-type-card:hover {
      border-color:var(--color-accent); transform:translateY(-2px);
      box-shadow:0 4px 16px rgba(0,0,0,0.06);
    }
    .os-type-card:hover::before { background:var(--color-accent); }
    .os-type-card.builtin { opacity:0.85; }
    .os-type-card.builtin:hover { opacity:1; }
    .os-card-icon { font-size:2rem; line-height:1; }
    .os-card-name { font-size:var(--text-base); font-weight:var(--weight-bold); color:var(--color-text); }
    .os-card-description {
      font-size:var(--text-xs); color:var(--color-text-muted); line-height:1.4; flex:1;
      display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;
    }
    .os-card-footer {
      display:flex; align-items:center; justify-content:space-between; margin-top:var(--space-1);
    }
    .os-card-count { font-size:var(--text-xs); color:var(--color-text-muted); }
    .os-badge-builtin {
      font-size:9px; padding:1px 6px; background:var(--color-surface-2);
      border:1px solid var(--color-border); border-radius:var(--radius-full);
      color:var(--color-text-muted); letter-spacing:0.05em;
    }
    .os-badge-custom {
      font-size:9px; padding:1px 6px; background:var(--color-accent-muted);
      border:1px solid transparent; border-radius:var(--radius-full);
      color:var(--color-accent); letter-spacing:0.05em;
    }
    /* Card action buttons — appear on hover */
    .os-card-actions {
      position:absolute; top:var(--space-2); right:var(--space-2);
      display:flex; gap:4px; opacity:0; transition:opacity 0.15s;
    }
    .os-type-card:hover .os-card-actions { opacity:1; }
    .os-card-action-btn {
      width:26px; height:26px; border:1px solid var(--color-border);
      border-radius:var(--radius-sm); background:var(--color-bg);
      color:var(--color-text-muted); font-size:14px; cursor:pointer;
      display:flex; align-items:center; justify-content:center; transition:all 0.12s;
    }
    .os-card-action-btn:hover {
      background:var(--color-surface-2); color:var(--color-text);
      border-color:var(--color-accent);
    }
    /* Wizard overlay */
    .os-wizard-overlay {
      position:fixed; inset:0; background:rgba(0,0,0,0.35); z-index:200;
      display:flex; align-items:center; justify-content:center;
      animation:os-fade-in 0.15s ease;
    }
    @keyframes os-fade-in { from{opacity:0}to{opacity:1} }
    .os-wizard {
      background:var(--color-bg); border:1px solid var(--color-border);
      border-radius:var(--radius-xl); width:min(540px,95vw);
      padding:var(--space-6); box-shadow:0 24px 64px rgba(0,0,0,0.18);
      animation:os-slide-up 0.18s ease;
    }
    @keyframes os-slide-up { from{transform:translateY(20px);opacity:0}to{transform:none;opacity:1} }
    .os-wizard-title { font-size:var(--text-lg); font-weight:var(--weight-bold); margin-bottom:var(--space-4); }
    .os-wizard-row { display:grid; grid-template-columns:1fr 1fr; gap:var(--space-3); }
    .os-wizard-step { margin-bottom:var(--space-4); }
    .os-wizard-label {
      display:block; font-size:var(--text-sm); font-weight:var(--weight-semibold);
      color:var(--color-text); margin-bottom:var(--space-1);
    }
    .os-wizard-input {
      width:100%; padding:8px 12px; border:1.5px solid var(--color-border);
      border-radius:var(--radius-md); background:var(--color-surface);
      color:var(--color-text); font-size:var(--text-sm); font-family:inherit;
    }
    .os-wizard-input:focus { outline:none; border-color:var(--color-accent); }
    .os-wizard-helper { font-size:var(--text-xs); color:var(--color-text-muted); margin-top:4px; }
    .os-emoji-grid {
      display:grid; grid-template-columns:repeat(10,1fr); gap:4px;
      margin-top:var(--space-2); max-height:160px; overflow-y:auto;
    }
    .os-emoji-btn {
      aspect-ratio:1; font-size:18px; border:1.5px solid transparent;
      border-radius:var(--radius-sm); background:none; cursor:pointer;
      display:flex; align-items:center; justify-content:center; transition:all 0.1s;
    }
    .os-emoji-btn:hover { background:var(--color-surface-2); }
    .os-emoji-btn.selected { border-color:var(--color-accent); background:var(--color-accent-muted); }
    .os-wizard-footer {
      display:flex; justify-content:flex-end; gap:var(--space-2);
      margin-top:var(--space-5); padding-top:var(--space-4); border-top:1px solid var(--color-border);
    }
    .os-btn-cancel {
      padding:7px 16px; border:1px solid var(--color-border); border-radius:var(--radius-md);
      background:none; color:var(--color-text-muted); font-size:var(--text-sm); cursor:pointer;
    }
    .os-btn-cancel:hover { background:var(--color-surface); color:var(--color-text); }
    .os-btn-create {
      padding:7px 20px; background:var(--color-accent); color:#fff; border:none;
      border-radius:var(--radius-md); font-size:var(--text-sm);
      font-weight:var(--weight-semibold); cursor:pointer;
    }
    .os-btn-create:hover { opacity:0.88; }
    .os-btn-create:disabled { opacity:0.5; cursor:default; }
    /* Empty custom types placeholder */
    .os-custom-empty {
      border:2px dashed var(--color-border); border-radius:var(--radius-lg);
      padding:var(--space-8) var(--space-4); text-align:center;
      cursor:pointer; transition:border-color 0.15s;
    }
    .os-custom-empty:hover { border-color:var(--color-accent); }
    .os-custom-empty-icon { font-size:2.5rem; opacity:0.4; }
    .os-custom-empty-title {
      font-size:var(--text-base); font-weight:var(--weight-semibold);
      color:var(--color-text); margin-top:var(--space-2);
    }
    .os-custom-empty-sub { font-size:var(--text-sm); color:var(--color-text-muted); margin-top:var(--space-1); }
    /* Loading / no-results */
    .os-loading {
      display:flex; align-items:center; justify-content:center;
      height:200px; color:var(--color-text-muted); font-size:var(--text-sm);
    }
  `;
  document.head.appendChild(s);
})();

// ── Emoji catalog for wizard ──────────────────────────────────────
const EMOJI_CATALOG = [
  '📝','📄','📋','📌','📎','🔖','📚','📖','📗','📘','📙','📓','📔','📒','📕',
  '💡','🎯','🎨','🎭','🎬','🎤','🎵','🎸','🎓','🏆','🥇','🏅','🎖',
  '🏠','🏢','🏥','🏫','🏗','🌍','🌱','🌿','🍀','🌸','🌺','🌙','☀️','⭐','🌟',
  '👤','👥','👨‍💼','👩‍💼','🧑‍🍳','🧑‍🏫','🧑‍⚕️','🧑‍💻','🧑‍🔬','🧑‍🎨',
  '🚀','✈️','🚗','🚲','⚽','🏀','🎾','💰','💳','📈','📉','📊','🗂','📅','⏰',
  '🍎','🍽','🍕','☕','🍵','💻','📱','⌨️','🔬','🧪','⚙️','🔧','🔨','📡','🧲',
  '❤️','💙','💚','💛','💜','🤍','🔥','⚡','💎','🔑','🗝','🔒','🎁','🎉','✦',
];

// ── HTML escape ───────────────────────────────────────────────────
function _esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Quick Create Wizard ───────────────────────────────────────────
let _wizardEl = null;

function _openWizard(onCreated) {
  if (_wizardEl?.isConnected) return;
  let selectedIcon = '◇';

  _wizardEl = document.createElement('div');
  _wizardEl.className = 'os-wizard-overlay';
  _wizardEl.innerHTML = `
    <div class="os-wizard" role="dialog" aria-modal="true">
      <div class="os-wizard-title">✨ New Object Type</div>
      <div class="os-wizard-row">
        <div class="os-wizard-step">
          <label class="os-wizard-label" for="ow-lbl">Singular name</label>
          <input id="ow-lbl" class="os-wizard-input" type="text" placeholder="e.g. Meeting" maxlength="40" autocomplete="off">
          <div class="os-wizard-helper">Used for individual objects</div>
        </div>
        <div class="os-wizard-step">
          <label class="os-wizard-label" for="ow-plural">Plural name</label>
          <input id="ow-plural" class="os-wizard-input" type="text" placeholder="e.g. Meetings" maxlength="40" autocomplete="off">
          <div class="os-wizard-helper">Used in sidebar &amp; headers</div>
        </div>
      </div>
      <div class="os-wizard-step">
        <label class="os-wizard-label">Icon</label>
        <div class="os-emoji-grid" id="ow-emoji-grid">
          ${EMOJI_CATALOG.map(e =>
            `<button class="os-emoji-btn${e === selectedIcon ? ' selected' : ''}" data-emoji="${_esc(e)}">${_esc(e)}</button>`
          ).join('')}
        </div>
      </div>
      <div class="os-wizard-step">
        <label class="os-wizard-label" for="ow-desc">Description <span style="font-weight:400;color:var(--color-text-muted)">(optional)</span></label>
        <input id="ow-desc" class="os-wizard-input" type="text" placeholder="What will you track?" maxlength="120" autocomplete="off">
      </div>
      <div class="os-wizard-footer">
        <button class="os-btn-cancel" id="ow-cancel">Cancel</button>
        <button class="os-btn-create" id="ow-create" disabled>Create Object Type →</button>
      </div>
    </div>
  `;

  const lblInput    = _wizardEl.querySelector('#ow-lbl');
  const pluralInput = _wizardEl.querySelector('#ow-plural');
  const createBtn   = _wizardEl.querySelector('#ow-create');

  // Emoji picker
  _wizardEl.querySelector('#ow-emoji-grid').addEventListener('click', e => {
    const btn = e.target.closest('.os-emoji-btn');
    if (!btn) return;
    selectedIcon = btn.dataset.emoji;
    _wizardEl.querySelectorAll('.os-emoji-btn').forEach(b => b.classList.toggle('selected', b === btn));
  });

  // Enable create when label is filled; auto-suggest plural
  lblInput.addEventListener('input', () => {
    const val = lblInput.value.trim();
    createBtn.disabled = !val;
    if (val && !pluralInput.dataset.manual) {
      pluralInput.placeholder = val + 's';
    }
  });
  pluralInput.addEventListener('input', () => { pluralInput.dataset.manual = '1'; });

  // Cancel / backdrop
  _wizardEl.querySelector('#ow-cancel').addEventListener('click', _closeWizard);
  _wizardEl.addEventListener('click', e => { if (e.target === _wizardEl) _closeWizard(); });

  // ESC key
  const _kd = e => { if (e.key === 'Escape') _closeWizard(); };
  document.addEventListener('keydown', _kd);
  _wizardEl._kd = _kd;

  // Create
  createBtn.addEventListener('click', async () => {
    const label  = lblInput.value.trim();
    const plural = pluralInput.value.trim() || label + 's';
    if (!label) return;
    createBtn.disabled = true;
    createBtn.textContent = 'Creating…';
    try {
      const config = await saveCustomObjectType({
        label,
        labelPlural: plural,
        icon:        selectedIcon || '◇',
        description: _wizardEl.querySelector('#ow-desc').value.trim(),
      });
      _closeWizard();
      if (onCreated) onCreated(config);
    } catch (err) {
      console.error('[object-studio] create type:', err);
      createBtn.disabled = false;
      createBtn.textContent = 'Create Object Type →';
    }
  });

  document.body.appendChild(_wizardEl);
  setTimeout(() => lblInput.focus(), 50);
}

function _closeWizard() {
  if (_wizardEl?._kd) document.removeEventListener('keydown', _wizardEl._kd);
  _wizardEl?.remove();
  _wizardEl = null;
}

// ── Card renderer ─────────────────────────────────────────────────
function _renderTypeCard(type, counts) {
  const count    = counts?.[type.key] || 0;
  const isBI     = type.isBuiltIn;
  const color    = type.color || (isBI ? 'var(--color-border)' : '#6366f1');
  const badge    = isBI
    ? `<span class="os-badge-builtin">Built-in</span>`
    : `<span class="os-badge-custom">Custom</span>`;
  const editBtn  = !isBI
    ? `<button class='os-card-action-btn' data-action='settings' data-type='${_esc(type.key)}' title='Type settings'>⚙</button>`
    : `<button class='os-card-action-btn' data-action='edit-builtin' data-type='${_esc(type.key)}' title='Customize appearance'>✏️</button>`;
  const desc = type.description
    ? `<div class="os-card-description">${_esc(type.description)}</div>`
    : `<div class="os-card-description" style="opacity:0" aria-hidden="true">—</div>`;

  return `
    <div class="os-type-card${isBI ? ' builtin' : ''}"
         data-type-key="${_esc(type.key)}"
         style="--card-accent:${_esc(color)}">
      <div class="os-card-actions">${editBtn}</div>
      <div class="os-card-icon">${_esc(type.icon || '◇')}</div>
      <div class="os-card-name">${_esc(type.labelPlural || type.label || type.key)}</div>
      ${desc}
      <div class="os-card-footer">
        <div class="os-card-count">◉ ${count} object${count !== 1 ? 's' : ''}</div>
        <div>${badge}</div>
      </div>
    </div>
  `;
}

function _renderSection(title, types, counts) {
  if (!types.length) return '';
  return `
    <div class="os-section-header">
      <span class="os-section-title">${_esc(title)}</span>
      <span class="os-section-count">${types.length}</span>
    </div>
    <div class="os-grid">
      ${types.map(t => _renderTypeCard(t, counts)).join('')}
    </div>
  `;
}

// ── Main render ───────────────────────────────────────────────────
async function renderObjectStudio(params = {}) {
  const el = document.getElementById('view-object-studio');
  if (!el) return;

  // Tear down old pub/sub listeners
  _unsubList.forEach(fn => fn());
  _unsubList = [];

  // Show skeleton while loading
  el.innerHTML = `
    <div class="os-topbar">
      <div class="os-studio-title">⬡ Object Studio</div>
    </div>
    <div class="os-loading">Loading object types…</div>
  `;

  let allTypes, counts;
  try {
    [allTypes, counts] = await Promise.all([getAllObjectTypes(), countByType()]);
  } catch (err) {
    console.error('[object-studio] load error:', err);
    el.innerHTML = `<div class="os-loading" style="color:var(--color-danger)">Failed to load types — check console</div>`;
    return;
  }

  const builtIns = allTypes.filter(t => t.isBuiltIn);
  const customs  = allTypes.filter(t => !t.isBuiltIn);

  // ── Build main panel content ─────────────────────────────────
  function _buildMain() {
    let list = allTypes;
    if (_activeFilter === 'builtin') list = builtIns;
    if (_activeFilter === 'custom')  list = customs;
    if (_searchQ) {
      const q = _searchQ.toLowerCase();
      list = list.filter(t =>
        (t.label || '').toLowerCase().includes(q) ||
        (t.labelPlural || '').toLowerCase().includes(q) ||
        (t.description || '').toLowerCase().includes(q) ||
        t.key.toLowerCase().includes(q)
      );
    }

    const visBI     = list.filter(t => t.isBuiltIn);
    const visCustom = list.filter(t => !t.isBuiltIn);

    let html = '';
    if (_activeFilter !== 'custom') html += _renderSection('Basic Object Types', visBI, counts);

    if (_activeFilter !== 'builtin') {
      if (!visCustom.length && !_searchQ) {
        html += `
          <div class="os-section-header">
            <span class="os-section-title">Custom Object Types</span>
            <span class="os-section-count">0</span>
          </div>
          <div class="os-custom-empty" data-action="create-empty">
            <div class="os-custom-empty-icon">✦</div>
            <div class="os-custom-empty-title">Create your first custom type</div>
            <div class="os-custom-empty-sub">Design object types that fit your family workflows</div>
          </div>
        `;
      } else {
        html += _renderSection('Custom Object Types', visCustom, counts);
      }
    }
    return html || `<div class="os-loading">No types match "${_esc(_searchQ)}"</div>`;
  }

  // ── Build full skeleton ──────────────────────────────────────
  el.innerHTML = `
    <div class="os-topbar">
      <div class="os-topbar-left">
        <div class="os-studio-title">
          ⬡ Object Studio
          <span class="os-studio-badge">${allTypes.length} types</span>
        </div>
        <div class="os-search-wrap">
          <input class="os-search" id="os-search" type="search"
                 placeholder="Search types…" value="${_esc(_searchQ)}">
        </div>
      </div>
      <button class="os-new-btn" id="os-new-btn">+ New Type</button>
    </div>
    <div class="os-body">
      <nav class="os-rail" id="os-rail">
        <div class="os-rail-section">Filter</div>
        <button class="os-rail-btn${_activeFilter === 'all'     ? ' active' : ''}" data-filter="all">
          All Types <span class="os-rail-count">${allTypes.length}</span>
        </button>
        <button class="os-rail-btn${_activeFilter === 'builtin' ? ' active' : ''}" data-filter="builtin">
          Basic <span class="os-rail-count">${builtIns.length}</span>
        </button>
        <button class="os-rail-btn${_activeFilter === 'custom'  ? ' active' : ''}" data-filter="custom">
          Custom <span class="os-rail-count">${customs.length}</span>
        </button>
      </nav>
      <div class="os-main" id="os-main"></div>
    </div>
  `;

  const mainEl = el.querySelector('#os-main');
  mainEl.innerHTML = _buildMain();

  // ── Rail filter — delegated from rail nav ────────────────────
  el.querySelector('#os-rail').addEventListener('click', e => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    _activeFilter = btn.dataset.filter;
    el.querySelectorAll('.os-rail-btn').forEach(b => b.classList.toggle('active', b === btn));
    mainEl.innerHTML = _buildMain();
  });

  // ── Search ───────────────────────────────────────────────────
  el.querySelector('#os-search').addEventListener('input', e => {
    _searchQ = e.target.value;
    mainEl.innerHTML = _buildMain();
  });

  // ── New Type button ───────────────────────────────────────────
  el.querySelector('#os-new-btn').addEventListener('click', () => {
    _openWizard(cfg => openTypeEditor(cfg.key, () => renderObjectStudio(params)));
  });

  // ── Main panel delegation (single persistent handler) ─────────
  // Handles: settings button, empty-state CTA, type card navigation.
  // mainEl.innerHTML is replaced in-place — no listener accumulation.
  mainEl.addEventListener('click', e => {
    // ✏️ Edit button on built-in card
    const editBuiltinBtn = e.target.closest('[data-action="edit-builtin"]');
    if (editBuiltinBtn) {
      e.stopPropagation();
      openTypeEditor(editBuiltinBtn.dataset.type, () => renderObjectStudio(params));
      return;
    }
    // ⚙ Settings button on custom card
    const settingsBtn = e.target.closest('[data-action="settings"]');
    if (settingsBtn) {
      e.stopPropagation();
      openTypeEditor(settingsBtn.dataset.type, () => renderObjectStudio(params));
      return;
    }
    // Empty-state CTA
    if (e.target.closest('[data-action="create-empty"]')) {
      _openWizard(cfg => openTypeEditor(cfg.key, () => renderObjectStudio(params)));
      return;
    }
    // Type card → navigate to entity-type view
    const card = e.target.closest('[data-type-key]');
    if (card) navigate('entity-type', { entityType: card.dataset.typeKey });
  });

  // ── React to type and entity changes ─────────────────────────
  _unsubList.push(on(EVENTS.TYPE_CREATED, () => renderObjectStudio(params)));
  _unsubList.push(on(EVENTS.TYPE_FIELD_REMOVED, ({ deleted } = {}) => {
    if (deleted) renderObjectStudio(params);
  }));
  _unsubList.push(on(EVENTS.ENTITY_SAVED, () => {
    // Refresh counts only — no full re-render needed
    countByType().then(nc => {
      Object.assign(counts, nc);
      mainEl.innerHTML = _buildMain();
    }).catch(() => {});
  }));
  _unsubList.push(on(EVENTS.ENTITY_DELETED, () => {
    // Refresh counts when an entity is deleted — otherwise cards show stale counts
    countByType().then(nc => {
      Object.assign(counts, nc);
      mainEl.innerHTML = _buildMain();
    }).catch(() => {});
  }));
}

registerView('object-studio', renderObjectStudio);
