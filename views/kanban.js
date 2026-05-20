/**
 * FamilyHub v4.8.6 — views/kanban.js
 * 4-column Kanban board: Not Started · Next Up · In Progress · Completed
 * Renders into #view-kanban when view="kanban"
 *
 * Features:
 *   - Task cards: checkbox, title, project chip, assignee avatars, priority dot,
 *     due date, tag chips, blocker indicator
 *   - Filter bar: project, assignee, tag, priority, overdue-only
 *   - Sort per column: Deadline First / Priority / Date Created
 *   - Quick-add per column (inline title → Enter)
 *   - Mouse + touch drag-and-drop between columns
 *   - Click card → opens entity panel
 *
 * Registration: registerView('kanban', renderKanban)
 */

import { registerView }                         from '../core/router.js';
import { getEntitiesByType, getEdgesFrom, getEdgesTo,
         getEntity, saveEntity, getSetting, setSetting }                 from '../core/db.js';
import { emit, on, EVENTS }                      from '../core/events.js';
// openEditForm no longer called directly — all clicks route through PANEL_OPENED (form-first)
import { getAccount }                            from '../core/auth.js';
import { filterByContext, getActiveContext }      from '../core/context.js';
// [fix] time-tracker loaded dynamically — kanban works even before file is deployed
let getSession    = () => null;
let stopSession   = async () => {};
let getElapsed    = () => 0;
let getRemaining  = () => null;
let activeTaskIds  = { value: new Set() };
let alarmedTaskIds = { value: new Set() };
let formatDurationCompact = (s) => { const m=Math.floor((s||0)/60),sc=Math.floor((s||0)%60); return String(m).padStart(2,'0')+':'+String(sc).padStart(2,'0'); };
let TIMER_TICK  = 'timer:tick';
let TIMER_ALARM = 'timer:alarm';
let _ttKanbanLoaded = false;
async function _ensureTimeTracker() {
  if (_ttKanbanLoaded) return;
  _ttKanbanLoaded = true;
  try {
    const tt = await import('../services/time-tracker.js');
    getSession    = tt.getSession;
    stopSession   = tt.stopSession;
    getElapsed    = tt.getElapsed;
    getRemaining  = tt.getRemaining;
    activeTaskIds  = tt.activeTaskIds;
    alarmedTaskIds = tt.alarmedTaskIds;
    formatDurationCompact = tt.formatDurationCompact;
    TIMER_TICK  = tt.TIMER_TICK;
    TIMER_ALARM = tt.TIMER_ALARM;
  } catch (e) { console.warn('[kanban] time-tracker not available:', e.message); }
}

// ── Timer listener registry (KB-9/10/11 fix) ─────────────── //
// Tracks per-card/row unsubscribe functions. Cleared before each board re-render
// to prevent O(n*renders) permanent listener accumulation.
const _timerUnsubs = [];
function _pushTimerUnsub(...fns) { _timerUnsubs.push(...fns); }
function _cleanupTimerListeners() {
  while (_timerUnsubs.length) { try { _timerUnsubs.pop()(); } catch {} }
}

// ── Constants ─────────────────────────────────────────────── //

const COLUMNS = [
  { key: 'Not Started', label: 'Not Started', color: 'var(--kanban-inbox)' },
  { key: 'Next Up',     label: 'Next Up',     color: 'var(--kanban-review)' },
  { key: 'In Progress', label: 'In Progress', color: 'var(--kanban-progress)' },
  { key: 'Completed',   label: 'Completed',   color: 'var(--kanban-done)' },
];

const PRIORITY_ORDER = { Critical: 0, High: 1, Medium: 2, Low: 3 };
// K-03: Map person.color select values → CSS colors for avatars
const PERSON_COLOR_MAP = {
  Red:    '#ef4444',
  Orange: '#f97316',
  Yellow: '#eab308',
  Green:  '#22c55e',
  Teal:   '#14b8a6',
  Blue:   '#3b82f6',
  Purple: '#a855f7',
  Pink:   '#ec4899',
};

const PRIORITY_COLORS = {
  Critical: 'var(--color-danger)',
  High:     'var(--color-warning)',
  Medium:   'var(--color-info)',
  Low:      'var(--color-text-muted)',
};

const SORT_OPTIONS = [
  { key: 'deadline',  label: 'Deadline First' },
  { key: 'priority',  label: 'Priority' },
  { key: 'created',   label: 'Date Created' },
];

// ── Module state ──────────────────────────────────────────── //

let _tasks      = [];
let _persons    = [];
let _projects   = [];
let _personMap  = new Map();
let _projectMap = new Map();
let _blockMap   = new Map(); // taskId → true if blocked by incomplete task
// Edge-resolved relation maps (populated in _loadData for tasks created via entity-form)
let _taskProjectMap  = new Map(); // taskId → projectId (from 'project' relation edge)
let _taskAssigneeMap = new Map(); // taskId → personId  (from 'assignedTo' relation edge)
// [v5.1.0] Reminder badge map: taskId → count of active reminders
let _taskReminderMap = new Map();
// [BUG-31 FIX] Dirty flag: only rebuild reminder map when a REMINDER_* event fires
let _reminderMapDirty = true;
// [v5.3.1] Recurring task instance state
let _instances    = [];         // taskInstance entities
let _instTemplMap = new Map();  // instanceId → template task entity

// [v5.3.1] Lazy rrule-lite loader — avoids hard import at module level
let _rruleHuman = null;
async function _getRruleHuman() {
  if (!_rruleHuman) {
    const m = await import('../services/rrule-lite.js');
    _rruleHuman = m.rruleToHuman;
  }
  return _rruleHuman;
}

// Filter state
let _filterProject        = null;   // project ID or null
let _filterAssignees      = new Set();
let _filterTags           = new Set();
let _filterPriority       = null;   // 'Critical' | 'High' | ... | null
let _filterOverdue        = false;
let _filterScheduledRange = null;   // null=all | 'overdue'|'today'|'tomorrow'|'this-week'|'next-week'|'later'

// ── Capacities-style view modes + filter tabs ─────────────── //
let _viewMode   = 'list'; // Spec: "default list with the view button on the right-hand side"

// Spec-defined canonical view per tab. Tabs with spec-defined groupings that are
// incompatible with kanban status columns force their canonical view.
// User can always override via the view-mode dropdown.
const _TAB_CANONICAL_VIEW = {
  inbox:      'list',    // spec: grouped by creation date
  today:      'kanban',  // [MAJOR] spec: default to kanban for Today tab
  scheduled:  'list',    // spec: grouped by execution date
  context:    'list',    // spec: grouped by context
  open:       'list',    // spec: ordered by priority and status (single group)
  completed:  'list',    // spec: ordered by completion date
  all:        'list',    // spec: all tasks, user filter/sort
};

// Track whether user has manually overridden the view for the current session
let _userOverrodeView = false;
let _filterTab  = 'inbox'; // [minor] Spec: inbox is the primary entry point

const _VIEW_MODES = [
  { key: 'list',    label: 'List',    icon: '\uD83D\uDCCB' },
  { key: 'kanban',  label: 'Kanban',  icon: '\uD83D\uDCCA' },
  { key: 'table',   label: 'Table',   icon: '\uD83D\uDDD3\uFE0F' },
];

const _FILTER_TABS = [
  { key: 'inbox',      label: 'Inbox',       icon: '\uD83D\uDCEC' },
  { key: 'today',      label: 'Today',        icon: '\u2600\uFE0F' },
  { key: 'scheduled',  label: 'Scheduled',    icon: '\uD83D\uDCC5' },
  { key: 'context',    label: 'Context',      icon: '\uD83C\uDFF7\uFE0F' },
  { key: 'open',       label: 'Open',         icon: '\u25CB' },
  { key: 'completed',  label: 'Completed',    icon: '\u2705' },
  { key: 'all',        label: 'All',          icon: '\uD83D\uDDC2\uFE0F' },
]; // [MAJOR] Removed Status tab — Kanban view with status columns makes it redundant

// User's default view preferences per filter tab (loaded from DB on render)
let _defaultViewPerTab = {
  inbox:      'list',
  today:      'kanban',
  scheduled:  'list',
  context:    'list',
  open:       'list',
  completed:  'list',
  all:        'list',
};

// Sort state per column key
let _sortBy = {};  // { 'Inbox': 'deadline', ... }

// Drag state
let _dragTaskId = null;
let _dragEl     = null;
let _dragGhost  = null;
let _dropTarget = null;

// ── View Preferences (DB persistence) ────────────────────── //

async function _loadViewPreferences() {
  try {
    const saved = await getSetting('taskViewPreferences');
    if (saved && typeof saved === 'object') {
      _defaultViewPerTab = { ..._defaultViewPerTab, ...saved };
    }
  } catch (err) {
    console.warn('[kanban] Failed to load view preferences:', err);
  }
}

async function _saveViewPreference(tabKey, viewMode) {
  try {
    _defaultViewPerTab[tabKey] = viewMode;
    await setSetting('taskViewPreferences', _defaultViewPerTab);
  } catch (err) {
    console.error('[kanban] Failed to save view preference:', err);
  }
}

// ── Data loading ──────────────────────────────────────────── //

async function _loadData() {
  const [tasks, instances, persons, projects] = await Promise.all([
    getEntitiesByType('task'),
    getEntitiesByType('taskInstance'),  // [v5.3.1]
    getEntitiesByType('person'),
    getEntitiesByType('project'),
  ]);

  _tasks     = filterByContext(tasks.filter(t => !t.deleted));
  _instances = filterByContext(instances.filter(i => !i.deleted)); // [v5.3.1]
  _persons   = persons;
  _projects  = filterByContext(projects.filter(p => !p.deleted));

  _personMap  = new Map(persons.map(p  => [p.id, p]));
  _projectMap = new Map(projects.map(pr => [pr.id, pr]));

  // [v5.3.1] Build instance→template lookup using templateId field (no edge query needed)
  _instTemplMap.clear();
  const _taskMapK = new Map(_tasks.map(t => [t.id, t]));
  for (const inst of _instances) {
    const tmpl = inst.templateId ? _taskMapK.get(inst.templateId) : null;
    if (tmpl) _instTemplMap.set(inst.id, tmpl);
  }

  // Build blocker map and edge-resolved relation maps
  await _buildBlockerMap();
  await _buildRelationEdgeMaps();
  // [v5.1.0] Build reminder badge map (active reminder count per task) — only if dirty
  if (_reminderMapDirty) {
    await _buildReminderMap();
    _reminderMapDirty = false;
  }
}

/**
 * Build edge-resolved project + assignee maps for tasks.
 * When tasks are created via entity-form, project/assignedTo are stored as
 * graph edges (not as direct fields). This resolves those edges so the kanban
 * card display and filters work correctly regardless of how the task was created.
 */
async function _buildRelationEdgeMaps() {
  _taskProjectMap.clear();
  _taskAssigneeMap.clear();

  // Parallel IDB reads — fire all edge lookups concurrently instead of sequentially
  const needProject  = _tasks.filter(t => !t.project);
  const needAssignee = _tasks.filter(t => !t.assignedTo);

  const [projResults, assignResults] = await Promise.all([
    Promise.all(needProject.map(t  => getEdgesFrom(t.id, 'project').catch(() => []))),
    Promise.all(needAssignee.map(t => getEdgesFrom(t.id, 'assignedTo').catch(() => []))),
  ]);

  needProject.forEach((t, i) => {
    if (projResults[i].length > 0) _taskProjectMap.set(t.id, projResults[i][0].toId);
  });
  needAssignee.forEach((t, i) => {
    if (assignResults[i].length > 0) _taskAssigneeMap.set(t.id, assignResults[i][0].toId);
  });
}

/**
 * [v5.1.0] Build taskId → active reminder count map.
 * Used to show 🔔 badge on kanban cards.
 * Only counts reminders with status 'active' or 'snoozed'.
 */
async function _buildReminderMap() {
  _taskReminderMap.clear();
  try {
    const reminders = await getEntitiesByType('reminder');
    const active    = reminders.filter(r => !r.deleted && (r.status === 'active' || r.status === 'snoozed') && !r.isTemplate);
    // Load reminder→task edges in parallel
    const edges = await Promise.all(active.map(r => getEdgesFrom(r.id, 'reminds').catch(() => [])));
    active.forEach((r, i) => {
      for (const edge of edges[i]) {
        const count = (_taskReminderMap.get(edge.toId) || 0) + 1;
        _taskReminderMap.set(edge.toId, count);
      }
    });
    // [v5.3.1] Propagate template reminder count to instances
    for (const inst of _instances) {
      const tmpl = _instTemplMap.get(inst.id);
      if (!tmpl) continue;
      const cnt = _taskReminderMap.get(tmpl.id) || 0;
      if (cnt > 0) _taskReminderMap.set(inst.id, cnt);
    }
  } catch (e) { console.warn('[kanban] _buildReminderMap failed:', e); }
}

async function _buildBlockerMap() {
  _blockMap.clear();
  const doneSet   = new Set(['Completed', 'Done', 'done']);
  const taskIndex = new Map(_tasks.map(t => [t.id, t]));

  // Parallel IDB reads — all blocker edge lookups fire concurrently
  const edgeResults = await Promise.all(
    _tasks.map(t => getEdgesFrom(t.id, 'blockedBy').catch(() => []))
  );

  _tasks.forEach((task, i) => {
    const edges = edgeResults[i];
    if (edges.length === 0) return;
    const isBlocked = edges.some(edge => {
      const blocker = taskIndex.get(edge.toId);
      return blocker && !doneSet.has(blocker.status);
    });
    if (isBlocked) _blockMap.set(task.id, true);
  });
}

// ── Filter / sort helpers ─────────────────────────────────── //

function _applyFilters(tasks) {
  // Cache scheduled boundaries once for the whole filter pass (avoid repeated new Date() calls)
  const _scheduledFilterBoundaries = (_filterScheduledRange && _filterTab === 'scheduled')
    ? _getScheduledBoundaries() : null;
  return tasks.filter(t => {
    if (_filterProject) {
      // [N03 fix] For instances, fall back to template's project
      const resolvedProj = t.project || _taskProjectMap.get(t.id)
        || (t._isInstance ? (t._template?.project || _taskProjectMap.get(t._template?.id)) : null);
      if (resolvedProj !== _filterProject) return false;
    }
    if (_filterAssignees.size > 0) {
      // [N04 fix] For instances, fall back to template's assignedTo
      const resolvedAssignee = t.assignedTo || _taskAssigneeMap.get(t.id)
        || (t._isInstance ? (t._template?.assignedTo || _taskAssigneeMap.get(t._template?.id)) : null);
      if (!_filterAssignees.has(resolvedAssignee)) return false;
    }
    if (_filterTags.size > 0) {
      const taskTags = new Set(t.tags || []);
      let hasMatch = false;
      for (const ft of _filterTags) {
        if (taskTags.has(ft)) { hasMatch = true; break; }
      }
      if (!hasMatch) return false;
    }
    if (_filterPriority && t.priority !== _filterPriority) return false;
    if (_filterOverdue) {
      const today = _todayStr();
      // Overdue means past the execution/scheduled date
      const overdueDate = _getExecDate(t);
      if (!overdueDate || overdueDate > today) return false;
    }
    // Scheduled tab time-context filter (boundaries cached outside loop by closure)
    if (_filterScheduledRange && _filterTab === 'scheduled') {
      const dateStr = _getExecDate(t);
      if (!dateStr) return false;
      const bucket = _classifyScheduledDate(dateStr, _scheduledFilterBoundaries);
      if (bucket !== _filterScheduledRange) return false;
    }
    return true;
  });
}

function _sortTasks(tasks, colKey) {
  const sortKey = _sortBy[colKey] || 'deadline';
  return [...tasks].sort((a, b) => {
    switch (sortKey) {
      case 'deadline': {
        // Spec: tasks WITH deadlines rank above tasks WITHOUT; earlier deadlines first
        // Used as tie-breaker after priority + scheduled date
        const ap = PRIORITY_ORDER[a.priority] ?? 99;
        const bp = PRIORITY_ORDER[b.priority] ?? 99;
        if (ap !== bp) return ap - bp;
        const aDue = _isoToLocalDate(a.dueDate) || '9999-99-99';
        const bDue = _isoToLocalDate(b.dueDate) || '9999-99-99';
        if (aDue !== bDue) return aDue.localeCompare(bDue);
        return _deadlineSort(a, b);
      }
      case 'priority': {
        const ap = PRIORITY_ORDER[a.priority] ?? 99;
        const bp = PRIORITY_ORDER[b.priority] ?? 99;
        if (ap !== bp) return ap - bp;
        return _deadlineSort(a, b);
      }
      case 'created':
        return (b.createdAt || '').localeCompare(a.createdAt || '');
      default:
        return 0;
    }
  });
}

function _todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

/** [minor] BUG-49/50 fix: parse any ISO date/datetime to local YYYY-MM-DD safely */
function _isoToLocalDate(isoStr) {
  if (!isoStr) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(isoStr)) return isoStr.slice(0, 10);
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function _collectAllTags() {
  const tags = new Set();
  // Collect from regular tasks AND recurring templates (instances inherit template tags)
  for (const t of _tasks) {
    if (Array.isArray(t.tags)) t.tags.forEach(tg => tags.add(tg));
  }
  // [P08 fix] Also collect from instance templates via _instTemplMap
  for (const tmpl of _instTemplMap.values()) {
    if (Array.isArray(tmpl.tags)) tmpl.tags.forEach(tg => tags.add(tg));
  }
  return [...tags].sort();
}

function _collectAssignees() {
  const ids = new Set();
  for (const t of _tasks) {
    // Collect from direct field AND edge-resolved map so filter chips are complete
    if (t.assignedTo) ids.add(t.assignedTo);
    const edgeAssignee = _taskAssigneeMap.get(t.id);
    if (edgeAssignee) ids.add(edgeAssignee);
  }
  // [P09 fix] Also collect assignees from instance templates
  for (const tmpl of _instTemplMap.values()) {
    if (tmpl.assignedTo) ids.add(tmpl.assignedTo);
    const edgeTmplAssignee = _taskAssigneeMap.get(tmpl.id);
    if (edgeTmplAssignee) ids.add(edgeTmplAssignee);
  }
  return [...ids].map(id => _personMap.get(id)).filter(Boolean);
}

// ── Filter tab logic ──────────────────────────────────────── //

/**
 * Spec-compliant filter tab logic (per design doc):
 *
 * Inbox     — tasks without a scheduled date OR without a status.
 *             Grouped by creation date (day bucket). Clear by assigning date/deadline/status.
 * Today     — tasks scheduled for today + tasks with overdue or due-today deadlines.
 *             Grouped by status, ordered by priority.
 * Scheduled — tasks that have a scheduled/due date assigned.
 *             Grouped by date property. Overdue tasks shown first for rescheduling.
 * Status    — all tasks grouped by status (original kanban grouping).
 * Context   — all tasks grouped by context tag, ordered by priority then status.
 * Open      — all undone tasks, ordered by priority then status.
 * Completed — tasks where status === 'Completed', ordered by completedAt descending.
 * All       — all tasks; user filter/sort choices apply.
 *
 * Deadline ranking (global tie-breaker):
 *   Tasks WITH deadlines rank above tasks WITHOUT.
 *   Among deadline tasks: earlier deadline first.
 *   Applied after priority and scheduled date.
 */

/** Get the effective execution date for a task — executionDate if set, else dueDate */
function _getExecDate(task) {
  return _isoToLocalDate(task.executionDate) || _isoToLocalDate(task.dueDate);
}

/** Returns the set of tasks that belong to the active filter tab */
function _applyFilterTab(tasks) {
  const today = _todayStr();
  switch (_filterTab) {
    case 'inbox':
      // Spec: "All tasks without a scheduled date (no due date set)."
      // A task appears in inbox ONLY if it is missing both executionDate and dueDate.
      return tasks.filter(t => {
        const hasDate = !!_getExecDate(t);
        return !hasDate; // [MAJOR] Show ONLY tasks without execution/due dates
      });

    case 'today': {
      // Tasks scheduled for today (by execution date) + overdue execution dates.
      return tasks.filter(t => {
        if (t.status === 'Completed' || t.status === 'Done' || t.status === 'done') return false;
        const exec = _getExecDate(t);
        if (!exec) return false;
        return exec <= today; // today's tasks + all overdue execution dates
      });
    }

    case 'scheduled':
      // All tasks with an execution date, excluding Done
      return tasks.filter(t => !!_getExecDate(t) && t.status !== 'Completed' && t.status !== 'Done' && t.status !== 'done');


    case 'open':
      // All undone tasks
      return tasks.filter(t => t.status !== 'Completed' && t.status !== 'Done' && t.status !== 'done');

    case 'completed':
      // Tasks marked Done or Skipped, most recently actioned first
      // [P18 fix] Include Skipped instances alongside Completed ones
      return tasks
        .filter(t => t.status === 'Completed' || t.status === 'Done' || t.status === 'done' || t.status === 'Skipped')
        .sort((a, b) => (b.completedAt || b.updatedAt || '').localeCompare(a.completedAt || a.updatedAt || ''));

    case 'status':
    case 'context':
    case 'all':
    default:
      return tasks;
  }
}

/** Deadline-aware sort comparator (global tie-breaker per spec).
 *  On task entity, dueDate IS the deadline — used as tie-breaker after priority + scheduled date.
 *  Tasks WITH a dueDate rank above tasks WITHOUT. Earlier dates come first.
 */
function _deadlineSort(a, b) {
  const aDl = _isoToLocalDate(a.dueDate); // dueDate serves as the task deadline
  const bDl = _isoToLocalDate(b.dueDate);
  // Tasks WITH deadline rank above tasks WITHOUT
  if (aDl && !bDl) return -1;
  if (!aDl && bDl) return 1;
  if (aDl && bDl) return aDl.localeCompare(bDl);
  return 0;
}

/** Priority + status + deadline composite sort (used by Today, Open, Context tabs).
 *  Order: priority → status (In Progress first) → dueDate → title (stable)
 */
const STATUS_SORT_ORDER = { 'In Progress': 0, 'Next Up': 1, 'Not Started': 2, 'Inbox': 2, 'Completed': 3, 'Done': 3, 'Review': 1 }; // C10: legacy status backward compat
function _priorityStatusDeadlineSort(a, b) {
  // 1. Priority
  const ap = PRIORITY_ORDER[a.priority] ?? 99;
  const bp = PRIORITY_ORDER[b.priority] ?? 99;
  if (ap !== bp) return ap - bp;
  // 2. Status order (spec: "priority and status")
  const as_ = STATUS_SORT_ORDER[a.status] ?? 2;
  const bs_ = STATUS_SORT_ORDER[b.status] ?? 2;
  if (as_ !== bs_) return as_ - bs_;
  // 3. Execution date (earlier first — falls back to dueDate)
  const aDate = _getExecDate(a) || '9999-99-99';
  const bDate = _getExecDate(b) || '9999-99-99';
  if (aDate !== bDate) return aDate.localeCompare(bDate);
  // 4. Stable title tie-break
  return (a.title || '').localeCompare(b.title || '');
}

/** Group tasks for Inbox tab: buckets by creation date */
function _groupByCreatedDate(tasks) {
  const today = _todayStr();
  const yesterday = (() => {
    const d = new Date(today + 'T00:00:00');
    d.setDate(d.getDate() - 1);
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  })();

  const groups = new Map();
  // Sort by createdAt desc; tasks with no createdAt go last ('' sorts before real dates when desc)
  const sorted = [...tasks].sort((a, b) => {
    if (!a.createdAt && !b.createdAt) return 0;
    if (!a.createdAt) return 1;  // no date → sort last
    if (!b.createdAt) return -1;
    return b.createdAt.localeCompare(a.createdAt);
  });
  for (const t of sorted) {
    const raw = t.createdAt ? t.createdAt.slice(0, 10) : 'Unknown';
    let label;
    if (raw === today)     label = 'Created Today';
    else if (raw === yesterday) label = 'Created Yesterday';
    else if (raw !== 'Unknown') {
      const d = new Date(raw + 'T00:00:00');
      label = 'Created ' + d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    } else {
      label = 'Created (date unknown)';
    }
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(t);
  }
  return groups;
}

/**
 * Compute the canonical date boundaries for the Scheduled tab time-context buckets.
 * Returns an object with YYYY-MM-DD strings for each boundary.
 *   today      : today's date string
 *   tomorrow   : tomorrow's date string
 *   weekEnd    : end of THIS week (Sunday of current week, or last day of 7-day window)
 *   nextWeekEnd: end of NEXT week (7 days after weekEnd)
 */
function _getScheduledBoundaries() {
  const now = new Date();
  const today = _todayStr();

  // Tomorrow
  const tomD = new Date(today + 'T00:00:00');
  tomD.setDate(tomD.getDate() + 1);
  const tomorrow = tomD.getFullYear() + '-' + String(tomD.getMonth()+1).padStart(2,'0') + '-' + String(tomD.getDate()).padStart(2,'0');

  // End of this week = this coming Sunday (or Saturday, based on ISO-week-like convention)
  // We use a simpler: "this week" = today through the next 6 days (rolling 7-day window ending Saturday)
  // Actually use calendar week: Mon-Sun. Find next Sunday.
  const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysUntilSunday = dayOfWeek === 0 ? 6 : 7 - dayOfWeek; // days until next Sunday (end of week)
  const weekEndD = new Date(today + 'T00:00:00');
  weekEndD.setDate(weekEndD.getDate() + daysUntilSunday);
  const weekEnd = weekEndD.getFullYear() + '-' + String(weekEndD.getMonth()+1).padStart(2,'0') + '-' + String(weekEndD.getDate()).padStart(2,'0');

  // End of next week = 7 days after weekEnd
  const nextWeekEndD = new Date(weekEndD);
  nextWeekEndD.setDate(nextWeekEndD.getDate() + 7);
  const nextWeekEnd = nextWeekEndD.getFullYear() + '-' + String(nextWeekEndD.getMonth()+1).padStart(2,'0') + '-' + String(nextWeekEndD.getDate()).padStart(2,'0');

  return { today, tomorrow, weekEnd, nextWeekEnd };
}

/**
 * Classify a YYYY-MM-DD date string into a time-context bucket key.
 * Returns one of: 'overdue' | 'today' | 'tomorrow' | 'this-week' | 'next-week' | 'later'
 */
function _classifyScheduledDate(dateStr, boundaries) {
  const { today, tomorrow, weekEnd, nextWeekEnd } = boundaries;
  if (dateStr < today)    return 'overdue';
  if (dateStr === today)  return 'today';
  if (dateStr === tomorrow) return 'tomorrow';
  if (dateStr <= weekEnd) return 'this-week';
  if (dateStr <= nextWeekEnd) return 'next-week';
  return 'later';
}

/** Maps a bucket key to its display label and accent color */
const SCHEDULED_BUCKETS = [
  { key: 'overdue',   label: '⚠ Overdue',    color: '#dc2626' },
  { key: 'today',     label: '📅 Today',      color: '#f97316' },
  { key: 'tomorrow',  label: '🌅 Tomorrow',   color: '#eab308' },
  { key: 'this-week', label: '📆 This Week',  color: '#3b82f6' },
  { key: 'next-week', label: '🗓 Next Week',  color: '#8b5cf6' },
  { key: 'later',     label: '🔭 Later',      color: '#6b7280' },
];

/** Group tasks for Scheduled tab: time-context buckets using EXECUTION DATE */
function _groupByScheduledDate(tasks) {
  const boundaries = _getScheduledBoundaries();

  // Build bucket map in canonical order
  const buckets = new Map();
  for (const b of SCHEDULED_BUCKETS) buckets.set(b.key, []);

  for (const t of tasks) {
    const dateStr = _getExecDate(t); // [MAJOR] use execution date (falls back to dueDate)
    if (!dateStr) continue;
    const bucket = _classifyScheduledDate(dateStr, boundaries);
    buckets.get(bucket).push(t);
  }

  // Sort within each bucket
  for (const [key, group] of buckets) {
    if (key === 'overdue') {
      group.sort((a, b) => (_getExecDate(a) || '').localeCompare(_getExecDate(b) || ''));
    } else {
      group.sort((a, b) => {
        const da = _getExecDate(a) || '9999-99-99';
        const db = _getExecDate(b) || '9999-99-99';
        if (da !== db) return da.localeCompare(db);
        return _priorityStatusDeadlineSort(a, b);
      });
    }
  }

  // Build result Map using display labels (skip empty buckets)
  const result = new Map();
  for (const b of SCHEDULED_BUCKETS) {
    const group = buckets.get(b.key);
    if (group.length > 0) result.set(b.label, group);
  }
  return result;
}



/** Group for Today tab: by status, ordered by priority within each group */
function _groupTodayByStatus(tasks) {
  const statusOrder = ['Not Started', 'Inbox', 'Next Up', 'Review', 'In Progress', 'Completed', 'Done']; // H05b legacy
  const groups = new Map();
  for (const t of [...tasks].sort(_priorityStatusDeadlineSort)) {
    const s = t.status || 'Not Started';
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(t);
  }
  const sorted = new Map();
  for (const key of statusOrder) { if (groups.has(key)) sorted.set(key, groups.get(key)); }
  for (const [k, v] of groups) { if (!sorted.has(k)) sorted.set(k, v); }
  return sorted;
}

function _groupByStatus(tasks) {
  const order = ['Not Started', 'Inbox', 'Next Up', 'Review', 'In Progress', 'Completed', 'Done']; // H05: legacy status compat
  const groups = new Map();
  for (const t of tasks) {
    const s = t.status || 'Not Started';
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(t);
  }
  const sorted = new Map();
  for (const key of order) { if (groups.has(key)) sorted.set(key, groups.get(key)); }
  for (const [k, v] of groups) { if (!sorted.has(k)) sorted.set(k, v); }
  return sorted;
}

function _groupByContext(tasks) {
  const groups = new Map();
  // Sort tasks by priority+deadline within each context group
  const sortedTasks = [...tasks].sort(_priorityStatusDeadlineSort);
  for (const t of sortedTasks) {
    const CTX_LABELS = { family: 'Family', personal: 'Personal', business: 'Business' };
    const ctx = (!t.context || t.context === 'all') ? 'All Contexts' : (CTX_LABELS[t.context] || t.context); // M03: capitalize
    if (!groups.has(ctx)) groups.set(ctx, []);
    groups.get(ctx).push(t);
  }
  return groups;
}

// _todayStr() defined above

// ── DOM: Filter bar ───────────────────────────────────────── //

/**
 * Unified filter change dispatcher.
 * In kanban mode: only the board columns need updating (_rerenderColumns).
 * In alt views (list/wall/gallery/table): full re-render needed because
 * _rerenderColumns only updates _boardEl which is null in alt modes.
 */
function _applyFilterChange() {
  if (_viewMode === 'kanban') {
    _rerenderColumns();
  } else {
    renderKanban({ _internal: true });
  }
}

/** CSS string for a scheduled time-context pill button */
function _scheduledPillStyle(isActive, color) {
  const base = 'display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:var(--radius-full);font-size:var(--text-xs);font-weight:var(--weight-semibold);cursor:pointer;transition:all 0.15s;white-space:nowrap;border:1.5px solid ';
  if (isActive) {
    return base + color + ';background:' + color + ';color:#fff;';
  }
  return base + color + ';background:transparent;color:' + color + ';';
}

/** Re-render the scheduled view — triggers full renderKanban for reliable state sync */
function _reRenderScheduled() {
  if (_filterTab !== 'scheduled') return;
  renderKanban({ _internal: true });
}

function _buildFilterBar(container) {
  const bar = document.createElement('div');
  bar.className = 'kanban-filter-bar';

  // ── Scheduled tab: time-context bucket filters ──────────────
  if (_filterTab === 'scheduled') {
    const timeRow = document.createElement('div');
    timeRow.className = 'kanban-scheduled-time-row';
    timeRow.style.cssText = 'display:flex;align-items:center;gap:var(--space-2);flex-wrap:nowrap;width:100%;padding-bottom:var(--space-2);border-bottom:1px solid var(--color-border);margin-bottom:var(--space-2);overflow-x:auto;scrollbar-width:thin;';

    const timeLabel = document.createElement('span');
    timeLabel.textContent = 'Show:';
    timeLabel.style.cssText = 'font-size:var(--text-xs);color:var(--color-text-muted);font-weight:var(--weight-semibold);flex-shrink:0;';
    timeRow.appendChild(timeLabel);

    const allPill = document.createElement('button');
    allPill.type = 'button';
    allPill.textContent = 'All';
    const isAllActive = !_filterScheduledRange;
    const allPillColor = isAllActive ? 'var(--color-accent,#3b82f6)' : '#6b7280';
    allPill.style.cssText = _scheduledPillStyle(isAllActive, allPillColor);
    allPill.addEventListener('click', () => {
      _filterScheduledRange = null;
      _reRenderScheduled();
    });
    timeRow.appendChild(allPill);

    const boundaries = _getScheduledBoundaries();
    const bucketCounts = new Map();
    const savedRange = _filterScheduledRange;
    _filterScheduledRange = null;
    // [P17 fix] Include instances in scheduled count badges
    const _normInstSched = _instances
      .filter(i => i.status !== 'Completed' && i.status !== 'Skipped')
      .map(_normalizeInstance).filter(Boolean);
    const _mergedForCount = [..._tasks.filter(t => !t.isRecurring), ..._normInstSched];
    const allForCounts = _applyFilters(_applyFilterTab(_mergedForCount));
    _filterScheduledRange = savedRange;
    for (const t of allForCounts) {
      // Scheduled uses executionDate (falls back to dueDate)
      const ds = _getExecDate(t);
      if (!ds) continue;
      const bk = _classifyScheduledDate(ds, boundaries);
      bucketCounts.set(bk, (bucketCounts.get(bk) || 0) + 1);
    }

    for (const b of SCHEDULED_BUCKETS) {
      const count = bucketCounts.get(b.key) || 0;
      const isActive = _filterScheduledRange === b.key;
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.style.cssText = _scheduledPillStyle(isActive, b.color);
      pill.innerHTML = b.label + (count > 0 ? ' <span style="font-size:10px;opacity:0.85;font-variant-numeric:tabular-nums;">(' + count + ')</span>' : '');
      pill.addEventListener('click', () => {
        _filterScheduledRange = isActive ? null : b.key;
        _reRenderScheduled();
      });
      timeRow.appendChild(pill);
    }

    bar.appendChild(timeRow);
  }
  // Project dropdown
  const projSelect = document.createElement('select');
  projSelect.className = 'select kanban-filter-select';
  projSelect.innerHTML = '<option value="">All Projects</option>';
  for (const p of _projects) {
    if (p.status === 'Archived') continue;
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `📁 ${p.name || 'Untitled'}`;
    if (p.id === _filterProject) opt.selected = true;
    projSelect.appendChild(opt);
  }
  projSelect.addEventListener('change', () => {
    _filterProject = projSelect.value || null;
    _applyFilterChange(); // B04 fix: re-render in all view modes
  });
  bar.appendChild(projSelect);

  // Priority dropdown
  const prioSelect = document.createElement('select');
  prioSelect.className = 'select kanban-filter-select';
  prioSelect.innerHTML = '<option value="">All Priorities</option>';
  for (const p of ['Critical', 'High', 'Medium', 'Low']) {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p;
    if (p === _filterPriority) opt.selected = true;
    prioSelect.appendChild(opt);
  }
  prioSelect.addEventListener('change', () => {
    _filterPriority = prioSelect.value || null;
    _applyFilterChange(); // B04 fix
  });
  bar.appendChild(prioSelect);

  // Assignee avatars
  const assignees = _collectAssignees();
  if (assignees.length) {
    const assigneeWrap = document.createElement('div');
    assigneeWrap.className = 'kanban-filter-avatars';
    for (const person of assignees) {
      const av = document.createElement('button');
      av.className = 'kanban-filter-avatar' + (_filterAssignees.has(person.id) ? ' active' : '');
      av.title = person.name || person.id;
      av.textContent = (person.name || '?').charAt(0).toUpperCase();
      av.addEventListener('click', () => {
        if (_filterAssignees.has(person.id)) _filterAssignees.delete(person.id);
        else _filterAssignees.add(person.id);
        _applyFilterChange(); // B04 fix
        av.classList.toggle('active');
      });
      assigneeWrap.appendChild(av);
    }
    bar.appendChild(assigneeWrap);
  }

  // ── Tag multi-select combobox ──────────────────────────────
  // Fills remaining space, search-as-you-type, multi-select checkboxes,
  // selected count badge / pills in trigger, one-click clear.
  const allTags = _collectAllTags();
  if (allTags.length) {
    const tagCombo = document.createElement('div');
    tagCombo.className = 'kanban-tag-combo';
    tagCombo.style.cssText = 'position:relative;flex:1;min-width:120px;max-width:420px;';

    // ── Trigger button ──
    const tagTrigger = document.createElement('button');
    tagTrigger.type = 'button';
    tagTrigger.className = 'kanban-tag-trigger';
    tagTrigger.style.cssText = [
      'display:flex;align-items:center;gap:var(--space-1);width:100%;',
      'padding:3px 8px;border:1px solid var(--color-border);border-radius:var(--radius-md);',
      'background:var(--color-surface);cursor:pointer;font-size:var(--text-sm);',
      'color:var(--color-text);min-height:30px;flex-wrap:wrap;text-align:left;',
    ].join('');

    function _renderTagTrigger() {
      tagTrigger.innerHTML = '';
      const selected = [..._filterTags];
      if (selected.length === 0) {
        const placeholder = document.createElement('span');
        placeholder.style.cssText = 'color:var(--color-text-muted);flex:1;font-size:var(--text-sm);';
        placeholder.textContent = '🏷️ Tags';
        tagTrigger.appendChild(placeholder);
      } else if (selected.length <= 3) {
        // Show pills for up to 3
        for (const t of selected) {
          const pill = document.createElement('span');
          pill.style.cssText = [
            'display:inline-flex;align-items:center;gap:2px;padding:1px 6px;',
            'background:var(--color-accent);color:#fff;border-radius:var(--radius-full);',
            'font-size:var(--text-xs);white-space:nowrap;max-width:90px;overflow:hidden;text-overflow:ellipsis;',
          ].join('');
          pill.title = t;
          pill.textContent = t;
          tagTrigger.appendChild(pill);
        }
      } else {
        // First pill + count badge when many selected
        const firstPill = document.createElement('span');
        firstPill.style.cssText = [
          'display:inline-flex;align-items:center;padding:1px 6px;',
          'background:var(--color-accent);color:#fff;border-radius:var(--radius-full);',
          'font-size:var(--text-xs);white-space:nowrap;max-width:80px;overflow:hidden;text-overflow:ellipsis;',
        ].join('');
        firstPill.textContent = selected[0];
        firstPill.title = selected[0];
        tagTrigger.appendChild(firstPill);
        const badge = document.createElement('span');
        badge.style.cssText = [
          'display:inline-flex;align-items:center;justify-content:center;',
          'padding:1px 6px;background:var(--color-accent);color:#fff;',
          'border-radius:var(--radius-full);font-size:var(--text-xs);font-weight:var(--weight-bold);white-space:nowrap;',
        ].join('');
        badge.textContent = `+${selected.length - 1} more`;
        tagTrigger.appendChild(badge);
      }
      // Caret + clear
      const right = document.createElement('span');
      right.style.cssText = 'display:flex;align-items:center;gap:4px;margin-left:auto;flex-shrink:0;';
      if (selected.length > 0) {
        const clearX = document.createElement('span');
        clearX.textContent = '✕';
        clearX.style.cssText = 'font-size:10px;color:var(--color-text-muted);padding:0 2px;cursor:pointer;';
        clearX.title = 'Clear tag filters';
        clearX.addEventListener('click', (e) => {
          e.stopPropagation();
          _filterTags.clear();
          _renderTagTrigger();
          _applyFilterChange();
        });
        right.appendChild(clearX);
      }
      const caret = document.createElement('span');
      caret.textContent = '▾';
      caret.style.cssText = 'font-size:9px;color:var(--color-text-muted);';
      right.appendChild(caret);
      tagTrigger.appendChild(right);
    }
    _renderTagTrigger();

    // ── Dropdown panel ──
    const tagDd = document.createElement('div');
    tagDd.className = 'kanban-tag-dd';
    tagDd.style.cssText = [
      'display:none;position:absolute;left:0;top:calc(100% + 4px);min-width:220px;width:max-content;max-width:340px;',
      'background:var(--color-surface);border:1px solid var(--color-border);',
      'border-radius:var(--radius-lg);box-shadow:var(--shadow-lg);z-index:300;',
      'flex-direction:column;overflow:hidden;',
    ].join('');

    // Search input
    const tagSearch = document.createElement('input');
    tagSearch.type = 'text';
    tagSearch.placeholder = 'Search tags…';
    tagSearch.style.cssText = [
      'width:100%;padding:8px 10px;border:none;border-bottom:1px solid var(--color-border);',
      'outline:none;font-size:var(--text-sm);background:transparent;color:var(--color-text);',
      'box-sizing:border-box;',
    ].join('');
    tagDd.appendChild(tagSearch);

    // Options list
    const tagList = document.createElement('div');
    tagList.style.cssText = 'max-height:220px;overflow-y:auto;padding:var(--space-1) 0;';

    function _renderTagOptions(filter = '') {
      tagList.innerHTML = '';
      const q = filter.toLowerCase();
      const visible = allTags.filter(t => !q || t.toLowerCase().includes(q));
      if (visible.length === 0) {
        const none = document.createElement('div');
        none.style.cssText = 'padding:8px 12px;font-size:var(--text-sm);color:var(--color-text-muted);';
        none.textContent = 'No tags match';
        tagList.appendChild(none);
        return;
      }
      for (const tag of visible) {
        const row = document.createElement('label');
        row.style.cssText = [
          'display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;',
          'font-size:var(--text-sm);color:var(--color-text);',
          'transition:background var(--transition-fast);',
        ].join('');
        row.addEventListener('mouseenter', () => { row.style.background = 'var(--color-surface-2)'; });
        row.addEventListener('mouseleave', () => { row.style.background = ''; });
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = _filterTags.has(tag);
        cb.style.cssText = 'width:14px;height:14px;accent-color:var(--color-accent);cursor:pointer;flex-shrink:0;';
        cb.addEventListener('change', () => {
          if (cb.checked) _filterTags.add(tag);
          else _filterTags.delete(tag);
          _renderTagTrigger();
          _applyFilterChange();
        });
        const label = document.createElement('span');
        label.style.cssText = 'flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        label.textContent = tag;
        row.appendChild(cb);
        row.appendChild(label);
        tagList.appendChild(row);
      }
    }
    _renderTagOptions();
    tagDd.appendChild(tagList);

    // Footer: select all / clear all
    const tagFooter = document.createElement('div');
    tagFooter.style.cssText = [
      'display:flex;justify-content:space-between;padding:6px 10px;',
      'border-top:1px solid var(--color-border);gap:var(--space-2);',
    ].join('');
    const selAllBtn = document.createElement('button');
    selAllBtn.type = 'button';
    selAllBtn.textContent = 'Select all';
    selAllBtn.style.cssText = 'font-size:var(--text-xs);background:none;border:none;color:var(--color-accent);cursor:pointer;padding:0;';
    selAllBtn.addEventListener('click', () => {
      const q = tagSearch.value.toLowerCase();
      allTags.filter(t => !q || t.toLowerCase().includes(q)).forEach(t => _filterTags.add(t));
      _renderTagOptions(tagSearch.value);
      _renderTagTrigger();
      _applyFilterChange();
    });
    const clrAllBtn = document.createElement('button');
    clrAllBtn.type = 'button';
    clrAllBtn.textContent = 'Clear all';
    clrAllBtn.style.cssText = 'font-size:var(--text-xs);background:none;border:none;color:var(--color-text-muted);cursor:pointer;padding:0;';
    clrAllBtn.addEventListener('click', () => {
      _filterTags.clear();
      _renderTagOptions(tagSearch.value);
      _renderTagTrigger();
      _applyFilterChange();
    });
    tagFooter.appendChild(selAllBtn);
    tagFooter.appendChild(clrAllBtn);
    tagDd.appendChild(tagFooter);

    // Search live filter
    tagSearch.addEventListener('input', () => _renderTagOptions(tagSearch.value));

    // Toggle open/close
    let _tagDdOpen = false;
    tagTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      _tagDdOpen = !_tagDdOpen;
      tagDd.style.display = _tagDdOpen ? 'flex' : 'none';
      tagDd.style.flexDirection = 'column';
      if (_tagDdOpen) {
        tagSearch.value = '';
        _renderTagOptions();
        setTimeout(() => tagSearch.focus(), 50);
      }
    });

    // Close on outside click
    document.addEventListener('click', function _closeTagDd(e) {
      if (!tagCombo.contains(e.target)) {
        _tagDdOpen = false;
        tagDd.style.display = 'none';
        document.removeEventListener('click', _closeTagDd);
      }
    });

    // Close on Escape
    tagSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { _tagDdOpen = false; tagDd.style.display = 'none'; }
    });

    tagCombo.appendChild(tagTrigger);
    tagCombo.appendChild(tagDd);
    bar.appendChild(tagCombo);
  }

  // Overdue toggle — hidden on scheduled tab (time-context pills handle this)
  if (_filterTab !== 'scheduled') { // B34 fix: hide on scheduled tab
    const overdueBtn = document.createElement('button');
    overdueBtn.className = 'btn btn-ghost btn-sm kanban-overdue-btn' + (_filterOverdue ? ' active' : '');
    overdueBtn.textContent = '⏰ Overdue';
    overdueBtn.addEventListener('click', () => {
      _filterOverdue = !_filterOverdue;
      overdueBtn.classList.toggle('active');
      _applyFilterChange();
    });
    bar.appendChild(overdueBtn);
  }

  // Clear filters
  const clearBtn = document.createElement('button');
  clearBtn.className = 'btn btn-ghost btn-xs kanban-clear-btn';
  clearBtn.textContent = '✕ Clear';
  clearBtn.addEventListener('click', () => {
    _filterProject   = null;
    _filterAssignees.clear();
    _filterTags.clear();
    _filterPriority  = null;
    _filterOverdue   = false;
    _filterScheduledRange = null;
    renderKanban({ _internal: true });
  });
  bar.appendChild(clearBtn);

  container.appendChild(bar);
}

// ── DOM: Columns ──────────────────────────────────────────── //

let _boardEl = null;

/**
 * [v5.3.1] Normalize a taskInstance into a card-compatible object
 * by merging template properties (priority, tags) onto the instance.
 * Returns null if no template found (instance orphaned).
 */
function _normalizeInstance(inst) {
  const tmpl = _instTemplMap.get(inst.id);
  if (!tmpl) return null;
  return {
    ...inst,
    _isInstance: true,
    _template:   tmpl,
    priority:    tmpl.priority || 'Medium',
    tags:        tmpl.tags     || [],
  };
}

function _buildBoard(container) {
  _boardEl = document.createElement('div');
  _boardEl.className = 'kanban-board';
  container.appendChild(_boardEl);
  _rerenderColumns();
}

function _rerenderColumns() {
  if (!_boardEl) return;
  _cleanupTimerListeners(); // KB-9 fix: unsubscribe all card timer listeners before clearing DOM
  _boardEl.innerHTML = '';

  // [v5.3.2] Build merged task list:
  // - Non-recurring tasks appear in all tabs/columns as normal
  // - Active instances (not completed/skipped) appear in status columns
  // - Recurring templates are EXCLUDED from board columns (B5 fix):
  //   showing both template + instances causes duplication.
  //   Templates are visible via All tab in list-view only.
  const normInst = _instances
    .filter(i => i.status !== 'Completed' && i.status !== 'Skipped')
    .map(_normalizeInstance)
    .filter(Boolean);
  const mergedTasks = [
    ..._tasks.filter(t => !t.isRecurring),  // regular non-recurring tasks
    ...normInst,                              // active occurrences in status columns
    // recurring templates intentionally excluded from kanban columns
  ];

  // Apply filter tab even in kanban mode (e.g. 'completed' → only Done column tasks)
  const _tabFiltered = _applyFilterTab(mergedTasks);
  const filtered = _applyFilters(_tabFiltered);

  // Show a friendly empty state banner when filters yield no results
  const anyFilter = _filterProject || _filterAssignees.size || _filterTags.size || _filterPriority || _filterOverdue || _filterScheduledRange; // B06 fix
  if (anyFilter && filtered.length === 0) {
    const banner = document.createElement('div');
    banner.style.cssText = [
      'grid-column:1/-1;display:flex;flex-direction:column;align-items:center;',
      'justify-content:center;padding:var(--space-10) var(--space-6);gap:var(--space-3);',
      'color:var(--color-text-muted);text-align:center;',
    ].join('');
    banner.innerHTML = `
      <div style="font-size:2rem;opacity:0.35;">🔍</div>
      <div style="font-size:var(--text-base);font-weight:var(--weight-semibold);color:var(--color-text);">No tasks match your filters</div>
      <div style="font-size:var(--text-sm);">Try adjusting or clearing the active filters above.</div>
    `;
    _boardEl.appendChild(banner);
    return;
  }

  for (const col of COLUMNS) {
    const colTasks = _sortTasks(
      filtered.filter(t => {
        if (col.key === 'Not Started') return !t.status || t.status === 'Not Started' || t.status === 'Inbox';
        if (col.key === 'Next Up')     return t.status === 'Next Up' || t.status === 'Review'; // H02: legacy 'Review'
        if (col.key === 'Completed')   return t.status === 'Completed' || t.status === 'Done'; // H03: legacy 'Done'
        return t.status === col.key;
      }),
      col.key
    );
    _buildColumn(_boardEl, col, colTasks);
  }
}

function _buildColumn(board, col, tasks) {
  const colEl = document.createElement('div');
  colEl.className = 'kanban-col';
  colEl.dataset.status = col.key;

  // Header
  const header = document.createElement('div');
  header.className = 'kanban-col-header';
  header.innerHTML = `
    <span class="kanban-col-dot" style="background:${col.color}"></span>
    <span class="kanban-col-label">${_esc(col.label)}</span>
    <span class="kanban-col-count">${tasks.length}</span>
  `;

  // Sort dropdown
  const sortSelect = document.createElement('select');
  sortSelect.className = 'kanban-sort-select';
  sortSelect.setAttribute('aria-label', `Sort ${col.label}`);
  for (const opt of SORT_OPTIONS) {
    const o = document.createElement('option');
    o.value = opt.key;
    o.textContent = opt.label;
    if ((_sortBy[col.key] || 'deadline') === opt.key) o.selected = true;
    sortSelect.appendChild(o);
  }
  sortSelect.addEventListener('change', () => {
    _sortBy[col.key] = sortSelect.value;
    _rerenderColumns();
  });
  header.appendChild(sortSelect);
  colEl.appendChild(header);

  // Card list (drop zone)
  const list = document.createElement('div');
  list.className = 'kanban-card-list';
  list.dataset.status = col.key;

  if (tasks.length === 0) {
    // Empty-state placeholder — stays visible as a drop target
    const empty = document.createElement('div');
    empty.className = 'kanban-col-empty';
    empty.setAttribute('aria-label', `No tasks in ${col.label}`);
    empty.innerHTML = `<span>No tasks</span>`;
    list.appendChild(empty);
  } else {
    for (const task of tasks) {
      const card = _buildCard(task);
      list.appendChild(card);
    }
  }

  // Drop zone listeners
  _wireDropZone(list, col.key);

  colEl.appendChild(list);

  // Quick-add
  const quickAdd = _buildQuickAdd(col.key);
  colEl.appendChild(quickAdd);

  board.appendChild(colEl);
}

// ── DOM: Task card ────────────────────────────────────────── //

function _buildCard(task) {
  const card = document.createElement('div');
  card.className = 'kanban-card';
  card.dataset.taskId = task.id;
  card.setAttribute('draggable', 'true');

  const today = _todayStr();
  const due   = _isoToLocalDate(task.dueDate); // [minor] BUG-49 fix: local date
  const dueCls = !due ? '' : due < today ? 'due-overdue' : due === today ? 'due-today' : 'due-future';

  // Project chip — resolve from direct field first, then from edge map
  const resolvedProjId = task.project || _taskProjectMap.get(task.id);
  const proj = resolvedProjId ? _projectMap.get(resolvedProjId) : null;
  const projChip = proj
    ? `<span class="kanban-card-project" style="border-left:3px solid ${proj.color || 'var(--color-accent)'}">${_esc(proj.name || 'Project')}</span>`
    : '';

  // Assignee avatar — resolve from direct field first, then from edge map
  const resolvedAssigneeId = task.assignedTo || _taskAssigneeMap.get(task.id);
  const assignee = resolvedAssigneeId ? _personMap.get(resolvedAssigneeId) : null;
  // K-03: Use person.color field for avatar background
  const avatarBg = assignee?.color && PERSON_COLOR_MAP[assignee.color]
    ? PERSON_COLOR_MAP[assignee.color]
    : 'var(--color-accent)';
  const assigneeEl = assignee
    ? `<span class="kanban-card-avatar" title="${_esc(assignee.name || '')}" style="background:${avatarBg}">${(assignee.name || '?').charAt(0).toUpperCase()}</span>`
    : '';

  // Priority dot
  const prioDot = task.priority
    ? `<span class="kanban-card-prio-dot" style="background:${PRIORITY_COLORS[task.priority] || 'var(--color-text-muted)'}" title="${_esc(task.priority)}"></span>`
    : '';

  // Execution date (when the task will be carried out)
  const execDate   = _isoToLocalDate(task.executionDate) || null;
  // Only show execution date chip when it differs from dueDate (avoids duplicate display)
  const showExecSeparate = execDate && execDate !== due;
  let plannedEl = '';
  if (showExecSeparate) {
    const execOverdue = execDate < today && task.status !== 'Done' && task.status !== 'Completed';
    const execToday   = execDate === today;
    const execColor   = execOverdue ? 'var(--color-danger)' : execToday ? 'var(--color-warning-text,#b45309)' : 'var(--color-info,#0ea5e9)';
    const execIcon    = (execOverdue || execToday) ? '⏰' : '🗓';
    plannedEl = `<span class="kanban-card-due" style="color:${execColor};font-size:0.68rem;" title="Planned for: ${execDate}">${execIcon} <span style="opacity:0.7;font-size:0.62rem;text-transform:uppercase;letter-spacing:0.04em;vertical-align:middle;">Plan</span> ${_formatDue(execDate, today)}</span>`;
  }
  // Due/deadline date
  let dueEl = '';
  if (due) {
    const isUrgent = due <= today; // overdue OR due today
    const deadlineColor = isUrgent ? 'var(--color-danger)' : 'var(--color-text-muted)';
    const deadlineIcon  = isUrgent ? '⏰' : '📅';
    const deadlineLabel = showExecSeparate ? '<span style="opacity:0.7;font-size:0.62rem;text-transform:uppercase;letter-spacing:0.04em;vertical-align:middle;">Due</span> ' : '';
    dueEl = `<span class="kanban-card-due ${dueCls}" style="${showExecSeparate ? 'color:' + deadlineColor + ';font-size:0.68rem;' : ''}" title="Deadline: ${due}">${deadlineIcon} ${deadlineLabel}${_formatDue(due, today)}</span>`;
  }

  // Tags (first 2 + "+N")
  const tags = Array.isArray(task.tags) ? task.tags : [];
  let tagHtml = '';
  if (tags.length > 0) {
    const shown = tags.slice(0, 2).map(t => `<span class="kanban-card-tag">${_esc(t)}</span>`).join('');
    const more  = tags.length > 2 ? `<span class="kanban-card-tag kanban-card-tag-more">+${tags.length - 2}</span>` : '';
    tagHtml = shown + more;
  }

  // Blocker
  const blockerEl = _blockMap.has(task.id)
    ? `<span class="kanban-card-blocker" title="Blocked by another task">🚫</span>`
    : '';

  // Checklist progress — K-02: visual progress bar + count
  // [B29 fix] Recurring templates show a blueprint checklist — suppress progress bar on templates
  const cl = (Array.isArray(task.checklist) && !task.isRecurring) ? task.checklist : [];
  const clDone = cl.filter(i => i.done).length;
  const clPct  = cl.length ? Math.round((clDone / cl.length) * 100) : 0;
  const clComplete = cl.length > 0 && clDone === cl.length;
  const clProgress = cl.length
    ? `<div class="kanban-card-checklist-prog" title="${clDone} of ${cl.length} checklist items done">
        <div class="kanban-card-checklist-bar-row">
          <span class="kanban-card-checklist-count${clComplete ? ' cl-complete' : ''}">${clDone}/${cl.length}</span>
          <div class="kanban-card-checklist-bar" role="progressbar" aria-valuenow="${clPct}" aria-valuemin="0" aria-valuemax="100">
            <div class="kanban-card-checklist-fill${clComplete ? ' cl-complete' : ''}" style="width:${clPct}%"></div>
          </div>
        </div>
      </div>`
    : '';

  // Kanban state dot (P-23)
  const kState    = task.kanban_state || 'normal';
  const kStateEsc = _esc(kState); // BUG-5 fix: escape kanban_state before embedding in HTML attrs
  const kStateDot = `<button class="kanban-state-dot kanban-state-dot--${kStateEsc}"
    title="State: ${kStateEsc}" aria-label="Kanban state: ${kStateEsc}" data-state="${kStateEsc}"></button>`;

  card.innerHTML = `
    <div class="kanban-card-top">
      <label class="kanban-card-check-label">
        <input type="checkbox" class="kanban-card-checkbox" ${(task.status === 'Completed' || task.status === 'Done') ? 'checked' : ''} />
      </label>
      <span class="kanban-card-title">${_esc(task.title || 'Untitled')}</span>
      ${prioDot}
      ${blockerEl}
      ${kStateDot}
    </div>
    ${clProgress}
    ${projChip}
    <div class="kanban-card-bottom">
      <div class="kanban-card-tags">${tagHtml}</div>
      <div class="kanban-card-meta">
        ${plannedEl}
        ${dueEl}
        ${assigneeEl}
        ${(_taskReminderMap.get(task.id)||0) > 0
          ? `<span class="kanban-card-reminder-badge" title="${_taskReminderMap.get(task.id)} active reminder${_taskReminderMap.get(task.id)!==1?'s':''}"
               style="font-size:0.7rem;padding:1px 5px;border-radius:10px;background:var(--color-accent-muted,#ede9fe);color:var(--color-accent,#4f8ef7);font-weight:600;white-space:nowrap;">
              🔔${_taskReminderMap.get(task.id)}
            </span>`
          : ''}
      </div>
    </div>
  `;

  // ── State dot: click → popover (P-23) ──────────────────── //
  const stateDotEl = card.querySelector('.kanban-state-dot');
  if (stateDotEl) {
    stateDotEl.addEventListener('click', (e) => {
      e.stopPropagation();
      _showStateDotPopover(stateDotEl, task);
    });
  }

  // ── [v5.3.1] Instance card overrides ──────────────────── //
  if (task._isInstance) {
    // Visual: purple left border marks instance cards
    card.style.borderLeft = '3px solid var(--color-accent2,#7C3AED)';
    // Subtitle: "#N · Weekly" etc.
    _getRruleHuman().then(rth => {
      const human  = rth ? rth(task._template?.rrule) : 'Recurring';
      const sub    = document.createElement('div');
      sub.style.cssText = [
        'font-size:0.65rem',
        'color:var(--color-accent2,#7C3AED)',
        'margin:-4px 0 4px 22px',
        'white-space:nowrap',
        'overflow:hidden',
        'text-overflow:ellipsis',
      ].join(';');
      sub.textContent = `↺ #${task.occurrenceIndex || '?'} · ${human}`;
      card.querySelector('.kanban-card-top')?.insertAdjacentElement('afterend', sub);
    }).catch(() => {});
    // Override checkbox: completeInstance instead of saveEntity
    const cbInst  = card.querySelector('.kanban-card-checkbox');
    if (cbInst) {
      const fresh = cbInst.cloneNode(true);
      cbInst.replaceWith(fresh);
      fresh.addEventListener('change', async (e) => {
        e.stopPropagation();
        if (!fresh.checked) return;
        fresh.disabled = true;
        card.style.opacity = '0.4';
        try {
          const { completeInstance } = await import('../services/recurrence.js');
          await completeInstance(task.id);
          window._fhEnv?.services?.effects?.play('confetti');
        } catch (err) {
          console.error('[kanban] completeInstance:', err);
          fresh.checked  = false;
          fresh.disabled = false;
          card.style.opacity = '1';
        }
      });
    }
  }

  // ── [v5.3.1] Recurring template: disable checkbox, add 🔁 prefix + pending count ──
  if (task.isRecurring && !task._isInstance) {
    const cbTmpl = card.querySelector('.kanban-card-checkbox');
    if (cbTmpl) {
      cbTmpl.disabled = true;
      cbTmpl.title    = 'Complete today\'s occurrence instead';
    }
    const tSpan = card.querySelector('.kanban-card-title');
    if (tSpan) tSpan.textContent = '🔁 ' + tSpan.textContent;
    // [N39 fix] Show count of pending instances so user knows activity level
    const pendingCount = _instances.filter(i =>
      i.templateId === task.id && i.status === 'Not Started'
    ).length;
    if (pendingCount > 0) {
      const badge = document.createElement('span');
      badge.style.cssText = 'font-size:0.6rem;padding:1px 5px;border-radius:99px;background:var(--color-accent2,#7C3AED);color:#fff;font-weight:600;margin-left:4px;vertical-align:middle;';
      badge.title = `${pendingCount} pending occurrence${pendingCount !== 1 ? 's' : ''}`;
      badge.textContent = pendingCount;
      tSpan?.parentElement?.appendChild(badge);
    }
  }

  // ── Click: title → edit form  |  rest of card → panel ──
  // (Checkbox is handled separately below and stops propagation)
  const titleSpan = card.querySelector('.kanban-card-title');
  if (titleSpan) {
    titleSpan.style.cssText += 'text-decoration: underline; text-decoration-color: transparent; text-underline-offset: 2px; transition: text-decoration-color 0.15s;';
    titleSpan.addEventListener('mouseenter', () => { titleSpan.style.textDecorationColor = 'var(--color-text-muted)'; });
    titleSpan.addEventListener('mouseleave', () => { titleSpan.style.textDecorationColor = 'transparent'; });
    titleSpan.addEventListener('click', (e) => {
      e.stopPropagation(); // prevent card click from also firing
      // Route through PANEL_OPENED → openPanel fetches fresh entity → openEditForm (form-first UX)
      // [B7 fix] use real entity type so panel config resolves correctly
      emit(EVENTS.PANEL_OPENED, { entityType: task._isInstance ? 'taskInstance' : 'task', entityId: task.id });
    });
  }
  card.addEventListener('click', (e) => {
    if (e.target.closest('.kanban-card-check-label')) return;
    if (e.target.closest('.kanban-card-title')) return; // title has its own handler
    emit(EVENTS.PANEL_OPENED, { entityType: task._isInstance ? 'taskInstance' : 'task', entityId: task.id }); // [B7 fix]
  });

  // ── Checkbox: toggle complete ──  [B1 fix: skip for instances — they use completeInstance handler above]
  if (!task._isInstance) {
  const cb = card.querySelector('.kanban-card-checkbox');
  cb.addEventListener('change', async (e) => {
    e.stopPropagation();
    const account = getAccount();
    // Revert to last non-completed status, not always 'Not Started'
    const revertStatus = (task.previousStatus && task.previousStatus !== 'Done' && task.previousStatus !== 'Completed')
      ? task.previousStatus
      : 'In Progress'; // C02: also exclude Completed from revert to prevent loop
    const newStatus = cb.checked ? 'Completed' : revertStatus;
    if (newStatus === 'Completed') window._fhEnv?.services?.effects?.play('confetti');
    // TT-12 fix: stop active timer when task is marked complete
    if (newStatus === 'Completed') {
      const _activeSession = getSession(task.id);
      if (_activeSession?.running) stopSession(task.id).catch(() => {});
    }
    // Optimistic fade for Completed tasks
    if (newStatus === 'Completed') {
      card.style.transition = 'opacity 0.25s';
      card.style.opacity = '0.35';
    }
    try {
      // Fetch fresh entity to avoid saving stale render-time snapshot
      let freshTaskCb;
      try { freshTaskCb = await getEntity(task.id); } catch { freshTaskCb = task; }
      const entityToSave = {
        ...freshTaskCb,
        status: newStatus,
        previousStatus: newStatus === 'Completed' ? freshTaskCb.status : freshTaskCb.previousStatus,
        kanban_state: (newStatus === 'Completed' && freshTaskCb.kanban_state === 'blocked') ? 'normal' : freshTaskCb.kanban_state,
      };
      await saveEntity(entityToSave, account?.id);
      // ENTITY_SAVED listener handles _loadData + _rerenderColumns — no manual call needed
      // (avoids the double-render flash caused by calling it here too)
    } catch (err) {
      console.error('[kanban] Complete failed:', err);
      cb.checked = !cb.checked;
      card.style.opacity = '1';
    }
  });
  } // end !task._isInstance guard

  // ── Drag start ──
  card.addEventListener('dragstart', (e) => {
    if (!task.id) { e.preventDefault(); return; } // Bug-70: guard missing id
    // [v5.4.0] Instances can be dragged to change status (Not Started/Next Up/In Progress)
    // but NOT to Completed — use the checkbox to complete instances.
    _dragTaskId = task.id;
    _dragEl     = card;
    card.classList.add('kanban-card-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', task.id);
  });

  card.addEventListener('dragend', () => {
    card.classList.remove('kanban-card-dragging');
    _clearDropIndicators();
    _dragTaskId = null;
    _dragEl     = null;
  });

  // ── Touch drag ──
  _wireTouchDrag(card, task);

  // ── Timer indicator badge ───────────────────────────────── //
  // Injected as a DOM element so it can update live via TIMER_TICK
  const timerBadge = document.createElement('div');
  timerBadge.className = 'kanban-card-timer';
  timerBadge.style.cssText = [
    'display:none;align-items:center;gap:3px;',
    'font-size:10px;font-weight:var(--weight-semibold);',
    'font-variant-numeric:tabular-nums;padding:2px 6px;',
    'border-radius:var(--radius-full);margin-top:4px;',
    'background:var(--color-accent);color:#fff;width:fit-content;',
  ].join('');

  function _refreshCardTimer() {
    const session = getSession(task.id);
    const alarmed = alarmedTaskIds.value.has(task.id);
    const active  = activeTaskIds.value.has(task.id);
    if (!session && !alarmed) {
      timerBadge.style.display = 'none';
      return;
    }
    timerBadge.style.display = 'inline-flex';
    const elapsed = getElapsed(session);
    if (alarmed) {
      timerBadge.textContent = '🔔 Block done';
      timerBadge.style.background = 'var(--color-danger)';
    } else if (session?.mode === 'block' && session.blockSecs) {
      const rem = getRemaining(session);
      timerBadge.textContent = '⏲ ' + formatDurationCompact(rem);
      timerBadge.style.background = rem <= 60 ? 'var(--color-danger)' : 'var(--color-accent)';
    } else {
      timerBadge.textContent = '⏱ ' + formatDurationCompact(elapsed);
      timerBadge.style.background = 'var(--color-accent)';
    }
  }

  // Initial render
  _refreshCardTimer();
  card.appendChild(timerBadge);

  // Live updates — store unsubscribes in registry (KB-9 fix: cleaned on re-render)
  _pushTimerUnsub(
    on(TIMER_TICK,  (d) => { if (d.taskId === task.id) _refreshCardTimer(); }),
    on(TIMER_ALARM, (d) => { if (d.taskId === task.id) _refreshCardTimer(); })
  );

  return card;
}


// ── State Dot Popover (P-23) ──────────────────────────────── //

const KANBAN_STATES = [
  { key: 'normal',  label: 'Normal',  color: 'var(--color-text-muted)' },
  { key: 'done',    label: 'Done',    color: 'var(--color-success)' },
  { key: 'blocked', label: 'Blocked', color: 'var(--color-danger)' },
];

let _activeDotPopover = null;

function _showStateDotPopover(dotEl, task) {
  // Close any existing popover
  _activeDotPopover?.remove();
  _activeDotPopover = null;

  const popover = document.createElement('div');
  popover.className = 'kanban-state-popover';
  popover.setAttribute('role', 'menu');

  for (const state of KANBAN_STATES) {
    const btn = document.createElement('button');
    btn.className = `kanban-state-option ${state.key === task.kanban_state ? 'kanban-state-option--active' : ''}`;
    btn.setAttribute('role', 'menuitem');
    btn.innerHTML = `<span class="kanban-state-option-dot" style="background:${state.color}"></span>${state.label}`;
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      popover.remove();
      _activeDotPopover = null;

      const account = getAccount();
      try {
        // Fetch fresh entity to avoid saving stale snapshot
        let freshTask;
        try { freshTask = await getEntity(task.id); } catch { freshTask = task; }
        // [G03 fix] Preserve _noSync on ghost instances — state dot doesn't promote ghost
        await saveEntity({ ...freshTask, kanban_state: state.key }, account?.id);
        // Update dot immediately without full re-render
        dotEl.className = `kanban-state-dot kanban-state-dot--${state.key}`;
        dotEl.setAttribute('title', `State: ${state.key}`);
        dotEl.setAttribute('aria-label', `Kanban state: ${state.key}`);
        dotEl.dataset.state = state.key;
        task.kanban_state = state.key;
        // Notification toast per spec
        const notifSvc = window._fhEnv?.services?.notification;
        if (notifSvc) {
          notifSvc.info(`Marked as ${state.label}`);
        }
      } catch (err) {
        console.error('[kanban] State update failed:', err);
      }
    });
    popover.appendChild(btn);
  }

  // Position below the dot
  document.body.appendChild(popover);
  const rect = dotEl.getBoundingClientRect();
  // BUG-12 fix: position:fixed uses viewport coords — no scrollY/scrollX offset needed
  popover.style.top  = `${rect.bottom + 4}px`;
  popover.style.left = `${Math.min(rect.left, window.innerWidth - 140)}px`;

  _activeDotPopover = popover;

  // Close on outside click or Escape
  const closeHandler = (e) => {
    if (!popover.contains(e.target)) {
      popover.remove();
      _activeDotPopover = null;
      document.removeEventListener('click', closeHandler, true);
      document.removeEventListener('keydown', escHandler);
    }
  };
  const escHandler = (e) => {
    if (e.key === 'Escape') {
      popover.remove();
      _activeDotPopover = null;
      document.removeEventListener('click', closeHandler, true);
      document.removeEventListener('keydown', escHandler);
    }
  };
  // Defer so the current click doesn't immediately close it
  setTimeout(() => {
    document.addEventListener('click', closeHandler, true);
    document.addEventListener('keydown', escHandler);
  }, 0);
}

// ── Quick-add helpers ─────────────────────────────────────── //

/**
 * Returns the appropriate dueDate for a quick-added task based on the
 * active filter tab and scheduled range filter.
 * Returns an object spread (e.g. { dueDate: 'YYYY-MM-DD' }) or {}.
 */
function _getQuickAddDueDate() {
  if (_filterTab === 'today') return { dueDate: _todayStr() };
  if (_filterTab === 'scheduled') {
    const b = _getScheduledBoundaries();
    switch (_filterScheduledRange) {
      case 'overdue':
      case 'today':    return { dueDate: b.today };
      case 'tomorrow': return { dueDate: b.tomorrow };
      case 'this-week': return { dueDate: b.weekEnd };
      case 'next-week': return { dueDate: b.nextWeekEnd };
      case 'later':    {
        // Later: set dueDate to 2 weeks from weekEnd as a reasonable default
        const later = new Date(b.nextWeekEnd + 'T00:00:00');
        later.setDate(later.getDate() + 7);
        return { dueDate: later.getFullYear() + '-' + String(later.getMonth()+1).padStart(2,'0') + '-' + String(later.getDate()).padStart(2,'0') };
      }
      default: return { dueDate: b.today }; // no range = default to today
    }
  }
  return {};
}

// ── Quick-add ─────────────────────────────────────────────── //

function _buildQuickAdd(statusKey) {
  const wrap = document.createElement('div');
  wrap.className = 'kanban-quick-add';

  const addBtn = document.createElement('button');
  addBtn.className = 'kanban-quick-add-btn';
  addBtn.textContent = '+ Add task';
  addBtn.addEventListener('click', () => {
    addBtn.style.display = 'none';
    inputWrap.style.display = 'flex';
    input.focus();
  });

  const inputWrap = document.createElement('div');
  inputWrap.className = 'kanban-quick-add-input-wrap';
  inputWrap.style.display = 'none';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'input kanban-quick-add-input';
  input.placeholder = 'Task name...';
  let _qaIsSaving = false; // BUG-R4 fix: prevent blur→focus→blur infinite loop

  const doAdd = async (fromBlur = false) => {
    if (_qaIsSaving) return; // BUG-R4 fix: prevent re-entrant calls
    const title = input.value.trim();
    if (!title) {
      inputWrap.style.display = 'none';
      addBtn.style.display = '';
      return;
    }
    _qaIsSaving = true;
    const account = getAccount();
    try {
      const ctx = getActiveContext();
      await saveEntity({
        type:     'task',
        title,
        status:   statusKey,
        priority: 'Medium',
        context:  (!ctx || ctx === 'all') ? 'personal' : ctx,
        // BUG-10/B18 fix: auto-set dueDate based on active tab and range filter
        ...(_getQuickAddDueDate()),
      }, account?.id);
      input.value = '';
      if (!fromBlur) {
        // Keep input open for rapid keyboard entry (Enter path only)
        setTimeout(() => {
          const col = wrap.closest('.kanban-col');
          const newCard = col?.querySelector('.kanban-card:last-child');
          if (newCard) {
            newCard.classList.add('kanban-card-new');
            setTimeout(() => newCard.classList.remove('kanban-card-new'), 400);
          }
          input.focus();
        }, 250);
      } else {
        // On blur-save: close the input so user knows it saved
        inputWrap.style.display = 'none';
        addBtn.style.display = '';
      }
    } catch (err) {
      console.error('[kanban] Quick add failed:', err);
    } finally {
      _qaIsSaving = false; // BUG-R4 fix: always release save guard
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doAdd(); }
    if (e.key === 'Escape') {
      input.value = '';
      inputWrap.style.display = 'none';
      addBtn.style.display = '';
    }
  });

  input.addEventListener('blur', () => {
    // BUG-15 fix: save on blur if there is content, don't silently discard
    setTimeout(() => {
      if (input.value.trim()) {
        doAdd(true); // BUG-R4 fix: fromBlur=true → close input after save, no focus() loop
      } else {
        inputWrap.style.display = 'none';
        addBtn.style.display = '';
      }
    }, 150);
  });

  inputWrap.appendChild(input);
  wrap.appendChild(addBtn);
  wrap.appendChild(inputWrap);
  return wrap;
}

// ── Drag and drop: mouse ──────────────────────────────────── //

function _wireDropZone(listEl, statusKey) {
  listEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    _showDropIndicator(listEl, e.clientY);
  });

  listEl.addEventListener('dragleave', (e) => {
    // Only clear if leaving the list entirely
    if (!listEl.contains(e.relatedTarget)) {
      _clearDropIndicators();
    }
  });

  listEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    _clearDropIndicators();
    const taskId = e.dataTransfer.getData('text/plain') || _dragTaskId;
    if (!taskId) return;
    await _moveTask(taskId, statusKey);
  });
}

function _showDropIndicator(listEl, clientY) {
  // Remove existing indicators
  listEl.querySelectorAll('.kanban-drop-indicator').forEach(el => el.remove());

  const cards = [...listEl.querySelectorAll('.kanban-card:not(.kanban-card-dragging)')];
  let insertBefore = null;

  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) {
      insertBefore = card;
      break;
    }
  }

  const indicator = document.createElement('div');
  indicator.className = 'kanban-drop-indicator';

  if (insertBefore) {
    listEl.insertBefore(indicator, insertBefore);
  } else {
    listEl.appendChild(indicator);
  }
}

function _clearDropIndicators() {
  document.querySelectorAll('.kanban-drop-indicator').forEach(el => el.remove());
}

// ── Drag and drop: touch ──────────────────────────────────── //

function _wireTouchDrag(card, task) {
  // [v5.4.0] Instances can be touch-dragged to change status (non-Completed columns only)
  let touchStartX = 0, touchStartY = 0;
  let isDragging = false;

  card.addEventListener('touchstart', (e) => {
    const touch = e.touches[0];
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
    isDragging = false;
  }, { passive: true });

  card.addEventListener('touchmove', (e) => {
    const touch = e.touches[0];
    const dx = Math.abs(touch.clientX - touchStartX);
    const dy = Math.abs(touch.clientY - touchStartY);

    // Start drag after 10px threshold
    if (!isDragging && (dx > 10 || dy > 10)) {
      isDragging = true;
      _dragTaskId = task.id;
      card.classList.add('kanban-card-dragging');

      // Create ghost
      _dragGhost = card.cloneNode(true);
      _dragGhost.className = 'kanban-card kanban-card-ghost';
      _dragGhost.style.cssText = `
        position: fixed; z-index: 9999; pointer-events: none;
        width: ${card.offsetWidth}px; opacity: 0.85;
        transform: rotate(2deg); box-shadow: var(--shadow-xl);
      `;
      document.body.appendChild(_dragGhost);
    }

    if (isDragging) {
      e.preventDefault();
      if (_dragGhost) {
        _dragGhost.style.left = `${touch.clientX - card.offsetWidth / 2}px`;
        _dragGhost.style.top  = `${touch.clientY - 20}px`;
      }

      // Find which column we're over
      const colLists = document.querySelectorAll('.kanban-card-list');
      for (const list of colLists) {
        const rect = list.getBoundingClientRect();
        if (touch.clientX >= rect.left && touch.clientX <= rect.right &&
            touch.clientY >= rect.top && touch.clientY <= rect.bottom) {
          _dropTarget = list.dataset.status;
          _showDropIndicator(list, touch.clientY);
        }
      }
    }
  }, { passive: false });

  const _touchCleanup = () => {
    card.classList.remove('kanban-card-dragging');
    _dragGhost?.remove();
    _dragGhost  = null;
    _dropTarget = null;
    _dragTaskId = null;
    isDragging  = false;
    _clearDropIndicators();
  };

  card.addEventListener('touchend', async () => {
    if (isDragging && _dragTaskId && _dropTarget) {
      await _moveTask(_dragTaskId, _dropTarget);
    }
    _touchCleanup();
  });

  // touchcancel fires when the OS interrupts (e.g. incoming call, notification)
  // Without this, the ghost element leaks and _dragTaskId stays set
  card.addEventListener('touchcancel', _touchCleanup);
}

// ── Move task to new status ───────────────────────────────── //

async function _moveTask(taskId, newStatus) {
  // Fetch fresh entity from IDB — avoids saving stale render-time snapshot
  let task;
  try {
    task = await getEntity(taskId);
  } catch {
    task = _tasks.find(t => t.id === taskId) || _instances.find(i => i.id === taskId);
  }
  if (!task || task.status === newStatus) return;
  // [v5.4.0] Instances can be dragged between non-Completed status columns.
  // Dragging an instance to Completed is blocked — use the checkbox instead.
  if (task.type === 'taskInstance' && (newStatus === 'Completed' || newStatus === 'Done')) return;

  const account = getAccount();
  try {
    // BUG-47 fix: preserve edge-resolved project relation on drag (task.project may be undefined for edge-stored relations)
    const edgeProject = _taskProjectMap.get(taskId);
    await saveEntity({
      ...task,
      status: newStatus,
      previousStatus: (newStatus === 'Completed' || newStatus === 'Done') ? task.status : task.previousStatus, // C03
      kanban_state: (newStatus === 'Completed' && task.kanban_state === 'blocked') ? 'normal' : task.kanban_state,
      ...(edgeProject && !task.project ? { project: edgeProject } : {}),
    }, account?.id);
    // [minor] BUG-64 fix: removed manual _loadData()/_rerenderColumns() here.
    // saveEntity triggers ENTITY_SAVED → the on(EVENTS.ENTITY_SAVED) listener
    // already calls _loadData().then(_rerenderColumns). Manual call caused double-render.

    // P-12: play confetti when task moves to Done column
    if (newStatus === 'Completed' || newStatus === 'Done' || newStatus === 'done') {
      window._fhEnv?.services?.effects?.play('confetti');
    }
  } catch (err) {
    console.error('[kanban] Move task failed:', err);
    // Re-render to restore correct state after failure
    await _loadData();
    _rerenderColumns();
  }
}

// ── Helper utilities ──────────────────────────────────────── //

function _esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _formatDue(dueStr, today) {
  if (!dueStr) return '';
  if (dueStr === today) return 'Today';
  // Yesterday / Tomorrow
  const d = new Date(dueStr + 'T00:00:00');
  const t = new Date(today + 'T00:00:00');
  const diff = Math.round((d - t) / 86400000);
  if (diff === -1) return 'Yesterday';
  if (diff === 1) return 'Tomorrow';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Styles injection ──────────────────────────────────────── //

function _injectStyles() {
  if (document.getElementById('kanban-view-styles')) return;
  const style = document.createElement('style');
  style.id = 'kanban-view-styles';
  style.textContent = `
    /* ── Kanban Layout ─────────────────────────────── */
    #view-kanban.active {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
      padding: 0;
    }
    /* Alt views: the body content area scrolls, not the whole container */
    #view-kanban.active.alt-view {
      overflow: hidden; /* container stays fixed */
    }
    #view-kanban.active.alt-view .kanban-alt-body {
      flex: 1;
      overflow-y: auto;
    }
    /* ── Filter Bar ─────────────────────────────────── */
    .kanban-filter-bar { /* B20 fix: removed duplicate flex-shrink:0 from preceding rule */
      display: flex;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-3) var(--space-4);
      border-bottom: 1px solid var(--color-border);
      background: var(--color-surface);
      flex-shrink: 0;
      flex-wrap: wrap;
      overflow-x: auto;
    }
    .kanban-filter-select {
      width: auto;
      min-width: 120px;
      padding: var(--space-1) var(--space-2);
      font-size: var(--text-xs);
    }
    .kanban-filter-avatars {
      display: flex;
      gap: var(--space-1);
    }
    .kanban-filter-avatar {
      width: 26px; height: 26px;
      border-radius: var(--radius-full);
      background: var(--color-surface-2);
      color: var(--color-text-muted);
      border: 2px solid transparent;
      font-size: 11px; font-weight: var(--weight-semibold);
      display: flex; align-items: center; justify-content: center;
      cursor: pointer;
      transition: border-color var(--transition-fast), background var(--transition-fast);
    }
    .kanban-filter-avatar.active {
      border-color: var(--color-accent);
      background: var(--color-accent);
      color: #fff;
    }
    .kanban-tag-combo {
      position: relative;
    }
    .kanban-tag-trigger {
      transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
    }
    .kanban-tag-trigger:hover {
      border-color: var(--color-accent);
    }
    .kanban-tag-trigger:focus-visible {
      outline: 2px solid var(--color-accent);
      outline-offset: 1px;
    }
    .kanban-tag-dd input[type="checkbox"]:checked {
      accent-color: var(--color-accent);
    }
    .kanban-overdue-btn.active {
      background: var(--color-danger-bg);
      color: var(--color-danger-text);
      border-color: var(--color-danger);
    }
    .kanban-clear-btn { margin-left: auto; }

    /* ── Board ──────────────────────────────────────── */
    .kanban-board {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: var(--space-3);
      flex: 1;
      overflow-x: auto;
      overflow-y: hidden;
      padding: var(--space-4);
      min-height: 0;
    }
    @media (max-width: 768px) {
      .kanban-board {
        grid-template-columns: repeat(4, minmax(260px, 1fr));
      }
    }

    /* ── Column ─────────────────────────────────────── */
    .kanban-col {
      display: flex;
      flex-direction: column;
      min-height: 0;
      border-radius: var(--radius-md);
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      overflow: hidden;
    }
    .kanban-col-header {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-3) var(--space-3);
      border-bottom: 1px solid var(--color-border);
      flex-shrink: 0;
    }
    .kanban-col-dot {
      width: 10px; height: 10px;
      border-radius: var(--radius-full);
      flex-shrink: 0;
    }
    .kanban-col-label {
      font-size: var(--text-sm);
      font-weight: var(--weight-semibold);
      color: var(--color-text);
    }
    .kanban-col-count {
      font-size: var(--text-xs);
      background: var(--color-surface-2);
      color: var(--color-text-muted);
      border-radius: var(--radius-full);
      padding: 0 6px;
      font-weight: var(--weight-semibold);
      line-height: 1.6;
    }
    .kanban-sort-select {
      margin-left: auto;
      border: none;
      background: transparent;
      font-size: var(--text-xs);
      color: var(--color-text-muted);
      cursor: pointer;
      padding: 2px;
      appearance: none;
    }

    /* ── Card List ──────────────────────────────────── */
    .kanban-card-list {
      flex: 1;
      overflow-y: auto;
      padding: var(--space-2);
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      min-height: 60px;
      scrollbar-width: thin;
      scrollbar-color: var(--color-border) transparent;
    }

    /* ── Card ───────────────────────────────────────── */
    .kanban-card {
      background: var(--color-bg);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: var(--space-2-5) var(--space-3);
      cursor: pointer;
      transition: box-shadow var(--transition-fast), border-color var(--transition-fast), opacity var(--transition-fast);
      display: flex;
      flex-direction: column;
      gap: var(--space-1-5);
      user-select: none;
    }
    .kanban-card:hover {
      border-color: var(--color-accent);
      box-shadow: var(--shadow-sm);
    }
    .kanban-card-dragging {
      opacity: 0.3;
    }
    .kanban-card-ghost {
      border-color: var(--color-accent);
    }

    .kanban-card-top {
      display: flex;
      align-items: flex-start;
      gap: var(--space-2);
    }
    .kanban-card-check-label {
      cursor: pointer;
      flex-shrink: 0;
      padding-top: 2px;
    }
    .kanban-card-checkbox {
      width: 14px; height: 14px;
      cursor: pointer;
      accent-color: var(--color-accent);
    }
    .kanban-card-title {
      font-size: var(--text-sm);
      font-weight: var(--weight-medium);
      color: var(--color-text);
      flex: 1;
      word-break: break-word;
      line-height: 1.35;
    }
    .kanban-card-checklist-prog {
      margin: 4px 0 2px;
      display: block;
    }
    .kanban-card-checklist-bar-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .kanban-card-checklist-count {
      font-size: 10px;
      font-weight: var(--weight-semibold);
      color: var(--color-text-muted);
      flex-shrink: 0;
      min-width: 28px;
    }
    .kanban-card-checklist-count.cl-complete {
      color: var(--color-success);
    }
    .kanban-card-checklist-bar {
      flex: 1;
      height: 4px;
      background: var(--color-border);
      border-radius: 99px;
      overflow: hidden;
    }
    .kanban-card-checklist-fill {
      height: 100%;
      background: var(--color-accent);
      border-radius: 99px;
      transition: width 0.3s ease;
    }
    .kanban-card-checklist-fill.cl-complete {
      background: var(--color-success);
    }
    .kanban-card-prio-dot {
      width: 8px; height: 8px;
      border-radius: var(--radius-full);
      flex-shrink: 0;
      margin-top: 4px;
    }
    .kanban-card-blocker {
      font-size: 12px;
      flex-shrink: 0;
      margin-top: 1px;
    }
    .kanban-card-project {
      font-size: var(--text-xs);
      color: var(--color-text-muted);
      padding-left: var(--space-2);
      display: block;
    }

    .kanban-card-bottom {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
    }
    .kanban-card-tags {
      display: flex;
      gap: var(--space-1);
      flex-wrap: wrap;
    }
    .kanban-card-tag {
      font-size: 10px;
      padding: 0 5px;
      border-radius: var(--radius-full);
      background: var(--color-surface-2);
      color: var(--color-text-muted);
      border: 1px solid var(--color-border);
      line-height: 1.6;
    }
    .kanban-card-tag-more {
      background: transparent;
      border: none;
      color: var(--color-text-muted);
      font-style: italic;
    }
    .kanban-card-meta {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      flex-shrink: 0;
    }
    .kanban-card-due {
      font-size: var(--text-xs);
      font-variant-numeric: tabular-nums;
    }
    .due-overdue { color: var(--color-danger); font-weight: var(--weight-semibold); }
    .due-today   { color: var(--color-warning-text); font-weight: var(--weight-semibold); }
    .due-future  { color: var(--color-text-muted); }

    .kanban-card-avatar {
      width: 22px; height: 22px;
      border-radius: var(--radius-full);
      background: var(--color-accent);
      color: #fff;
      font-size: 10px;
      font-weight: var(--weight-semibold);
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
    }

    /* ── Empty column placeholder ────────────────── */
    .kanban-col-empty {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: var(--space-6) var(--space-3);
      color: var(--color-text-muted);
      font-size: var(--text-sm);
      opacity: 0.5;
      pointer-events: none;
      user-select: none;
      border: 1.5px dashed var(--color-border);
      border-radius: var(--radius-md);
      margin: var(--space-2) 0;
    }

    /* ── Drop indicator ─────────────────────────── */
    .kanban-drop-indicator {
      height: 3px;
      background: var(--color-accent);
      border-radius: var(--radius-full);
      margin: var(--space-0-5) 0;
      flex-shrink: 0;
      animation: dropPulse 0.8s ease infinite alternate;
    }
    @keyframes dropPulse {
      from { opacity: 0.5; }
      to   { opacity: 1; }
    }

    /* ── Quick Add ──────────────────────────────────── */
    .kanban-quick-add {
      padding: var(--space-2) var(--space-2);
      border-top: 1px solid var(--color-border);
      flex-shrink: 0;
    }
    .kanban-quick-add-btn {
      width: 100%;
      padding: var(--space-2);
      border: 1px dashed var(--color-border);
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--color-text-muted);
      font-size: var(--text-xs);
      cursor: pointer;
      transition: border-color var(--transition-fast), color var(--transition-fast);
      font-family: var(--font-body);
    }
    .kanban-quick-add-btn:hover {
      border-color: var(--color-accent);
      color: var(--color-accent);
    }
    .kanban-quick-add-input-wrap {
      display: flex;
      gap: var(--space-2);
    }
    .kanban-quick-add-input {
      font-size: var(--text-sm);
      padding: var(--space-2);
    }

    /* ── Kanban State Dot ──────────────────────────── */
    .kanban-state-dot {
      width: 10px; height: 10px;
      border-radius: var(--radius-full);
      border: none; padding: 0; cursor: pointer;
      flex-shrink: 0; margin-top: 3px;
      transition: transform 0.12s;
    }
    .kanban-state-dot:hover { transform: scale(1.3); }
    .kanban-state-dot--normal  { background: var(--color-text-muted); }
    .kanban-state-dot--done    { background: var(--color-success); }
    .kanban-state-dot--blocked { background: var(--color-danger); }
    .kanban-state-popover {
      position: fixed; z-index: 9999; /* BUG-12 fix: fixed so scrollY offset not needed */
      background: var(--color-bg); border: 1px solid var(--color-border);
      border-radius: var(--radius-md); box-shadow: var(--shadow-lg);
      padding: var(--space-1); min-width: 120px;
    }
    .kanban-state-option {
      display: flex; align-items: center; gap: var(--space-2);
      padding: var(--space-1-5) var(--space-2); border: none;
      background: transparent; cursor: pointer; width: 100%;
      font-size: var(--text-sm); color: var(--color-text);
      border-radius: var(--radius-sm); transition: background 0.1s;
    }
    .kanban-state-option:hover { background: var(--color-surface-2); }
    .kanban-state-option--active { font-weight: var(--weight-bold); }
    .kanban-state-option-dot {
      width: 8px; height: 8px; border-radius: var(--radius-full); flex-shrink: 0;
    }
    .kanban-card-new {
      animation: cardSlideIn 0.3s ease;
    }
    @keyframes cardSlideIn {
      from { opacity: 0; transform: translateY(-8px); }
      to   { opacity: 1; transform: none; }
    }

    /* ── Deadline badge on card ─────────────────── */
    .kanban-card-deadline {
      font-size: var(--text-xs);
      font-variant-numeric: tabular-nums;
      padding: 1px 4px;
      border-radius: var(--radius-sm);
      background: var(--color-surface-2);
    }
    .kanban-card-deadline.due-overdue {
      background: var(--color-danger-bg, #fef2f2);
      color: var(--color-danger);
      font-weight: var(--weight-semibold);
    }
    .kanban-card-deadline.due-today {
      background: var(--color-warning-bg, #fffbeb);
      color: var(--color-warning-text);
      font-weight: var(--weight-semibold);
    }
    .kanban-card-deadline.due-future {
      color: var(--color-text-muted);
    }

    /* ── Inbox empty-state helper text ──────────── */
    .kanban-inbox-hint {
      font-size: var(--text-xs);
      color: var(--color-text-muted);
      padding: var(--space-2) var(--space-3);
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      margin-bottom: var(--space-3);
      line-height: 1.5;
    }

    /* ── Mobile ─────────────────────────────────────── */
    @media (max-width: 600px) {
      .kanban-filter-bar {
        padding: var(--space-2);
      }
      .kanban-board {
        padding: var(--space-2);
        gap: var(--space-2);
      }
    }
  `;
  document.head.appendChild(style);
}

// ── Main render ───────────────────────────────────────────── //

let _renderSeq = 0; // BUG-7 fix: render sequence counter to guard against concurrent renders

async function renderKanban(params = {}) {
  const viewEl = document.getElementById('view-kanban');
  if (!viewEl) return;

  // [fix] Ensure time-tracker module is loaded (safe if file not yet on server)
  await _ensureTimeTracker();

  const seq = ++_renderSeq; // claim this render slot
  _injectStyles();
  
  // [MAJOR] Load view preferences from DB on every fresh (non-internal) render (KB-5 fix)
  // seq===1 guard was wrong: after navigation _renderSeq > 1 so prefs never reloaded
  if (!params._internal) {
    await _loadViewPreferences();
  }
  
  // BUG-R15 fix: only show loading if this is the latest render (avoids flash on aborted renders)
  if (seq === _renderSeq) {
    viewEl.innerHTML = '<div style="padding:var(--space-8);color:var(--color-text-muted);text-align:center;">Loading tasks…</div>';
  }

  // BUG-36 fix: reset all filter state on a fresh (non-internal) render to prevent state leak
  if (!params._internal) {
    _filterProject = null; _filterAssignees.clear(); _filterTags.clear();
    _filterPriority = null; _filterOverdue = false; _filterScheduledRange = null;
    if (_viewMode !== (params.viewMode || _viewMode)) _sortBy = {};
    // Spec fix: snap to user's saved view preference for the current tab, fallback to canonical
    if (!params.viewMode) {
      _viewMode = _defaultViewPerTab[_filterTab] || _TAB_CANONICAL_VIEW[_filterTab] || 'list';
      _userOverrodeView = false;
    }
  }
  if (params.filter === 'overdue') _filterOverdue = true;
  if (params.viewMode) _viewMode = params.viewMode;
  if (params.filterTab) _filterTab = params.filterTab;

  try {
    await _loadData();
    if (seq !== _renderSeq) return; // BUG-7 fix: a newer render started; abort this one
    viewEl.innerHTML = '';

    // \u2500\u2500 Header: icon + title \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:var(--space-4) var(--space-5) 0;';
    header.innerHTML = '<div style="display:flex;align-items:center;gap:var(--space-3);"><span style="font-size:1.4rem;">\u2611</span><span style="font-size:var(--text-2xl);font-weight:var(--weight-bold);color:var(--color-text);">Tasks</span></div><div style="display:flex;align-items:center;gap:var(--space-2);"><span class="kanban-search-toggle" title="Search" style="cursor:pointer;font-size:1.1rem;">\uD83D\uDD0D</span><span class="kanban-collapse-toggle" title="Collapse" style="cursor:pointer;font-size:1.1rem;">\u2303</span></div>';
    viewEl.appendChild(header);

    // BUG 21: Wire search toggle — focuses the filter bar project/tag controls
    header.querySelector('.kanban-search-toggle')?.addEventListener('click', () => {
      const filterBar = viewEl.querySelector('.kanban-filter-bar');
      if (filterBar) filterBar.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      else {
        // In alt view, scroll to top
        viewEl.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
    // BUG 22: Wire collapse toggle — cycles between compact and normal tab bar
    header.querySelector('.kanban-collapse-toggle')?.addEventListener('click', () => {
      const tabBar = viewEl.querySelector('[data-kanban-tabbar]');
      if (tabBar) tabBar.style.display = tabBar.style.display === 'none' ? '' : 'none';
    });

    // \u2500\u2500 Filter tabs \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    const tabBar = document.createElement('div');
    tabBar.style.cssText = 'display:flex;gap:var(--space-1);padding:var(--space-3) var(--space-5) 0;flex-wrap:wrap;border-bottom:1px solid var(--color-border);';
    tabBar.dataset.kanbanTabbar = '1';
    for (const tab of _FILTER_TABS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      const isActive = _filterTab === tab.key;
      btn.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:6px 12px;border:none;border-radius:var(--radius-md) var(--radius-md) 0 0;cursor:pointer;font-size:var(--text-sm);font-weight:' + (isActive ? 'var(--weight-bold)' : 'var(--weight-normal)') + ';background:' + (isActive ? 'var(--color-surface)' : 'transparent') + ';color:' + (isActive ? 'var(--color-text)' : 'var(--color-text-muted)') + ';border-bottom:2px solid ' + (isActive ? 'var(--color-accent)' : 'transparent') + ';transition:all 0.15s;';
      btn.textContent = tab.icon + ' ' + tab.label;
      btn.addEventListener('click', () => {
        _filterTab = tab.key;
        // Use user's saved preference for this tab, fallback to canonical default
        _viewMode = _defaultViewPerTab[tab.key] || _TAB_CANONICAL_VIEW[tab.key] || 'list';
        _userOverrodeView = false;
        _filterScheduledRange = null; // reset time-context filter on tab switch
        renderKanban({ _internal: true });
      });
      tabBar.appendChild(btn);
    }
    viewEl.appendChild(tabBar);

    // \u2500\u2500 Controls row: count + view mode dropdown \u2500\u2500\u2500\u2500
    // [B6 fix] Build merged list for count badge + alt-views (list/table/wall)
    // so instances appear in counts and non-kanban views, not just in the board columns.
    // [B25 fix] Include completed/skipped instances for the 'completed' tab
    const _altNormInst = _instances
      .filter(i => i.status !== 'Completed' && i.status !== 'Skipped')
      .map(_normalizeInstance).filter(Boolean);
    const _altNormInstCompleted = _instances
      .filter(i => i.status === 'Completed' || i.status === 'Skipped')
      .map(_normalizeInstance).filter(Boolean);
    // [N05 fix] Recurring templates visible in 'all' tab; excluded from other tabs to avoid duplication
    const _recurringTemplates = _filterTab === 'all' ? _tasks.filter(t => t.isRecurring) : [];
    const _altMerged = [
      ..._tasks.filter(t => !t.isRecurring),
      ..._altNormInst,
      ...(_filterTab === 'completed' ? _altNormInstCompleted : []),
      ..._recurringTemplates,
    ];
    const filtered = _applyFilters(_applyFilterTab(_altMerged));
    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex;align-items:center;justify-content:flex-end;gap:var(--space-3);padding:var(--space-2) var(--space-5);';

    const countEl = document.createElement('span');
    countEl.style.cssText = 'font-size:var(--text-sm);color:var(--color-text-muted);font-weight:var(--weight-semibold);';
    countEl.className = 'kanban-task-count'; // tagged for _reRenderScheduled fast-path
    countEl.textContent = filtered.length + ' ' + (filtered.length === 1 ? 'item' : 'items'); // [P19] instances + tasks
    controls.appendChild(countEl);

    // View mode dropdown
    const vmWrap = document.createElement('div');
    vmWrap.style.cssText = 'position:relative;';
    const currentVm = _VIEW_MODES.find(v => v.key === _viewMode) || _VIEW_MODES.find(v => v.key === 'kanban') || _VIEW_MODES[0];
    const vmBtn = document.createElement('button');
    vmBtn.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-surface);cursor:pointer;font-size:var(--text-sm);color:var(--color-text);';
    vmBtn.type = 'button';
    vmBtn.innerHTML = currentVm.icon + ' ' + currentVm.label + ' \u25BE'; // FIX-10: show view name

    const vmDd = document.createElement('div');
    vmDd.style.cssText = 'display:none;position:absolute;right:0;top:100%;margin-top:4px;min-width:180px;background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-lg);box-shadow:var(--shadow-lg);z-index:200;padding:var(--space-2);';
    const vmSearchInp = document.createElement('input');
    vmSearchInp.type = 'text';
    vmSearchInp.placeholder = 'Search';
    vmSearchInp.style.cssText = 'width:100%;padding:var(--space-1) var(--space-2);border:none;border-bottom:1px solid var(--color-border);outline:none;font-size:var(--text-sm);background:transparent;color:var(--color-text);margin-bottom:var(--space-1);';
    vmDd.appendChild(vmSearchInp);
    for (const vm of _VIEW_MODES) {
      const item = document.createElement('div');
      item.className = 'kanban-vm-item';
      item.style.cssText = 'display:flex;align-items:center;gap:var(--space-2);padding:6px 8px;border-radius:var(--radius-sm);cursor:pointer;font-size:var(--text-sm);color:var(--color-text);' + (_viewMode === vm.key ? 'background:var(--color-surface-2);font-weight:var(--weight-bold);' : '');
      item.innerHTML = '<span>' + vm.icon + '</span> <span style="flex:1;">' + _esc(vm.label) + '</span>' + (_viewMode === vm.key ? '<span style="color:var(--color-accent);">\u2713</span>' : '');
      item.addEventListener('click', () => {
        _viewMode = vm.key;
        _userOverrodeView = true; // user explicitly chose this view
        _saveViewPreference(_filterTab, vm.key); // [MAJOR] Persist user's choice
        vmDd.style.display = 'none';
        renderKanban({ _internal: true });
      });
      item.addEventListener('mouseenter', () => { item.style.background = 'var(--color-surface-2)'; });
      item.addEventListener('mouseleave', () => { item.style.background = _viewMode === vm.key ? 'var(--color-surface-2)' : 'transparent'; });
      vmDd.appendChild(item);
    }
    vmSearchInp.addEventListener('input', () => {
      const q = vmSearchInp.value.toLowerCase();
      vmDd.querySelectorAll('.kanban-vm-item').forEach(el => { el.style.display = el.textContent.toLowerCase().includes(q) ? '' : 'none'; });
    });
    vmBtn.addEventListener('click', (e) => { e.stopPropagation(); vmDd.style.display = vmDd.style.display === 'none' ? '' : 'none'; });
    // [minor] BUG-21 fix: clean up ALL previous click-away listeners before adding new one
    // Without this, each renderKanban (filter tab switch) stacks a new listener.
    // BUG-R2 fix: always initialise _vmListeners before push (first render = undefined)
    if (viewEl._vmListeners) {
      viewEl._vmListeners.forEach(fn => document.removeEventListener('click', fn));
    }
    viewEl._vmListeners = [];
    const _vmClickAway = (ev) => { if (!vmWrap.contains(ev.target)) vmDd.style.display = 'none'; };
    document.addEventListener('click', _vmClickAway);
    viewEl._vmListeners.push(_vmClickAway);
    vmWrap.appendChild(vmBtn);
    vmWrap.appendChild(vmDd);
    controls.appendChild(vmWrap);
    viewEl.appendChild(controls);

    // \u2500\u2500 Render body based on view mode \u2500\u2500\u2500\u2500\u2500\u2500
    // Spec fix: filter bar shown in ALL view modes (not just kanban)
    // This lets users filter while viewing inbox/today/scheduled/etc. in list mode
    _buildFilterBar(viewEl);

    if (_viewMode === 'kanban') {
      viewEl.classList.remove('alt-view');
      _buildBoard(viewEl);
    } else {
      viewEl.classList.add('alt-view');
      _renderAltView(viewEl, filtered);
    }

  } catch (err) {
    console.error('[kanban] Render failed:', err);
    viewEl.innerHTML = '<div style="padding:var(--space-8);color:var(--color-danger-text);text-align:center;">Failed to load tasks. Please try refreshing.</div>';
  }
}

// ── Alternative view modes (non-Kanban) ───────────────────── //

function _renderAltView(container, tasks) {
  _cleanupTimerListeners(); // KB-10/11 fix: unsubscribe previous row timer listeners
  // Select grouping strategy based on active filter tab (spec-compliant)
  let grouped;
  switch (_filterTab) {
    case 'inbox':
      grouped = _groupByCreatedDate(tasks);
      break;
    case 'today':
      grouped = _groupTodayByStatus(tasks);
      break;
    case 'scheduled':
      grouped = _groupByScheduledDate(tasks);
      break;
    case 'open': {
      const openSorted = [...tasks].sort(_priorityStatusDeadlineSort);
      grouped = new Map([['Open Tasks', openSorted]]);
      break;
    }
    case 'completed':
      grouped = new Map([['Completed', tasks]]);
      break;
    case 'context':
      grouped = _groupByContext(tasks);
      break;
    case 'all':
    case 'status':
    default:
      grouped = _groupByStatus(tasks);
      break;
  }

  // ── Tab hint notes (item 10) ──────────────────────────── //
  const _TAB_HINTS = {
    inbox:      '📥 Inbox — tasks with no execution/due date. Grouped by creation date.',
    today:      '☀️ Today — grouped by Execution Date (or Due Date if not set). Shows today + overdue.',
    scheduled:  '📅 Scheduled — grouped by Execution Date (falls back to Due Date). Use this for planning when tasks will be done.',
    context:    '🏷️ Context — grouped by context tag. Ordered by execution date (or due date).',
    open:       '○ Open — all incomplete tasks. Ordered by priority → status → execution date.',
    completed:  '✅ Completed — recently completed tasks, newest first.',
    all:        '📚 All — every task across all tabs. Filter and sort as needed.',
  };

  const body = document.createElement('div');
  body.className = 'kanban-alt-body'; // FIX-7: scrollable wrapper for alt views
  body.style.cssText = 'padding:0 var(--space-5) var(--space-5);';

  // BUG 13: Show empty state when no tasks
  if (tasks.length === 0) {
    // Tab hint shown above empty state
    const hintTextEmpty = _TAB_HINTS[_filterTab];
    if (hintTextEmpty) {
      const hintBannerEmpty = document.createElement('div');
      hintBannerEmpty.style.cssText = [
        'margin-bottom:var(--space-3);padding:6px 12px;',
        'background:var(--color-surface-2,rgba(0,0,0,0.03));',
        'border-left:3px solid var(--color-accent);',
        'border-radius:0 var(--radius-sm) var(--radius-sm) 0;',
        'font-size:var(--text-xs);color:var(--color-text-muted);line-height:1.5;',
      ].join('');
      hintBannerEmpty.textContent = hintTextEmpty;
      body.appendChild(hintBannerEmpty);
    }
    const emptyIcon = _filterTab === 'inbox' ? '📥' : _filterTab === 'completed' ? '✅' : _filterTab === 'today' ? '☀️' : _filterTab === 'scheduled' ? '📅' : _filterTab === 'open' ? '○' : '🎉';
    const emptyMsg  = _filterTab === 'inbox'
      ? 'Your inbox is clear! Tasks with no due date appear here, grouped by creation date.'
      : _filterTab === 'today'
      ? 'Nothing scheduled for today.'
      : _filterTab === 'completed'
      ? 'No completed tasks yet.'
      : 'No tasks here. Switch tabs or clear filters to see tasks.';
    const emptyDiv = document.createElement('div');
    emptyDiv.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;padding:var(--space-12) var(--space-6);gap:var(--space-3);color:var(--color-text-muted);text-align:center;';
    emptyDiv.innerHTML = '<div style="font-size:2.5rem;">' + emptyIcon + '</div><div style="font-size:var(--text-base);font-weight:var(--weight-semibold);color:var(--color-text);">Empty</div><div style="font-size:var(--text-sm);">' + emptyMsg + '</div>';
    body.appendChild(emptyDiv);
    container.appendChild(body);
    return;
  }

  // Tab hint banner (non-empty state)
  const hintText = _TAB_HINTS[_filterTab];
  if (hintText) {
    const hintBanner = document.createElement('div');
    hintBanner.style.cssText = [
      'margin-bottom:var(--space-3);padding:6px 12px;',
      'background:var(--color-surface-2,rgba(0,0,0,0.03));',
      'border-left:3px solid var(--color-accent);',
      'border-radius:0 var(--radius-sm) var(--radius-sm) 0;',
      'font-size:var(--text-xs);color:var(--color-text-muted);line-height:1.5;',
    ].join('');
    hintBanner.textContent = hintText;
    body.appendChild(hintBanner);
  }
  // Inbox tab: show helper text explaining how to clear tasks from inbox
  if (_filterTab === 'inbox') {
    const hint = document.createElement('div');
    hint.className = 'kanban-inbox-hint';
    hint.textContent = 'These tasks have no due date set. Grouped by when they were created. Assign a due date to move a task out of inbox.';
    body.appendChild(hint);
  }

  // Color map for group badge headers across all tabs
  const _statusColors = {
    // Status groups
    'Not Started':'#6b7280','Inbox':'#6b7280','Next Up':'#f97316','Review':'#8b5cf6','In Progress':'#3b82f6','Completed':'#22c55e','Done':'#22c55e',
    // Scheduled tab time-context buckets (using SCHEDULED_BUCKETS display labels)
    '⚠ Overdue': '#dc2626',
    '📅 Today':   '#f97316',
    '🌅 Tomorrow':'#eab308',
    '📆 This Week':'#3b82f6',
    '🗓 Next Week':'#8b5cf6',
    '🔭 Later':   '#6b7280',
    // Other tabs
    'Open Tasks': '#3b82f6',
    // 'Completed' already defined in Status groups above
    'Created Today': '#6b7280', 'Created Yesterday': '#6b7280', 'Created (date unknown)': '#9ca3af',
  };

  for (const [groupKey, groupTasks] of grouped) {
    if (!groupTasks.length) continue;  // skip empty groups
    // Group badge
    const badge = document.createElement('div');
    badge.style.cssText = 'display:flex;align-items:center;gap:var(--space-2);margin:var(--space-4) 0 var(--space-2);';
    const bc = _statusColors[groupKey] || 'var(--color-text-muted)';
    badge.innerHTML = '<span style="display:inline-block;padding:2px 10px;border:1.5px solid ' + bc + ';border-radius:var(--radius-full);font-size:var(--text-xs);font-weight:var(--weight-bold);color:' + bc + ';">' + _esc(groupKey || 'None') + '</span> <span style="font-size:var(--text-xs);color:var(--color-text-muted);">' + groupTasks.length + '</span>';
    body.appendChild(badge);

    if (_viewMode === 'list' || _viewMode === 'embed') {
      for (const task of groupTasks) {
        const row = document.createElement('div');
        const isEmbed = _viewMode === 'embed';
        row.style.cssText = 'display:flex;align-items:center;gap:var(--space-3);padding:var(--space-2) var(--space-3);border-bottom:1px solid var(--color-border);cursor:pointer;transition:background 0.1s;';
        row.addEventListener('mouseenter', () => { row.style.background = 'var(--color-surface)'; });
        row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
        const projId = task.project || _taskProjectMap.get(task.id) || '';
        const pName = projId ? (_projectMap.get(projId)?.name || '') : '';
        const due = _isoToLocalDate(task.dueDate);
        const execDate2 = _isoToLocalDate(task.executionDate) || null;
        const today2 = _todayStr();
        const overdue = due && due < today2 && task.status !== 'Done' && task.status !== 'Completed'; // C07
        const dueFormatted = due ? _formatDue(due, today2) : '';
        const execFormatted = execDate2 ? _formatDue(execDate2, today2) : '';
        const execOverdue2 = execDate2 && execDate2 < today2 && task.status !== 'Done' && task.status !== 'Completed';
        const showExecSep2 = execDate2 && execDate2 !== due;
        // Build date chips HTML
        const plannedChip2 = execDate2
          ? ('<span style="font-size:var(--text-xs);color:' + (execOverdue2 ? 'var(--color-danger)' : execDate2 === today2 ? 'var(--color-warning-text,#b45309)' : 'var(--color-info,#0ea5e9)') + ';white-space:nowrap;">' +
             (execOverdue2 || execDate2 === today2 ? '⏰' : '🗓') + ' <span style="opacity:0.65;font-size:0.65rem;text-transform:uppercase;letter-spacing:0.04em;">Plan</span> ' + execFormatted + '</span>')
          : '';
        const deadlineChip2 = due
          ? ('<span style="font-size:var(--text-xs);color:' + (overdue ? 'var(--color-danger)' : due === today2 ? 'var(--color-warning-text,#b45309)' : 'var(--color-text-muted)') + ';font-weight:' + (overdue || due === today2 ? 'var(--weight-semibold)' : 'normal') + ';white-space:nowrap;">' +
             (overdue || due === today2 ? '⏰' : '📅') + ' ' + (showExecSep2 ? '<span style="opacity:0.65;font-size:0.65rem;text-transform:uppercase;letter-spacing:0.04em;">Due</span> ' : '') + dueFormatted + '</span>')
          : '';
        const expandChevron = isEmbed ? '<span style="font-size:var(--text-xs);color:var(--color-text-muted);flex-shrink:0;">&#9654;</span>' : '';
        row.innerHTML = expandChevron +
          '<input type="checkbox" ' + ((task.status === 'Completed' || task.status === 'Done') ? 'checked' : '') + ' style="width:14px;height:14px;cursor:pointer;accent-color:var(--color-accent);flex-shrink:0;" />' +
          '<span style="flex:1;font-size:var(--text-sm);color:var(--color-text);' + ((task.status === 'Completed' || task.status === 'Done') ? 'text-decoration:line-through;color:var(--color-text-muted);' : '') + '">' + _esc(task.title || 'Untitled') + '</span>' +
          plannedChip2 +
          deadlineChip2 +
          (pName ? '<span style="font-size:var(--text-xs);color:var(--color-accent);background:var(--color-surface-2);padding:1px 8px;border-radius:var(--radius-full);">' + _esc(pName) + '</span>' : '');
        // BUG-14 fix: interactive checkbox in list/embed views
        // [B11 fix] instances use completeInstance; regular tasks use saveEntity
        const listCb = row.querySelector('input[type=checkbox]');
        if (listCb) {
          listCb.addEventListener('change', async (e) => {
            e.stopPropagation();
            const account = getAccount();
            if (task._isInstance) {
              if (!listCb.checked) return;
              listCb.disabled = true;
              try {
                const { completeInstance } = await import('../services/recurrence.js');
                await completeInstance(task.id);
                window._fhEnv?.services?.effects?.play('confetti');
                row.style.opacity = '0.4';
              } catch (err) { console.error('[kanban] list completeInstance:', err); listCb.checked = false; listCb.disabled = false; }
              return;
            }
            const newStatus = listCb.checked ? 'Completed' : (task.previousStatus && task.previousStatus !== 'Completed' && task.previousStatus !== 'Done' ? task.previousStatus : 'In Progress');
            if (listCb.checked) window._fhEnv?.services?.effects?.play('confetti');
            try {
              let fresh; try { fresh = await getEntity(task.id); } catch { fresh = task; }
              await saveEntity({ ...fresh, status: newStatus, previousStatus: (newStatus === 'Completed' || newStatus === 'Done') ? fresh.status : fresh.previousStatus }, account?.id); // C04
            } catch (err) { console.error('[kanban] List complete failed:', err); listCb.checked = !listCb.checked; }
          });
        }
        row.addEventListener('click', (e) => { if (e.target.tagName === 'INPUT') return; emit(EVENTS.PANEL_OPENED, { entityType: task._isInstance ? 'taskInstance' : 'task', entityId: task.id }); }); // [B7]
        // Timer live badge
        const listTimerBadge = document.createElement('span');
        listTimerBadge.style.cssText = 'display:none;font-size:10px;font-weight:var(--weight-semibold);font-variant-numeric:tabular-nums;padding:1px 5px;border-radius:var(--radius-full);background:var(--color-accent);color:#fff;white-space:nowrap;flex-shrink:0;';
        function _refreshListTimer() {
          const _s = getSession(task.id);
          if (!_s && !alarmedTaskIds.value.has(task.id)) { listTimerBadge.style.display = 'none'; return; }
          listTimerBadge.style.display = 'inline';
          if (alarmedTaskIds.value.has(task.id)) { listTimerBadge.textContent = '\uD83D\uDD14'; listTimerBadge.style.background = 'var(--color-danger)'; }
          else if (_s.mode === 'block' && _s.blockSecs) { const _rem = getRemaining(_s); listTimerBadge.textContent = '\u23F2 ' + formatDurationCompact(_rem); listTimerBadge.style.background = _rem <= 60 ? 'var(--color-danger)' : 'var(--color-accent)'; }
          else { listTimerBadge.textContent = '\u23F1 ' + formatDurationCompact(getElapsed(_s)); listTimerBadge.style.background = 'var(--color-accent)'; }
        }
        _refreshListTimer();
        row.appendChild(listTimerBadge);
        _pushTimerUnsub( // KB-10 fix: store unsubscribes for cleanup on re-render
          on(TIMER_TICK,  (_d) => { if (_d.taskId === task.id) _refreshListTimer(); }),
          on(TIMER_ALARM, (_d) => { if (_d.taskId === task.id) _refreshListTimer(); })
        );
        body.appendChild(row);
      }
    } else if (_viewMode === 'wall' || _viewMode === 'gallery') {
      const grid = document.createElement('div');
      grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:var(--space-3);width:100%;';
      for (const task of groupTasks) {
        const card = document.createElement('div');
        card.style.cssText = 'flex:1 1 240px;min-width:200px;max-width:320px;border:1px solid var(--color-border);border-radius:var(--radius-lg);padding:var(--space-3);background:var(--color-surface);cursor:pointer;display:flex;flex-direction:column;gap:var(--space-1);transition:box-shadow 0.15s;'; // BUG-42 fix: responsive flex
        card.addEventListener('mouseenter', () => { card.style.boxShadow = 'var(--shadow-md)'; });
        card.addEventListener('mouseleave', () => { card.style.boxShadow = 'none'; });
        const wallDue = _isoToLocalDate(task.dueDate);
        const wallExec = _isoToLocalDate(task.executionDate) || null;
        const wallToday = _todayStr();
        const overdue = wallDue && wallDue < wallToday && task.status !== 'Done' && task.status !== 'Completed'; // C06
        const dueTodayW = wallDue === wallToday;
        const wallDueFmt  = wallDue  ? _formatDue(wallDue,  wallToday) : '';
        const wallExecFmt = wallExec ? _formatDue(wallExec, wallToday) : '';
        const wallExecOverdue = wallExec && wallExec < wallToday && task.status !== 'Done' && task.status !== 'Completed';
        const wallExecToday   = wallExec === wallToday;
        const wallShowExecSep = wallExec && wallExec !== wallDue;
        const projId = task.project || _taskProjectMap.get(task.id) || '';
        const pName = projId ? (_projectMap.get(projId)?.name || '') : '';
        // BUG-R5 fix: interactive checkbox in wall/gallery cards
        const wallDoneStyle = (task.status === 'Completed' || task.status === 'Done') ? 'text-decoration:line-through;color:var(--color-text-muted);' : '';
        card.innerHTML =
          '<div style="font-size:var(--text-xs);color:var(--color-accent);font-weight:var(--weight-bold);">&#8857; Task</div>' +
          '<div style="display:flex;align-items:center;gap:6px;">' +
            '<input type="checkbox" ' + ((task.status === 'Completed' || task.status === 'Done') ? 'checked' : '') + ' style="width:14px;height:14px;cursor:pointer;accent-color:var(--color-accent);flex-shrink:0;" />' +
            '<span style="font-size:var(--text-sm);font-weight:var(--weight-semibold);' + wallDoneStyle + '">' + _esc(task.title || 'Untitled') + '</span>' +
          '</div>' +
          (wallExec ? '<div style="font-size:var(--text-xs);color:' + (wallExecOverdue ? 'var(--color-danger)' : wallExecToday ? 'var(--color-warning-text,#b45309)' : 'var(--color-info,#0ea5e9)') + ';font-weight:' + (wallExecOverdue || wallExecToday ? 'var(--weight-semibold)' : 'normal') + ';">' + (wallExecOverdue || wallExecToday ? '⏰' : '🗓') + ' <span style="opacity:0.65;font-size:0.65rem;text-transform:uppercase;letter-spacing:0.04em;">Planned for</span> ' + wallExecFmt + '</div>' : '') +
          (wallDue ? '<div style="font-size:var(--text-xs);color:' + (overdue ? 'var(--color-danger)' : dueTodayW ? 'var(--color-warning-text,#b45309)' : 'var(--color-text-muted)') + ';font-weight:' + (overdue || dueTodayW ? 'var(--weight-semibold)' : 'normal') + ';">' + (overdue || dueTodayW ? '⏰' : '📅') + ' ' + (wallShowExecSep ? '<span style="opacity:0.65;font-size:0.65rem;text-transform:uppercase;letter-spacing:0.04em;">Deadline</span> ' : '') + wallDueFmt + '</div>' : '') +
          (pName ? '<div style="font-size:var(--text-xs);color:var(--color-text-muted);">&#127760; ' + _esc(pName) + '</div>' : '');
        const wallCb = card.querySelector('input[type=checkbox]');
        if (wallCb) {
          wallCb.addEventListener('change', async (e) => {
            e.stopPropagation();
            const account = getAccount();
            // [P02 fix] instances use completeInstance; regular tasks use saveEntity
            if (task._isInstance) {
              if (!wallCb.checked) return;
              wallCb.disabled = true;
              try {
                const { completeInstance } = await import('../services/recurrence.js');
                await completeInstance(task.id);
                window._fhEnv?.services?.effects?.play('confetti');
                card.style.opacity = '0.4';
              } catch (err) {
                console.error('[kanban] wall completeInstance:', err);
                wallCb.checked = false; wallCb.disabled = false;
              }
              return;
            }
            const newStatus = wallCb.checked ? 'Completed' : (task.previousStatus && task.previousStatus !== 'Completed' && task.previousStatus !== 'Done' ? task.previousStatus : 'In Progress');
            if (wallCb.checked) window._fhEnv?.services?.effects?.play('confetti');
            try {
              let fresh; try { fresh = await getEntity(task.id); } catch { fresh = task; }
              await saveEntity({ ...fresh, status: newStatus, previousStatus: (newStatus === 'Completed' || newStatus === 'Done') ? fresh.status : fresh.previousStatus }, account?.id); // C05
            } catch (err) { console.error('[kanban] Wall complete failed:', err); wallCb.checked = !wallCb.checked; }
          }); // C05: previousStatus fix applied above in wallCb change handler
        }
        card.addEventListener('click', (e) => { if (e.target.tagName === 'INPUT') return; emit(EVENTS.PANEL_OPENED, { entityType: task._isInstance ? 'taskInstance' : 'task', entityId: task.id }); }); // [B7]
        grid.appendChild(card);
      }
      body.appendChild(grid);
    } else if (_viewMode === 'table') {
      if (groupTasks.length) {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'overflow-x:auto;border:1px solid var(--color-border);border-radius:var(--radius-lg);margin-bottom:var(--space-2);';
        const t = document.createElement('table');
        t.style.cssText = 'width:100%;border-collapse:collapse;font-size:var(--text-sm);min-width:700px;';
        t.innerHTML = '<thead><tr style="background:var(--color-surface);border-bottom:2px solid var(--color-border);"><th style="padding:8px 12px;text-align:left;font-weight:var(--weight-bold);font-size:var(--text-xs);color:var(--color-text-muted);"></th><th style="padding:8px 12px;text-align:left;">Title</th><th style="padding:8px 12px;text-align:left;">Status</th><th style="padding:8px 12px;text-align:left;">🗓 Planned For</th><th style="padding:8px 12px;text-align:left;">📅 Deadline</th><th style="padding:8px 12px;text-align:left;">Priority</th><th style="padding:8px 12px;text-align:left;">Context</th><th style="padding:8px 12px;text-align:left;">Tags</th><th style="padding:8px 12px;text-align:left;">⏱ Timer</th><th style="padding:8px 12px;text-align:left;">Notes</th></tr></thead>';
        const tbody = document.createElement('tbody');
        groupTasks.forEach((tk, i) => {
          const _rowIdx = i + 1; // row number within this group (1-based)
          const tr = document.createElement('tr');
          tr.style.cssText = 'border-bottom:1px solid var(--color-border);cursor:pointer;transition:background 0.1s;';
          tr.addEventListener('mouseenter', () => { tr.style.background = 'var(--color-surface)'; });
          tr.addEventListener('mouseleave', () => { tr.style.background = 'transparent'; });
          const _dueLocal   = _isoToLocalDate(tk.dueDate); // BUG-6 fix: normalise to local YYYY-MM-DD first
          const _execLocal  = _isoToLocalDate(tk.executionDate) || null;
          const _todayLocal = _todayStr();
          const fmtLong = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', {year:'numeric',month:'long',day:'numeric'}) : '';
          const dueDisplay  = fmtLong(_dueLocal);
          const execDisplay = fmtLong(_execLocal);
          const ov = _dueLocal && _dueLocal < _todayLocal && tk.status !== 'Completed' && tk.status !== 'Done';
          const execOv = _execLocal && _execLocal < _todayLocal && tk.status !== 'Completed' && tk.status !== 'Done';
          const tags = Array.isArray(tk.tags) ? tk.tags.join(', ') : '';
          const bodyTxt = tk.details ? String(tk.details).replace(/<[^>]+>/g,' ').trim() : '';
          const wc = bodyTxt ? bodyTxt.split(/\s+/).length : 0;
          const execCell = _execLocal
            ? (execDisplay + (execOv ? ' <span style="color:var(--color-danger);font-size:var(--text-xs);">Overdue</span>' : (_execLocal === _todayLocal ? ' <span style="color:var(--color-warning-text,#b45309);font-size:var(--text-xs);">Today</span>' : '')))
            : '<span style="color:var(--color-text-muted);font-size:var(--text-xs);">—</span>';
          const dueCell = _dueLocal
            ? (dueDisplay + (ov ? ' <span style="color:var(--color-danger);font-size:var(--text-xs);">Overdue</span>' : (_dueLocal === _todayLocal ? ' <span style="color:var(--color-warning-text,#b45309);font-size:var(--text-xs);">Today</span>' : '')))
            : '<span style="color:var(--color-text-muted);font-size:var(--text-xs);">—</span>';
          tr.innerHTML = '<td style="padding:8px 12px;color:var(--color-text-muted);">' + _rowIdx + '</td><td style="padding:8px 12px;font-weight:var(--weight-semibold);">' + _esc(tk.title||'') + '</td><td style="padding:8px 12px;">' + _esc(tk.status||'') + '</td><td style="padding:8px 12px;">' + execCell + '</td><td style="padding:8px 12px;">' + dueCell + '</td><td style="padding:8px 12px;">' + _esc(tk.priority||'') + '</td><td style="padding:8px 12px;">' + _esc(tk.context||'') + '</td><td style="padding:8px 12px;">' + _esc(tags) + '</td><td class="kanban-table-timer-cell" style="padding:8px 12px;font-variant-numeric:tabular-nums;"></td><td style="padding:8px 12px;">\u270E ' + wc + ' words</td>';
          // Wire live timer badge into table cell
          const _timerTd = tr.querySelector('.kanban-table-timer-cell');
          if (_timerTd) {
            function _refreshTableTimer() {
              const _ts = getSession(tk.id);
              const _al = alarmedTaskIds.value.has(tk.id);
              if (!_ts && !_al) {
                _timerTd.textContent = tk.timeTracked > 0 ? formatDurationCompact(tk.timeTracked) : '—';
                _timerTd.style.color = 'var(--color-text-muted)';
                return;
              }
              if (_al) { _timerTd.innerHTML = '<span style="background:var(--color-danger);color:#fff;border-radius:var(--radius-full);padding:1px 6px;font-size:10px;">🔔 Done</span>'; return; }
              const _elapsed = getElapsed(_ts);
              const _isBlock = _ts.mode === 'block' && _ts.blockSecs;
              const _rem = _isBlock ? getRemaining(_ts) : null;
              const _txt = _isBlock ? ('⏲ ' + formatDurationCompact(_rem)) : ('⏱ ' + formatDurationCompact(_elapsed));
              const _col = (_isBlock && _rem <= 60) ? 'var(--color-danger)' : 'var(--color-accent)';
              _timerTd.innerHTML = '<span style="background:' + _col + ';color:#fff;border-radius:var(--radius-full);padding:1px 6px;font-size:10px;">' + _txt + '</span>';
            }
            _refreshTableTimer();
            _pushTimerUnsub( // KB-11 fix: store unsubscribes for cleanup on re-render
              on(TIMER_TICK,  (_d) => { if (_d.taskId === tk.id) _refreshTableTimer(); }),
              on(TIMER_ALARM, (_d) => { if (_d.taskId === tk.id) _refreshTableTimer(); })
            );
          }
          tr.addEventListener('click', () => emit(EVENTS.PANEL_OPENED, { entityType: tk._isInstance ? 'taskInstance' : 'task', entityId: tk.id })); // [P03 fix]
          tbody.appendChild(tr);
        });
        t.appendChild(tbody);
        wrap.appendChild(t);
        body.appendChild(wrap);
      }
    }
  }

  container.appendChild(body);
}

// ── Listen for entity saves to refresh board ──────────────── //

// [N07 fix] Debounced refresh — completeInstance emits ENTITY_SAVED twice (instance + template).
// Debounce coalesces them into one re-render.
let _kanbanRefreshTimer = null;
let _kanbanRefreshPending = false; // [P14 fix] prevent concurrent _loadData calls
function _scheduleKanbanRefresh() {
  clearTimeout(_kanbanRefreshTimer);
  _kanbanRefreshTimer = setTimeout(async () => {
    if (_kanbanRefreshPending) return; // already loading, skip
    const viewActive = document.getElementById('view-kanban')?.classList.contains('active');
    if (!viewActive) return;
    _kanbanRefreshPending = true;
    try {
      if (_viewMode === 'kanban') {
        await _loadData();
        _rerenderColumns();
      } else {
        await renderKanban({ _internal: true });
      }
    } catch (e) { console.error('[kanban] refresh error:', e); }
    finally { _kanbanRefreshPending = false; }
  }, 150); // [P14 fix] 150ms: enough for rapid ENTITY_SAVED + RECURRENCE_MATERIALIZED
}

on(EVENTS.ENTITY_SAVED, ({ entity, _streakUpdate } = {}) => {
  const KANBAN_REFRESH_TYPES = new Set(['task', 'person', 'project', 'taskInstance']); // [v5.3.1]
  if (entity && !KANBAN_REFRESH_TYPES.has(entity.type)) return;
  if (_streakUpdate) return; // [N07 fix] streak-only template update from completeInstance
  _scheduleKanbanRefresh();
});

on(EVENTS.ENTITY_DELETED, ({ entity } = {}) => {
  const entityType = entity?.type;
  if (entityType && !['task', 'person', 'project', 'taskInstance'].includes(entityType)) return; // [v5.3.1]
  const viewActive = document.getElementById('view-kanban')?.classList.contains('active');
  if (!viewActive) return;
  if (_viewMode === 'kanban') {
    _loadData().then(() => _rerenderColumns()).catch(() => {});
  } else {
    renderKanban({ _internal: true }).catch(() => {});
  }
});

// [P07 fix] RECURRENCE_MATERIALIZED: new ghost instances need to appear immediately
on(EVENTS.RECURRENCE_MATERIALIZED, () => {
  const viewActive = document.getElementById('view-kanban')?.classList.contains('active');
  if (!viewActive) return;
  _scheduleKanbanRefresh();
});

// [P16 fix] RECURRENCE_SERIES_STOPPED: remove template instances from board immediately
on(EVENTS.RECURRENCE_SERIES_STOPPED, () => {
  const viewActive = document.getElementById('view-kanban')?.classList.contains('active');
  if (!viewActive) return;
  _scheduleKanbanRefresh();
});

// BUG-D fix: close state dot popover and collapse any open dropdowns on navigation
on(EVENTS.VIEW_CHANGED, ({ viewKey } = {}) => {
  if (viewKey !== 'kanban') {
    if (_activeDotPopover) { _activeDotPopover.remove(); _activeDotPopover = null; }
    // Clean up any stale document click listeners from the view mode dropdown
    const viewEl = document.getElementById('view-kanban');
    if (viewEl?._vmListeners) {
      viewEl._vmListeners.forEach(fn => document.removeEventListener('click', fn));
      viewEl._vmListeners = [];
    }
  }
});

// [v5.1.0] REMINDER badge invalidation — refresh reminder map + re-render badges on REMINDER_* events
// Only re-renders when kanban view is active; lightweight: only rebuilds reminder map then patches badges.
const _REMINDER_REFRESH_EVTS = [
  EVENTS.REMINDER_CREATED, EVENTS.REMINDER_UPDATED,
  EVENTS.REMINDER_DISMISSED, EVENTS.REMINDER_PAUSED, EVENTS.REMINDER_RESUMED,
];
for (const evt of _REMINDER_REFRESH_EVTS) {
  on(evt, async () => {
    _reminderMapDirty = true; // [BUG-31 FIX] mark dirty so next _loadData rebuilds map
    if (!document.getElementById('view-kanban')?.classList.contains('active')) return;
    await _buildReminderMap();
    _reminderMapDirty = false;
    // Patch existing badge spans in DOM without full re-render (performance)
    document.querySelectorAll('.kanban-card[data-task-id]').forEach(card => {
      const tid   = card.dataset.taskId;
      const count = _taskReminderMap.get(tid) || 0;
      let badge   = card.querySelector('.kanban-card-reminder-badge');
      if (count > 0) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'kanban-card-reminder-badge';
          badge.style.cssText = 'font-size:0.7rem;padding:1px 5px;border-radius:10px;background:var(--color-accent-muted,#ede9fe);color:var(--color-accent,#4f8ef7);font-weight:600;white-space:nowrap;';
          card.querySelector('.kanban-card-meta')?.appendChild(badge);
        }
        badge.textContent = `🔔${count}`;
        badge.title = `${count} active reminder${count !== 1 ? 's' : ''}`;
      } else if (badge) {
        badge.remove();
      }
    });
  });
}

// ── Registration ──────────────────────────────────────────── //

// CS-04: Re-render board when context changes (only when kanban is the active view)
on('context:changed', () => {
  if (!document.getElementById('view-kanban')?.classList.contains('active')) return;
  if (_viewMode === 'kanban') {
    _loadData().then(() => _rerenderColumns()).catch(() => {});
  } else {
    renderKanban({ _internal: true }).catch(() => {});
  }
});

// KB-7 fix: sync in-memory view preferences when user changes them in Settings
window.addEventListener('fh:taskViewPrefChanged', (e) => {
  const { tabKey, viewMode } = e.detail || {};
  if (tabKey && viewMode) _defaultViewPerTab[tabKey] = viewMode;
});

registerView('kanban', renderKanban);

export { renderKanban };
