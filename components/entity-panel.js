
/** Convert camelCase field key to human relation label (e.g. 'assignedTo' → 'assigned to') */
function _fieldKeyToRelLabel(key, fieldConfig) {
  if (fieldConfig?.label) return fieldConfig.label.toLowerCase();
  return key.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
}

/**
 * FamilyHub v4.2 — components/entity-panel.js
 * Universal entity detail panel — slide-in from right (desktop) / drawer from bottom (mobile)
 * Blueprint §5.1 (entity panel), Phase 1-B
 *
 * Public API:
 *   openPanel(entityId)   — loads entity, renders, slides panel in
 *   closePanel()          — slides panel out, cleans up
 *   initEntityPanel()     — wires panel events (call once during boot)
 */

import { getEntity, saveEntity, deleteEntity, getEdgesFrom, getEdgesTo,
         saveEdge, deleteEdge, getSetting, setSetting, getEntitiesByType,
         queryEntities } from '../core/db.js';
import { getEntityTypeConfig, getAllEntityTypes,
         getNeighbors, convertEntity } from '../core/graph-engine.js';
import { on, emit, EVENTS } from '../core/events.js';
import { toast, showToast }     from '../core/toast.js';
import { openEditForm, openForm, openQuickCreateModal } from './entity-form.js';
import { getAccount }       from '../core/auth.js';
import { initGraph, destroyGraph, setFocusId, refreshGraph, setActiveTypes, getActiveNodeTypes } from './graph-canvas.js';
import { navigate, VIEW_KEYS } from '../core/router.js';
import { mountActivityStream, recordCreated } from './activity-stream.js';
import { getSequentialTaskState } from '../views/projects.js'; // [v5.9.0] Sequential mode
import { initRelatedPanel, renderRelatedPanel } from './related-panel.js'; // [KLRE v6.6.0]

// 3P-L-03: module-scope constant for footer type exclusion
const _NO_REMINDER_TYPES = new Set(['reminder','reminderLog','post','comment','activity','message','conversation','dailyReview','tag']);
// [fix] time-tracker loaded dynamically — panel works even before file is deployed
let getSession    = () => null;
let startFreeRun  = async () => {};
let startBlock    = async () => {};
let stopSession   = async () => {};
let resetSession  = async () => {};
let adjustSession = async () => {};
let clearAlarm    = () => {};
let getElapsed    = () => 0;
let getRemaining  = () => null;
let formatDuration = (s) => { if(!s||s<0)return '0s'; const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=Math.floor(s%60); return [h&&h+'h',m&&m+'m',sec+'s'].filter(Boolean).join(' '); };
let formatDurationCompact = (s) => { const m=Math.floor((s||0)/60),sc=Math.floor((s||0)%60); return String(m).padStart(2,'0')+':'+String(sc).padStart(2,'0'); };
let activeTaskIds  = { value: new Set() };
let alarmedTaskIds = { value: new Set() };
let TIMER_TICK  = 'timer:tick';
let TIMER_ALARM = 'timer:alarm';
let TIMER_SAVED = 'timer:saved';
let _ttPanelLoaded = false;
async function _ensureTimeTrackerPanel() {
  if (_ttPanelLoaded) return;
  _ttPanelLoaded = true;
  try {
    const tt = await import('../services/time-tracker.js');
    getSession    = tt.getSession;
    startFreeRun  = tt.startFreeRun;
    startBlock    = tt.startBlock;
    stopSession   = tt.stopSession;
    resetSession  = tt.resetSession;
    adjustSession = tt.adjustSession;
    clearAlarm    = tt.clearAlarm;
    getElapsed    = tt.getElapsed;
    getRemaining  = tt.getRemaining;
    formatDuration = tt.formatDuration;
    formatDurationCompact = tt.formatDurationCompact;
    activeTaskIds  = tt.activeTaskIds;
    alarmedTaskIds = tt.alarmedTaskIds;
    TIMER_TICK  = tt.TIMER_TICK;
    TIMER_ALARM = tt.TIMER_ALARM;
    TIMER_SAVED = tt.TIMER_SAVED;
  } catch (e) { console.warn('[entity-panel] time-tracker not available:', e.message); }
}

// ── Graph view state ──────────────────────────────────────── //
let _graphViewActive = false;
let _graphPreviousView = null;   // viewKey to restore on exit
let _graphPanelEntityId = null;  // tracks which entity is showing in the panel during graph mode
let _graphTypeFilters = new Set(); // entity types currently shown in graph
let _graphAllTypes = [];           // [minor] all graphVisible types — captured at graph open, never shrinks

// ── Entity type → native view mapping ─────────────────────── //
const TYPE_VIEW_MAP = {
  task:         'kanban',
  event:        'calendar',
  note:         'notes',
  project:      'projects',
  post:         'activity-center',
  comment:      'activity-center',
  budgetEntry:  'budget',
  recipe:       'recipes',
  document:     'documents',
  contact:      'contacts',
  mealPlan:     'recipes',
  shoppingItem: 'kanban',
  appointment:  'calendar',
  dateEntity:   'calendar',
  person:       'contacts',
  // Generic entity types → entity-type view
  idea:         'entity-type/idea',
  research:     'entity-type/research',
  book:         'entity-type/book',
  trip:         'entity-type/trip',
  place:        'entity-type/place',
  weblink:      'entity-type/weblink',
  goal:         'entity-type/goal',
  habit:        'entity-type/habit',
  medication:   'entity-type/medication',
  // Daily Review → daily view
  dailyReview:  'daily',
  // [v5.0.0] Reminder → reminders view
  reminder:     'reminders',
};

// ── DOM refs (cached once on init) ───────────────────────── //
let _panel, _panelBody, _panelTitle, _panelTypeBadge, _panelClose, _savingIndicator, _headerActions;

// ── State ────────────────────────────────────────────────── //
let _entity     = null;   // currently open entity
let _config     = null;   // its EntityTypeConfig
let _activeTab  = 'properties';
let _saving     = false;
let _dirty           = false;
let _snapshot        = null;
let _activityCleanup = null;  // P-28: cleanup fn for mounted activity stream       // snapshot of entity at panel open time (P-26)
let _dirtyEl    = null;       // "Unsaved changes" indicator element (P-26)

// ════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════

/**
 * Wire panel events. Call once during app boot after DOM is ready.
 */
export function initEntityPanel() {
  _panel     = document.getElementById('entity-panel');
  _panelBody = document.getElementById('entity-panel-body');

  if (!_panel || !_panelBody) {
    console.warn('[entity-panel] Panel DOM not found — skipping init.');
    return;
  }

  // Wire backdrop — tap to close on mobile AND in modal mode on desktop
  const _backdrop = document.getElementById('entity-panel-backdrop');
  if (_backdrop) {
    _backdrop.addEventListener('click', () => closePanel());
  }

  // M-02: Swipe-down gesture on the drag handle to close on mobile
  // Only triggers when touch begins in the top 64px (drag handle + panel header region)
  // to prevent false positives from scrolling panel body content.
  let _touchStartY         = 0;
  let _touchStartTime      = 0;
  let _touchStartPanelTop  = 0;
  let _swipeEligible       = false;

  _panel.addEventListener('touchstart', (e) => {
    _touchStartY        = e.touches[0].clientY;
    _touchStartTime     = Date.now();
    _touchStartPanelTop = _panel.getBoundingClientRect().top;
    // Only eligible if touch started within 64px of panel top (drag handle area)
    const relativeY = _touchStartY - _touchStartPanelTop;
    _swipeEligible  = relativeY >= 0 && relativeY <= 64;
  }, { passive: true });

  _panel.addEventListener('touchend', (e) => {
    if (!_panel.classList.contains('open') || !_swipeEligible) return;
    const dy       = e.changedTouches[0].clientY - _touchStartY;
    const elapsed  = Date.now() - _touchStartTime;
    const velocity = dy / elapsed;  // px/ms
    // Close if dragged down >60px, or fast flick (>0.4 px/ms) within 350ms
    if (dy > 60 || (velocity > 0.4 && elapsed < 350 && dy > 20)) {
      closePanel();
    }
  }, { passive: true });

  // Esc key closes panel — but not if a form modal is open or a panel input has focus
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _panel.classList.contains('open')) {
      // Suppress if entity-form overlay is visible
      if (document.querySelector('.ef-overlay')) return;
      // Suppress if focus is inside the panel (title input, relation search, etc.)
      // Let the focused element handle Escape first (clear/blur), don't close panel
      const active = document.activeElement;
      if (active && _panel.contains(active) &&
          (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' ||
           active.getAttribute('contenteditable') === 'true')) {
        active.blur();
        return;
      }
      closePanel();
    }
  });

  // Cmd+S saves panel when open (P-26) — use named handler to prevent duplicate registration
  if (!document._fhPanelSaveListenerWired) {
    document._fhPanelSaveListenerWired = true;
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's' && _panel?.classList.contains('open')) {
        e.preventDefault();
        if (_dirty) _save();
      }
    });
  }

  // Listen for open requests from anywhere
  on(EVENTS.PANEL_OPENED, ({ entityId, entityType } = {}) => {
    if (entityId) openPanel(entityId, entityType);
  });

  // Refresh if entity we're showing got saved elsewhere
  on(EVENTS.ENTITY_SAVED, ({ entity } = {}) => {
    if (!entity || !_entity) return;

    if (entity.id === _entity.id && !_saving) {
      _entity = entity;
      // If entity type changed (e.g. after Convert), reload config to match new type
      if (_config && entity.type && entity.type !== _config.key) {
        const newCfg = getEntityTypeConfig(entity.type);
        if (newCfg) {
          _config    = newCfg;
          _activeTab = 'properties';
          _renderHeader();
        }
      }
      _renderActiveTab();

    } else if (_entity.type === 'project' && _activeTab === 'tasks' && entity.type === 'task') {
      // [v5.8.0] A task was saved while showing a project's Tasks tab — refresh the list
      const c = _panelBody?.querySelector('.panel-view-container');
      if (c) _renderProjectTasksTab(c);

    } else if (_activeTab === 'series') {
      // [v6.3.4] Recurrence summary fix: refresh the series tab when the TEMPLATE is saved
      // while currently viewing an INSTANCE panel (entity.id != _entity.id, but it's the parent template).
      // Covers: completeInstance updating occurrenceCount/currentStreak/longestStreak on the template.
      const isCurrentEntityTemplate =
        // Viewing an instance: its templateId matches the saved entity
        (_entity.type === 'taskInstance' && (_entity.templateId === entity.id)) ||
        // Viewing a template: a child instance was saved (e.g. skip updates the instance)
        (entity.type === 'taskInstance' && entity.templateId === _entity.id);

      if (isCurrentEntityTemplate) {
        const c = _panelBody?.querySelector('.panel-view-container');
        if (c) _renderSeriesTab(c);
      }
    }
  });

  // Close panel (or clear graph panel) if shown entity was deleted
  on(EVENTS.ENTITY_DELETED, ({ id } = {}) => {
    if (!_entity || _entity.id !== id) return;
    if (_graphViewActive) {
      // In graph mode: just clear the panel content; don't exit graph entirely
      _clearGraphPanel();
    } else {
      closePanel();
    }
  });

  // Graph canvas: single-click → update panel to that entity
  on('graph:nodeSelected', ({ id } = {}) => {
    if (!_graphViewActive || !id) return;
    _graphPanelEntityId = id;
    _showGraphPanel();
    openPanel(id).then(() => {
      _activeTab = 'properties';
      _renderActiveTab();
    });
  });

  // Graph canvas: double-click → drills focus (graph-canvas handles setFocusId),
  // also update panel to the focused entity
  on('graph:nodeFocused', ({ id } = {}) => {
    if (!_graphViewActive || !id) return;
    _graphPanelEntityId = id;
    _showGraphPanel();
    openPanel(id).then(() => {
      _activeTab = 'properties';
      _renderActiveTab();
    });
  });

  // Graph canvas: empty space clicked → clear panel content (stay in graph)
  on('graph:emptyClicked', () => {
    if (!_graphViewActive) return;
    _clearGraphPanel();
  });

  // [minor] Graph canvas: focus exited — merge any new rendered types into _graphAllTypes,
  // then rebuild chips so newly-discovered types get their chips too.
  on('graph:focusExited', () => {
    if (!_graphViewActive) return;
    setTimeout(() => {
      // Merge newly-rendered types into _graphAllTypes (union — never shrinks)
      const rendered = getActiveNodeTypes();
      const knownKeys = new Set(_graphAllTypes.map(c => c.key));
      const allCfgs = getAllEntityTypes();
      for (const key of rendered) {
        if (!knownKeys.has(key)) {
          const cfg = allCfgs.find(c => c.key === key);
          if (cfg) {
            _graphAllTypes.push(cfg);
            _graphTypeFilters.add(key); // new type starts ON
          }
        }
      }
      _buildGraphTypeFilters();
    }, 80);
  });

  // [F-graph] Open graph view for an entity (used by daily.js graph button and others)
  // _openGraphView internally calls openPanel after setting _graphViewActive=true,
  // so no pre-call to openPanel is needed — it avoids a redundant double-render.
  on('panel:openGraphForEntity', ({ entityId } = {}) => {
    if (!entityId) return;
    _openGraphView(entityId).catch(err => {
      console.error('[entity-panel] panel:openGraphForEntity failed:', err);
    });
  });

  // If user navigates away via sidebar/breadcrumbs while graph is open, clean up
  on(EVENTS.VIEW_CHANGED, ({ viewKey } = {}) => {
    if (_graphViewActive && viewKey !== 'graph') {
      // User navigated away while graph was open — fully tear down graph view
      destroyGraph();
      _graphViewActive    = false;
      _graphPanelEntityId = null;
      _graphPreviousView  = null;
      _graphAllTypes      = [];

      // Clean up graph DOM so the incoming view can render correctly
      const main   = document.getElementById('main');
      const viewEl = document.getElementById('view-graph');
      if (main)   main.classList.remove('graph-active');
      if (viewEl) {
        viewEl.classList.remove('active');
        viewEl.setAttribute('aria-hidden', 'true');
        viewEl.innerHTML = '';
      }

      if (_panel) {
        _panel.classList.remove('graph-mode');
        _panel.classList.remove('graph-panel-empty');
      }
      // Also close the panel when graph is torn down by navigation
      // so it doesn't float over the newly-restored view.
      if (_panel && _panel.classList.contains('open')) {
        _panel.classList.remove('open');
        _panel.setAttribute('aria-hidden', 'true');
        const _bd = document.getElementById('entity-panel-backdrop');
        if (_bd) { _bd.classList.remove('visible'); _bd.classList.remove('modal-backdrop'); }
        _entity = null; _config = null;
      }
    }

    // BUG-2 fix: close the panel on ANY view change (sidebar clicks, hotkeys, etc.)
    // This prevents the panel from hanging over a completely different view.
    if (_panel && _panel.classList.contains('open') && !_graphViewActive) {
      // Auto-save if dirty before closing — prevents silent data loss on navigation
      if (_dirty && _entity) {
        // Snapshot entity before clearing module state — _save() is async and
        // would race with the null assignments below, restoring _entity after close.
        const _snapEntity = _entity;
        const _snapAcct   = getAccount()?.id;
        saveEntity(_snapEntity, _snapAcct).catch(() => {}); // best-effort
        toast.info('Changes saved automatically.');
      }
      _panel.classList.remove('open');
      _panel.classList.remove('modal-mode');
      _panel.setAttribute('aria-hidden', 'true');
      // Hide backdrop — both mobile side-panel and desktop modal-mode
      const _bd2 = document.getElementById('entity-panel-backdrop');
      if (_bd2) { _bd2.classList.remove('visible'); _bd2.classList.remove('modal-backdrop'); }
      _dirty    = false;
      _snapshot = null;
      _entity   = null;
      _config   = null;
      _updateDirtyIndicator();
      if (_activityCleanup) { _activityCleanup(); _activityCleanup = null; }
      setTimeout(() => { if (_panelBody) _panelBody.innerHTML = ''; }, 420);
      emit(EVENTS.PANEL_CLOSED);
    }
  });

  console.log('[entity-panel] Initialised.');

  // ── One-time repair for entities corrupted by type-field collision ──
  // Events/appointments with type set to a subtype value (e.g. 'Work', 'School')
  // instead of 'event'/'appointment' need repair.
  _repairCorruptedTypes();

  // ── One-time migration: clean up stale daily-review edges and fix DR titles ──
  _migrateDailyReviewEdges();

  // ── One-time migration: fix stale dueDate on taskInstances (pre-v5.4.3) ──
  _migrateInstanceDueDates();
}

/**
 * Scan for entities whose .type doesn't match any registered entity type
 * but whose field values suggest they belong to a known type.
 * Repairs them by moving the corrupted type to ._subtype and restoring the correct type.
 */
async function _repairCorruptedTypes() {
  try {
    const allTypes = getAllEntityTypes({ includeArchived: true });
    const knownKeys = new Set(allTypes.map(t => t.key));

    // Build a map of subtype values → parent type key
    // e.g. 'Work' → 'event', 'School' → 'event', 'Medical' → 'appointment'
    const subtypeMap = new Map();
    for (const tc of allTypes) {
      for (const field of tc.fields || []) {
        if (field.key === 'type' && field.options) {
          for (const opt of field.options) {
            subtypeMap.set(opt, tc.key);
          }
        }
      }
    }

    // Scan all entities — find ones with unrecognised type
    const allEntities = await queryEntities({ includeDeleted: false });
    let repairCount = 0;

    for (const entity of allEntities) {
      if (knownKeys.has(entity.type)) continue;

      // Try to identify the correct type from the subtype map
      const correctType = subtypeMap.get(entity.type);
      if (correctType) {
        entity._subtype = entity.type;
        entity.type = correctType;
        await saveEntity(entity, getAccount()?.id);
        repairCount++;
      }
    }

    if (repairCount > 0) {
      console.info(`[entity-panel] Repaired ${repairCount} entities with corrupted type field.`);
    }
  } catch (err) {
    console.warn('[entity-panel] Type repair scan failed:', err);
  }
}

/**
 * One-time migration (runs every boot, idempotent):
 *
 * 1. Fix Daily Review entity titles: old format 'Daily Review — YYYY-MM-DD'
 *    → new format 'Daily Review — MM-DD-YYYY'. Matched by .date field.
 *
 * 2. Delete ALL stale daily-review edges (relation = 'daily review' or 'contains'
 *    where fromType or toType = 'dailyReview'). These were created by old code
 *    that used wrong dates (createdAt instead of dueDate, etc.).
 *    Fresh correct edges will be created on next panel open or daily view load.
 *
 * Non-blocking — errors are logged but never crash the app.
 */
async function _migrateDailyReviewEdges() {
  try {
    // ── Step 1: Fix Daily Review entity titles (YYYY-MM-DD → MM-DD-YYYY) ─
    const drEntities = await getEntitiesByType('dailyReview');
    let titleFixed = 0;
    for (const dr of drEntities) {
      if (!dr.date || dr.deleted) continue;
      const correctTitle = `Daily Review — ${_formatDateForTitle(dr.date)}`;
      if (dr.title !== correctTitle) {
        try { await saveEntity({ ...dr, title: correctTitle }, getAccount()?.id); titleFixed++; } catch { /* skip */ }
      }
    }
    if (titleFixed > 0) {
      console.info(`[entity-panel] [migration] Fixed ${titleFixed} DR titles to MM-DD-YYYY.`);
    }

    // ── Step 2: PURGE only stale OLD-relation-name edges (once only) ─────
    // Only delete edges with OLD relation names ('in daily review', 'daily review').
    // NEVER delete 'contains' edges — those are intentionally created by users
    // and by _createAndLink / _syncDailyReviewLinks in the current version.
    //
    // Guard: skip if this migration has already run (stored in a DB setting).
    const migDoneKey = 'migration_dr_edges_v3_done'; // [v5.4.4] bumped to include taskInstance
    const alreadyMigrated = await getSetting(migDoneKey).catch(() => null);
    if (alreadyMigrated) {
      // Migration already ran — skip entirely
    } else {
      const allTypes = ['task','taskInstance','event','appointment','note','post','dateEntity',
                        'mealPlan','trip','idea','research','book',
                        'person','project','contact','place','weblink',
                        'recipe','medication','shoppingItem','habit','goal','dailyReview'];

      let edgeDeleted = 0;

      for (const typeName of allTypes) {
        try {
          const entities = await getEntitiesByType(typeName);
          for (const entity of entities) {
            if (entity.deleted) continue;
            // Only delete OLD relation-name edges (not 'contains')
            for (const rel of ['daily review', 'in daily review']) {
              const edges = await getEdgesFrom(entity.id, rel);
              for (const edge of edges) {
                try { await deleteEdge(edge.id); edgeDeleted++; } catch { /* skip */ }
              }
            }
          }
        } catch { /* skip type */ }
      }

      // Mark migration as done so it never runs again
      await setSetting(migDoneKey, true).catch(() => {});

      if (edgeDeleted > 0) {
        console.info(`[entity-panel] [migration] Purged ${edgeDeleted} stale old-relation-name DR edges.`);
      }
    }

  } catch (err) {
    console.warn('[entity-panel] [migration] _migrateDailyReviewEdges failed (non-fatal):', err);
  }
}

/**
 * [v5.5.1] One-time migration: fix stale dueDate on taskInstances created before v5.4.3.
 * Pre-v5.4.3, instances inherited dueDate from the template (e.g. "May 11") instead of
 * being set to their own periodStart. This caused wrong "DUE Yesterday" chips in kanban/daily.
 * Fix: set dueDate = periodStart for any instance where they differ.
 */
async function _migrateInstanceDueDates() {
  const migKey = 'migration_instance_duedate_v1_done';
  try {
    const already = await getSetting(migKey).catch(() => null);
    if (already) return;

    const instances = await getEntitiesByType('taskInstance').catch(() => []);
    let fixed = 0;
    const acct = getAccount();
    for (const inst of instances) {
      if (!inst || inst.deleted) continue;
      const ps = inst.periodStart?.slice(0, 10);
      if (!ps) continue;
      if (inst.dueDate?.slice(0, 10) !== ps) {
        try {
          await saveEntity({ ...inst, dueDate: ps }, acct?.id);
          fixed++;
        } catch { /* best-effort, skip this one */ }
      }
    }

    await setSetting(migKey, true).catch(() => {});
    if (fixed > 0) {
      console.info(`[entity-panel] [migration] Fixed dueDate on ${fixed} taskInstance(s).`);
    }
  } catch (err) {
    console.warn('[entity-panel] [migration] _migrateInstanceDueDates failed (non-fatal):', err);
  }
}

/**
 * Return the Set of correct YYYY-MM-DD dates for an entity's Daily Review links,
 * or null if we can't determine (e.g. unknown type). Used by migration.
 */
function _getCorrectDatesForEntity(entity) {
  const SKIP = new Set(['dailyReview','tag','note','budgetEntry','person','project',
                        'contact','place','weblink','recipe','medication','shoppingItem','habit','goal']);
  if (SKIP.has(entity.type)) return new Set(); // should have zero links

  const dates = new Set();
  switch (entity.type) {
    case 'task':
      if (entity.dueDate) { const d = _isoToLocalDate(entity.dueDate); if (d) dates.add(d); }
      break;
    case 'taskInstance': {
      // [v5.4.3] Instances belong to their periodStart DR only
      const occDate = _isoToLocalDate(entity.periodStart);
      if (occDate) dates.add(occDate);
      break;
    }
    case 'event': {
      const startD = _isoToLocalDate(entity.date);
      const endD   = _isoToLocalDate(entity.endDate);
      if (startD) {
        dates.add(startD);
        if (endD && endD > startD) {
          let cur = new Date(startD + 'T00:00:00');
          const stop = new Date(endD + 'T00:00:00');
          let safety = 0;
          while (cur <= stop && safety++ < 90) {
            const y = cur.getFullYear(), m = String(cur.getMonth()+1).padStart(2,'0'), dy = String(cur.getDate()).padStart(2,'0');
            dates.add(`${y}-${m}-${dy}`);
            cur.setDate(cur.getDate() + 1);
          }
        }
      }
      break;
    }
    case 'appointment': case 'dateEntity': case 'mealPlan':
      if (entity.date) { const d = _isoToLocalDate(entity.date); if (d) dates.add(d); }
      break;
    case 'trip':
      if (entity.startDate) { const d = _isoToLocalDate(entity.startDate); if (d) dates.add(d); }
      break;
    default:
      if (entity.createdAt) { const d = _isoToLocalDate(entity.createdAt); if (d) dates.add(d); }
      break;
  }
  return dates;
  initRelatedPanel(); // [KLRE] wire related panel listeners
}

// ════════════════════════════════════════════════════════════
// OPEN / CLOSE
// ════════════════════════════════════════════════════════════

/**
 * Open the entity panel for a given entity ID.
 * @param {string} entityId
 * @param {string} [entityTypeHint] - fallback type key if entity.type is corrupted
 */
// [N-01] Concurrent openPanel guard — prevents stale entity from slower first call
// overwriting _entity when a second call resolves first.
let _loadingEntityId = null;

export async function openPanel(entityId, entityTypeHint) {
  if (!_panel || !_panelBody) return;

  // [N-01 fix] Track which entityId is currently being loaded.
  // If a new call arrives before the previous one resolves, the first call's
  // result is discarded.
  const myLoadId = entityId;
  _loadingEntityId = myLoadId;

  try {
    const entity = await getEntity(entityId);
    // [N-01 fix] If another openPanel() was called while we were awaiting IDB,
    // this result is stale — discard it.
    if (_loadingEntityId !== myLoadId) return;
    if (!entity || entity.deleted) {
      console.warn(`[entity-panel] Entity "${entityId}" not found.`);
      // Show friendly message in panel instead of silent failure
      _panelBody.innerHTML = '';
      const msg = document.createElement('div');
      msg.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:var(--space-4);padding:var(--space-8);text-align:center;';
      msg.innerHTML = `
        <div style="font-size:2.5rem;">🔍</div>
        <div style="font-weight:var(--weight-semibold);font-size:var(--text-base);color:var(--color-text);">Item not found</div>
        <div style="font-size:var(--text-sm);color:var(--color-text-muted);max-width:260px;line-height:1.5;">
          This item may have been deleted or moved. It no longer exists in your data.
        </div>
        <button class="btn btn-ghost btn-sm" onclick="this.closest('.entity-panel,.side-panel,[class*=panel]')?.dispatchEvent(new CustomEvent('close'))">Close</button>
      `;
      _panelBody.appendChild(msg);
      // Show panel so user sees the message
      if (_panel && !_panel.classList.contains('open')) {
        _panel.classList.add('open');
        document.body.classList.add('panel-open');
      }
      return;
    }

    let config = getEntityTypeConfig(entity.type);

    // If config not found, the entity.type may have been corrupted by a
    // field named 'type' (e.g. event subtype 'Work' overwrote 'event').
    // Try the entityTypeHint or scan for a matching type by field shape.
    if (!config && entityTypeHint) {
      config = getEntityTypeConfig(entityTypeHint);
      if (config) {
        // Repair: move corrupted type to _subtype, restore structural type
        entity._subtype = entity.type;
        entity.type = entityTypeHint;
        // Persist the repair so it doesn't recur
        try { await saveEntity(entity, getAccount()?.id); } catch { /* best effort */ }
        console.info(`[entity-panel] Repaired entity "${entityId}": type "${entity._subtype}" → "${entityTypeHint}"`);
      }
    }

    if (!config) {
      console.warn(`[entity-panel] No config for type "${entity.type}".`);
      return;
    }

    // ── Form-first routing ─────────────────────────────────────
    // Outside of graph mode: every entity click goes to the edit form (modal overlay)
    // rather than the slide panel. The panel is reserved for graph-view entity browsing.
    // Exception: skipFormFirst flag allows internal navigation (graph button, close-graph restore).
    // [P01 fix] taskInstance bypasses form-first — series panel is the primary UX.
    const _isTaskInstance = entity.type === 'taskInstance';
    if (!_graphViewActive && !openPanel._skipFormFirst && !_isTaskInstance) {
      // [minor] BUG-35 fix: do NOT set module state before early-return to avoid leakage
      openEditForm(entity);
      return;
    }
    // Graph mode, explicit bypass, or taskInstance: fall through to panel rendering.

    _entity    = entity;
    _config    = config;
    // Content-first types default to 'content' view; projects default to 'tasks'; others to 'properties'
    if (entity.type === 'project') {
      _activeTab = 'tasks';
    } else {
      _activeTab = CONTENT_FIRST_TYPES.has(entity.type) ? 'content' : 'properties';
    }
    if (entity.type === 'taskInstance') _activeTab = 'series'; // [v5.3.1]
    _dirty     = false;
    _snapshot  = JSON.stringify(entity);  // P-26: snapshot for dirty detection
    _updateDirtyIndicator();
    // Clear saved tab scroll positions — new entity starts fresh
    Object.keys(_tabScrollPos).forEach(k => delete _tabScrollPos[k]);
    if (_panelBody) delete _panelBody.dataset.renderedTab;

    // Auto-link entity to its Daily Note(s) in background
    // Skip in graph mode — graph browsing shouldn't create new DR edges
    if (!_graphViewActive) {
      _ensureDailyLinks(entity).catch(() => {});
    }

    _renderHeader();
    _renderActiveTab();
    _mountActivityStream();  // P-28: mount activity stream after content

    // [KLRE v6.6.0] Inject related panel — must be after all awaits
    // myLoadId was captured before any await at the top of this function
    {
      const klreEl = document.createElement('div');
      _panelBody.appendChild(klreEl);
      renderRelatedPanel(klreEl, myLoadId); // async — self-renders, no await needed
    }

    // ── Modal mode: center panel for content-heavy entity types ──────────
    // Professional UX: side-panel for quick-glance types (tasks, events)
    //                  centered modal for content types (notes, ideas, books, etc.)
    const _isModalType = CONTENT_FIRST_TYPES.has(entity.type);
    if (_isModalType) {
      _panel.classList.add('modal-mode');
      document.getElementById('entity-panel-backdrop')?.classList.add('modal-backdrop');
    } else {
      _panel.classList.remove('modal-mode');
      document.getElementById('entity-panel-backdrop')?.classList.remove('modal-backdrop');
    }

    _panel.classList.add('open');
    _panel.setAttribute('aria-hidden', 'false');
    // M-02: show backdrop on mobile (always); show on desktop for modal mode
    document.getElementById('entity-panel-backdrop')?.classList.add('visible');
    // Auto-close notification drawer so it doesn't stack on top of the panel
    const notifsDrawer = document.getElementById('notification-drawer');
    const notifsBtn    = document.getElementById('topbar-notifications-btn');
    if (notifsDrawer?.classList.contains('open')) {
      notifsDrawer.classList.remove('open');
      notifsBtn?.setAttribute('aria-expanded', 'false');
    }

  } catch (err) {
    console.error('[entity-panel] openPanel failed:', err);
  }
}

/**
 * Close the panel and clean up.
 * In graph view mode, closing the panel also exits the graph view.
 */
export function closePanel() {
  if (!_panel) return;

  // If in graph view mode, close the entire graph view
  if (_graphViewActive) {
    _closeGraphView();
    return;
  }

  _panel.classList.remove('open');
  _panel.classList.remove('modal-mode');
  _panel.setAttribute('aria-hidden', 'true');
  // M-02: hide backdrop (both side-panel mobile and modal-mode desktop)
  const _bd = document.getElementById('entity-panel-backdrop');
  if (_bd) {
    _bd.classList.remove('visible');
    _bd.classList.remove('modal-backdrop');
  }

  _entity   = null;
  _config   = null;
  _dirty    = false;
  _snapshot = null;
  _updateDirtyIndicator();
  if (_activityCleanup) { _activityCleanup(); _activityCleanup = null; }  // P-28

  // Clear body after transition
  setTimeout(() => {
    if (!_entity && _panelBody) _panelBody.innerHTML = '';
  }, 420);

  emit(EVENTS.PANEL_CLOSED);
}

// ════════════════════════════════════════════════════════════
// HEADER
// ════════════════════════════════════════════════════════════

function _renderHeader() {
  if (!_entity || !_config) return;

  const headerEl = document.getElementById('entity-panel-header');
  if (!headerEl) return;
  headerEl.innerHTML = '';
  headerEl.style.cssText = '';  // Let CSS classes control layout

  // ── Row 1: type badge · saving indicator · icon toolbar · close ──
  const topRow = document.createElement('div');
  topRow.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;';

  // Type badge (click → navigate to entity's native view)
  const badge = document.createElement('span');
  badge.id = 'entity-panel-type-badge';
  badge.className = 'type-badge';
  badge.setAttribute('aria-hidden', 'true');
  badge.textContent = `${_config.icon} ${_config.label}`;
  badge.style.background = _config.color;
  badge.style.cursor = 'pointer';
  badge.title = `Go to ${_config.labelPlural || _config.label} view`;
  badge.addEventListener('click', () => _navigateToEntityView(_entity, _config));
  topRow.appendChild(badge);
  _panelTypeBadge = badge;

  // Saving indicator
  const savingInd = document.createElement('span');
  savingInd.id = 'panel-saving-indicator';
  savingInd.className = 'panel-saving-indicator hidden';
  savingInd.setAttribute('aria-live', 'polite');
  savingInd.textContent = 'Saving…';
  topRow.appendChild(savingInd);
  _savingIndicator = savingInd;

  // Dirty indicator (P-26)
  const dirtyInd = document.createElement('span');
  dirtyInd.className = 'panel-dirty-indicator';
  dirtyInd.textContent = '● Unsaved';
  dirtyInd.setAttribute('aria-live', 'polite');
  dirtyInd.style.display = 'none';
  topRow.appendChild(dirtyInd);
  _dirtyEl = dirtyInd;

  // ── Icon toolbar (right-aligned) ─────────────────────────
  const toolbar = document.createElement('div');
  toolbar.style.cssText = 'display:flex;align-items:center;gap:2px;margin-left:auto;';

  // Action buttons (complete, duplicate, archive, add-to-project, convert, delete)
  const actionsDiv = document.createElement('div');
  actionsDiv.id = 'entity-panel-header-actions';
  actionsDiv.style.cssText = 'display:flex;gap:2px;align-items:center;';
  toolbar.appendChild(actionsDiv);
  _headerActions = actionsDiv;

  // Separator
  const sep1 = document.createElement('div');
  sep1.className = 'panel-icon-btn-sep';
  toolbar.appendChild(sep1);

  // View icon buttons: only show 'content' if entity has a content field
  const hasContent = _getContentField(_entity, _config) !== null;
  const visibleViews = VIEW_DEFS.filter(v => v.key !== 'content' || hasContent);
  // [v5.3.1] Inject Series tab for recurring templates and instances
  const _showSeries = (_entity?.type === 'task' && _entity?.isRecurring) || _entity?.type === 'taskInstance';
  if (_showSeries) visibleViews.push({ key: 'series', icon: '🔁', title: 'Series' });

  // [v5.8.0] Inject Tasks tab for project entities — after Details, before Connections
  if (_entity?.type === 'project') {
    // Insert Tasks tab at position 2 (after properties, before relations)
    const relIdx = visibleViews.findIndex(v => v.key === 'relations');
    const insertAt = relIdx >= 0 ? relIdx : visibleViews.length;
    visibleViews.splice(insertAt, 0, { key: 'tasks', icon: '✅', title: 'Tasks' });
  }

  for (const view of visibleViews) {
    const btn = document.createElement('button');
    btn.className = 'panel-icon-btn' + (_activeTab === view.key ? ' active' : '');
    btn.title = view.title;
    btn.setAttribute('aria-label', view.title);
    btn.setAttribute('data-view', view.key);
    btn.textContent = view.icon;
    btn.addEventListener('click', () => {
      _activeTab = view.key;
      toolbar.querySelectorAll('.panel-icon-btn[data-view]').forEach(b => {
        b.classList.toggle('active', b.dataset.view === view.key);
      });
      _renderActiveTab();
    });
    toolbar.appendChild(btn);
  }

  // ── Edit button: opens full entity-form for editing all fields ─
  if ((_config.actions || []).includes('edit')) {
    const editBtn = document.createElement('button');
    editBtn.className = 'panel-icon-btn panel-edit-btn';
    editBtn.title = _entity?.type === 'taskInstance' ? 'Edit this occurrence' : 'Edit all fields';
    editBtn.setAttribute('aria-label', _entity?.type === 'taskInstance' ? 'Edit this occurrence' : 'Edit entity');
    editBtn.innerHTML = '✏️';
    editBtn.style.cssText = 'font-size: 1rem;';
    editBtn.addEventListener('click', () => {
      if (!_entity) return;
      openEditForm(_entity, () => {
        // ENTITY_SAVED listener already refreshed the tab body.
        // Only header needs explicit refresh (action buttons, type badge, title).
        _renderHeader();
      });
    });
    toolbar.appendChild(editBtn);
  }

  // ── Graph: direct-action button (opens graph view immediately) ──
  const graphBtn = document.createElement('button');
  graphBtn.className = 'panel-icon-btn';
  graphBtn.title = 'Open Graph';
  graphBtn.setAttribute('aria-label', 'Open Graph');
  graphBtn.textContent = '🔮';
  graphBtn.style.cssText = 'color: var(--color-accent); font-size: 1rem;';
  graphBtn.addEventListener('click', () => {
    if (_entity?.id) _openGraphView(_entity.id);
  });
  // Hide graph button for types that have graphVisible: false in their config
  if (_config?.graphVisible === false) {
    graphBtn.style.display = 'none';
  }
  toolbar.appendChild(graphBtn);

  // Separator before close
  const sep2 = document.createElement('div');
  sep2.className = 'panel-icon-btn-sep';
  toolbar.appendChild(sep2);

  // Close button — prominently styled with label for discoverability
  const closeBtn = document.createElement('button');
  closeBtn.id = 'entity-panel-close';
  closeBtn.className = 'panel-icon-btn panel-close-btn';
  closeBtn.setAttribute('aria-label', 'Close entity panel');
  closeBtn.title = 'Close (Esc)';
  closeBtn.innerHTML = '✕ <span class="panel-close-label">Close</span>';
  closeBtn.addEventListener('click', async () => {
    if (_dirty) {
      const dialogSvc = window._fhEnv?.services?.dialog;
      let confirmed = true;
      if (dialogSvc) {
        confirmed = await dialogSvc.confirm(
          'You have unsaved changes. Discard them?',
          { title: 'Unsaved changes', confirmLabel: 'Discard', cancelLabel: 'Keep editing', danger: true }
        );
      }
      if (!confirmed) return;
    }
    closePanel();
  });
  toolbar.appendChild(closeBtn);
  _panelClose = closeBtn;

  topRow.appendChild(toolbar);
  headerEl.appendChild(topRow);

  // ── Row 2: entity title ──────────────────────────────────
  const titleRow = document.createElement('div');
  titleRow.style.cssText = 'display:flex;align-items:flex-start;width:100%;';

  const titleField = _config.fields.find(f => f.isTitle);
  const titleVal   = _getDisplayTitle(_entity);

  const titleSpan = document.createElement('span');
  titleSpan.id = 'entity-panel-title';
  titleSpan.textContent = titleVal;
  titleSpan.title = 'Click to edit title';
  titleSpan.style.cssText = 'font-family:var(--font-heading,system-ui,sans-serif);font-size:var(--text-xl,1.25rem);font-weight:700;color:var(--color-text);cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;line-height:1.25;';
  if (titleField) titleSpan.addEventListener('click', () => _makeTitleEditable(titleField));
  titleRow.appendChild(titleSpan);
  _panelTitle = titleSpan;

  headerEl.appendChild(titleRow);

  // ── Populate action buttons ──────────────────────────────
  _renderHeaderActions();
}
function _makeTitleEditable(titleField) {
  if (!_panelTitle || !titleField) return;

  const current = _entity[titleField.key] || '';
  const input   = document.createElement('input');
  input.type        = 'text';
  input.value       = current;
  input.className   = 'input';
  input.style.cssText = 'font-family: var(--font-heading); font-weight: var(--weight-bold); font-size: var(--text-xl); flex: 1; padding: var(--space-1) var(--space-2);';

  _panelTitle.replaceWith(input);
  input.focus();
  input.select();

  const commit = async () => {
    const val = input.value.trim();
    // Guard: never save an empty title — revert to previous value
    const effectiveVal = val || current;
    if (effectiveVal !== current && effectiveVal) {
      _entity[titleField.key] = effectiveVal;
      _markDirty();
      await _save();
    }
    // Rebuild title span — CSS handles styling via #entity-panel-title
    const span = document.createElement('span');
    span.id          = 'entity-panel-title';
    span.textContent = effectiveVal || current || 'Untitled';
    span.title       = 'Click to edit title';
    input.replaceWith(span);
    _panelTitle = span;
    span.addEventListener('click', () => _makeTitleEditable(titleField));
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = current; input.blur(); }
  });
}

// ════════════════════════════════════════════════════════════
// HEADER ACTION BUTTONS
// ════════════════════════════════════════════════════════════

function _renderHeaderActions() {
  if (!_headerActions || !_entity || !_config) return;

  _headerActions.innerHTML = '';
  const actions = _config.actions || [];

  const mkBtn = (icon, title, danger = false) => {
    const btn = document.createElement('button');
    btn.className = 'panel-icon-btn';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.textContent = icon;
    if (danger) btn.style.color = 'var(--color-danger)';
    return btn;
  };

  // ── PRIMARY: Complete (tasks and taskInstances) ─────────
  if (_entity.type === 'task' && _entity.status !== 'Done' && _entity.status !== 'Completed') { // SYS-05
    const btn = mkBtn('✓', 'Mark complete');
    btn.style.color = 'var(--color-success-text, #15803d)';
    btn.style.fontWeight = '600';
    btn.addEventListener('click', async () => {
      _entity.status = 'Completed'; // SYS-06
      _markDirty();
      await _save();
      _renderHeader();
      _renderActiveTab();
    });
    _headerActions.appendChild(btn);
  }

  // Complete for taskInstance — uses completeInstance (updates streak/count)
  if (_entity.type === 'taskInstance' && _entity.status !== 'Completed' && _entity.status !== 'Skipped') {
    const btn = mkBtn('✓', 'Complete this occurrence');
    btn.style.color = 'var(--color-success-text, #15803d)';
    btn.style.fontWeight = '600';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const { completeInstance } = await import('../services/recurrence.js');
        await completeInstance(_entity.id);
        _entity.status = 'Completed';
        _renderHeader();
        _renderActiveTab();
      } catch (err) {
        console.error('[panel] completeInstance from header:', err);
        btn.disabled = false;
      }
    });
    _headerActions.appendChild(btn);
  }

  // ── PRIMARY: Archive / Unarchive (not for taskInstance) ─
  if (!(_entity.type === 'taskInstance') && (actions.includes('archive') || actions.includes('edit'))) {
    const isArchived = _entity.status === 'Archived' || _entity.archived;
    const btn = mkBtn(isArchived ? '↑' : '📦', isArchived ? 'Unarchive' : 'Archive');
    btn.addEventListener('click', async () => {
      if (_entity.status !== undefined) {
        _entity.status = isArchived ? 'Active' : 'Archived';
      } else {
        _entity.archived = !isArchived;
      }
      _markDirty();
      await _save();
      _renderHeader();
      _renderActiveTab();
    });
    _headerActions.appendChild(btn);
  }

  // ── PRIMARY: Delete ─────────────────────────────────────
  if (actions.includes('delete')) {
    const btn = mkBtn('🗑️', 'Delete', true);
    btn.addEventListener('click', () => _confirmDelete());
    _headerActions.appendChild(btn);
  }

  // ── OVERFLOW MENU: Duplicate · Add to Project · Convert ─
  const overflowItems = [];
  if (actions.includes('duplicate'))     overflowItems.push({ label: 'Duplicate',       fn: _duplicateEntity });
  if (_entity.type !== 'project' && _entity.type !== 'taskInstance') overflowItems.push({ label: 'Add to Project',  fn: _showProjectPicker });
  if (actions.includes('convert'))       overflowItems.push({ label: 'Convert to…',     fn: _showConvertDropdown });

  if (overflowItems.length > 0) {
    const moreBtn = mkBtn('···', 'More actions');
    moreBtn.style.cssText = 'letter-spacing: -1px; font-size: 0.7rem; position: relative;';
    let _menu = null;

    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (_menu && document.contains(_menu)) { _menu.remove(); _menu = null; return; }

      _menu = document.createElement('div');
      _menu.style.cssText = `
        position: absolute; top: calc(100% + 4px); right: 0; z-index: 999;
        background: var(--color-bg); border: 1px solid var(--color-border);
        border-radius: var(--radius-sm); box-shadow: var(--shadow-md);
        padding: var(--space-1); min-width: 160px;
      `;
      for (const item of overflowItems) {
        const row = document.createElement('button');
        row.style.cssText = `
          display: block; width: 100%; text-align: left;
          padding: var(--space-1-5) var(--space-3); border: none; background: none;
          font-size: var(--text-sm); color: var(--color-text); cursor: pointer;
          border-radius: var(--radius-sm);
        `;
        row.textContent = item.label;
        row.addEventListener('mouseenter', () => row.style.background = 'var(--color-surface-2)');
        row.addEventListener('mouseleave', () => row.style.background = 'transparent');
        row.addEventListener('click', () => { _menu?.remove(); _menu = null; item.fn(); });
        _menu.appendChild(row);
      }

      // Append directly to moreBtn (which is position:relative)
      moreBtn.appendChild(_menu);

      const close = (ev) => {
        if (!_menu?.contains(ev.target) && ev.target !== moreBtn) {
          _menu?.remove(); _menu = null;
          document.removeEventListener('click', close);
        }
      };
      setTimeout(() => document.addEventListener('click', close), 0);
    });
    _headerActions.appendChild(moreBtn);
  }
}

async function _duplicateEntity() {
  if (!_entity) return;
  const sourceId = _entity.id;
  const dup = { ..._entity };
  delete dup.id; delete dup.createdAt; delete dup.updatedAt;
  delete dup.createdBy; // will be set to current user by saveEntity
  const titleK = _getTitleKey(dup.type);
  if (titleK && dup[titleK]) dup[titleK] += ' (copy)';
  const account = getAccount();
  const saved = await saveEntity(dup, account?.id);

  // Copy outgoing relation edges to the duplicate
  try {
    const srcEdges = await getEdgesFrom(sourceId);
    await Promise.all(srcEdges.map(edge =>
      saveEdge({
        fromId:   saved.id,
        fromType: saved.type,
        toId:     edge.toId,
        toType:   edge.toType,
        relation: edge.relation,
        metadata: edge.metadata,
      }, account?.id).catch(() => {})
    ));
  } catch { /* edge copy is best-effort */ }

  openPanel(saved.id);
}

/** Show a dropdown to pick a project and link this entity to it */
async function _showProjectPicker() {
  if (!_entity) return;

  // Create dropdown below the header actions
  const existing = document.querySelector('.panel-project-picker');
  if (existing) { existing.remove(); return; }

  const projects = (await getEntitiesByType('project')).filter(p => !p.deleted);

  const dropdown = document.createElement('div');
  dropdown.className = 'panel-project-picker';
  dropdown.style.cssText = `
    position: absolute; top: 100%; right: var(--space-4); z-index: 10;
    background: var(--color-bg); border: 1px solid var(--color-border);
    border-radius: var(--radius-md); box-shadow: var(--shadow-lg);
    padding: var(--space-2); min-width: 180px; max-height: 200px;
    overflow-y: auto;
  `;

  // Search input
  const projSearchInput = document.createElement('input');
  projSearchInput.type = 'text';
  projSearchInput.className = 'input';
  projSearchInput.placeholder = 'Search or create project…';
  projSearchInput.style.cssText = 'padding:var(--space-1-5) var(--space-2);font-size:var(--text-sm);margin-bottom:var(--space-1);width:100%;box-sizing:border-box;';
  dropdown.appendChild(projSearchInput);

  const projList = document.createElement('div');
  projList.style.cssText = 'max-height:160px;overflow-y:auto;';
  dropdown.appendChild(projList);

  const _renderProjList = (query) => {
    projList.innerHTML = '';
    const q = (query || '').toLowerCase().trim();
    const filtered = projects.filter(p => !p.deleted && (!q || (p.name || '').toLowerCase().includes(q)));

    // + Create new project button
    const createBtn = document.createElement('div');
    createBtn.style.cssText = 'padding:var(--space-1-5) var(--space-2);cursor:pointer;' +
      'font-size:var(--text-xs);font-weight:var(--weight-semibold);color:var(--color-accent);' +
      'border-bottom:1px solid var(--color-border);';
    createBtn.textContent = q ? `+ Create project "${query}"` : '+ New project…';
    createBtn.addEventListener('click', () => {
      dropdown.remove();
      openQuickCreateModal('project', { name: query || '' }, async newProj => {
        if (!newProj) return;
        await saveEdge({
          fromId:   _entity.id,
          fromType: _entity.type,
          toId:     newProj.id,
          toType:   'project',
          relation: 'project',
        }, getAccount()?.id);
        _renderActiveTab();
      });
    });
    projList.appendChild(createBtn);

    if (filtered.length === 0) {
      const noRes = document.createElement('div');
      noRes.style.cssText = 'font-size:var(--text-xs);color:var(--color-text-muted);padding:var(--space-2);';
      noRes.textContent = q ? 'No matching projects' : 'No projects yet — create one above';
      projList.appendChild(noRes);
    } else {
      for (const proj of filtered) {
        const item = document.createElement('div');
        item.style.cssText = `
          display: flex; align-items: center; gap: var(--space-2);
          padding: var(--space-1-5) var(--space-2); border-radius: var(--radius-sm);
          cursor: pointer; font-size: var(--text-sm);
          transition: background var(--transition-fast);
        `;
        item.textContent = `📁 ${proj.name || 'Untitled'}`;
        item.addEventListener('mouseenter', () => { item.style.background = 'var(--color-surface-2)'; });
        item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; });
        item.addEventListener('click', async () => {
          await saveEdge({
            fromId:   _entity.id,
            fromType: _entity.type,
            toId:     proj.id,
            toType:   'project',
            relation: 'project', // [B-02 fix] match 'project' relation queried by _buildProjectTaskEdgeMap
          }, getAccount()?.id);
          dropdown.remove();
          _renderActiveTab();
        });
        projList.appendChild(item);
      }
    }
  };

  _renderProjList('');
  projSearchInput.addEventListener('input', () => _renderProjList(projSearchInput.value));
  setTimeout(() => projSearchInput.focus(), 30);

  // Position relative to header
  // Anchor to the panel header — ensure position:relative
  const header = document.getElementById('entity-panel-header');
  if (header) {
    if (!header.style.position || header.style.position === 'static') {
      header.style.position = 'relative';
    }
    header.appendChild(dropdown);
  }

  // Close on outside click
  const closeHandler = (e) => {
    if (!dropdown.contains(e.target)) {
      dropdown.remove();
      document.removeEventListener('click', closeHandler, true);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler, true), 10);
}

/** Show convert type dropdown from header */
function _showConvertDropdown() {
  const existing = document.querySelector('.panel-convert-picker');
  if (existing) { existing.remove(); return; }

  const dropdown = document.createElement('div');
  dropdown.className = 'panel-convert-picker';
  dropdown.style.cssText = `
    position: absolute; top: 100%; right: var(--space-4); z-index: 10;
    background: var(--color-bg); border: 1px solid var(--color-border);
    border-radius: var(--radius-md); box-shadow: var(--shadow-lg);
    padding: var(--space-2); min-width: 180px; max-height: 250px;
    overflow-y: auto; display: flex; flex-wrap: wrap; gap: var(--space-1);
  `;

  const types = getAllEntityTypes();
  for (const t of types) {
    if (t.key === _entity.type) continue;
    const btn = document.createElement('button');
    btn.className   = 'btn btn-ghost btn-xs';
    btn.textContent = `${t.icon} ${t.label}`;
    btn.style.fontSize = 'var(--text-xs)';
    btn.addEventListener('click', async () => {
      try {
        const converted = await convertEntity(_entity.id, t.key);
        dropdown.remove();
        openPanel(converted.id);
      } catch (err) {
        console.error('[entity-panel] Convert failed:', err);
      }
    });
    dropdown.appendChild(btn);
  }

  const header = document.getElementById('entity-panel-header');
  if (header) {
    header.style.position = 'relative';
    header.appendChild(dropdown);
  }

  const closeHandler = (e) => {
    if (!dropdown.contains(e.target)) {
      dropdown.remove();
      document.removeEventListener('click', closeHandler, true);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler, true), 10);
}

// ════════════════════════════════════════════════════════════
// TABS
// ════════════════════════════════════════════════════════════

// ── Content-first entity types ────────────────────────────── //
// These types open in 'content' view by default (body/richtext prominent).
// All others open in 'properties' view.
const CONTENT_FIRST_TYPES = new Set([
  'note', 'idea', 'research', 'book', 'document', 'weblink',
  'trip', 'goal', 'habit', 'recipe', 'post', 'comment',
]);

// ── View definitions (icon toolbar) ──────────────────────── //
// 'graph' is NOT in this list — it gets its own direct-action button below
const VIEW_DEFS = [
  { key: 'content',    icon: '📄',  title: 'Content' },
  { key: 'properties', icon: '📝',  title: 'Properties' },
  { key: 'relations',  icon: '🔗',  title: 'Connections' }, // [v5.1.0] renamed to Connections
  { key: 'activity',   icon: '📋',  title: 'Change Log' }, // [MAJOR] renamed from Activity
];

// ════════════════════════════════════════════════════════════
// VIEW RENDERING (no tab bar — views driven by icon toolbar)
// ════════════════════════════════════════════════════════════

/**
 * Get the primary content/richtext field for an entity, or null.
 * Used to decide whether to show the Content view icon and whether
 * to render content-first.
 */
function _getContentField(entity, config) {
  if (!entity || !config) return null;
  // Find the first richtext field that is NOT the title
  const field = config.fields.find(f => f.type === 'richtext' && !f.isTitle);
  if (!field) return null;
  return field;
}

// Track which tab had which scroll position so switching back feels natural
const _tabScrollPos = {};

function _renderActiveTab() {
  if (!_panelBody) return;

  // Save current scroll position for the tab we're leaving
  const prevTab = _panelBody.dataset.renderedTab;
  if (prevTab) {
    _tabScrollPos[prevTab] = _panelBody.scrollTop;
  }

  _panelBody.innerHTML = '';
  _panelBody.dataset.renderedTab = _activeTab;

  const container = document.createElement('div');
  container.className = 'panel-view-container';
  container.style.cssText = 'padding: var(--space-5) var(--space-6); min-height: 200px;';
  _panelBody.appendChild(container);

  switch (_activeTab) {
    case 'content':    _renderContentView(container);    break;
    case 'properties': _renderPropertiesTab(container);  break;
    case 'relations':  _renderRelationsTab(container);   break;
    case 'activity':   _renderActivityTab(container);    break;
    case 'series':     _renderSeriesTab(container);      break; // [v5.3.1]
    case 'tasks':      _renderProjectTasksTab(container); break; // [v5.8.0]
    default:           _renderPropertiesTab(container);  break;
  }

  // BUG-1 fix: always remount activity stream after tab renders
  // (all callers that clear _panelBody need the stream re-attached)
  if (_entity) _mountActivityStream();

  // Restore scroll position if returning to a previously visited tab
  const savedScroll = _tabScrollPos[_activeTab] || 0;
  if (savedScroll > 0) {
    requestAnimationFrame(() => { _panelBody.scrollTop = savedScroll; });
  }
}

/**
 * Content view — renders the primary richtext/body field prominently,
 * plus all non-title non-richtext fields as a compact property strip below.
 */
function _renderContentView(container) {
  if (!_entity || !_config) return;

  const contentField = _getContentField(_entity, _config);
  if (!contentField) {
    // Fallback: show properties if no content field
    _renderPropertiesTab(container);
    return;
  }

  // ── Content editor ───────────────────────────────────────
  const editorWrap = document.createElement('div');
  editorWrap.style.cssText = 'margin-bottom: var(--space-6);';

  const value = _entity[contentField.key];

  const editor = document.createElement('div');
  editor.contentEditable = 'true';
  editor.setAttribute('role', 'textbox');
  editor.setAttribute('aria-multiline', 'true');
  editor.setAttribute('aria-label', contentField.label);
  editor.setAttribute('data-placeholder', `Start writing ${contentField.label.toLowerCase()}…`);
  editor.style.cssText = `
    min-height: 220px;
    font-size: var(--text-sm);
    line-height: 1.75;
    color: var(--color-text);
    outline: none;
    white-space: pre-wrap;
    word-break: break-word;
  `;
  // Sanitize content to prevent XSS from sync'd data
  if (value) {
    const _dp37 = new DOMParser();
    const _doc37 = _dp37.parseFromString(value, 'text/html');
    _doc37.querySelectorAll('script,iframe,object,embed').forEach(el => el.remove());
    editor.innerHTML = _doc37.body.innerHTML;
  } else {
    editor.innerHTML = '';
  }

  editor.className = 'panel-content-editor';

  // Inject placeholder style once — guard against duplicates
  if (!document.getElementById('panel-content-editor-style')) {
    const editorStyle = document.createElement('style');
    editorStyle.id = 'panel-content-editor-style';
    editorStyle.textContent = `
      .panel-content-editor:empty:before {
        content: attr(data-placeholder);
        color: var(--color-text-muted);
        pointer-events: none;
      }
    `;
    document.head.appendChild(editorStyle);
  }

  // Capture snapshot of entity and field key at render time to prevent stale closure
  const _capturedEntity     = _entity;
  const _capturedFieldKey   = contentField.key;

  let _saveDebounce = null;
  const schedSave = () => {
    clearTimeout(_saveDebounce);
    _saveDebounce = setTimeout(async () => {
      // Only save if panel still shows the same entity
      if (_entity !== _capturedEntity) return;
      _capturedEntity[_capturedFieldKey] = editor.innerHTML;
      _markDirty();
      await _save();
    }, 800);
  };
  editor.addEventListener('input', schedSave);
  editor.addEventListener('blur', async () => {
    clearTimeout(_saveDebounce);
    if (_entity !== _capturedEntity) return;
    _capturedEntity[_capturedFieldKey] = editor.innerHTML;
    _markDirty();
    await _save();
  });

  editorWrap.appendChild(editor);
  container.appendChild(editorWrap);

  // ── Compact property strip (non-title fields, excluding the content field itself) ──
  const otherFields = _config.fields.filter(f =>
    !f.isTitle && f.key !== contentField.key
  );

  if (otherFields.length > 0) {
    const strip = document.createElement('div');
    strip.style.cssText = `
      border-top: 1px solid var(--color-border);
      padding-top: var(--space-4);
      display: flex;
      flex-direction: column;
      gap: 0;
    `;

    for (const field of otherFields) {
      const row = _createFieldRow(field);
      strip.appendChild(row);
    }

    // Metadata
    const meta = document.createElement('div');
    meta.style.cssText = 'margin-top: var(--space-4); padding-top: var(--space-3); border-top: 1px solid var(--color-border);';
    meta.innerHTML = `
      <div style="font-size: var(--text-xs); color: var(--color-text-muted); display: flex; flex-direction: column; gap: var(--space-1);">
        <span>Created: ${_formatTimestamp(_entity.createdAt)}</span>
        <span>Updated: ${_formatTimestamp(_entity.updatedAt)}</span>
        <span style="opacity:0.5;">ID: ${_entity.id}</span>
      </div>
    `;
    strip.appendChild(meta);
    container.appendChild(strip);
  }
}

// ════════════════════════════════════════════════════════════
// PROPERTIES TAB
// ════════════════════════════════════════════════════════════

function _renderPropertiesTab(container) {
  if (!_entity || !_config) return;

  const list = document.createElement('div');
  list.className = 'panel-props';

  for (const field of _config.fields) {
    if (field.isTitle) continue; // Title is in header
    if (field.hidden)  continue; // Hidden fields (e.g. timeTracked) handled by dedicated widgets
    const row = _createFieldRow(field);
    list.appendChild(row);
  }

  // Metadata footer
  const meta = document.createElement('div');
  meta.className = 'panel-meta';
  meta.style.cssText = 'margin-top: var(--space-6); padding-top: var(--space-4); border-top: 1px solid var(--color-border);';
  meta.innerHTML = `
    <div style="font-size: var(--text-xs); color: var(--color-text-muted); display: flex; flex-direction: column; gap: var(--space-1);">
      <span>Created: ${_formatTimestamp(_entity.createdAt)}</span>
      <span>Updated: ${_formatTimestamp(_entity.updatedAt)}</span>
      <span style="opacity: 0.6;">ID: ${_entity.id}</span>
    </div>
  `;

  container.appendChild(list);
  container.appendChild(meta);

  // [v5.0.0] Reminder strip + quick-set footer
  // Skip for reminders themselves and reminderLog entries
  // 3P-L-03 fix: _NO_REMINDER_TYPES is now module-level (not re-created per render)
  if (_entity && !_NO_REMINDER_TYPES.has(_entity.type)) {
    // NEW-M-03: async function called from sync context — catch for error visibility
    _renderReminderFooter(container, _entity).catch(err => console.warn('[entity-panel] reminder footer failed:', err));
  }
}

/**
 * [v5.0.0] Render the reminder quick-set widget + chip strip in the panel footer.
 * Reads from module-level _entity (not a prop) — consistent with rest of panel.
 */
async function _renderReminderFooter(container, entity) {
  const footer = document.createElement('div');
  footer.className = 'panel-reminder-footer';
  footer.style.cssText = 'margin-top:16px;padding-top:12px;border-top:1px solid var(--color-border,#e2e8f0);';

  // Load active reminders for this entity via graph edges
  // Uses dual-lookup: compound index first, simple index fallback.
  // Checks entity type='reminder' rather than fromType (may be absent on old edges).
  let activeReminders = [];
  try {
    let edges = await getEdgesTo(entity.id, 'reminds').catch(() => []);
    if (!edges.length) {
      const allIncoming = await getEdgesTo(entity.id).catch(() => []);
      edges = allIncoming.filter(e => e.relation === 'reminds');
    }
    const all = await Promise.all(edges.map(e => getEntity(e.fromId).catch(() => null)));
    // Show active and snoozed reminders in panel footer
    activeReminders = all.filter(r => r && r.type === 'reminder' && (r.status === 'active' || r.status === 'snoozed'));
  } catch (err) { console.warn('[entity-panel] reminder footer load failed:', err); }

  const chipHtml = activeReminders.slice(0, 3).map(r => {
    const { rruleToHuman: rth } = { rruleToHuman: (x) => x ? '🔁' : '' };
    const fireLabel = r.nextFireAt ? _formatFireAt(r.nextFireAt) : '—';
    const pColor   = { Urgent:'#ef4444', High:'#f59e0b', Normal:'#3b82f6', Low:'#94a3b8' }[r.priority] || '#94a3b8';
    return `<div style="display:flex;align-items:center;gap:6px;padding:5px 8px;
      border-radius:6px;border:1px solid var(--color-border,#e2e8f0);font-size:0.75rem;
      background:var(--color-surface-raised,#f8fafc);flex-wrap:wrap;">
      <span style="width:8px;height:8px;border-radius:50%;background:${pColor};flex-shrink:0;display:inline-block;"></span>
      <span style="font-weight:500;">${r.title || 'Reminder'}</span>
      <span style="color:var(--color-text-muted,#94a3b8);">${fireLabel}</span>
      ${r.rrule ? '<span style="color:var(--color-text-muted,#94a3b8);">🔁</span>' : ''}
      <button class="rm-chip-edit" data-rid="${r.id}"
        style="border:none;background:none;cursor:pointer;padding:2px 4px;font-size:0.7rem;color:var(--color-text-muted,#64748b);">✏️</button>
      <button class="rm-chip-dismiss" data-rid="${r.id}"
        style="border:none;background:none;cursor:pointer;padding:2px 4px;font-size:0.7rem;color:var(--color-danger,#ef4444);">✕</button>
    </div>`;
  }).join('');

  const moreCount = activeReminders.length > 3 ? activeReminders.length - 3 : 0;

  footer.innerHTML = `
    <div style="margin-bottom:8px;">
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;">
        ${chipHtml}
        ${moreCount > 0 ? `<button class="rm-view-all" style="font-size:0.73rem;color:var(--color-primary,#4f8ef7);background:none;border:none;cursor:pointer;">+${moreCount} more…</button>` : ''}
      </div>
      <button class="rm-quick-add" style="
        font-size:0.8rem;padding:6px 14px;border-radius:20px;
        border:1px dashed var(--color-border,#cbd5e1);cursor:pointer;
        background:transparent;color:var(--color-text-muted,#64748b);
        display:flex;align-items:center;gap:6px;width:100%;justify-content:center;">
        🔔 Add Reminder
      </button>
    </div>
    <div class="rm-quick-set" style="display:none;margin-top:8px;">
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">
        <button class="rm-preset" data-offset="600000" style="${_rmPresetBtn()}">In 10m</button>
        <button class="rm-preset" data-offset="3600000" style="${_rmPresetBtn()}">In 1h</button>
        <button class="rm-preset" data-tomorrow="1" style="${_rmPresetBtn()}">Tomorrow 9am</button>
        <button class="rm-preset" data-custom="1" style="${_rmPresetBtn()}">Custom…</button>
      </div>
      <button class="rm-quick-save" style="
        width:100%;padding:7px;border-radius:8px;border:none;cursor:pointer;
        background:var(--color-primary,#4f8ef7);color:#fff;font-size:0.85rem;font-weight:600;">
        🔔 Set reminder for "${(entity.title || entity.name || 'this').slice(0, 30)}${(entity.title || entity.name || '').length > 30 ? '…' : ''}"
      </button>
    </div>
  `;

  container.appendChild(footer);

  // H-08 fix: subscribe to reminder events so chips refresh when a reminder fires/updates
  // outside the panel (e.g. scheduler fires while entity panel is open).
  const _footerUnsubs = [];
  const _refreshFooter = () => {
    if (!footer.isConnected) {
      _footerUnsubs.forEach(fn => { try { fn(); } catch {} });
      return;
    }
    footer.remove();
    _renderReminderFooter(container, entity);
  };
  _footerUnsubs.push(on(EVENTS.REMINDER_FIRED,     _refreshFooter));
  _footerUnsubs.push(on(EVENTS.REMINDER_UPDATED,   _refreshFooter));
  _footerUnsubs.push(on(EVENTS.REMINDER_CREATED,   _refreshFooter));
  _footerUnsubs.push(on(EVENTS.REMINDER_DISMISSED, _refreshFooter));

  let _selectedOffset = 3600000; // default 1h

  // Wire quick-add toggle
  footer.querySelector('.rm-quick-add')?.addEventListener('click', () => {
    const qs = footer.querySelector('.rm-quick-set');
    if (qs) qs.style.display = qs.style.display === 'none' ? 'block' : 'none';
  });

  // Wire preset buttons
  footer.querySelectorAll('.rm-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.custom) {
        // Open full form
        import('./reminder-form.js').then(m => m.openReminderForm({ targetEntity: entity })).catch(console.error);
        return;
      }
      _selectedOffset = btn.dataset.tomorrow ? null : parseInt(btn.dataset.offset, 10);
      footer.querySelectorAll('.rm-preset').forEach(b => b.style.background = 'transparent');
      btn.style.background = 'var(--color-primary-light,#eff6ff)';
    });
  });

  // Wire save
  footer.querySelector('.rm-quick-save')?.addEventListener('click', async () => {
    try {
      const { createReminder } = await import('../services/reminder.js');
      const now = new Date();
      let fireAt;
      if (_selectedOffset === null) {
        // Tomorrow 9am
        const tom = new Date(now.getFullYear(), now.getMonth(), now.getDate()+1, 9, 0, 0);
        const p = n => String(n).padStart(2,'0');
        fireAt = `${tom.getFullYear()}-${p(tom.getMonth()+1)}-${p(tom.getDate())}T09:00:00`;
      } else {
        const d = new Date(now.getTime() + _selectedOffset);
        const p = n => String(n).padStart(2,'0');
        fireAt = `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
      }
      await createReminder({
        title:      entity.title || entity.name || 'Reminder',
        fireAt,
        status:     'active',
        nextFireAt: fireAt,
      }, entity.id);
      // H-08 fix: clean up event subscriptions before refresh
      _footerUnsubs.forEach(fn => { try { fn(); } catch {} });
      footer.remove();
      // L-04 fix: only re-render if container is still attached to DOM
      if (container.isConnected) _renderReminderFooter(container, entity);
    } catch (err) {
      console.error('[entity-panel] Quick reminder save failed:', err);
    }
  });

  // Wire chip edit buttons
  footer.querySelectorAll('.rm-chip-edit').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      import('./reminder-form.js').then(m => m.openReminderForm({ reminderId: btn.dataset.rid })).catch(console.error);
    });
  });

  // Wire chip dismiss buttons
  footer.querySelectorAll('.rm-chip-dismiss').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const svc = window._fhEnv?.services?.reminder;
      if (svc) {
        await svc.dismiss(btn.dataset.rid);
        // H-08 fix: clean up event subscriptions before refresh
        _footerUnsubs.forEach(fn => { try { fn(); } catch {} });
        footer.remove();
        // L-04 fix: only re-render if container is still attached to DOM
        if (container.isConnected) _renderReminderFooter(container, entity);
      }
    });
  });

  // Wire "view all" → navigate to reminders view
  footer.querySelector('.rm-view-all')?.addEventListener('click', () => {
    import('../core/router.js').then(m => m.navigate('reminders')).catch(console.error);
  });
}

function _rmPresetBtn() {
  return 'font-size:0.75rem;padding:5px 12px;border-radius:20px;border:1px solid var(--color-border,#e2e8f0);cursor:pointer;background:transparent;';
}

function _formatFireAt(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso.includes('T') ? iso : iso + 'T00:00:00');
    const now = new Date();
    const ms = d - now;
    if (ms < 0) return 'overdue';
    const m = Math.floor(ms / 60000);
    if (m < 60) return `in ${m}m`;
    if (m < 1440) return `in ${Math.floor(m/60)}h`;
    return `in ${Math.floor(m/1440)}d`;
  } catch { return iso; }
}

/**
 * Create a single field row: label + inline-editable value.
 */
function _createFieldRow(field) {
  const row = document.createElement('div');
  row.className = 'panel-field-row';
  row.dataset.fieldKey = field.key;  // enables _applyOnChanges highlight flash
  row.style.cssText = `
    display: flex; align-items: flex-start; gap: var(--space-3);
    padding: var(--space-2) 0;
    border-bottom: 1px solid color-mix(in srgb, var(--color-border) 50%, transparent);
    min-height: 36px;
  `;

  // Label
  const label = document.createElement('label');
  label.className   = 'panel-field-label';
  label.textContent = field.label;
  label.style.cssText = `
    width: 110px; flex-shrink: 0;
    font-size: var(--text-xs); font-weight: var(--weight-medium);
    color: var(--color-text-muted); padding-top: var(--space-1-5);
    text-transform: uppercase; letter-spacing: 0.04em;
  `;

  // Value area
  const valueWrap = document.createElement('div');
  valueWrap.className = 'panel-field-value';
  valueWrap.style.cssText = 'flex: 1; min-width: 0;';

  _renderFieldValue(valueWrap, field);

  row.appendChild(label);
  row.appendChild(valueWrap);
  return row;
}

/**
 * Render the display state of a field value.
 * Click turns it into an editable input.
 */
function _renderFieldValue(wrap, field) {
  wrap.innerHTML = '';
  // GUARD: For field named 'type', read from _subtype to avoid collision
  const value = field.key === 'type' ? (_entity._subtype ?? _entity[field.key]) : _entity[field.key];

  switch (field.type) {

    // ── SELECT ──────────────────────────────────────────── //
    case 'select': {
      const display = document.createElement('span');
      display.className = 'panel-field-display';
      display.style.cssText = `
        cursor: pointer; padding: var(--space-1) var(--space-2);
        border-radius: var(--radius-sm); font-size: var(--text-sm);
        display: inline-block; min-width: 60px;
        transition: background var(--transition-fast);
      `;
      display.textContent = value || '—';
      if (value) {
        display.style.background = 'var(--color-surface-2)';
        display.style.color      = 'var(--color-text)';
      } else {
        display.style.color = 'var(--color-text-muted)';
      }

      display.addEventListener('click', () => {
        _editSelect(wrap, field);
      });
      wrap.appendChild(display);
      break;
    }

    // ── RELATION ────────────────────────────────────────── //
    case 'relation': {
      _renderRelationChips(wrap, field);
      break;
    }

    // ── TAGS ────────────────────────────────────────────── //
    case 'tags': {
      _renderTagChips(wrap, field);
      break;
    }

    // ── CHECKBOX ────────────────────────────────────────── //
    case 'checkbox': {
      const cb = document.createElement('input');
      cb.type    = 'checkbox';
      cb.checked = !!value;
      cb.style.cssText = 'cursor: pointer; width: 18px; height: 18px; accent-color: var(--color-accent);';
      cb.addEventListener('change', async () => {
        _entity[field.key] = cb.checked;
        _markDirty();
        await _save();
      });
      wrap.appendChild(cb);
      break;
    }

    // ── CHECKLIST ────────────────────────────────────────── //
    case 'checklist': {
      const items = Array.isArray(value) ? value : [];

      if (!items.length) {
        const empty = document.createElement('span');
        empty.textContent = 'No items — open form to add';
        empty.style.cssText = 'font-size:var(--text-sm);color:var(--color-text-muted);';
        wrap.appendChild(empty);
        break;
      }

      const list = document.createElement('div');
      list.style.cssText = 'display:flex;flex-direction:column;gap:var(--space-1-5);';

      // Live-updating progress bar + counter — matches kanban K-02 visual style
      const prog = document.createElement('div');
      prog.style.cssText = 'margin-top:var(--space-2);';
      prog.innerHTML = `
        <div style="display:flex;align-items:center;gap:6px;">
          <span class="panel-cl-count" style="font-size:var(--text-xs);font-weight:var(--weight-semibold);color:var(--color-text-muted);min-width:32px;">0/${items.length}</span>
          <div style="flex:1;height:5px;background:var(--color-border);border-radius:99px;overflow:hidden;">
            <div class="panel-cl-fill" style="height:100%;background:var(--color-accent);border-radius:99px;transition:width 0.25s ease;width:0%"></div>
          </div>
        </div>
      `;
      const _clCount = prog.querySelector('.panel-cl-count');
      const _clFill  = prog.querySelector('.panel-cl-fill');
      const _updateProg = () => {
        const current = Array.isArray(_entity[field.key]) ? _entity[field.key] : [];
        const doneCount = current.filter(it => it.done).length;
        const pct = items.length ? Math.round((doneCount / items.length) * 100) : 0;
        const complete = doneCount === items.length && items.length > 0;
        if (_clCount) {
          _clCount.textContent = `${doneCount}/${items.length}`;
          _clCount.style.color = complete ? 'var(--color-success)' : 'var(--color-text-muted)';
        }
        if (_clFill) {
          _clFill.style.width = `${pct}%`;
          _clFill.style.background = complete ? 'var(--color-success)' : 'var(--color-accent)';
        }
      };
      _updateProg();

      items.forEach((item, i) => {
        const row = document.createElement('label');
        row.style.cssText = 'display:flex;align-items:center;gap:var(--space-2);cursor:pointer;';

        const cb = document.createElement('input');
        cb.type    = 'checkbox';
        cb.checked = !!item.done;
        cb.style.cssText = 'width:15px;height:15px;flex-shrink:0;accent-color:var(--color-accent);cursor:pointer;';

        const txt = document.createElement('span');
        txt.textContent = item.text || '(empty)';
        txt.style.cssText = 'font-size:var(--text-sm);'
          + (item.done
            ? 'text-decoration:line-through;color:var(--color-text-muted);'
            : 'color:var(--color-text);');

        cb.addEventListener('change', async () => {
          // Guard: item may not exist if entity was updated externally
          const current = Array.isArray(_entity[field.key]) ? _entity[field.key] : [];
          if (!current[i]) return;
          // Optimistic update
          const updated = current.map((it, idx) =>
            idx === i ? { ...it, done: cb.checked } : it
          );
          _entity[field.key] = updated;
          txt.style.textDecoration = cb.checked ? 'line-through' : 'none';
          txt.style.color = cb.checked ? 'var(--color-text-muted)' : 'var(--color-text)';
          _updateProg(); // keep progress counter live
          try {
            _markDirty();
            await _save();
          } catch (err) {
            // Revert on failure
            cb.checked = !cb.checked;
            const reverted = (Array.isArray(_entity[field.key]) ? _entity[field.key] : [])
              .map((it, idx) => idx === i ? { ...it, done: cb.checked } : it);
            _entity[field.key] = reverted;
            txt.style.textDecoration = cb.checked ? 'line-through' : 'none';
            txt.style.color = cb.checked ? 'var(--color-text-muted)' : 'var(--color-text)';
            _updateProg();
          }
        });

        row.append(cb, txt);
        list.appendChild(row);
      });

      wrap.appendChild(list);
      wrap.appendChild(prog);
      break;
    }

    // ── RICHTEXT ────────────────────────────────────────── //
    case 'richtext': {
      const display = document.createElement('div');
      display.className = 'panel-field-display';
      display.style.cssText = `
        cursor: pointer; padding: var(--space-1-5) var(--space-2);
        border-radius: var(--radius-sm); font-size: var(--text-sm);
        color: ${value ? 'var(--color-text)' : 'var(--color-text-muted)'};
        word-break: break-word; max-height: 120px;
        overflow: hidden; line-height: var(--leading-relaxed);
        transition: background var(--transition-fast);
      `;
      // Use innerHTML to render HTML content; fall back to placeholder text
      if (value) {
        display.innerHTML = value;
      } else {
        display.textContent = 'Click to edit…';
      }

      display.addEventListener('click', () => {
        _editRichtext(wrap, field);
      });
      wrap.appendChild(display);
      break;
    }

    // ── NUMBER ──────────────────────────────────────────── //
    case 'number': {
      const display = document.createElement('span');
      display.className = 'panel-field-display';
      display.style.cssText = `
        cursor: pointer; padding: var(--space-1) var(--space-2);
        border-radius: var(--radius-sm); font-size: var(--text-sm);
        display: inline-block;
      `;
      display.textContent = value != null ? String(value) : '—';
      display.style.color = value != null ? 'var(--color-text)' : 'var(--color-text-muted)';

      display.addEventListener('click', () => {
        _editText(wrap, field, 'number');
      });
      wrap.appendChild(display);
      break;
    }

    // ── DATE / DATETIME ─────────────────────────────────── //
    case 'date': {
      const display = document.createElement('span');
      display.className = 'panel-field-display';
      display.style.cssText = `
        cursor: pointer; padding: var(--space-1) var(--space-2);
        border-radius: var(--radius-sm); font-size: var(--text-sm);
        display: inline-block;
      `;
      display.textContent = value ? _formatDate(value) : '—';
      display.style.color = value ? 'var(--color-text)' : 'var(--color-text-muted)';

      display.addEventListener('click', () => {
        _editDate(wrap, field);
      });
      wrap.appendChild(display);
      break;
    }

    case 'datetime': {
      const display = document.createElement('span');
      display.className = 'panel-field-display';
      display.style.cssText = `
        cursor: pointer; padding: var(--space-1) var(--space-2);
        border-radius: var(--radius-sm); font-size: var(--text-sm);
        display: inline-block;
      `;
      // Show date + time for datetime fields
      display.textContent = value
        ? new Date(value).toLocaleString(undefined, {
            year: 'numeric', month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit', hour12: true,
          })
        : '—';
      display.style.color = value ? 'var(--color-text)' : 'var(--color-text-muted)';

      display.addEventListener('click', () => {
        _editDate(wrap, field);
      });
      wrap.appendChild(display);
      break;
    }

    // ── TIME ────────────────────────────────────────────── //
    case 'time': {
      const display = document.createElement('span');
      display.className = 'panel-field-display';
      display.style.cssText = `
        cursor: pointer; padding: var(--space-1) var(--space-2);
        border-radius: var(--radius-sm); font-size: var(--text-sm);
        display: inline-block;
      `;

      // Format "HH:MM" → "6:00 AM" for display
      if (value) {
        const [hh, mm] = value.split(':').map(Number);
        const ampm = hh >= 12 ? 'PM' : 'AM';
        const h12  = hh === 0 ? 12 : hh > 12 ? hh - 12 : hh;
        display.textContent = `${h12}:${String(mm).padStart(2,'0')} ${ampm}`;
        display.style.color = 'var(--color-text)';
      } else {
        display.textContent = '—';
        display.style.color = 'var(--color-text-muted)';
      }

      display.addEventListener('click', () => _editTime(wrap, field));
      wrap.appendChild(display);
      break;
    }

    // ── URL ──────────────────────────────────────────────── //
    case 'url': {
      if (value) {
        const link = document.createElement('a');
        link.href        = value;
        link.target       = '_blank';
        link.rel          = 'noopener noreferrer';
        link.textContent  = _truncate(value, 40);
        link.style.cssText = 'font-size: var(--text-sm); color: var(--color-text-link); word-break: break-all;';
        wrap.appendChild(link);

        const editBtn = document.createElement('button');
        editBtn.textContent = '✎';
        editBtn.className   = 'btn-icon btn-xs';
        editBtn.style.cssText = 'margin-left: var(--space-1); font-size: var(--text-xs);';
        editBtn.addEventListener('click', () => _editText(wrap, field, 'url'));
        wrap.appendChild(editBtn);
      } else {
        const display = document.createElement('span');
        display.textContent = '—';
        display.style.cssText = 'cursor: pointer; font-size: var(--text-sm); color: var(--color-text-muted); padding: var(--space-1) var(--space-2);';
        display.addEventListener('click', () => _editText(wrap, field, 'url'));
        wrap.appendChild(display);
      }
      break;
    }

    // ── TEXT / EMAIL / PHONE / DEFAULT ───────────────────── //
    default: {
      const display = document.createElement('span');
      display.className = 'panel-field-display';
      display.style.cssText = `
        cursor: pointer; padding: var(--space-1) var(--space-2);
        border-radius: var(--radius-sm); font-size: var(--text-sm);
        display: inline-block; word-break: break-word;
      `;
      display.textContent = value || '—';
      display.style.color = value ? 'var(--color-text)' : 'var(--color-text-muted)';

      const inputType = field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : 'text';
      display.addEventListener('click', () => {
        _editText(wrap, field, inputType);
      });
      wrap.appendChild(display);
      break;
    }
  }
}

// ── Inline edit helpers ──────────────────────────────────── //

function _editText(wrap, field, inputType = 'text') {
  const current = _entity[field.key] ?? '';
  wrap.innerHTML = '';

  const input = document.createElement('input');
  input.type      = inputType;
  input.value     = current;
  input.className = 'input';
  input.style.cssText = 'padding: var(--space-1) var(--space-2); font-size: var(--text-sm);';
  wrap.appendChild(input);
  input.focus();

  const commit = async () => {
    let val = input.value.trim();
    if (inputType === 'number') val = val === '' ? null : Number(val);
    if (val !== current) {
      _entity[field.key] = val || null;
      _markDirty();
      await _save();
    }
    _renderFieldValue(wrap, field);
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = current; input.blur(); }
  });
}

function _editSelect(wrap, field) {
  // GUARD: For field named 'type', use _subtype
  const current = field.key === 'type' ? (_entity._subtype ?? '') : (_entity[field.key] ?? '');
  wrap.innerHTML = '';

  const select = document.createElement('select');
  select.className = 'select';
  select.style.cssText = 'padding: var(--space-1) var(--space-2); font-size: var(--text-sm);';

  // Empty option
  const emptyOpt   = document.createElement('option');
  emptyOpt.value   = '';
  emptyOpt.textContent = '— None —';
  select.appendChild(emptyOpt);

  for (const opt of (field.options || [])) {
    const o = document.createElement('option');
    o.value       = opt;
    o.textContent = opt;
    if (opt === current) o.selected = true;
    select.appendChild(o);
  }

  wrap.appendChild(select);
  select.focus();

  const commit = async () => {
    const val = select.value;
    if (val !== current) {
      if (field.key === 'type') {
        _entity._subtype = val || null;
      } else {
        _entity[field.key] = val || null;
      }
      _markDirty();
      await _applyOnChanges(field.key, val || null);  // P-27: cascade urgency etc.
      await _save();
    }
    _renderFieldValue(wrap, field);
  };

  select.addEventListener('blur', commit);
  select.addEventListener('change', () => select.blur());
  select.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { select.value = current; select.blur(); }
  });
}

// Date fields whose change should trigger DR edge re-wiring
const DR_DATE_FIELDS = new Set(['dueDate', 'date', 'startDate']);

function _editDate(wrap, field) {
  const current = _entity[field.key] ?? '';
  wrap.innerHTML = '';

  const input = document.createElement('input');
  input.type      = field.type === 'datetime' ? 'datetime-local' : 'date';
  input.className = 'input';
  input.style.cssText = 'padding: var(--space-1) var(--space-2); font-size: var(--text-sm);';

  // Convert ISO to input-friendly format
  if (current) {
    if (field.type === 'datetime') {
      input.value = current.slice(0, 16); // 'YYYY-MM-DDTHH:mm'
    } else {
      input.value = current.slice(0, 10); // 'YYYY-MM-DD'
    }
  }

  wrap.appendChild(input);
  input.focus();

  const commit = async () => {
    const val = input.value;
    // For 'datetime' fields: val is 'YYYY-MM-DDTHH:mm' (local time from browser input).
    // new Date(val) treats it as UTC in some engines → date shifts in negative TZ.
    // Use explicit local-time construction to preserve the user's intended date/time.
    let isoVal = null;
    if (val) {
      if (field.type === 'datetime') {
        // Parse as local time: 'YYYY-MM-DDTHH:mm' → local Date → ISO string
        const [datePart, timePart = '00:00'] = val.split('T');
        const [y, mo, d] = datePart.split('-').map(Number);
        const [h, mi]    = timePart.split(':').map(Number);
        isoVal = new Date(y, mo - 1, d, h, mi).toISOString();
      } else {
        isoVal = val; // 'date' fields store YYYY-MM-DD directly — no TZ issue
      }
    }
    if (isoVal !== current) {
      // Capture old/new date strings BEFORE mutating entity, for DR edge update
      const oldDateStr = DR_DATE_FIELDS.has(field.key) ? _isoToLocalDate(current) : null;
      const newDateStr = DR_DATE_FIELDS.has(field.key) ? _isoToLocalDate(isoVal) : null;

      _entity[field.key] = isoVal;
      _markDirty();
      await _applyOnChanges(field.key, isoVal);  // P-27
      await _save();

      // Rewire Daily Review edges when a canonical date field changes
      if (DR_DATE_FIELDS.has(field.key) && oldDateStr !== newDateStr) {
        _updateDailyReviewEdgesForDateChange(_entity, field.key, oldDateStr, newDateStr)
          .catch(err => console.warn('[entity-panel] DR edge update failed:', err));
      }
    }
    _renderFieldValue(wrap, field);
  };

  input.addEventListener('blur', commit);
  input.addEventListener('change', () => input.blur());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.value = current; input.blur(); }
  });
}

function _editTime(wrap, field) {
  // Guard: dueTime requires dueDate — without it the task disappears from calendar
  if (field.key === 'dueTime' && !_entity.dueDate) {
    wrap.innerHTML = '';
    const msg = document.createElement('span');
    msg.style.cssText = 'font-size:var(--text-sm);color:var(--color-warning-text);padding:var(--space-1) var(--space-2);';
    msg.textContent = '⚠ Set a Due Date first';
    wrap.appendChild(msg);
    // Auto-clear after 2.5s
    setTimeout(() => _renderFieldValue(wrap, field), 2500);
    return;
  }

  const current = _entity[field.key] ?? '06:00';
  wrap.innerHTML = '';

  const input = document.createElement('input');
  input.type      = 'time';
  input.className = 'input';
  input.step      = '600'; // 10-minute increments
  input.value     = current.slice(0, 5); // 'HH:MM'
  input.style.cssText = 'padding: var(--space-1) var(--space-2); font-size: var(--text-sm); width: 130px;';
  wrap.appendChild(input);
  input.focus();

  const commit = async () => {
    const val = input.value || '06:00';
    if (val !== current) {
      _entity[field.key] = val;
      // Update _dateTimeISO so calendar immediately reflects the new time
      if (field.key === 'dueTime' && _entity.dueDate) {
        _entity._dateTimeISO = `${_entity.dueDate}T${val}:00`;
      }
      _markDirty();
      await _save();
    }
    _renderFieldValue(wrap, field);
  };

  input.addEventListener('blur', commit);
  input.addEventListener('change', () => input.blur());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.value = current; input.blur(); }
  });
}

function _editRichtext(wrap, field) {
  const current = _entity[field.key] ?? '';
  wrap.innerHTML = '';

  // Use contenteditable div to preserve HTML formatting (bold, italic, lists from Quill)
  const editor = document.createElement('div');
  editor.contentEditable = 'true';
  editor.className = 'panel-richtext-inline-editor';
  editor.style.cssText = `
    padding: var(--space-2); font-size: var(--text-sm); min-height: 80px;
    border: 1px solid var(--color-accent); border-radius: var(--radius-sm);
    outline: none; line-height: var(--leading-relaxed);
    color: var(--color-text); background: var(--color-bg);
    word-break: break-word; white-space: pre-wrap;
    resize: vertical; overflow-y: auto; max-height: 320px;
  `;
  editor.innerHTML = current;
  wrap.appendChild(editor);

  // Focus and place cursor at end
  editor.focus();
  const range = document.createRange();
  const sel = window.getSelection();
  range.selectNodeContents(editor);
  range.collapse(false);
  sel?.removeAllRanges();
  sel?.addRange(range);

  const commit = async () => {
    const val = editor.innerHTML;
    // Treat empty editor (just <br> or empty) as null
    const cleaned = (val === '<br>' || val === '' || val === '<div><br></div>') ? null : val;
    if (cleaned !== (current || null)) {
      _entity[field.key] = cleaned;
      _markDirty();
      await _save();
    }
    _renderFieldValue(wrap, field);
  };

  editor.addEventListener('blur', commit);
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      editor.innerHTML = current;
      editor.removeEventListener('blur', commit);
      _renderFieldValue(wrap, field);
    }
    // Allow Enter for newlines — no commit on Enter
  });
}

// ── Relation chips ───────────────────────────────────────── //

async function _renderRelationChips(wrap, field) {
  wrap.innerHTML = '';

  const chipContainer = document.createElement('div');
  chipContainer.style.cssText = 'display: flex; flex-wrap: wrap; gap: var(--space-1); align-items: center;';

  // Guard: capture entity ID before any await — panel may close mid-async
  if (!_entity) return;
  const _entityIdForChips = _entity.id;

  // Get edges from this entity for this relation field
  const edges = await getEdgesFrom(_entityIdForChips, field.key);

  // Guard: entity panel may have been closed or navigated away during await
  if (!_entity || _entity.id !== _entityIdForChips) return;

  // Resolve all linked entities concurrently (O(1) vs O(n) sequential IDB reads)
  const linkedEntities = await Promise.all(
    edges.map(edge => getEntity(edge.toId).catch(() => null))
  );

  for (let i = 0; i < edges.length; i++) {
    const edge   = edges[i];
    const linked = linkedEntities[i];
    if (!linked || linked.deleted) continue;  // skip null and deleted

    const linkedConfig = getEntityTypeConfig(linked.type);
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.style.cssText = 'cursor: pointer; display: inline-flex; align-items: center; gap: var(--space-1);';
    chip.innerHTML = `<span>${linkedConfig?.icon || '📎'}</span> <span>${_getDisplayTitle(linked)}</span>`;

    // Click to navigate — smart: dailyReview → exact date, task → kanban+panel
    chip.addEventListener('click', () => {
      _navigateToLinkedEntity(linked);
    });

    // Remove button
    const removeBtn = document.createElement('span');
    removeBtn.textContent = '×';
    removeBtn.style.cssText = 'cursor: pointer; margin-left: var(--space-1); color: var(--color-text-muted); font-weight: bold;';
    removeBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteEdge(edge.id);
      _renderRelationChips(wrap, field);
    });
    chip.appendChild(removeBtn);

    chipContainer.appendChild(chip);
  }

  // Add button
  const addBtn = document.createElement('button');
  addBtn.className   = 'btn btn-ghost btn-xs';
  addBtn.textContent = '+ Add';
  addBtn.style.cssText = 'font-size: var(--text-xs); padding: var(--space-0-5) var(--space-2);';
  addBtn.addEventListener('click', () => {
    _showRelationPicker(wrap, field);
  });
  chipContainer.appendChild(addBtn);

  wrap.appendChild(chipContainer);
}

// ── Tag chips ────────────────────────────────────────────── //

function _renderTagChips(wrap, field) {
  wrap.innerHTML = '';
  const tags = _entity[field.key] || [];

  const chipContainer = document.createElement('div');
  chipContainer.style.cssText = 'display: flex; flex-wrap: wrap; gap: var(--space-1); align-items: center;';

  for (let i = 0; i < tags.length; i++) {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.title = 'Click to open tag · × to remove';
    chip.style.cursor = 'pointer';

    const text = document.createElement('span');
    text.textContent = tags[i];
    chip.appendChild(text);

    // Click chip label → open tag entity panel by name lookup
    const tagName = tags[i];
    text.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const allTags = await getEntitiesByType('tag');
        const tagEntity = allTags.find(t =>
          (t.name || t.title || '').toLowerCase() === tagName.toLowerCase()
        );
        if (tagEntity) {
          emit(EVENTS.PANEL_OPENED, { entityId: tagEntity.id, entityType: 'tag' });
        } else {
          // Tag entity doesn't exist yet — offer to create it
          // Only open create form if no other form is currently open
          if (!document.querySelector('.ef-overlay')) {
            import('../components/entity-form.js').then(({ openForm }) => {
              openForm('tag', { name: tagName });
            }).catch(() => {});
          } else {
            import('../core/toast.js').then(({ toast }) => {
              toast.info(`Tag "${tagName}" not found — close the current form to create it`);
            }).catch(() => {});
          }
        }
      } catch (err) {
        console.warn('[panel] tag lookup failed:', err);
      }
    });

    const remove = document.createElement('span');
    remove.textContent = '×';
    remove.style.cssText = 'cursor: pointer; margin-left: var(--space-1); color: var(--color-text-muted); font-weight: bold;';
    const tagToRemove = tags[i];  // capture value, not index — index is stale after removals
    remove.addEventListener('click', async (e) => {
      e.stopPropagation();
      // Find by value to handle index-shift from prior removals
      const arr = [...(_entity[field.key] || [])];
      const pos = arr.indexOf(tagToRemove);
      if (pos !== -1) arr.splice(pos, 1);
      _entity[field.key] = arr;
      _markDirty();
      await _save();
      _renderTagChips(wrap, field);
    });
    chip.appendChild(remove);

    chipContainer.appendChild(chip);
  }

  // Add button
  const addBtn = document.createElement('button');
  addBtn.className   = 'btn btn-ghost btn-xs';
  addBtn.textContent = '+ Tag';
  addBtn.style.cssText = 'font-size: var(--text-xs); padding: var(--space-0-5) var(--space-2);';
  addBtn.addEventListener('click', () => {
    _showTagInput(wrap, field, chipContainer);
  });
  chipContainer.appendChild(addBtn);

  wrap.appendChild(chipContainer);
}

function _showTagInput(wrap, field, chipContainer) {
  // Remove add button temporarily
  const addBtn = chipContainer.querySelector('.btn');
  if (addBtn) addBtn.remove();

  const input = document.createElement('input');
  input.type        = 'text';
  input.className   = 'input';
  input.placeholder = 'Tag name…';
  input.style.cssText = 'width: 100px; padding: var(--space-0-5) var(--space-2); font-size: var(--text-xs);';
  chipContainer.appendChild(input);
  input.focus();

  const commit = async () => {
    const val = input.value.trim();
    if (val) {
      const arr = [...(_entity[field.key] || [])];
      if (!arr.includes(val)) {
        arr.push(val);
        _entity[field.key] = arr;
        _markDirty();
        await _save();
      }
    }
    _renderTagChips(wrap, field);
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = ''; input.blur(); }
  });
}

// ── Relation picker ──────────────────────────────────────── //

async function _showRelationPicker(wrap, field) {
  wrap.innerHTML = '';

  const picker = document.createElement('div');
  picker.style.cssText = 'display: flex; flex-direction: column; gap: var(--space-2);';

  // Guard: capture entity ref before any await
  if (!_entity) return;
  const _entityRefForPicker = _entity;

  // Re-render existing chips above the search input so they don't disappear
  const existingEdges = await getEdgesFrom(_entityRefForPicker.id, field.key).catch(() => []);

  // Guard: entity panel may have closed during await
  if (!_entity || _entity.id !== _entityRefForPicker.id) return;
  if (existingEdges.length > 0) {
    const chipStrip = document.createElement('div');
    chipStrip.style.cssText = 'display:flex;flex-wrap:wrap;gap:var(--space-1);margin-bottom:var(--space-1);';
    // Resolve all linked entities in parallel
    const linkedEntities34 = await Promise.all(existingEdges.map(e => getEntity(e.toId).catch(() => null)));
    for (let _i34 = 0; _i34 < existingEdges.length; _i34++) {
      const edge = existingEdges[_i34];
      const linked = linkedEntities34[_i34];
      if (!linked || linked.deleted) continue;
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.style.cssText = 'display:inline-flex;align-items:center;gap:4px;';
      const cfg = getEntityTypeConfig(linked.type);
      chip.innerHTML = `<span>${cfg?.icon || '📎'}</span><span>${_getDisplayTitle(linked)}</span>`;
      const rm = document.createElement('span');
      rm.textContent = '×';
      rm.style.cssText = 'cursor:pointer;font-weight:bold;color:var(--color-text-muted);margin-left:2px;';
      rm.addEventListener('click', async (e) => {
        e.stopPropagation();
        await deleteEdge(edge.id);
        _renderRelationChips(wrap, field);
      });
      chip.appendChild(rm);
      chipStrip.appendChild(chip);
    }
    picker.appendChild(chipStrip);
  }

  const input = document.createElement('input');
  input.type        = 'text';
  input.className   = 'input';
  input.placeholder = `Search ${field.relatesTo || 'entity'}…`;
  input.style.cssText = 'padding: var(--space-1-5) var(--space-2); font-size: var(--text-sm);';
  picker.appendChild(input);

  const results = document.createElement('div');
  results.style.cssText = 'max-height: 150px; overflow-y: auto; display: flex; flex-direction: column; gap: var(--space-1);';
  picker.appendChild(results);

  wrap.appendChild(picker);
  input.focus();

  const doSearch = async () => {
    const query   = input.value.toLowerCase().trim();
    const relType = field.relatesTo || null;

    let candidates = [];
    if (relType) {
      candidates = await getEntitiesByType(relType);
    }

    // Filter by search, exclude self, exclude deleted
    const filtered = candidates.filter(e => {
      if (e.id === _entity.id) return false;
      if (e.deleted) return false;
      const t = _getDisplayTitle(e).toLowerCase();
      return !query || t.includes(query);
    }).slice(0, 10);

    results.innerHTML = '';

    // "Create new" button — shown when there's a search query
    if (query) {
      const createBtn = document.createElement('button');
      const relCfg = field.relatesTo ? getEntityTypeConfig(field.relatesTo) : null;
      createBtn.style.cssText = 'width:100%;text-align:left;padding:var(--space-1-5) var(--space-2);' +
        'border:1px dashed var(--color-accent);border-radius:var(--radius-sm);' +
        'background:var(--color-accent-muted);color:var(--color-accent);' +
        'font-size:var(--text-xs);font-weight:var(--weight-semibold);cursor:pointer;' +
        'margin-bottom:var(--space-1);';
      const typeLabel = relCfg?.label || field.relatesTo || 'entity';
      createBtn.textContent = `+ Create "${input.value.trim()}" as ${typeLabel}`;
      createBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const q = input.value.trim();
        const targetType = field.relatesTo || null;
        if (targetType) {
          openQuickCreateModal(targetType, { title: q, name: q }, async newEnt => {
            if (!newEnt) return;
            await saveEdge({
              fromId:   _entity.id,
              fromType: _entity.type,
              toId:     newEnt.id,
              toType:   newEnt.type,
              relation: _fieldKeyToRelLabel(field.key, field),
            }, getAccount()?.id);
            _renderRelationChips(wrap, field);
          });
        } else {
          // No target type — open full entity form to create any type
          openForm('note', { title: q }, async newEnt => {
            if (!newEnt) return;
            await saveEdge({
              fromId:   _entity.id,
              fromType: _entity.type,
              toId:     newEnt.id,
              toType:   newEnt.type,
              relation: _fieldKeyToRelLabel(field.key, field),
            }, getAccount()?.id);
            _renderRelationChips(wrap, field);
          });
        }
      });
      results.appendChild(createBtn);
    }

    if (filtered.length === 0) {
      if (!query || !field.relatesTo) {
        const noRes = document.createElement('div');
        noRes.style.cssText = 'font-size:var(--text-xs);color:var(--color-text-muted);padding:var(--space-2);';
        noRes.textContent = query ? 'No matches — use the create button above' : 'No results';
        results.appendChild(noRes);
      }
      return;
    }

    for (const candidate of filtered) {
      const cfg     = getEntityTypeConfig(candidate.type);

      const item = document.createElement('div');
      item.style.cssText = `
        display: flex; align-items: center; gap: var(--space-2);
        padding: var(--space-1-5) var(--space-2); border-radius: var(--radius-sm);
        cursor: pointer; font-size: var(--text-sm);
        transition: background var(--transition-fast);
      `;
      item.innerHTML = `<span>${cfg?.icon || '📎'}</span> <span>${_getDisplayTitle(candidate)}</span>`;

      item.addEventListener('mouseenter', () => { item.style.background = 'var(--color-surface-2)'; });
      item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; });

      item.addEventListener('click', async () => {
        // Create edge
        await saveEdge({
          fromId:   _entity.id,
          fromType: _entity.type,
          toId:     candidate.id,
          toType:   candidate.type,
          relation: _fieldKeyToRelLabel(field.key, field),
        }, getAccount()?.id);
        _renderRelationChips(wrap, field);
      });

      results.appendChild(item);
    }
  };

  // Initial populate
  doSearch();

  input.addEventListener('input', doSearch);

  // Cancel on Escape
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      _renderRelationChips(wrap, field);
    }
  });

  input.addEventListener('blur', () => {
    // Small delay so click on result registers first
    setTimeout(() => {
      if (wrap.contains(picker)) {
        _renderRelationChips(wrap, field);
      }
    }, 200);
  });
}

// ════════════════════════════════════════════════════════════
// RELATIONS TAB
// ════════════════════════════════════════════════════════════

// ── Daily Review link system ──────────────────────────────────
// Entities with temporal dates auto-link to their Daily Review entity.

/**
 * Format a YYYY-MM-DD dateStr to MM-DD-YYYY for display.
 * e.g. '2026-04-20' → '04-20-2026'
 */
function _formatDateForTitle(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  const [y, m, d] = dateStr.split('-');
  return `${m}-${d}-${y}`;
}

/**
 * Find or create the Daily Review entity (type:'dailyReview') for a date.
 * @param {string} dateStr  — 'YYYY-MM-DD'
 * @returns {Promise<object>} the dailyReview entity
 */
async function _getOrCreateDailyReview(dateStr) {
  if (!dateStr) return null;
  try {
    const existing = await getEntitiesByType('dailyReview');
    const found = existing.find(dr => dr.date === dateStr && !dr.deleted);
    if (found) return found;
    return await saveEntity({
      type:  'dailyReview',
      title: `Daily Review — ${_formatDateForTitle(dateStr)}`,
      date:  dateStr,
    }, getAccount()?.id);
  } catch (err) {
    console.warn('[entity-panel] _getOrCreateDailyReview failed:', dateStr, err);
    return null;
  }
}

/**
 * When a date-bearing field (dueDate, date, startDate) changes on an entity,
 * remove stale 'in daily review' edges pointing to the old date's DR entity
 * and create the correct new edge for the new date.
 *
 * @param {object} entity        — the entity AFTER save (has new date value)
 * @param {string} dateFieldKey  — which field changed ('dueDate' | 'date' | 'startDate')
 * @param {string|null} oldDateStr — previous YYYY-MM-DD value (null if no previous date)
 * @param {string|null} newDateStr — new YYYY-MM-DD value (null if date was cleared)
 */
async function _updateDailyReviewEdgesForDateChange(entity, dateFieldKey, oldDateStr, newDateStr) {
  if (!entity?.id) return;
  // Nothing changed
  if (oldDateStr === newDateStr) return;

  try {
    // Remove old 'in daily review' edge for the old date
    if (oldDateStr) {
      const oldDR = await getEntitiesByType('dailyReview')
        .then(all => all.find(dr => dr.date === oldDateStr && !dr.deleted))
        .catch(() => null);
      if (oldDR) {
        const staleEdges = await getEdgesFrom(entity.id, 'in daily review')
          .then(edges => edges.filter(e => e.toId === oldDR.id))
          .catch(() => []);
        for (const edge of staleEdges) {
          try { await deleteEdge(edge.id); } catch { /* best effort */ }
        }
        // Also remove the reverse 'contains' edge from the old DR → entity
        const staleContains = await getEdgesFrom(oldDR.id, 'contains')
          .then(edges => edges.filter(e => e.toId === entity.id))
          .catch(() => []);
        for (const edge of staleContains) {
          try { await deleteEdge(edge.id); } catch { /* best effort */ }
        }
        console.log('[entity-panel] removed stale DR edges from', oldDateStr, '→', entity.id);
      }
    }

    // Create new 'in daily review' edge for the new date
    if (newDateStr) {
      const newDR = await _getOrCreateDailyReview(newDateStr);
      if (newDR) {
        // Check if edge already exists before creating
        const existingContains = await getEdgesFrom(newDR.id, 'contains')
          .then(edges => edges.find(e => e.toId === entity.id))
          .catch(() => null);
        if (!existingContains) {
          await saveEdge({
            fromId:   newDR.id,
            fromType: 'dailyReview',
            toId:     entity.id,
            toType:   entity.type,
            relation: 'contains',
          }, getAccount()?.id);
        }
        console.log('[entity-panel] linked', entity.id, '→ DR', newDateStr);
      }
    }
  } catch (err) {
    console.warn('[entity-panel] _updateDailyReviewEdgesForDateChange failed:', err);
  }
}

/**
 * Ensure the entity is linked to Daily Review entities for its temporal dates.
 * Idempotent — checks existing edges before creating. Non-blocking.
 * @param {object} entity
 */
/** Cache of 'entityId:dateStr' pairs already ensured this session — prevents redundant IDB writes */
const _dailyLinksEnsured = new Set();

async function _ensureDailyLinks(entity) {
  if (!entity?.id || !entity?.type) return;

  // Skip types that are containers or lack temporal meaning
  const SKIP_TYPES = new Set(['dailyReview', 'tag', 'note', 'comment', 'budgetEntry', 'person',
                               'project', 'contact', 'place', 'weblink', 'recipe',
                               'medication', 'shoppingItem', 'habit', 'goal']);
  if (SKIP_TYPES.has(entity.type)) return;

  const datesToLink = new Set();

  // Each type uses its canonical date ONLY — never mix createdAt with dedicated date fields
  switch (entity.type) {
    case 'task':
      // Tasks link ONLY to their due date
      if (entity.dueDate) { const d = _isoToLocalDate(entity.dueDate); if (d) datesToLink.add(d); }
      break;

    case 'taskInstance': {
      // [v5.4.3] Instances link to their periodStart (the day they occur).
      // If overdue (periodStart < today), also link to today so it appears in today's DR.
      const occDate = _isoToLocalDate(entity.periodStart);
      if (occDate) {
        datesToLink.add(occDate);
        const todayStr = (() => {
          const n = new Date();
          return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
        })();
        if (occDate < todayStr) datesToLink.add(todayStr); // overdue: also today's DR
      }
      break;
    }

    case 'event': {
      // Events link to every date they span (startDate through endDate inclusive)
      const startD = _isoToLocalDate(entity.date);
      const endD   = _isoToLocalDate(entity.endDate);
      if (startD) {
        datesToLink.add(startD);
        if (endD && endD > startD) {
          let cur = new Date(startD + 'T00:00:00');
          const stop = new Date(endD + 'T00:00:00');
          let safety = 0;
          while (cur <= stop && safety++ < 90) {
            const y = cur.getFullYear();
            const m = String(cur.getMonth() + 1).padStart(2, '0');
            const dy = String(cur.getDate()).padStart(2, '0');
            datesToLink.add(`${y}-${m}-${dy}`);
            cur.setDate(cur.getDate() + 1);
          }
        }
      }
      break;
    }

    case 'appointment':
    case 'dateEntity':
    case 'mealPlan':
      if (entity.date) { const d = _isoToLocalDate(entity.date); if (d) datesToLink.add(d); }
      break;

    case 'trip':
      if (entity.startDate) { const d = _isoToLocalDate(entity.startDate); if (d) datesToLink.add(d); }
      break;

    default:
      // Other types (idea, research, post, book, etc.) use createdAt
      if (entity.createdAt) { const d = _isoToLocalDate(entity.createdAt); if (d) datesToLink.add(d); }
      break;
  }

  if (datesToLink.size === 0) return;

  // Look up 'contains' edges from DR → entity (canonical direction)
  // Also check old 'in daily review' edges for backward compat during migration
  const _allDREdges = await (async () => {
    const byOld = await getEdgesFrom(entity.id, 'in daily review').catch(() => []);
    return byOld; // backward compat lookup; new edges go DR→entity
  })();
  // New canonical: check contains edges per DR below
  const linkedIds = new Set(_allDREdges.map(e => e.toId));

  for (const dateStr of datesToLink) {
    // Skip if already ensured this entity+date pair in this session
    const cacheKey = `${entity.id}:${dateStr}`;
    if (_dailyLinksEnsured.has(cacheKey)) continue;
    try {
      const dr = await _getOrCreateDailyReview(dateStr);
      if (!dr || linkedIds.has(dr.id)) {
        _dailyLinksEnsured.add(cacheKey); // mark even if already linked
        continue;
      }
      // Check canonical 'contains' from DR→entity before creating
      const drContainsAlready = await getEdgesFrom(dr.id, 'contains')
        .then(es => es.some(e => e.toId === entity.id)).catch(() => false);
      if (drContainsAlready) { _dailyLinksEnsured.add(cacheKey); continue; }
      await saveEdge({
        fromId:   dr.id,
        fromType: 'dailyReview',
        toId:     entity.id,
        toType:   entity.type,
        relation: 'contains',
      }, getAccount()?.id);
      _dailyLinksEnsured.add(cacheKey);
    } catch (err) {
      console.warn('[entity-panel] _ensureDailyLinks failed for date:', dateStr, err);
    }
  }
}

/** Parse ISO string or date-only string to local YYYY-MM-DD */
function _isoToLocalDate(isoStr) {
  if (!isoStr) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(isoStr)) return isoStr;
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dy}`;
}

// ── Time Tracker UI ───────────────────────────────────────── //

async function _buildTimeTrackerUI(container, entity) {
  // [fix] Ensure time-tracker loaded before using its API
  await _ensureTimeTrackerPanel();
  const taskId = entity.id;

  const header = document.createElement('div');
  header.style.cssText = 'font-size:var(--text-xs);font-weight:var(--weight-semibold);color:var(--color-text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:var(--space-3);';
  header.textContent = '⏱️ Time Tracking';
  container.appendChild(header);

  // ── Main display: full elapsed ──
  const display = document.createElement('div');
  display.style.cssText = [
    'font-size:2.2rem;font-weight:var(--weight-bold);color:var(--color-text);',
    'font-variant-numeric:tabular-nums;letter-spacing:-0.02em;',
    'margin-bottom:var(--space-2);line-height:1;',
  ].join('');
  container.appendChild(display);

  // Sub-display: days / hours / mins / secs breakdown
  const breakdown = document.createElement('div');
  breakdown.style.cssText = 'display:flex;gap:var(--space-3);margin-bottom:var(--space-4);';
  const mkUnit = (label) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;min-width:32px;';
    const num = document.createElement('span');
    num.style.cssText = 'font-size:var(--text-sm);font-weight:var(--weight-bold);color:var(--color-text);font-variant-numeric:tabular-nums;';
    const lbl = document.createElement('span');
    lbl.style.cssText = 'font-size:10px;color:var(--color-text-muted);margin-top:1px;';
    lbl.textContent = label;
    wrap.append(num, lbl);
    return { wrap, num };
  };
  const days  = mkUnit('days');
  const hours = mkUnit('hrs');
  const mins  = mkUnit('min');
  const secs  = mkUnit('sec');
  breakdown.append(days.wrap, hours.wrap, mins.wrap, secs.wrap);
  container.appendChild(breakdown);

  // ── Control row: Start / Stop / Reset ──
  const ctrlRow = document.createElement('div');
  ctrlRow.style.cssText = 'display:flex;gap:var(--space-2);flex-wrap:wrap;margin-bottom:var(--space-3);';
  container.appendChild(ctrlRow);

  const mkBtn = (text, accent = false, danger = false) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.style.cssText = [
      'padding:6px 14px;border-radius:var(--radius-md);font-size:var(--text-sm);',
      'font-weight:var(--weight-semibold);cursor:pointer;border:1px solid var(--color-border);',
      'transition:opacity 0.12s;',
      accent ? 'background:var(--color-accent);color:#fff;border-color:var(--color-accent);' :
      danger  ? 'background:var(--color-surface);color:var(--color-danger);border-color:var(--color-danger);' :
                'background:var(--color-surface);color:var(--color-text);',
    ].join('');
    b.addEventListener('mouseenter', () => b.style.opacity = '0.8');
    b.addEventListener('mouseleave', () => b.style.opacity = '1');
    return b;
  };

  const startBtn  = mkBtn('▶ Start', true);
  const stopBtn   = mkBtn('⏸ Pause');
  const resetBtn  = mkBtn('↺ Reset', false, true);
  ctrlRow.append(startBtn, stopBtn, resetBtn);

  // ── Status badge ──
  const statusBadge = document.createElement('div');
  statusBadge.style.cssText = 'font-size:var(--text-xs);color:var(--color-text-muted);margin-bottom:var(--space-3);min-height:18px;';
  container.appendChild(statusBadge);

  // ── Time Block section ──
  const blockSection = document.createElement('div');
  blockSection.style.cssText = 'background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:var(--space-3);margin-bottom:var(--space-3);';
  container.appendChild(blockSection);

  const blockTitle = document.createElement('div');
  blockTitle.style.cssText = 'font-size:var(--text-xs);font-weight:var(--weight-semibold);color:var(--color-text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:var(--space-2);';
  blockTitle.textContent = '⏲ Time Block';
  blockSection.appendChild(blockTitle);

  const blockRow = document.createElement('div');
  blockRow.style.cssText = 'display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap;';
  blockSection.appendChild(blockRow);

  const blockSelect = document.createElement('select');
  blockSelect.style.cssText = 'padding:5px 8px;border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-bg);color:var(--color-text);font-size:var(--text-sm);flex:1;min-width:130px;';
  const blockOptions = [
    { label: '5 min',   secs: 300   },
    { label: '10 min',  secs: 600   },
    { label: '15 min',  secs: 900   },
    { label: '25 min (Pomodoro)', secs: 1500 },
    { label: '30 min',  secs: 1800  },
    { label: '45 min',  secs: 2700  },
    { label: '1 hr',    secs: 3600  },
    { label: '1.5 hr',  secs: 5400  },
    { label: '2 hr',    secs: 7200  },
    { label: '3 hr',    secs: 10800 },
    { label: '4 hr',    secs: 14400 },
    { label: '5 hr',    secs: 18000 },
  ];
  for (const opt of blockOptions) {
    const o = document.createElement('option');
    o.value = String(opt.secs);
    o.textContent = opt.label;
    blockSelect.appendChild(o);
  }

  // [v6.2.0] Pre-select from plannedDuration field if set — "use task time block as default duration"
  if (_entity?.plannedDuration && !getSession(_entity.id)) {
    const pd = String(_entity.plannedDuration).toLowerCase();
    let targetSecs = 0;
    const minM = pd.match(/^(\d+)\s*min/);   if (minM) targetSecs = parseInt(minM[1], 10) * 60;
    const hrM  = pd.match(/^([\d.]+)\s*hour/); if (hrM) targetSecs = Math.round(parseFloat(hrM[1]) * 3600);
    if (targetSecs > 0) {
      const match = [...blockSelect.options].find(o => o.value === String(targetSecs));
      if (match) blockSelect.value = String(targetSecs);
    }
  }
  // Fallback: pre-select from saved default if no plannedDuration match
  getSetting('taskDefaultTimeBlock').then(defaultSecs => {
    if (defaultSecs && !getSession(_entity?.id)) {
      const val = String(defaultSecs);
      if ([...blockSelect.options].some(o => o.value === val)) {
        if (blockSelect.value === blockSelect.options[0]?.value) blockSelect.value = val;
      }
    }
  }).catch(() => {});

  blockRow.appendChild(blockSelect);

  const startBlockBtn = mkBtn('▶ Start Block', true);
  blockRow.appendChild(startBlockBtn);

  // Block countdown display
  const blockCountdown = document.createElement('div');
  blockCountdown.style.cssText = 'font-size:var(--text-sm);font-weight:var(--weight-semibold);color:var(--color-text);margin-top:var(--space-2);min-height:20px;';
  blockSection.appendChild(blockCountdown);

  // ── Manual adjust section ──
  const adjSection = document.createElement('div');
  adjSection.style.cssText = 'margin-bottom:var(--space-3);';
  container.appendChild(adjSection);

  const adjTitle = document.createElement('div');
  adjTitle.style.cssText = 'font-size:var(--text-xs);font-weight:var(--weight-semibold);color:var(--color-text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:var(--space-2);';
  adjTitle.textContent = '✏️ Manual Adjust';
  adjSection.appendChild(adjTitle);

  const adjRow = document.createElement('div');
  adjRow.style.cssText = 'display:flex;gap:var(--space-1);align-items:center;flex-wrap:wrap;';
  adjSection.appendChild(adjRow);

  const mkNumInput = (placeholder, width = '52px') => {
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.min = '0';
    inp.placeholder = placeholder;
    inp.style.cssText = `width:${width};padding:5px 6px;border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-bg);color:var(--color-text);font-size:var(--text-sm);text-align:center;`;
    return inp;
  };
  const mkLabel = (text) => {
    const lbl = document.createElement('span');
    lbl.textContent = text;
    lbl.style.cssText = 'font-size:var(--text-xs);color:var(--color-text-muted);';
    return lbl;
  };

  const adjD = mkNumInput('0d', '44px');
  const adjH = mkNumInput('0h', '44px');
  const adjM = mkNumInput('0m', '44px');
  const adjS = mkNumInput('0s', '44px');
  const adjBtn = mkBtn('Set & Continue');

  adjRow.append(adjD, mkLabel('d'), adjH, mkLabel('h'), adjM, mkLabel('m'), adjS, mkLabel('s'), adjBtn);

  // ── Total saved time display ──
  const savedRow = document.createElement('div');
  savedRow.style.cssText = 'font-size:var(--text-xs);color:var(--color-text-muted);margin-top:var(--space-1);';
  container.appendChild(savedRow);

  // ── Refresh logic ──────────────────────────────────────────

  function _updateDisplay() {
    const session  = getSession(taskId);
    const elapsed  = getElapsed(session) || (entity.timeTracked || 0);
    const running  = session?.running;
    const alarmed  = session?.alarmed;
    const isBlock  = session?.mode === 'block';

    // Big display
    const totalSecs = getElapsed(session);
    display.textContent = formatDurationCompact(totalSecs);

    // Breakdown
    const d = Math.floor(totalSecs / 86400);
    const h = Math.floor((totalSecs % 86400) / 3600);
    const m = Math.floor((totalSecs % 3600) / 60);
    const s = Math.floor(totalSecs % 60);
    days.num.textContent  = String(d);
    hours.num.textContent = String(h);
    mins.num.textContent  = String(m);
    secs.num.textContent  = String(s);

    // Status badge
    if (alarmed) {
      statusBadge.textContent = '🔔 Block complete! Timer stopped.';
      statusBadge.style.color = 'var(--color-danger)';
    } else if (running && isBlock) {
      const rem = getRemaining(session);
      statusBadge.textContent = `⏲ Block — ${formatDuration(rem)} remaining`;
      statusBadge.style.color = rem <= 60 ? 'var(--color-danger)' : 'var(--color-accent)';
    } else if (running) {
      statusBadge.textContent = '🔴 Recording…';
      statusBadge.style.color = 'var(--color-accent)';
    } else if (totalSecs > 0) {
      statusBadge.textContent = `Paused — ${formatDuration(totalSecs)} total`;
      statusBadge.style.color = 'var(--color-text-muted)';
    } else {
      statusBadge.textContent = 'Not started';
      statusBadge.style.color = 'var(--color-text-muted)';
    }

    // Button states
    startBtn.disabled  = running && !alarmed;
    startBtn.style.opacity = (running && !alarmed) ? '0.4' : '1';
    stopBtn.disabled   = !running;
    stopBtn.style.opacity = !running ? '0.4' : '1';

    // Block countdown
    if (isBlock && session?.blockSecs) {
      const rem = getRemaining(session);
      if (alarmed) {
        blockCountdown.textContent = '🔔 Block finished!';
        blockCountdown.style.color = 'var(--color-danger)';
      } else if (running) {
        const pct = Math.max(0, (rem / session.blockSecs) * 100);
        blockCountdown.innerHTML = `<span style="color:var(--color-accent);">${formatDuration(rem)}</span> remaining <span style="color:var(--color-text-muted);">(${Math.round(100 - pct)}% done)</span>`;
      } else {
        blockCountdown.textContent = '';
      }
    } else {
      blockCountdown.textContent = '';
    }

    // Saved time
    savedRow.textContent = entity.timeTracked > 0
      ? `💾 Saved total: ${formatDuration(entity.timeTracked)}`
      : '';
  }

  // Wire controls
  startBtn.addEventListener('click', async () => {
    await startFreeRun(taskId, entity);
    _updateDisplay();
  });

  stopBtn.addEventListener('click', async () => {
    await stopSession(taskId);
    entity.timeTracked = getElapsed(getSession(taskId));
    _updateDisplay();
    toast.success('Time saved ✓');
  });

  resetBtn.addEventListener('click', async () => {
    const dialog = window._fhEnv?.services?.dialog;
    let ok = true;
    if (dialog) ok = await dialog.confirm('Reset timer? Current session will be discarded.', { confirmLabel: 'Reset', danger: true });
    if (!ok) return;
    await resetSession(taskId);
    // TT-8 fix: persist reset to IDB and update local state so _save() doesn't resurrect old value
    entity.timeTracked = 0;
    if (_draft) _draft.timeTracked = 0;
    try {
      const fresh = await getEntity(taskId);
      if (fresh) await saveEntity({ ...fresh, timeTracked: 0 });
    } catch (e) { console.warn('[timer] reset persist failed:', e); }
    _updateDisplay();
    toast.success('Timer reset');
  });

  startBlockBtn.addEventListener('click', async () => {
    const blockSecs = parseInt(blockSelect.value, 10);
    if (!blockSecs) return;
    clearAlarm(taskId);
    await startBlock(taskId, entity, blockSecs);
    _updateDisplay();
  });

  adjBtn.addEventListener('click', async () => {
    const d = parseInt(adjD.value) || 0;
    const h = parseInt(adjH.value) || 0;
    const m = parseInt(adjM.value) || 0;
    const s = parseInt(adjS.value) || 0;
    const totalSecs = d * 86400 + h * 3600 + m * 60 + s;
    await adjustSession(taskId, totalSecs, entity);
    _updateDisplay();
    adjD.value = adjH.value = adjM.value = adjS.value = '';
  });

  // Live tick updates — store unsubscribes; clean up when container is removed from DOM
  const _unsubTick  = on(TIMER_TICK,  (data) => { if (data.taskId === taskId) _updateDisplay(); });
  const _unsubAlarm = on(TIMER_ALARM, (data) => { if (data.taskId === taskId) _updateDisplay(); });
  const _unsubSaved = on(TIMER_SAVED, (data) => {
    if (data.taskId === taskId) { entity.timeTracked = data.elapsed; _updateDisplay(); }
  });
  // MutationObserver: when container is removed (tab switch / panel close), unsubscribe all
  const _ttCleanup = () => { _unsubTick(); _unsubAlarm(); _unsubSaved(); };
  const _ttObserver = new MutationObserver(() => {
    if (!document.contains(container)) { _ttCleanup(); _ttObserver.disconnect(); }
  });
  _ttObserver.observe(document.body, { childList: true, subtree: true });

  // Initial render
  // Pre-fill adjust fields from current elapsed
  const initSession = getSession(taskId);
  if (initSession) {
    const e = getElapsed(initSession);
    adjD.placeholder = String(Math.floor(e / 86400));
    adjH.placeholder = String(Math.floor((e % 86400) / 3600));
    adjM.placeholder = String(Math.floor((e % 3600) / 60));
    adjS.placeholder = String(Math.floor(e % 60));
  }
  _updateDisplay();
}

// ── Relations Tab — comprehensive connection system ───────────

async function _renderRelationsTab(container) {
  if (!_entity) return;

  container.innerHTML = '';

  // ── Section 0: Action buttons (moved from header) ───────────
  if (_entity && _config) {
    const actSection = document.createElement('div');
    actSection.style.cssText = 'border-bottom:1px solid var(--color-border);padding-bottom:var(--space-4);margin-bottom:var(--space-4);';
    container.appendChild(actSection);

    const actHeader = document.createElement('div');
    actHeader.style.cssText = 'font-size:var(--text-xs);font-weight:var(--weight-semibold);color:var(--color-text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:var(--space-3);';
    actHeader.textContent = '⚡ Actions';
    actSection.appendChild(actHeader);

    const actRow = document.createElement('div');
    actRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:var(--space-2);';
    actSection.appendChild(actRow);

    const mkActionBtn = (label, icon, style = '', danger = false) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.innerHTML = `<span>${icon}</span> ${label}`;
      btn.style.cssText = [
        'display:inline-flex;align-items:center;gap:4px;padding:6px 12px;',
        'border:1px solid var(--color-border);border-radius:var(--radius-md);',
        'background:var(--color-surface);cursor:pointer;font-size:var(--text-sm);',
        'color:' + (danger ? 'var(--color-danger)' : 'var(--color-text)') + ';',
        'transition:background 0.12s;', style,
      ].join('');
      btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--color-surface-2)'; });
      btn.addEventListener('mouseleave', () => { btn.style.background = 'var(--color-surface)'; });
      return btn;
    };

    const actions = _config.actions || [];
    const isDone = _entity.status === 'Completed' || _entity.status === 'Done';

    // Complete (tasks)
    if (_entity.type === 'task') {
      const completeBtn = mkActionBtn(isDone ? 'Mark In Progress' : 'Mark Complete', isDone ? '↩' : '✓', 'color:var(--color-success-text,#15803d);border-color:var(--color-success-text,#15803d);');
      completeBtn.addEventListener('click', async () => {
        const wasCompleting = !isDone;
        _entity.status = isDone ? 'In Progress' : 'Completed';
        _markDirty();
        await _save();
        _renderHeader();
        _renderActiveTab();
        // [v6.5.0] Follow-up prompt on completion
        if (wasCompleting) {
          try {
            const { _promptFollowUp } = await import('./entity-form.js');
            await _promptFollowUp(_entity);
          } catch {}
        }
      });
      actRow.appendChild(completeBtn);
    }

    // Complete this occurrence (taskInstance)
    if (_entity.type === 'taskInstance' && !isDone && _entity.status !== 'Skipped') {
      const completeBtn = mkActionBtn('Complete Occurrence', '✓', 'color:var(--color-success-text,#15803d);border-color:var(--color-success-text,#15803d);');
      completeBtn.addEventListener('click', async () => {
        completeBtn.disabled = true;
        try {
          const { completeInstance } = await import('../services/recurrence.js');
          await completeInstance(_entity.id);
          _entity.status = 'Completed';
          _renderHeader();
          _renderActiveTab();
        } catch (err) {
          console.error('[panel] completeInstance (props tab):', err);
          completeBtn.disabled = false;
        }
      });
      actRow.appendChild(completeBtn);
    }

    // Archive/Unarchive (not for taskInstance)
    if (_entity.type !== 'taskInstance' && (actions.includes('archive') || actions.includes('edit'))) {
      const isArchived = _entity.status === 'Archived' || _entity.archived;
      const archBtn = mkActionBtn(isArchived ? 'Unarchive' : 'Archive', isArchived ? '↑' : '📦');
      archBtn.addEventListener('click', async () => {
        if (_entity.status !== undefined) _entity.status = isArchived ? 'Active' : 'Archived';
        else _entity.archived = !isArchived;
        _markDirty();
        await _save();
        _renderHeader();
        _renderActiveTab();
      });
      actRow.appendChild(archBtn);
    }

    // Duplicate
    if (actions.includes('duplicate')) {
      const dupBtn = mkActionBtn('Duplicate', '⎘');
      dupBtn.addEventListener('click', () => _duplicateEntity());
      actRow.appendChild(dupBtn);
    }

    // Add to project (not for taskInstance)
    if (_entity.type !== 'project' && _entity.type !== 'taskInstance') {
      const projBtn = mkActionBtn('Add to Project', '📁');
      projBtn.addEventListener('click', () => _showProjectPicker());
      actRow.appendChild(projBtn);
    }

    // Convert
    if (actions.includes('convert')) {
      const convBtn = mkActionBtn('Convert to…', '🔄');
      convBtn.addEventListener('click', () => _showConvertDropdown());
      actRow.appendChild(convBtn);
    }

    // Delete: available in header toolbar — not duplicated in Connections tab (EP-1 fix)
  }

  // ── Section 1: Time Tracker (tasks only) ────────────────────
  if (_entity?.type === 'task') {
    const ttSection = document.createElement('div');
    ttSection.style.cssText = 'border-bottom:1px solid var(--color-border);padding-bottom:var(--space-4);margin-bottom:var(--space-4);';
    container.appendChild(ttSection);
    _buildTimeTrackerUI(ttSection, _entity).catch(e => console.warn('[panel] timer UI error:', e));
  }

  // [minor] BUG-72 fix: skip _ensureDailyLinks in graph mode — graph browsing is read-only
  if (!_graphViewActive) {
    _ensureDailyLinks(_entity).catch(() => {});
  }

  // ── Section: Add New Connection ────────────────────────────
  const addSection = document.createElement('div');
  addSection.style.cssText = 'border-bottom: 1px solid var(--color-border); padding-bottom: var(--space-4); margin-bottom: var(--space-4);';
  container.appendChild(addSection);

  const addHeader = document.createElement('div');
  addHeader.style.cssText = 'font-size: var(--text-xs); font-weight: var(--weight-semibold); color: var(--color-text-muted); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: var(--space-2);';
  addHeader.textContent = '＋ Add Connection';
  addSection.appendChild(addHeader);

  // Relation type selector + search bar row
  const addRow = document.createElement('div');
  addRow.style.cssText = 'display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap;';
  addSection.appendChild(addRow);

  // Relation label input
  const relationInput = document.createElement('input');
  relationInput.type = 'text';
  relationInput.className = 'input';
  relationInput.placeholder = 'Relation label (e.g. "related to")';
  relationInput.value = 'related to';
  relationInput.style.cssText = 'width: 160px; font-size: var(--text-xs); padding: var(--space-1-5) var(--space-2);';
  addRow.appendChild(relationInput);

  // Quick relation presets
  const presets = ['related to', 'part of', 'blocked by', 'assigned to', 'daily review', 'belongs to', 'see also'];
  const presetRow = document.createElement('div');
  presetRow.style.cssText = 'display: flex; flex-wrap: wrap; gap: var(--space-1); margin-top: var(--space-1-5);';
  for (const p of presets) {
    const chip = document.createElement('button');
    chip.textContent = p;
    chip.style.cssText = `
      font-size: 10px; padding: 2px 8px; border-radius: 99px;
      border: 1px solid var(--color-border); background: var(--color-surface);
      color: var(--color-text-muted); cursor: pointer;
      transition: all 0.12s ease;
    `;
    chip.addEventListener('click', () => {
      relationInput.value = p;
      chip.style.background = 'var(--color-accent)';
      chip.style.color = '#fff';
      chip.style.borderColor = 'var(--color-accent)';
      // Reset siblings
      presetRow.querySelectorAll('button').forEach(b => {
        if (b !== chip) { b.style.background = ''; b.style.color = ''; b.style.borderColor = ''; }
      });
    });
    presetRow.appendChild(chip);
  }
  addSection.appendChild(presetRow);

  // ── Live search box ───────────────────────────────────────
  const searchWrap = document.createElement('div');
  searchWrap.style.cssText = 'position: relative; margin-top: var(--space-2);';
  addSection.appendChild(searchWrap);

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'input';
  searchInput.placeholder = '🔍 Search all entities — type to filter…';
  searchInput.setAttribute('aria-label', 'Search entities to link');
  searchInput.style.cssText = 'width: 100%; font-size: var(--text-sm); padding: var(--space-2) var(--space-3);';
  searchWrap.appendChild(searchInput);

  const resultsList = document.createElement('div');
  resultsList.style.cssText = `
    display: none;
    position: absolute; top: 100%; left: 0; right: 0; z-index: 100;
    background: var(--color-bg); border: 1px solid var(--color-border);
    border-radius: var(--radius-md); box-shadow: var(--shadow-panel);
    max-height: 320px; overflow-y: auto;
    margin-top: 2px;
  `;
  searchWrap.appendChild(resultsList);

  // Load ALL entities sorted by updatedAt desc (most recent first)
  let _allEntities = [];
  let _searchDebounce = null;

  // Show loading state in search input while entities load
  searchInput.placeholder = 'Loading entities…';
  searchInput.disabled = true;

  const loadAllEntities = async () => {
    try {
      const allTypes = getAllEntityTypes();
      const arrays = await Promise.all(allTypes.map(t => getEntitiesByType(t.key).catch(() => [])));
      _allEntities = arrays.flat()
        .filter(e => !e.deleted && e.id !== _entity.id)
        .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));
    } catch (err) {
      console.warn('[entity-panel] loadAllEntities failed:', err);
    }
  };

  await loadAllEntities();
  searchInput.placeholder = '🔍 Search all entities — type to filter…';
  searchInput.disabled = false;

  // Get set of already-linked entity IDs
  const getLinkedIds = async () => {
    const [out, inc] = await Promise.all([
      getEdgesFrom(_entity.id),
      getEdgesTo(_entity.id),
    ]);
    return new Set([...out.map(e => e.toId), ...inc.map(e => e.fromId)]);
  };

  let _linkedIds = await getLinkedIds();

  const renderSearchResults = (query) => {
    resultsList.innerHTML = '';
    const q = query.trim().toLowerCase();

    let candidates = _allEntities;
    if (q) {
      candidates = _allEntities.filter(e => {
        const title = _getDisplayTitle(e).toLowerCase();
        const type  = (e.type || '').toLowerCase();
        return title.includes(q) || type.includes(q);
      });
    }

    // Cap at 40 results
    const results = candidates.slice(0, 40);

    if (results.length === 0) {
      resultsList.innerHTML = '';
      const emptyDiv = document.createElement('div');
      emptyDiv.style.cssText = 'padding:var(--space-3);font-size:var(--text-xs);color:var(--color-text-muted);text-align:center;';
      emptyDiv.textContent = `No entities found${q ? ` matching "${q}"` : ''}`;
      resultsList.appendChild(emptyDiv);
      if (q) {
        const createDiv = document.createElement('button');
        createDiv.style.cssText = 'display:block;width:100%;padding:var(--space-2) var(--space-3);border:none;' +
          'background:var(--color-accent-muted);color:var(--color-accent);cursor:pointer;' +
          'font-size:var(--text-xs);font-weight:var(--weight-semibold);text-align:left;border-top:1px solid var(--color-border);';
        createDiv.textContent = `+ Create "${q}" as new entity`;
        createDiv.addEventListener('click', () => {
          resultsList.style.display = 'none';
          // Build a type-picker row so user can choose what type to create
          const pickerWrap = document.createElement('div');
          pickerWrap.style.cssText = 'display:flex;gap:var(--space-2);align-items:center;margin-top:var(--space-2);flex-wrap:wrap;';
          const pickerLabel = document.createElement('span');
          pickerLabel.style.cssText = 'font-size:var(--text-xs);color:var(--color-text-muted);white-space:nowrap;';
          pickerLabel.textContent = 'Create as:';
          const typeSelect = document.createElement('select');
          typeSelect.className = 'select'; // [G10b fix] was 'input' — needs dropdown arrow
          typeSelect.style.cssText = 'font-size:var(--text-xs);padding:3px 6px;flex:1;min-width:100px;';
          const creatableTypes = getAllEntityTypes().filter(t => !t.archived);
          for (const tp of creatableTypes) {
            const opt = document.createElement('option');
            opt.value = tp.key;
            opt.textContent = (tp.icon ? tp.icon + ' ' : '') + tp.label;
            typeSelect.appendChild(opt);
          }
          const goBtn = document.createElement('button');
          goBtn.textContent = 'Create';
          goBtn.style.cssText = 'font-size:var(--text-xs);padding:3px 10px;background:var(--color-accent);color:#fff;border:none;border-radius:var(--radius-sm);cursor:pointer;white-space:nowrap;';
          goBtn.addEventListener('click', () => {
            const chosenType = typeSelect.value;
            if (!chosenType) return;
            pickerWrap.remove();
            openQuickCreateModal(chosenType, { title: q }, async newEnt => {
              if (!newEnt) return;
              const acct = getAccount();
              const rel = relationInput.value.trim() || 'related to';
              await saveEdge({ fromId: _entity.id, toId: newEnt.id, relation: rel }, acct?.id);
              await loadAllEntities();
              _linkedIds = await getLinkedIds();
              searchInput.value = '';
              resultsList.style.display = 'none';
              _renderRelationsTab(container);
            });
          });
          pickerWrap.append(pickerLabel, typeSelect, goBtn);
          // Insert picker below the results list
          resultsList.parentNode.insertBefore(pickerWrap, resultsList.nextSibling);
        });
        resultsList.appendChild(createDiv);
      }
      resultsList.style.display = 'block';
      return;
    }

    for (const ent of results) {
      const cfg      = getEntityTypeConfig(ent.type);
      const title    = _getDisplayTitle(ent);
      const isLinked = _linkedIds.has(ent.id);

      const item = document.createElement('div');
      item.style.cssText = `
        display: flex; align-items: center; gap: var(--space-2);
        padding: var(--space-2) var(--space-3); cursor: pointer;
        transition: background 0.1s; border-bottom: 1px solid var(--color-border);
        ${isLinked ? 'opacity: 0.45;' : ''}
      `;

      const timeAgo = _relativeTime(ent.updatedAt || ent.createdAt);

      item.innerHTML = `
        <span style="font-size: 1rem; flex-shrink: 0;">${cfg?.icon || '📎'}</span>
        <div style="flex: 1; min-width: 0;">
          <div style="font-size: var(--text-sm); font-weight: var(--weight-medium); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${_escHtml(title)}</div>
          <div style="font-size: 10px; color: var(--color-text-muted);">${_escHtml(cfg?.label || ent.type)} · ${_escHtml(timeAgo)}</div>
        </div>
        <span style="font-size: 10px; padding: 2px 6px; border-radius: 99px; background: ${cfg?.color || '#94a3b8'}22; color: ${cfg?.color || '#94a3b8'}; font-weight: 600; flex-shrink: 0;">${isLinked ? '✓ linked' : '+ link'}</span>
      `;

      item.addEventListener('mouseenter', () => { if (!isLinked) item.style.background = 'var(--color-surface)'; });
      item.addEventListener('mouseleave', () => { item.style.background = ''; });

      item.addEventListener('click', async () => {
        if (isLinked) return;
        try {
          const relation = relationInput.value.trim() || 'related to';
          await saveEdge({
            fromId:   _entity.id,
            fromType: _entity.type,
            toId:     ent.id,
            toType:   ent.type,
            relation,
          });
          _linkedIds.add(ent.id);
          // Mark as linked in result
          item.style.opacity = '0.45';
          const pill = item.querySelector('span:last-child');
          if (pill) { pill.textContent = '✓ linked'; }
          // Refresh connections list
          await _renderConnectionsList(connContainer);
        } catch (err) {
          console.error('[entity-panel] saveEdge failed:', err);
        }
      });

      resultsList.appendChild(item);
    }

    resultsList.style.display = 'block';
  };

  searchInput.addEventListener('focus', () => {
    renderSearchResults(searchInput.value);
  });

  searchInput.addEventListener('input', () => {
    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(() => renderSearchResults(searchInput.value), 120);
  });

  // Close results on click outside — store ref so we can remove it
  const _closeResultsOnOutsideClick = (e) => {
    if (!searchWrap.contains(e.target)) {
      resultsList.style.display = 'none';
    }
  };
  document.addEventListener('click', _closeResultsOnOutsideClick);

  // Clean up when the panel body is replaced (next tab switch or close)
  const _cleanupRelationsTab = () => {
    document.removeEventListener('click', _closeResultsOnOutsideClick);
  };
  // Use a MutationObserver to detect when searchWrap is removed from DOM
  const _relObserver = new MutationObserver(() => {
    if (!document.contains(searchWrap)) {
      _cleanupRelationsTab();
      _relObserver.disconnect();
    }
  });
  _relObserver.observe(document.body, { childList: true, subtree: true });

  // ── Existing connections list ──────────────────────────────
  const connHeader = document.createElement('div');
  connHeader.style.cssText = 'font-size: var(--text-xs); font-weight: var(--weight-semibold); color: var(--color-text-muted); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: var(--space-2);';
  connHeader.textContent = 'Connections';
  container.appendChild(connHeader);

  const connContainer = document.createElement('div');
  container.appendChild(connContainer);

  await _renderConnectionsList(connContainer);
}

/**
 * Render the list of all existing connections for _entity,
 * grouped by relation label, sorted most-recent-first.
 * Each row has: icon · title · type badge · direction · remove button
 */
async function _renderConnectionsList(container) {
  if (!_entity) return;

  container.innerHTML = '<div style="font-size: var(--text-xs); color: var(--color-text-muted); padding: var(--space-2);">Loading…</div>';

  try {
    const [outgoing, incoming] = await Promise.all([
      getEdgesFrom(_entity.id),
      getEdgesTo(_entity.id),
    ]);

    // Resolve all linked entities and sort by updatedAt desc
    // Resolve all linked entities concurrently (O(1) vs O(n) sequential IDB reads)
    const [outResolved, inResolved] = await Promise.all([
      Promise.all(outgoing.map(edge => getEntity(edge.toId).then(e => ({ edge, linked: e, direction: 'out' })).catch(() => null))),
      Promise.all(incoming.map(edge => getEntity(edge.fromId).then(e => ({ edge, linked: e, direction: 'in' })).catch(() => null))),
    ]);

    const items = [];
    const _seenEdgeKeys = new Set();
    for (const r of [...outResolved, ...inResolved]) {
      if (!r || !r.linked || r.linked.deleted) continue;
      // Deduplicate: same direction + same linked entity + same relation
      const linkedId = r.direction === 'out' ? r.edge.toId : r.edge.fromId;
      const edgeKey = `${r.direction}:${linkedId}:${r.edge.relation || ''}`;
      if (_seenEdgeKeys.has(edgeKey)) continue;
      _seenEdgeKeys.add(edgeKey);
      items.push({ ...r, sortKey: r.linked.updatedAt || r.linked.createdAt || '' });
    }

    // Sort by most recent first
    items.sort((a, b) => b.sortKey.localeCompare(a.sortKey));

    container.innerHTML = '';

    if (items.length === 0) {
      container.innerHTML = `
        <div style="padding: var(--space-6) var(--space-2); text-align: center; color: var(--color-text-muted); font-size: var(--text-sm);">
          <div style="font-size: 2rem; margin-bottom: var(--space-2);">🔗</div>
          <div>No connections yet</div>
          <div style="font-size: var(--text-xs); margin-top: var(--space-1);">Search above to add connections</div>
        </div>
      `;
      return;
    }

    // Group by relation label — humanize raw camelCase keys
    const _humanRel = (rel) => {
      if (!rel) return 'related to';
      // Already human (has spaces or is lowercase with spaces)
      if (rel.includes(' ')) return rel.toLowerCase();
      // camelCase → "camel case"
      return rel.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
    };
    const groups = new Map();
    for (const item of items) {
      const relation = _humanRel(item.edge.relation);
      const dir      = item.direction === 'out' ? '→' : '←';
      // Bug-30 fix: group by relation only, not direction+relation, so old 'assignedTo'
      // and new 'assigned to' edges merge into the same group; direction shown per row.
      const key      = relation;
      if (!groups.has(key)) groups.set(key, { dir, items: [] });
      groups.get(key).items.push(item);
    }

    for (const [groupLabel, { dir: groupDir, items: groupItems }] of groups) {
      const section = document.createElement('div');
      section.style.cssText = 'margin-bottom: var(--space-3);';

      const header = document.createElement('div');
      header.style.cssText = `
        font-size: 10px; font-weight: var(--weight-semibold);
        color: var(--color-text-muted); text-transform: uppercase;
        letter-spacing: 0.05em; padding: var(--space-1) 0 var(--space-1);
        border-bottom: 1px solid var(--color-border); margin-bottom: var(--space-1);
        display: flex; align-items: center; justify-content: space-between;
      `;
      header.innerHTML = `
        <span>${groupDir} ${_escHtml(groupLabel)}</span>
        <span style="font-weight:400; text-transform:none; letter-spacing:0;">${groupItems.length} item${groupItems.length !== 1 ? 's' : ''}</span>
      `;
      section.appendChild(header);

      for (const { edge, linked, direction } of groupItems) {
        const cfg      = getEntityTypeConfig(linked.type);
        const title    = _getDisplayTitle(linked);
        const timeAgo  = _relativeTime(linked.updatedAt || linked.createdAt);

        const row = document.createElement('div');
        row.dataset.edgeId = edge.id;
        row.style.cssText = `
          display: flex; align-items: center; gap: var(--space-2);
          padding: var(--space-2) var(--space-1-5);
          border-radius: var(--radius-sm);
          transition: background var(--transition-fast);
          cursor: pointer;
        `;

        const dirArrow = direction === 'out'
          ? `<span style="color: var(--color-accent); font-size: 10px; flex-shrink:0;">→</span>`
          : `<span style="color: var(--color-text-muted); font-size: 10px; flex-shrink:0;">←</span>`;

        row.innerHTML = `
          ${dirArrow}
          <span style="font-size: 1rem; flex-shrink: 0;">${cfg?.icon || '📎'}</span>
          <div style="flex: 1; min-width: 0;">
            <div style="font-size: var(--text-sm); font-weight: var(--weight-medium); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${_escHtml(title)}</div>
            <div style="font-size: 10px; color: var(--color-text-muted);">${_escHtml(cfg?.label || linked.type)} · ${_escHtml(timeAgo)}</div>
          </div>
          <span class="type-badge" style="background: ${cfg?.color || '#94a3b8'}; font-size: 9px; padding: 1px 6px; flex-shrink:0;">${_escHtml(cfg?.label || linked.type)}</span>
          <button class="rel-remove-btn" title="Remove connection" style="
            background: none; border: none; cursor: pointer; padding: 2px 4px;
            color: var(--color-text-muted); font-size: 0.85rem; border-radius: var(--radius-sm);
            flex-shrink: 0; line-height: 1; opacity: 0.5; transition: opacity 0.1s, color 0.1s;
          ">✕</button>
        `;

        row.addEventListener('mouseenter', () => {
          row.style.background = 'var(--color-surface-2)';
          row.querySelector('.rel-remove-btn')?.style && (row.querySelector('.rel-remove-btn').style.opacity = '1');
        });
        row.addEventListener('mouseleave', () => {
          row.style.background = '';
          row.querySelector('.rel-remove-btn')?.style && (row.querySelector('.rel-remove-btn').style.opacity = '0.5');
        });

        // Click row → smart navigation based on linked entity type
        row.addEventListener('click', (e) => {
          if (e.target.classList.contains('rel-remove-btn')) return;
          _navigateToLinkedEntity(linked);
        });

        // Remove button
        const removeBtn = row.querySelector('.rel-remove-btn');
        removeBtn?.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (removeBtn) removeBtn.style.color = 'var(--color-danger)';
          try {
            await deleteEdge(edge.id);
            row.style.opacity = '0';
            row.style.transition = 'opacity 0.2s';
            setTimeout(() => {
              row.remove();
              // Update group count
              const remaining = section.querySelectorAll('[data-edge-id]').length;
              if (remaining === 0) section.remove();
              else header.querySelector('span:last-child').textContent =
                `${remaining} item${remaining !== 1 ? 's' : ''}`;
            }, 220);
          } catch (err) {
            console.error('[entity-panel] deleteEdge failed:', err);
          }
        });

        section.appendChild(row);
      }

      container.appendChild(section);
    }

    // Total count at bottom
    const total = document.createElement('div');
    total.style.cssText = 'font-size: 10px; color: var(--color-text-muted); text-align: center; padding: var(--space-2); margin-top: var(--space-1);';
    total.textContent = `${items.length} total connection${items.length !== 1 ? 's' : ''}`;
    container.appendChild(total);

  } catch (err) {
    console.error('[entity-panel] _renderConnectionsList failed:', err);
    container.innerHTML = '<div style="color: var(--color-danger); font-size: var(--text-sm); padding: var(--space-3);">Failed to load connections.</div>';
  }
}

/**
 * Smart navigation when a linked entity is clicked in the Relations tab.
 * - dailyReview  → navigate to that specific date in Daily Review view
 * - task         → navigate to Kanban and open the task panel
 * - anything else → just open the entity panel
 * @param {object} linked  the linked entity object (must have .id, .type, .date)
 */
function _navigateToLinkedEntity(linked) {
  if (!linked) return;

  // [minor] Fix: always close graph view before navigating away to another view
  // Without this, navigate() fires VIEW_CHANGED which tears down graph mid-flight
  if (_graphViewActive) _closeGraphView();

  if (linked.type === 'dailyReview') {
    // Prefer .date field; fall back to parsing title 'Daily Review — MM-DD-YYYY'
    let dateStr = linked.date || null;
    if (!dateStr && linked.title) {
      const m = linked.title.match(/(\d{2})-(\d{2})-(\d{4})$/);
      if (m) dateStr = `${m[3]}-${m[1]}-${m[2]}`; // → YYYY-MM-DD
    }
    if (dateStr) {
      navigate('daily', { date: dateStr }, `Daily Review — ${_formatDateForTitle(dateStr)}`);
      return;
    }
    // No date available — open form (form-first UX)
    emit(EVENTS.PANEL_OPENED, { entityId: linked.id, entityType: 'dailyReview' });
    return;
  }

  if (linked.type === 'task') {
    // Navigate to kanban today tab with kanban view, then open the form for that task (form-first UX)
    navigate('kanban', { filterTab: 'today', viewMode: 'kanban' }, 'Tasks');
    setTimeout(() => emit(EVENTS.PANEL_OPENED, { entityId: linked.id, entityType: 'task' }), 200);
    return;
  }

  if (linked.type === 'event' || linked.type === 'appointment') {
    navigate('calendar', {}, 'Calendar');
    setTimeout(() => emit(EVENTS.PANEL_OPENED, { entityId: linked.id, entityType: linked.type }), 200);
    return;
  }

  // Default: just open the entity panel
  openPanel(linked.id);
}

/** Human-readable relative time: "2h ago", "3 days ago", "just now" */
function _relativeTime(isoStr) {
  if (!isoStr) return '';
  try {
    const diff = Date.now() - new Date(isoStr).getTime();
    const s = Math.floor(diff / 1000);
    if (s < 60)     return 'just now';
    if (s < 3600)   return `${Math.floor(s / 60)}m ago`;
    if (s < 86400)  return `${Math.floor(s / 3600)}h ago`;
    if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
    return new Date(isoStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch { return ''; }
}

/** HTML escape helper */
function _escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/**
 * [v5.8.0] Tasks tab — shows all tasks linked to this project.
 * Fetches via both graph edges ('project' + 'part of') and direct entity.project field.
 * Groups by status. Provides inline status toggle and + Add Task button.
 */
async function _renderProjectTasksTab(container) {
  if (!_entity || _entity.type !== 'project') return;
  const projectId = _entity.id;
  const projectTitle = _entity.name || _entity.title || 'this project';

  container.innerHTML = '<div style="color:var(--color-text-muted);font-size:var(--text-xs);padding:var(--space-2);">Loading tasks…</div>';

  try {
    // ── Load all tasks linked to this project ────────────────
    // Dual-path: graph edges (form/panel created) + direct entity.project field (template created)
    const [allTasks, edgesProject, edgesPartOf] = await Promise.all([
      getEntitiesByType('task').catch(() => []),
      getEdgesTo(projectId, 'project').catch(() => []),
      getEdgesTo(projectId, 'part of').catch(() => []),
    ]);

    if (!_entity || _entity.id !== projectId) return; // stale guard

    const edgeTaskIds = new Set([...edgesProject, ...edgesPartOf].map(e => e.fromId));
    const tasks = allTasks.filter(t =>
      !t.deleted && (t.project === projectId || edgeTaskIds.has(t.id))
    );

    // [Sequential mode] determine which task is current and which are blocked
    const isSequential = _entity?.completionMode === 'Sequential';
    let _seqCurrentId  = null;
    let _seqBlockedIds = new Set();
    if (isSequential) {
      try {
        const state = getSequentialTaskState(_entity, tasks);
        _seqCurrentId  = state.currentId;
        _seqBlockedIds = state.blockedIds;
      } catch { /* non-fatal */ }
    }

    container.innerHTML = '';

    // ── Header row: task count + Add Task button ─────────────
    const headerRow = document.createElement('div');
    headerRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-4);';

    const countEl = document.createElement('span');
    countEl.style.cssText = 'font-size:var(--text-xs);font-weight:var(--weight-semibold);color:var(--color-text-muted);text-transform:uppercase;letter-spacing:0.06em;';
    const doneCount = tasks.filter(t => t.status === 'Done' || t.status === 'Completed').length;
    const modeLabel = isSequential ? ' · 🔢 Sequential' : '';
    countEl.textContent = `${tasks.length} task${tasks.length !== 1 ? 's' : ''} · ${doneCount} done${modeLabel}`;
    headerRow.appendChild(countEl);

    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn-sm btn-primary';
    addBtn.style.cssText = 'font-size:var(--text-xs);padding:4px 10px;';
    addBtn.innerHTML = '+ Add Task';
    addBtn.addEventListener('click', () => {
      openForm('task', {
        project: projectId,
        projectTitle,
        context: _entity.context || 'family',
      });
    });
    headerRow.appendChild(addBtn);
    container.appendChild(headerRow);

    if (tasks.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'text-align:center;padding:var(--space-6) var(--space-2);color:var(--color-text-muted);font-size:var(--text-sm);';
      empty.innerHTML = '<div style="font-size:2rem;margin-bottom:var(--space-2);">📋</div><div>No tasks yet</div><div style="font-size:var(--text-xs);margin-top:var(--space-1);">Click + Add Task to create one</div>';
      container.appendChild(empty);
      return;
    }

    // ── Group tasks by status ────────────────────────────────
    const STATUS_ORDER = ['In Progress', 'Not Started', 'Blocked', 'On Hold', 'Done', 'Completed', 'Skipped'];
    const DONE_STATUSES = new Set(['Done', 'Completed', 'Skipped']);
    const groups = new Map();
    for (const status of STATUS_ORDER) groups.set(status, []);
    for (const t of tasks) {
      const s = t.status || 'Not Started';
      if (!groups.has(s)) groups.set(s, []);
      groups.get(s).push(t);
    }

    const STATUS_COLOR = {
      'In Progress': 'var(--color-accent)',
      'Done':        'var(--color-success,#16a34a)',
      'Completed':   'var(--color-success,#16a34a)',
      'Blocked':     'var(--color-danger)',
      'Not Started': 'var(--color-text-muted)',
      'Skipped':     'var(--color-text-muted)',
      'On Hold':     'var(--color-warning,#d97706)',
    };

    for (const [status, statusTasks] of groups) {
      if (statusTasks.length === 0) continue;

      // Group header
      const groupHdr = document.createElement('div');
      groupHdr.style.cssText = 'font-size:10px;font-weight:var(--weight-semibold);color:var(--color-text-muted);text-transform:uppercase;letter-spacing:0.06em;padding:var(--space-1) 0;border-bottom:1px solid var(--color-border);margin-bottom:var(--space-1-5);margin-top:var(--space-3);display:flex;align-items:center;justify-content:space-between;';
      const dotColor = STATUS_COLOR[status] || 'var(--color-text-muted)';
      groupHdr.innerHTML = `<span style="display:flex;align-items:center;gap:6px;"><span style="width:7px;height:7px;border-radius:50%;background:${dotColor};flex-shrink:0;"></span>${_escHtml(status)}</span><span style="font-weight:400;text-transform:none;letter-spacing:0;">${statusTasks.length}</span>`;
      container.appendChild(groupHdr);

      for (const task of statusTasks.sort((a,b) => {
        // Sort by priority then by title
        const PRIO = { 'Critical':0,'High':1,'Medium':2,'Low':3 };
        const pa = PRIO[a.priority] ?? 2;
        const pb = PRIO[b.priority] ?? 2;
        return pa !== pb ? pa - pb : (a.title||'').localeCompare(b.title||'');
      })) {
        const isDone = DONE_STATUSES.has(task.status);
        const isBlocked = isSequential && _seqBlockedIds.has(task.id);
        const isCurrent = isSequential && _seqCurrentId === task.id;
        const row = document.createElement('div');
        row.style.cssText = `display:flex;align-items:center;gap:var(--space-2);padding:var(--space-1-5) var(--space-1);border-radius:var(--radius-sm);cursor:pointer;transition:background 0.12s;${isBlocked ? 'opacity:0.45;' : ''}`;
        row.addEventListener('mouseenter', () => { row.style.background = 'var(--color-surface)'; });
        row.addEventListener('mouseleave', () => { row.style.background = ''; });

        // Checkbox for quick complete/uncomplete
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = isDone;
        cb.style.cssText = 'flex-shrink:0;cursor:pointer;width:15px;height:15px;accent-color:var(--color-accent);';
        cb.title = isDone ? 'Mark incomplete' : isBlocked ? 'Blocked until previous task is done' : 'Mark complete';
        if (isBlocked) cb.disabled = true;
        cb.addEventListener('click', async (e) => {
          e.stopPropagation();
          const acct = getAccount();
          const newStatus = isDone ? 'In Progress' : 'Done';
          try {
            await saveEntity({ ...task, status: newStatus }, acct?.id);
            // Re-render the tab
            const c = _panelBody?.querySelector('.panel-view-container');
            if (c) _renderProjectTasksTab(c);
          } catch (err) {
            console.error('[panel] task status toggle:', err);
          }
        });

        // Priority dot
        const PRIO_COLOR = { 'Critical':'#ef4444','High':'#f97316','Medium':'#f59e0b','Low':'#94a3b8' };
        const prioColor = PRIO_COLOR[task.priority] || '#94a3b8';
        const prioDot = document.createElement('span');
        prioDot.style.cssText = `width:6px;height:6px;border-radius:50%;background:${prioColor};flex-shrink:0;`;
        prioDot.title = task.priority || 'Medium';

        // Task title
        const titleEl = document.createElement('span');
        titleEl.style.cssText = `flex:1;font-size:var(--text-sm);color:var(--color-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${isDone ? 'text-decoration:line-through;opacity:0.55;' : ''}`;
        titleEl.textContent = task.title || '(Untitled)';

        // Sequential mode label
        if (isCurrent && !isDone) {
          const curTag = document.createElement('span');
          curTag.style.cssText = 'font-size:9px;background:var(--color-accent);color:#fff;padding:1px 6px;border-radius:99px;flex-shrink:0;font-weight:600;';
          curTag.textContent = 'Up Next';
          titleEl.after(curTag);
        } else if (isBlocked) {
          const blockTag = document.createElement('span');
          blockTag.style.cssText = 'font-size:9px;background:var(--color-surface);color:var(--color-text-muted);padding:1px 6px;border-radius:99px;flex-shrink:0;border:1px solid var(--color-border);';
          blockTag.textContent = '🔒 Blocked';
          titleEl.after(blockTag);
        }

        // Due date
        const dueEl = document.createElement('span');
        dueEl.style.cssText = 'font-size:10px;color:var(--color-text-muted);white-space:nowrap;flex-shrink:0;';
        if (task.dueDate) {
          const today = new Date(); today.setHours(0,0,0,0);
          const [y,mo,d] = task.dueDate.split('-').map(Number);
          const due = new Date(y, mo-1, d);
          const isOverdue = !isDone && due < today;
          const isSoon = !isDone && !isOverdue && (due - today) <= 3*86400000;
          dueEl.textContent = `${mo}/${d}`;
          if (isOverdue) dueEl.style.color = 'var(--color-danger)';
          else if (isSoon) dueEl.style.color = 'var(--color-warning,#d97706)';
        }

        row.append(cb, prioDot, titleEl, dueEl);

        // Click row (not checkbox) → open task in panel
        row.addEventListener('click', (e) => {
          if (e.target === cb) return;
          emit(EVENTS.PANEL_OPENED, { entityId: task.id });
        });

        container.appendChild(row);
      }
    }

  } catch (err) {
    console.error('[panel] _renderProjectTasksTab failed:', err);
    container.innerHTML = '<div style="color:var(--color-danger);font-size:var(--text-xs);padding:var(--space-3);">Failed to load tasks. Please try again.</div>';
  }
}

/** Alias required by _renderSeriesTab and other inline template callers */
const _esc = _escHtml;

// ════════════════════════════════════════════════════════════
// ACTIVITY TAB
// ════════════════════════════════════════════════════════════

async function _renderActivityTab(container) {
  if (!_entity) return;

  container.innerHTML = '<div style="font-size: var(--text-xs); color: var(--color-text-muted); padding: var(--space-2);">Loading activity…</div>';

  try {
    const [rec, authData] = await Promise.all([
      getSetting('auditLog'),
      getSetting('auth'),
    ]);
    const log = Array.isArray(rec) ? rec : [];

    // Build accountId → display name map (parallel IDB reads)
    const accountMap = new Map();
    const accounts = authData?.accounts || [];
    await Promise.all(accounts.map(async (acct) => {
      if (acct.memberId) {
        const person = await getEntity(acct.memberId).catch(() => null);
        accountMap.set(acct.id, person?.name || person?.title || acct.username || acct.id);
      } else {
        accountMap.set(acct.id, acct.username || acct.id);
      }
    }));

    // Filter to this entity, newest first
    const entries = log
      .filter(e => e.entityId === _entity.id)
      .reverse()
      .slice(0, 50);

    container.innerHTML = '';

    if (entries.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="padding: var(--space-8);">
          <div class="empty-state-icon">📋</div>
          <div class="empty-state-title">No activity yet</div>
          <div class="empty-state-desc">Changes to this ${_config.label.toLowerCase()} will appear here.</div>
        </div>
      `;
      return;
    }

    const list = document.createElement('div');
    list.style.cssText = 'display: flex; flex-direction: column; gap: var(--space-1);';

    for (const entry of entries) {
      const item = document.createElement('div');
      item.style.cssText = `
        display: flex; flex-direction: column; gap: var(--space-1); padding: var(--space-2);
        border-bottom: 1px solid color-mix(in srgb, var(--color-border) 50%, transparent);
        font-size: var(--text-xs);
      `;

      const icon = entry.action === 'create' ? '✨'
                 : entry.action === 'delete' ? '🗑️'
                 : entry.action === 'link'   ? '🔗'
                 : entry.action === 'unlink' ? '🔓'
                 : '✏️';

      // Resolve old/new values — if they look like entity IDs, try to fetch display names
      let oldDisplay = entry.oldValue != null ? String(entry.oldValue) : null;
      let newDisplay = entry.newValue != null ? String(entry.newValue) : null;

      // Resolve old/new values — if they look like entity IDs, try to fetch display names
      // An ID is any value: length > 8, no spaces, not a date/number/boolean
      const _looksLikeId = (v) => v && v.length > 8 && !v.includes(' ') &&
        !/^\d{4}-\d{2}-\d{2}/.test(v) && isNaN(Number(v));

      // Resolve both values concurrently
      const [resolvedOld, resolvedNew] = await Promise.all([
        _looksLikeId(oldDisplay) ? getEntity(oldDisplay).then(e => (e ? (e.name || e.title || oldDisplay) : oldDisplay)).catch(() => oldDisplay) : Promise.resolve(oldDisplay),
        _looksLikeId(newDisplay) ? getEntity(newDisplay).then(e => (e ? (e.name || e.title || newDisplay) : newDisplay)).catch(() => newDisplay) : Promise.resolve(newDisplay),
      ]);
      oldDisplay = resolvedOld;
      newDisplay = resolvedNew;

      let desc = `${icon} ${_capitalize(entry.action || 'updated')}`;
      if (entry.field) {
        desc += ` — ${entry.field}`;
        if (oldDisplay != null || newDisplay != null) {
          const old = oldDisplay != null ? `"${_truncate(oldDisplay, 25)}"` : 'empty';
          const nw  = newDisplay != null ? `"${_truncate(newDisplay, 25)}"` : 'empty';
          desc += `: ${old} → ${nw}`;
        }
      }

      // Resolve byAccountId to display name
      const byName = entry.byAccountId ? accountMap.get(entry.byAccountId) : null;

      const topRow = document.createElement('div');
      topRow.style.cssText = 'display: flex; gap: var(--space-2); align-items: flex-start;';
      topRow.innerHTML = `
        <div style="flex: 1; color: var(--color-text);">${desc}</div>
        <div style="flex-shrink: 0; color: var(--color-text-muted); white-space: nowrap;">${_formatDateShort(entry.at)}</div>
      `;
      item.appendChild(topRow);

      if (byName) {
        const byRow = document.createElement('div');
        byRow.style.cssText = 'color: var(--color-text-muted); font-size: var(--text-xs); padding-left: var(--space-1);';
        byRow.textContent = `by ${byName}`;
        item.appendChild(byRow);
      }

      list.appendChild(item);
    }

    container.appendChild(list);

  } catch (err) {
    console.error('[entity-panel] Activity tab error:', err);
    container.innerHTML = '<div style="color: var(--color-danger); font-size: var(--text-sm); padding: var(--space-4);">Failed to load activity.</div>';
  }
}

// ════════════════════════════════════════════════════════════
// GRAPH VIEW — side-by-side: graph (left) + entity panel (right)
// ════════════════════════════════════════════════════════════

/**
 * Open the full side-by-side graph view.
 * Graph canvas fills #view-graph (left), entity panel stays open (right).
 * Single-click a node → update panel to that entity.
 * Double-click a node → drill focus + update panel.
 * "Exit Graph" button → close graph, return to previous view.
 */
async function _openGraphView(entityId) {
  if (!entityId) return;
  // Guard: if already in graph view, just update the focused entity
  if (_graphViewActive) {
    await openPanel(entityId);
    return;
  }

  const main    = document.getElementById('main');
  const viewEl  = document.getElementById('view-graph');
  if (!main || !viewEl) return;

  // ── Remember current view so we can restore on exit ─────
  const currentActiveView = document.querySelector('.view.active');
  _graphPreviousView = currentActiveView?.id?.replace('view-', '') || 'kanban';

  // ── Hide all views, show graph view ─────────────────────
  document.querySelectorAll('.view').forEach(el => {
    el.classList.remove('active');
    el.setAttribute('aria-hidden', 'true');
  });
  viewEl.classList.add('active');
  viewEl.setAttribute('aria-hidden', 'false');
  main.classList.add('graph-active');

  // ── Build the graph view DOM ────────────────────────────
  viewEl.innerHTML = '';

  // Graph canvas column (fills the main area)
  const graphCol = document.createElement('div');
  graphCol.id = 'graph-canvas-column';
  graphCol.style.cssText = `
    position: relative;
    grid-column: 1 / -1;
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    background: var(--color-surface);
  `;

  // ── Toolbar ─────────────────────────────────────────────
  const toolbar = document.createElement('div');
  toolbar.style.cssText = `
    display: flex; align-items: center; gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--color-border);
    background: var(--color-bg);
    flex-shrink: 0;
    z-index: 2;
  `;

  // Title
  const titleEl = document.createElement('span');
  titleEl.id = 'graph-view-title';
  titleEl.style.cssText = 'font-family: var(--font-heading); font-size: var(--text-sm); font-weight: var(--weight-semibold); white-space: nowrap;';
  titleEl.textContent = '🔮 Knowledge Graph';
  toolbar.appendChild(titleEl);

  // Spacer
  const spacer = document.createElement('span');
  spacer.style.flex = '1';
  toolbar.appendChild(spacer);

  // Hint (short)
  const hintEl = document.createElement('span');
  hintEl.style.cssText = 'font-size: 10px; color: var(--color-text-muted); white-space: nowrap;';
  hintEl.textContent = 'Click: select · Dbl-click: drill · Scroll: zoom';
  toolbar.appendChild(hintEl);

  // Exit button — prominent, always visible
  const exitBtn = document.createElement('button');
  exitBtn.className = 'btn btn-sm';
  exitBtn.style.cssText = `
    display: flex; align-items: center; gap: var(--space-1); flex-shrink: 0;
    background: var(--color-danger); color: #fff; border: none;
    padding: var(--space-1) var(--space-3); border-radius: var(--radius-sm);
    font-size: var(--text-xs); font-weight: 600; cursor: pointer;
  `;
  exitBtn.innerHTML = '✕ Exit Graph';
  exitBtn.addEventListener('click', _closeGraphView);
  toolbar.appendChild(exitBtn);

  graphCol.appendChild(toolbar);

  // ── Type filter toggles row ─────────────────────────────
  const filterRow = document.createElement('div');
  filterRow.id = 'graph-type-filters';
  filterRow.style.cssText = `
    display: flex; align-items: center; gap: var(--space-1-5);
    padding: var(--space-1-5) var(--space-3);
    border-bottom: 1px solid var(--color-border);
    background: var(--color-bg);
    flex-shrink: 0;
    flex-wrap: wrap;
    z-index: 2;
  `;
  const filterLabel = document.createElement('span');
  filterLabel.style.cssText = 'font-size: 10px; color: var(--color-text-muted); margin-right: var(--space-1);';
  filterLabel.textContent = 'Filter:';
  filterRow.appendChild(filterLabel);
  // Filter chips are populated after graph builds (see _buildGraphTypeFilters)
  graphCol.appendChild(filterRow);

  // ── Canvas ──────────────────────────────────────────────
  const canvasWrap = document.createElement('div');
  canvasWrap.style.cssText = 'flex: 1; position: relative; overflow: hidden;';

  const canvas = document.createElement('canvas');
  canvas.id = 'graph-main-canvas';
  canvas.style.cssText = 'display: block; width: 100%; height: 100%;';
  canvasWrap.appendChild(canvas);
  graphCol.appendChild(canvasWrap);

  viewEl.appendChild(graphCol);

  // ── Open triggering entity in the panel ─────────────────
  _graphViewActive    = true;
  _graphPanelEntityId = entityId;

  if (_panel) {
    _panel.classList.add('graph-mode');
    _panel.classList.add('open');
    _panel.setAttribute('aria-hidden', 'false');
  }

  try {
    await openPanel(entityId);
  } catch (err) {
    // If openPanel fails, reset graph state so it isn't permanently stuck
    console.error('[entity-panel] openPanel failed during graph open:', err);
    _graphViewActive    = false;
    _graphPanelEntityId = null;
    if (_panel) _panel.classList.remove('graph-mode');
    throw err;
  }

  // Force properties tab in graph mode
  _activeTab = 'properties';
  _renderActiveTab();

  // ── Launch graph canvas ─────────────────────────────────
  // Small delay to ensure canvas has layout dimensions
  await new Promise(r => setTimeout(r, 50));

  await initGraph(canvas, {
    mini: false,
    focusEntityId: entityId,
  });

  // ── Capture rendered type set then populate filter chips ─
  // [minor] Only types with actual nodes get chips — keeps filter bar clean.
  // _graphAllTypes grows via focusExited merge as user explores the graph.
  // _graphTypeFilters tracks which are ON (starts: all rendered types ON).
  const _initialRendered = getActiveNodeTypes();
  const _allTypeCfgs = getAllEntityTypes();
  _graphAllTypes = _allTypeCfgs.filter(cfg => _initialRendered.has(cfg.key));
  _graphTypeFilters = new Set(_graphAllTypes.map(c => c.key));
  _buildGraphTypeFilters();

  console.log('[entity-panel] [minor] Graph view opened for', entityId);
}

/**
 * Close the side-by-side graph view, restore previous view.
 */
function _closeGraphView() {
  destroyGraph();
  _graphViewActive = false;

  if (_panel) {
    _panel.classList.remove('graph-mode');
    _panel.classList.remove('graph-panel-empty');
  }

  const main   = document.getElementById('main');
  const viewEl = document.getElementById('view-graph');
  if (main)   main.classList.remove('graph-active');
  if (viewEl) {
    viewEl.classList.remove('active');
    viewEl.setAttribute('aria-hidden', 'true');
    viewEl.innerHTML = '';
  }

  // Restore previous view
  const prevViewEl = document.getElementById('view-' + (_graphPreviousView || 'kanban'));
  if (prevViewEl) {
    prevViewEl.classList.add('active');
    prevViewEl.setAttribute('aria-hidden', 'false');
  }

  // Update sidebar active state
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.view === _graphPreviousView);
  });

  _graphPreviousView  = null;
  _graphPanelEntityId = null;
  _graphAllTypes      = [];
  closePanel();

  console.log('[entity-panel] [minor] Graph view closed.');
}

/**
 * Build entity type filter toggle chips in the graph toolbar.
 *
 * [minor] Design: _graphAllTypes holds only types with actual nodes (grows on focusExited).
 * _graphTypeFilters tracks which are ON. Toggled-OFF chips stay visible greyed — never vanish.
 *
 *  ON + has nodes  → coloured chip, full opacity
 *  ON + no nodes   → coloured chip, 50% opacity
 *  OFF             → grey dashed border, inner <span> strikethrough (cross-browser safe)
 *
 * renderedTypes re-read fresh per click — no stale closure bug.
 */
function _buildGraphTypeFilters() {
  const filterRow = document.getElementById('graph-type-filters');
  if (!filterRow) return;

  // Remove old chips (keep the "Filter:" label)
  filterRow.querySelectorAll('.graph-filter-chip').forEach(c => c.remove());

  if (_graphAllTypes.length === 0) return;

  for (const cfg of _graphAllTypes) {
    const isOn     = _graphTypeFilters.has(cfg.key);
    const hasNodes = getActiveNodeTypes().has(cfg.key);  // fresh read, not stale closure

    const chip = document.createElement('button');
    chip.className       = 'graph-filter-chip';
    chip.dataset.typeKey = cfg.key;

    // Inner span so text-decoration works on inline-flex buttons (cross-browser)
    const label = document.createElement('span');
    label.textContent = `${cfg.icon} ${cfg.labelPlural || cfg.label}`;
    chip.appendChild(label);

    const applyChipStyle = (on, nodes) => {
      if (on) {
        chip.style.cssText = `
          display: inline-flex; align-items: center;
          padding: 2px 8px; border-radius: 99px;
          font-size: 10px; cursor: pointer; font-weight: 600;
          border: 1.5px solid ${cfg.color};
          background: ${cfg.color}22; color: ${cfg.color};
          transition: background 0.18s, opacity 0.18s; line-height: 1.4;
          opacity: ${nodes ? '1' : '0.5'};
        `;
        label.style.cssText = 'text-decoration: none;';
        chip.title = nodes
          ? `Hide ${cfg.labelPlural || cfg.label}`
          : `Hide ${cfg.labelPlural || cfg.label} (no entities yet)`;
      } else {
        chip.style.cssText = `
          display: inline-flex; align-items: center;
          padding: 2px 8px; border-radius: 99px;
          font-size: 10px; cursor: pointer; font-weight: 500;
          border: 1.5px dashed var(--color-border);
          background: var(--color-surface); color: var(--color-text-muted);
          transition: background 0.18s, opacity 0.18s; line-height: 1.4;
          opacity: 0.65;
        `;
        label.style.cssText = `
          text-decoration: line-through;
          text-decoration-color: var(--color-text-muted);
          text-decoration-thickness: 1.5px;
        `;
        chip.title = `Re-enable ${cfg.labelPlural || cfg.label}`;
      }
    };

    applyChipStyle(isOn, hasNodes);

    chip.addEventListener('click', () => {
      const nowOn = _graphTypeFilters.has(cfg.key);
      if (nowOn && _graphTypeFilters.size <= 1) return; // keep at least one

      if (nowOn) _graphTypeFilters.delete(cfg.key);
      else       _graphTypeFilters.add(cfg.key);

      // Fresh read at click time — not the stale hasNodes from build time
      applyChipStyle(!nowOn, getActiveNodeTypes().has(cfg.key));

      // Rebuild graph with updated type set
      setActiveTypes(new Set(_graphTypeFilters));
    });

    filterRow.appendChild(chip);
  }
}


/**
 * When a node is single-clicked in graph mode, update the panel to show
 * that entity's properties — but do NOT drill down or navigate away.
 */
/**
 * Show the graph panel (ensure .open + remove empty state).
 * Called before openPanel in graph mode so the panel is visible.
 */
function _showGraphPanel() {
  if (!_panel) return;
  _panel.classList.remove('graph-panel-empty');
  _panel.classList.add('open');
  _panel.setAttribute('aria-hidden', 'false');
  // M-02: show backdrop on mobile
  document.getElementById('entity-panel-backdrop')?.classList.add('visible');
}

/**
 * Clear graph panel content without exiting graph mode.
 * Hides the panel content visually but keeps the panel column in the layout.
 */
function _clearGraphPanel() {
  _graphPanelEntityId = null;
  _entity = null;
  _config = null;
  // Clean up activity stream subscription to prevent stale listener leaks
  if (_activityCleanup) { _activityCleanup(); _activityCleanup = null; }
  if (_panelBody)  _panelBody.innerHTML  = '';
  const headerEl = document.getElementById('entity-panel-header');
  if (headerEl)    headerEl.innerHTML    = '';
  if (_panel)      _panel.classList.add('graph-panel-empty');
}


// ════════════════════════════════════════════════════════════
// DELETE CONFIRMATION
// ════════════════════════════════════════════════════════════

async function _confirmDelete() {
  if (!_entity) return;

  const entityLabel = _config?.label || 'entity';
  const entityTitle = _entity.title || _entity.name || _entity.body?.slice(0,40) || entityLabel;
  const entityId    = _entity.id;
  const isProject   = _entity.type === 'project';

  // Capture snapshot for undo BEFORE deleting
  const snapshot = { ..._entity };

  // ── Project delete: delegated to shared flow ───────────────
  if (isProject) {
    await _deleteProjectWithTaskFlow(entityId, entityTitle, snapshot, entityLabel,
      () => { closePanel(); window.FH?._pushUndoDelete?.({ snapshot, entityLabel, entityTitle }); });
    return;
  }

  // ── Standard delete (non-project) ──────────────────────────
  let confirmed = false;
  const dialogSvc = window._fhEnv?.services?.dialog;
  if (dialogSvc) {
    confirmed = await dialogSvc.confirm(
      `Delete \u201c${entityTitle}\u201d? You can press Cmd+Z to undo within 8 seconds.`,
      { title: `Delete ${entityLabel}`, confirmLabel: 'Delete', cancelLabel: 'Keep', danger: true }
    );
  } else {
    confirmed = window.confirm(`Delete \u201c${entityTitle}\u201d? Press Cmd+Z immediately after to undo.`);
  }
  if (!confirmed) return;

  try {
    await deleteEntity(entityId);
    closePanel();
    window.FH?._pushUndoDelete?.({ snapshot, entityLabel, entityTitle });
  } catch (err) {
    console.error('[entity-panel] Delete failed:', err);
    showToast('Delete failed — please try again', 'error');
  }
}



/**
 * [v5.3.1] Render the Series tab for a recurring task template or task instance.
 * Mirrors _renderActivityTab async pattern exactly — sets loading state first,
 * then async loads. Called without await from _renderActiveTab switch.
 * Uses _esc() (module-level), getEdgesFrom/To/getEntity (already imported).
 */
async function _renderSeriesTab(container) {
  if (!_entity) return;
  const entityId = _entity.id; // capture before await (C11 async safety)

  container.innerHTML = '<div style="font-size:var(--text-xs);color:var(--color-text-muted);padding:var(--space-2);">Loading series…</div>';

  try {
    // Determine if we're on a template or an instance
    const isInstance = _entity.type === 'taskInstance';
    const templateId = isInstance ? _entity.templateId : _entity.id;

    // Load template
    const tmpl = templateId ? await getEntity(templateId).catch(() => null) : null;
    if (!_entity || _entity.id !== entityId) return; // stale — panel switched

    // Load all instances via instanceOf edges
    const edges = tmpl ? await getEdgesTo(tmpl.id, 'instanceOf').catch(() => []) : [];
    const allInsts = await Promise.all(edges.map(e => getEntity(e.fromId).catch(() => null)));
    if (!_entity || _entity.id !== entityId) return; // stale check again

    const insts = allInsts.filter(Boolean).sort((a, b) =>
      (b.periodStart || '').localeCompare(a.periodStart || '')
    );

    // Lazy-load rrule-lite for human-readable label
    let rruleHuman = '';
    if (tmpl?.rrule) {
      try {
        const m = await import('../services/rrule-lite.js');
        rruleHuman = m.rruleToHuman(tmpl.rrule);
      } catch (_) {}
    }

    const frag = document.createDocumentFragment();

    // ── Header: template summary ──────────────────────────
    if (tmpl) {
      const hdr = document.createElement('div');
      hdr.style.cssText = 'margin-bottom:var(--space-4);padding:var(--space-3);background:var(--color-surface);border-radius:var(--radius-md);border:1px solid var(--color-border);';
      hdr.innerHTML = `
        <div style="font-weight:var(--weight-semibold);margin-bottom:var(--space-2);">🔁 ${_esc(tmpl.title || 'Recurring Task')}</div>
        ${rruleHuman ? `<div style="font-size:var(--text-sm);color:var(--color-text-muted);">${_esc(rruleHuman)}</div>` : ''}
        <div style="display:flex;gap:var(--space-4);margin-top:var(--space-2);font-size:var(--text-sm);">
          <span>🔢 <b>${tmpl.occurrenceCount || 0}</b> completed</span>
          <span>🔥 <b>${tmpl.currentStreak || 0}</b> streak</span>
          <span>🏆 <b>${tmpl.longestStreak || 0}</b> best</span>
        </div>
      `;

      // [B12 fix] Instance view: add link to navigate to parent template
      if (isInstance) {
        const tmplLink = document.createElement('button');
        tmplLink.className = 'btn btn-ghost btn-sm';
        tmplLink.style.cssText = 'margin-top:var(--space-2);color:var(--color-accent);font-size:var(--text-xs);';
        tmplLink.textContent = '→ View recurring template';
        tmplLink.addEventListener('click', () => {
          emit(EVENTS.PANEL_OPENED, { entityType: 'task', entityId: tmpl.id });
        });
        hdr.appendChild(tmplLink);
      }

      // Stop series button (template view only)
      if (!isInstance) {
        const stopBtn = document.createElement('button');
        stopBtn.className = 'btn btn-ghost btn-sm';
        stopBtn.style.cssText = 'margin-top:var(--space-2);color:var(--color-danger);';
        stopBtn.textContent = '⏹ Stop recurring series';
        stopBtn.addEventListener('click', async () => {
          // [N10 fix] PWA-safe confirmation — use dialog service if available, else inline confirm
          let confirmed = false;
          const dialogSvc = window._fhEnv?.services?.dialog;
          if (dialogSvc?.confirm) {
            confirmed = await dialogSvc.confirm(
              'Stop this recurring series? All pending (Not Started) occurrences will be permanently deleted.',
              { confirmLabel: 'Stop Series', danger: true }
            ).catch(() => false);
          } else {
            // Fallback for environments where dialog service isn't yet available
            confirmed = window.confirm('Stop this recurring series? All pending occurrences will be deleted.');
          }
          if (!confirmed) return;
          stopBtn.disabled = true;
          stopBtn.textContent = '⏳ Stopping…';
          try {
            const { stopSeries } = await import('../services/recurrence.js');
            await stopSeries(tmpl.id);
            container.innerHTML = '<div style="padding:var(--space-4);color:var(--color-text-muted);">Series stopped. This task will no longer recur.</div>';
          } catch (e) {
            console.error('[panel] stopSeries:', e);
            stopBtn.disabled = false;
            stopBtn.textContent = '⏹ Stop recurring series';
          }
        });
        hdr.appendChild(stopBtn);
      }
      frag.appendChild(hdr);
    }

    // ── Occurrences list ───────────────────────────────────
    const listHdr = document.createElement('div');
    listHdr.style.cssText = 'font-size:var(--text-xs);font-weight:var(--weight-semibold);color:var(--color-text-muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:var(--space-2);';
    listHdr.textContent = `Occurrences (${insts.length})`;
    frag.appendChild(listHdr);

    if (insts.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'font-size:var(--text-sm);color:var(--color-text-muted);padding:var(--space-3) 0;';
      empty.textContent = 'No occurrences yet.';
      frag.appendChild(empty);
    }

    // ── Helper: build one occurrence row (reused in both main list and show-more) ──
    const STATUS_ICONS = { Completed: '✅', Skipped: '⏭', 'In Progress': '🔄', 'Not Started': '⭕' };

    const _buildOccRow = (inst) => {
      const icon   = STATUS_ICONS[inst.status] || '⭕';
      const isThis = inst.id === _entity.id;

      const row = document.createElement('div');
      row.style.cssText = [
        'display:flex;align-items:center;gap:var(--space-2)',
        'padding:var(--space-2) var(--space-1)',
        'border-bottom:1px solid var(--color-border)',
        'font-size:var(--text-sm)',
        isThis ? 'background:var(--color-accent-muted,#ede9fe);border-radius:var(--radius-sm);' : '',
      ].join(';');

      const dateStr10 = inst.periodStart?.slice(0, 10) || '';
      let dateDisplay = dateStr10 || '—';
      if (dateStr10) {
        try {
          const parts = dateStr10.split('-');
          const d = new Date(parseInt(parts[0],10), parseInt(parts[1],10)-1, parseInt(parts[2],10));
          dateDisplay = d.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });
        } catch (_) { dateDisplay = dateStr10; }
      }

      row.innerHTML = `
        <span style="min-width:1.2em;text-align:center;">${icon}</span>
        <span style="flex:1;${inst.status === 'Completed' ? 'text-decoration:line-through;color:var(--color-text-muted);' : ''}">
          ${_esc(dateDisplay)}
        </span>
        <span style="font-size:var(--text-xs);color:var(--color-text-muted);">#${inst.occurrenceIndex || '?'}</span>
      `;

      // Click: navigate to that instance's panel (if not already open)
      if (!isThis) {
        row.style.cursor = 'pointer';
        row.addEventListener('click', () => {
          emit(EVENTS.PANEL_OPENED, { entityType: 'taskInstance', entityId: inst.id });
        });
      }

      // Action buttons for Not Started instances (not the currently-open one)
      if (inst.status === 'Not Started' && !isThis) {
        const doneBtn = document.createElement('button');
        doneBtn.className = 'btn btn-ghost btn-xs';
        doneBtn.style.cssText = 'font-size:0.6rem;padding:2px 6px;color:var(--color-success,#22c55e);';
        doneBtn.textContent = '✓';
        doneBtn.title = 'Complete this occurrence';
        doneBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          doneBtn.disabled = true;
          try {
            const { completeInstance } = await import('../services/recurrence.js');
            await completeInstance(inst.id);
            row.querySelector('span:first-child').textContent = '✅';
            window._fhEnv?.services?.effects?.play('confetti');
          } catch (err) { console.error('[panel] completeInstance:', err); doneBtn.disabled = false; }
        });
        row.appendChild(doneBtn);

        const skipBtn = document.createElement('button');
        skipBtn.className = 'btn btn-ghost btn-xs';
        skipBtn.style.cssText = 'font-size:0.6rem;padding:2px 6px;color:var(--color-text-muted);';
        skipBtn.textContent = 'Skip';
        skipBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            const { skipInstance } = await import('../services/recurrence.js');
            await skipInstance(inst.id);
            row.querySelector('span:first-child').textContent = '⏭';
          } catch (err) { console.error('[panel] skipInstance:', err); }
        });
        row.appendChild(skipBtn);
      }

      // Edit button on every row
      const editOccBtn = document.createElement('button');
      editOccBtn.className = 'btn btn-ghost btn-xs';
      editOccBtn.style.cssText = 'font-size:0.65rem;padding:2px 5px;color:var(--color-text-muted);';
      editOccBtn.textContent = '✏️';
      editOccBtn.title = 'Edit this occurrence';
      editOccBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const freshInst = await getEntity(inst.id).catch(() => inst);
        openEditForm(freshInst);
      });
      row.appendChild(editOccBtn);

      return row;
    };

    const PAGE_SIZE = 30;
    for (const inst of insts.slice(0, PAGE_SIZE)) {
      frag.appendChild(_buildOccRow(inst));
    }

    // [N42 fix] Show-more link when list is truncated
    if (insts.length > PAGE_SIZE) {
      const moreBtn = document.createElement('button');
      moreBtn.className = 'btn btn-ghost btn-sm';
      moreBtn.style.cssText = 'width:100%;margin-top:var(--space-2);font-size:var(--text-xs);color:var(--color-text-muted);';
      moreBtn.textContent = `↓ Show all ${insts.length} occurrences`;
      moreBtn.addEventListener('click', () => {
        moreBtn.remove();
        for (const inst of insts.slice(PAGE_SIZE)) {
          container.appendChild(_buildOccRow(inst));
        }
      });
      frag.appendChild(moreBtn);
    }

    container.innerHTML = '';
    container.appendChild(frag);
  } catch (err) {
    console.error('[panel] _renderSeriesTab failed:', err);
    container.innerHTML = `<div style="color:var(--color-danger);padding:var(--space-3);">Failed to load series data.</div>`;
  }
}


/**
 * Mount activity stream below the properties tab content (P-28).
 */
function _mountActivityStream() {
  // [v5.3.1] taskInstance has no activity stream — skip to prevent crash
  if (_entity?.type === 'taskInstance') return;
  // Cleanup previous stream
  if (_activityCleanup) { _activityCleanup(); _activityCleanup = null; }
  if (!_entity) return;

  // Find or create the activity container below the panel body
  let actContainer = _panelBody?.querySelector('.activity-stream-container');
  if (!actContainer) {
    actContainer = document.createElement('div');
    actContainer.className = 'activity-stream-container';
    _panelBody?.appendChild(actContainer);
  }
  _activityCleanup = mountActivityStream(actContainer, _entity.id, _entity.type);
}


// ── onChange cascading (P-27) ────────────────────────────── //

/**
 * Apply onChanges cascade when a field value changes.
 * Merges the returned patch into _entity and highlights auto-computed fields.
 * @param {string} changedField
 * @param {*} newValue
 */
async function _applyOnChanges(changedField, newValue) {
  const onChanges = _config?.onChanges;
  if (!onChanges || !onChanges[changedField]) return;

  const patch = onChanges[changedField]({ ..._entity }, newValue);
  if (!patch || typeof patch !== 'object') return;

  // Merge patch into entity
  Object.assign(_entity, patch);

  // BUG-2 fix: don't re-render entire tab (causes focus loss and stream wipe).
  // Only flash the cascaded field elements to show they were auto-computed.

  // Highlight auto-computed fields with yellow flash (150ms per spec)
  for (const key of Object.keys(patch)) {
    const fieldEl = _panelBody?.querySelector(`[data-field-key="${key}"]`);
    if (fieldEl) {
      fieldEl.style.transition = 'background 0s';
      fieldEl.style.background = 'rgba(251,191,36,0.35)';
      setTimeout(() => {
        fieldEl.style.transition = 'background 0.4s ease';
        fieldEl.style.background = '';
      }, 150);
    }
  }
}

// ── Dirty state (P-26) ──────────────────────────────────── //

/**
 * Mark the panel as dirty (unsaved changes).
 * Called by every inline-edit that mutates _entity.
 */
function _markDirty() {
  if (!_dirty) {
    _dirty = true;
    _updateDirtyIndicator();
  }
}

function _updateDirtyIndicator() {
  if (!_dirtyEl) return;
  _dirtyEl.style.display = _dirty ? '' : 'none';
}

// ════════════════════════════════════════════════════════════
// SAVE
// ════════════════════════════════════════════════════════════

async function _save() {
  if (!_entity || _saving) return;
  _saving = true;

  // Show saving indicator
  if (_savingIndicator) _savingIndicator.classList.remove('hidden');

  try {
    // GUARD: If the entity has a field named 'type' that overwrote the structural
    // entity type (e.g. appointment subtype "Medical" replaced "appointment"),
    // restore the correct structural type from _config.
    if (_config && _entity.type !== _config.key) {
      _entity._subtype = _entity.type;
      _entity.type = _config.key;
    }
    _entity = await saveEntity(_entity, getAccount()?.id);
    _dirty    = false;
    _snapshot = JSON.stringify(_entity);  // update snapshot after save
    _updateDirtyIndicator();
  } catch (err) {
    console.error('[entity-panel] Save failed:', err);
  } finally {
    _saving = false;
    if (_savingIndicator) _savingIndicator.classList.add('hidden');
    // If another change came in while we were saving, schedule a retry save
    if (_dirty && _entity) {
      setTimeout(() => { if (_dirty && _entity) _save(); }, 100);
    }
  }
}

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════

/**
 * Navigate to the native view for an entity type, then open the entity panel.
 * e.g. task → kanban, note → notes, event → calendar, idea → entity-type/idea
 */
function _navigateToEntityView(entity, config) {
  if (!entity || !config) return;

  // Close graph view if active
  if (_graphViewActive) _closeGraphView();

  const viewPath = TYPE_VIEW_MAP[entity.type];
  if (!viewPath) return;

  // dailyReview: navigate to that specific date, not just the daily view home
  // [minor] Fix: also parse date from title if .date field is missing
  if (entity.type === 'dailyReview') {
    let dateStr = entity.date || null;
    if (!dateStr && entity.title) {
      const m = entity.title.match(/(\d{2})-(\d{2})-(\d{4})$/);
      if (m) dateStr = `${m[3]}-${m[1]}-${m[2]}`;
    }
    if (dateStr) {
      navigate('daily', { date: dateStr },
        `Daily Review — ${_formatDateForTitle(dateStr)}`);
      return;
    }
  }

  if (viewPath.startsWith('entity-type/')) {
    const typeKey = viewPath.split('/')[1];
    navigate(VIEW_KEYS.ENTITY_TYPE, { entityType: typeKey }, config.labelPlural || config.label);
  } else {
    navigate(viewPath);
  }

  // Re-open panel after a tick so the view renders first
  // Use _skipFormFirst so panel renders (not form) as user was just browsing graph
  setTimeout(() => {
    openPanel._skipFormFirst = true;
    openPanel(entity.id).finally(() => { openPanel._skipFormFirst = false; });
  }, 100);
}

/** Get the title field key for a given entity type */
function _getTitleKey(type) {
  const cfg = getEntityTypeConfig(type);
  if (!cfg) return 'title';
  const tf = cfg.fields.find(f => f.isTitle);
  return tf ? tf.key : 'title';
}

/**
 * Get a human-readable display title for any entity.
 * For types with an isTitle field (task, person, etc.) → use that field.
 * For types without one (post) → derive from body/first text field, truncated.
 * @param {object} entity
 * @param {string} [type] — entity.type override
 * @returns {string}
 */
function _getDisplayTitle(entity, type) {
  if (!entity) return 'Untitled';
  const t   = type || entity.type;
  const cfg = getEntityTypeConfig(t);
  if (!cfg) return entity.title || entity.name || 'Untitled';

  // 1. Try isTitle field
  const tf = cfg.fields.find(f => f.isTitle);
  if (tf) {
    const val = entity[tf.key];
    return val ? String(val) : 'Untitled';
  }

  // 2. No isTitle field — derive from body / first text/richtext field
  const bodyField = cfg.fields.find(f =>
    f.type === 'richtext' || f.type === 'text'
  );
  if (bodyField) {
    const raw = entity[bodyField.key];
    if (raw) {
      // Strip HTML tags, collapse whitespace, truncate
      const plain = String(raw).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      if (plain.length > 40) return plain.slice(0, 40) + '…';
      if (plain) return plain;
    }
  }

  // 3. Last resort fallbacks
  return entity.title || entity.name || entity.label || 'Untitled';
}

/** Format ISO date string for display in date fields (date-only, no time) */
function _formatDate(iso) {
  if (!iso) return '';
  try {
    // Date-only strings (YYYY-MM-DD) must be parsed as LOCAL midnight.
    // new Date('2026-04-20') treats the string as UTC midnight, which
    // shifts the displayed date by -1 day in timezones west of UTC.
    // Appending T00:00:00 (no Z) forces local-time interpretation.
    const normalized = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso + 'T00:00:00' : iso;
    const d = new Date(normalized);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

/**
 * Format a full ISO timestamp for Created/Updated footers.
 * Shows date + time + timezone offset so the user knows exactly when.
 * e.g. "Apr 21, 2026, 2:34 PM (UTC+8)"
 */
function _formatTimestamp(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    // Date + time in user's locale
    const base = d.toLocaleString(undefined, {
      year:   'numeric',
      month:  'short',
      day:    'numeric',
      hour:   'numeric',
      minute: '2-digit',
      hour12: true,
    });
    // Timezone offset string e.g. "UTC+8" or "UTC-5"
    const offsetMin = -d.getTimezoneOffset();
    const sign      = offsetMin >= 0 ? '+' : '-';
    const absH      = Math.floor(Math.abs(offsetMin) / 60);
    const absM      = Math.abs(offsetMin) % 60;
    const tzLabel   = absM === 0
      ? `UTC${sign}${absH}`
      : `UTC${sign}${absH}:${String(absM).padStart(2, '0')}`;
    return `${base} (${tzLabel})`;
  } catch {
    return iso;
  }
}

/** Short date format for activity log */
function _formatDateShort(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / 60000);

    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h ago`;
    if (diffMin < 10080) return `${Math.floor(diffMin / 1440)}d ago`;

    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

/** Truncate string to max length */
function _truncate(str, max) {
  if (!str || str.length <= max) return str;
  return str.slice(0, max) + '…';
}

/** Capitalize first letter */
function _capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ════════════════════════════════════════════════════════════
// [v6.1.8] SHARED PROJECT DELETE WITH TASK LIST PREVIEW
// Called from both entity-panel._confirmDelete and
// entity-form delete toolbar button (for project entities).
// ════════════════════════════════════════════════════════════

/**
 * Full project delete flow:
 *  Step 1 → 3-option dialog: delete tasks / keep tasks / cancel
 *  Step 2 (if delete-tasks) → task list preview with checkboxes + final confirm
 *  Step 3 → execute chosen action and call onComplete()
 *
 * @param {string}   projectId    - ID of the project to delete
 * @param {string}   projectTitle - Display name for the project
 * @param {object}   snapshot     - Entity snapshot for undo
 * @param {string}   entityLabel  - e.g. "Project"
 * @param {Function} onComplete   - Called after successful delete (e.g. closePanel / closeForm)
 */
export async function _deleteProjectWithTaskFlow(projectId, projectTitle, snapshot, entityLabel, onComplete) {
  // ── STEP 1: 3-option dialog ──────────────────────────────
  const choice = await new Promise(resolve => {
    const modal = document.createElement('div');
    modal.style.cssText = [
      'position:fixed;inset:0;z-index:var(--z-modal,700);',
      'background:rgba(15,23,42,0.5);',
      'display:flex;align-items:center;justify-content:center;padding:20px;',
    ].join('');
    const title = _esc(projectTitle);
    modal.innerHTML = `
      <div style="background:var(--color-bg);border-radius:var(--radius-lg);
        max-width:440px;width:100%;padding:26px;box-shadow:var(--shadow-2xl);
        font-family:var(--font-body);">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
          <span style="font-size:1.4rem;">🗑️</span>
          <span style="font-size:var(--text-lg);font-weight:var(--weight-bold);">Delete Project</span>
        </div>
        <div style="font-size:var(--text-sm);color:var(--color-text-muted);margin-bottom:20px;line-height:1.6;">
          What should happen to tasks linked to <strong>${title}</strong>?
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          <button id="pdel-delete-tasks" style="
            padding:11px 14px;border-radius:var(--radius-md);cursor:pointer;
            border:1.5px solid var(--color-danger);
            background:var(--color-danger-bg,#fef2f2);
            color:var(--color-danger);
            font-size:var(--text-sm);font-weight:600;text-align:left;
            display:flex;align-items:center;gap:10px;transition:background 0.12s;">
            <span>🗑️</span>
            <div>
              <div>Delete project <em>and</em> all its tasks</div>
              <div style="font-weight:400;font-size:var(--text-xs);opacity:0.75;margin-top:2px;">
                You'll see a task list and confirm before anything is deleted
              </div>
            </div>
          </button>
          <button id="pdel-keep-tasks" style="
            padding:11px 14px;border-radius:var(--radius-md);cursor:pointer;
            border:1.5px solid var(--color-border);background:var(--color-surface);
            color:var(--color-text);font-size:var(--text-sm);font-weight:600;text-align:left;
            display:flex;align-items:center;gap:10px;transition:background 0.12s;">
            <span>📋</span>
            <div>
              <div>Delete project only — keep tasks</div>
              <div style="font-weight:400;font-size:var(--text-xs);color:var(--color-text-muted);margin-top:2px;">
                Tasks become unlinked (no project)
              </div>
            </div>
          </button>
          <button id="pdel-cancel" style="
            padding:8px 14px;border-radius:var(--radius-md);
            border:1px solid var(--color-border);background:none;
            color:var(--color-text-muted);cursor:pointer;font-size:var(--text-sm);">
            Cancel
          </button>
        </div>
      </div>
    `;
    modal.querySelector('#pdel-delete-tasks').addEventListener('click', () => { modal.remove(); resolve('delete-tasks'); });
    modal.querySelector('#pdel-keep-tasks').addEventListener('click',   () => { modal.remove(); resolve('keep-tasks'); });
    modal.querySelector('#pdel-cancel').addEventListener('click',       () => { modal.remove(); resolve('cancel'); });
    modal.addEventListener('click', e => { if (e.target === modal) { modal.remove(); resolve('cancel'); } });
    document.body.appendChild(modal);
  });

  if (choice === 'cancel') return;

  // ── STEP 2 (delete-tasks only): load tasks + show preview list ──
  let tasksToDelete = [];
  if (choice === 'delete-tasks') {
    // Gather task IDs from both edges and direct field
    const [edgesProject, edgesPartOf, allTasks] = await Promise.all([
      getEdgesTo(projectId, 'project').catch(() => []),
      getEdgesTo(projectId, 'part of').catch(() => []),
      getEntitiesByType('task').catch(() => []),
    ]);
    const taskIds = new Set([...edgesProject, ...edgesPartOf].map(e => e.fromId));
    allTasks.filter(t => !t.deleted && t.project === projectId).forEach(t => taskIds.add(t.id));
    tasksToDelete = allTasks.filter(t => !t.deleted && taskIds.has(t.id));

    // Sort: done last, then by status, then title
    const STATUS_ORDER = { 'In Progress':0,'Not Started':1,'Next Up':1,'Blocked':2,'Done':9,'Completed':9 };
    tasksToDelete.sort((a,b) => {
      const sa = STATUS_ORDER[a.status] ?? 5;
      const sb = STATUS_ORDER[b.status] ?? 5;
      if (sa !== sb) return sa - sb;
      return (a.title||'').localeCompare(b.title||'');
    });

    // ── STEP 2 modal: task list with checkboxes ──────────────
    const confirmed = await new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.style.cssText = [
        'position:fixed;inset:0;z-index:calc(var(--z-modal,700) + 1);',
        'background:rgba(15,23,42,0.55);',
        'display:flex;align-items:center;justify-content:center;padding:20px;',
      ].join('');

      const STATUS_C = {
        'Done':'#10b981','Completed':'#10b981','In Progress':'#3b82f6',
        'Not Started':'#94a3b8','Next Up':'#60a5fa','Blocked':'#ef4444',
      };
      const PRIO_C = { Critical:'#dc2626',High:'#f97316',Medium:'#f59e0b',Low:'#6b7280' };

      overlay.innerHTML = `
        <div style="background:var(--color-bg);border-radius:var(--radius-lg);
          width:100%;max-width:560px;max-height:85vh;
          display:flex;flex-direction:column;box-shadow:var(--shadow-2xl);
          font-family:var(--font-body);overflow:hidden;">

          <!-- Header -->
          <div style="padding:18px 22px 14px;border-bottom:1px solid var(--color-border);flex-shrink:0;">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
              <span style="font-size:1.3rem;">⚠️</span>
              <span style="font-size:var(--text-lg);font-weight:var(--weight-bold);color:var(--color-danger);">
                Confirm Task Deletion
              </span>
            </div>
            <div style="font-size:var(--text-sm);color:var(--color-text-muted);line-height:1.5;">
              The following <strong>${tasksToDelete.length} task${tasksToDelete.length!==1?'s':''}</strong>
              linked to <strong>${_esc(projectTitle)}</strong> will be permanently deleted.
              Uncheck any tasks you want to keep.
            </div>
          </div>

          <!-- Task list -->
          <div style="flex:1;overflow-y:auto;padding:12px 22px;" id="pdel-task-list">
            ${tasksToDelete.length === 0
              ? `<div style="text-align:center;padding:24px;color:var(--color-text-muted);">
                   No tasks linked to this project.
                 </div>`
              : tasksToDelete.map((t,i) => {
                  const statusColor = STATUS_C[t.status] || '#94a3b8';
                  const prioColor   = PRIO_C[t.priority] || '#94a3b8';
                  const isDone      = t.status === 'Done' || t.status === 'Completed';
                  return `
                    <label style="
                      display:flex;align-items:flex-start;gap:10px;
                      padding:9px 10px;margin-bottom:5px;
                      border-radius:var(--radius-md);cursor:pointer;
                      background:var(--color-surface);border:1px solid var(--color-border);
                      transition:background 0.1s;
                    " onmouseover="this.style.background='var(--color-surface-2)'"
                       onmouseout="this.style.background='var(--color-surface)'">
                      <input type="checkbox" data-task-id="${_esc(t.id)}" checked
                        style="margin-top:2px;width:15px;height:15px;cursor:pointer;
                          accent-color:var(--color-danger);flex-shrink:0;">
                      <div style="flex:1;min-width:0;">
                        <div style="
                          font-size:var(--text-sm);font-weight:500;
                          color:var(--color-text);line-height:1.3;
                          text-decoration:${isDone?'line-through':'none'};
                          opacity:${isDone?0.6:1};
                          overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                          ${_esc(t.title||t.name||'Untitled task')}
                        </div>
                        <div style="display:flex;align-items:center;gap:8px;margin-top:3px;flex-wrap:wrap;">
                          <span style="font-size:10px;padding:1px 6px;border-radius:9px;
                            background:${statusColor}22;color:${statusColor};font-weight:600;">
                            ${_esc(t.status||'Not Started')}
                          </span>
                          ${t.priority?`<span style="font-size:10px;color:${prioColor};">${_esc(t.priority)}</span>`:''}
                          ${t.dueDate?`<span style="font-size:10px;color:var(--color-text-muted);">📅 ${_esc(t.dueDate)}</span>`:''}
                        </div>
                      </div>
                    </label>`;
                }).join('')
            }
          </div>

          <!-- Select all / none -->
          ${tasksToDelete.length > 0 ? `
          <div style="padding:8px 22px;border-top:1px solid var(--color-border);
            display:flex;align-items:center;gap:12px;flex-shrink:0;
            background:var(--color-surface);">
            <button id="pdel-select-all" style="font-size:var(--text-xs);padding:3px 10px;
              border-radius:var(--radius-sm);border:1px solid var(--color-border);
              background:none;cursor:pointer;color:var(--color-text-muted);">
              Select all
            </button>
            <button id="pdel-select-none" style="font-size:var(--text-xs);padding:3px 10px;
              border-radius:var(--radius-sm);border:1px solid var(--color-border);
              background:none;cursor:pointer;color:var(--color-text-muted);">
              Select none
            </button>
            <span id="pdel-sel-count" style="font-size:var(--text-xs);color:var(--color-text-muted);margin-left:auto;">
              ${tasksToDelete.length} selected
            </span>
          </div>` : ''}

          <!-- Footer -->
          <div style="padding:14px 22px;border-top:1px solid var(--color-border);
            display:flex;gap:10px;justify-content:flex-end;flex-shrink:0;">
            <button id="pdel-back" style="padding:7px 16px;border-radius:var(--radius-md);
              border:1px solid var(--color-border);background:var(--color-surface);
              color:var(--color-text);cursor:pointer;font-size:var(--text-sm);">
              ← Back
            </button>
            <button id="pdel-confirm" style="padding:7px 18px;border-radius:var(--radius-md);
              border:none;background:var(--color-danger);color:#fff;
              cursor:pointer;font-size:var(--text-sm);font-weight:600;">
              🗑️ Delete ${tasksToDelete.length} task${tasksToDelete.length!==1?'s':''} + project
            </button>
          </div>
        </div>
      `;

      document.body.appendChild(overlay);

      // Wire select-all / select-none
      const getCheckboxes = () => [...overlay.querySelectorAll('input[type="checkbox"][data-task-id]')];
      const updateCount = () => {
        const count = getCheckboxes().filter(cb => cb.checked).length;
        const selCount = overlay.querySelector('#pdel-sel-count');
        if (selCount) selCount.textContent = `${count} selected`;
        const confirmBtn = overlay.querySelector('#pdel-confirm');
        if (confirmBtn) {
          confirmBtn.textContent = `🗑️ Delete ${count} task${count!==1?'s':''} + project`;
          confirmBtn.style.opacity = count === 0 ? '0.6' : '1';
        }
      };

      overlay.querySelector('#pdel-select-all')?.addEventListener('click', () => {
        getCheckboxes().forEach(cb => cb.checked = true); updateCount();
      });
      overlay.querySelector('#pdel-select-none')?.addEventListener('click', () => {
        getCheckboxes().forEach(cb => cb.checked = false); updateCount();
      });
      getCheckboxes().forEach(cb => cb.addEventListener('change', updateCount));

      overlay.querySelector('#pdel-back').addEventListener('click', () => { overlay.remove(); resolve(null); });
      overlay.querySelector('#pdel-confirm').addEventListener('click', () => {
        // Return the IDs that are still checked
        const selected = getCheckboxes().filter(cb => cb.checked).map(cb => cb.dataset.taskId);
        overlay.remove();
        resolve(selected);
      });
      overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); resolve(null); } });
    });

    // null = user hit Back or dismissed → restart? No — just cancel the whole operation
    if (confirmed === null) return;

    // ── STEP 3: Execute deletion ─────────────────────────────
    try {
      // Delete only the checked task IDs
      if (confirmed.length > 0) {
        await Promise.allSettled(confirmed.map(tid => deleteEntity(tid)));
      }
      // Unlink any unchecked tasks (keep but remove project association)
      const uncheckedIds = new Set(tasksToDelete.map(t => t.id).filter(id => !confirmed.includes(id)));
      if (uncheckedIds.size > 0) {
        await Promise.allSettled(
          [...uncheckedIds].map(tid => {
            const t = tasksToDelete.find(x => x.id === tid);
            if (!t) return Promise.resolve();
            return saveEntity({ ...t, project: null }, getAccount()?.id).catch(() => {});
          })
        );
      }
      await deleteEntity(projectId);
      showToast(
        confirmed.length > 0
          ? `Project deleted with ${confirmed.length} task${confirmed.length!==1?'s':''}`
          : 'Project deleted — tasks unlinked',
        'success'
      );
      if (typeof onComplete === 'function') onComplete();
      window.FH?._pushUndoDelete?.({ snapshot, entityLabel, entityTitle: projectTitle });
    } catch (err) {
      console.error('[entity-panel] Project + tasks delete failed:', err);
      showToast('Delete failed — please try again', 'error');
    }
    return;
  }

  // ── STEP 3 (keep-tasks path): just unlink then delete project ──
  try {
    const allTasksKeep = await getEntitiesByType('task').catch(() => []);
    const linked = allTasksKeep.filter(t => !t.deleted && t.project === projectId);
    await Promise.allSettled(linked.map(t => saveEntity({ ...t, project: null }, getAccount()?.id)));
    await deleteEntity(projectId);
    showToast('Project deleted — tasks unlinked', 'success');
    if (typeof onComplete === 'function') onComplete();
    window.FH?._pushUndoDelete?.({ snapshot, entityLabel, entityTitle: projectTitle });
  } catch (err) {
    console.error('[entity-panel] Project delete (keep-tasks) failed:', err);
    showToast('Delete failed — please try again', 'error');
  }
}
