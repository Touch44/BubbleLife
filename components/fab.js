/**
 * FamilyHub v4.2 — components/fab.js
 * Floating Action Button — radial menu, context-aware defaults, keyboard shortcuts.
 * Blueprint §5.3, Phase 1-D
 *
 * Public API:
 *   initFab()      — wire all FAB behaviour; call once after DOM ready
 *   expandFab()    — open radial menu
 *   collapseFab()  — close radial menu
 */

import { on, EVENTS }         from '../core/events.js';
import { getCurrentView }      from '../core/router.js';
import { openForm }            from './entity-form.js';
// [v5.0.0] reminder form import — dynamic to avoid circular dependency
let _openReminderForm = null;
async function _ensureReminderForm() {
  if (!_openReminderForm) {
    const m = await import('./reminder-form.js').catch(() => null);
    _openReminderForm = m?.openReminderForm || null;
  }
  return _openReminderForm;
}

// ── DOM refs ──────────────────────────────────────────────── //
let _fab, _fabMainBtn;

// ── Context map: view → default entity type ───────────────── //
const VIEW_DEFAULT_TYPE = {
  'kanban':       'task',
  'daily':        'task',
  'activity-center':  'post',
  'notes':        'note',
  'calendar':     'event',
  'projects':     'project',
  'budget':       'budgetEntry',
  'recipes':      'recipe',
  'contacts':     'contact',
};

// ════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════

/**
 * Initialise FAB. Must be called once after DOM is ready.
 */
export function initFab() {
  _fab        = document.getElementById('fab');
  _fabMainBtn = document.getElementById('fab-main-btn');

  if (!_fab || !_fabMainBtn) {
    console.warn('[fab] FAB DOM not found — skipping init.');
    return;
  }

  // ── Main button: toggle expand/collapse ──────────────────
  _fabMainBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const expanded = _fab.classList.toggle('fab-expanded');
    _fabMainBtn.setAttribute('aria-expanded', String(expanded));
  });

  // ── Radial item clicks ───────────────────────────────────
  _fab.querySelectorAll('.fab-radial-btn[data-fab-type]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const type = btn.dataset.fabType;
      collapseFab();
      _handleFabType(type);
    });
  });

  // ── Close on outside click ───────────────────────────────
  document.addEventListener('click', (e) => {
    if (_fab && !_fab.contains(e.target)) {
      collapseFab();
    }
  });

  // ── Esc closes FAB ───────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _fab.classList.contains('fab-expanded')) {
      collapseFab();
    }
  });

  // ── Keyboard shortcuts: N = note, T = task, + = toggle FAB ─
  document.addEventListener('keydown', (e) => {
    // BUG-G fix: don't fire shortcuts when auth screen is visible
    const appEl = document.getElementById('app');
    if (appEl && appEl.getAttribute('aria-hidden') === 'true') return;

    const inTextField = e.target.matches(
      'input, textarea, [contenteditable="true"], select'
    );
    if (inTextField || e.metaKey || e.ctrlKey || e.altKey) return;

    switch (e.key) {
      case 'n': case 'N':
        e.preventDefault();
        collapseFab();
        _openQuickForm('note');
        break;
      case 't': case 'T':
        e.preventDefault();
        collapseFab();
        _openQuickForm('task');
        break;
      case '+': case '=':
        e.preventDefault();
        if (_fab.classList.contains('fab-expanded')) {
          collapseFab();
        } else {
          expandFab();
        }
        break;
    }
  });

  // ── Listen for fab:create events from other modules ──────
  on(EVENTS.FAB_CREATE, ({ entityType, prefill } = {}) => {
    collapseFab();
    if (entityType) _handleFabType(entityType, prefill);
  });

  // BUG-C fix: collapse FAB radial menu on any view navigation
  on(EVENTS.VIEW_CHANGED, () => {
    if (_fab?.classList.contains('fab-expanded')) collapseFab();
  });

  // [v5.0.0] Alert badge — removeAttribute when 0 (NOT setAttribute '0')
  // CSS [data-alerts]::after uses attr(), so attribute must be ABSENT to hide badge
  on(EVENTS.ALERT_COUNT_CHANGED, (count) => {
    const btn = document.getElementById('fab-main-btn');
    if (!btn) return;
    if (count > 0) {
      btn.setAttribute('data-alerts', String(count));
    } else {
      btn.removeAttribute('data-alerts'); // ← removeAttribute, never setAttribute('data-alerts','0')
    }
  });

  console.log('[fab] Initialised.');
}

// ════════════════════════════════════════════════════════════
// PUBLIC
// ════════════════════════════════════════════════════════════

export function expandFab() {
  if (!_fab) return;
  _fab.classList.add('fab-expanded');
  _fabMainBtn?.setAttribute('aria-expanded', 'true');
}

export function collapseFab() {
  if (!_fab) return;
  _fab.classList.remove('fab-expanded');
  _fabMainBtn?.setAttribute('aria-expanded', 'false');
}

// ════════════════════════════════════════════════════════════
// INTERNAL
// ════════════════════════════════════════════════════════════

/**
 * Handle a FAB type click — 'more' opens form with type selector,
 * all others open form pre-set to that type.
 * @param {string} type
 * @param {object} [prefill={}] - optional field values to pre-populate
 */
function _handleFabType(type, prefill = {}) {
  if (type === 'more') {
    const currentView = getCurrentView();
    const viewKey     = currentView?.viewKey || '';
    const entityType  = currentView?.params?.entityType;

    // 3P-H-01 fix: reminders view → open reminder creation form (not entity form)
    if (viewKey === 'reminders') {
      _ensureReminderForm().then(fn => fn && fn({})).catch(console.error);
      return;
    }

    const defaultType = (viewKey === 'entity-type' && entityType)
      ? entityType
      : (VIEW_DEFAULT_TYPE[viewKey] || 'note');
    openForm(defaultType);
    return;
  }
  _openQuickForm(type, prefill);
}

/**
 * Open entity form for a specific type, with context-aware prefill.
 * @param {string} type
 * @param {object} [callerPrefill={}] - prefill values from the caller (e.g. dueDate from daily.js)
 */
function _openQuickForm(type, callerPrefill = {}) {
  const view    = getCurrentView()?.viewKey || '';
  const prefill = { ...callerPrefill };

  // Context-aware prefill: kanban/daily → task gets status:Inbox (only if not already set)
  if (type === 'task') {
    if (!prefill.status)   prefill.status   = 'Not Started'; // SYS-13
    if (!prefill.priority) prefill.priority = 'Medium';
  }
  // activity-center posts prefill type
  if (type === 'post' && view === 'activity-center') {
    if (!prefill.category) prefill.category = 'Family';
  }

  openForm(type, prefill);
}
