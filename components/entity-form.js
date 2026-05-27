/**
 * FamilyHub v4.2 — components/entity-form.js
 * Universal create/edit form — modal on desktop, full-screen on mobile.
 * Blueprint §5.2 (entity form), Phase 1-C
 *
 * Public API:
 *   openForm(typeKey, prefillProps?, onSave?)  — open form for new entity
 *   openEditForm(entity, onSave?)              — open form to edit existing entity
 *   closeForm()                                — close and discard draft
 *   initEntityForm()                           — wire FAB events (call once on boot)
 */

import { saveEntity, saveEdge, deleteEdge, deleteEntity, getEdgesFrom, getEdgesTo,
         getEntitiesByType, getEntity, getSetting }            from '../core/db.js';
import { getEntityTypeConfig, getAllEntityTypes,
         convertEntity }                     from '../core/graph-engine.js';
import { emit, on, EVENTS }                                    from '../core/events.js';
import { toast }                                               from '../core/toast.js';
import { getAccount }                                          from '../core/auth.js';
import { getActiveContext, ALWAYS_SHARED_TYPES }               from '../core/context.js';
import { presetToRrule, rruleToHuman, nextNDates }
  from '../services/rrule-lite.js'; // [v5.3.1]

// ── Module-level state ────────────────────────────────────── //

/** @type {HTMLElement|null} */
let _overlay = null;

/** @type {object|null} draft form values {fieldKey: value} */
let _draft = null;

/** @type {string|null} current type key */
let _typeKey = null;

/** @type {object|null} entity being edited (null = create mode) */
let _editEntity = null;

/** @type {Function|null} */
let _onSave = null;

/** @type {Map<string, string[]>} relation field → array of entity IDs selected */
const _relationValues = new Map();

/** @type {Map<string, string[]>} tags field → array of tag strings */
const _tagValues = new Map();

/** Active tab key in edit-mode form: 'fields' | 'details' | 'relations' */
let _activeFormTab = 'fields';

/** True while _submitForm is in-flight — prevents ENTITY_SAVED re-entering the form */
let _formIsSaving = false;
/** Form tab bodies — promoted to module scope so _refreshFormTabs can access them */
let _tab2Body = null;  // Activity tab
let _tab3Body = null;  // Connections tab
let _tab4Body = null;  // Reminders tab
let _tab5Body = null;  // Tasks tab (project edit only) [v5.9.4]

/** Cleanup fns for form-lifetime event subscriptions — called in closeForm */
let _formEventUnsubs = [];
let _selfDeleting    = false; // [v6.4.4] flag: suppress ENTITY_DELETED toast when form is the deleter

// ── Date helper [v5.3.1] ──────────────────────────────────── //
/** Return today as YYYY-MM-DD using local time (never toISOString). */
function _todayStr() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}


/** Stack of saved parent form states for stacked (child) forms.
 *  When closeForm runs, if a parent state exists, it is restored. */
const _parentFormStack = [];

// ── Colorful palette for relation/tag chips — cycles through vibrant hues ── //
const _CHIP_PALETTE = [
  { bg: '#6366f1', text: '#fff' }, // indigo
  { bg: '#8b5cf6', text: '#fff' }, // violet
  { bg: '#ec4899', text: '#fff' }, // pink
  { bg: '#f97316', text: '#fff' }, // orange
  { bg: '#14b8a6', text: '#fff' }, // teal
  { bg: '#3b82f6', text: '#fff' }, // blue
  { bg: '#22c55e', text: '#fff' }, // green
  { bg: '#e11d48', text: '#fff' }, // rose
];
function _chipColor(index) {
  return _CHIP_PALETTE[index % _CHIP_PALETTE.length];
}

// ════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════

/**
 * Wire FAB and keyboard events. Call once during app boot.
 */
export function initEntityForm() {
  // fab:create is handled exclusively by fab.js, which calls openForm() directly.
  // No listener here — a second listener caused every FAB action to open the form twice.

  // Global Cmd+Enter to save if form is open
  document.addEventListener('keydown', (e) => {
    if (!_overlay) return;

    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      _submitForm();
      return;
    }

    if (e.key === 'Escape') {
      // If focus is inside a form input/select/textarea, let the input
      // handle its own Esc first (clear value, blur) — only close the
      // form if focus is on the overlay itself or a non-editable element
      const active = document.activeElement;
      const isInsideInput = active &&
        _overlay.contains(active) &&
        (active.tagName === 'INPUT' ||
         active.tagName === 'TEXTAREA' ||
         active.tagName === 'SELECT' ||
         active.isContentEditable);

      if (!isInsideInput) {
        e.preventDefault();
        closeForm();
      }
      // If inside an input: let the input's own Esc handler fire,
      // then a second Esc (after blur) will hit this branch and close.
    }
  });

  console.log('[entity-form] Initialised.');
}

// ════════════════════════════════════════════════════════════
// PUBLIC API
// ════════════════════════════════════════════════════════════

/**
 * Open the form to create a new entity.
 * @param {string}   typeKey      - entity type key (e.g. 'task', 'note')
 * @param {object}   [prefill]    - field values to pre-populate
 * @param {Function} [onSave]     - callback(entity) after successful save
 */
export function openForm(typeKey, prefill = {}, onSave = null) {
  _activeFormTab = 'fields'; // reset tab on fresh open
  const config = getEntityTypeConfig(typeKey);
  if (!config) {
    console.warn(`[entity-form] Unknown type "${typeKey}"`);
    return;
  }

  _typeKey    = typeKey;
  _editEntity = null;
  _onSave     = onSave;
  _draft      = { ...prefill };

  // CS-05: Auto-fill context from active context if not already set
  if (!_draft.context && !ALWAYS_SHARED_TYPES.has(typeKey)) {
    const activeCtx = getActiveContext();
    _draft.context = activeCtx === 'all' ? 'personal' : activeCtx; // SYS-04: default personal not family
  }

  _relationValues.clear();
  _tagValues.clear();

  // Apply field-level defaultValues for new entities (not edits)
  // This sets sensible defaults (e.g. project status=Active) without overriding explicit prefill
  if (!_editEntity) {
    for (const f of config.fields) {
      if (f.defaultValue !== undefined && _draft[f.key] === undefined) {
        _draft[f.key] = f.defaultValue;
      }
    }
  }

  // Pre-populate relation fields from prefill ID values.
  // When callers pass { project: 'some-id' }, the form should show that relation
  // pre-selected rather than leaving the picker empty.
  // We do async look-ups after mounting so the form renders first (non-blocking).
  _preFillRelations(config, prefill);

  _buildAndMount(config);
}

/**
 * Pre-populate _relationValues for any relation field whose key appears in prefill
 * as a plain entity ID string. Runs async after mount so UI renders without delay.
 * @param {object} config  - entity type config
 * @param {object} prefill - caller-provided prefill values
 */
async function _preFillRelations(config, prefill) {
  for (const field of config.fields) {
    if (field.type !== 'relation') continue;
    const prefillVal = prefill[field.key];
    // Accept a plain ID string or an array of ID strings
    const ids = Array.isArray(prefillVal)
      ? prefillVal
      : (typeof prefillVal === 'string' && prefillVal ? [prefillVal] : []);
    if (!ids.length) continue;

    const entities = await Promise.all(ids.map(id => getEntity(id).catch(() => null)));
    const valid = entities.filter(Boolean);
    if (valid.length) {
      _relationValues.set(field.key, valid);
      // Refresh the relation control UI if the form is still open
      const control = _overlay?.querySelector(`[data-field="${field.key}"] .ef-relation-control`);
      if (control) _refreshRelationChips(control, field);
    }
  }
}

/**
 * Refresh the displayed chips in a relation control after async prefill.
 * @param {HTMLElement} control
 * @param {object} field
 */
function _refreshRelationChips(control, field) {
  const chipWrap = control.querySelector('.ef-relation-chips');
  if (!chipWrap) return;
  chipWrap.innerHTML = '';
  const vals = _relationValues.get(field.key) || [];
  for (let i = 0; i < vals.length; i++) {
    const entity = vals[i];
    const { bg, text } = _chipColor(i);
    const chip = document.createElement('span');
    chip.className = 'ef-relation-chip';
    chip.style.cssText = `display:inline-flex;align-items:center;gap:5px;padding:4px 10px;background:${bg};color:${text};border-radius:99px;font-size:var(--text-sm);font-weight:600;letter-spacing:0.01em;box-shadow:0 1px 3px rgba(0,0,0,0.15);`;
    const labelEl = document.createElement('span');
    labelEl.textContent = entity.title || entity.name || entity.label || entity.id;
    chip.appendChild(labelEl);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.textContent = '×';
    rm.style.cssText = `background:none;border:none;color:${text};opacity:0.75;cursor:pointer;padding:0 0 0 4px;font-size:1em;line-height:1;`;
    rm.addEventListener('click', () => {
      const arr = _relationValues.get(field.key) || [];
      _relationValues.set(field.key, arr.filter(e => e.id !== entity.id));
      chip.remove();
    });
    chip.appendChild(rm);
    chipWrap.appendChild(chip);
  }
}

/**
 * Open the form to edit an existing entity.
 * @param {object|string} entityOrId  — full entity object OR entity ID string
 * @param {Function}      [onSave]
 */
export async function openEditForm(entityOrId, onSave = null) {
  // Accept either a full entity object or a bare string ID
  let entity = entityOrId;
  if (typeof entityOrId === 'string') {
    entity = await getEntity(entityOrId).catch(() => null);
    if (!entity) {
      console.warn(`[entity-form] openEditForm: entity "${entityOrId}" not found`);
      return;
    }
  }

  _activeFormTab = 'fields'; // reset tab on fresh open
  const config = getEntityTypeConfig(entity.type);
  if (!config) {
    console.warn(`[entity-form] Unknown type "${entity.type}"`);
    return;
  }

  _typeKey    = entity.type;
  _editEntity = entity;
  _onSave     = onSave;
  _draft      = { ...entity };
  _relationValues.clear();
  _tagValues.clear();

  // Pre-populate tag fields from entity
  for (const field of config.fields) {
    if (field.type === 'tags' && Array.isArray(entity[field.key])) {
      _tagValues.set(field.key, [...entity[field.key]]);
    }
  }

  _buildAndMount(config);
}

/**
 * Close and discard the form.
 */
export function closeForm() {
  if (!_overlay) return;

  // Cancel form-lifetime event subscriptions immediately (before the 200ms teardown)
  _formEventUnsubs.forEach(fn => { try { fn(); } catch {} });
  _formEventUnsubs = [];

  _overlay.classList.add('ef-closing');
  setTimeout(() => {
    _overlay?.remove();
    _overlay    = null;
    _draft      = null;
    _typeKey    = null;
    _editEntity = null;
    _onSave     = null;
    _relationValues.clear();
    _tagValues.clear();
    _tab2Body = null; _tab3Body = null; _tab4Body = null; _tab5Body = null; // [fix] clear so _refreshFormTabs is a no-op when no form

    // If a parent form was stacked, restore it
    if (_parentFormStack.length > 0) {
      const ps = _parentFormStack.pop();
      setTimeout(() => {
        _overlay       = ps.overlay;
        _typeKey       = ps.typeKey;
        _editEntity    = ps.editEntity;
        _draft         = ps.draft;
        _onSave        = ps.onSave;
        _activeFormTab = ps.activeTab;
        _relationValues.clear();
        for (const [k, v] of ps.relVals) _relationValues.set(k, v);
        _tagValues.clear();
        for (const [k, v] of ps.tagVals) _tagValues.set(k, v);
        if (_overlay) {
          _overlay.style.display = '';
          document.body.appendChild(_overlay);
        }
        // Run the onCreated/onCancel callback if present
        if (ps.onCancel) ps.onCancel();
      }, 50);
    }
  }, 200);
}

// ════════════════════════════════════════════════════════════
// BUILD & MOUNT
// ════════════════════════════════════════════════════════════

function _buildAndMount(config) {
  // If there's already an open form and we're not in a stack operation,
  // push current state to stack so it can be restored
  const existingOverlay = document.querySelector('.ef-overlay');
  if (existingOverlay && existingOverlay === _overlay && _overlay && _parentFormStack.length === 0) {
    // Save current form to stack automatically
    _parentFormStack.push({
      overlay: _overlay,
      typeKey: _typeKey,
      editEntity: _editEntity,
      draft: _draft ? { ..._draft } : null,
      onSave: _onSave,
      relVals: new Map(_relationValues),
      tagVals: new Map(_tagValues),
      activeTab: _activeFormTab,
      onCancel: null,
    });
    _overlay.style.display = 'none';
    _overlay.remove();
  } else {
    // Remove any existing form
    document.querySelector('.ef-overlay')?.remove();
  }

  // ── Overlay ──────────────────────────────────────────── //
  _overlay = document.createElement('div');
  _overlay.className   = 'modal-overlay ef-overlay';
  _overlay.setAttribute('role', 'dialog');
  _overlay.setAttribute('aria-modal', 'true');
  _overlay.setAttribute('aria-label', `${_editEntity ? 'Edit' : 'New'} ${config.label}`);

  // Click outside to close
  _overlay.addEventListener('click', (e) => {
    if (e.target === _overlay) closeForm();
  });

  // ── Modal shell ──────────────────────────────────────── //
  const modal = document.createElement('div');
  modal.className = 'modal ef-modal';
  // Widen modal for edit mode (tab strip needs breathing room)
  modal.style.cssText = _editEntity ? 'max-width: 660px;' : 'max-width: 560px;';

  // ── Header ───────────────────────────────────────────── //
  const header = document.createElement('div');
  // All layout via inline styles — immune to stale CSS cache
  header.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:12px 16px;border-bottom:1px solid var(--color-border);flex-shrink:0;';

  // ── Header top row: type selector + close button ────── //
  const headerTop = document.createElement('div');
  headerTop.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;';

  // Type selector
  const typeSelect = document.createElement('select');
  typeSelect.className  = 'select ef-type-select';
  typeSelect.style.cssText = 'width: auto; padding: var(--space-1) var(--space-2); font-size: var(--text-sm); border-color: transparent; background: var(--color-surface-2); cursor: pointer;';
  typeSelect.setAttribute('aria-label', 'Entity type');
  // In edit mode the type is fixed — switching type discards all field data
  if (_editEntity) {
    typeSelect.disabled = true;
    typeSelect.title    = 'Use Convert to change entity type';
    typeSelect.style.opacity = '0.6';
    typeSelect.style.cursor  = 'not-allowed';
  }

  const allTypes = getAllEntityTypes();
  // In create mode, filter out internal/system types users shouldn't create directly.
  // [G01 fix] Extended HIDDEN_TYPES to include all scheduler/system entity types.
  const HIDDEN_TYPES = new Set([
    'dailyReview', 'tag', 'comment',
    'taskInstance', // [G01] auto-generated by recurrence scheduler — never user-created
    'reminderLog',  // [G01] audit trail — never user-created
    'rule',         // [G01] auto-rule engine — managed via auto-rules UI
    'message',      // [G01] managed via messages view
    'activityLog',  // [G01] internal activity log
  ]);
  // [G06 fix] Also exclude types flagged graphVisible:false — they are internal types
  // not designed for direct creation (reminderLog, rule, etc. caught above already)
  const visibleTypes = _editEntity
    ? allTypes
    : allTypes.filter(t => !HIDDEN_TYPES.has(t.key) && t.graphVisible !== false);
  for (const t of visibleTypes) {
    const opt = document.createElement('option');
    opt.value       = t.key;
    opt.textContent = `${t.icon} ${t.label}`;
    if (t.key === _typeKey) opt.selected = true;
    typeSelect.appendChild(opt);
  }

  typeSelect.addEventListener('change', () => {
    // Preserve title/name across type switch
    _saveDraftFromForm();
    const oldTitleField = config.fields.find(f => f.isTitle);
    const oldTitle = oldTitleField ? _draft[oldTitleField.key] : null;

    _typeKey = typeSelect.value;
    const newConfig = getEntityTypeConfig(_typeKey);
    if (!newConfig) return;

    const newTitleField = newConfig.fields.find(f => f.isTitle);
    if (oldTitle && newTitleField) {
      _draft[newTitleField.key] = oldTitle;
    }

    _relationValues.clear();
    _tagValues.clear();
    // Target the scrollable fields container inside tab1Body, not the outer body
    const fieldsTarget = body.querySelector('.ef-fields-scroll') || body;
    _rebuildBody(newConfig, fieldsTarget);
    _updateHeader(header, newConfig, typeSelect);

    // [G09 fix] Update tab4 (Reminders) visibility when type changes
    // reminder and reminderLog types should not show the Reminders tab
    const _newNoRemindersTab = ['reminder', 'reminderLog', 'taskInstance'].includes(_typeKey);
    if (tab4Btn) {
      tab4Btn.style.display = _newNoRemindersTab ? 'none' : '';
    }
    // If currently on reminders tab and new type doesn't support it, switch to fields
    if (_activeFormTab === 'reminders' && _newNoRemindersTab) {
      _switchTab('fields');
    }
  });

  headerTop.appendChild(typeSelect);

  const closeBtn = document.createElement('button');
  closeBtn.style.cssText = 'display:flex;align-items:center;gap:4px;padding:5px 10px;border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-surface);cursor:pointer;color:var(--color-text-muted);font-size:var(--text-xs);font-family:var(--font-body);margin-left:auto;transition:all 0.12s;';
  closeBtn.innerHTML = '✕ <span style="font-size:var(--text-xs);font-weight:500">Close</span>';
  closeBtn.setAttribute('aria-label', 'Close form');
  closeBtn.addEventListener('click', closeForm);
  headerTop.appendChild(closeBtn);

  header.appendChild(headerTop);

  // ── Header title row ────────────────────────────────── //
  const titleRow = document.createElement('div');
  titleRow.style.cssText = 'display:flex;align-items:center;width:100%;min-height:32px;padding-top:2px;';

  const title = document.createElement('h2');
  title.className = 'ef-modal-title';
  title.style.cssText = 'font-family:var(--font-heading,system-ui,sans-serif);font-size:var(--text-xl,1.25rem);font-weight:700;color:var(--color-text);margin:0;line-height:1.3;';
  title.textContent = _editEntity ? `Edit ${config.label}` : `New ${config.label}`;
  titleRow.appendChild(title);
  header.appendChild(titleRow);

  // ── Tab strip ─────────────────────────────────────────── //
  let tabStrip = null;
  let tab1Body = null;
  // _tab2Body/_tab3Body/_tab4Body are module-level so _refreshFormTabs can reach them
  _tab2Body = null;
  _tab3Body = null;
  _tab4Body = null;

  // Show tab strip in both create and edit modes for visual consistency
  tabStrip = document.createElement('div');
  tabStrip.style.cssText = [
    'display: flex; gap: 2px; padding: 0 16px;',
    'border-bottom: 1px solid var(--color-border);',
    'background: var(--color-surface); flex-shrink: 0;',
  ].join(' ');

  const _mkTab = (key, label, icon, disabled = false) => {
    const btn = document.createElement('button');
    btn.dataset.tabKey = key;
    btn.style.cssText = [
      'padding: 9px 14px 8px; border: none; background: none; cursor: pointer;',
      'font-size: var(--text-sm); font-family: var(--font-body);',
      'display: flex; align-items: center; gap: 6px;',
      'border-bottom: 2px solid transparent; margin-bottom: -1px;',
      'transition: color 0.12s, border-color 0.12s;',
    ].join(' ');
    btn.innerHTML = `<span style="font-size:13px">${icon}</span><span>${label}</span>`;
    if (disabled) {
      btn.disabled = true;
      btn.setAttribute('aria-disabled', 'true');
      btn.style.opacity = '0.35';
      btn.style.cursor = 'default';
      btn.title = 'Save first to unlock';
    }
    return btn;
  };

  const tab1Btn = _mkTab('fields',    'Details',                                       '📋');
  // Tab 2: Activity — time tracking (tasks) + metadata + change history
  const tab2Btn = _mkTab('details',   'Activity',                                      '⚡');
  // Tab 3: Connections — action buttons + entity relations
  const tab3Btn = _mkTab('relations', 'Connections',                                   '🔗');
  // Tab 4: Reminders — not shown for reminder/reminderLog entities (no sub-reminders)
  const _noRemindersTab = ['reminder', 'reminderLog', 'taskInstance'].includes(_typeKey);
  const tab4Btn = _noRemindersTab ? null : _mkTab('reminders', 'Reminders',            '🔔');
  // [v5.9.4] Tasks tab — only in EDIT mode for project type
  const _showTasksTab = !!_editEntity && _typeKey === 'project';
  const tab5Btn = _showTasksTab ? _mkTab('tasks', 'Tasks', '✅') : null;

  const _applyTabStyles = () => {
    [tab1Btn, tab2Btn, tab3Btn, tab4Btn, tab5Btn].filter(Boolean).forEach(b => {
      const active = b.dataset.tabKey === _activeFormTab;
      b.style.color = active ? 'var(--color-accent)' : 'var(--color-text-muted)';
      b.style.borderBottomColor = active ? 'var(--color-accent)' : 'transparent';
      b.style.fontWeight = active ? '600' : '400';
    });
  };

  // Always wire tab switching — all tabs accessible in both create and edit mode.
  // Individual tab builders handle the create-mode "save first" messaging internally.
  const _switchTab = (key) => {
    _activeFormTab = key;
    _applyTabStyles();
    if (tab1Body) tab1Body.style.display = key === 'fields'    ? 'flex' : 'none';
    if (_tab2Body) _tab2Body.style.display = key === 'details'   ? 'flex' : 'none';
    if (_tab3Body) _tab3Body.style.display = key === 'relations' ? 'flex' : 'none';
    if (_tab4Body) _tab4Body.style.display = key === 'reminders' ? 'flex' : 'none';
    if (_tab5Body) _tab5Body.style.display = key === 'tasks'     ? 'flex' : 'none'; // [v5.9.4]
    // Hide footer (Save button) only in EDIT mode on non-fields tabs.
    // In CREATE mode, always show footer so user can save from any tab.
    const footerEl = modal.querySelector('.modal-footer');
    if (footerEl) {
      const hideFooter = !!_editEntity && (key === 'details' || key === 'relations' || key === 'reminders' || key === 'tasks');
      footerEl.style.display = hideFooter ? 'none' : '';
    }
    // [v5.9.4] Lazy-load Tasks tab on first activate
    if (key === 'tasks' && _tab5Body && !_tab5Body.dataset.loaded) {
      _tab5Body.dataset.loaded = '1';
      _buildFormTasksTab(_tab5Body, _editEntity).catch(e => console.warn('[entity-form] Tasks tab error:', e));
    }
    // Lazy-load Tab 2 on first open (or if marked dirty by external save)
    if (key === 'details' && _tab2Body && (!_tab2Body.dataset.loaded || _tab2Body.dataset.loaded === 'dirty')) {
      _tab2Body.dataset.loaded = '1';
      const freshConfig = _editEntity ? getEntityTypeConfig(_editEntity.type) : config;
      _buildDetailsTab(_tab2Body, freshConfig || config).catch(e => console.warn('[entity-form] Activity tab error:', e));
    }
    // Lazy-load Tab 3 on first open (or if marked dirty)
    if (key === 'relations' && _tab3Body && (!_tab3Body.dataset.loaded || _tab3Body.dataset.loaded === 'dirty')) {
      _tab3Body.dataset.loaded = '1';
      _buildRelationsTab(_tab3Body);
    }
    if (key === 'reminders' && _tab4Body && (!_tab4Body.dataset.loaded || _tab4Body.dataset.loaded === 'dirty')) {
      _tab4Body.dataset.loaded = '1';
      _buildRemindersTab(_tab4Body);
    }
  };

  tab1Btn.addEventListener('click', () => _switchTab('fields'));
  tab2Btn.addEventListener('click', () => _switchTab('details'));
  tab3Btn.addEventListener('click', () => _switchTab('relations'));
  if (tab4Btn) tab4Btn.addEventListener('click', () => _switchTab('reminders'));
  if (tab5Btn) tab5Btn.addEventListener('click', () => _switchTab('tasks')); // [v5.9.4]

  tabStrip.appendChild(tab1Btn);
  tabStrip.appendChild(tab2Btn);
  tabStrip.appendChild(tab3Btn);
  if (tab4Btn) tabStrip.appendChild(tab4Btn);
  if (tab5Btn) tabStrip.appendChild(tab5Btn); // [v5.9.4] Tasks tab
  _applyTabStyles();

  // ── Body ─────────────────────────────────────────────── //
  const body = document.createElement('div');
  // Always use tabbed layout — tab bodies handle their own padding/scrolling.
  body.className = 'ef-body';
  body.style.cssText = 'display:flex;flex-direction:column;flex:1;overflow:hidden;padding:0;';

  // ── Tab 1: Details (form fields) — always built immediately ──
  tab1Body = document.createElement('div');
  tab1Body.style.cssText = 'display: flex; flex-direction: column; flex: 1; min-height: 0; padding: 0; gap: 0;';

  // Fields scroll container (padded, scrollable) — same in both modes
  const fieldsScroll = document.createElement('div');
  fieldsScroll.className = 'ef-fields-scroll';
  fieldsScroll.style.cssText = 'flex: 1; overflow-y: auto; padding: var(--space-4) var(--space-5);';
  _rebuildBodyInto(config, fieldsScroll);
  tab1Body.appendChild(fieldsScroll);

  if (_editEntity) {
    // ── Edit-mode action bar: status toggle + open graph ────────
    let _tab1BarBuilding = false;
    const _buildTab1ActionBar = () => {
      if (_tab1BarBuilding) return;
      _tab1BarBuilding = true;
      const existing = tab1Body.querySelector('.ef-tab1-actionbar');
      if (existing) existing.remove();

      const actionBar = document.createElement('div');
      actionBar.className = 'ef-tab1-actionbar';
      actionBar.style.cssText = [
        'display: flex; align-items: center; gap: 8px; flex-wrap: wrap;',
        'padding: 10px 20px 8px;',
        'border-bottom: 1px solid var(--color-border);',
        'background: var(--color-surface); flex-shrink: 0;',
      ].join(' ');

      // ── Reminder status actions (reminder entities only) ──────────────
      if (_editEntity?.type === 'reminder') {
        const svc = window._fhEnv?.services?.reminder;
        const r   = _editEntity;
        const isPaused   = r.status === 'paused';
        const isInactive = r.status === 'dismissed' || r.status === 'expired';

        const _rBtn = (label, bg, fg, handler) => {
          const b = document.createElement('button');
          b.style.cssText = `display:inline-flex;align-items:center;gap:5px;padding:5px 11px;
            border-radius:var(--radius-md);cursor:pointer;font-size:var(--text-sm);
            font-family:var(--font-body);transition:all 0.15s;
            background:${bg};color:${fg};border:1px solid ${bg};`;
          b.innerHTML = label;
          b.addEventListener('click', async () => {
            b.disabled = true;
            try { await handler(); } catch (e) { console.error(e); toast.error('Action failed'); }
            b.disabled = false;
          });
          return b;
        };

        if (!isInactive) {
          // ✓ Done — delete one-shot, advance recurrence for recurring
          actionBar.appendChild(_rBtn('✓ Done',
            'var(--color-success-bg,#f0fdf4)', 'var(--color-success-text,#15803d)',
            async () => {
              await svc?.markDone(r.id);
              toast.success(r.rrule ? 'Advanced to next occurrence ✓' : 'Reminder removed ✓');
              closeForm();
            }
          ));

          // ⏰ Snooze
          actionBar.appendChild(_rBtn('⏰ Snooze',
            'var(--color-surface-2,#f1f5f9)', 'var(--color-text)',
            async () => {
              await svc?.snooze(r.id);
              const fresh = await getEntity(r.id).catch(() => null);
              if (fresh) { _editEntity = fresh; _draft = { ...fresh }; }
              toast.success('Snoozed');
              _buildTab1ActionBar();
            }
          ));

          // ⏸ Pause / ▶ Resume
          actionBar.appendChild(_rBtn(isPaused ? '▶ Resume' : '⏸ Pause',
            'var(--color-surface-2,#f1f5f9)', 'var(--color-text)',
            async () => {
              if (isPaused) await svc?.resume(r.id); else await svc?.pause(r.id);
              const fresh = await getEntity(r.id).catch(() => null);
              if (fresh) { _editEntity = fresh; _draft = { ...fresh }; }
              toast.success(isPaused ? 'Resumed' : 'Paused');
              _buildTab1ActionBar();
            }
          ));
        }

        if (isInactive) {
          actionBar.appendChild(_rBtn('↻ Re-activate',
            'var(--color-surface-2,#f1f5f9)', 'var(--color-text)',
            async () => {
              const fresh = await getEntity(r.id).catch(() => null);
              if (!fresh) return;
              const saved = await saveEntity({ ...fresh, status: 'active', dismissedAt: null, nextFireAt: fresh.fireAt }, getAccount()?.id);
              _editEntity = saved; _draft = { ...saved };
              toast.success('Reminder re-activated');
              _buildTab1ActionBar();
            }
          ));
        }
      }

      // ── Delete button (tasks only) — [v6.4.4] moved from Connections tab, placed first ──
      if (_editEntity?.type === 'task' && _editEntity?.id) {
        const _taskConfig = getEntityTypeConfig('task');
        const _taskActions = _taskConfig?.actions || [];
        if (_taskActions.includes('delete')) {
          const delBtn = document.createElement('button');
          delBtn.style.cssText = [
            'display: inline-flex; align-items: center; gap: 6px;',
            'padding: 5px 11px; border-radius: var(--radius-md); cursor: pointer;',
            'font-size: var(--text-sm); font-family: var(--font-body); transition: all 0.15s;',
            'background: var(--color-danger-bg,#fee2e2); color: var(--color-danger,#dc2626);',
            'border: 1px solid var(--color-danger,#dc2626);',
          ].join(' ');
          delBtn.innerHTML = '<span style="font-size:13px">🗑️</span><span>Delete</span>';
          delBtn.title = 'Delete this task';
          delBtn.addEventListener('mouseenter', () => delBtn.style.filter = 'brightness(0.92)');
          delBtn.addEventListener('mouseleave', () => delBtn.style.filter = '');
          delBtn.addEventListener('click', async () => {
            const et   = _editEntity?.title || _editEntity?.name || 'Task';
            const snap = { ..._editEntity };
            if (_editEntity?.type === 'project') {
              const { _deleteProjectWithTaskFlow } = await import('./entity-panel.js');
              await _deleteProjectWithTaskFlow(_editEntity.id, et, snap, 'Project', () => closeForm());
              return;
            }
            if (!window.confirm(`Delete "${et}"? Press Cmd+Z immediately after to undo.`)) return;
            try {
              _selfDeleting = true;
              await deleteEntity(_editEntity.id);
              _selfDeleting = false;
              window.FH?._pushUndoDelete?.({ snapshot: snap, entityLabel: 'Task', entityTitle: et });
              closeForm();
            } catch (err) {
              _selfDeleting = false;
              console.error('[entity-form] Delete failed:', err);
              toast.error('Delete failed');
            }
          });
          actionBar.appendChild(delBtn);
        }
      }

      // ── Status toggle: In Progress <> Complete (tasks only) ──
      if (_editEntity?.type === 'task') {
        const isDone = _editEntity.status === 'Completed' || _editEntity.status === 'Done';
        const statusBtn = document.createElement('button');
        statusBtn.style.cssText = [
          'display: inline-flex; align-items: center; gap: 6px;',
          'padding: 5px 12px; border-radius: var(--radius-md); cursor: pointer;',
          'font-size: var(--text-sm); font-family: var(--font-body); transition: all 0.15s;',
          isDone
            ? 'background: var(--color-success-bg,#f0fdf4); color: var(--color-success-text,#15803d); border: 1px solid var(--color-success-text,#15803d);'
            : 'background: var(--color-surface-2); color: var(--color-text); border: 1px solid var(--color-border);',
        ].join(' ');
        statusBtn.innerHTML = isDone
          ? '<span>✓</span><span>Mark in progress</span>'
          : '<span style="opacity:0.5">○</span><span>Mark complete</span>';
        statusBtn.title = isDone ? 'Switch back to In Progress' : 'Mark as completed';
        statusBtn.addEventListener('click', async () => {
          try {
            const newStatus = isDone ? 'In Progress' : 'Completed';
            const updated = { ..._editEntity, status: newStatus };
            const saved = await saveEntity(updated, getAccount()?.id);
            _editEntity = saved;
            _draft.status = newStatus;
            const statusSelect = _overlay?.querySelector('#ef-field-status');
            if (statusSelect) statusSelect.value = newStatus;
            // [G02 fix] saveEntity already emits ENTITY_SAVED internally — don't emit again
            toast.success(newStatus === 'Completed' ? 'Marked complete ✓' : 'Marked in progress');
            _buildTab1ActionBar();
            // [v6.5.0] Prompt follow-up when completing (not when un-completing)
            if (newStatus === 'Completed') {
              try { await _promptFollowUp(saved); } catch {}
            }
          } catch (err) {
            console.error('[entity-form] status toggle failed:', err);
            toast.error('Could not update status');
          }
        });
        actionBar.appendChild(statusBtn);
      }

      // ── Complete / Set Active toggle (projects only) ────────────
      if (_editEntity?.type === 'project') {
        const isDoneProj = _editEntity.status === 'Completed' || _editEntity.status === 'Done';
        const toggleBtn  = document.createElement('button');

        const _styleToggle = (done) => {
          toggleBtn.style.cssText = [
            'display: inline-flex; align-items: center; gap: 6px;',
            'padding: 5px 12px; border-radius: var(--radius-md); cursor: pointer;',
            'font-size: var(--text-sm); font-family: var(--font-body); transition: all 0.15s;',
            done
              ? 'background: var(--color-surface-2); color: var(--color-text-muted); border: 1px solid var(--color-border);'
              : 'background: var(--color-success-bg,#f0fdf4); color: var(--color-success-text,#15803d); border: 1px solid var(--color-success-text,#15803d);',
          ].join(' ');
          toggleBtn.innerHTML = done
            ? '<span>↩</span><span>Set Active</span>'
            : '<span>✓</span><span>Complete Project</span>';
          toggleBtn.title = done
            ? 'Mark project active again'
            : 'Mark project complete and optionally create a new cycle';
        };

        _styleToggle(isDoneProj);

        toggleBtn.addEventListener('click', async () => {
          toggleBtn.disabled = true;
          const isNowDone = _editEntity.status === 'Completed' || _editEntity.status === 'Done';
          try {
            if (isNowDone) {
              // Toggle back to Active
              const updated = { ..._editEntity, status: 'Active' };
              const saved   = await saveEntity(updated, getAccount()?.id);
              _editEntity   = saved;
              _draft.status = 'Active';
              const statusSelect = _overlay?.querySelector('#ef-field-status');
              if (statusSelect) statusSelect.value = 'Active';
              toast.success('Project set to Active');
              _styleToggle(false);
              toggleBtn.disabled = false;
            } else {
              // Complete flow (may close form) — pass _buildTab1ActionBar as callback
              // so the top-level function can trigger a closure-internal re-render
              await _completeProjectFlow(_editEntity, _buildTab1ActionBar);
              // If form still open (user chose no-duplicate), re-style
              const stillDone = _editEntity.status === 'Completed' || _editEntity.status === 'Done';
              if (document.contains(toggleBtn)) {
                _styleToggle(stillDone);
                toggleBtn.disabled = false;
              }
            }
          } catch (err) {
            console.error('[entity-form] project toggle failed:', err);
            toast.error('Could not update project status');
            toggleBtn.disabled = false;
          }
        });

        actionBar.appendChild(toggleBtn);
      }

      // ── Convert to Template button (projects only) ────────────
      if (_editEntity?.type === 'project') {
        const tplBtn = document.createElement('button');
        tplBtn.style.cssText = [
          'display: inline-flex; align-items: center; gap: 6px;',
          'padding: 5px 12px; border-radius: var(--radius-md); cursor: pointer;',
          'font-size: var(--text-sm); font-family: var(--font-body); transition: all 0.15s;',
          'background: var(--color-surface); color: var(--color-text-muted);',
          'border: 1px solid var(--color-border);',
        ].join(' ');
        tplBtn.innerHTML = '<span>📋</span><span>Save as Template</span>';
        tplBtn.title = 'Convert this project into a reusable template';
        tplBtn.addEventListener('mouseenter', () => {
          tplBtn.style.borderColor = 'var(--color-accent)';
          tplBtn.style.color = 'var(--color-accent)';
        });
        tplBtn.addEventListener('mouseleave', () => {
          tplBtn.style.borderColor = 'var(--color-border)';
          tplBtn.style.color = 'var(--color-text-muted)';
        });
        tplBtn.addEventListener('click', async () => {
          tplBtn.disabled = true;
          tplBtn.innerHTML = '<span>⏳</span><span>Building…</span>';
          try {
            await _convertProjectToTemplate(_editEntity);
          } catch (err) {
            console.error('[entity-form] convert to template failed:', err);
            toast.error('Could not save template');
          }
          tplBtn.disabled = false;
          tplBtn.innerHTML = '<span>📋</span><span>Save as Template</span>';
        });
        actionBar.appendChild(tplBtn);
      }

      // ── Open Graph button ────────────────────────────────────
      if (_editEntity?.id) {
        const graphBtn = document.createElement('button');
        graphBtn.style.cssText = [
          'display: inline-flex; align-items: center; gap: 6px; margin-left: auto;',
          'padding: 5px 12px; border-radius: var(--radius-md); cursor: pointer;',
          'font-size: var(--text-sm); font-family: var(--font-body); transition: all 0.15s;',
          'background: none; color: var(--color-accent); border: 1px solid var(--color-accent);',
        ].join(' ');
        graphBtn.innerHTML = '<span>🔮</span><span>Graph</span>';
        graphBtn.title = 'Open in Knowledge Graph';
        graphBtn.addEventListener('click', async () => {
          const eid = _editEntity?.id;
          if (!eid) return;
          closeForm();
          try {
            const { openPanel } = await import('./entity-panel.js');
            openPanel._skipFormFirst = true;
            await openPanel(eid);
            openPanel._skipFormFirst = false;
            let _retries = 0;
            const _clickGraph = () => {
              const panelGraphBtn = document.querySelector('[aria-label="Open Graph"]');
              if (panelGraphBtn) {
                panelGraphBtn.click();
              } else if (_retries++ < 10) {
                setTimeout(_clickGraph, 80);
              }
            };
            setTimeout(_clickGraph, 80);
          } catch (err) {
            openPanel && (openPanel._skipFormFirst = false);
            console.warn('[entity-form] graph open failed:', err);
          }
        });
        actionBar.appendChild(graphBtn);
      }

      if (actionBar.children.length > 0) {
        tab1Body.insertBefore(actionBar, tab1Body.firstChild);
      }
      _tab1BarBuilding = false;
    };

    _buildTab1ActionBar();
  }

  body.appendChild(tab1Body);

  // ── Tabs 2–4: always create so switching works in both create and edit mode ──
  _tab2Body = document.createElement('div');
  _tab2Body.style.cssText = 'display: none; flex-direction: column; flex: 1; min-height: 0; padding: 0;';
  body.appendChild(_tab2Body);

  _tab3Body = document.createElement('div');
  _tab3Body.style.cssText = 'display: none; flex-direction: column; flex: 1; min-height: 0; padding: 0;';
  body.appendChild(_tab3Body);

  _tab4Body = document.createElement('div');
  _tab4Body.style.cssText = 'display: none; flex-direction: column; flex: 1; min-height: 0; padding: 0;';
  body.appendChild(_tab4Body);

  // [v5.9.4] Tasks tab body — only created for project edit mode
  if (_showTasksTab) {
    _tab5Body = document.createElement('div');
    _tab5Body.style.cssText = 'display: none; flex-direction: column; flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-4);';
    body.appendChild(_tab5Body);
  }

  // Apply initial tab visibility
  tab1Body.style.display = _activeFormTab === 'fields'    ? 'flex' : 'none';
  _tab2Body.style.display = _activeFormTab === 'details'   ? 'flex' : 'none';
  _tab3Body.style.display = _activeFormTab === 'relations' ? 'flex' : 'none';
  _tab4Body.style.display = _activeFormTab === 'reminders' ? 'flex' : 'none';

  // ── Footer ───────────────────────────────────────────── //
  // Single Save button — Cancel is redundant (✕ header, Esc, backdrop click all close).
  // ⌘↩ hint lives as tooltip on the save button, not as visible footer text.
  const footer = document.createElement('div');
  footer.className = 'modal-footer';
  footer.style.cssText = 'padding: var(--space-3) var(--space-4); border-top: 1px solid var(--color-border); flex-shrink: 0;';

  const saveBtn = document.createElement('button');
  saveBtn.className   = 'btn btn-primary ef-save-btn';
  saveBtn.textContent = _editEntity ? 'Save changes' : `Create ${config.label}`;
  saveBtn.title       = '⌘↩ to save';
  saveBtn.style.cssText = 'width: 100%; justify-content: center;';
  saveBtn.addEventListener('click', _submitForm);

  footer.appendChild(saveBtn);

  modal.appendChild(header);
  if (tabStrip) modal.appendChild(tabStrip);
  modal.appendChild(body);
  modal.appendChild(footer);
  _overlay.appendChild(modal);
  document.body.appendChild(_overlay);

  // Inject richtext placeholder CSS once globally (data-placeholder attr drives content)
  if (!document.getElementById('ef-richtext-placeholder-style')) {
    const s = document.createElement('style');
    s.id = 'ef-richtext-placeholder-style';
    s.textContent = `
      .ef-richtext-editor:empty:before {
        content: attr(data-placeholder);
        color: var(--color-text-muted);
        pointer-events: none;
        display: block;
      }
      .ef-rating-row{display:flex;gap:4px;padding:2px 0;}
      .ef-star-btn{font-size:1.4rem;background:none;border:none;cursor:pointer;
        color:var(--color-accent);padding:0;line-height:1;}
      .ef-star-btn:hover{transform:scale(1.15);}
      .ef-relation-create-btn{display:none;width:100%;margin-top:4px;padding:6px 10px;
        border:1px dashed var(--color-accent);border-radius:var(--radius-sm);
        background:var(--color-accent-muted);color:var(--color-accent);
        font-size:var(--text-xs);cursor:pointer;text-align:left;}
      .ef-relation-create-btn:hover{background:var(--color-accent);color:#fff;}
    `;
    document.head.appendChild(s);
  }

  // Focus the title field
  setTimeout(() => {
    const titleInput = modal.querySelector('.ef-title-field');
    titleInput?.focus();
  }, 60);

  // ── Form-lifetime event subscriptions ────────────────────────
  // These keep the form in sync when the same entity is changed elsewhere
  // (panel action, kanban drag, timer, another tab, etc.)
  // All subscriptions are cleaned up in closeForm().

  // Clear any subscriptions left from a previous form (shouldn't happen, but defensive)
  _formEventUnsubs.forEach(fn => { try { fn(); } catch {} });
  _formEventUnsubs = [];

  if (_editEntity) {
    const entityId = _editEntity.id;

    // 1. ENTITY_SAVED — refresh non-field tabs when entity changes externally
    _formEventUnsubs.push(on(EVENTS.ENTITY_SAVED, ({ entity } = {}) => {
      if (_formIsSaving) return;               // ignore our own saves
      if (!_editEntity || entity?.id !== entityId) return; // different entity
      _editEntity = entity;                    // keep _editEntity fresh
      // Merge non-destructively: only update draft fields the user hasn't dirtied
      // (Leave _draft as-is so in-progress typing is never lost)
      _refreshFormTabs(config, false); // false = skip Details tab (preserve typing)
    }));

    // 2. ENTITY_DELETED — close form if editing entity was deleted
    // [v6.4.4] _selfDeleting flag suppresses the "form closed" toast when WE initiated the delete
    _formEventUnsubs.push(on(EVENTS.ENTITY_DELETED, ({ id } = {}) => {
      if (id !== entityId) return;
      if (!_selfDeleting) toast.success('This entity was deleted — form closed');
      closeForm();
    }));

    // 3. EDGE_SAVED / EDGE_DELETED — refresh Connections tab when relations change
    const _onEdgeChange = ({ edge } = {}) => {
      if (!edge) return;
      if (edge.fromId !== entityId && edge.toId !== entityId) return;
      _refreshFormTabs(config, false);
    };
    _formEventUnsubs.push(on(EVENTS.EDGE_SAVED,   _onEdgeChange));
    _formEventUnsubs.push(on(EVENTS.EDGE_DELETED,  _onEdgeChange));
  }
}

/** Update header title text when type changes */
function _updateHeader(header, config, typeSelect) {
  const title = header.querySelector('.ef-modal-title');
  if (title) title.textContent = `New ${config.label}`;
}

/** Rebuild the form body for a given config */
function _rebuildBody(config, body) {
  body.innerHTML = '';
  _rebuildBodyInto(config, body);
}

/** Fill a container element with field groups for config. */
function _rebuildBodyInto(config, container) {
  container.innerHTML = '';
  const fields = config.fields.filter(f => !f.hidden);

  // Date+time pairs: these share a label row and sit side-by-side
  const DATE_TIME_PAIRS = {
    dueDate:       'dueTime',
    executionDate: 'executionTime',
  };
  const timeFields = new Set(Object.values(DATE_TIME_PAIRS));
  const consumed   = new Set();

  for (const field of fields) {
    if (consumed.has(field.key)) continue;

    const pairedTimeKey = DATE_TIME_PAIRS[field.key];
    const pairedTime    = pairedTimeKey && fields.find(f => f.key === pairedTimeKey);

    if (pairedTime) {
      // Build a combined date+time row
      consumed.add(field.key);
      consumed.add(pairedTimeKey);

      const wrapper = document.createElement('div');
      wrapper.className = 'form-group ef-datetime-pair';
      wrapper.dataset.field = field.key; // primary key
      // Also set data-field for the time key so validation can find it
      wrapper.dataset.fieldPaired = pairedTimeKey;
      wrapper.style.marginBottom = 'var(--space-4)';

      // ── Label row: for executionDate, prepend the copy-from-dueDate sync button ──
      const lblRow = document.createElement('div');
      lblRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:var(--space-1);';

      // Combined label: "Due Date & Time" / "Planned For & Time"
      const lbl = document.createElement('label');
      lbl.htmlFor = `ef-field-${field.key}`;
      lbl.style.cssText = 'font-size:var(--text-sm);font-weight:var(--weight-semibold);color:var(--color-text);';
      lbl.textContent = field.label + ' & Time';

      if (field.key === 'dueDate') {
        // [v6.5.0] Sync button — copies current Planned For → Due Date, shown BEFORE the label
        const syncBtn = document.createElement('button');
        syncBtn.type = 'button';
        syncBtn.title = 'Copy Planned For & Time to Due Date';
        syncBtn.style.cssText = [
          'width:22px;height:22px;border-radius:50%;border:1px solid var(--color-border);',
          'background:var(--color-surface);cursor:pointer;display:flex;align-items:center;',
          'justify-content:center;font-size:12px;flex-shrink:0;transition:all 0.15s;',
          'color:var(--color-accent);padding:0;',
        ].join('');
        syncBtn.innerHTML = '⇒'; // ⇒ = copy Planned→Due (forward direction)
        syncBtn.addEventListener('mouseenter', () => { syncBtn.style.background = 'var(--color-accent)'; syncBtn.style.color = '#fff'; });
        syncBtn.addEventListener('mouseleave', () => { syncBtn.style.background = 'var(--color-surface)'; syncBtn.style.color = 'var(--color-accent)'; });
        syncBtn.addEventListener('click', () => {
          const execDateInput = _overlay?.querySelector('#ef-field-executionDate');
          const execDateVal = execDateInput?.value || _draft.executionDate;
          if (execDateVal) {
            const dateStr = String(execDateVal).slice(0, 10);
            const dueDateInput = _overlay?.querySelector('#ef-field-dueDate');
            if (dueDateInput) { dueDateInput.value = dateStr; }
            _draft.dueDate = dateStr;
            const execTimeEl = _overlay?.querySelector('#ef-field-executionTime');
            const execTimeVal = execTimeEl?.value || _draft.executionTime;
            const dueTimeEl = _overlay?.querySelector('#ef-field-dueTime');
            if (dueTimeEl && execTimeVal) {
              dueTimeEl.value = execTimeVal;
              _draft.dueTime = execTimeVal;
            }
          } else {
            const orig = syncBtn.innerHTML;
            syncBtn.textContent = '⚠';
            syncBtn.title = 'No Planned For date set yet';
            setTimeout(() => { syncBtn.innerHTML = orig; syncBtn.title = 'Copy Planned For & Time to Due Date'; }, 1200);
          }
        });
        lblRow.appendChild(syncBtn);
      }

      if (field.key === 'executionDate') {
        // Sync button — copies current dueDate → executionDate, shown BEFORE the label
        const syncBtn = document.createElement('button');
        syncBtn.type = 'button';
        syncBtn.title = 'Copy current Due Date value to Planned For';
        syncBtn.style.cssText = [
          'width:22px;height:22px;border-radius:50%;border:1px solid var(--color-border);',
          'background:var(--color-surface);cursor:pointer;display:flex;align-items:center;',
          'justify-content:center;font-size:12px;flex-shrink:0;transition:all 0.15s;',
          'color:var(--color-accent);padding:0;',
        ].join('');
        syncBtn.innerHTML = '⇐';
        syncBtn.addEventListener('mouseenter', () => { syncBtn.style.background = 'var(--color-accent)'; syncBtn.style.color = '#fff'; });
        syncBtn.addEventListener('mouseleave', () => { syncBtn.style.background = 'var(--color-surface)'; syncBtn.style.color = 'var(--color-accent)'; });
        syncBtn.addEventListener('click', () => {
          const dueDateInput = _overlay?.querySelector('#ef-field-dueDate');
          const dueDateVal = dueDateInput?.value || _draft.dueDate;
          if (dueDateVal) {
            const dateStr = String(dueDateVal).slice(0, 10);
            const execDateInput = _overlay?.querySelector('#ef-field-executionDate');
            if (execDateInput) { execDateInput.value = dateStr; }
            _draft.executionDate = dateStr;
            const dueTimeInput = _overlay?.querySelector('#ef-field-dueTime');
            const dueTimeVal = dueTimeInput?.value || _draft.dueTime;
            const execTimeEl = _overlay?.querySelector('#ef-field-executionTime');
            if (execTimeEl && dueTimeVal) {
              execTimeEl.value = dueTimeVal;
              _draft.executionTime = dueTimeVal;
            }
          } else {
            const orig = syncBtn.innerHTML;
            syncBtn.textContent = '⚠';
            syncBtn.title = 'No Due Date set yet';
            setTimeout(() => { syncBtn.innerHTML = orig; syncBtn.title = 'Copy current Due Date value to Planned For'; }, 1200);
          }
        });
        lblRow.appendChild(syncBtn);
      }

      lblRow.appendChild(lbl);

      // Row: [date input] [time input] — side by side, matching Due Date row layout
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:var(--space-2);align-items:flex-start;flex-wrap:wrap;';

      // Date part — for executionDate, build a plain date input (syncBtn moved to label row)
      let dateCtrl;
      if (field.key === 'executionDate') {
        const input = document.createElement('input');
        input.type      = 'date';
        input.id        = `ef-field-${field.key}`;
        input.className = 'input';
        const isNewTask   = !_editEntity;
        const existingVal = _draft[field.key];
        const resolvedExec = existingVal
          ? String(existingVal).slice(0, 10)
          : (isNewTask ? (_draft.dueDate?.slice(0, 10) || '') : '');
        input.value = resolvedExec;
        if (resolvedExec) _draft.executionDate = resolvedExec;
        if (field.required) input.required = true;
        input.addEventListener('change', () => { _draft[field.key] = input.value || null; });
        dateCtrl = input;
      } else {
        dateCtrl = _buildFieldControl(field, config);
      }
      if (dateCtrl) {
        dateCtrl.style.flex = '1 1 150px';
        row.appendChild(dateCtrl);
      }

      // Time part — build control then suppress verbose hint text
      const timeCtrl = _buildFieldControl(pairedTime, config);
      if (timeCtrl) {
        timeCtrl.style.cssText = 'flex:0 0 140px;';
        const hintSpan = timeCtrl.querySelector?.('span');
        if (hintSpan) hintSpan.textContent = '';
        const timeInput = timeCtrl.querySelector?.('input[type="time"]');
        if (timeInput) timeInput.style.width = '100%';
        row.appendChild(timeCtrl);
      }

      // Error span — covers both date and time validation
      const errEl = document.createElement('div');
      errEl.className = 'ef-field-error';
      errEl.dataset.forField = field.key;
      errEl.style.cssText = 'font-size:var(--text-xs);color:var(--color-danger);display:none;margin-top:2px;';

      wrapper.appendChild(lblRow);
      wrapper.appendChild(row);
      wrapper.appendChild(errEl);
      container.appendChild(wrapper);
    } else if (!timeFields.has(field.key)) {
      // Normal field (not a time field that's already been paired)
      const group = _buildFieldGroup(field, config);
      if (group) container.appendChild(group);
    }
    // If it IS a time field but no date pair found (e.g. orphan), render normally
    else {
      const group = _buildFieldGroup(field, config);
      if (group) container.appendChild(group);
    }
  }
}

// ════════════════════════════════════════════════════════════
// RECURRENCE PANEL [v5.3.1]
// ════════════════════════════════════════════════════════════

/**
 * Show or hide the recurrence settings panel below the isRecurring checkbox.
 * Called on checkbox change and immediately on edit-mode open when already recurring.
 * @param {boolean} enabled
 * @param {HTMLElement} anchor  — the data-field="isRecurring" group element
 */
function _toggleRecurrencePanel(enabled, anchor) {
  const panelId = 'ef-recurrence-panel';
  _overlay?.querySelector('#' + panelId)?.remove();
  if (!enabled) {
    // [B9 fix] Clear ALL recurrence draft fields to prevent stale values persisting on entity
    _draft.rrule             = null;
    _draft.recurrenceEnd     = 'never';
    _draft.recurrenceCount   = null;
    _draft.recurrenceEndDate = null;
    _draft.nextOccurrenceDate = null;
    return;
  }
  if (!anchor) return; // [F06 fix] silently bail if anchor missing (form not yet in DOM)

  const panel = document.createElement('div');
  panel.id = panelId;
  panel.style.cssText = [
    'margin:var(--space-3) 0',
    'padding:var(--space-4)',
    'border-radius:var(--radius-md)',
    'background:var(--color-surface)',
    'border:1px solid var(--color-accent)',   // accent border to indicate active state
    'border-left:4px solid var(--color-accent)',
    'display:flex',
    'flex-direction:column',
    'gap:var(--space-3)',
  ].join(';');

  const PRESETS = [
    ['one-time',              'Does not repeat'],
    ['daily',                 'Daily'],
    ['weekdays',              'Weekdays (Mon–Fri)'],
    ['weekends',              'Weekends'],
    ['weekly',                'Weekly'],
    ['biweekly',              'Every 2 weeks'],
    ['monthly',               'Monthly'],
    ['monthly-first-monday',  '1st Monday of month'],
    ['yearly',                'Annually'],
    ['hourly',                'Every hour'],
  ];

  // [F02 fix] Section header label
  const header = document.createElement('div');
  header.style.cssText = 'font-size:var(--text-xs);font-weight:var(--weight-semibold);color:var(--color-accent);text-transform:uppercase;letter-spacing:.06em;';
  header.textContent = '🔁 Recurrence Schedule';
  panel.appendChild(header);

  // [F01 fix] Preset selector — must use 'select' class (provides dropdown arrow SVG)
  const selWrap = document.createElement('div');
  selWrap.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
  const selLbl = document.createElement('label');
  selLbl.style.cssText = 'font-size:var(--text-xs);color:var(--color-text-muted);font-weight:500;';
  selLbl.textContent = 'Repeats';
  selLbl.setAttribute('for', 'ef-rrule-sel');
  const sel = document.createElement('select');
  sel.className = 'select'; // [F01 fix] was 'input' — select class provides the dropdown arrow
  sel.id = 'ef-rrule-sel';
  const curRule = _draft.rrule || '';
  let matched = 'weekly';
  for (const [pk] of PRESETS) {
    if (presetToRrule(pk) === curRule) { matched = pk; break; }
  }
  PRESETS.forEach(([pk, pl]) => {
    const o = document.createElement('option');
    o.value = pk; o.textContent = pl; o.selected = pk === matched;
    sel.appendChild(o);
  });
  selWrap.appendChild(selLbl);
  selWrap.appendChild(sel);
  panel.appendChild(selWrap);

  // Human-readable preview + next dates
  const prev = document.createElement('div');
  prev.style.cssText = 'font-size:var(--text-xs);color:var(--color-text-muted);';

  function _updatePreview() {
    const rule = presetToRrule(sel.value);
    _draft.rrule = rule;
    if (!rule) { prev.textContent = 'One-time — will not repeat.'; return; }
    const anchorDate = _draft.executionDate || _draft.dueDate || _todayStr();
    const dates  = nextNDates(rule, anchorDate + 'T00:00:00', 5).map(d =>
      new Date(d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    );
    prev.textContent = rruleToHuman(rule) + (dates.length ? ' · Next: ' + dates.join(', ') : '');
  }
  sel.addEventListener('change', _updatePreview);
  _updatePreview();
  panel.appendChild(prev);

  // [F05 fix] End-condition section label
  const endsLbl = document.createElement('div');
  endsLbl.style.cssText = 'font-size:var(--text-xs);color:var(--color-text-muted);font-weight:500;margin-top:var(--space-1);';
  endsLbl.textContent = 'Ends';
  panel.appendChild(endsLbl);

  // [F03 fix] End-condition radios with inline inputs — each radio+input is a paired row
  const endsWrap = document.createElement('div');
  endsWrap.style.cssText = 'display:flex;flex-direction:column;gap:var(--space-2);';

  const rbName = 'ef-recend-' + Date.now();
  const curEnd = _draft.recurrenceEnd || 'never';

  // "Never" option
  const lbNever = document.createElement('label');
  lbNever.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:var(--text-sm);cursor:pointer;';
  const rbNever = document.createElement('input');
  rbNever.type = 'radio'; rbNever.name = rbName; rbNever.value = 'never';
  rbNever.checked = curEnd === 'never';
  lbNever.append(rbNever, document.createTextNode('Never'));
  endsWrap.appendChild(lbNever);

  // "After N times" option — with inline count input
  const lbCount = document.createElement('label');
  lbCount.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:var(--text-sm);cursor:pointer;flex-wrap:wrap;';
  const rbCount = document.createElement('input');
  rbCount.type = 'radio'; rbCount.name = rbName; rbCount.value = 'count';
  rbCount.checked = curEnd === 'count';
  const countIn = document.createElement('input');
  countIn.type = 'number'; countIn.min = '1'; countIn.placeholder = 'N';
  countIn.className = 'input';
  countIn.style.cssText = 'width:64px;padding:3px 8px;font-size:var(--text-sm);display:' + (curEnd === 'count' ? 'inline-block' : 'none') + ';';
  countIn.value = _draft.recurrenceCount || '';
  countIn.addEventListener('input', () => { _draft.recurrenceCount = parseInt(countIn.value, 10) || null; });
  const countSuffix = document.createElement('span');
  countSuffix.textContent = 'times';
  countSuffix.style.cssText = 'display:' + (curEnd === 'count' ? 'inline' : 'none') + ';color:var(--color-text-muted);font-size:var(--text-xs);';
  lbCount.append(rbCount, document.createTextNode('After'), countIn, countSuffix);
  endsWrap.appendChild(lbCount);

  // "On date" option — with inline date input
  const lbDate = document.createElement('label');
  lbDate.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:var(--text-sm);cursor:pointer;flex-wrap:wrap;';
  const rbDate = document.createElement('input');
  rbDate.type = 'radio'; rbDate.name = rbName; rbDate.value = 'date';
  rbDate.checked = curEnd === 'date';
  const dateIn = document.createElement('input');
  dateIn.type = 'date';
  dateIn.className = 'input';
  dateIn.style.cssText = 'width:150px;padding:3px 8px;font-size:var(--text-sm);display:' + (curEnd === 'date' ? 'inline-block' : 'none') + ';';
  dateIn.value = _draft.recurrenceEndDate || '';
  // [F04 fix] listen on both 'change' and 'input' for cross-browser / mobile compatibility
  const _syncDate = () => { _draft.recurrenceEndDate = dateIn.value || null; };
  dateIn.addEventListener('change', _syncDate);
  dateIn.addEventListener('input',  _syncDate);
  lbDate.append(rbDate, document.createTextNode('On'), dateIn);
  endsWrap.appendChild(lbDate);

  // Wire radio → show/hide inline inputs
  function _syncEndVisibility(val) {
    countIn.style.display    = val === 'count' ? 'inline-block' : 'none';
    countSuffix.style.display = val === 'count' ? 'inline'      : 'none';
    dateIn.style.display     = val === 'date'  ? 'inline-block' : 'none';
    _draft.recurrenceEnd = val;
  }
  [rbNever, rbCount, rbDate].forEach(rb => {
    rb.addEventListener('change', () => _syncEndVisibility(rb.value));
  });

  panel.appendChild(endsWrap);
  anchor.insertAdjacentElement('afterend', panel); // anchor guaranteed non-null (checked above)
}

// ════════════════════════════════════════════════════════════
// FIELD RENDERING
// ════════════════════════════════════════════════════════════

function _buildFieldGroup(field, config) {
  const group = document.createElement('div');
  group.className     = 'form-group';
  group.dataset.field = field.key;
  group.style.marginBottom = 'var(--space-4)';

  // ── endDate: initially hidden with toggle ──
  const isEndDate = field.key === 'endDate';
  const hasExisting = isEndDate && _draft[field.key];

  if (isEndDate && !hasExisting) {
    // Show as a toggle link instead of the full field
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'btn btn-ghost btn-xs';
    toggle.style.cssText = 'color: var(--color-text-accent); padding: var(--space-1) 0;';
    toggle.textContent = '+ Add end date/time';
    toggle.addEventListener('click', () => {
      toggle.style.display = 'none';
      group.style.display = '';
    });
    // Insert toggle before group, hide the group
    const wrapper = document.createElement('div');
    wrapper.dataset.field = field.key;
    wrapper.appendChild(toggle);

    // Still build the group but hide it
    group.style.display = 'none';

    // Label
    const label = document.createElement('label');
    label.className   = 'form-label';
    label.htmlFor     = `ef-field-${field.key}`;
    label.textContent = field.label;
    group.appendChild(label);

    const control = _buildFieldControl(field, config);
    if (control) group.appendChild(control);

    const err = document.createElement('span');
    err.className       = 'form-error ef-field-error';
    err.style.display   = 'none';
    err.setAttribute('role', 'alert');
    group.appendChild(err);

    wrapper.appendChild(group);
    return wrapper;
  }

  // Label — skip for isTitle (title gets special styling)
  if (!field.isTitle) {
    const label = document.createElement('label');
    label.className   = `form-label${field.required ? ' required' : ''}`;
    label.htmlFor     = `ef-field-${field.key}`;
    label.textContent = field.label;
    group.appendChild(label);
  }

  const control = _buildFieldControl(field, config);
  if (control) group.appendChild(control);

  // Error container
  const err = document.createElement('span');
  err.className       = 'form-error ef-field-error';
  err.style.display   = 'none';
  err.setAttribute('role', 'alert');
  group.appendChild(err);

  return group;
}

function _buildFieldControl(field, config) {
  // GUARD: For fields named 'type', read from '_subtype' to avoid collision
  // with the structural entity.type property (which holds the entity kind key).
  const existing = field.key === 'type' ? (_draft._subtype ?? _draft[field.key]) : _draft[field.key];

  switch (field.type) {

    // ── TITLE (text, special styling) ────────────────────── //
    case 'title': {
      const input = document.createElement('input');
      input.type        = 'text';
      input.id          = `ef-field-${field.key}`;
      input.className   = 'input ef-title-field';
      input.placeholder = field.label;
      input.value       = existing || '';
      input.required    = true;
      input.autocomplete = 'off';
      input.style.cssText = 'font-size: var(--text-lg); font-weight: var(--weight-semibold); padding: var(--space-3);';
      input.addEventListener('input', () => { _draft[field.key] = input.value; });
      return input;
    }

    // ── TEXT / EMAIL / PHONE / URL ────────────────────────── //
    case 'text':
    case 'email':
    case 'phone':
    case 'url': {
      const typeMap = { text: 'text', email: 'email', phone: 'tel', url: 'url' };
      const input = document.createElement('input');
      input.type        = typeMap[field.type] || 'text';
      input.id          = `ef-field-${field.key}`;
      input.className   = 'input';
      input.placeholder = `Enter ${field.label.toLowerCase()}…`;
      input.value       = existing || '';
      if (field.required) input.required = true;
      input.addEventListener('input', () => { _draft[field.key] = input.value.trim() || null; });
      return input;
    }

    // ── NUMBER ───────────────────────────────────────────── //
    case 'number': {
      const input = document.createElement('input');
      input.type        = 'number';
      input.id          = `ef-field-${field.key}`;
      input.className   = 'input';
      input.placeholder = field.min != null ? String(field.min) : '0';
      input.value       = existing != null ? String(existing) : '';
      if (field.required) input.required = true;
      // Apply constraints from type config (set in Object Studio P2)
      if (field.min  != null) input.min  = String(field.min);
      if (field.max  != null) input.max  = String(field.max);
      if (field.step != null) input.step = String(field.step);
      input.addEventListener('input', () => {
        _draft[field.key] = input.value !== '' ? Number(input.value) : null;
      });
      return input;
    }

    // ── DATE ─────────────────────────────────────────────── //
    case 'date': {
      // ── executionDate: plain date input (sync button rendered in label row by _rebuildBodyInto) ── //
      if (field.key === 'executionDate') {
        const input = document.createElement('input');
        input.type      = 'date';
        input.id        = `ef-field-${field.key}`;
        input.className = 'input';
        const isNewTask = !_editEntity;
        const resolvedExec = existing
          ? existing.slice(0, 10)
          : (isNewTask ? (_draft.dueDate?.slice(0, 10) || '') : '');
        input.value = resolvedExec;
        if (resolvedExec) _draft.executionDate = resolvedExec;
        if (field.required) input.required = true;
        input.addEventListener('change', () => {
          _draft[field.key] = input.value || null;
        });
        return input;
      }

      // Standard date field
      const input = document.createElement('input');
      input.type      = 'date';
      input.id        = `ef-field-${field.key}`;
      input.className = 'input';
      input.value     = existing ? existing.slice(0, 10) : '';
      if (field.required) input.required = true;
      input.addEventListener('change', () => {
        _draft[field.key] = input.value || null;
      });
      return input;
    }

    // ── TIME ─────────────────────────────────────────────── //
    case 'time': {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';

      const input = document.createElement('input');
      input.type      = 'time';
      input.id        = `ef-field-${field.key}`;
      input.className = 'input';
      input.step      = '600'; // 10-minute increments
      input.value     = existing || '06:00';
      if (field.placeholder) input.placeholder = field.placeholder;

      // Only save time when paired date is also set
      input.addEventListener('change', () => {
        const dateKey = field.key === 'dueTime' ? 'dueDate'
                      : field.key === 'executionTime' ? 'executionDate' : null;
        if (dateKey) {
          // Check live DOM input first (draft may be stale before submit)
          const pairedInput = _overlay?.querySelector(`#ef-field-${dateKey}`);
          const pairedVal = pairedInput?.value || _draft[dateKey];
          if (!pairedVal) {
            const hintLabel = dateKey === 'dueDate' ? 'a Due Date' : 'an Execution Date';
            hintEl.textContent = `⚠ Set ${hintLabel} first`;
            hintEl.style.color = 'var(--color-warning-text,#b45309)';
            input.value = existing || '';
            return;
          }
        }
        _draft[field.key] = input.value || '06:00';
        hintEl.textContent = field.helpText || '10-min steps';
        hintEl.style.color = 'var(--color-text-muted)';
      });
      // init draft: only set time if paired date exists
      const pairedDateKey = field.key === 'dueTime' ? 'dueDate'
                          : field.key === 'executionTime' ? 'executionDate' : null;
      if (!existing && pairedDateKey && _draft[pairedDateKey]) {
        _draft[field.key] = '06:00';
      } else if (!existing) {
        _draft[field.key] = null;
        input.value = '';
      }

      const hintEl = document.createElement('span');
      hintEl.style.cssText = 'font-size:var(--text-xs);color:var(--color-text-muted);white-space:nowrap;';
      hintEl.textContent = field.helpText || '10-min steps';

      wrap.append(input, hintEl);
      return wrap;
    }

    // ── DATETIME ─────────────────────────────────────────── //
    case 'datetime': {
      const input = document.createElement('input');
      input.type      = 'datetime-local';
      input.id        = `ef-field-${field.key}`;
      input.className = 'input';
      input.value     = existing ? existing.slice(0, 16) : '';
      if (field.required) input.required = true;
      input.addEventListener('change', () => {
        // Parse datetime-local value as local time to avoid UTC shift in negative TZ
        if (input.value) {
          const [dp, tp = '00:00'] = input.value.split('T');
          const [y, mo, d] = dp.split('-').map(Number);
          const [h, mi]    = tp.split(':').map(Number);
          _draft[field.key] = new Date(y, mo - 1, d, h, mi).toISOString();
        } else {
          _draft[field.key] = null;
        }
      });
      return input;
    }

    // ── SELECT ───────────────────────────────────────────── //
    case 'select': {
      const select = document.createElement('select');
      select.id        = `ef-field-${field.key}`;
      select.className = 'select';
      if (field.required) select.required = true;

      const empty = document.createElement('option');
      empty.value       = '';
      empty.textContent = `— Select ${field.label} —`;
      select.appendChild(empty);

      // CS-05: Emoji labels for context field — order follows contextOrder setting
      const CTX_EMOJI = { family: '🏠 Family', personal: '👤 Personal', business: '💼 Business', all: '🌐 All' };

      let _fieldOpts = field.options || [];
      if (field.key === 'context') {
        // Reorder options to match saved context order (async, best-effort)
        getSetting('contextOrder').then(saved => {
          if (!Array.isArray(saved) || saved.length !== 4) return;
          // Sort the existing <option> elements inside select by saved order
          const optMap = {};
          for (const o of [...select.querySelectorAll('option')]) {
            if (o.value) optMap[o.value] = o;
          }
          // Remove non-empty options only (preserve the blank "— Select —" placeholder)
          for (const o of [...select.querySelectorAll('option')]) {
            if (o.value) o.remove();
          }
          for (const ctx of saved) {
            if (optMap[ctx]) select.appendChild(optMap[ctx]);
          }
        }).catch(() => {});
      }

      for (const opt of _fieldOpts) {
        const o = document.createElement('option');
        o.value       = opt;
        o.textContent = (field.key === 'context' && CTX_EMOJI[opt]) ? CTX_EMOJI[opt] : opt;
        if (opt === existing) o.selected = true;
        select.appendChild(o);
      }

      // [v5.1.0] STATUS-FIX: if entity has a legacy status value not in field.options
      // (e.g. 'Done', 'Review', 'Inbox', 'Archived'), add it as a disabled option so the
      // select doesn't silently blank. Normalise on first Save via _draft propagation.
      if (field.key === 'status' && existing && field.options?.length) {
        const knownOpts = new Set(field.options);
        if (!knownOpts.has(existing)) {
          const o = document.createElement('option');
          o.value    = existing;
          o.textContent = existing + ' (legacy)';
          o.selected = true;
          select.appendChild(o);
        }
      }

      // If no pre-selection yet, default to first option for non-required fields
      if (!existing && !field.required && field.options?.length) {
        // Leave blank
      }

      select.addEventListener('change', () => {
        const val = select.value || null;
        if (field.key === 'type') {
          _draft._subtype = val;   // safe alias
        }
        _draft[field.key] = val;
      });
      return select;
    }

    // ── CHECKBOX ─────────────────────────────────────────── //
    case 'checkbox': {
      const wrap = document.createElement('label');
      wrap.style.cssText = 'display: flex; align-items: center; gap: var(--space-2); cursor: pointer; font-size: var(--text-sm);';

      const cb = document.createElement('input');
      cb.type    = 'checkbox';
      cb.id      = `ef-field-${field.key}`;
      cb.checked = !!existing;
      cb.style.cssText = 'width: 18px; height: 18px; accent-color: var(--color-accent); cursor: pointer; flex-shrink: 0;';
      cb.addEventListener('change', () => { _draft[field.key] = cb.checked; });

      // [v5.3.1] isRecurring: toggle the recurrence panel below this field
      if (field.key === 'isRecurring') {
        cb.addEventListener('change', () => {
          _draft.isRecurring = cb.checked;
          const group = cb.closest('[data-field]');
          _toggleRecurrencePanel(cb.checked, group);
        });
        // Edit mode: show panel immediately if already recurring
        if (cb.checked) {
          requestAnimationFrame(() => {
            if (!_overlay || !document.body.contains(_overlay)) return; // [B22 fix] form may have closed
            const group = cb.closest('[data-field]');
            if (group) _toggleRecurrencePanel(true, group);
          });
        }
      }

      const lbl = document.createElement('span');
      lbl.textContent = field.label;

      wrap.appendChild(cb);
      wrap.appendChild(lbl);
      return wrap;
    }

    // ── RICHTEXT (Quill.js) — N-01 ───────────────────────── //
    // N-01: Quill.js integration for rich text editing.
    // Falls back gracefully to contenteditable if Quill fails to load.
    case 'richtext': {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;flex-direction:column;gap:0;';

      const editorContainer = document.createElement('div');
      editorContainer.id = `ef-field-${field.key}`;
      editorContainer.className = 'ef-quill-container';
      editorContainer.style.cssText = `
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: var(--color-bg);
        transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
        overflow: hidden;
        min-height: 120px;
      `;

      wrap.appendChild(editorContainer);

      const initialContent = existing || '';
      _draft[field.key] = initialContent || null;

      const _installFallback = () => {
        editorContainer.innerHTML = '';
        const fallback = document.createElement('div');
        fallback.contentEditable = 'true';
        fallback.className = 'ef-richtext-editor ef-richtext-fallback';
        fallback.style.cssText = `min-height:100px;padding:var(--space-3);font-size:var(--text-sm);line-height:var(--leading-relaxed);outline:none;color:var(--color-text);`;
        fallback.setAttribute('data-placeholder', `${field.label}… (Ctrl+B bold, Ctrl+I italic)`);
        if (initialContent) fallback.innerHTML = initialContent;
        fallback.addEventListener('input', () => { if (_draft) _draft[field.key] = fallback.innerHTML.trim() || null; });
        fallback.addEventListener('blur',  () => { if (_draft) _draft[field.key] = fallback.innerHTML.trim() || null; });
        editorContainer.appendChild(fallback);
      };

      const _initQuill = () => {
        // Bail if container was removed from DOM (form closed before Quill loaded)
        if (!editorContainer.isConnected || !_draft) { return; }
        if (typeof window.Quill === 'undefined') { _installFallback(); return; }
        try {
          const quill = new window.Quill(editorContainer, {
            theme: 'snow',
            placeholder: `${field.label}…`,
            modules: {
              toolbar: [
                [{ header: [1, 2, 3, false] }],
                ['bold', 'italic', 'underline', 'strike'],
                [{ list: 'ordered' }, { list: 'bullet' }],
                ['blockquote', 'code-block'],
                ['link'],
                ['clean'],
              ],
            },
          });
          if (initialContent) quill.clipboard.dangerouslyPasteHTML(initialContent);

          quill.on('text-change', () => {
            if (!_draft) return;  // form already closed
            const html = editorContainer.querySelector('.ql-editor')?.innerHTML || '';
            _draft[field.key] = (html === '<p><br></p>' || !html) ? null : html;
          });
          quill.on('selection-change', (range) => {
            if (range) {
              editorContainer.style.borderColor = 'var(--color-accent)';
              editorContainer.style.boxShadow   = 'var(--shadow-focus)';
            } else {
              editorContainer.style.borderColor = 'var(--color-border)';
              editorContainer.style.boxShadow   = 'none';
              if (!_draft) return;  // form already closed
              const html = editorContainer.querySelector('.ql-editor')?.innerHTML || '';
              _draft[field.key] = (html === '<p><br></p>' || !html) ? null : html;
            }
          });
        } catch (err) {
          console.warn('[entity-form] Quill init failed, using fallback:', err);
          _installFallback();
        }
      };

      // Lazily load Quill from CDN if not already present, then init
      if (typeof window.Quill !== 'undefined') {
        setTimeout(_initQuill, 0);
      } else {
        if (!document.getElementById('quill-css')) {
          const link = document.createElement('link');
          link.id   = 'quill-css';
          link.rel  = 'stylesheet';
          link.href = 'https://cdnjs.cloudflare.com/ajax/libs/quill/1.3.7/quill.snow.min.css';
          document.head.appendChild(link);
        }
        if (!document.getElementById('quill-js')) {
          const script    = document.createElement('script');
          script.id       = 'quill-js';
          script.src      = 'https://cdnjs.cloudflare.com/ajax/libs/quill/1.3.7/quill.min.js';
          script.onload   = _initQuill;
          script.onerror  = _installFallback;
          document.head.appendChild(script);
        } else {
          // Script tag exists but Quill may still be loading — poll
          const poll = setInterval(() => {
            if (typeof window.Quill !== 'undefined') { clearInterval(poll); _initQuill(); }
          }, 50);
          setTimeout(() => { clearInterval(poll); if (typeof window.Quill === 'undefined') _installFallback(); }, 5000);
        }
      }

      return wrap;
    }

    // ── CHECKLIST ────────────────────────────────────────── //
    case 'checklist': {
      // Deep-copy existing items so draft mutations don’t affect the entity object
      let items = Array.isArray(existing) ? existing.map(it => ({ ...it })) : [];
      _draft[field.key] = items.length ? [...items] : null;

      const wrap = document.createElement('div');
      wrap.className = 'ef-checklist-wrap';
      wrap.style.cssText = 'display:flex;flex-direction:column;gap:var(--space-1-5);';

      function _genId() {
        return Math.random().toString(36).slice(2, 10);
      }

      function _syncDraft() {
        // Store a shallow-copy array so save reads correct state
        _draft[field.key] = items.length ? items.map(it => ({ ...it })) : null;
      }

      // Build the Add button once — re-append on each _renderItems, never recreate
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'ef-checklist-add btn btn-ghost btn-sm';
      addBtn.style.cssText = 'align-self:flex-start;margin-top:var(--space-1);font-size:var(--text-xs);';
      addBtn.textContent = '+ Add item';
      addBtn.addEventListener('click', () => {
        items.push({ id: _genId(), text: '', done: false });
        _syncDraft();
        _renderItems();
        const inputs = wrap.querySelectorAll('input[type="text"]');
        if (inputs.length) inputs[inputs.length - 1].focus();
      });

      function _renderItems() {
        wrap.innerHTML = '';
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;align-items:center;gap:var(--space-1-5);';

          const cb = document.createElement('input');
          cb.type    = 'checkbox';
          cb.checked = !!item.done;
          cb.style.cssText = 'width:15px;height:15px;flex-shrink:0;accent-color:var(--color-accent);cursor:pointer;';

          const txt = document.createElement('input');
          txt.type        = 'text';
          txt.value       = item.text || '';
          txt.className   = 'input';
          txt.placeholder = 'Item text…';
          txt.style.cssText = 'flex:1;padding:var(--space-1) var(--space-2);font-size:var(--text-sm);'
            + (item.done ? 'text-decoration:line-through;color:var(--color-text-muted);' : '');

          const del = document.createElement('button');
          del.type = 'button';
          del.textContent = '×';
          del.title = 'Remove item';
          del.style.cssText = 'background:none;border:none;cursor:pointer;color:var(--color-text-muted);font-size:var(--text-lg);line-height:1;padding:0 var(--space-1);flex-shrink:0;';

          // IIFE captures stable idx — prevents classic for-loop closure bug where all
          // event handlers would reference the final value of i after the loop ends.
          (function(idx) {
            cb.addEventListener('change', () => {
              items[idx].done = cb.checked;
              txt.style.textDecoration = cb.checked ? 'line-through' : 'none';
              txt.style.color = cb.checked ? 'var(--color-text-muted)' : 'var(--color-text)';
              _syncDraft();
            });
            txt.addEventListener('input', () => {
              items[idx].text = txt.value;
              _syncDraft();
            });
            del.addEventListener('click', () => {
              items.splice(idx, 1);
              _syncDraft();
              _renderItems();
            });
          })(i);

          row.append(cb, txt, del);
          wrap.appendChild(row);
        }
        wrap.appendChild(addBtn); // stable node re-appended each render
      }

      _renderItems();
      return wrap;
    }

    // ── TAGS (multiselect with chip + create) ─────────────── //
    case 'tags':
    case 'multiselect': {
      if (!_tagValues.has(field.key)) {
        _tagValues.set(field.key, Array.isArray(existing) ? [...existing] : []);
      }
      return _buildTagControl(field);
    }

    // ── RATING (1–5 stars) ────────────────────────────────── //
    case 'rating': {
      const wrap = document.createElement('div');
      wrap.className = 'ef-rating-row';
      wrap.dataset.fieldKey = field.key;
      // 'existing' = _draft[field.key], correct for both create and edit
      const current = parseInt(existing || 0, 10);
      wrap.dataset.currentVal = String(current); // init so save reads correctly
      for (let i = 1; i <= 5; i++) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = i <= current ? '★' : '☆';
        btn.dataset.val = String(i);
        btn.className = 'ef-star-btn';
        btn.addEventListener('click', () => {
          const v = parseInt(btn.dataset.val, 10);
          wrap.querySelectorAll('.ef-star-btn').forEach((b, idx) => {
            b.textContent = idx + 1 <= v ? '★' : '☆';
          });
          wrap.dataset.currentVal = String(v);
        });
        wrap.appendChild(btn);
      }
      return wrap;
    }

    // ── RELATION (search-as-you-type, works in create AND edit mode) ──── //
    case 'relation': {
      if (!_relationValues.has(field.key)) {
        _relationValues.set(field.key, []);
      }
      // In edit mode: load existing edges so chips populate immediately.
      if (_editEntity) {
        _loadExistingEdges(_editEntity.id, field).catch(err =>
          console.warn('[entity-form] edge pre-load failed:', err)
        );
      }
      return _buildRelationControl(field, config);
    }

    default:
      return null;
  }
}

// ════════════════════════════════════════════════════════════
// TAG CONTROL
// ════════════════════════════════════════════════════════════

/**
 * Tag control — mirrors _buildRelationControl but stores tag names (strings).
 * Searches existing tag entities by name; clicking a chip opens the tag panel.
 * "+ Create" appears when no match found — creates the tag entity and adds it.
 */
function _buildTagControl(field) {
  const wrap = document.createElement('div');
  wrap.className   = 'ef-tag-control';
  wrap.dataset.key = field.key;

  // ── Chip row (selected tags) ──────────────────────────── //
  const chipRow = document.createElement('div');
  chipRow.className = 'ef-relation-chips';
  chipRow.style.cssText = 'display: flex; flex-wrap: wrap; gap: var(--space-1); margin-bottom: var(--space-1);';
  wrap.appendChild(chipRow);

  // ── Search input + dropdown wrapper ─────────────────── //
  const searchWrap = document.createElement('div');
  searchWrap.style.cssText = 'position: relative;';
  wrap.appendChild(searchWrap);

  const searchInput = document.createElement('input');
  searchInput.type        = 'text';
  searchInput.className   = 'input';
  searchInput.placeholder = 'Search or add tags…';
  searchInput.autocomplete = 'off';
  searchWrap.appendChild(searchInput);

  // ── Dropdown results ─────────────────────────────────── //
  const results = document.createElement('div');
  results.style.cssText = [
    'max-height: 180px; overflow-y: auto;',
    'border: 1px solid var(--color-border);',
    'border-radius: var(--radius-sm);',
    'position: absolute; top: 100%; left: 0; right: 0; z-index: 1200;',
    'display: none; background: var(--color-bg);',
    'box-shadow: 0 8px 24px rgba(0,0,0,0.15);',
    'margin-top: 2px;',
  ].join(' ');
  searchWrap.appendChild(results);

  // ── "+ Create" button ─────────────────────────────────── //
  const createBtn = document.createElement('button');
  createBtn.type = 'button';
  createBtn.className = 'ef-relation-create-btn';
  createBtn.style.display = 'none';
  searchWrap.appendChild(createBtn);

  createBtn.addEventListener('click', () => {
    const rawName = searchInput.value.trim();
    if (!rawName) return;
    // Quick-create the tag entity, then add its name to the field
    openQuickCreateModal('tag', { name: rawName }, newTagEntity => {
      const tagName = newTagEntity.name || newTagEntity.title || rawName;
      const arr = _tagValues.get(field.key) || [];
      if (!arr.includes(tagName)) arr.push(tagName);
      _tagValues.set(field.key, arr);
      _renderChips();
      searchInput.value = '';
      createBtn.style.display = 'none';
      results.innerHTML = ''; results.style.display = 'none';
    });
  });

  // ── Also support Enter / comma to add raw tag name ────── //
  searchInput.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ',') && searchInput.value.trim()) {
      e.preventDefault();
      const val = searchInput.value.trim().replace(/,$/, '');
      if (val) {
        const arr = _tagValues.get(field.key) || [];
        if (!arr.includes(val)) arr.push(val);
        _tagValues.set(field.key, arr);
      }
      _renderChips();
      searchInput.value = '';
      results.innerHTML = ''; results.style.display = 'none';
      createBtn.style.display = 'none';
    }
    if (e.key === 'Backspace' && !searchInput.value) {
      const arr = _tagValues.get(field.key) || [];
      if (arr.length) { arr.pop(); _tagValues.set(field.key, arr); _renderChips(); }
    }
    if (e.key === 'Escape') {
      results.style.display = 'none';
      createBtn.style.display = 'none';
    }
  });

  // ── Render chips ─────────────────────────────────────── //
  const _renderChips = () => {
    chipRow.innerHTML = '';
    const tags = _tagValues.get(field.key) || [];
    for (let i = 0; i < tags.length; i++) {
      const tagName = tags[i];
      const { bg, text } = _chipColor(i);
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.style.cssText = `display:inline-flex;align-items:center;gap:5px;background:${bg};color:${text};border-radius:99px;padding:4px 10px;font-size:var(--text-sm);font-weight:600;letter-spacing:0.01em;box-shadow:0 1px 3px rgba(0,0,0,0.15);transition:filter 0.15s;`;
      chip.title = 'Click label to open tag · × to remove';

      // Clickable label — looks up tag entity by name and opens panel
      const labelEl = document.createElement('span');
      labelEl.textContent = tagName;
      labelEl.style.cursor = 'pointer';
      labelEl.addEventListener('mouseenter', () => { chip.style.filter = 'brightness(1.1)'; });
      labelEl.addEventListener('mouseleave', () => { chip.style.filter = ''; });
      labelEl.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          const allTags = await getEntitiesByType('tag');
          const tagEntity = allTags.find(t =>
            (t.name || t.title || '').toLowerCase() === tagName.toLowerCase()
          );
          if (tagEntity) {
            emit(EVENTS.PANEL_OPENED, { entityId: tagEntity.id, entityType: 'tag' });
          }
        } catch (err) {
          console.warn('[entity-form] tag panel open failed:', err);
        }
      });
      chip.appendChild(labelEl);

      // Remove button
      const rm = document.createElement('span');
      rm.textContent = '×';
      rm.style.cssText = `cursor:pointer;font-weight:bold;color:${text};opacity:0.75;font-size:1em;line-height:1;`;
      rm.addEventListener('mouseenter', () => { rm.style.opacity = '1'; });
      rm.addEventListener('mouseleave', () => { rm.style.opacity = '0.75'; });
      rm.addEventListener('click', (function(idx) {
        return function(e) {
          e.stopPropagation();
          const arr = _tagValues.get(field.key) || [];
          arr.splice(idx, 1);
          _tagValues.set(field.key, arr);
          _renderChips();
        };
      })(i));
      chip.appendChild(rm);
      chipRow.appendChild(chip);
    }
  };

  // ── Search existing tag entities ──────────────────────── //
  const _search = async (query) => {
    let allTags = [];
    try { allTags = await getEntitiesByType('tag'); } catch { return; }

    const currentTags = _tagValues.get(field.key) || [];
    const filtered = allTags.filter(t => {
      if (t.deleted) return false;
      const name = (t.name || t.title || '').toLowerCase();
      // Skip already-added tags
      if (currentTags.some(ct => ct.toLowerCase() === name)) return false;
      return !query || name.includes(query.toLowerCase());
    }).slice(0, 8);

    results.innerHTML = '';

    if (filtered.length === 0) {
      results.style.display = 'none';
      const q = searchInput.value.trim();
      if (q) {
        createBtn.textContent = `+ Create tag "${q}"`;
        createBtn.style.display = 'block';
      } else {
        createBtn.style.display = 'none';
      }
      return;
    }

    createBtn.style.display = 'none';
    results.style.display = 'block';

    for (const tagEntity of filtered) {
      const tagName = tagEntity.name || tagEntity.title || '';
      const colorDot = tagEntity.color ? ` <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--color-${tagEntity.color.toLowerCase()},#6b7280);margin-left:2px;"></span>` : '';

      const item = document.createElement('div');
      item.style.cssText = [
        'display: flex; align-items: center; gap: var(--space-2);',
        'padding: var(--space-2) var(--space-3); cursor: pointer;',
        'font-size: var(--text-sm); transition: background var(--transition-fast);',
      ].join(' ');
      item.innerHTML = `<span>🏷️</span><span>${_esc(tagName)}</span>${colorDot}`;
      item.addEventListener('mouseenter', () => { item.style.background = 'var(--color-surface-2)'; });
      item.addEventListener('mouseleave', () => { item.style.background = 'none'; });
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const arr = _tagValues.get(field.key) || [];
        if (!arr.includes(tagName)) arr.push(tagName);
        _tagValues.set(field.key, arr);
        _renderChips();
        searchInput.value = '';
        results.style.display = 'none';
        createBtn.style.display = 'none';
      });
      results.appendChild(item);
    }
  };

  searchInput.addEventListener('input',  () => _search(searchInput.value));
  searchInput.addEventListener('focus',  () => _search(searchInput.value));
  searchInput.addEventListener('blur',   () => {
    setTimeout(() => { results.style.display = 'none'; }, 150);
  });

  _renderChips();
  return wrap;
}

// ════════════════════════════════════════════════════════════
// HELPERS (early — used by QCM below)
// ════════════════════════════════════════════════════════════

/** HTML-escape a string to prevent XSS in innerHTML template literals. */
function _esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ════════════════════════════════════════════════════════════
// QUICK-CREATE MODAL
// ════════════════════════════════════════════════════════════

/**
 * Open a lightweight sub-modal to create a new entity of typeKey on the fly.
 * @param {string} typeKey
 * @param {object} prefill
 * @param {function} onCreated  called with the saved entity
 */
export function openQuickCreateModal(typeKey, prefill = {}, onCreated) {
  if (!typeKey) {
    toast.error('Relation has no target type — edit the type in Object Studio');
    return;
  }
  const config = getEntityTypeConfig(typeKey);
  if (!config) { console.warn('[qcm] Unknown type:', typeKey); return; }

  // ── Stacking: push parent form state onto stack ── //
  const parentState = {
    overlay:     _overlay,
    typeKey:     _typeKey,
    editEntity:  _editEntity,
    draft:       _draft ? { ..._draft } : null,
    onSave:      _onSave,
    relVals:     new Map(_relationValues),
    tagVals:     new Map(_tagValues),
    activeTab:   _activeFormTab,
    onCancel:    null, // set below on save
  };

  // Detach parent overlay so _buildAndMount won't remove it
  if (parentState.overlay) {
    parentState.overlay.style.display = 'none';
    parentState.overlay.remove();
  }

  // Push onto stack — closeForm will auto-restore parent on Escape or Save
  _parentFormStack.push(parentState);

  // Open full form for the child entity type
  openForm(typeKey, prefill, (savedEntity) => {
    // On save: inject onCreated into the stack entry so it fires
    // when closeForm restores the parent
    const entry = _parentFormStack[_parentFormStack.length - 1];
    if (entry === parentState) {
      entry.onCancel = () => { if (onCreated) onCreated(savedEntity); };
    }
  });
}


// ════════════════════════════════════════════════════════════
// RELATION HELPERS
// ════════════════════════════════════════════════════════════

/**
 * For edit mode: fetch existing edges for a relation field and populate _relationValues.
 * Then refresh the chips UI if the control is already mounted.
 */
async function _loadExistingEdges(entityId, field) {
  try {
    const edges = await getEdgesFrom(entityId, field.key);
    // [v5.9.5] Fallback: if no edge exists, check entity's direct field (e.g. task.project from template)
    if (!edges.length) {
      const directId = _editEntity?.[field.key];
      if (directId && typeof directId === 'string') {
        const directEntity = await getEntity(directId).catch(() => null);
        if (directEntity && !directEntity.deleted) {
          const mapped = [{ id: directEntity.id, label: _getDisplayTitle(directEntity), type: directEntity.type }];
          _relationValues.set(field.key, mapped);
          const control = _overlay?.querySelector(`[data-field="${field.key}"] .ef-relation-control`);
          if (control) {
            const chipRow = control.querySelector('.ef-relation-chips');
            if (chipRow) _refreshRelationChipsDom(chipRow, field.key);
          }
        }
      }
      return;
    }
    const entities = await Promise.all(
      edges.map(e => getEntity(e.toId).catch(() => null))
    );
    const valid = entities.filter(Boolean).filter(e => !e.deleted);
    if (!valid.length) return;
    const mapped = valid.map(e => ({
      id:    e.id,
      label: _getDisplayTitle(e),
      type:  e.type,
    }));
    _relationValues.set(field.key, mapped);
    // Re-render chips if control is already in DOM
    const control = _overlay?.querySelector(
      `[data-field="${field.key}"] .ef-relation-control`
    );
    if (control) {
      const chipRow = control.querySelector('.ef-relation-chips');
      if (chipRow) _refreshRelationChipsDom(chipRow, field.key);
    }
  } catch (err) {
    console.warn('[entity-form] _loadExistingEdges failed:', err);
  }
}

/**
 * Re-render the chips row from current _relationValues.
 */
function _refreshRelationChipsDom(chipRow, fieldKey) {
  chipRow.innerHTML = '';
  const vals = _relationValues.get(fieldKey) || [];
  for (let i = 0; i < vals.length; i++) {
    const entity = vals[i];
    const { bg, text } = _chipColor(i);
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.style.cssText = `display:inline-flex;align-items:center;gap:5px;cursor:default;background:${bg};color:${text};border-radius:99px;padding:4px 10px 4px 10px;font-size:var(--text-sm);font-weight:600;letter-spacing:0.01em;box-shadow:0 1px 3px rgba(0,0,0,0.15);transition:filter 0.15s;`;
    chip.dataset.id = entity.id;
    chip.title = 'Double-click to open · × to remove';
    const label = document.createElement('span');
    label.textContent = entity.label || entity.id;
    label.style.cssText = 'cursor:pointer;';
    label.addEventListener('mouseenter', () => { chip.style.filter = 'brightness(1.1)'; });
    label.addEventListener('mouseleave', () => { chip.style.filter = ''; });
    // Double-click → open that entity's edit form (stacked above parent)
    label.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      _openStackedEditForm(entity.id);
    });
    chip.appendChild(label);
    const rm = document.createElement('span');
    rm.textContent = '×';
    rm.style.cssText = `cursor:pointer;font-weight:bold;color:${text};opacity:0.75;margin-left:2px;font-size:1em;line-height:1;`;
    rm.addEventListener('mouseenter', () => { rm.style.opacity = '1'; });
    rm.addEventListener('mouseleave', () => { rm.style.opacity = '0.75'; });
    rm.addEventListener('click', (function(idx) {
      return function() {
        const arr = _relationValues.get(fieldKey) || [];
        arr.splice(idx, 1);
        _refreshRelationChipsDom(chipRow, fieldKey);
      };
    })(i));
    chip.appendChild(rm);
    chipRow.appendChild(chip);
  }
}

/**
 * Open an entity's edit form stacked above the current parent form.
 * On save/close the parent form is restored.
 */
async function _openStackedEditForm(entityId) {
  try {
    const entity = await getEntity(entityId);
    if (!entity) return;

    // Push parent state onto stack
    const parentState = {
      overlay:    _overlay,
      typeKey:    _typeKey,
      editEntity: _editEntity,
      draft:      _draft ? { ..._draft } : null,
      onSave:     _onSave,
      relVals:    new Map(_relationValues),
      tagVals:    new Map(_tagValues),
      activeTab:  _activeFormTab,
      onCancel:   null,
    };

    if (parentState.overlay) {
      parentState.overlay.style.display = 'none';
      parentState.overlay.remove();
    }

    _parentFormStack.push(parentState);

    // Open edit form — closeForm will auto-restore parent from stack
    openEditForm(entity);
  } catch (err) {
    console.warn('[entity-form] stacked edit failed:', err);
  }
}

// ════════════════════════════════════════════════════════════
// RELATION CONTROL
// ════════════════════════════════════════════════════════════

function _buildRelationControl(field, config) {
  const wrap = document.createElement('div');
  wrap.className   = 'ef-relation-control';
  wrap.dataset.key = field.key;

  const chipRow = document.createElement('div');
  chipRow.className = 'ef-relation-chips';
  chipRow.style.cssText = 'display: flex; flex-wrap: wrap; gap: var(--space-1); margin-bottom: var(--space-1);';
  wrap.appendChild(chipRow);

  const relSearchWrap = document.createElement('div');
  relSearchWrap.style.cssText = 'position: relative;';
  wrap.appendChild(relSearchWrap);

  const searchInput = document.createElement('input');
  searchInput.type        = 'text';
  searchInput.className   = 'input';
  searchInput.placeholder = `Search ${field.relatesTo || 'entities'}…`;
  searchInput.autocomplete = 'off';
  relSearchWrap.appendChild(searchInput);

  const results = document.createElement('div');
  results.style.cssText = `
    max-height: 180px; overflow-y: auto; border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    position: absolute; top: 100%; left: 0; right: 0; z-index: 1200;
    display: none; background: var(--color-bg);
    box-shadow: 0 8px 24px rgba(0,0,0,0.15);
    margin-top: 2px;
  `;
  relSearchWrap.appendChild(results);

  // + Create new entity button (shown when search has text but no results)
  const createBtn = document.createElement('button');
  createBtn.type = 'button';
  createBtn.className = 'ef-relation-create-btn';
  createBtn.style.display = 'none';
  relSearchWrap.appendChild(createBtn);
  createBtn.addEventListener('click', () => {
    // Look up the target type's title field key (not always 'title')
    const _tCfg = getEntityTypeConfig(typeToSearch);
    const _tKey = _tCfg?.fields?.find(f => f.isTitle)?.key || 'title';
    openQuickCreateModal(typeToSearch, { [_tKey]: searchInput.value.trim() }, newEntity => {
      const arr = _relationValues.get(field.key) || [];
      if (!arr.find(r => r.id === newEntity.id)) {
        arr.push({ id: newEntity.id, label: newEntity.title || newEntity.name || newEntity.id,
                   type: newEntity.type });
        _relationValues.set(field.key, arr);
      }
      _renderChips();
      searchInput.value = '';
      createBtn.style.display = 'none';
      results.innerHTML = ''; results.style.display = 'none';
    });
  });

  const _renderChips = () => {
    _refreshRelationChipsDom(chipRow, field.key);
  };

  const typeToSearch = field.relatesTo || null;

  const _search = async (query) => {
    let candidates = [];
    try {
      if (typeToSearch) {
        candidates = await getEntitiesByType(typeToSearch);
      } else {
        // No target type configured — search all entity types
        const allTypes = getAllEntityTypes(); // synchronous, no await
        const buckets = await Promise.all(
          allTypes.map(tp => getEntitiesByType(tp.key).catch(() => []))
        );
        candidates = buckets.flat();
      }
    } catch { return; }

    const filtered = candidates.filter(e => {
      if (e.deleted) return false;
      if (_editEntity && e.id === _editEntity.id) return false;  // exclude self-link
      return !query || _getDisplayTitle(e).toLowerCase().includes(query.toLowerCase());
    }).slice(0, 8);

    results.innerHTML = '';
    if (filtered.length === 0) {
      results.style.display = 'none';
      const q = searchInput.value.trim();
      if (q) {
        const lbl = getEntityTypeConfig(typeToSearch)?.label || typeToSearch || 'entity';
        createBtn.textContent = `+ Create "${q}" as ${lbl}`;
        createBtn.style.display = 'block';
      } else {
        createBtn.style.display = 'none';
      }
      return;
    }
    createBtn.style.display = 'none';

    results.style.display = 'block';
    for (const candidate of filtered) {
      const cfg    = getEntityTypeConfig(candidate.type);
      const title  = _getDisplayTitle(candidate);

      const item = document.createElement('div');
      item.style.cssText = `
        display: flex; align-items: center; gap: var(--space-2);
        padding: var(--space-2) var(--space-3); cursor: pointer;
        font-size: var(--text-sm); transition: background var(--transition-fast);
      `;
      item.innerHTML = `<span>${cfg?.icon || '📎'}</span><span>${title}</span>`;
      item.addEventListener('mouseenter', () => { item.style.background = 'var(--color-surface-2)'; });
      item.addEventListener('mouseleave', () => { item.style.background = 'none'; });
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const arr = _relationValues.get(field.key) || [];
        if (!arr.find(r => r.id === candidate.id)) {
          arr.push({ id: candidate.id, label: title, type: candidate.type });
          _relationValues.set(field.key, arr);
        }
        _renderChips();
        searchInput.value = '';
        results.style.display = 'none';
      });
      results.appendChild(item);
    }
  };

  searchInput.addEventListener('input', () => _search(searchInput.value));
  searchInput.addEventListener('focus', () => _search(searchInput.value));
  searchInput.addEventListener('blur', () => {
    setTimeout(() => { results.style.display = 'none'; }, 150);
  });

  _renderChips();
  return wrap;
}

// ════════════════════════════════════════════════════════════
// RELATION TYPE INFERENCE
// ════════════════════════════════════════════════════════════

/**
 * Infer the best relation type label based on from and to entity types.
 * Used by the Relations tab to auto-select relation type when an entity is picked.
 * @param {string} fromType - the entity being edited
 * @param {string} toType   - the entity being connected
 * @returns {string|null} inferred relation label, or null if no good guess
 */
function _inferRelationType(fromType, toType) {
  // Direct type-pair map — must match preset chip labels exactly (lowercase)
  const pairMap = {
    'task:person':       'assigned to',
    'task:project':      'part of',
    'task:task':         'blocked by',
    'event:person':      'assigned to',
    'note:project':      'part of',
    'document:person':   'belongs to',
    'goal:project':      'part of',
    'goal:person':       'assigned to',
  };
  const key = fromType + ':' + toType;
  if (pairMap[key]) return pairMap[key];

  // Generic toType fallback
  const genericMap = {
    'person':       'assigned to',
    'project':      'part of',
    'dailyReview':  'daily review',
    'task':         'blocked by',
    'tag':          'related to',
  };
  return genericMap[toType] || null;
}

// ════════════════════════════════════════════════════════════
// [v5.1.0] FORM TIME-TRACKER WIDGET (tasks only)
// Self-contained — lazy-imports time-tracker service.
// Mirrors entity-panel.js _buildTimeTrackerUI but lives in the form context.
// ════════════════════════════════════════════════════════════

// Module-level lazy refs — loaded once per page session
let _ftGetSession    = () => null;
let _ftStartFreeRun  = async () => {};
let _ftStartBlock    = async () => {};
let _ftStopSession   = async () => {};
let _ftResetSession  = async () => {};
let _ftAdjustSession = async () => {};
let _ftClearAlarm    = () => {};
let _ftGetElapsed    = () => 0;
let _ftGetRemaining  = () => null;
let _ftFmtDuration   = (s) => {
  if (!s || s < 0) return '0s';
  const h  = Math.floor(s / 3600);
  const m  = Math.floor((s % 3600) / 60);
  const sc = Math.floor(s % 60);
  const parts = [];
  if (h) parts.push(h + 'h');
  if (m) parts.push(m + 'm');
  // Show seconds only when no hours (keeps display compact for long sessions)
  if (!h && (sc || !m)) parts.push(sc + 's');
  return parts.join(' ') || '0s';
};
let _ftFmtCompact    = (s) => { const m=Math.floor((s||0)/60),sc=Math.floor((s||0)%60); return String(m).padStart(2,'0')+':'+String(sc).padStart(2,'0'); };
let _ftOn            = null;
let _ftTICK  = 'timer:tick';
let _ftALARM = 'timer:alarm';
let _ftSAVED = 'timer:saved';
/** True only when time-tracker import SUCCEEDED (not just attempted). Replaces broken === comparison. */
let _ftServiceReady  = false;
let _ftLoaded = false;

async function _ensureFormTimeTracker() {
  if (_ftLoaded) return;
  _ftLoaded = true;
  try {
    const tt = await import('../services/time-tracker.js');
    _ftGetSession    = tt.getSession;
    _ftStartFreeRun  = tt.startFreeRun;
    _ftStartBlock    = tt.startBlock;
    _ftStopSession   = tt.stopSession;
    _ftResetSession  = tt.resetSession;
    _ftAdjustSession = tt.adjustSession;
    _ftClearAlarm    = tt.clearAlarm;
    _ftGetElapsed    = tt.getElapsed;
    _ftGetRemaining  = tt.getRemaining;
    _ftFmtDuration   = tt.formatDuration;
    _ftFmtCompact    = tt.formatDurationCompact;
    _ftTICK  = tt.TIMER_TICK;
    _ftALARM = tt.TIMER_ALARM;
    _ftSAVED = tt.TIMER_SAVED;
    _ftServiceReady = true; // import succeeded
  } catch (e) { console.warn('[entity-form] time-tracker not available:', e.message); }
  // [BUG-8 FIX] Use statically-imported `on` from events.js (no dynamic import needed)
  _ftOn = on;
}

/**
 * Render a fully-interactive time-tracking widget into `container` for a task entity.
 * @param {HTMLElement} container
 * @param {object}      entity       — task entity (needs .id, .timeTracked)
 */
async function _buildFormTimeTrackerUI(container, entity) {
  await _ensureFormTimeTracker();
  const taskId = entity.id;

  // ── Header ──
  const hdr = document.createElement('div');
  hdr.style.cssText = 'font-size:var(--text-xs);font-weight:var(--weight-semibold);color:var(--color-text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:var(--space-3);';
  hdr.textContent = '⏱️ Time Tracking';
  container.appendChild(hdr);

  // ── Main display — friendly duration ──────────────────────
  // Shows the primary duration in human-readable form: e.g. "1h 23m 45s", "2d 4h", "47s"
  const display = document.createElement('div');
  display.style.cssText = [
    'font-size:1.75rem;font-weight:var(--weight-bold);color:var(--color-text);',
    'font-variant-numeric:tabular-nums;letter-spacing:-0.01em;',
    'margin-bottom:var(--space-1);line-height:1.1;',
  ].join('');
  container.appendChild(display);

  // ── Breakdown row — individual unit chips ──────────────────
  const breakdown = document.createElement('div');
  breakdown.style.cssText = 'display:flex;gap:var(--space-2);margin-bottom:var(--space-3);flex-wrap:wrap;';

  const _mkUnit = (label) => {
    const chip = document.createElement('div');
    chip.style.cssText = [
      'display:flex;flex-direction:column;align-items:center;',
      'background:var(--color-surface-2,rgba(0,0,0,0.04));',
      'border-radius:var(--radius-sm);padding:4px 10px;min-width:44px;',
    ].join('');
    const n = document.createElement('span');
    n.style.cssText = 'font-size:var(--text-base);font-weight:var(--weight-bold);color:var(--color-text);font-variant-numeric:tabular-nums;line-height:1.2;';
    const l = document.createElement('span');
    l.style.cssText = 'font-size:10px;color:var(--color-text-muted);margin-top:1px;text-transform:uppercase;letter-spacing:0.04em;';
    l.textContent = label;
    chip.append(n, l);
    return { w: chip, n };
  };

  const ud = _mkUnit('days'); const uh = _mkUnit('hrs');
  const um = _mkUnit('min');  const us = _mkUnit('sec');
  breakdown.append(ud.w, uh.w, um.w, us.w);
  container.appendChild(breakdown);

  // ── Status badge ──
  const statusBadge = document.createElement('div');
  statusBadge.style.cssText = 'font-size:var(--text-xs);color:var(--color-text-muted);margin-bottom:var(--space-3);min-height:16px;';
  container.appendChild(statusBadge);

  // ── Control row ──
  const ctrlRow = document.createElement('div');
  ctrlRow.style.cssText = 'display:flex;gap:var(--space-2);flex-wrap:wrap;margin-bottom:var(--space-3);';
  container.appendChild(ctrlRow);

  const _mkBtn = (text, accent = false, danger = false) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.style.cssText = [
      'padding:5px 13px;border-radius:var(--radius-md);font-size:var(--text-sm);',
      'font-weight:var(--weight-semibold);cursor:pointer;border:1px solid var(--color-border);',
      'transition:all 0.12s;',
      accent ? 'background:var(--color-accent);color:#fff;border-color:var(--color-accent);' :
      danger  ? 'background:var(--color-surface);color:var(--color-danger);border-color:var(--color-danger);' :
                'background:var(--color-surface);color:var(--color-text);',
    ].join('');
    b.addEventListener('mouseenter', () => b.style.opacity = '0.8');
    b.addEventListener('mouseleave', () => b.style.opacity = '1');
    return b;
  };

  // Unified toggle button: ▶ Start → ⏸ Pause → ▶ Continue
  const toggleBtn = _mkBtn('▶ Start', true);
  ctrlRow.append(toggleBtn);

  // ── Reset button — lives in its own row with two-step inline confirm ─
  const resetRow = document.createElement('div');
  resetRow.style.cssText = 'display:flex;gap:var(--space-2);align-items:center;margin-bottom:var(--space-3);';
  container.appendChild(resetRow);

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.textContent = '↺ Reset to 0';
  resetBtn.style.cssText = [
    'padding:4px 12px;border-radius:var(--radius-md);font-size:var(--text-xs);',
    'font-weight:var(--weight-semibold);cursor:pointer;',
    'background:var(--color-surface);color:var(--color-text-muted);',
    'border:1px solid var(--color-border);transition:all 0.12s;',
  ].join('');

  // Confirm label (hidden until first click)
  const resetConfirmLabel = document.createElement('span');
  resetConfirmLabel.style.cssText = 'font-size:var(--text-xs);color:var(--color-danger);display:none;';
  resetConfirmLabel.textContent = '⚠ This will clear ALL tracked time from the database.';

  const resetCancelBtn = document.createElement('button');
  resetCancelBtn.type = 'button';
  resetCancelBtn.textContent = 'Cancel';
  resetCancelBtn.style.cssText = [
    'padding:4px 10px;border-radius:var(--radius-md);font-size:var(--text-xs);',
    'cursor:pointer;background:none;border:1px solid var(--color-border);',
    'color:var(--color-text-muted);display:none;',
  ].join('');

  resetRow.append(resetBtn, resetConfirmLabel, resetCancelBtn);

  let _resetPending = false;
  let _resetTimer   = null;

  const _cancelReset = () => {
    _resetPending = false;
    clearTimeout(_resetTimer);
    resetBtn.textContent  = '↺ Reset to 0';
    resetBtn.style.color  = 'var(--color-text-muted)';
    resetBtn.style.borderColor = 'var(--color-border)';
    resetBtn.style.background  = 'var(--color-surface)';
    resetConfirmLabel.style.display = 'none';
    resetCancelBtn.style.display    = 'none';
  };

  resetCancelBtn.addEventListener('click', _cancelReset);

  resetBtn.addEventListener('click', async () => {
    if (!_resetPending) {
      // Step 1 — arm the reset
      _resetPending = true;
      resetBtn.textContent  = '⚠ Tap again to confirm';
      resetBtn.style.color  = 'var(--color-danger)';
      resetBtn.style.borderColor = 'var(--color-danger)';
      resetBtn.style.background  = 'var(--color-surface)';
      resetConfirmLabel.style.display = '';
      resetCancelBtn.style.display    = '';
      // Auto-cancel after 5 seconds
      _resetTimer = setTimeout(_cancelReset, 5000);
      return;
    }

    // Step 2 — execute reset
    _cancelReset();
    resetBtn.disabled = true;
    resetBtn.textContent = '…resetting';

    try {
      // Stop any running session in memory
      const liveSess = _ftGetSession(taskId);
      if (liveSess?.running) await _ftStopSession(taskId);

      // Delete in-memory session
      await _ftResetSession(taskId);

      // Zero out local references
      entity.timeTracked = 0;
      if (_draft) _draft.timeTracked = 0;

      // Persist 0 to IDB entity and emit TIMER_SAVED so all listeners update
      const fresh = await getEntity(taskId);
      if (fresh) {
        const zeroed = { ...fresh, timeTracked: 0 };
        await saveEntity(zeroed);
        emit(_ftSAVED, { taskId, elapsed: 0, entity: zeroed });
      }

      _upd();
      toast.success('Time tracking reset to 0 ✓');
    } catch (err) {
      console.error('[entity-form] Reset failed:', err);
      toast.error('Reset failed — please try again');
    } finally {
      resetBtn.disabled = false;
      resetBtn.textContent = '↺ Reset to 0';
    }
  });

  // ── Time Block section ──
  const blockSec = document.createElement('div');
  blockSec.style.cssText = 'background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:var(--space-3);margin-bottom:var(--space-3);';
  container.appendChild(blockSec);

  const blockTitle = document.createElement('div');
  blockTitle.style.cssText = 'font-size:var(--text-xs);font-weight:var(--weight-semibold);color:var(--color-text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:var(--space-2);';
  blockTitle.textContent = '⏲ Time Block';
  blockSec.appendChild(blockTitle);

  const blockRow = document.createElement('div');
  blockRow.style.cssText = 'display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap;';
  blockSec.appendChild(blockRow);

  const blockSelect = document.createElement('select');
  blockSelect.style.cssText = 'padding:5px 8px;border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-bg);color:var(--color-text);font-size:var(--text-sm);flex:1;min-width:130px;';
  const _BLOCK_OPTS = [
    {l:'5 min',secs:300},{l:'10 min',secs:600},{l:'15 min',secs:900},
    {l:'25 min (Pomodoro)',secs:1500},{l:'30 min',secs:1800},{l:'45 min',secs:2700},
    {l:'1 hr',secs:3600},{l:'1.5 hr',secs:5400},{l:'2 hr',secs:7200},
    {l:'3 hr',secs:10800},{l:'4 hr',secs:14400},{l:'5 hr',secs:18000},
  ];
  for (const o of _BLOCK_OPTS) {
    const op = document.createElement('option');
    op.value = String(o.secs);
    op.textContent = o.l;
    blockSelect.appendChild(op);
  }
  // [v6.2.0] Pre-select from plannedDuration field if set on the task entity
  // This makes the task's time block the default for the timer — "use time block as default duration".
  const plannedMins = entity?.plannedDuration
    ? (() => {
        const s = String(entity.plannedDuration).toLowerCase();
        const m = s.match(/^(\d+)\s*min/);   if (m) return parseInt(m[1], 10) * 60;
        const h = s.match(/^([\d.]+)\s*hour/); if (h) return Math.round(parseFloat(h[1]) * 3600);
        return 0;
      })()
    : 0;
  if (plannedMins > 0 && !_ftGetSession(taskId)) {
    const val = String(plannedMins);
    if ([...blockSelect.options].some(o => o.value === val)) {
      blockSelect.value = val;
    }
  }
  // Fall back to saved default time block setting
  if (!plannedMins) {
    getSetting('taskDefaultTimeBlock').then(defaultSecs => {
      if (defaultSecs && !_ftGetSession(taskId)) {
        const val = String(defaultSecs);
        if ([...blockSelect.options].some(o => o.value === val)) {
          blockSelect.value = val;
        }
      }
    }).catch(() => {});
  }
  blockRow.appendChild(blockSelect);

  const startBlockBtn = _mkBtn('▶ Start Block', true);
  blockRow.appendChild(startBlockBtn);

  const blockCountdown = document.createElement('div');
  blockCountdown.style.cssText = 'font-size:var(--text-sm);font-weight:var(--weight-semibold);color:var(--color-text);margin-top:var(--space-2);min-height:18px;';
  blockSec.appendChild(blockCountdown);

  // ── Manual adjust ──
  const adjSec = document.createElement('div');
  adjSec.style.cssText = 'margin-bottom:var(--space-3);';
  container.appendChild(adjSec);

  const adjTitle = document.createElement('div');
  adjTitle.style.cssText = 'font-size:var(--text-xs);font-weight:var(--weight-semibold);color:var(--color-text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:var(--space-2);';
  adjTitle.textContent = '✏️ Manual Adjust';
  adjSec.appendChild(adjTitle);

  const adjRow = document.createElement('div');
  adjRow.style.cssText = 'display:flex;gap:var(--space-1);align-items:center;flex-wrap:wrap;';
  adjSec.appendChild(adjRow);

  const _mkNI = (ph, w = '46px') => {
    const i = document.createElement('input');
    i.type = 'number'; i.min = '0'; i.placeholder = ph;
    i.style.cssText = `width:${w};padding:4px 5px;border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-bg);color:var(--color-text);font-size:var(--text-sm);text-align:center;`;
    return i;
  };
  const _mkL = (t) => { const s = document.createElement('span'); s.textContent = t; s.style.cssText = 'font-size:var(--text-xs);color:var(--color-text-muted);'; return s; };

  const adjD = _mkNI('0d'); const adjH = _mkNI('0h'); const adjM = _mkNI('0m'); const adjS = _mkNI('0s');
  const adjBtn = _mkBtn('Set Total');
  adjRow.append(adjD, _mkL('d'), adjH, _mkL('h'), adjM, _mkL('m'), adjS, _mkL('s'), adjBtn);

  // ── Total saved ──
  const savedRow = document.createElement('div');
  savedRow.style.cssText = 'font-size:var(--text-xs);color:var(--color-text-muted);margin-top:var(--space-1);';
  container.appendChild(savedRow);

  // ── Display update ──
  function _upd() {
    const session  = _ftGetSession(taskId);
    const elapsed  = _ftGetElapsed(session) || (entity.timeTracked || 0);
    const running  = session?.running;
    const alarmed  = session?.alarmed;
    const isBlock  = session?.mode === 'block';
    const hasSess  = !!session;

    // ── Friendly duration display ─────────────────────────────
    const dv = Math.floor(elapsed / 86400);
    const hv = Math.floor((elapsed % 86400) / 3600);
    const mv = Math.floor((elapsed % 3600) / 60);
    const sv = Math.floor(elapsed % 60);

    // Main display: compact human-readable (e.g. "1d 4h", "23m 05s", "47s", "0s")
    let friendlyMain;
    if (dv > 0)      friendlyMain = `${dv}d ${hv}h`;
    else if (hv > 0) friendlyMain = `${hv}h ${mv}m`;
    else if (mv > 0) friendlyMain = `${mv}m ${String(sv).padStart(2,'0')}s`;
    else             friendlyMain = `${sv}s`;

    display.textContent = friendlyMain;
    display.style.color = alarmed ? 'var(--color-danger)' : running ? 'var(--color-accent)' : 'var(--color-text)';

    // Breakdown chips — dim zero values for visual clarity
    ud.n.textContent = String(dv);
    uh.n.textContent = String(hv);
    um.n.textContent = String(mv);
    us.n.textContent = String(sv).padStart(2, '0');
    ud.w.style.opacity = dv > 0 ? '1' : '0.3';
    uh.w.style.opacity = hv > 0 ? '1' : (dv > 0 ? '0.5' : '0.3');
    um.w.style.opacity = mv > 0 ? '1' : (hv > 0 ? '0.5' : '0.3');
    us.w.style.opacity = '1'; // seconds always visible

    // Unified toggle button: Start / ⏸ Pause / ▶ Continue / ▶ Restart
    if (alarmed) {
      toggleBtn.textContent = '▶ Restart';
      Object.assign(toggleBtn.style, { background:'var(--color-accent)', color:'#fff', borderColor:'var(--color-accent)' });
    } else if (running) {
      toggleBtn.textContent = '⏸ Pause';
      Object.assign(toggleBtn.style, { background:'var(--color-surface)', color:'var(--color-text)', borderColor:'var(--color-border)' });
    } else if (hasSess || entity.timeTracked) {
      toggleBtn.textContent = '▶ Continue';
      Object.assign(toggleBtn.style, { background:'var(--color-accent)', color:'#fff', borderColor:'var(--color-accent)' });
    } else {
      toggleBtn.textContent = '▶ Start';
      Object.assign(toggleBtn.style, { background:'var(--color-accent)', color:'#fff', borderColor:'var(--color-accent)' });
    }

    if (alarmed) {
      statusBadge.style.color = 'var(--color-danger)';
      statusBadge.textContent = '🔔 Block complete! Time saved.';
    } else if (running && isBlock) {
      const rem = _ftGetRemaining(session);
      statusBadge.style.color = rem != null && rem <= 60 ? 'var(--color-danger)' : 'var(--color-text-muted)';
      statusBadge.textContent = rem != null ? `⏲ Block — ${_ftFmtDuration(rem)} remaining` : '⏱ Running';
      if (rem != null) {
        const pct = Math.min(100, (rem / session.blockSecs) * 100);
        blockCountdown.innerHTML = `<span style="color:var(--color-accent);">${_ftFmtDuration(rem)}</span> remaining <span style="color:var(--color-text-muted);">(${Math.round(100 - pct)}% done)</span>`;
        blockCountdown.style.color = rem <= 60 ? 'var(--color-danger)' : 'var(--color-text)';
      } else { blockCountdown.textContent = ''; }
    } else if (running) {
      statusBadge.style.color = 'var(--color-text-muted)';
      statusBadge.textContent = `⏱ Running — ${_ftFmtDuration(elapsed)} elapsed`;
      blockCountdown.textContent = '';
    } else if (hasSess && elapsed > 0) {
      statusBadge.style.color = 'var(--color-text-muted)';
      statusBadge.textContent = `⏸ Paused — ${_ftFmtDuration(elapsed)} recorded`;
      blockCountdown.textContent = ''; // always clear countdown when paused
    } else {
      statusBadge.textContent = entity.timeTracked ? '' : 'Not started'; // savedRow shows total
      blockCountdown.textContent = '';
    }

    savedRow.textContent = entity.timeTracked
      ? `💾 Total saved: ${_ftFmtDuration(entity.timeTracked)}`
      : '';
  }

  // ── Event wiring ──

  // Unified toggle: running → Pause, paused/not started → Start/Continue
  toggleBtn.addEventListener('click', async () => {
    const sess = _ftGetSession(taskId);
    if (sess?.running) {
      const wasBlock = sess.mode === 'block';
      await _ftStopSession(taskId);
      if (_draft) _draft.timeTracked = entity.timeTracked;
      _upd();
      toast.success(wasBlock ? 'Block paused ⏸ — click Continue to resume' : 'Paused ⏸');
    } else {
      _ftClearAlarm(taskId);
      await _ftStartFreeRun(taskId, entity);
      _upd();
    }
  });

  startBlockBtn.addEventListener('click', async () => {
    if (!_ftServiceReady) {
      toast.error('Timer not ready — please try again'); return;
    }
    const blockSecs = parseInt(blockSelect.value, 10);
    if (!blockSecs) return;
    _ftClearAlarm(taskId);
    await _ftStartBlock(taskId, entity, blockSecs);
    _upd();
    toast.success(`⏲ ${blockSelect.options[blockSelect.selectedIndex]?.text || 'Block'} started`);
  });

  adjBtn.addEventListener('click', async () => {
    const total = (parseInt(adjD.value)||0)*86400 + (parseInt(adjH.value)||0)*3600 +
                  (parseInt(adjM.value)||0)*60   + (parseInt(adjS.value)||0);
    if (total < 0) { toast.error('Time cannot be negative'); return; }
    if (total === 0 && !(adjD.value || adjH.value || adjM.value || adjS.value)) {
      toast.error('Enter a time value to adjust'); return;
    }
    await _ftAdjustSession(taskId, total, entity);
    adjD.value = adjH.value = adjM.value = adjS.value = '';
    // Update placeholders to reflect new adjusted value
    adjD.placeholder = String(Math.floor(total / 86400));
    adjH.placeholder = String(Math.floor((total % 86400) / 3600));
    adjM.placeholder = String(Math.floor((total % 3600) / 60));
    adjS.placeholder = String(Math.floor(total % 60));
    _upd();
    toast.success(`Set to ${_ftFmtDuration(total)}`);
  });

  // ── Live tick subscriptions (auto-unsub when removed from DOM OR cleanup event) ──
  if (_ftOn) {
    const _u1 = _ftOn(_ftTICK,  ({ taskId: tid }) => { if (tid === taskId) _upd(); });
    const _u2 = _ftOn(_ftALARM, ({ taskId: tid }) => { if (tid === taskId) _upd(); });
    const _u3 = _ftOn(_ftSAVED, ({ taskId: tid, elapsed }) => { if (tid === taskId) { entity.timeTracked = elapsed; _upd(); } });
    const _cleanup = () => { _u1(); _u2(); _u3(); _obs.disconnect(); };
    // [BUG-29 FIX] Listen on a common ancestor (document) to catch events bubbled
    // from the overlay or from any tab container (timer can be in tab2 but event dispatched
    // from tab3 during Connections tab rebuild).
    const _cleanupHandler = (e) => {
      // Only respond to events originating from within our overlay
      if (_overlay && (e.target === _overlay || _overlay.contains(e.target))) _cleanup();
    };
    document.addEventListener('fh:timerCleanup', _cleanupHandler, { once: true });
    // Also clean up when container leaves DOM (form closed)
    const _obs = new MutationObserver(() => {
      if (!document.contains(container)) { _cleanup(); document.removeEventListener('fh:timerCleanup', _cleanupHandler); }
    });
    _obs.observe(document.body, { childList: true, subtree: true });
  }

  // Pre-fill adjust inputs from current elapsed
  const initSess = _ftGetSession(taskId);
  if (initSess) {
    const e = _ftGetElapsed(initSess);
    adjD.placeholder = String(Math.floor(e / 86400));
    adjH.placeholder = String(Math.floor((e % 86400) / 3600));
    adjM.placeholder = String(Math.floor((e % 3600) / 60));
    adjS.placeholder = String(Math.floor(e % 60));
  }

  _upd();
}

// ════════════════════════════════════════════════════════════
// CONNECTIONS TAB (Tab 3 — edit mode only) [v5.1.0: renamed to "Connections"]
// Self-contained port of panel _renderRelationsTab.
// Operates on _editEntity (the saved entity being edited).
// ════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════
// CONNECTIONS TAB — REMINDER SECTION (mirrors entity-panel)
// ════════════════════════════════════════════════════════════

/**
 * Render the Add Reminder widget at the top of the Connections tab.
 * Shows existing reminder chips + quick-set presets (10m / 1h / Tomorrow 9am / Custom).
 * Self-refreshes on REMINDER_* events while the form is open.
 */
async function _renderFormReminderSection(container, entity) {
  const _esc2 = (s) => !s ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  const wrap = document.createElement('div');
  wrap.dataset.reminderSection = '1';
  wrap.style.cssText = 'padding:12px 16px 10px;border-bottom:1px solid var(--color-border);flex-shrink:0;';
  container.appendChild(wrap);

  const hdr = document.createElement('div');
  hdr.style.cssText = 'font-size:10px;font-weight:600;color:var(--color-text-muted);text-transform:uppercase;letter-spacing:0.07em;margin-bottom:8px;';
  hdr.textContent = '\uD83D\uDD14 Reminders';
  wrap.appendChild(hdr);

  // Load ALL non-dismissed reminders linked to this entity.
  // Uses two complementary queries to handle both edge directions and old data:
  //   1. getEdgesTo(entity.id, 'reminds')  — standard: reminder→entity incoming edge
  //   2. getEdgesTo(entity.id) filtered    — fallback: any incoming edge with relation='reminds'
  // Both filtered by fetched entity type='reminder' (not fromType, which may be absent in old data).
  let allReminders = [];
  try {
    // Primary query: compound index toId_relation
    let edges = await getEdgesTo(entity.id, 'reminds').catch(() => []);

    // Fallback: if compound index returned nothing, use simple toId index and filter in JS.
    // Handles cases where the compound index is unavailable or edges lack fromType.
    if (!edges.length) {
      const allIncoming = await getEdgesTo(entity.id).catch(() => []);
      edges = allIncoming.filter(e => e.relation === 'reminds');
    }

    // Fetch reminder entities — verify type='reminder' on the fetched entity
    // (safer than trusting fromType which may be null on edges created by older code)
    const fetched = await Promise.all(
      edges.map(e => getEntity(e.fromId).catch(() => null))
    );
    allReminders = fetched.filter(r => r && r.type === 'reminder' && r.status !== 'dismissed');

    // Sort ascending by nextFireAt (earliest first); no-date entries go last
    allReminders.sort((a, b) => {
      const ta = a.nextFireAt || a.fireAt || 'Z';
      const tb = b.nextFireAt || b.fireAt || 'Z';
      return ta.localeCompare(tb);
    });
  } catch (err) {
    console.warn('[entity-form] _renderFormReminderSection: edge load failed:', err);
  }

  // ── Chip strip ──
  const chipStrip = document.createElement('div');
  chipStrip.style.cssText = 'display:flex;flex-direction:column;gap:5px;margin-bottom:8px;';

  const _fmtFire = (iso) => {
    if (!iso) return '\u2014';
    try {
      const ms = new Date(iso.includes('T') ? iso : iso + 'T00:00:00') - Date.now();
      if (ms < 0) return 'overdue';
      const m = Math.floor(ms / 60000);
      if (m < 60)   return 'in ' + m + 'm';
      if (m < 1440) return 'in ' + Math.floor(m / 60) + 'h';
      return 'in ' + Math.floor(m / 1440) + 'd';
    } catch { return ''; }
  };

  const _pColor = (p) => ({ Urgent: '#ef4444', High: '#f59e0b', Normal: '#3b82f6', Low: '#94a3b8' }[p] || '#94a3b8');

  // Status badge for non-active reminders
  const _statusBadge = (r) => {
    if (r.status === 'active')   return '';
    if (r.status === 'snoozed')  return `<span style="font-size:0.65rem;padding:1px 5px;border-radius:4px;background:#f59e0b22;color:#f59e0b;font-weight:600;">snoozed</span>`;
    if (r.status === 'paused')   return `<span style="font-size:0.65rem;padding:1px 5px;border-radius:4px;background:#94a3b822;color:#94a3b8;font-weight:600;">paused</span>`;
    if (r.status === 'expired')  return `<span style="font-size:0.65rem;padding:1px 5px;border-radius:4px;background:#22c55e22;color:#22c55e;font-weight:600;">fired</span>`;
    return `<span style="font-size:0.65rem;padding:1px 5px;border-radius:4px;background:var(--color-border);color:var(--color-text-muted);font-weight:600;">${r.status}</span>`;
  };

  allReminders.forEach(r => {
    const isInactive = r.status === 'expired' || r.status === 'paused';
    const chip = document.createElement('div');
    chip.style.cssText = `display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:6px;border:1px solid var(--color-border);font-size:0.75rem;background:var(--color-surface);flex-wrap:wrap;${isInactive ? 'opacity:0.7;' : ''}`;
    const dot     = `<span style="width:8px;height:8px;border-radius:50%;background:${_pColor(r.priority)};flex-shrink:0;display:inline-block;"></span>`;
    const title2  = `<span style="font-weight:500;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc2(r.title || 'Reminder')}</span>`;
    const fire    = `<span style="color:var(--color-text-muted);white-space:nowrap;">${_fmtFire(r.nextFireAt)}</span>`;
    const badge   = _statusBadge(r);
    const recur   = r.rrule ? `<span style="color:var(--color-text-muted);">\uD83D\uDD01</span>` : '';
    const editB   = `<button data-edit-rid="${_esc2(r.id)}" title="Edit reminder" style="border:none;background:none;cursor:pointer;padding:2px 4px;font-size:0.7rem;color:var(--color-text-muted);">\u270F\uFE0F</button>`;
    // X = delete reminder + orphan cleanup (not just dismiss)
    const deleteB = `<button data-delete-rid="${_esc2(r.id)}" title="Remove reminder" style="border:none;background:none;cursor:pointer;padding:2px 4px;font-size:0.7rem;color:var(--color-danger);">\u2715</button>`;
    chip.innerHTML = dot + title2 + fire + badge + recur + editB + deleteB;
    chipStrip.appendChild(chip);
  });

  if (allReminders.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:12px 0 4px;font-size:var(--text-xs);color:var(--color-text-muted);text-align:center;';
    empty.textContent = 'No reminders set for this entity.';
    chipStrip.appendChild(empty);
  }

  wrap.appendChild(chipStrip);

  // ── Add Reminder toggle button ──
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.style.cssText = 'font-size:0.8rem;padding:6px 14px;border-radius:20px;border:1px dashed var(--color-border);cursor:pointer;background:transparent;color:var(--color-text-muted);display:flex;align-items:center;gap:6px;width:100%;justify-content:center;';
  addBtn.textContent = '\uD83D\uDD14 Add Reminder';
  wrap.appendChild(addBtn);

  // ── Quick-set section ──
  const quickSet = document.createElement('div');
  quickSet.style.cssText = 'display:none;margin-top:8px;';

  const presetRow = document.createElement('div');
  presetRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;';

  let _selectedOffset = 3600000;
  const _PRESETS = [
    { label: 'In 10m', offset: 600000 },
    { label: 'In 1h',  offset: 3600000 },
    { label: 'Tomorrow 9am', tomorrow: true },
    { label: 'Custom\u2026', custom: true },
  ];

  _PRESETS.forEach(p => {
    const pb = document.createElement('button');
    pb.type = 'button';
    pb.textContent = p.label;
    pb.style.cssText = 'font-size:0.75rem;padding:5px 12px;border-radius:20px;border:1px solid var(--color-border);cursor:pointer;background:transparent;';
    pb.addEventListener('click', () => {
      if (p.custom) {
        import('./reminder-form.js').then(m => m.openReminderForm({ targetEntity: entity })).catch(e => console.error('[entity-form] openReminderForm (custom) failed:', e));
        return;
      }
      _selectedOffset = p.tomorrow ? null : p.offset;
      presetRow.querySelectorAll('button').forEach(b => b.style.background = 'transparent');
      pb.style.background = 'var(--color-accent-muted,#eff6ff)';
    });
    presetRow.appendChild(pb);
  });
  quickSet.appendChild(presetRow);

  const _eLabel = (entity.title || entity.name || 'this').slice(0, 30);
  const saveReminderBtn = document.createElement('button');
  saveReminderBtn.type = 'button';
  saveReminderBtn.style.cssText = 'width:100%;padding:7px;border-radius:8px;border:none;cursor:pointer;background:var(--color-accent);color:#fff;font-size:0.85rem;font-weight:600;';
  saveReminderBtn.textContent = '\uD83D\uDD14 Set reminder for "' + _eLabel + '"';
  quickSet.appendChild(saveReminderBtn);
  wrap.appendChild(quickSet);

  // ── Event subscriptions (auto-unsub when wrap removed from DOM) ──
  const _unsubs = [];
  const _refresh = () => {
    _unsubs.forEach(fn => { try { fn(); } catch {} });
    if (!wrap.isConnected) return;
    wrap.remove();
    if (container.isConnected) _renderFormReminderSection(container, entity);
  };
  [EVENTS.REMINDER_CREATED, EVENTS.REMINDER_UPDATED,
   EVENTS.REMINDER_DISMISSED, EVENTS.REMINDER_SNOOZED,
   EVENTS.REMINDER_PAUSED,   EVENTS.REMINDER_RESUMED,
   EVENTS.REMINDER_FIRED,    EVENTS.REMINDER_EXPIRED].forEach(evt => _unsubs.push(on(evt, _refresh)));

  // ── Delegated click handler for chip buttons ──
  wrap.addEventListener('click', async (e) => {
    const editRid   = e.target.closest('[data-edit-rid]')?.dataset.editRid;
    const deleteRid = e.target.closest('[data-delete-rid]')?.dataset.deleteRid;
    if (editRid) {
      e.stopPropagation();
      import('./reminder-form.js').then(m => m.openReminderForm({ reminderId: editRid })).catch(e => console.error('[entity-form] openReminderForm (edit chip) failed:', e));
    }
    if (deleteRid) {
      e.stopPropagation();
      try {
        // Orphan check: how many entities is this reminder linked to?
        // Edge storage: fromId=reminder → toId=entity, relation='reminds'
        const remindsEdges = await getEdgesFrom(deleteRid, 'reminds').catch(() => []);
        if (remindsEdges.length <= 1) {
          // Only connected to this entity (or none) — delete the reminder entirely
          await deleteEntity(deleteRid).catch(e => console.warn("[entity-form] deleteEntity failed:", e));
        } else {
          // Still linked to other entities — just remove this specific edge
          const thisEdge = remindsEdges.find(ed => ed.toId === entity.id);
          if (thisEdge) await deleteEdge(thisEdge.id).catch(e => console.warn("[entity-form] deleteEdge failed:", e));
        }
        toast.success('Reminder removed');
        _unsubs.forEach(fn => { try { fn(); } catch {} });
        wrap.remove();
        if (container.isConnected) _renderFormReminderSection(container, entity);
      } catch (err) {
        console.error('[entity-form] Delete reminder failed:', err);
        toast.error('Could not remove reminder');
      }
    }
  });

  addBtn.addEventListener('click', () => {
    quickSet.style.display = quickSet.style.display === 'none' ? 'block' : 'none';
  });

  saveReminderBtn.addEventListener('click', async () => {
    saveReminderBtn.disabled = true;
    saveReminderBtn.textContent = '\u2026saving';
    try {
      const { createReminder } = await import('../services/reminder.js');
      const now = new Date();
      let fireAt;
      if (_selectedOffset === null) {
        const tom = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0);
        const p = n => String(n).padStart(2, '0');
        fireAt = tom.getFullYear() + '-' + p(tom.getMonth() + 1) + '-' + p(tom.getDate()) + 'T09:00:00';
      } else {
        const d = new Date(now.getTime() + _selectedOffset);
        const p = n => String(n).padStart(2, '0');
        fireAt = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':00';
      }
      await createReminder({
        title: entity.title || entity.name || 'Reminder',
        fireAt, status: 'active', nextFireAt: fireAt,
      }, entity.id);
      toast.success('Reminder set \u2713');
      _refresh();
    } catch (err) {
      console.error('[entity-form] Reminder save failed:', err);
      toast.error('Failed to save reminder');
      saveReminderBtn.disabled = false;
      saveReminderBtn.textContent = '\uD83D\uDD14 Set reminder for "' + _eLabel + '"';
    }
  });
}


// ════════════════════════════════════════════════════════════
// REMINDERS TAB (Tab 4) — dedicated reminder management
// Moved from Connections tab to its own tab in v5.2.0
// ════════════════════════════════════════════════════════════

async function _buildRemindersTab(container) {
  container.innerHTML = '';

  const entity = _editEntity;

  // ── Create mode: entity not yet saved ─────────────────────────
  if (!entity) {
    const msg = document.createElement('div');
    msg.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:40px 24px;gap:12px;';
    msg.innerHTML = `
      <div style="font-size:1.8rem;opacity:0.4;">🔔</div>
      <div style="font-weight:600;color:var(--color-text);font-size:var(--text-sm);">Save first to add reminders</div>
      <div style="color:var(--color-text-muted);font-size:var(--text-xs);text-align:center;">
        Fill in the details above, save the entity, then open the Reminders tab to manage reminders.
      </div>
      <button class="btn btn-primary ef-save-btn" style="margin-top:8px;padding:8px 20px;" onclick="document.querySelector('.ef-save-btn')?.click()">
        Save now
      </button>`;
    container.appendChild(msg);
    return;
  }

  // ── Render reminder section (full feature set) ─────────────────
  if (['reminder','reminderLog','rule'].includes(entity.type)) {
    const msg = document.createElement('div');
    msg.style.cssText = 'padding:24px;color:var(--color-text-muted);font-size:var(--text-sm);text-align:center;';
    msg.textContent = 'Reminders are not available for this entity type.';
    container.appendChild(msg);
    return;
  }

  await _renderFormReminderSection(container, entity);
}

async function _buildRelationsTab(container) {
  // Create mode: show add-connection form but disable connection list (needs entity ID)
  if (!_editEntity) {
    container.innerHTML = '';
    const msg = document.createElement('div');
    msg.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:40px 24px;gap:12px;';
    msg.innerHTML = `
      <div style="font-size:1.8rem;opacity:0.4;">🔗</div>
      <div style="font-weight:600;color:var(--color-text);font-size:var(--text-sm);">Save first to add connections</div>
      <div style="color:var(--color-text-muted);font-size:var(--text-xs);text-align:center;">
        Fill in the details above and save — then you can link this entity to others.
      </div>
      <button style="margin-top:8px;padding:8px 20px;border-radius:var(--radius-md);background:var(--color-accent);color:#fff;border:none;cursor:pointer;font-size:var(--text-sm);font-weight:600;"
        onclick="document.querySelector('.ef-save-btn')?.click()">
        Save now
      </button>`;
    container.appendChild(msg);
    return;
  }

  const entity = _editEntity;

  // [BUG-29 FIX] Dispatch cleanup on the modal overlay so it reaches the timer widget
  // in the Activity tab (_tab2Body), not just _tab3Body. Timer widget listens on ttWrap
  // which is inside _tab2Body — dispatching on _tab3Body (container) never reaches it.
  const _overlayEl = container.closest?.('[data-modal]') || _overlay;
  if (_overlayEl) _overlayEl.dispatchEvent(new CustomEvent('fh:timerCleanup', { bubbles: true }));
  else container.dispatchEvent(new CustomEvent('fh:timerCleanup', { bubbles: false }));
  container.innerHTML = '<div style="padding:16px;font-size:var(--text-xs);color:var(--color-text-muted);">Loading…</div>';

  // ── Pre-load all entities (needed for relations section below) ─
  // We await this early so the Loading indicator is actually visible during the IDB reads.
  let _allEntities = [];
  try {
    const allTypes = getAllEntityTypes().filter(t => !t.hidden);
    const buckets = await Promise.all(allTypes.map(t => getEntitiesByType(t.key).catch(() => [])));
    _allEntities = buckets.flat()
      .filter(e => !e.deleted && e.id !== entity.id)
      .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));
  } catch (err) {
    console.warn('[entity-form] relations: load all failed', err);
  }

  // ── Now clear and build (Loading was visible during the await above) ──────
  const _escR = (s) => !s ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const _relTime = (iso) => {
    if (!iso) return '';
    try {
      const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
      if (s < 60)     return 'just now';
      if (s < 3600)   return `${Math.floor(s/60)}m ago`;
      if (s < 86400)  return `${Math.floor(s/3600)}h ago`;
      if (s < 604800) return `${Math.floor(s/86400)}d ago`;
      return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch { return ''; }
  };
  const _dispTitle = (e) => {
    if (!e) return 'Untitled';
    const cfg = getEntityTypeConfig(e.type);
    const tf = cfg?.fields?.find(f => f.isTitle);
    if (tf) return e[tf.key] || 'Untitled';
    return e.title || e.name || 'Untitled';
  };

  // Helper: spread _editEntity but capture live timer elapsed to avoid stale timeTracked
  const _liveEntity = () => {
    const base = { ..._editEntity };
    if (_editEntity?.type === 'task' && _ftLoaded && typeof _ftGetSession === 'function') {
      const liveSess = _ftGetSession(_editEntity.id);
      if (liveSess) base.timeTracked = _ftGetElapsed(liveSess);
    }
    return base;
  };

  container.innerHTML = '';

  // ═══════════════════════════════════════════════════════════
  // [v5.1.0] SECTION 0: ACTION TOOLBAR (moved from Details tab)
  // ═══════════════════════════════════════════════════════════
  {
    const config = getEntityTypeConfig(entity.type);
    const actions = config?.actions || [];

    const toolbar = document.createElement('div');
    toolbar.style.cssText = [
      'display: flex; align-items: center; gap: 8px; flex-wrap: wrap;',
      'padding: 12px 16px 10px;',
      'border-bottom: 1px solid var(--color-border);',
      'background: var(--color-surface);',
      'position: relative; overflow: visible;',
    ].join(' ');

    const _mkB = (icon, label, danger = false) => {
      const btn = document.createElement('button');
      btn.style.cssText = [
        'display: inline-flex; align-items: center; gap: 6px;',
        'padding: 5px 11px; border-radius: var(--radius-md);',
        'font-size: var(--text-sm); font-family: var(--font-body);',
        'cursor: pointer; transition: all 0.12s; white-space: nowrap;',
        danger ? 'background: var(--color-danger-bg,#fee2e2); color: var(--color-danger,#dc2626); border: 1px solid var(--color-danger,#dc2626);'
               : 'background: var(--color-surface-2); color: var(--color-text); border: 1px solid var(--color-border);',
      ].join(' ');
      btn.innerHTML = `<span style="font-size:13px">${icon}</span><span>${label}</span>`;
      btn.title = label;
      btn.addEventListener('mouseenter', () => btn.style.filter = 'brightness(0.92)');
      btn.addEventListener('mouseleave', () => btn.style.filter = '');
      return btn;
    };

    const _guardR = async (fn) => { _saveDraftFromForm(); await fn(); };

    // ── Mark Complete / In Progress ─────────────────────────
    if (entity.type === 'task') {
      const isDone = entity.status === 'Completed' || entity.status === 'Done';
      const completeBtn = _mkB(isDone ? '↩' : '✓', isDone ? 'Mark In Progress' : 'Mark Complete');
      completeBtn.style.color         = 'var(--color-success-text,#15803d)';
      completeBtn.style.borderColor   = 'var(--color-success-text,#15803d)';
      completeBtn.addEventListener('click', () => _guardR(async () => {
        const newStatus = isDone ? 'In Progress' : 'Completed';
        const saved = await saveEntity({ ..._liveEntity(), status: newStatus }, getAccount()?.id);
        _editEntity = saved;
        _draft.status = newStatus;
        const statusSel = _overlay?.querySelector('#ef-field-status');
        if (statusSel) statusSel.value = newStatus;
        emit(EVENTS.ENTITY_SAVED, { entity: saved, isNew: false });
        toast.success(newStatus === 'Completed' ? 'Marked complete ✓' : 'Marked in progress');
        container.innerHTML = '';
        _buildRelationsTab(container);
      }));
      toolbar.appendChild(completeBtn);
    }

    // taskInstance: complete via completeInstance (updates streak/count)
    if (entity.type === 'taskInstance') {
      const isDone = entity.status === 'Completed' || entity.status === 'Skipped';
      if (!isDone) {
        const completeBtn = _mkB('✓', 'Complete Occurrence');
        completeBtn.style.color       = 'var(--color-success-text,#15803d)';
        completeBtn.style.borderColor = 'var(--color-success-text,#15803d)';
        completeBtn.addEventListener('click', () => _guardR(async () => {
          completeBtn.disabled = true;
          try {
            const { completeInstance } = await import('../services/recurrence.js');
            await completeInstance(entity.id);
            _editEntity = { ..._editEntity, status: 'Completed' };
            emit(EVENTS.ENTITY_SAVED, { entity: _editEntity, isNew: false });
            toast.success('Occurrence completed ✓');
            container.innerHTML = '';
            _buildRelationsTab(container);
          } catch (err) {
            console.error('[entity-form] completeInstance:', err);
            completeBtn.disabled = false;
          }
        }));
        toolbar.appendChild(completeBtn);
      }
    }

    // ── Archive / Unarchive (not for taskInstance) ───────────
    if (entity.type !== 'taskInstance' && (actions.includes('archive') || actions.includes('edit'))) {
      const isArchived = entity.status === 'Archived' || entity.archived;
      const btn = _mkB(isArchived ? '↑' : '📦', isArchived ? 'Unarchive' : 'Archive');
      btn.addEventListener('click', () => _guardR(async () => {
        const hasStatus = config?.fields?.some(f => f.key === 'status');
        const updated = hasStatus
          ? { ..._liveEntity(), status: isArchived ? 'Active' : 'Archived' }
          : { ..._liveEntity(), archived: !isArchived };
        const saved = await saveEntity(updated, getAccount()?.id);
        _editEntity = saved;
        emit(EVENTS.ENTITY_SAVED, { entity: saved, isNew: false });
        toast.success(isArchived ? 'Unarchived' : 'Archived');
        container.innerHTML = '';
        _buildRelationsTab(container);
      }));
      toolbar.appendChild(btn);
    }

    // ── Duplicate ─────────────────────────────────────────────
    if (actions.includes('duplicate')) {
      const btn = _mkB('⧉', 'Duplicate');
      btn.addEventListener('click', () => _guardR(async () => {
        const dup = { ..._editEntity };
        delete dup.id; delete dup.createdAt; delete dup.updatedAt; delete dup.createdBy;
        const tf = config?.fields?.find(f => f.isTitle);
        if (tf && dup[tf.key]) dup[tf.key] += ' (copy)';
        const saved = await saveEntity(dup, getAccount()?.id);
        emit(EVENTS.ENTITY_SAVED, { entity: saved, isNew: true });
        toast.success('Duplicated — opening copy');
        closeForm();
        setTimeout(() => emit(EVENTS.PANEL_OPENED, { entityId: saved.id }), 100);
      }));
      toolbar.appendChild(btn);
    }

    // ── Add to Project (not for taskInstance) ─────────────────
    if (entity.type !== 'project' && entity.type !== 'taskInstance') {
      const btn = _mkB('📁', 'Add to Project');
      btn.style.position = 'relative';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const existing = toolbar.querySelector('.ef-r-proj-picker');
        if (existing) { existing.remove(); return; }
        const dd = document.createElement('div');
        dd.className = 'ef-r-proj-picker';
        dd.style.cssText = [
          'position: absolute; top: calc(100% + 4px); left: 0; z-index: 999;',
          'background: var(--color-bg); border: 1px solid var(--color-border);',
          'border-radius: var(--radius-md); box-shadow: var(--shadow-lg);',
          'padding: 8px; min-width: 200px; max-height: 220px; overflow-y: auto;',
        ].join(' ');
        const si = document.createElement('input');
        si.type = 'text'; si.className = 'input';
        si.placeholder = 'Search projects…';
        si.style.cssText = 'padding:6px 8px;font-size:var(--text-sm);margin-bottom:6px;width:100%;box-sizing:border-box;';
        dd.appendChild(si);
        const pl = document.createElement('div');
        dd.appendChild(pl);
        const _rp = async (q) => {
          pl.innerHTML = '';
          let projs = [];
          try { projs = (await getEntitiesByType('project')).filter(p => !p.deleted); } catch {}
          const fil = projs.filter(p => !q || (p.name||'').toLowerCase().includes(q.toLowerCase()));
          const cr = document.createElement('div');
          cr.style.cssText = 'padding:6px 8px;cursor:pointer;font-size:var(--text-xs);font-weight:600;color:var(--color-accent);border-bottom:1px solid var(--color-border);';
          cr.textContent = q ? `+ Create "${q}"` : '+ New project…';
          cr.addEventListener('click', () => {
            dd.remove();
            openQuickCreateModal('project', { name: q || '' }, async np => {
              if (!np) return;
              await saveEdge({ fromId: _editEntity.id, fromType: _editEntity.type, toId: np.id, toType: 'project', relation: 'project' }, getAccount()?.id); // [B-03 fix]
              toast.success(`Added to ${np.name || 'project'}`);
            });
          });
          pl.appendChild(cr);
          for (const proj of fil.slice(0, 8)) {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px;cursor:pointer;font-size:var(--text-sm);border-radius:4px;';
            row.textContent = '📁 ' + (proj.name || 'Untitled');
            row.addEventListener('mouseenter', () => row.style.background = 'var(--color-surface-2)');
            row.addEventListener('mouseleave', () => row.style.background = '');
            row.addEventListener('click', async () => {
              await saveEdge({ fromId: _editEntity.id, fromType: _editEntity.type, toId: proj.id, toType: 'project', relation: 'project' }, getAccount()?.id); // [B-03 fix]
              dd.remove();
              toast.success(`Added to ${proj.name || 'project'}`);
            });
            pl.appendChild(row);
          }
        };
        si.addEventListener('input', () => _rp(si.value));
        _rp('');
        btn.appendChild(dd);
        setTimeout(() => si.focus(), 20);
        const _cdd = (ev) => { if (!dd.contains(ev.target) && ev.target !== btn) { dd.remove(); document.removeEventListener('click', _cdd, true); } };
        setTimeout(() => document.addEventListener('click', _cdd, true), 10);
      });
      toolbar.appendChild(btn);
    }

    // ── Convert to… ───────────────────────────────────────────
    if (actions.includes('convert')) {
      const btn = _mkB('⇄', 'Convert to…');
      btn.style.position = 'relative';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const existing = toolbar.querySelector('.ef-r-conv-picker');
        if (existing) { existing.remove(); return; }
        const dd = document.createElement('div');
        dd.className = 'ef-r-conv-picker';
        dd.style.cssText = [
          'position: absolute; top: calc(100% + 4px); left: 0; z-index: 999;',
          'background: var(--color-bg); border: 1px solid var(--color-border);',
          'border-radius: var(--radius-md); box-shadow: var(--shadow-lg);',
          'padding: 8px; min-width: 180px; max-height: 260px;',
          'overflow-y: auto; display: flex; flex-wrap: wrap; gap: 6px;',
        ].join(' ');
        const types = getAllEntityTypes().filter(t => !t.hidden && !t.archived);
        for (const t of types) {
          if (t.key === entity.type) continue;
          const row = document.createElement('button');
          row.style.cssText = 'padding:5px 10px;border:1px solid var(--color-border);border-radius:4px;background:none;cursor:pointer;font-size:var(--text-xs);color:var(--color-text);';
          row.textContent = `${t.icon} ${t.label}`;
          row.addEventListener('mouseenter', () => row.style.background = 'var(--color-surface-2)');
          row.addEventListener('mouseleave', () => row.style.background = '');
          row.addEventListener('click', async () => {
            try {
              _saveDraftFromForm();
              const converted = await convertEntity(_editEntity.id, t.key);
              dd.remove();
              emit(EVENTS.ENTITY_SAVED, { entity: converted, isNew: false });
              toast.success(`Converted to ${t.label}`);
              closeForm();
              import('./entity-panel.js').then(({ openPanel }) => openPanel(converted.id)).catch(e => console.error('[entity-form] openPanel after convert failed:', e));
            } catch (err) {
              console.error('[entity-form] Convert failed:', err);
              toast.error('Conversion failed');
            }
          });
          dd.appendChild(row);
        }
        btn.appendChild(dd);
        const _cdd = (ev) => { if (!dd.contains(ev.target) && ev.target !== btn) { dd.remove(); document.removeEventListener('click', _cdd, true); } };
        setTimeout(() => document.addEventListener('click', _cdd, true), 10);
      });
      toolbar.appendChild(btn);
    }

    if (toolbar.children.length > 0) container.appendChild(toolbar);
  }

  // Reminder section has moved to the dedicated Reminders tab (tab4) — see _buildRemindersTab()

  // ── Section 1: Add Connection ────────────────────────── //
  const addSection = document.createElement('div');
  addSection.style.cssText = 'padding: 14px 16px 12px; border-bottom: 1px solid var(--color-border); flex-shrink: 0;';
  container.appendChild(addSection);

  const addHeader = document.createElement('div');
  addHeader.style.cssText = 'font-size: 10px; font-weight: 600; color: var(--color-text-muted); text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 8px;';
  addHeader.textContent = '＋ Add Connection';
  addSection.appendChild(addHeader);

  // Relation label input
  const relationInput = document.createElement('input');
  relationInput.type = 'text';
  relationInput.className = 'input';
  relationInput.placeholder = 'Relation label (e.g. "related to")';
  relationInput.value = 'related to';
  relationInput.style.cssText = 'width: 160px; font-size: var(--text-xs); padding: 5px 8px; margin-bottom: 6px;';
  addSection.appendChild(relationInput);

  // Preset chips
  const presets = ['related to', 'part of', 'blocked by', 'blocking', 'assigned to', 'daily review', 'belongs to', 'see also'];
  const presetRow = document.createElement('div');
  presetRow.style.cssText = 'display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px;';
  for (const p of presets) {
    const chip = document.createElement('button');
    chip.textContent = p;
    chip.style.cssText = 'font-size: 10px; padding: 2px 8px; border-radius: 99px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-text-muted); cursor: pointer;';
    chip.addEventListener('click', () => {
      relationInput.value = p;
      presetRow.querySelectorAll('button').forEach(b => {
        b.style.background = b === chip ? 'var(--color-accent)' : '';
        b.style.color      = b === chip ? '#fff' : '';
        b.style.borderColor= b === chip ? 'var(--color-accent)' : '';
      });
    });
    presetRow.appendChild(chip);
  }
  addSection.appendChild(presetRow);

  // Search input + results dropdown
  const searchWrap = document.createElement('div');
  searchWrap.style.position = 'relative';
  addSection.appendChild(searchWrap);

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'input';
  searchInput.placeholder = '🔍 Search all entities — type to filter…';
  searchInput.style.cssText = 'width: 100%; font-size: var(--text-sm); padding: 8px 12px; box-sizing: border-box;';
  searchWrap.appendChild(searchInput);

  const resultsList = document.createElement('div');
  resultsList.style.cssText = [
    'display: none; position: absolute; top: 100%; left: 0; right: 0; z-index: 200;',
    'background: var(--color-bg); border: 1px solid var(--color-border);',
    'border-radius: var(--radius-md); box-shadow: 0 8px 24px rgba(0,0,0,.12);',
    'max-height: 260px; overflow-y: auto; margin-top: 2px;',
  ].join(' ');
  searchWrap.appendChild(resultsList);

  // Track linked IDs
  const _getLinkedIds = async () => {
    const [out, inc] = await Promise.all([
      getEdgesFrom(entity.id).catch(() => []),
      getEdgesTo(entity.id).catch(() => []),
    ]);
    return new Set([...out.map(e => e.toId), ...inc.map(e => e.fromId)]);
  };
  let _linkedIds = await _getLinkedIds();

  const _renderSearchResults = (query) => {
    resultsList.innerHTML = '';
    const q = (query || '').trim().toLowerCase();
    let candidates = q
      ? _allEntities.filter(e => {
          const t = _dispTitle(e).toLowerCase();
          return t.includes(q) || (e.type || '').toLowerCase().includes(q);
        })
      : _allEntities;
    const matchedResults = candidates.slice(0, 30); // [minor] BUG-70 fix: renamed from 'results' to avoid shadowing DOM node

    if (matchedResults.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:10px 12px;font-size:var(--text-xs);color:var(--color-text-muted);text-align:center;';
      empty.textContent = q ? `No entities matching "${q}"` : 'No entities found';
      resultsList.appendChild(empty);
      if (q) {
        const createBtn = document.createElement('button');
        createBtn.style.cssText = 'display:block;width:100%;padding:8px 12px;border:none;background:var(--color-accent-muted);color:var(--color-accent);cursor:pointer;font-size:var(--text-xs);font-weight:600;text-align:left;border-top:1px solid var(--color-border);';
        createBtn.textContent = `+ Create "${q}" as new entity`;
        createBtn.addEventListener('click', () => {
          resultsList.style.display = 'none';
          // Type picker
          const pickerWrap = document.createElement('div');
          pickerWrap.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap;';
          const lbl = document.createElement('span');
          lbl.style.cssText = 'font-size:var(--text-xs);color:var(--color-text-muted);';
          lbl.textContent = 'Create as:';
          const typeSelect = document.createElement('select');
          typeSelect.className = 'select'; // [G10 fix] was 'input' — needs dropdown arrow
          typeSelect.style.cssText = 'font-size:var(--text-xs);padding:3px 6px;flex:1;min-width:100px;';
          for (const tp of getAllEntityTypes().filter(t => !t.archived)) {
            const opt = document.createElement('option');
            opt.value = tp.key;
            opt.textContent = (tp.icon ? tp.icon + ' ' : '') + tp.label;
            typeSelect.appendChild(opt);
          }
          const goBtn = document.createElement('button');
          goBtn.textContent = 'Create';
          goBtn.style.cssText = 'font-size:var(--text-xs);padding:3px 10px;background:var(--color-accent);color:#fff;border:none;border-radius:var(--radius-sm);cursor:pointer;';
          goBtn.addEventListener('click', async () => {
            const chosenType = typeSelect.value;
            if (!chosenType) return;
            pickerWrap.remove();
            const _tCfg2 = getEntityTypeConfig(chosenType);
            const _tKey2 = _tCfg2?.fields?.find(f => f.isTitle)?.key || 'title';
            openQuickCreateModal(chosenType, { [_tKey2]: q }, async newEnt => {
              if (!newEnt) return;
              const rel = relationInput.value.trim() || 'related to';
              await saveEdge({ fromId: entity.id, fromType: entity.type, toId: newEnt.id, toType: newEnt.type, relation: rel }, getAccount()?.id);
              _linkedIds = await _getLinkedIds();
              searchInput.value = '';
              resultsList.style.display = 'none';
              await _refreshConnections();
            });
          });
          pickerWrap.append(lbl, typeSelect, goBtn);
          searchWrap.parentNode.insertBefore(pickerWrap, searchWrap.nextSibling);
        });
        resultsList.appendChild(createBtn);
      }
      resultsList.style.display = 'block';
      return;
    }

    for (const ent of matchedResults) {
      const cfg = getEntityTypeConfig(ent.type);
      const title = _dispTitle(ent);
      const isLinked = _linkedIds.has(ent.id);
      const timeAgo = _relTime(ent.updatedAt || ent.createdAt);

      const item = document.createElement('div');
      item.style.cssText = `display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--color-border);${isLinked ? 'opacity:0.45;' : ''}`;
      item.innerHTML = [
        `<span style="font-size:1rem;flex-shrink:0">${cfg?.icon || '📎'}</span>`,
        `<div style="flex:1;min-width:0">`,
        `  <div style="font-size:var(--text-sm);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_escR(title)}</div>`,
        `  <div style="font-size:10px;color:var(--color-text-muted)">${_escR(cfg?.label || ent.type)} · ${_escR(timeAgo)}</div>`,
        `</div>`,
        `<span style="font-size:10px;padding:2px 6px;border-radius:99px;background:${cfg?.color||'#94a3b8'}22;color:${cfg?.color||'#94a3b8'};font-weight:600;flex-shrink:0">${isLinked ? '✓ linked' : '+ link'}</span>`,
      ].join('');
      item.addEventListener('mouseenter', () => { if (!isLinked) item.style.background = 'var(--color-surface)'; });
      item.addEventListener('mouseleave', () => { item.style.background = ''; });
      item.addEventListener('click', async () => {
        if (isLinked) return;
        // [MAJOR] Auto-detect relation type based on entity types
        const autoRel = _inferRelationType(entity.type, ent.type);
        if (autoRel && relationInput.value === 'related to') {
          relationInput.value = autoRel;
          // Highlight the matching preset chip
          presetRow.querySelectorAll('button').forEach(b => {
            const match = b.textContent === autoRel;
            b.style.background   = match ? 'var(--color-accent)' : '';
            b.style.color        = match ? '#fff' : '';
            b.style.borderColor  = match ? 'var(--color-accent)' : '';
          });
        }
        const rel = relationInput.value.trim() || 'related to';
        try {
          await saveEdge({ fromId: entity.id, fromType: entity.type, toId: ent.id, toType: ent.type, relation: rel }, getAccount()?.id);
          _linkedIds.add(ent.id);
          item.style.opacity = '0.45';
          const pill = item.querySelector('span:last-child');
          if (pill) pill.textContent = '✓ linked';
          _refreshConnections();
        } catch (err) {
          console.error('[entity-form] saveEdge failed:', err);
        }
      });
      resultsList.appendChild(item);
    }
    resultsList.style.display = 'block';
  };

  let _searchDebounce = null;
  searchInput.addEventListener('focus', () => _renderSearchResults(searchInput.value));
  searchInput.addEventListener('input', () => {
    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(() => _renderSearchResults(searchInput.value), 120);
  });

  // Close dropdown on outside click — clean up with MutationObserver
  const _outsideClose = (e) => { if (!searchWrap.contains(e.target)) resultsList.style.display = 'none'; };
  document.addEventListener('click', _outsideClose);
  const _relObs = new MutationObserver(() => {
    if (!document.contains(searchWrap)) { document.removeEventListener('click', _outsideClose); _relObs.disconnect(); }
  });
  _relObs.observe(document.body, { childList: true, subtree: true });

  // ── Section 2: Connections list ──────────────────────── //
  const connHeader = document.createElement('div');
  connHeader.style.cssText = 'padding: 10px 16px 4px; font-size: 10px; font-weight: 600; color: var(--color-text-muted); text-transform: uppercase; letter-spacing: 0.07em; flex-shrink: 0;';
  connHeader.textContent = 'Connections';
  container.appendChild(connHeader);

  const connContainer = document.createElement('div');
  connContainer.style.cssText = 'flex: 1; overflow-y: auto; min-height: 0; padding: 0 0 8px;';
  container.appendChild(connContainer);

  const _refreshConnections = () => _renderFormConnectionsList(connContainer, entity);
  await _refreshConnections();
}

/**
 * Render grouped connection list for _buildRelationsTab.
 * Same logic as panel _renderConnectionsList but uses
 * form-local helpers and opens panel on row click.
 */
async function _renderFormConnectionsList(container, entity) {
  container.innerHTML = '<div style="padding:12px 16px;font-size:var(--text-xs);color:var(--color-text-muted);">Loading…</div>';

  const _escR = (s) => !s ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const _relTime = (iso) => {
    if (!iso) return '';
    try {
      const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
      if (s < 60) return 'just now';
      if (s < 3600)  return `${Math.floor(s/60)}m ago`;
      if (s < 86400) return `${Math.floor(s/3600)}h ago`;
      if (s < 604800) return `${Math.floor(s/86400)}d ago`;
      return new Date(iso).toLocaleDateString(undefined, { month:'short', day:'numeric' });
    } catch { return ''; }
  };
  const _dispTitle = (e) => {
    if (!e) return 'Untitled';
    const cfg = getEntityTypeConfig(e.type);
    const tf = cfg?.fields?.find(f => f.isTitle);
    if (tf) return e[tf.key] || 'Untitled';
    return e.title || e.name || 'Untitled';
  };

  try {
    const [outgoing, incoming] = await Promise.all([
      getEdgesFrom(entity.id).catch(() => []),
      getEdgesTo(entity.id).catch(() => []),
    ]);

    const items = [];
    for (const edge of outgoing) {
      const linked = await getEntity(edge.toId).catch(() => null);
      if (!linked || linked.deleted) continue;
      // Reminders are managed in the dedicated Reminders tab — skip here
      if (linked.type === 'reminder') continue;
      if (edge.relation === 'reminds') continue;
      items.push({ edge, linked, direction: 'out', sortKey: linked.updatedAt || linked.createdAt || '' });
    }
    for (const edge of incoming) {
      const linked = await getEntity(edge.fromId).catch(() => null);
      if (!linked || linked.deleted) continue;
      // Reminders are managed in the dedicated Reminders tab — skip here
      if (linked.type === 'reminder') continue;
      if (edge.relation === 'reminds') continue;
      items.push({ edge, linked, direction: 'in', sortKey: linked.updatedAt || linked.createdAt || '' });
    }
    items.sort((a, b) => b.sortKey.localeCompare(a.sortKey));

    container.innerHTML = '';

    if (items.length === 0) {
      container.innerHTML = [
        '<div style="padding:28px 16px;text-align:center;color:var(--color-text-muted);">',
        '  <div style="font-size:2rem;margin-bottom:8px">🔗</div>',
        '  <div style="font-size:var(--text-sm)">No connections yet</div>',
        '  <div style="font-size:var(--text-xs);margin-top:4px">Search above to add connections</div>',
        '</div>',
      ].join('');
      return;
    }

    // Group by relation + direction
    const groups = new Map();
    for (const item of items) {
      const rel = item.edge.relation || 'related to';
      const dir = item.direction === 'out' ? '→' : '←';
      const key = `${dir} ${rel}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }

    for (const [groupLabel, groupItems] of groups) {
      const section = document.createElement('div');
      section.style.cssText = 'margin-bottom: 8px; padding: 0 16px;';

      const hdr = document.createElement('div');
      hdr.style.cssText = [
        'font-size: 10px; font-weight: 600; color: var(--color-text-muted);',
        'text-transform: uppercase; letter-spacing: 0.05em;',
        'padding: 6px 0 4px; border-bottom: 1px solid var(--color-border);',
        'display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;',
      ].join(' ');
      hdr.innerHTML = `<span>${_escR(groupLabel)}</span><span style="font-weight:400;text-transform:none;letter-spacing:0">${groupItems.length} item${groupItems.length !== 1 ? 's' : ''}</span>`;
      section.appendChild(hdr);

      for (const { edge, linked, direction } of groupItems) {
        const cfg     = getEntityTypeConfig(linked.type);
        const title   = _dispTitle(linked);
        const timeAgo = _relTime(linked.updatedAt || linked.createdAt);

        const row = document.createElement('div');
        row.dataset.edgeId = edge.id;
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:7px 6px;border-radius:var(--radius-sm);cursor:pointer;transition:background 0.1s;';

        const dirArrow = direction === 'out'
          ? `<span style="color:var(--color-accent);font-size:10px;flex-shrink:0">→</span>`
          : `<span style="color:var(--color-text-muted);font-size:10px;flex-shrink:0">←</span>`;

        row.innerHTML = [
          dirArrow,
          `<span style="font-size:1rem;flex-shrink:0">${cfg?.icon || '📎'}</span>`,
          `<div style="flex:1;min-width:0">`,
          `  <div style="font-size:var(--text-sm);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_escR(title)}</div>`,
          `  <div style="font-size:10px;color:var(--color-text-muted)">${_escR(cfg?.label || linked.type)} · ${_escR(timeAgo)}</div>`,
          `</div>`,
          `<span class="type-badge" style="background:${cfg?.color||'#94a3b8'};font-size:9px;padding:1px 6px;flex-shrink:0">${_escR(cfg?.label || linked.type)}</span>`,
          `<button class="rel-rm-btn" title="Remove" style="background:none;border:none;cursor:pointer;padding:2px 4px;color:var(--color-text-muted);font-size:0.85rem;border-radius:4px;flex-shrink:0;opacity:0.5;transition:opacity 0.1s">✕</button>`,
        ].join('');

        row.addEventListener('mouseenter', () => {
          row.style.background = 'var(--color-surface-2)';
          row.querySelector('.rel-rm-btn').style.opacity = '1';
        });
        row.addEventListener('mouseleave', () => {
          row.style.background = '';
          row.querySelector('.rel-rm-btn').style.opacity = '0.5';
        });

        // Click row → open that entity's panel
        row.addEventListener('click', async (e) => {
          if (e.target.classList.contains('rel-rm-btn')) return;
          try {
            const { openPanel } = await import('./entity-panel.js');
            // Use form-first routing (opens editForm) — correct UX
            emit(EVENTS.PANEL_OPENED, { entityId: linked.id });
          } catch (err) { console.warn('[entity-form] openPanel failed:', err); }
        });

        // Remove button
        row.querySelector('.rel-rm-btn').addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            await deleteEdge(edge.id);
            row.style.opacity = '0';
            row.style.transition = 'opacity 0.2s';
            setTimeout(() => {
              row.remove();
              const remaining = section.querySelectorAll('[data-edge-id]').length;
              if (remaining === 0) section.remove();
              else hdr.querySelector('span:last-child').textContent = `${remaining} item${remaining !== 1 ? 's' : ''}`;
            }, 220);
          } catch (err) { console.error('[entity-form] deleteEdge failed:', err); }
        });

        section.appendChild(row);
      }
      container.appendChild(section);
    }

    // Total count
    const total = document.createElement('div');
    total.style.cssText = 'font-size:10px;color:var(--color-text-muted);text-align:center;padding:8px 16px;';
    total.textContent = `${items.length} total connection${items.length !== 1 ? 's' : ''}`;
    container.appendChild(total);

  } catch (err) {
    console.error('[entity-form] _renderFormConnectionsList failed:', err);
    container.innerHTML = '<div style="padding:16px;color:var(--color-danger);font-size:var(--text-xs);">Failed to load connections.</div>';
  }
}

// ════════════════════════════════════════════════════════════
// ACTIVITY TAB (Tab 2 — edit mode only) — Time tracking (tasks) + Metadata + Change log
// ════════════════════════════════════════════════════════════

/**
 * Build the "Activity" tab body (all entity types).
 * Sections for tasks:
 *   0. Time Tracker      — at top, tasks only
 *   1. Metadata card     — created / updated timestamps + ID
 *   2. Change History    — collapsible audit log
 * For non-task entities sections 1 & 2 only.
 */
/**
 * [v5.9.4] Build Tasks tab for project edit form.
 * Shows all linked tasks with inline complete toggle and + Add Task.
 */
async function _buildFormTasksTab(container, project) {
  if (!project || project.type !== 'project') return;
  container.innerHTML = '<div style="color:var(--color-text-muted);font-size:var(--text-xs);padding:var(--space-2);">Loading tasks\u2026</div>';
  try {
    const { getEntitiesByType, getEdgesTo, saveEntity } = await import('../core/db.js');
    const { emit, EVENTS } = await import('../core/events.js');
    const { getAccount } = await import('../core/auth.js');

    const [allTasks, edgesProject, edgesPartOf] = await Promise.all([
      getEntitiesByType('task').catch(() => []),
      getEdgesTo(project.id, 'project').catch(() => []),
      getEdgesTo(project.id, 'part of').catch(() => []),
    ]);

    const edgeIds = new Set([...edgesProject, ...edgesPartOf].map(e => e.fromId));
    const tasks = allTasks.filter(t => !t.deleted && (t.project === project.id || edgeIds.has(t.id)));

    container.innerHTML = '';

    const DONE = new Set(['Done','Completed','Skipped']);
    const doneCount = tasks.filter(t => DONE.has(t.status)).length;

    const hdr = document.createElement('div');
    hdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-3);flex-shrink:0;';

    const countEl = document.createElement('span');
    countEl.style.cssText = 'font-size:var(--text-xs);color:var(--color-text-muted);font-weight:600;';
    countEl.textContent = tasks.length + ' task' + (tasks.length !== 1 ? 's' : '') + ' \u00b7 ' + doneCount + ' done';
    hdr.appendChild(countEl);

    const addBtn = document.createElement('button');
    addBtn.textContent = '+ Add Task';
    addBtn.style.cssText = 'padding:4px 10px;font-size:var(--text-xs);font-weight:600;background:var(--color-accent);color:#fff;border:none;border-radius:var(--radius-sm);cursor:pointer;';
    addBtn.addEventListener('click', () => {
      const acct = getAccount();
      openForm('task', {
        project:    project.id,
        projectTitle: project.name || project.title,
        context:    project.context || 'family',
        ...(acct?.memberId ? { assignedTo: acct.memberId } : {}),
      });
    });
    hdr.appendChild(addBtn);
    container.appendChild(hdr);

    if (tasks.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'text-align:center;padding:var(--space-6) 0;color:var(--color-text-muted);font-size:var(--text-sm);';
      empty.innerHTML = '<div style="font-size:1.8rem;margin-bottom:var(--space-2);">\uD83D\uDCCB</div><div>No tasks yet</div>';
      container.appendChild(empty);
      return;
    }

    const STATUS_ORDER = ['In Progress','Not Started','Blocked','On Hold','Done','Completed','Skipped'];
    const groups = new Map(STATUS_ORDER.map(s => [s, []]));
    for (const t of tasks) {
      const s = t.status || 'Not Started';
      if (!groups.has(s)) groups.set(s, []);
      groups.get(s).push(t);
    }
    const STATUS_DOT = {
      'In Progress':'var(--color-accent)', 'Done':'#16a34a', 'Completed':'#16a34a',
      'Blocked':'var(--color-danger)', 'Not Started':'var(--color-text-muted)',
      'Skipped':'var(--color-text-muted)', 'On Hold':'#d97706'
    };
    const PRIO_COLOR = {'Critical':'#ef4444','High':'#f97316','Medium':'#f59e0b','Low':'#94a3b8'};
    const _e = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    for (const [status, sTasks] of groups) {
      if (!sTasks.length) continue;
      const isDone = DONE.has(status);
      const dot = STATUS_DOT[status] || 'var(--color-text-muted)';

      const grpHdr = document.createElement('div');
      grpHdr.style.cssText = 'font-size:10px;font-weight:600;color:var(--color-text-muted);text-transform:uppercase;letter-spacing:.06em;padding:var(--space-1) 0;border-bottom:1px solid var(--color-border);margin-bottom:var(--space-1);margin-top:var(--space-3);display:flex;align-items:center;justify-content:space-between;';
      grpHdr.innerHTML = '<span style="display:flex;align-items:center;gap:6px;"><span style="width:7px;height:7px;border-radius:50%;background:' + dot + ';flex-shrink:0;"></span>' + _e(status) + '</span><span style="font-weight:400;text-transform:none;">' + sTasks.length + '</span>';
      container.appendChild(grpHdr);

      for (const task of sTasks.sort((a,b) => {
        const P = {'Critical':0,'High':1,'Medium':2,'Low':3};
        return (P[a.priority] != null ? P[a.priority] : 2) - (P[b.priority] != null ? P[b.priority] : 2) || (a.title||'').localeCompare(b.title||'');
      })) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:var(--space-2);padding:var(--space-1-5) var(--space-1);border-radius:var(--radius-sm);cursor:pointer;transition:background 0.12s;' + (isDone ? 'opacity:0.55;' : '');
        row.addEventListener('mouseenter', () => { row.style.background = 'var(--color-surface)'; });
        row.addEventListener('mouseleave', () => { row.style.background = ''; });

        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = isDone;
        cb.style.cssText = 'flex-shrink:0;cursor:pointer;width:15px;height:15px;accent-color:var(--color-accent);';
        cb.addEventListener('click', async function(e) {
          e.stopPropagation();
          try {
            const acct = getAccount();
            await saveEntity(Object.assign({}, task, { status: isDone ? 'In Progress' : 'Done' }), acct && acct.id);
            if (container.isConnected) {
              container.dataset.loaded = '';
              _buildFormTasksTab(container, project).catch(function() {});
            }
          } catch(err) { /* non-fatal */ }
        });

        const prioDot = document.createElement('span');
        prioDot.style.cssText = 'width:6px;height:6px;border-radius:50%;background:' + (PRIO_COLOR[task.priority]||'#94a3b8') + ';flex-shrink:0;';

        const titleEl = document.createElement('span');
        titleEl.style.cssText = 'flex:1;font-size:var(--text-sm);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' + (isDone ? 'text-decoration:line-through;' : '');
        titleEl.textContent = task.title || '(Untitled)';

        const due = document.createElement('span');
        due.style.cssText = 'font-size:10px;color:var(--color-text-muted);white-space:nowrap;flex-shrink:0;';
        if (task.dueDate) {
          const parts = task.dueDate.split('-').map(Number);
          const dueDate = new Date(parts[0], parts[1]-1, parts[2]);
          const today = new Date(); today.setHours(0,0,0,0);
          due.textContent = parts[1] + '/' + parts[2];
          if (!isDone && dueDate < today) due.style.color = 'var(--color-danger)';
        }

        row.append(cb, prioDot, titleEl, due);
        row.addEventListener('click', function(e) {
          if (e.target === cb) return;
          emit(EVENTS.PANEL_OPENED, { entityId: task.id });
        });
        container.appendChild(row);
      }
    }
  } catch (err) {
    console.error('[entity-form] _buildFormTasksTab:', err);
    container.innerHTML = '<div style="color:var(--color-danger);font-size:var(--text-xs);padding:var(--space-3);">Failed to load tasks.</div>';
  }
}


async function _buildDetailsTab(container, config) {
  container.innerHTML = '';

  if (!_editEntity) {
    // New entity: show checklist (for tasks) + "save first" for activity
    if (_typeKey === 'task' || _typeKey === 'taskInstance') {
      const _clConfig = getEntityTypeConfig(_typeKey);
      const clField = _clConfig?.fields?.find(f => f.key === 'checklist');
      if (clField) {
        const clSection = document.createElement('div');
        clSection.style.cssText = 'padding:12px 16px;border-bottom:1px solid var(--color-border);';
        const clLabel = document.createElement('div');
        clLabel.style.cssText = 'font-size:var(--text-sm);font-weight:var(--weight-semibold);color:var(--color-text);margin-bottom:var(--space-2);';
        clLabel.textContent = '☑ Checklist';
        clSection.appendChild(clLabel);
        const clCtrl = _buildFieldControl(clField, _clConfig);
        if (clCtrl) clSection.appendChild(clCtrl);
        container.appendChild(clSection);
      }
    }
    const msg = document.createElement('div');
    msg.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 24px;gap:12px;';
    msg.innerHTML = `
      <div style="font-size:1.8rem;opacity:0.4;">⚡</div>
      <div style="font-weight:600;color:var(--color-text);font-size:var(--text-sm);">Activity is tracked after saving</div>
      <div style="color:var(--color-text-muted);font-size:var(--text-xs);text-align:center;">
        Time tracking, change history, and metadata appear here once the entity is saved.
      </div>
      <button style="margin-top:8px;padding:8px 20px;border-radius:var(--radius-md);background:var(--color-accent);color:#fff;border:none;cursor:pointer;font-size:var(--text-sm);font-weight:600;"
        onclick="document.querySelector('.ef-save-btn')?.click()">
        Save now
      </button>`;
    container.appendChild(msg);
    return;
  }

  const entity   = _editEntity;

  // ── helpers ─────────────────────────────────────────────── //
  const _fmtTs = (iso) => {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString(undefined, {
        dateStyle: 'medium', timeStyle: 'short',
      });
    } catch { return iso; }
  };

  // ─── 0. TIME TRACKER (tasks only — at very top) ──────────── //
  if (entity.type === 'task') {
    const ttWrap = document.createElement('div');
    ttWrap.style.cssText = [
      'border-bottom: 1px solid var(--color-border);',
      'padding: var(--space-4);',
      'background: var(--color-surface);',
    ].join(' ');
    container.appendChild(ttWrap);
    _buildFormTimeTrackerUI(ttWrap, entity).catch(e => console.warn('[entity-form] timer UI error:', e));
  }

  // ─── 1. CHECKLIST (tasks / taskInstances — after time tracker) ──── //
  if (entity.type === 'task' || entity.type === 'taskInstance') {
    const _clConfig = getEntityTypeConfig(entity.type);
    const clField = _clConfig?.fields?.find(f => f.key === 'checklist');
    if (clField) {
      const clSection = document.createElement('div');
      clSection.style.cssText = 'padding:12px 16px;border-bottom:1px solid var(--color-border);';
      const clLabel = document.createElement('div');
      clLabel.style.cssText = 'font-size:var(--text-sm);font-weight:var(--weight-semibold);color:var(--color-text);margin-bottom:var(--space-2);';
      clLabel.textContent = '☑ Checklist';
      clSection.appendChild(clLabel);
      const clCtrl = _buildFieldControl(clField, _clConfig);
      if (clCtrl) clSection.appendChild(clCtrl);
      container.appendChild(clSection);
    }
  }

  // ─── 2. METADATA CARD ─────────────────────────────────────── //
  const meta = document.createElement('div');
  meta.style.cssText = [
    'padding: 14px 16px;',
    'border-bottom: 1px solid var(--color-border);',
    'display: flex; flex-direction: column; gap: 6px;',
  ].join(' ');

  const _metaRow = (label, value) => {
    const row = document.createElement('div');
    row.style.cssText = 'display: flex; gap: 10px; align-items: baseline; font-size: var(--text-sm);';
    const lbl = document.createElement('span');
    lbl.style.cssText = 'width: 78px; flex-shrink: 0; color: var(--color-text-muted); font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; padding-top: 1px;';
    lbl.textContent = label;
    const val = document.createElement('span');
    val.style.cssText = 'color: var(--color-text); font-size: var(--text-sm);';
    val.textContent = value;
    row.appendChild(lbl); row.appendChild(val);
    return row;
  };

  meta.appendChild(_metaRow('Created',  _fmtTs(entity.createdAt)));
  meta.appendChild(_metaRow('Updated',  _fmtTs(entity.updatedAt)));
  meta.appendChild(_metaRow('ID',       entity.id || '—'));
  if (entity.createdBy) {
    // Resolve account ID → display name if possible
    const _authorName = entity._authorName || entity.createdBy;
    meta.appendChild(_metaRow('By', _authorName));
  }

  container.appendChild(meta);

  // ─── 2. ACTIVITY / CHANGE LOG (collapsible) ─────────────── //
  const actSection = document.createElement('div');
  actSection.style.cssText = 'flex: 1; display: flex; flex-direction: column; min-height: 0; overflow: hidden;';

  // Toggle header
  const actHeader = document.createElement('button');
  actHeader.style.cssText = [
    'display: flex; align-items: center; justify-content: space-between;',
    'width: 100%; padding: 11px 16px; border: none; background: var(--color-surface);',
    'border-bottom: 1px solid var(--color-border); cursor: pointer;',
    'font-size: var(--text-sm); font-weight: 600; color: var(--color-text);',
    'font-family: var(--font-body);',
  ].join(' ');
  const _actLogLabel = (_editEntity?.type === 'task') ? '📋 Change History' : '📋 Activity Log';
  actHeader.innerHTML = `<span>${_actLogLabel}</span><span class="ef-act-chevron" style="font-size:10px;color:var(--color-text-muted)">▼</span>`;

  let actOpen = true;
  const actBody = document.createElement('div');
  actBody.style.cssText = 'flex: 1; overflow-y: auto; min-height: 0;';

  actHeader.addEventListener('click', () => {
    actOpen = !actOpen;
    actBody.style.display = actOpen ? '' : 'none';
    actHeader.querySelector('.ef-act-chevron').textContent = actOpen ? '▼' : '▶';
  });

  actSection.appendChild(actHeader);
  actSection.appendChild(actBody);
  container.appendChild(actSection);

  // Load activity log async (non-fatal if it throws)
  _loadEntityActivityLog(actBody, entity, config).catch(e => {
    actBody.innerHTML = '<div style="padding:16px;font-size:var(--text-xs);color:var(--color-text-muted);">Could not load activity log.</div>';
    console.warn('[entity-form] activity log error:', e);
  });
}

/**
 * Load and render the audit log entries for a specific entity.
 */
async function _loadEntityActivityLog(container, entity, config) {
  container.innerHTML = '<div style="padding:16px;font-size:var(--text-xs);color:var(--color-text-muted);">Loading…</div>';

  try {
    const [log, authData] = await Promise.all([
      getSetting('auditLog').catch(() => []),
      getSetting('auth').catch(() => null),
    ]);
    // Filter out timer fields (timeTracked, lastFiredAt, fireCount) — handled by timer widget
    const TIMER_FIELDS = new Set(['timeTracked','lastFiredAt','fireCount','reminderTitle']);
    const entries = Array.isArray(log)
      ? log.filter(e => e.entityId === entity.id && !TIMER_FIELDS.has(e.field))
           .reverse().slice(0, 100)
      : [];

    // Build account ID → display name map
    const accountMap = new Map();
    for (const acct of (authData?.accounts || [])) {
      const name = acct.memberId
        ? await getEntity(acct.memberId).then(p => p?.name || p?.title || acct.username || acct.id).catch(() => acct.username || acct.id)
        : (acct.username || acct.id);
      accountMap.set(acct.id, name);
    }

    container.innerHTML = '';

    if (entries.length === 0) {
      container.innerHTML = [
        '<div style="display:flex;flex-direction:column;align-items:center;padding:28px 16px;gap:6px;">',
        '  <div style="font-size:1.5rem;opacity:0.4">📋</div>',
        '  <div style="font-size:var(--text-sm);color:var(--color-text-muted);">No activity recorded yet</div>',
        '  <div style="font-size:var(--text-xs);color:var(--color-text-muted);">Changes will appear here automatically</div>',
        '</div>',
      ].join('');
      return;
    }

    const _looksLikeId = (v) => v && v.length > 8 && !v.includes(' ')
      && !/^\d{4}-\d{2}-\d{2}/.test(v) && isNaN(Number(v));

    // Resolve all entity IDs in old/new values concurrently (avoids O(n) sequential reads)
    const resolvedEntries = await Promise.all(entries.map(async (entry) => {
      let oldVal = entry.oldValue != null ? String(entry.oldValue) : null;
      let newVal = entry.newValue != null ? String(entry.newValue) : null;
      const [resolvedOld, resolvedNew] = await Promise.all([
        _looksLikeId(oldVal) ? getEntity(oldVal).then(e => e?.name || e?.title || oldVal).catch(() => oldVal) : Promise.resolve(oldVal),
        _looksLikeId(newVal) ? getEntity(newVal).then(e => e?.name || e?.title || newVal).catch(() => newVal) : Promise.resolve(newVal),
      ]);
      return { ...entry, _resolvedOld: resolvedOld, _resolvedNew: resolvedNew };
    }));

    for (const entry of resolvedEntries) {
      const row = document.createElement('div');
      row.style.cssText = [
        'display: flex; flex-direction: column; gap: 3px;',
        'padding: 10px 16px;',
        'border-bottom: 1px solid color-mix(in srgb, var(--color-border) 40%, transparent);',
        'font-size: var(--text-xs);',
      ].join(' ');

      const icon = entry.action === 'create'             ? '✨'
                 : entry.action === 'delete'             ? '🗑️'
                 : entry.action === 'link'               ? '🔗'
                 : entry.action === 'unlink'             ? '🔓'
                 : entry.action?.startsWith('reminder:') ? '🔔'
                 : '✏️';

      // Reminder activity entries — rendered directly from newValue (reminder title)
      const REMINDER_LABELS = {
        'reminder:added':     'Reminder added',
        'reminder:fired':     'Reminder fired',
        'reminder:dismissed': 'Reminder done',
        'reminder:snoozed':   'Reminder snoozed',
        'reminder:removed':   'Reminder removed',
        'reminder:paused':    'Reminder paused',
        'reminder:resumed':   'Reminder resumed',
      };

      // Use pre-resolved values
      let oldVal = entry._resolvedOld;
      let newVal = entry._resolvedNew;

      // Build description
      let desc = `${icon} `;
      if (REMINDER_LABELS[entry.action]) {
        desc += `${REMINDER_LABELS[entry.action]}`;
        if (entry.newValue) desc += `: "${_efTruncate(entry.newValue, 40)}"`;
      } else if (entry.action === 'create') {
        desc += `${config.label} created`;
      } else if (entry.action === 'delete') {
        desc += `${config.label} deleted`;
      } else if (entry.action === 'link') {
        desc += `linked${entry.field ? ` via ${entry.field}` : ''}`;
        if (newVal) desc += ` → "${_efTruncate(newVal, 30)}"`;
      } else if (entry.action === 'unlink') {
        desc += `unlinked${entry.field ? ` via ${entry.field}` : ''}`;
        if (oldVal) desc += ` "${_efTruncate(oldVal, 30)}"`;
      } else if (entry.field) {
        const fieldLabel = config.fields.find(f => f.key === entry.field)?.label || entry.field;
        desc += `${fieldLabel} changed`;
        if (oldVal != null && newVal != null) {
          desc += `: "${_efTruncate(oldVal, 22)}" → "${_efTruncate(newVal, 22)}"`;
        } else if (newVal != null) {
          desc += ` to "${_efTruncate(newVal, 30)}"`;
        } else if (oldVal != null) {
          desc += ` from "${_efTruncate(oldVal, 30)}" (cleared)`;
        }
      } else {
        desc += 'updated';
      }

      const byName = entry.byAccountId ? (accountMap.get(entry.byAccountId) || null) : null;

      const mainLine = document.createElement('div');
      mainLine.style.cssText = 'display:flex;justify-content:space-between;align-items:flex-start;gap:8px;color:var(--color-text);';
      mainLine.innerHTML = [
        `<span style="flex:1;line-height:1.45">${_efEsc(desc)}</span>`,
        `<span style="flex-shrink:0;color:var(--color-text-muted);white-space:nowrap" title="${entry.at || ''}">${_efFmtShort(entry.at)}</span>`,
      ].join('');
      row.appendChild(mainLine);

      if (byName) {
        const byLine = document.createElement('div');
        byLine.style.cssText = 'color:var(--color-text-muted);padding-left:18px;';
        byLine.textContent = `by ${byName}`;
        row.appendChild(byLine);
      }

      container.appendChild(row);
    }
  } catch (err) {
    console.error('[entity-form] Activity log error:', err);
    container.innerHTML = '<div style="padding:16px;color:var(--color-danger);font-size:var(--text-xs);">Failed to load activity</div>';
  }
}

/** HTML-escape a string (activity log — prevents XSS in innerHTML) */
function _efEsc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Truncate a string for activity log display */
function _efTruncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

/** Format ISO timestamp to relative short label */
function _efFmtShort(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso), now = new Date(), diff = now - d;
    if (diff < 60000)  return 'just now';
    if (diff < 3600000) return `${Math.floor(diff/60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff/3600000)}h ago`;
    if (diff < 604800000) return `${Math.floor(diff/86400000)}d ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return iso; }
}

// ════════════════════════════════════════════════════════════
// SUBMIT / SAVE
// ════════════════════════════════════════════════════════════


/**
 * Convert a camelCase field key to a human-readable relation label.
 * Used to normalize edge.relation strings so entity-panel groups correctly.
 * @param {string} key - field key e.g. 'blockedBy', 'assignedTo'
 * @param {object} [fieldConfig] - optional field config with .label
 * @returns {string} human label e.g. 'blocked by', 'assigned to'
 */
/**
 * Return the relation string to store on an edge.
 * We use the field KEY directly (camelCase) so that every reader
 * (kanban _buildBlockerMap, daily _buildRelationEdgeMaps, calendar,
 *  entity-form _loadExistingEdges) can query with the same key without
 * any label-to-key translation step.
 * e.g. field.key='assignedTo' → relation='assignedTo'
 *       field.key='blockedBy'  → relation='blockedBy'
 *       field.key='project'    → relation='project'
 * [minor] BUG-01 fix: was converting to human label ('assigned to') causing
 * all relation edge queries to silently return empty results.
 */
function _fieldKeyToRelLabel(key, fieldConfig) {
  // Always return the field key — consistent with how all readers query edges
  return key;
}

// ── [v6.2.0] Task Period Overlap Checking ────────────────────────────────────

/**
 * Parse plannedDuration label → minutes
 * e.g. '30 min' → 30, '1.5 hours' → 90
 */
function _parseDurationMins(label) {
  if (!label) return 0;
  const s = String(label).toLowerCase().trim();
  const minMatch = s.match(/^(\d+)\s*min/);
  if (minMatch) return parseInt(minMatch[1], 10);
  const hrMatch = s.match(/^([\d.]+)\s*hour/);
  if (hrMatch) return Math.round(parseFloat(hrMatch[1]) * 60);
  return 0;
}

/**
 * Parse 'YYYY-MM-DD' + 'HH:MM' into epoch ms (local time).
 */
function _toEpochMs(dateStr, timeStr) {
  if (!dateStr) return null;
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi]    = (timeStr || '06:00').split(':').map(Number);
  return new Date(y, mo - 1, d, h || 0, mi || 0, 0).getTime();
}


/** Format epoch ms as "h:mm AM/PM" (12-hour, no leading zero on hour) */
function _fmtAMPM(ms) {
  const d = new Date(ms);
  let h = d.getHours(), m = d.getMinutes();
  const suffix = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2,'0')} ${suffix}`;
}
/** Format HH:MM string as "h:mm AM/PM" */
function _timeStrToAMPM(timeStr) {
  if (!timeStr) return '';
  const [hh, mm] = timeStr.split(':').map(Number);
  const suffix = hh >= 12 ? 'PM' : 'AM';
  const h = hh % 12 || 12;
  return `${h}:${String(mm).padStart(2,'0')} ${suffix}`;
}

/**
 * Find all tasks that overlap the given time block [startMs, endMs).
 * Excludes the current entity being edited (by id).
 *
 * Returns array of { task, startMs, endMs } for each overlap.
 */
async function _findOverlappingTasks(dateStr, timeStr, durationMins, excludeId) {
  if (!dateStr || !durationMins) return [];
  const startMs = _toEpochMs(dateStr, timeStr);
  if (startMs === null) return [];
  const endMs = startMs + durationMins * 60000;

  let allTasks, allEvents;
  try {
    [allTasks, allEvents] = await Promise.all([
      getEntitiesByType('task').catch(() => []),
      getEntitiesByType('event').catch(() => []),
    ]);
  } catch { return []; }

  const _checkItem = (item, getDateStr, getTimeStr, getDur) => {
    if (item.deleted) return null;
    if (excludeId && item.id === excludeId) return null;
    const ds  = getDateStr(item);
    if (!ds) return null;
    const dur = getDur(item);
    if (!dur) return null;
    const ts  = _toEpochMs(ds, getTimeStr(item));
    if (ts === null) return null;
    const te  = ts + dur * 60000;
    if (startMs < te && endMs > ts) return { task: item, startMs: ts, endMs: te };
    return null;
  };

  const overlaps = [];
  for (const t of allTasks) {
    const hit = _checkItem(t,
      t => t.executionDate,
      t => t.executionTime || '06:00',
      t => _parseDurationMins(t.plannedDuration)
    );
    if (hit) overlaps.push(hit);
  }
  for (const ev of allEvents) {
    const hit = _checkItem(ev,
      e => e.date ? String(e.date).slice(0, 10) : null,
      e => e.date && e.date.length > 10 ? String(e.date).slice(11, 16) : '00:00',
      e => {
        if (e.endDate && e.date) {
          const diff = Math.round((new Date(e.endDate).getTime() - new Date(e.date).getTime()) / 60000);
          if (diff > 0) return diff;
        }
        return _parseDurationMins(e.plannedDuration);
      }
    );
    if (hit) overlaps.push(hit);
  }
  return overlaps;
}

/**
 * Suggest the next available time slot after all overlapping blocks.
 */
function _suggestNextSlot(overlaps, durationMins) {
  if (!overlaps.length) return null;
  // Find the latest end time among all overlapping sessions
  const latestEnd = Math.max(...overlaps.map(o => o.endMs));
  const d = new Date(latestEnd);
  const pad = n => String(n).padStart(2, '0');
  const dateStr = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return { dateStr, timeStr };
}

const MAX_PARALLEL = 3;

/**
 * [v6.4.5] Integrated overlap conflict panel.
 *
 * Instead of a floating dialog ON TOP of the entity form, we:
 *   1. Hide the entity form overlay temporarily
 *   2. Show the conflict UI in the SAME modal position
 *   3. On user choice, restore the form with updated values
 *
 * Returns: { choice: 'parallel'|'reschedule'|'pick'|'cancel', pickedTime?: string, pickedDate?: string }
 */
async function _showOverlapDialog(overlaps, durationMins, suggestedSlot, currentDateStr) {
  return new Promise(resolve => {
    document.getElementById('fh-overlap-dialog')?.remove();

    // Hide entity form so the conflict panel takes its place seamlessly
    if (_overlay) _overlay.style.visibility = 'hidden';

    const backdrop = document.createElement('div');
    backdrop.id = 'fh-overlap-dialog';
    backdrop.style.cssText = [
      'position:fixed;inset:0;z-index:calc(var(--z-modal) + 50);',
      'background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;',
      'padding:16px;',
    ].join('');

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'overlap-dialog-title');
    dialog.style.cssText = [
      'background:var(--color-bg);border:1px solid var(--color-border);',
      'border-radius:var(--radius-lg);box-shadow:var(--shadow-xl);',
      'padding:24px;max-width:460px;width:100%;font-family:var(--font-body);',
    ].join('');

    const atParallelLimit = overlaps.length >= MAX_PARALLEL;

    const overlapList = overlaps.slice(0, 3).map(o => {
      const timeRange = `${_fmtAMPM(o.startMs)} – ${_fmtAMPM(o.endMs)}`;
      return `<li style="margin-bottom:6px;display:flex;align-items:center;gap:6px;">
        <span style="color:var(--color-accent);">📌</span>
        <strong style="flex:1;">${_esc(o.task.title || 'Untitled')}</strong>
        <span style="color:var(--color-text-muted);font-size:var(--text-xs);white-space:nowrap;">${timeRange}</span>
      </li>`;
    }).join('');

    const suggestTimeAMPM = suggestedSlot ? _timeStrToAMPM(suggestedSlot.timeStr) : '';

    const suggestHtml = suggestedSlot
      ? `<div style="margin-top:10px;padding:8px 12px;background:var(--color-surface);border-radius:var(--radius-md);
                    font-size:var(--text-xs);color:var(--color-text-muted);display:flex;align-items:center;gap:6px;">
           💡 Next available: <strong style="color:var(--color-text);">${suggestedSlot.dateStr} at ${suggestTimeAMPM}</strong>
         </div>`
      : '';

    // Build time picker for custom time selection
    const nowHH = String(new Date().getHours()).padStart(2,'0');
    const nowMM = String(new Date().getMinutes()).padStart(2,'0');
    const defaultPickTime = suggestedSlot?.timeStr || `${nowHH}:${nowMM}`;
    const defaultPickDate = suggestedSlot?.dateStr || currentDateStr || '';
    dialog.innerHTML = `
      <div id="overlap-dialog-title" style="font-weight:var(--weight-bold);font-size:var(--text-base);margin-bottom:6px;display:flex;align-items:center;gap:6px;">
        ⚠️ Time Block Conflict
      </div>
      <div style="font-size:var(--text-sm);color:var(--color-text-muted);margin-bottom:12px;">
        This task's planned time block overlaps with ${overlaps.length} existing task${overlaps.length !== 1 ? 's' : ''}:
      </div>
      <ul style="list-style:none;margin:0 0 12px;padding:0;font-size:var(--text-sm);">
        ${overlapList}
        ${overlaps.length > 3 ? `<li style="color:var(--color-text-muted);font-size:var(--text-xs);margin-top:4px;">…and ${overlaps.length - 3} more</li>` : ''}
      </ul>
      ${suggestHtml}

      <div style="margin-top:14px;padding:12px;background:var(--color-surface);border-radius:var(--radius-md);border:1px solid var(--color-border);">
        <div style="font-size:var(--text-xs);font-weight:var(--weight-semibold);color:var(--color-text-muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:0.05em;">
          Pick a different time
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <input id="od-pick-date" type="date" value="${_esc(defaultPickDate)}"
            style="padding:5px 8px;border:1px solid var(--color-border);border-radius:var(--radius-sm);
                   background:var(--color-bg);color:var(--color-text);font-size:var(--text-sm);cursor:pointer;" />
          <input id="od-pick-time" type="time" value="${_esc(defaultPickTime)}"
            style="padding:5px 8px;border:1px solid var(--color-border);border-radius:var(--radius-sm);
                   background:var(--color-bg);color:var(--color-text);font-size:var(--text-sm);cursor:pointer;" />
          <button id="od-pick-apply" style="
            padding:5px 12px;border-radius:var(--radius-sm);font-size:var(--text-sm);
            font-weight:var(--weight-semibold);cursor:pointer;
            background:var(--color-accent);color:#fff;border:1px solid var(--color-accent);">
            Use this time
          </button>
        </div>
        <div id="od-pick-status" style="font-size:var(--text-xs);margin-top:6px;min-height:16px;"></div>
      </div>

      <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap;align-items:center;">
        ${!atParallelLimit ? `<button id="od-parallel" style="
          padding:8px 14px;border-radius:var(--radius-md);font-size:var(--text-sm);
          font-weight:var(--weight-semibold);cursor:pointer;flex:1;
          background:var(--color-accent);color:#fff;border:1px solid var(--color-accent);">
          Work in parallel (${overlaps.length}/${MAX_PARALLEL})
        </button>` : `<div style="
          padding:8px 14px;border-radius:var(--radius-md);font-size:var(--text-sm);
          background:var(--color-danger-bg);color:var(--color-danger);
          border:1px solid var(--color-danger);font-weight:var(--weight-semibold);">
          ⛔ Max ${MAX_PARALLEL} parallel tasks reached
        </div>`}
        ${suggestedSlot ? `<button id="od-reschedule" style="
          padding:8px 14px;border-radius:var(--radius-md);font-size:var(--text-sm);
          font-weight:var(--weight-semibold);cursor:pointer;
          background:var(--color-surface);color:var(--color-text);border:1px solid var(--color-border);">
          📅 Use ${suggestTimeAMPM}
        </button>` : ''}
        <button id="od-cancel" style="
          padding:8px 14px;border-radius:var(--radius-md);font-size:var(--text-sm);
          cursor:pointer;background:none;color:var(--color-text-muted);border:1px solid var(--color-border);">
          ✕ Go back
        </button>
      </div>
    `;

    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);

    const _dismiss = (result) => {
      backdrop.remove();
      if (_overlay) _overlay.style.visibility = ''; // restore entity form
      resolve(result);
    };

    // Live conflict check for custom time picker
    const pickDateEl   = dialog.querySelector('#od-pick-date');
    const pickTimeEl   = dialog.querySelector('#od-pick-time');
    const pickStatusEl = dialog.querySelector('#od-pick-status');
    let _liveCheckTimer = null;

    const _runLiveCheck = async () => {
      const d = pickDateEl.value;
      const t = pickTimeEl.value;
      if (!d || !t) { pickStatusEl.textContent = ''; return; }
      pickStatusEl.innerHTML = '<span style="color:var(--color-text-muted);">Checking…</span>';
      const conflicts = await _findOverlappingTasks(d, t, durationMins, _editEntity?.id);
      if (conflicts.length === 0) {
        const displayTime = _timeStrToAMPM(t);
        pickStatusEl.innerHTML = `<span style="color:var(--color-success-text,#15803d);">✓ ${displayTime} is available — click "Use this time" to apply</span>`;
      } else {
        const names = conflicts.slice(0,2).map(c => _esc(c.task.title||'Untitled')).join(', ');
        pickStatusEl.innerHTML = `<span style="color:var(--color-danger);">⚠ Still conflicts with: ${names}${conflicts.length>2?` +${conflicts.length-2} more`:''}</span>`;
      }
    };

    const _scheduleLiveCheck = () => {
      clearTimeout(_liveCheckTimer);
      _liveCheckTimer = setTimeout(_runLiveCheck, 400);
    };

    pickDateEl.addEventListener('change', _scheduleLiveCheck);
    pickTimeEl.addEventListener('change', _scheduleLiveCheck);
    pickTimeEl.addEventListener('input',  _scheduleLiveCheck);

    // Initial check on the pre-filled suggested time
    _scheduleLiveCheck();

    dialog.querySelector('#od-pick-apply')?.addEventListener('click', () => {
      const d = pickDateEl.value;
      const t = pickTimeEl.value;
      if (!d || !t) return;
      _dismiss({ choice: 'pick', pickedDate: d, pickedTime: t });
    });

    dialog.querySelector('#od-parallel')?.addEventListener('click', () => {
      _dismiss({ choice: 'parallel' });
    });
    dialog.querySelector('#od-reschedule')?.addEventListener('click', () => {
      _dismiss({ choice: 'reschedule' });
    });
    dialog.querySelector('#od-cancel')?.addEventListener('click', () => {
      _dismiss({ choice: 'cancel' });
    });
  });
}

/**
 * [v6.5.0] Prompt user to create a follow-up task/event after completion.
 * Checks the fh:followup_on_complete setting before showing the prompt.
 * @param {object} completedEntity - the just-completed task or event
 */
export async function _promptFollowUp(completedEntity) {
  if (!completedEntity) return;
  try {
    const { getSetting } = await import('../core/db.js');
    const enabled = await getSetting('fh:followup_on_complete');
    if (enabled === false) return; // user disabled the feature
  } catch { /* non-fatal */ }

  const entityLabel = completedEntity.type === 'event' ? 'event' : 'task';
  const title       = completedEntity.title || completedEntity.name || 'this item';

  // ── Show the follow-up dialog ──
  return new Promise(resolve => {
    const existing = document.getElementById('fh-followup-dialog');
    if (existing) existing.remove();

    const backdrop = document.createElement('div');
    backdrop.id = 'fh-followup-dialog';
    backdrop.style.cssText = [
      'position:fixed;inset:0;z-index:calc(var(--z-modal) + 60);',
      'background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;',
      'padding:16px;font-family:var(--font-body);',
    ].join('');

    const dialog = document.createElement('div');
    dialog.style.cssText = [
      'background:var(--color-bg);border:1px solid var(--color-border);',
      'border-radius:var(--radius-lg);box-shadow:var(--shadow-xl);',
      'padding:24px;max-width:400px;width:100%;',
    ].join('');

    dialog.innerHTML = `
      <div style="font-weight:var(--weight-bold);font-size:var(--text-base);margin-bottom:8px;">
        ✅ ${_esc(entityLabel === 'event' ? 'Event' : 'Task')} completed!
      </div>
      <div style="font-size:var(--text-sm);color:var(--color-text-muted);margin-bottom:16px;">
        Would you like to create a follow-up ${entityLabel === 'event' ? 'task or event' : 'task or event'} connected to
        <strong>"${_esc(title)}"</strong>?
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;">
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button id="fu-task" style="
            flex:1;padding:9px 14px;border-radius:var(--radius-md);font-size:var(--text-sm);
            font-weight:var(--weight-semibold);cursor:pointer;
            background:var(--color-accent);color:#fff;border:1px solid var(--color-accent);">
            ✅ Follow-up Task
          </button>
          <button id="fu-event" style="
            flex:1;padding:9px 14px;border-radius:var(--radius-md);font-size:var(--text-sm);
            font-weight:var(--weight-semibold);cursor:pointer;
            background:#a855f7;color:#fff;border:1px solid #a855f7;">
            📅 Follow-up Event
          </button>
        </div>
        <button id="fu-skip" style="
          padding:7px 14px;border-radius:var(--radius-md);font-size:var(--text-sm);
          cursor:pointer;background:none;color:var(--color-text-muted);border:1px solid var(--color-border);">
          Not now
        </button>
      </div>
      <label style="display:flex;align-items:center;gap:6px;margin-top:12px;font-size:var(--text-xs);color:var(--color-text-muted);cursor:pointer;">
        <input type="checkbox" id="fu-disable" style="accent-color:var(--color-accent);" />
        Don't ask again (change in Settings → Tasks)
      </label>
    `;

    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);

    const _dismiss = async (choice) => {
      backdrop.remove();
      // Handle "don't ask again"
      const disableEl = dialog.querySelector('#fu-disable');
      if (disableEl?.checked) {
        try {
          const { setSetting } = await import('../core/db.js');
          await setSetting('fh:followup_on_complete', false);
        } catch {}
      }
      resolve(choice);
    };

    dialog.querySelector('#fu-task').addEventListener('click', () => _dismiss('task'));
    dialog.querySelector('#fu-event').addEventListener('click', () => _dismiss('event'));
    dialog.querySelector('#fu-skip').addEventListener('click', () => _dismiss(null));
  }).then(async (choice) => {
    if (!choice) return;

    // Build pre-fill data from the completed entity
    const prefill = {
      context:  completedEntity.context || 'family',
    };
    if (completedEntity.project)         prefill.project         = completedEntity.project;
    if (completedEntity.priority)        prefill.priority        = completedEntity.priority;
    if (completedEntity.plannedDuration) prefill.plannedDuration = completedEntity.plannedDuration;
    if (completedEntity.tags?.length)    prefill.tags            = [...completedEntity.tags];

    // Create the follow-up entity in IDB, then connect it and open the form
    try {
      const { saveEntity, saveEdge } = await import('../core/db.js');
      const { getAccount } = await import('../core/auth.js');
      const account = getAccount();
      const now = new Date().toISOString();

      const followUpType = choice; // 'task' or 'event'
      const newEntity = {
        type:      followUpType,
        title:     `Follow-up: ${completedEntity.title || 'Untitled'}`,
        context:   prefill.context,
        createdAt: now,
        updatedAt: now,
        ...(followUpType === 'task' ? {
          status:          'Next Up',
          priority:        prefill.priority || 'Medium',
          plannedDuration: prefill.plannedDuration || '',
          project:         prefill.project || null,
          tags:            prefill.tags || [],
        } : {
          // Note: event's 'type' category field intentionally omitted to avoid
          // overwriting the structural entity.type. User sets it in the edit form.
          tags:     prefill.tags || [],
        }),
      };

      const saved = await saveEntity(newEntity, account?.id);
      if (!saved) return;

      // Connect: completed → follow-up (relation: "followed by")
      const _acct = account?.id || null;
      await saveEdge({
        fromId:   completedEntity.id,
        toId:     saved.id,
        relation: 'followed by',
        metadata: { createdAt: now },
      }, _acct).catch(() => {});

      // Also connect: follow-up → completed (relation: "follows")
      await saveEdge({
        fromId:   saved.id,
        toId:     completedEntity.id,
        relation: 'follows',
        metadata: { createdAt: now },
      }, _acct).catch(() => {});

      // Open the form for further editing — pre-fill from the follow-up entity already saved
      // Use editEntity path so the form shows the full edit UI with connections, reminders, etc.
      // Small delay to let the completion save settle and IDB emit to propagate
      setTimeout(async () => {
        // Open edit form for the just-created follow-up entity so user can refine it
        await openEditForm(saved);
      }, 300);

    } catch (err) {
      console.error('[entity-form] follow-up creation failed:', err);
    }
  });
}

async function _submitForm() {
  if (!_typeKey) return;
  if (_formIsSaving) return; // prevent double-submit

  const config = getEntityTypeConfig(_typeKey);
  if (!config) return;

  _formIsSaving = true;

  // Sync draft from live form
  _saveDraftFromForm();

  // ── Validate required fields ──────────────────────────── //
  let valid = true;

  for (const field of config.fields) {
    if (field.hidden) continue; // hidden fields never validated (not in DOM)
    // [fix] Also search by fieldPaired for time fields inside paired date+time wrappers
    const group = _overlay?.querySelector(`[data-field="${field.key}"]`)
               || _overlay?.querySelector(`[data-field-paired="${field.key}"]`);
    const errEl = group?.querySelector('.ef-field-error');

    if (!field.required) continue;

    const val = field.type === 'tags'     ? _tagValues.get(field.key)
              : field.type === 'relation' ? _relationValues.get(field.key)
              : _draft[field.key];

    const isEmpty = val === null || val === undefined || val === ''
                 || (Array.isArray(val) && val.length === 0);

    if (isEmpty) {
      valid = false;
      if (errEl) {
        errEl.textContent = `${field.label} is required`;
        errEl.style.display = 'block';
      }
      if (group) {
        const control = group.querySelector('input, select, [contenteditable]');
        control?.focus();
      }
    } else {
      if (errEl) errEl.style.display = 'none';
    }
  }

  if (!valid) { _formIsSaving = false; return; }

  // ── [v6.5.0] Time block overlap check (task + event) ────── //
  {
    let _overlapDate = null, _overlapTime = '00:00', _overlapDuration = 0;
    let _dateFieldKey = 'executionDate', _timeFieldKey = 'executionTime';

    if (_typeKey === 'task') {
      _overlapDate     = _draft.executionDate;
      _overlapTime     = _draft.executionTime || '06:00';
      _overlapDuration = _parseDurationMins(_draft.plannedDuration);
    } else if (_typeKey === 'event') {
      // Events: use 'date' field for start, compute duration from endDate or plannedDuration
      _overlapDate     = _draft.date ? String(_draft.date).slice(0, 10) : null;
      _overlapTime     = _draft.date && _draft.date.length > 10
        ? String(_draft.date).slice(11, 16) : '00:00';
      _dateFieldKey    = 'date';
      _timeFieldKey    = 'date';
      // Prefer computed end-start diff, fall back to plannedDuration field
      if (_draft.endDate && _draft.date) {
        const startMs = new Date(_draft.date).getTime();
        const endMs   = new Date(_draft.endDate).getTime();
        if (endMs > startMs) _overlapDuration = Math.round((endMs - startMs) / 60000);
      }
      if (!_overlapDuration) _overlapDuration = _parseDurationMins(_draft.plannedDuration);
    }

    if (_overlapDate && _overlapDuration > 0) {
      const overlaps = await _findOverlappingTasks(_overlapDate, _overlapTime, _overlapDuration, _editEntity?.id);
      if (overlaps.length > 0) {
        const suggested = _suggestNextSlot(overlaps, _overlapDuration);
        _formIsSaving = false;
        const result = await _showOverlapDialog(overlaps, _overlapDuration, suggested, _overlapDate);

        if (result.choice === 'cancel') return;

        const _applyDateTimeToForm = (dateStr, timeStr) => {
          if (_typeKey === 'task') {
            _draft.executionDate = dateStr;
            _draft.executionTime = timeStr;
            const dEl = _overlay?.querySelector('#ef-field-executionDate');
            const tEl = _overlay?.querySelector('#ef-field-executionTime');
            if (dEl) dEl.value = dateStr;
            if (tEl) tEl.value = timeStr;
          } else if (_typeKey === 'event') {
            // Rebuild full ISO datetime for event's 'date' field
            const dateISO = `${dateStr}T${timeStr}:00`;
            _draft.date = dateISO;
            const dEl = _overlay?.querySelector('#ef-field-date');
            if (dEl) dEl.value = dateISO;
          }
        };

        if (result.choice === 'reschedule' && suggested) {
          _applyDateTimeToForm(suggested.dateStr, suggested.timeStr);
        }
        if (result.choice === 'pick' && result.pickedDate && result.pickedTime) {
          _applyDateTimeToForm(result.pickedDate, result.pickedTime);
        }
        // 'parallel' → proceed with overlap acknowledged
        _formIsSaving = true;
      }
    }
  }

  // ── Show saving state ─────────────────────────────────── //
  const saveBtn = _overlay?.querySelector('.ef-save-btn');
  if (saveBtn) {
    saveBtn.disabled     = true;
    saveBtn.textContent  = 'Saving…';
  }

  try {
    // ── Build entity object ───────────────────────────────── //
    const entityData = {
      ..._editEntity,          // preserve id, createdAt, createdBy if editing
      type: _typeKey,
    };

    for (const field of config.fields) {
      if (field.type === 'tags') {
        entityData[field.key] = _tagValues.get(field.key) || [];
      } else if (field.type === 'relation') {
        // Relations handled via edges — don't store on entity
      } else if (field.type === 'checklist') {
        // [minor] BUG-66 fix: checklist is already in _draft via _syncDraft() —
        // don't double-serialize by reading _draft again here. Read directly from _draft.
        if (_draft[field.key] !== undefined) {
          entityData[field.key] = _draft[field.key];
        }
      } else if (field.type === 'rating') {
        // Rating stored in DOM dataset
        const ratingWrap = _overlay?.querySelector(`.ef-rating-row[data-field-key="${field.key}"]`);
        if (ratingWrap && ratingWrap.dataset.currentVal !== undefined) {
          entityData[field.key] = parseInt(ratingWrap.dataset.currentVal, 10) || 0;
        } else if (_draft[field.key] !== undefined) {
          entityData[field.key] = _draft[field.key];
        }
      } else {
        const val = _draft[field.key];
        if (val !== undefined) {
          // GUARD: Never let a field named 'type' overwrite the structural entity type.
          // Store it under a safe alias instead (e.g. 'eventType', 'category').
          if (field.key === 'type') {
            entityData._subtype = val;       // preserved for display
            // Also keep the field.key so reads work — but re-assert structural type after
          } else {
            entityData[field.key] = val;
          }
        }
      }
    }

    // Re-assert structural type AFTER field loop to guard against any
    // field.key collision (e.g. event has a 'type' select field for
    // Family/School/Work which would overwrite entity.type).
    entityData.type = _typeKey;

    // [v5.3.1] Initialise recurrence cursor for new recurring tasks
    if (entityData.isRecurring && !entityData.nextOccurrenceDate) {
      entityData.nextOccurrenceDate = entityData.executionDate
                                    || entityData.dueDate
                                    || _todayStr();
      entityData.occurrenceCount = 0;
      entityData.currentStreak   = 0;
      entityData.longestStreak   = 0;
    }

    // ── Capture live timer elapsed (tasks only) ───────────────── //
    // timeTracked is hidden (not in config.fields loop). If the timer is running
    // when Save is clicked, _editEntity.timeTracked is stale. Capture current elapsed
    // so tracked time is never lost on form save.
    if (_typeKey === 'task' && _ftLoaded && typeof _ftGetSession === 'function') {
      const liveSess = _ftGetSession(entityData.id);
      if (liveSess) entityData.timeTracked = _ftGetElapsed(liveSess);
    }

    // ── Save entity ───────────────────────────────────────── //
    const account = getAccount();
    // [N01 fix] Promote ghost taskInstance to real when user edits it via form
    if (entityData.type === 'taskInstance' && (entityData.isGhost || entityData._noSync)) {
      delete entityData.isGhost;
      delete entityData._noSync;
    }
    // [G07 fix] Set completedAt when taskInstance status changes to Completed via form
    if (entityData.type === 'taskInstance' && entityData.status === 'Completed' && !entityData.completedAt) {
      const _now = new Date();
      const _p = n => String(n).padStart(2, '0');
      entityData.completedAt = `${_now.getFullYear()}-${_p(_now.getMonth()+1)}-${_p(_now.getDate())}T${_p(_now.getHours())}:${_p(_now.getMinutes())}:00`;
    }
    const saved = await saveEntity(entityData, account?.id);

    // ── Save relation edges (diff-aware: add new, remove deleted) ──── //
    for (const field of config.fields) {
      if (field.type !== 'relation') continue;
      const targets = _relationValues.get(field.key) || [];
      const targetIds = new Set(targets.map(t => t.id));

      if (_editEntity) {
        // Edit mode: fetch existing edges, remove ones no longer selected, add new ones
        try {
          const existing = await getEdgesFrom(saved.id, field.key);
          const existingToIds = new Set(existing.map(e => e.toId));
          // Remove deselected
          for (const edge of existing) {
            if (!targetIds.has(edge.toId)) {
              try { await deleteEdge(edge.id); } catch(de) { console.warn('[entity-form] deleteEdge failed:', de); }
            }
          }
          // Add newly selected
          for (const target of targets) {
            if (!existingToIds.has(target.id)) {
              try {
                await saveEdge({
                  fromId:   saved.id,
                  fromType: saved.type,
                  toId:     target.id,
                  toType:   target.type || field.relatesTo || '',
                  relation: _fieldKeyToRelLabel(field.key, field),
                }, getAccount()?.id);
              } catch (edgeErr) { console.warn('[entity-form] Edge save failed:', edgeErr); }
            }
          }
        } catch (edgeErr) { console.warn('[entity-form] Edge diff failed:', edgeErr); }
      } else {
        // Create mode: just save all selected
        for (const target of targets) {
          try {
            await saveEdge({
              fromId:   saved.id,
              fromType: saved.type,
              toId:     target.id,
              toType:   target.type || field.relatesTo || '',
              relation: _fieldKeyToRelLabel(field.key, field),
            });
            // [minor] BIDIR: create reverse edge in create mode too
            const biRev = { blockedBy: 'blocking', blocking: 'blockedBy' }[field.key];
            if (biRev) {
              const revExists = await getEdgesFrom(target.id, biRev).catch(() => []);
              if (!revExists.some(e => e.toId === saved.id)) {
                await saveEdge({
                  fromId: target.id, fromType: target.type || 'task',
                  toId: saved.id, toType: saved.type,
                  relation: _fieldKeyToRelLabel(biRev),
                }, getAccount()?.id).catch(() => {});
              }
            }
          } catch (edgeErr) {
            console.warn('[entity-form] Edge save failed:', edgeErr);
          }
        }
      }
    }

    // ── Callback & close ──────────────────────────────────── //
    // [MAJOR] Bidirectional sync: blockedBy ↔ blocking
    // When blockedBy edges change, mirror them as blocking edges on the target task.
    // When blocking edges change, mirror them as blockedBy edges on the target task.
    const BIDIR_PAIRS = { blockedBy: 'blocking', blocking: 'blockedBy' };
    for (const field of config.fields) {
      if (field.type !== 'relation' || !BIDIR_PAIRS[field.key]) continue;
      const reverseKey = BIDIR_PAIRS[field.key];
      const targets = _relationValues.get(field.key) || [];
      const targetIds = new Set(targets.map(t => t.id));

      try {
        // For all currently-selected targets, ensure reverse edge exists
        for (const target of targets) {
          const reverseEdges = await getEdgesFrom(target.id, _fieldKeyToRelLabel(reverseKey)).catch(() => []);
          const alreadyLinked = reverseEdges.some(e => e.toId === saved.id);
          if (!alreadyLinked) {
            try {
              await saveEdge({
                fromId:   target.id,
                fromType: target.type || 'task',
                toId:     saved.id,
                toType:   saved.type,
                relation: _fieldKeyToRelLabel(reverseKey),
              }, getAccount()?.id);
            } catch (re) { console.warn('[entity-form] reverse edge save failed:', re); }
          }
        }

        // Reverse cleanup handled in second pass below
      } catch (bidirErr) {
        console.warn('[entity-form] bidir sync failed:', bidirErr);
      }
    }
    // Second pass: clean up reverse edges for removed blockedBy/blocking
    for (const field of config.fields) {
      if (field.type !== 'relation' || !BIDIR_PAIRS[field.key]) continue;
      const reverseKey = BIDIR_PAIRS[field.key];
      const targets = _relationValues.get(field.key) || [];
      const targetIds = new Set(targets.map(t => t.id));

      if (_editEntity) {
        try {
          // Re-fetch to see what forward edges survived (some may have been deleted above)
          const currentForward = await getEdgesFrom(saved.id, field.key).catch(() => []);
          const currentForwardIds = new Set(currentForward.map(e => e.toId));
          // Find entities that WERE linked but are no longer
          // They had their forward edge deleted in the main loop above
          // We need to delete their reverse edges too
          // Strategy: check all entities that have a reverse edge pointing to saved.id
          // and remove ones whose forward edge no longer exists
          const reverseToUs = await getEdgesTo(saved.id, reverseKey).catch(() => []);
          for (const revEdge of reverseToUs) {
            // revEdge.fromId → saved.id with relation reverseKey
            // This means revEdge.fromId has us in their `reverseKey` field
            // If we DON'T have revEdge.fromId in our `field.key` targets, remove the reverse
            if (!targetIds.has(revEdge.fromId)) {
              try { await deleteEdge(revEdge.id); } catch {}
            }
          }
        } catch (cleanErr) {
          console.warn('[entity-form] bidir cleanup failed:', cleanErr);
        }
      }
    }

    // Emit ENTITY_SAVED before the callback so listeners (panel, kanban, daily)
    // update state first. The callback then has fresh data if it queries anything.
    const cb = _onSave;
    const _wasNewLocal = !_editEntity; // [v5.3.1] capture BEFORE emit (wasNew declared after)
    const wasNew = !_editEntity;
    const entityLabel = config?.label || 'item';

    // [v5.3.1] Stop series if isRecurring was toggled off during edit
    if (_editEntity?.isRecurring && !saved.isRecurring) {
      try {
        const { stopSeries } = await import('../services/recurrence.js');
        await stopSeries(saved.id); // must await before ENTITY_SAVED fires
      } catch (e) { console.error('[entity-form] stopSeries:', e); }
    }

    // [v5.3.1] Auto-create linked reminder for brand-new recurring tasks
    if (_wasNewLocal && saved.isRecurring && saved.rrule) {
      try {
        const { getEdgesTo: _getEdgesTo } = await import('../core/db.js');
        const linked = await _getEdgesTo(saved.id, 'reminds').catch(() => []);
        if (linked.length === 0) {
          const { createReminder } = await import('../services/reminder.js');
          const ft = (saved.executionTime || saved.dueTime || '06:00').slice(0, 5);
          const fd = saved.executionDate || saved.dueDate;
          if (fd) {
            await createReminder({
              title:             `Reminder: ${saved.title}`,
              rrule:             saved.rrule,
              fireAt:            `${fd}T${ft}:00`,
              context:           saved.context,
              recurrenceEnd:     saved.recurrenceEnd,
              recurrenceEndDate: saved.recurrenceEndDate,
              recurrenceCount:   saved.recurrenceCount,
              channelInApp:      true,
              channelToast:      true,
            }, saved.id);
          }
        }
      } catch (e) { console.error('[entity-form] auto-reminder:', e); }
    }

    // Emit ENTITY_SAVED FIRST so listeners (kanban, daily, panel) get fresh data,
    // then run the onSave callback, then close the form.
    // Closing last ensures any listener that checks the overlay won't see null prematurely.
    emit(EVENTS.ENTITY_SAVED, { entity: saved, isNew: wasNew });
    cb?.(saved);
    closeForm();
    if (saved.isRecurring) {
      toast.success(wasNew ? `Recurring task created — view in the All tab` : `Recurring task saved`);
    } else {
      toast.success(wasNew ? `${entityLabel} created` : `${entityLabel} saved`);
    }

  } catch (err) {
    console.error('[entity-form] Save failed:', err);
    // Only re-enable if overlay is still in the DOM (user may have Escaped mid-save)
    if (saveBtn && _overlay && document.body.contains(_overlay)) {
      saveBtn.disabled    = false;
      saveBtn.textContent = _editEntity ? 'Save changes' : `Create ${config?.label}`;
    }
    // Show global error
    const body = _overlay?.querySelector('.ef-body');
    if (body) {
      let errBanner = body.querySelector('.ef-global-error');
      if (!errBanner) {
        errBanner = document.createElement('div');
        errBanner.className = 'ef-global-error';
        errBanner.style.cssText = `
          background: var(--color-danger-bg); color: var(--color-danger-text);
          border: 1px solid var(--color-danger); border-radius: var(--radius-sm);
          padding: var(--space-2) var(--space-3); font-size: var(--text-sm);
          margin-bottom: var(--space-3);
        `;
        body.insertBefore(errBanner, body.firstChild);
      }
      errBanner.textContent = `Save failed: ${err.message || 'Unknown error'}`;
    }
  } finally {
    _formIsSaving = false;
    // [v6.5.0] Safety: ensure overlay is visible if overlap dialog was shown but not properly dismissed
    if (_overlay && _overlay.style.visibility === 'hidden') _overlay.style.visibility = '';
  }
}

/**
 * Refresh the non-Details tabs of the currently open entity form.
 * Called when an external save/edge change affects the editing entity.
 * @param {object} config
 * @param {boolean} includeDetails  — if true also refreshes the Details tab (fields)
 */
function _refreshFormTabs(config, includeDetails = false) {
  if (!_editEntity) return;
  // Activity tab: reset so it re-loads with latest change history
  if (_tab2Body?.dataset.loaded && (includeDetails || _tab2Body.dataset.loaded === 'dirty')) {
    _tab2Body.dataset.loaded = '';
    if (_activeFormTab === 'details') {
      const freshConfig = getEntityTypeConfig(_editEntity.type) || config;
      _buildDetailsTab(_tab2Body, freshConfig).catch(e => console.warn('[entity-form] Activity refresh:', e));
    }
  } else if (_tab2Body?.dataset.loaded) {
    // Mark dirty so it reloads next time it becomes active
    _tab2Body.dataset.loaded = 'dirty';
  }
  // Connections tab
  if (_tab3Body?.dataset.loaded) {
    _tab3Body.dataset.loaded = '';
    if (_activeFormTab === 'relations') {
      _buildRelationsTab(_tab3Body);
    }
  }
  // Reminders tab
  if (_tab4Body?.dataset.loaded) {
    _tab4Body.dataset.loaded = '';
    if (_activeFormTab === 'reminders') {
      _buildRemindersTab(_tab4Body);
    }
  }
  // Update modal header title if entity title changed
  if (_overlay) {
    const headerTitle = _overlay.querySelector('.ef-entity-label');
    if (headerTitle) {
      const name = _editEntity.title || _editEntity.name || '';
      if (name && headerTitle.textContent !== name) headerTitle.textContent = name;
    }
  }
}



/**
 * Sync live input values into _draft (for fields not already updating on input).
 */
function _saveDraftFromForm() {
  if (!_overlay || !_typeKey) return;
  const config = getEntityTypeConfig(_typeKey);
  if (!config) return;

  for (const field of config.fields) {
    if (field.hidden) continue; // hidden fields not in DOM — skip
    if (['relation', 'tags', 'multiselect', 'richtext', 'checkbox', 'checklist', 'rating'].includes(field.type)) continue;

    const el = _overlay.querySelector(`#ef-field-${field.key}`);
    if (!el) continue;

    if (el.tagName === 'SELECT') {
      _draft[field.key] = el.value || null;
    } else if (el.tagName === 'INPUT') {
      if (el.type === 'number') {
        _draft[field.key] = el.value !== '' ? Number(el.value) : null;
      } else {
        _draft[field.key] = el.value.trim() || null;
      }
    }
  }

  // Sync richtext editors — handles both Quill (.ef-quill-container) and fallback (.ef-richtext-fallback)
  _overlay.querySelectorAll('.ef-richtext-fallback').forEach(ed => {
    const key = ed.closest('[data-field]')?.dataset.field;
    if (key) _draft[key] = ed.innerHTML.trim() || null;
  });
  // Quill containers: read from .ql-editor inside each .ef-quill-container
  _overlay.querySelectorAll('.ef-quill-container').forEach(container => {
    const key = container.closest('[data-field]')?.dataset.field;
    if (!key) return;
    const qlEditor = container.querySelector('.ql-editor');
    if (qlEditor) {
      const html = qlEditor.innerHTML || '';
      _draft[key] = (html === '<p><br></p>' || !html) ? null : html;
    }
  });
}

/** Get title field key for a given entity type */
function _getTitleKey(type) {
  const cfg = getEntityTypeConfig(type);
  if (!cfg) return 'title';
  const tf = cfg.fields.find(f => f.isTitle);
  return tf ? tf.key : 'title';
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

// ── [v6.1.1] Complete Project Flow ─────────────────────────────── //

async function _completeProjectFlow(project, onActionBarRefresh) {
  // onActionBarRefresh: optional callback to re-render the action bar
  // (passed from the toggleBtn click handler which has _buildTab1ActionBar in closure)
  // [v6.1.5 B34]: Dialog shown FIRST — entity saved AFTER user confirms (not before)
  if (!project?.id) return;
  const account = getAccount();

  const dialog = document.createElement('div');
  dialog.style.cssText = 'position:fixed;inset:0;z-index:900;background:rgba(15,23,42,0.5);display:flex;align-items:center;justify-content:center;padding:20px;';
  const pName = String(project.name || project.title || 'Project').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  dialog.innerHTML = `<div style="background:var(--color-bg);border-radius:var(--radius-lg);max-width:460px;width:100%;padding:28px;box-shadow:var(--shadow-2xl);font-family:var(--font-body);">
    <div style="font-size:1.6rem;margin-bottom:12px;">🎉</div>
    <div style="font-size:var(--text-lg);font-weight:var(--weight-bold);margin-bottom:8px;">Project Completed!</div>
    <div style="font-size:var(--text-sm);color:var(--color-text-muted);margin-bottom:20px;line-height:1.6;">
      <strong>${pName}</strong> has been marked complete. Would you like to start a new cycle?
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;">
      <button id="cpf-no" style="padding:8px 18px;border-radius:var(--radius-md);border:1px solid var(--color-border);background:var(--color-surface);color:var(--color-text);cursor:pointer;font-size:var(--text-sm);">No, just complete</button>
      <button id="cpf-yes" style="padding:8px 18px;border-radius:var(--radius-md);border:none;background:var(--color-accent);color:#fff;cursor:pointer;font-size:var(--text-sm);font-weight:600;">✨ Yes, create new cycle</button>
    </div>
  </div>`;
  document.body.appendChild(dialog);

  const choice = await new Promise(resolve => {
    dialog.querySelector('#cpf-no').addEventListener('click',  () => { dialog.remove(); resolve(false); });
    dialog.querySelector('#cpf-yes').addEventListener('click', () => { dialog.remove(); resolve(true); });
  });

  const completedProj = { ...project, status: 'Completed' };
  try {
    await saveEntity(completedProj, account?.id);
  } catch (err) {
    console.error('[entity-form] complete save failed:', err);
    toast.error('Could not complete project');
    return;
  }

  if (!choice) {
    // Just mark complete — keep form open so toggle refreshes to "Set Active"
    toast.success('Project completed ✓');
    _editEntity = { ..._editEntity, status: 'Completed' };
    _draft.status = 'Completed';
    const statusSelect2 = document.querySelector('#ef-field-status');
    if (statusSelect2) statusSelect2.value = 'Completed';
    // Use the callback (passed from the closure that has _buildTab1ActionBar)
    if (typeof onActionBarRefresh === 'function') onActionBarRefresh();
    return;
  }
  await _duplicateProjectCycle(project, account);
}

async function _duplicateProjectCycle(origProj, account) {
  // ── Count same-base-title siblings ──────────────────────────
  const allProjects = (await getEntitiesByType('project')).filter(p => !p.deleted);
  const baseTitle   = String(origProj.name || origProj.title || 'Project').replace(/\s+\d+$/, '').trim();
  const siblings    = allProjects.filter(p => {
    const b = String(p.name || p.title || '').replace(/\s+\d+$/, '').trim();
    return b.toLowerCase() === baseTitle.toLowerCase();
  });
  const newTitle = `${baseTitle} ${siblings.length + 1}`;

  // ── Duplicate project ────────────────────────────────────────
  const dupProj = { ...origProj };
  delete dupProj.id; delete dupProj.createdAt; delete dupProj.updatedAt;
  dupProj.name = newTitle; dupProj.title = newTitle;
  dupProj.status = 'Not Started'; dupProj.deadline = null;
  dupProj.createdBy = account?.id;
  dupProj._lastProgressSnapshot = null; dupProj._lastProgressSnapshotAt = null;
  const savedDup = await saveEntity(dupProj, account?.id);

  // ── Get original tasks via both project field and edge ───────
  const allTasks   = (await getEntitiesByType('task')).filter(t => !t.deleted);
  const origEdges  = await import('../core/db.js').then(m => m.getEdgesTo(origProj.id, 'project')).catch(() => []);
  const origEdgeIds = new Set(origEdges.map(e => e.fromId));
  const origTasks  = allTasks.filter(t => t.project === origProj.id || origEdgeIds.has(t.id));

  // ── Compute date offsets from original earliest task ─────────
  const origDates    = origTasks.map(t => t.dueDate).filter(Boolean).sort();
  const origEarliest = origDates[0] || null;
  const origEarliestMs = origEarliest ? new Date(origEarliest + 'T00:00:00').getTime() : Date.now();

  const today = new Date(); today.setHours(0,0,0,0);
  const newAnchor = new Date(today); newAnchor.setDate(newAnchor.getDate() + 3);
  const _fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

  const newTaskDates = [];
  for (const origTask of origTasks) {
    const dayOffset = origTask.dueDate
      ? Math.round((new Date(origTask.dueDate + 'T00:00:00').getTime() - origEarliestMs) / 86400000)
      : 0;
    const newDue = new Date(newAnchor); newDue.setDate(newDue.getDate() + dayOffset);
    const newDueStr = _fmt(newDue);
    newTaskDates.push(newDueStr);

    const dupTask = { ...origTask };
    delete dupTask.id; delete dupTask.createdAt; delete dupTask.updatedAt;
    dupTask.project = savedDup.id; dupTask.dueDate = newDueStr;
    dupTask.status = 'Not Started'; dupTask.completedAt = null;
    dupTask.createdBy = account?.id;
    const savedTask = await saveEntity(dupTask, account?.id);
    await import('../core/db.js').then(m => m.saveEdge({
      fromId: savedTask.id, fromType: 'task', toId: savedDup.id, toType: 'project', relation: 'project',
    }, account?.id)).catch(() => {});
  }

  // ── Set deadline to latest task date ─────────────────────────
  const latestDate = newTaskDates.filter(Boolean).sort().pop() || null;
  if (latestDate) {
    await saveEntity({ ...savedDup, deadline: latestDate }, account?.id).catch(() => {});
  }

  // ── Copy reminders ────────────────────────────────────────────
  const origReminders = (await getEntitiesByType('reminder')).filter(r =>
    !r.deleted && r.targetEntityId === origProj.id);
  for (const r of origReminders) {
    const dupRem = { ...r };
    delete dupRem.id; delete dupRem.createdAt; delete dupRem.updatedAt;
    dupRem.targetEntityId = savedDup.id; dupRem.status = 'active';
    dupRem.fireCount = 0; dupRem.lastFiredAt = null;
    dupRem.dismissedAt = null; dupRem.snoozeUntil = null;
    await saveEntity(dupRem, account?.id).catch(() => {});
  }

  // ── Link all same-title projects as connections ───────────────
  for (const sib of siblings) {
    await import('../core/db.js').then(async m => {
      await m.saveEdge({ fromId:savedDup.id, fromType:'project', toId:sib.id, toType:'project', relation:'related to' }, account?.id).catch(() => {});
      await m.saveEdge({ fromId:sib.id, fromType:'project', toId:savedDup.id, toType:'project', relation:'related to' }, account?.id).catch(() => {});
    }).catch(() => {});
  }

  toast.success(`✨ Created "${newTitle}" — ${origTasks.length} tasks copied`);
  closeForm();
}

// ── [v6.1.3] Convert Project → Template ─────────────────────── //
/**
 * Converts the current project into a reusable user template.
 *
 * Assumptions:
 *   1. ALL non-deleted tasks (including Done) are included — captures full process.
 *   2. daysOffset = Math.round((task.dueDate − deadlineAnchor) / 1 day).
 *      Deadline anchor = project.deadline if set, else latest task dueDate.
 *      Tasks without dueDate get daysOffset = 0.
 *   3. Done tasks shown with ✓ indicator in preview to distinguish from open.
 *   4. Template stored in fh_project_templates_v1 (same as template library).
 *   5. Uses top-level getEdgesTo (already imported) — no redundant dynamic import.
 *   6. Duplicate name → overwrite or save-as-copy.
 *   7. After save → navigates to Projects → Templates tab.
 */
async function _convertProjectToTemplate(project) {
  // ── 1. Load ALL non-deleted tasks for this project ──────────
  const allTasks = (await getEntitiesByType('task')).filter(t => !t.deleted);
  const edgesIn  = await getEdgesTo(project.id, 'project').catch(() => []);
  const edgeIds  = new Set(edgesIn.map(e => e.fromId));

  const projTasks = allTasks.filter(t =>
    t.project === project.id || edgeIds.has(t.id)
  ); // ALL tasks — including Done — to capture the full process

  const doneTasks = projTasks.filter(t => _isTplTaskDone(t));

  // ── 2. Compute deadline anchor ───────────────────────────────
  const today = new Date(); today.setHours(0,0,0,0);
  let deadlineAnchor;
  if (project.deadline) {
    deadlineAnchor = new Date(project.deadline + 'T00:00:00');
  } else {
    const dates = projTasks.map(t => t.dueDate).filter(Boolean).sort();
    deadlineAnchor = dates.length > 0
      ? new Date(dates[dates.length - 1] + 'T00:00:00')
      : today;
  }

  // ── 3. Build template tasks (all tasks, daysOffset relative to deadline) ──
  const templateTasks = projTasks
    .slice()
    .sort((a, b) => {
      const da = a.dueDate || '9999-12-31';
      const db = b.dueDate || '9999-12-31';
      return da.localeCompare(db) || (a.title || '').localeCompare(b.title || '');
    })
    .map((t, idx) => {
      let daysOffset = 0;
      if (t.dueDate) {
        const taskDate = new Date(t.dueDate + 'T00:00:00');
        daysOffset = Math.round((taskDate - deadlineAnchor) / 86400000);
      }
      return {
        title:     t.title || t.name || 'Task',
        priority:  t.priority || 'Medium',
        daysOffset,
        order:     idx,
        wasDone:   _isTplTaskDone(t), // metadata for preview display only
      };
    });

  // ── 4. Load existing user templates ─────────────────────────
  const TKEY = 'fh_project_templates_v1';
  let userTemplates = [];
  try {
    const raw = await getSetting(TKEY);
    userTemplates = raw ? JSON.parse(raw) : [];
  } catch { userTemplates = []; }

  // ── 5. Show preview dialog ───────────────────────────────────
  const projName      = project.name || project.title || 'Project';
  const suggestedName = projName;

  const dialog = document.createElement('div');
  dialog.style.cssText = 'position:fixed;inset:0;z-index:950;background:rgba(15,23,42,0.5);display:flex;align-items:center;justify-content:center;padding:20px;';

  const PRIO_C = { Critical:'#dc2626', High:'#f97316', Medium:'#f59e0b', Low:'#6b7280' };

  dialog.innerHTML = `
    <div style="background:var(--color-bg);border-radius:var(--radius-lg);max-width:540px;width:100%;
      max-height:88vh;display:flex;flex-direction:column;box-shadow:var(--shadow-2xl);font-family:var(--font-body);overflow:hidden;">

      <!-- Header -->
      <div style="padding:18px 22px 14px;border-bottom:1px solid var(--color-border);flex-shrink:0;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
          <span style="font-size:1.4rem;">📋</span>
          <span style="font-size:var(--text-lg);font-weight:var(--weight-bold);">Save as Template</span>
        </div>
        <div style="font-size:var(--text-xs);color:var(--color-text-muted);line-height:1.5;">
          Captures the full task structure of <strong>${_escEF(projName)}</strong> —
          all tasks including completed ones. Due dates become relative offsets from the project deadline.
        </div>
      </div>

      <!-- Body -->
      <div style="flex:1;overflow-y:auto;padding:18px 22px;">

        <!-- Template name -->
        <div style="margin-bottom:16px;">
          <label style="font-size:var(--text-xs);font-weight:700;letter-spacing:0.06em;text-transform:uppercase;
            color:var(--color-text-muted);display:block;margin-bottom:6px;">Template Name</label>
          <input id="tpl-name-inp" type="text" value="${_escEF(suggestedName)}"
            style="width:100%;padding:8px 12px;border-radius:var(--radius-md);border:1.5px solid var(--color-border);
              background:var(--color-bg);color:var(--color-text);font-size:var(--text-sm);
              font-family:var(--font-body);box-sizing:border-box;"
            placeholder="Template name…">
        </div>

        <!-- Stats row -->
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:16px;">
          <div style="padding:10px 12px;background:var(--color-surface);border-radius:var(--radius-md);
            border:1px solid var(--color-border);text-align:center;">
            <div style="font-size:1.4rem;font-weight:var(--weight-bold);color:var(--color-accent);">${templateTasks.length}</div>
            <div style="font-size:10px;color:var(--color-text-muted);">Total Tasks</div>
          </div>
          <div style="padding:10px 12px;background:var(--color-surface);border-radius:var(--radius-md);
            border:1px solid var(--color-border);text-align:center;">
            <div style="font-size:1.4rem;font-weight:var(--weight-bold);color:var(--color-success-text,#15803d);">${doneTasks.length}</div>
            <div style="font-size:10px;color:var(--color-text-muted);">Done Tasks</div>
          </div>
          <div style="padding:10px 12px;background:var(--color-surface);border-radius:var(--radius-md);
            border:1px solid var(--color-border);text-align:center;">
            <div style="font-size:1.2rem;font-weight:var(--weight-bold);color:var(--color-text);">
              ${project.deadline ? project.deadline.slice(5) : '—'}
            </div>
            <div style="font-size:10px;color:var(--color-text-muted);">Deadline anchor</div>
          </div>
        </div>

        <!-- Task preview -->
        <div style="font-size:var(--text-xs);font-weight:700;letter-spacing:0.06em;text-transform:uppercase;
          color:var(--color-text-muted);margin-bottom:8px;">
          Task Preview
          <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--color-text-muted);margin-left:6px;">
            (✓ = was Done)
          </span>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;max-height:240px;overflow-y:auto;
          border:1px solid var(--color-border);border-radius:var(--radius-md);padding:8px;">
          ${templateTasks.length === 0
            ? '<div style="text-align:center;padding:16px;color:var(--color-text-muted);font-size:var(--text-sm);">No tasks in this project</div>'
            : templateTasks.map(t => {
                const offsetLabel = t.daysOffset === 0 ? 'on deadline'
                  : t.daysOffset < 0 ? `${Math.abs(t.daysOffset)}d before`
                  : `${t.daysOffset}d after`;
                const doneBadge = t.wasDone
                  ? '<span style="font-size:9px;padding:1px 5px;border-radius:9px;background:#dcfce7;color:#15803d;flex-shrink:0;">✓ Done</span>'
                  : '';
                return `<div style="display:flex;align-items:center;gap:8px;padding:5px 8px;
                  background:${t.wasDone ? 'var(--color-surface)' : 'var(--color-bg)'};
                  border-radius:var(--radius-sm);opacity:${t.wasDone ? 0.75 : 1};">
                  <span style="width:7px;height:7px;border-radius:50%;background:${PRIO_C[t.priority]||'#94a3b8'};flex-shrink:0;"></span>
                  <span style="flex:1;font-size:var(--text-xs);color:var(--color-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_escEF(t.title)}</span>
                  ${doneBadge}
                  <span style="font-size:10px;color:var(--color-text-muted);white-space:nowrap;flex-shrink:0;">${offsetLabel}</span>
                </div>`;
              }).join('')
          }
        </div>

      </div>

      <!-- Footer -->
      <div style="padding:14px 22px;border-top:1px solid var(--color-border);display:flex;gap:10px;justify-content:flex-end;flex-shrink:0;">
        <button id="tpl-cancel" style="padding:7px 16px;border-radius:var(--radius-md);border:1px solid var(--color-border);
          background:var(--color-surface);color:var(--color-text);cursor:pointer;font-size:var(--text-sm);">Cancel</button>
        <button id="tpl-save" style="padding:7px 18px;border-radius:var(--radius-md);border:none;
          background:var(--color-accent);color:#fff;cursor:pointer;font-size:var(--text-sm);font-weight:600;">
          💾 Save Template
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(dialog);
  const nameInp = dialog.querySelector('#tpl-name-inp');
  nameInp.focus(); nameInp.select();

  await new Promise(resolve => {
    dialog.querySelector('#tpl-cancel').addEventListener('click', () => { dialog.remove(); resolve(); });
    dialog.addEventListener('click', e => { if (e.target === dialog) { dialog.remove(); resolve(); } });

    dialog.querySelector('#tpl-save').addEventListener('click', async () => {
      const name = nameInp.value.trim();
      if (!name) { nameInp.style.borderColor = 'var(--color-danger)'; nameInp.focus(); return; }

      // Strip wasDone metadata — not part of template spec
      const saveTasks = templateTasks.map(({ wasDone: _, ...rest }) => rest);

      const dupIdx = userTemplates.findIndex(t => t.name.trim().toLowerCase() === name.toLowerCase());
      if (dupIdx >= 0) {
        const overwrite = confirm(`A template named "${name}" already exists.\n\nOK = overwrite it\nCancel = save as new copy`);
        if (overwrite) {
          userTemplates[dupIdx] = {
            ...userTemplates[dupIdx],
            name,
            goal:           project.goal || '',
            completionMode: project.completionMode || 'Parallel',
            tasks:          saveTasks,
          };
        } else {
          userTemplates.push({
            id:             _tplUid(),
            name:           name + ' (copy)',
            goal:           project.goal || '',
            completionMode: project.completionMode || 'Parallel',
            tasks:          saveTasks,
          });
        }
      } else {
        userTemplates.push({
          id:             _tplUid(),
          name,
          goal:           project.goal || '',
          completionMode: project.completionMode || 'Parallel',
          tasks:          saveTasks,
        });
      }

      try {
        await setSetting(TKEY, JSON.stringify(userTemplates));
        dialog.remove();
        toast.success(`📋 Template "${name}" saved! (${saveTasks.length} tasks)`);
        try {
          const { navigate } = await import('../core/router.js');
          await navigate('projects', { _tab: 'templates' });
        } catch { /* non-fatal */ }
        resolve();
      } catch (err) {
        console.error('[entity-form] save template:', err);
        toast.error('Could not save template');
      }
    });
  });
}

/** Check if a task is done (for template preview badge — not for filtering) */
function _isTplTaskDone(t) {
  const s = (t?.status || '').toLowerCase();
  return s === 'done' || s === 'completed' || s === 'complete';
}


function _tplUid() {
  return 'tpl-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function _escEF(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
