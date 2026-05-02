/**
 * FamilyHub v2.0 — components/entity-form.js
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
         convertEntity }                                       from '../core/graph-engine.js';
import { emit, EVENTS }                                        from '../core/events.js';
import { toast }                                               from '../core/toast.js';
import { getAccount }                                          from '../core/auth.js';
import { getActiveContext, ALWAYS_SHARED_TYPES }               from '../core/context.js';

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
    _draft.context = activeCtx === 'all' ? 'family' : activeCtx;
  }

  _relationValues.clear();
  _tagValues.clear();

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
  for (const entity of vals) {
    const chip = document.createElement('span');
    chip.className = 'ef-relation-chip';
    chip.textContent = entity.title || entity.name || entity.label || entity.id;
    chip.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:2px 8px;background:var(--color-accent);color:#fff;border-radius:99px;font-size:var(--text-xs);font-weight:var(--weight-semibold);';
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.textContent = '×';
    rm.style.cssText = 'background:none;border:none;color:inherit;cursor:pointer;padding:0 0 0 4px;font-size:1em;line-height:1;';
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
 * @param {object}   entity
 * @param {Function} [onSave]
 */
export function openEditForm(entity, onSave = null) {
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
  }, 200);
}

// ════════════════════════════════════════════════════════════
// BUILD & MOUNT
// ════════════════════════════════════════════════════════════

function _buildAndMount(config) {
  // Remove any existing form
  document.querySelector('.ef-overlay')?.remove();

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
  for (const t of allTypes) {
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
    _rebuildBody(newConfig, body);
    _updateHeader(header, newConfig, typeSelect);
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
  title.style.cssText = 'font-family:var(--font-heading,Georgia,serif);font-size:1.3125rem;font-weight:700;color:var(--color-text);margin:0;line-height:1.3;';
  title.textContent = _editEntity ? `Edit ${config.label}` : `New ${config.label}`;
  titleRow.appendChild(title);
  header.appendChild(titleRow);

  // ── Tab strip (edit mode only) ───────────────────────── //
  let tabStrip = null;
  let tab1Body = null;
  let tab2Body = null;
  let tab3Body = null;

  if (_editEntity) {
    tabStrip = document.createElement('div');
    tabStrip.style.cssText = [
      'display: flex; gap: 2px; padding: 0 16px;',
      'border-bottom: 1px solid var(--color-border);',
      'background: var(--color-surface); flex-shrink: 0;',
    ].join(' ');

    const _mkTab = (key, label, icon) => {
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
      return btn;
    };

    const tab1Btn = _mkTab('fields',    'Fields',           '⊞');
    const tab2Btn = _mkTab('details',   'Details',          '◷');
    const tab3Btn = _mkTab('relations', 'Relations',        '⌥');

    const _applyTabStyles = () => {
      [tab1Btn, tab2Btn, tab3Btn].forEach(b => {
        const active = b.dataset.tabKey === _activeFormTab;
        b.style.color = active ? 'var(--color-accent)' : 'var(--color-text-muted)';
        b.style.borderBottomColor = active ? 'var(--color-accent)' : 'transparent';
        b.style.fontWeight = active ? '600' : '400';
      });
    };

    const _switchTab = (key) => {
      _activeFormTab = key;
      _applyTabStyles();
      if (tab1Body) tab1Body.style.display = key === 'fields'    ? 'flex' : 'none';
      if (tab2Body) tab2Body.style.display = key === 'details'   ? 'flex' : 'none';
      if (tab3Body) tab3Body.style.display = key === 'relations' ? 'flex' : 'none';
      // Hide footer (Save button) on Details and Relations tabs
      const footerEl = modal.querySelector('.modal-footer');
      if (footerEl) footerEl.style.display = (key === 'details' || key === 'relations') ? 'none' : '';
      // Lazy-load Tab 2 on first open
      if (key === 'details' && tab2Body) {
        // Always rebuild Tab 2 on open — config may have changed (e.g. after Convert)
        // and _editEntity may have been updated by status toggle or archive actions.
        tab2Body.dataset.loaded = '1';
        const freshConfig = _editEntity ? getEntityTypeConfig(_editEntity.type) : config;
        _buildDetailsTab(tab2Body, freshConfig || config);
      }
      // Lazy-load Tab 3 on first open
      if (key === 'relations' && tab3Body && !tab3Body.dataset.loaded) {
        tab3Body.dataset.loaded = '1';
        _buildRelationsTab(tab3Body);
      }
    };

    tab1Btn.addEventListener('click', () => _switchTab('fields'));
    tab2Btn.addEventListener('click', () => _switchTab('details'));
    tab3Btn.addEventListener('click', () => _switchTab('relations'));

    tabStrip.appendChild(tab1Btn);
    tabStrip.appendChild(tab2Btn);
    tabStrip.appendChild(tab3Btn);
    _applyTabStyles();
  }

  // ── Body ─────────────────────────────────────────────── //
  const body = document.createElement('div');
  // In edit mode, tabs handle their own padding/scrolling.
  // Remove the .modal-body CSS padding to avoid double-padding the tab contents.
  body.className = _editEntity ? 'ef-body' : 'modal-body ef-body';
  if (_editEntity) {
    body.style.cssText = 'display:flex;flex-direction:column;flex:1;overflow:hidden;padding:0;';
  }

  if (_editEntity) {
    // Tab 1: Fields (existing form body)
    tab1Body = document.createElement('div');
    tab1Body.style.cssText = 'display: flex; flex-direction: column; flex: 1; min-height: 0; padding: 0; gap: 0;';

    // ── Tab 1 action bar: status toggle + open graph ────────
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

      // ── Status toggle: In Progress <> Complete (tasks only) ──
      if (_editEntity.type === 'task') {
        const isDone = _editEntity.status === 'Done';
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
        statusBtn.title = isDone ? 'Switch back to In Progress' : 'Mark as Done';
        statusBtn.addEventListener('click', async () => {
          try {
            const newStatus = isDone ? 'In Progress' : 'Done';
            const updated = { ..._editEntity, status: newStatus };
            const saved = await saveEntity(updated, getAccount()?.id);
            _editEntity = saved;
            // Sync draft AND the live SELECT element so _saveDraftFromForm
            // doesn't revert the status when the user later hits Save.
            _draft.status = newStatus;
            const statusSelect = _overlay?.querySelector('#ef-field-status');
            if (statusSelect) statusSelect.value = newStatus;
            emit(EVENTS.ENTITY_SAVED, { entity: saved, isNew: false });
            toast.success(newStatus === 'Done' ? 'Marked complete ✓' : 'Marked in progress');
            _buildTab1ActionBar();
          } catch (err) {
            console.error('[entity-form] status toggle failed:', err);
            toast.error('Could not update status');
          }
        });
        actionBar.appendChild(statusBtn);
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
        graphBtn.innerHTML = '<span>◎</span><span>Graph</span>';
        graphBtn.title = 'Open in Knowledge Graph';
        graphBtn.addEventListener('click', async () => {
          const eid = _editEntity?.id;
          if (!eid) return;
          closeForm();
          // Open panel then trigger graph view
          try {
            const { openPanel } = await import('./entity-panel.js');
            await openPanel(eid);
            // Wait for panel graph button to exist (retries for up to 1s to handle slow IDB)
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
            console.warn('[entity-form] graph open failed:', err);
          }
        });
        actionBar.appendChild(graphBtn);
      }

      // Only insert if at least one button was added
      if (actionBar.children.length > 0) {
        tab1Body.insertBefore(actionBar, tab1Body.firstChild);
      }
      _tab1BarBuilding = false;
    };

    // Fields scroll container (padded, scrollable)
    const fieldsScroll = document.createElement('div');
    fieldsScroll.style.cssText = 'flex: 1; overflow-y: auto; padding: var(--space-4) var(--space-5);';
    _rebuildBodyInto(config, fieldsScroll);
    tab1Body.appendChild(fieldsScroll);

    _buildTab1ActionBar();
    body.appendChild(tab1Body);

    // Tab 2: Details & Activity (lazy — built on first click)
    tab2Body = document.createElement('div');
    tab2Body.style.cssText = 'display: none; flex-direction: column; flex: 1; min-height: 0; padding: 0;';
    body.appendChild(tab2Body);

    // Tab 3: Relations (lazy — built on first click)
    tab3Body = document.createElement('div');
    tab3Body.style.cssText = 'display: none; flex-direction: column; flex: 1; min-height: 0; padding: 0;';
    body.appendChild(tab3Body);

    // Apply initial visibility
    tab1Body.style.display = _activeFormTab === 'fields'    ? 'flex' : 'none';
    tab2Body.style.display = _activeFormTab === 'details'   ? 'flex' : 'none';
    tab3Body.style.display = _activeFormTab === 'relations' ? 'flex' : 'none';
  } else {
    // Create mode — no tabs, just the form body.
    // .modal-body CSS class provides padding; no inline override needed.
    _rebuildBodyInto(config, body);
  }

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
      .qcm-overlay{position:fixed;inset:0;background:rgba(0,0,0,.38);z-index:500;
        display:flex;align-items:center;justify-content:center;}
      .qcm-modal{background:var(--color-bg);border:1px solid var(--color-border);
        border-radius:var(--radius-xl);width:min(400px,95vw);padding:var(--space-5);
        box-shadow:0 24px 64px rgba(0,0,0,.2);}
      .qcm-header{display:flex;align-items:center;gap:var(--space-2);
        margin-bottom:var(--space-4);font-size:var(--text-lg);font-weight:var(--weight-bold);}
      .qcm-field{margin-bottom:var(--space-3);}
      .qcm-label{display:block;font-size:var(--text-sm);font-weight:var(--weight-semibold);
        margin-bottom:4px;color:var(--color-text);}
      .qcm-input{width:100%;padding:8px 10px;border:1.5px solid var(--color-border);
        border-radius:var(--radius-md);background:var(--color-surface);
        color:var(--color-text);font-size:var(--text-sm);font-family:inherit;box-sizing:border-box;}
      .qcm-input:focus{outline:none;border-color:var(--color-accent);}
      .qcm-footer{display:flex;justify-content:flex-end;gap:var(--space-2);
        padding-top:var(--space-4);border-top:1px solid var(--color-border);margin-top:var(--space-4);}
      .qcm-cancel{padding:6px 14px;border:1px solid var(--color-border);
        border-radius:var(--radius-md);background:none;cursor:pointer;color:var(--color-text-muted);}
      .qcm-save{padding:6px 18px;background:var(--color-accent);color:#fff;border:none;
        border-radius:var(--radius-md);font-weight:var(--weight-semibold);cursor:pointer;}
      .qcm-save:disabled{opacity:.5;cursor:default;}
    `;
    document.head.appendChild(s);
  }

  // Focus the title field
  setTimeout(() => {
    const titleInput = modal.querySelector('.ef-title-field');
    titleInput?.focus();
  }, 60);
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
  const fields = config.fields;
  for (const field of fields) {
    const group = _buildFieldGroup(field, config);
    if (group) container.appendChild(group);
  }
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

      // Only save dueTime when dueDate is also set — prevents disappearing from calendar
      input.addEventListener('change', () => {
        const dateKey = field.key === 'dueTime' ? 'dueDate' : null;
        if (dateKey && !_draft[dateKey]) {
          // No date set — don't persist time, show hint
          hintEl.textContent = '⚠ Set a Due Date first';
          hintEl.style.color = 'var(--color-warning-text)';
          input.value = existing || '06:00';
          return;
        }
        _draft[field.key] = input.value || '06:00';
        hintEl.textContent = field.helpText || '10-min steps';
        hintEl.style.color = 'var(--color-text-muted)';
      });
      // Init draft only if dueDate exists
      if (!existing && _draft.dueDate) _draft[field.key] = '06:00';
      else if (!existing) _draft[field.key] = null; // no date = no time

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

      // CS-05: Emoji labels for context field
      const CTX_EMOJI = { family: '🏠 Family', personal: '👤 Personal', business: '💼 Business', all: '🌐 All' };

      for (const opt of (field.options || [])) {
        const o = document.createElement('option');
        o.value       = opt;
        o.textContent = (field.key === 'context' && CTX_EMOJI[opt]) ? CTX_EMOJI[opt] : opt;
        if (opt === existing) o.selected = true;
        select.appendChild(o);
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

  // ── Search input ─────────────────────────────────────── //
  const searchInput = document.createElement('input');
  searchInput.type        = 'text';
  searchInput.className   = 'input';
  searchInput.placeholder = 'Search or add tags…';
  searchInput.autocomplete = 'off';
  wrap.appendChild(searchInput);

  // ── Dropdown results ─────────────────────────────────── //
  const results = document.createElement('div');
  results.style.cssText = [
    'max-height: 140px; overflow-y: auto;',
    'border: 1px solid var(--color-border); border-top: none;',
    'border-radius: 0 0 var(--radius-sm) var(--radius-sm);',
    'display: none; background: var(--color-bg);',
  ].join(' ');
  wrap.appendChild(results);

  // ── "+ Create" button ─────────────────────────────────── //
  const createBtn = document.createElement('button');
  createBtn.type = 'button';
  createBtn.className = 'ef-relation-create-btn';
  createBtn.style.display = 'none';
  wrap.appendChild(createBtn);

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
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.style.cssText = 'display: inline-flex; align-items: center; gap: 4px;';
      chip.title = 'Click label to open tag · × to remove';

      // Clickable label — looks up tag entity by name and opens panel
      const labelEl = document.createElement('span');
      labelEl.textContent = tagName;
      labelEl.style.cursor = 'pointer';
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
      rm.style.cssText = 'cursor: pointer; font-weight: bold; color: var(--color-text-muted); margin-left: 2px;';
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
  // Collect required/title fields for QCM form inputs.
  // If none are marked required, fall back to the first field so the form isn't empty.
  const required = (() => {
    const r = (config.fields||[]).filter(f => f.isTitle || f.required);
    return r.length ? r : (config.fields||[]).slice(0, 1);
  })();

  const overlay = document.createElement('div');
  overlay.className = 'qcm-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `
    <div class="qcm-modal">
      <div class="qcm-header">
        <span class="qcm-icon">${_esc(config.icon||'\u25C7')}</span>
        <span class="qcm-title">New ${_esc(config.label)}</span>
      </div>
      <div class="qcm-body" id="qcm-body-inner"></div>
      <div class="qcm-footer">
        <button class="qcm-cancel" id="qcm-cancel">Cancel</button>
        <button class="qcm-save" id="qcm-save">Create →</button>
      </div>
    </div>
  `;

  const body = overlay.querySelector('#qcm-body-inner');
  const fieldEls = {};
  for (const f of required) {
    const wrap  = document.createElement('div'); wrap.className = 'qcm-field';
    const lbl   = document.createElement('label'); lbl.className = 'qcm-label';
    lbl.textContent = f.label || f.key;
    const input = document.createElement('input');
    input.type = 'text'; input.className = 'qcm-input';
    input.value = prefill[f.key] || '';
    fieldEls[f.key] = input;
    wrap.appendChild(lbl); wrap.appendChild(input); body.appendChild(wrap);
  }

  const _closeQCM = () => {
    document.removeEventListener('keydown', _kd);
    overlay.remove();
  };
  const _kd = e => { if (e.key === 'Escape') _closeQCM(); };
  document.addEventListener('keydown', _kd);
  overlay.querySelector('#qcm-cancel').addEventListener('click', _closeQCM);
  overlay.addEventListener('click', e => { if (e.target === overlay) _closeQCM(); });

  overlay.querySelector('#qcm-save').addEventListener('click', async () => {
    const sb = overlay.querySelector('#qcm-save');
    sb.disabled = true; sb.textContent = 'Creating…';
    try {
      const data = { type: typeKey };
      for (const [key, el] of Object.entries(fieldEls)) data[key] = el.value.trim();
      const titleField = required.find(f => f.isTitle);
      if (titleField && !data[titleField.key]) {
        toast.error(`${config.label} name is required`);
        sb.disabled = false; sb.textContent = 'Create →'; return;
      }
      const acct = getAccount();
      const saved = await saveEntity(data, acct?.id);
      _closeQCM();
      if (onCreated) onCreated(saved);
    } catch (err) {
      console.error('[qcm] save failed:', err);
      toast.error('Create failed — see console');
      sb.disabled = false; sb.textContent = 'Create →';
    }
  });

  document.body.appendChild(overlay);
  setTimeout(() => overlay.querySelector('.qcm-input')?.focus(), 30);
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
    if (!edges.length) return;
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
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.style.cssText = 'display:inline-flex;align-items:center;gap:4px;';
    chip.dataset.id = entity.id;
    const label = document.createElement('span');
    label.textContent = entity.label || entity.id;
    chip.appendChild(label);
    const rm = document.createElement('span');
    rm.textContent = '×';
    rm.style.cssText = 'cursor:pointer;font-weight:bold;color:var(--color-text-muted);margin-left:2px;';
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

  const searchInput = document.createElement('input');
  searchInput.type        = 'text';
  searchInput.className   = 'input';
  searchInput.placeholder = `Search ${field.relatesTo || 'entities'}…`;
  searchInput.autocomplete = 'off';
  wrap.appendChild(searchInput);

  const results = document.createElement('div');
  results.style.cssText = `
    max-height: 140px; overflow-y: auto; border: 1px solid var(--color-border);
    border-top: none; border-radius: 0 0 var(--radius-sm) var(--radius-sm);
    display: none; background: var(--color-bg);
  `;
  wrap.appendChild(results);

  // + Create new entity button (shown when search has text but no results)
  const createBtn = document.createElement('button');
  createBtn.type = 'button';
  createBtn.className = 'ef-relation-create-btn';
  createBtn.style.display = 'none';
  wrap.appendChild(createBtn);
  createBtn.addEventListener('click', () => {
    openQuickCreateModal(typeToSearch, { title: searchInput.value.trim() }, newEntity => {
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
// RELATIONS TAB (Tab 3 — edit mode only)
// Self-contained port of panel _renderRelationsTab.
// Operates on _editEntity (the saved entity being edited).
// ════════════════════════════════════════════════════════════

async function _buildRelationsTab(container) {
  if (!_editEntity) return;

  const entity = _editEntity;
  container.innerHTML = '<div style="padding:16px;font-size:var(--text-xs);color:var(--color-text-muted);">Loading…</div>';

  // ── Helpers ───────────────────────────────────────────── //
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

  container.innerHTML = '';

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
  const presets = ['related to', 'part of', 'blocked by', 'assigned to', 'daily review', 'belongs to', 'see also'];
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

  // Load all entities
  let _allEntities = [];
  try {
    const allTypes = getAllEntityTypes();
    const buckets = await Promise.all(allTypes.map(t => getEntitiesByType(t.key).catch(() => [])));
    _allEntities = buckets.flat()
      .filter(e => !e.deleted && e.id !== entity.id)
      .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));
  } catch (err) {
    console.warn('[entity-form] relations: load all failed', err);
  }

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
    const results = candidates.slice(0, 30);

    if (results.length === 0) {
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
          typeSelect.className = 'input';
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
            openQuickCreateModal(chosenType, { title: q }, async newEnt => {
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

    for (const ent of results) {
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
      items.push({ edge, linked, direction: 'out', sortKey: linked.updatedAt || linked.createdAt || '' });
    }
    for (const edge of incoming) {
      const linked = await getEntity(edge.fromId).catch(() => null);
      if (!linked || linked.deleted) continue;
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
            openPanel(linked.id);
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
// DETAILS & ACTIVITY TAB (Tab 2 — edit mode only)
// ════════════════════════════════════════════════════════════

/**
 * Build the "Details & Activity" tab body.
 * Sections:
 *   1. Action toolbar  — mirrors panel header actions
 *   2. Metadata card   — created / updated timestamps + ID
 *   3. Activity log    — collapsible, reads auditLog from settings
 */
function _buildDetailsTab(container, config) {
  if (!_editEntity) return;
  container.innerHTML = '';

  const entity   = _editEntity;
  const actions  = config.actions || [];

  // ── helpers ─────────────────────────────────────────────── //
  const _fmtTs = (iso) => {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString(undefined, {
        dateStyle: 'medium', timeStyle: 'short',
      });
    } catch { return iso; }
  };
  // _fmtShort removed (unused — use _efFmtShort instead)

  // Auto-save draft then run action
  const _guardedAction = async (fn) => {
    _saveDraftFromForm();
    await fn();
  };

  // ─── 1. ACTION TOOLBAR ──────────────────────────────────── //
  const toolbar = document.createElement('div');
  toolbar.style.cssText = [
    'display: flex; align-items: center; gap: 8px; flex-wrap: wrap;',
    'padding: 14px 16px 12px;',
    'border-bottom: 1px solid var(--color-border);',
    'background: var(--color-surface);',
    'position: relative;',      // anchor for absolute-positioned dropdowns
    'overflow: visible;',       // allow dropdowns to escape container bounds
  ].join(' ');

  const _mkBtn = (icon, label, danger = false, outline = false) => {
    const btn = document.createElement('button');
    btn.style.cssText = [
      'display: inline-flex; align-items: center; gap: 6px;',
      'padding: 6px 12px; border-radius: var(--radius-md);',
      'font-size: var(--text-sm); font-family: var(--font-body);',
      'cursor: pointer; transition: all 0.12s; white-space: nowrap;',
      danger  ? 'background: var(--color-danger-bg, #fee2e2); color: var(--color-danger, #dc2626); border: 1px solid var(--color-danger, #dc2626);'
              : outline
                ? 'background: var(--color-surface); color: var(--color-text); border: 1px solid var(--color-border);'
                : 'background: var(--color-surface-2); color: var(--color-text); border: 1px solid var(--color-border);',
    ].join(' ');
    btn.innerHTML = `<span style="font-size:14px">${icon}</span><span>${label}</span>`;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.addEventListener('mouseenter', () => {
      btn.style.filter = 'brightness(0.92)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.filter = '';
    });
    return btn;
  };

  // ── Archive / Unarchive ──────────────────────────────────
  if (actions.includes('archive') || actions.includes('edit')) {
    const isArchived = entity.status === 'Archived' || entity.archived;
    const btn = _mkBtn(isArchived ? '↑' : '⊟', isArchived ? 'Unarchive' : 'Archive');
    btn.addEventListener('click', () => _guardedAction(async () => {
      let updated;
      if (_editEntity.status !== undefined) {
        updated = { ..._editEntity, status: isArchived ? 'Active' : 'Archived' };
      } else {
        updated = { ..._editEntity, archived: !isArchived };
      }
      const saved = await saveEntity(updated, getAccount()?.id);
      _editEntity = saved;
      emit(EVENTS.ENTITY_SAVED, { entity: saved, isNew: false });
      toast.success(isArchived ? 'Unarchived' : 'Archived');
      // Only rebuild tab content if details tab is currently visible
      if (_activeFormTab === 'details') {
        const freshCfg = getEntityTypeConfig(_editEntity.type) || config;
        _buildDetailsTab(container, freshCfg);
      }
    }));
    toolbar.appendChild(btn);
  }

  // ── Duplicate ────────────────────────────────────────────
  if (actions.includes('duplicate')) {
    const btn = _mkBtn('⧉', 'Duplicate');
    btn.addEventListener('click', () => _guardedAction(async () => {
      const dup = { ..._editEntity };
      delete dup.id; delete dup.createdAt; delete dup.updatedAt; delete dup.createdBy;
      const cfg2 = config;
      const titleK = cfg2.fields.find(f => f.isTitle)?.key;
      if (titleK && dup[titleK]) dup[titleK] += ' (copy)';
      const saved = await saveEntity(dup, getAccount()?.id);
      emit(EVENTS.ENTITY_SAVED, { entity: saved, isNew: true });
      toast.success('Duplicated — opening copy');
      closeForm();
      // Open panel for the duplicate
      import('./entity-panel.js').then(({ openPanel }) => openPanel(saved.id)).catch(() => {});
    }));
    toolbar.appendChild(btn);
  }

  // ── Add to Project ───────────────────────────────────────
  if (entity.type !== 'project') {
    const btn = _mkBtn('📁', 'Add to Project');
    btn.style.position = 'relative';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Toggle dropdown
      const existing = toolbar.querySelector('.ef-proj-picker');
      if (existing) { existing.remove(); return; }

      const dd = document.createElement('div');
      dd.className = 'ef-proj-picker';
      dd.style.cssText = [
        'position: absolute; top: calc(100% + 4px); left: 0; z-index: 999;',
        'background: var(--color-bg); border: 1px solid var(--color-border);',
        'border-radius: var(--radius-md); box-shadow: var(--shadow-lg);',
        'padding: 8px; min-width: 200px; max-height: 220px; overflow-y: auto;',
      ].join(' ');

      const sinput = document.createElement('input');
      sinput.type = 'text'; sinput.className = 'input';
      sinput.placeholder = 'Search projects…';
      sinput.style.cssText = 'padding:6px 8px;font-size:var(--text-sm);margin-bottom:6px;width:100%;box-sizing:border-box;';
      dd.appendChild(sinput);

      const projList = document.createElement('div');
      dd.appendChild(projList);

      const _renderProjs = async (q) => {
        projList.innerHTML = '';
        let projects = [];
        try { projects = (await getEntitiesByType('project')).filter(p => !p.deleted); } catch {}
        const filtered = projects.filter(p => !q || (p.name||'').toLowerCase().includes(q.toLowerCase()));

        const createRow = document.createElement('div');
        createRow.style.cssText = 'padding:6px 8px;cursor:pointer;font-size:var(--text-xs);font-weight:600;color:var(--color-accent);border-bottom:1px solid var(--color-border);';
        createRow.textContent = q ? `+ Create "${q}"` : '+ New project…';
        createRow.addEventListener('click', () => {
          dd.remove();
          openQuickCreateModal('project', { name: q || '' }, async np => {
            if (!np) return;
            await saveEdge({ fromId: _editEntity.id, fromType: _editEntity.type, toId: np.id, toType: 'project', relation: 'project' });
            toast.success(`Added to ${np.name || 'project'}`);
          });
        });
        projList.appendChild(createRow);

        for (const proj of filtered.slice(0, 8)) {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px;cursor:pointer;font-size:var(--text-sm);border-radius:4px;';
          row.textContent = '📁 ' + (proj.name || 'Untitled');
          row.addEventListener('mouseenter', () => row.style.background = 'var(--color-surface-2)');
          row.addEventListener('mouseleave', () => row.style.background = '');
          row.addEventListener('click', async () => {
            await saveEdge({ fromId: _editEntity.id, fromType: _editEntity.type, toId: proj.id, toType: 'project', relation: 'project' });
            dd.remove();
            toast.success(`Added to ${proj.name || 'project'}`);
          });
          projList.appendChild(row);
        }
        if (filtered.length === 0 && !q) {
          const empty = document.createElement('div');
          empty.style.cssText = 'font-size:var(--text-xs);color:var(--color-text-muted);padding:6px 8px;';
          empty.textContent = 'No projects yet';
          projList.appendChild(empty);
        }
      };

      sinput.addEventListener('input', () => _renderProjs(sinput.value));
      _renderProjs('');
      btn.appendChild(dd);
      setTimeout(() => sinput.focus(), 20);

      const closeDD = (ev) => {
        if (!dd.contains(ev.target) && ev.target !== btn) {
          dd.remove();
          document.removeEventListener('click', closeDD, true);
        }
      };
      setTimeout(() => document.addEventListener('click', closeDD, true), 10);
    });
    toolbar.appendChild(btn);
  }

  // ── Convert to… ─────────────────────────────────────────
  if (actions.includes('convert')) {
    const btn = _mkBtn('⇄', 'Convert to…');
    btn.style.position = 'relative';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const existing = toolbar.querySelector('.ef-convert-picker');
      if (existing) { existing.remove(); return; }

      const dd = document.createElement('div');
      dd.className = 'ef-convert-picker';
      dd.style.cssText = [
        'position: absolute; top: calc(100% + 4px); left: 0; z-index: 999;',
        'background: var(--color-bg); border: 1px solid var(--color-border);',
        'border-radius: var(--radius-md); box-shadow: var(--shadow-lg);',
        'padding: 8px; min-width: 180px; max-height: 260px;',
        'overflow-y: auto; display: flex; flex-wrap: wrap; gap: 6px;',
      ].join(' ');

      const types = getAllEntityTypes();
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
            import('./entity-panel.js').then(({ openPanel }) => openPanel(converted.id)).catch(() => {});
          } catch (err) {
            console.error('[entity-form] Convert failed:', err);
            toast.error('Conversion failed');
          }
        });
        dd.appendChild(row);
      }

      btn.appendChild(dd);
      const closeDD = (ev) => {
        if (!dd.contains(ev.target) && ev.target !== btn) {
          dd.remove();
          document.removeEventListener('click', closeDD, true);
        }
      };
      setTimeout(() => document.addEventListener('click', closeDD, true), 10);
    });
    toolbar.appendChild(btn);
  }

  // ── Delete ───────────────────────────────────────────────
  if (actions.includes('delete')) {
    const btn = _mkBtn('⊗', 'Delete', true);
    btn.addEventListener('click', () => _guardedAction(async () => {
      const entityTitle = _editEntity.title || _editEntity.name || config.label;
      const snapshot = { ..._editEntity };
      const confirmed = window.confirm(
        `Delete "${entityTitle}"? Press Cmd+Z immediately after to undo.`
      );
      if (!confirmed) return;
      try {
        await deleteEntity(_editEntity.id);
        // db.deleteEntity already emits ENTITY_DELETED — don't also emit ENTITY_SAVED
        toast.success(`${config.label} deleted`);
        // Push to undo stack — consistent with panel delete behaviour
        window.FH?._pushUndoDelete?.({
          snapshot,
          entityLabel: config.label,
          entityTitle,
        });
        closeForm();
      } catch (err) {
        console.error('[entity-form] Delete failed:', err);
        toast.error('Delete failed');
      }
    }));
    toolbar.appendChild(btn);
  }

  container.appendChild(toolbar);

  // ─── 2. METADATA CARD ───────────────────────────────────── //
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
  if (entity.createdBy) meta.appendChild(_metaRow('By',  entity.createdBy));

  container.appendChild(meta);

  // ─── 3. ACTIVITY LOG (collapsible) ──────────────────────── //
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
  actHeader.innerHTML = '<span>◷ Activity Log</span><span class="ef-act-chevron" style="font-size:10px;color:var(--color-text-muted)">▼</span>';

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

  // Load activity log async
  _loadEntityActivityLog(actBody, entity, config);
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
    const entries = Array.isArray(log)
      ? log.filter(e => e.entityId === entity.id).reverse().slice(0, 100)
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
        '  <div style="font-size:1.5rem;opacity:0.4">◷</div>',
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

      const icon = entry.action === 'create' ? '✨'
                 : entry.action === 'delete' ? '🗑️'
                 : entry.action === 'link'   ? '🔗'
                 : entry.action === 'unlink' ? '🔓'
                 : '✏️';

      // Use pre-resolved values
      let oldVal = entry._resolvedOld;
      let newVal = entry._resolvedNew;

      // Build description
      let desc = `${icon} `;
      if (entry.action === 'create') {
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

async function _submitForm() {
  if (!_typeKey) return;

  const config = getEntityTypeConfig(_typeKey);
  if (!config) return;

  // Sync draft from live form
  _saveDraftFromForm();

  // ── Validate required fields ──────────────────────────── //
  let valid = true;

  for (const field of config.fields) {
    const group = _overlay?.querySelector(`[data-field="${field.key}"]`);
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

  if (!valid) return;

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

    // ── Save entity ───────────────────────────────────────── //
    const account = getAccount();
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
                  relation: field.key,
                });
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
              relation: field.key,
            });
          } catch (edgeErr) {
            console.warn('[entity-form] Edge save failed:', edgeErr);
          }
        }
      }
    }

    // ── Callback & close ──────────────────────────────────── //
    // Emit ENTITY_SAVED before the callback so listeners (panel, kanban, daily)
    // update state first. The callback then has fresh data if it queries anything.
    const cb = _onSave;
    const wasNew = !_editEntity;
    const entityLabel = config?.label || 'item';
    // Emit ENTITY_SAVED FIRST so listeners (kanban, daily, panel) get fresh data,
    // then run the onSave callback, then close the form.
    // Closing last ensures any listener that checks the overlay won't see null prematurely.
    emit(EVENTS.ENTITY_SAVED, { entity: saved, isNew: wasNew });
    cb?.(saved);
    closeForm();
    toast.success(wasNew ? `${entityLabel} created` : `${entityLabel} saved`);

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
  }
}

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════

/**
 * Sync live input values into _draft (for fields not already updating on input).
 */
function _saveDraftFromForm() {
  if (!_overlay || !_typeKey) return;
  const config = getEntityTypeConfig(_typeKey);
  if (!config) return;

  for (const field of config.fields) {
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
