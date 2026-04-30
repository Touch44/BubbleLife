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

import { saveEntity, saveEdge, getEntitiesByType, getEntity } from '../core/db.js';
import { getEntityTypeConfig, getAllEntityTypes }        from '../core/graph-engine.js';
import { emit, EVENTS }                                from '../core/events.js';
import { toast }                                       from '../core/toast.js';
import { getAccount }                                  from '../core/auth.js';
import { getActiveContext, ALWAYS_SHARED_TYPES }        from '../core/context.js';

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
  modal.style.cssText = 'max-width: 560px;';

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

  // ── Body ─────────────────────────────────────────────── //
  const body = document.createElement('div');
  body.className = 'modal-body ef-body';
  _rebuildBody(config, body);

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

  const fields = config.fields;
  for (const field of fields) {
    const group = _buildFieldGroup(field, config);
    if (group) body.appendChild(group);
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
        _draft[field.key] = input.value ? new Date(input.value).toISOString() : null;
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

    // ── RELATION (search-as-you-type) ─────────────────────── //
    case 'relation': {
      // In edit mode, relations are managed from the panel's Relations tab.
      // Show a read-only info note so users know where to go.
      if (_editEntity) {
        const note = document.createElement('span');
        note.style.cssText = 'font-size:var(--text-xs);color:var(--color-text-muted);display:block;padding:var(--space-1) 0;';
        note.textContent = 'Manage links from the Relations tab in the panel';
        return note;
      }
      if (!_relationValues.has(field.key)) {
        _relationValues.set(field.key, []);
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

function _buildTagControl(field) {
  const wrap = document.createElement('div');
  wrap.className   = 'ef-tag-control';
  wrap.dataset.key = field.key;

  const _render = () => {
    wrap.innerHTML = '';
    const chipRow = document.createElement('div');
    chipRow.style.cssText = 'display: flex; flex-wrap: wrap; gap: var(--space-1); align-items: center; padding: var(--space-2); border: 1px solid var(--color-border); border-radius: var(--radius-sm); min-height: 42px; background: var(--color-bg); cursor: text;';

    const tags = _tagValues.get(field.key) || [];
    for (let i = 0; i < tags.length; i++) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.style.cssText = 'display: inline-flex; align-items: center; gap: 4px;';
      chip.innerHTML = `<span>${tags[i]}</span>`;

      const rm = document.createElement('span');
      rm.textContent = '×';
      rm.style.cssText = 'cursor: pointer; font-weight: bold; color: var(--color-text-muted); margin-left: 2px;';
      rm.addEventListener('click', () => {
        const arr = _tagValues.get(field.key) || [];
        arr.splice(i, 1);
        _tagValues.set(field.key, arr);
        _render();
      });
      chip.appendChild(rm);
      chipRow.appendChild(chip);
    }

    // Input
    const input = document.createElement('input');
    input.type        = 'text';
    input.placeholder = tags.length ? '' : `Add ${field.label.toLowerCase()}…`;
    input.style.cssText = 'border: none; outline: none; font-size: var(--text-sm); background: transparent; min-width: 80px; flex: 1; font-family: var(--font-body);';

    input.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ',') && input.value.trim()) {
        e.preventDefault();
        const val = input.value.trim().replace(/,$/, '');
        if (val) {
          const arr = _tagValues.get(field.key) || [];
          if (!arr.includes(val)) arr.push(val);
          _tagValues.set(field.key, arr);
        }
        _render();
      }
      if (e.key === 'Backspace' && !input.value) {
        const arr = _tagValues.get(field.key) || [];
        if (arr.length) { arr.pop(); _tagValues.set(field.key, arr); _render(); }
      }
    });
    input.addEventListener('blur', () => {
      const val = input.value.trim();
      if (val) {
        const arr = _tagValues.get(field.key) || [];
        if (!arr.includes(val)) arr.push(val);
        _tagValues.set(field.key, arr);
        _render();
      }
    });

    chipRow.appendChild(input);
    chipRow.addEventListener('click', () => input.focus());
    wrap.appendChild(chipRow);

    const hint = document.createElement('span');
    hint.className    = 'form-hint';
    hint.textContent  = 'Press Enter or comma to add';
    wrap.appendChild(hint);
  };

  _render();
  return wrap;
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
    chipRow.innerHTML = '';
    const ids = _relationValues.get(field.key) || [];
    for (let i = 0; i < ids.length; i++) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.style.cssText = 'display: inline-flex; align-items: center; gap: 4px;';
      // Show ID shortened as placeholder — resolved at save time
      chip.dataset.id = ids[i].id;

      const label = document.createElement('span');
      label.textContent = ids[i].label || ids[i].id;
      chip.appendChild(label);

      const rm = document.createElement('span');
      rm.textContent = '×';
      rm.style.cssText = 'cursor: pointer; font-weight: bold; color: var(--color-text-muted); margin-left: 2px;';
      rm.addEventListener('click', () => {
        const arr = _relationValues.get(field.key) || [];
        arr.splice(i, 1);
        _renderChips();
      });
      chip.appendChild(rm);
      chipRow.appendChild(chip);
    }
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

    // ── Save relation edges ───────────────────────────────── //
    for (const field of config.fields) {
      if (field.type !== 'relation') continue;
      const targets = _relationValues.get(field.key) || [];
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

    // ── Callback & close ──────────────────────────────────── //
    // Emit ENTITY_SAVED before the callback so listeners (panel, kanban, daily)
    // update state first. The callback then has fresh data if it queries anything.
    const cb = _onSave;
    const wasNew = !_editEntity;
    const entityLabel = config?.label || 'item';
    closeForm();
    emit(EVENTS.ENTITY_SAVED, { entity: saved, isNew: wasNew });
    cb?.(saved);
    toast.success(wasNew ? `${entityLabel} created` : `${entityLabel} saved`);

  } catch (err) {
    console.error('[entity-form] Save failed:', err);
    if (saveBtn) {
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
