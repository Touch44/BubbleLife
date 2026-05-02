/**
 * FamilyHub v4.2 — views/kanban.js
 * 4-column Kanban board: Inbox · In Progress · Review · Done
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
import { getEntitiesByType, getEdgesFrom,
         getEntity, saveEntity }                 from '../core/db.js';
import { emit, on, EVENTS }                      from '../core/events.js';
// openEditForm no longer called directly — all clicks route through PANEL_OPENED (form-first)
import { getAccount }                            from '../core/auth.js';
import { filterByContext, getActiveContext }      from '../core/context.js';

// ── Constants ─────────────────────────────────────────────── //

const COLUMNS = [
  { key: 'Inbox',       label: 'Inbox',       color: 'var(--kanban-inbox)' },
  { key: 'In Progress', label: 'In Progress', color: 'var(--kanban-progress)' },
  { key: 'Review',      label: 'Review',      color: 'var(--kanban-review)' },
  { key: 'Done',        label: 'Done',        color: 'var(--kanban-done)' },
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

// Filter state
let _filterProject   = null;   // project ID or null
let _filterAssignees = new Set();
let _filterTags      = new Set();
let _filterPriority  = null;   // 'Critical' | 'High' | ... | null
let _filterOverdue   = false;

// ── Capacities-style view modes + filter tabs ─────────────── //
let _viewMode   = 'kanban';
let _filterTab  = 'status';

const _VIEW_MODES = [
  { key: 'list',    label: 'List',    icon: '\uD83D\uDCCB' },
  { key: 'wall',    label: 'Wall',    icon: '\uD83E\uDDE0' },
  { key: 'kanban',  label: 'Kanban',  icon: '\uD83D\uDCCA' },
  { key: 'gallery', label: 'Gallery', icon: '\uD83D\uDDBC\uFE0F' },
  { key: 'table',   label: 'Table',   icon: '\uD83D\uDDD3\uFE0F' },
  { key: 'embed',   label: 'Embed',   icon: '\uD83D\uDCCE' },
];

const _FILTER_TABS = [
  { key: 'inbox',     label: 'Inbox',     icon: '\uD83D\uDCEC' },
  { key: 'scheduled', label: 'Scheduled', icon: '\uD83D\uDCC5' },
  { key: 'today',     label: 'Today',     icon: '\u2600\uFE0F' },
  { key: 'status',    label: 'Status',    icon: '\uD83D\uDD04' },
  { key: 'context',   label: 'Context',   icon: '\uD83C\uDFF7\uFE0F' },
  { key: 'open',      label: 'Open',      icon: '\u25CB' },
  { key: 'completed', label: 'Completed', icon: '\u2705' },
  { key: 'all',       label: 'All',       icon: '\uD83D\uDDC2\uFE0F' },
];

// Sort state per column key
let _sortBy = {};  // { 'Inbox': 'deadline', ... }

// Drag state
let _dragTaskId = null;
let _dragEl     = null;
let _dragGhost  = null;
let _dropTarget = null;

// ── Data loading ──────────────────────────────────────────── //

async function _loadData() {
  const [tasks, persons, projects] = await Promise.all([
    getEntitiesByType('task'),
    getEntitiesByType('person'),
    getEntitiesByType('project'),
  ]);

  _tasks    = filterByContext(tasks.filter(t => !t.deleted));
  _persons  = persons;
  _projects = filterByContext(projects.filter(p => !p.deleted));

  _personMap  = new Map(persons.map(p  => [p.id, p]));
  _projectMap = new Map(projects.map(pr => [pr.id, pr]));

  // Build blocker map and edge-resolved relation maps
  await _buildBlockerMap();
  await _buildRelationEdgeMaps();
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

async function _buildBlockerMap() {
  _blockMap.clear();
  const doneSet   = new Set(['Done', 'done']);
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
  return tasks.filter(t => {
    if (_filterProject) {
      const resolvedProj = t.project || _taskProjectMap.get(t.id);
      if (resolvedProj !== _filterProject) return false;
    }
    if (_filterAssignees.size > 0) {
      const resolvedAssignee = t.assignedTo || _taskAssigneeMap.get(t.id);
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
      const due = t.dueDate ? t.dueDate.slice(0, 10) : null;
      if (!due || due >= today) return false;
    }
    return true;
  });
}

function _sortTasks(tasks, colKey) {
  const sortKey = _sortBy[colKey] || 'deadline';
  return [...tasks].sort((a, b) => {
    switch (sortKey) {
      case 'deadline': {
        const aDue = a.dueDate || '9999-99-99';
        const bDue = b.dueDate || '9999-99-99';
        return aDue.localeCompare(bDue);
      }
      case 'priority': {
        const ap = PRIORITY_ORDER[a.priority] ?? 99;
        const bp = PRIORITY_ORDER[b.priority] ?? 99;
        return ap - bp;
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

function _collectAllTags() {
  const tags = new Set();
  for (const t of _tasks) {
    if (Array.isArray(t.tags)) t.tags.forEach(tg => tags.add(tg));
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
  return [...ids].map(id => _personMap.get(id)).filter(Boolean);
}

// ── Filter tab logic ──────────────────────────────────────── //

function _applyFilterTab(tasks) {
  const today = _todayStr();
  switch (_filterTab) {
    case 'inbox':     return tasks.filter(t => t.status === 'Inbox' || !t.status);
    case 'scheduled': return tasks.filter(t => t.dueDate);
    case 'today':     return tasks.filter(t => t.dueDate && t.dueDate.slice(0,10) === today);
    case 'open':      return tasks.filter(t => t.status !== 'Done');
    case 'completed': return tasks.filter(t => t.status === 'Done');
    case 'status': case 'context': case 'all': default:
      return tasks;
  }
}

function _groupByStatus(tasks) {
  // Only include statuses that actually have tasks (no empty group clutter)
  const order = ['Inbox', 'In Progress', 'Review', 'Done'];
  const groups = new Map();
  for (const t of tasks) {
    const s = t.status || 'Inbox';
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(t);
  }
  // Sort by known order first, then alphabetical for custom statuses
  const sorted = new Map();
  for (const key of order) { if (groups.has(key)) sorted.set(key, groups.get(key)); }
  for (const [k, v] of groups) { if (!sorted.has(k)) sorted.set(k, v); }
  return sorted;
}

function _groupByContext(tasks) {
  const groups = new Map();
  for (const t of tasks) {
    const ctx = t.context || 'none';
    if (!groups.has(ctx)) groups.set(ctx, []);
    groups.get(ctx).push(t);
  }
  return groups;
}

// _todayStr() defined above

// ── DOM: Filter bar ───────────────────────────────────────── //

function _buildFilterBar(container) {
  const bar = document.createElement('div');
  bar.className = 'kanban-filter-bar';

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
    _rerenderColumns();
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
    _rerenderColumns();
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
        _rerenderColumns();
        av.classList.toggle('active');
      });
      assigneeWrap.appendChild(av);
    }
    bar.appendChild(assigneeWrap);
  }

  // Tag chips
  const allTags = _collectAllTags();
  if (allTags.length) {
    const tagWrap = document.createElement('div');
    tagWrap.className = 'kanban-filter-tags';
    for (const tag of allTags.slice(0, 8)) {
      const chip = document.createElement('button');
      chip.className = 'kanban-filter-tag' + (_filterTags.has(tag) ? ' active' : '');
      chip.textContent = tag;
      chip.addEventListener('click', () => {
        if (_filterTags.has(tag)) _filterTags.delete(tag);
        else _filterTags.add(tag);
        _rerenderColumns();
        chip.classList.toggle('active');
      });
      tagWrap.appendChild(chip);
    }
    bar.appendChild(tagWrap);
  }

  // Overdue toggle
  const overdueBtn = document.createElement('button');
  overdueBtn.className = 'btn btn-ghost btn-sm kanban-overdue-btn' + (_filterOverdue ? ' active' : '');
  overdueBtn.textContent = '⏰ Overdue';
  overdueBtn.addEventListener('click', () => {
    _filterOverdue = !_filterOverdue;
    overdueBtn.classList.toggle('active');
    _rerenderColumns();
  });
  bar.appendChild(overdueBtn);

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
    renderKanban({ _internal: true });
  });
  bar.appendChild(clearBtn);

  container.appendChild(bar);
}

// ── DOM: Columns ──────────────────────────────────────────── //

let _boardEl = null;

function _buildBoard(container) {
  _boardEl = document.createElement('div');
  _boardEl.className = 'kanban-board';
  container.appendChild(_boardEl);
  _rerenderColumns();
}

function _rerenderColumns() {
  if (!_boardEl) return;
  _boardEl.innerHTML = '';

  // Apply filter tab even in kanban mode (e.g. 'completed' → only Done column tasks)
  const _tabFiltered = _applyFilterTab(_tasks);
  const filtered = _applyFilters(_tabFiltered);

  // Show a friendly empty state banner when filters yield no results
  const anyFilter = _filterProject || _filterAssignees.size || _filterTags.size || _filterPriority || _filterOverdue;
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
      filtered.filter(t => t.status === col.key),
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
  const due   = task.dueDate ? task.dueDate.slice(0, 10) : null;
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

  // Due date
  const dueEl = due
    ? `<span class="kanban-card-due ${dueCls}">${_formatDue(due, today)}</span>`
    : '';

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
  const cl = Array.isArray(task.checklist) ? task.checklist : [];
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
  const kStateDot = `<button class="kanban-state-dot kanban-state-dot--${kState}"
    title="State: ${kState}" aria-label="Kanban state: ${kState}" data-state="${kState}"></button>`;

  card.innerHTML = `
    <div class="kanban-card-top">
      <label class="kanban-card-check-label">
        <input type="checkbox" class="kanban-card-checkbox" ${task.status === 'Done' ? 'checked' : ''} />
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
        ${dueEl}
        ${assigneeEl}
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
      emit(EVENTS.PANEL_OPENED, { entityType: 'task', entityId: task.id });
    });
  }
  card.addEventListener('click', (e) => {
    if (e.target.closest('.kanban-card-check-label')) return;
    if (e.target.closest('.kanban-card-title')) return; // title has its own handler
    emit(EVENTS.PANEL_OPENED, { entityType: 'task', entityId: task.id });
  });

  // ── Checkbox: toggle complete ──
  const cb = card.querySelector('.kanban-card-checkbox');
  cb.addEventListener('change', async (e) => {
    e.stopPropagation();
    const account = getAccount();
    // Revert to last non-Done status, not always 'Inbox'
    const revertStatus = (task.previousStatus && task.previousStatus !== 'Done')
      ? task.previousStatus
      : 'In Progress';
    const newStatus = cb.checked ? 'Done' : revertStatus;
    if (newStatus === 'Done') window._fhEnv?.services?.effects?.play('confetti');
    // Optimistic fade for Done tasks
    if (newStatus === 'Done') {
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
        previousStatus: newStatus === 'Done' ? freshTaskCb.status : freshTaskCb.previousStatus,
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

  // ── Drag start ──
  card.addEventListener('dragstart', (e) => {
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
  popover.style.top  = `${rect.bottom + window.scrollY + 4}px`;
  popover.style.left = `${Math.min(rect.left + window.scrollX, window.innerWidth - 140)}px`;

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

  const doAdd = async () => {
    const title = input.value.trim();
    if (!title) {
      inputWrap.style.display = 'none';
      addBtn.style.display = '';
      return;
    }
    const account = getAccount();
    try {
      const ctx = getActiveContext();
      await saveEntity({
        type:     'task',
        title,
        status:   statusKey,
        priority: 'Medium',
        context:  ctx === 'all' ? 'family' : ctx,
      }, account?.id);
      input.value = '';
      await _loadData();
      _rerenderColumns();
      // Animate the new card (last card in column gets slide-in class)
      const col = wrap.closest('.kanban-col');
      const newCard = col?.querySelector('.kanban-card:last-child');
      if (newCard) {
        newCard.classList.add('kanban-card-new');
        setTimeout(() => newCard.classList.remove('kanban-card-new'), 400);
      }
    } catch (err) {
      console.error('[kanban] Quick add failed:', err);
    }
    // Keep input open for rapid entry
    input.focus();
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
    // Small delay so Enter fires first
    setTimeout(() => {
      if (!input.value.trim()) {
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
    task = _tasks.find(t => t.id === taskId);
  }
  if (!task || task.status === newStatus) return;

  const account = getAccount();
  try {
    await saveEntity({
    ...task,
    status: newStatus,
    previousStatus: newStatus === 'Done' ? task.status : task.previousStatus,
  }, account?.id);
    await _loadData();
    _rerenderColumns();

    // P-12: play confetti when task moves to Done column
    if (newStatus === 'Done' || newStatus === 'done') {
      window._fhEnv?.services?.effects?.play('confetti');
    }
  } catch (err) {
    console.error('[kanban] Move task failed:', err);
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
      overflow: hidden;   /* board mode: columns scroll horizontally */
      padding: 0;
    }
    #view-kanban.active.alt-view {
      overflow-y: auto;   /* alt views: body scrolls vertically */
    }

    /* ── Filter Bar ─────────────────────────────────── */
    .kanban-filter-bar {
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
    .kanban-filter-tags {
      display: flex;
      gap: var(--space-1);
      flex-wrap: wrap;
    }
    .kanban-filter-tag {
      padding: 1px var(--space-2);
      border-radius: var(--radius-full);
      border: 1px solid var(--color-border);
      background: var(--color-bg);
      font-size: var(--text-xs);
      cursor: pointer;
      color: var(--color-text-muted);
      transition: all var(--transition-fast);
    }
    .kanban-filter-tag.active {
      background: var(--color-accent);
      border-color: var(--color-accent);
      color: #fff;
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
      position: absolute; z-index: 9999;
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

async function renderKanban(params = {}) {
  const viewEl = document.getElementById('view-kanban');
  if (!viewEl) return;

  _injectStyles();

  viewEl.innerHTML = '<div style="padding:var(--space-8);color:var(--color-text-muted);text-align:center;">Loading tasks\u2026</div>';

  if (params.filter === 'overdue') _filterOverdue = true;
  if (params.viewMode) _viewMode = params.viewMode;
  if (params.filterTab) _filterTab = params.filterTab;

  try {
    await _loadData();
    viewEl.innerHTML = '';

    // \u2500\u2500 Header: icon + title \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:var(--space-4) var(--space-5) 0;';
    header.innerHTML = '<div style="display:flex;align-items:center;gap:var(--space-3);"><span style="font-size:1.4rem;">\u2299</span><span style="font-size:var(--text-2xl);font-weight:var(--weight-bold);color:var(--color-text);">Tasks</span></div><div style="display:flex;align-items:center;gap:var(--space-2);"><span class="kanban-search-toggle" title="Search" style="cursor:pointer;font-size:1.1rem;">\uD83D\uDD0D</span><span class="kanban-collapse-toggle" title="Collapse" style="cursor:pointer;font-size:1.1rem;">\u2303</span></div>';
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
      btn.addEventListener('click', () => { _filterTab = tab.key; renderKanban({ _internal: true }); });
      tabBar.appendChild(btn);
    }
    viewEl.appendChild(tabBar);

    // \u2500\u2500 Controls row: count + view mode dropdown \u2500\u2500\u2500\u2500
    const filtered = _applyFilterTab(_applyFilters(_tasks));  // both filter-tab AND kanban bar filters
    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex;align-items:center;justify-content:flex-end;gap:var(--space-3);padding:var(--space-2) var(--space-5);';

    const countEl = document.createElement('span');
    countEl.style.cssText = 'font-size:var(--text-sm);color:var(--color-text-muted);font-weight:var(--weight-semibold);';
    countEl.textContent = '# ' + filtered.length + ' tasks';
    controls.appendChild(countEl);

    // View mode dropdown
    const vmWrap = document.createElement('div');
    vmWrap.style.cssText = 'position:relative;';
    const currentVm = _VIEW_MODES.find(v => v.key === _viewMode) || _VIEW_MODES.find(v => v.key === 'kanban') || _VIEW_MODES[0];
    const vmBtn = document.createElement('button');
    vmBtn.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-surface);cursor:pointer;font-size:var(--text-sm);color:var(--color-text);';
    vmBtn.type = 'button';
    vmBtn.innerHTML = currentVm.icon + ' \u25BE';

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
      item.addEventListener('click', () => { _viewMode = vm.key; vmDd.style.display = 'none'; renderKanban({ _internal: true }); });
      item.addEventListener('mouseenter', () => { item.style.background = 'var(--color-surface-2)'; });
      item.addEventListener('mouseleave', () => { item.style.background = _viewMode === vm.key ? 'var(--color-surface-2)' : 'transparent'; });
      vmDd.appendChild(item);
    }
    vmSearchInp.addEventListener('input', () => {
      const q = vmSearchInp.value.toLowerCase();
      vmDd.querySelectorAll('.kanban-vm-item').forEach(el => { el.style.display = el.textContent.toLowerCase().includes(q) ? '' : 'none'; });
    });
    vmBtn.addEventListener('click', (e) => { e.stopPropagation(); vmDd.style.display = vmDd.style.display === 'none' ? '' : 'none'; });
    // Store named ref on element so VIEW_CHANGED can clean it up (prevents listener accumulation)
    const _vmClickAway = (ev) => { if (!vmWrap.contains(ev.target)) vmDd.style.display = 'none'; };
    document.addEventListener('click', _vmClickAway);
    if (!viewEl._vmListeners) viewEl._vmListeners = [];
    viewEl._vmListeners.push(_vmClickAway);
    vmWrap.appendChild(vmBtn);
    vmWrap.appendChild(vmDd);
    controls.appendChild(vmWrap);
    viewEl.appendChild(controls);

    // \u2500\u2500 Render body based on view mode \u2500\u2500\u2500\u2500\u2500\u2500
    if (_viewMode === 'kanban') {
      viewEl.classList.remove('alt-view');
      _buildFilterBar(viewEl);
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
  const grouped = (_filterTab === 'context')
    ? _groupByContext(tasks)
    : _groupByStatus(tasks);

  const body = document.createElement('div');
  body.style.cssText = 'padding:0 var(--space-5) var(--space-5);';

  // BUG 13: Show empty state when no tasks
  if (tasks.length === 0) {
    body.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:var(--space-12) var(--space-6);gap:var(--space-3);color:var(--color-text-muted);text-align:center;"><div style="font-size:2.5rem;">\uD83C\uDF89</div><div style="font-size:var(--text-base);font-weight:var(--weight-semibold);color:var(--color-text);">No tasks here</div><div style="font-size:var(--text-sm);">Switch tabs or clear filters to see tasks.</div></div>';
    container.appendChild(body);
    return;
  }

  const _statusColors = { 'Inbox':'#6b7280','Not Started':'#f97316','Next Up':'#eab308','In Progress':'#3b82f6','Review':'#8b5cf6','Done':'#22c55e' };

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
        const cb = task.status === 'Done' ? '\u2705' : '\u25CB';
        const projId = task.project || _taskProjectMap.get(task.id) || '';
        const pName = projId ? (_projectMap.get(projId)?.name || '') : '';
        const due = task.dueDate ? task.dueDate.slice(0,10) : '';
        const overdue = due && due < _todayStr() && task.status !== 'Done';
        const expandChevron = isEmbed ? '<span style="font-size:var(--text-xs);color:var(--color-text-muted);flex-shrink:0;">\u25B6</span>' : '';
        row.innerHTML = expandChevron + '<span style="font-size:1rem;">' + cb + '</span><span style="flex:1;font-size:var(--text-sm);color:var(--color-text);">' + _esc(task.title || 'Untitled') + '</span>' + (due ? '<span style="font-size:var(--text-xs);color:' + (overdue ? 'var(--color-danger)' : 'var(--color-text-muted)') + ';">' + due + '</span>' : '') + (pName ? '<span style="font-size:var(--text-xs);color:var(--color-accent);background:var(--color-surface-2);padding:1px 8px;border-radius:var(--radius-full);">' + _esc(pName) + '</span>' : '');
        row.addEventListener('click', () => emit(EVENTS.PANEL_OPENED, { entityType: 'task', entityId: task.id }));
        body.appendChild(row);
      }
    } else if (_viewMode === 'wall' || _viewMode === 'gallery') {
      const grid = document.createElement('div');
      grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:var(--space-3);width:100%;';
      for (const task of groupTasks) {
        const card = document.createElement('div');
        card.style.cssText = 'flex:0 0 260px;border:1px solid var(--color-border);border-radius:var(--radius-lg);padding:var(--space-3);background:var(--color-surface);cursor:pointer;display:flex;flex-direction:column;gap:var(--space-1);transition:box-shadow 0.15s;';
        card.addEventListener('mouseenter', () => { card.style.boxShadow = 'var(--shadow-md)'; });
        card.addEventListener('mouseleave', () => { card.style.boxShadow = 'none'; });
        const cb = task.status === 'Done' ? '\u2705' : '\u25CB';
        const due = task.dueDate ? task.dueDate.slice(0,10) : '';
        const overdue = due && due < _todayStr() && task.status !== 'Done';
        const projId = task.project || _taskProjectMap.get(task.id) || '';
        const pName = projId ? (_projectMap.get(projId)?.name || '') : '';
        card.innerHTML = '<div style="font-size:var(--text-xs);color:var(--color-accent);font-weight:var(--weight-bold);">\u2299 Task</div><div style="display:flex;align-items:center;gap:6px;font-size:var(--text-sm);font-weight:var(--weight-semibold);color:var(--color-text);">' + cb + ' ' + _esc(task.title || 'Untitled') + '</div>' + (due ? '<div style="font-size:var(--text-xs);color:' + (overdue ? 'var(--color-danger)' : 'var(--color-text-muted)') + ';">' + due + ' \uD83D\uDCC5' + (overdue ? ' \u26A0' : '') + '</div>' : '') + (pName ? '<div style="font-size:var(--text-xs);color:var(--color-text-muted);">\uD83C\uDF10 ' + _esc(pName) + '</div>' : '');
        card.addEventListener('click', () => emit(EVENTS.PANEL_OPENED, { entityType: 'task', entityId: task.id }));
        grid.appendChild(card);
      }
      body.appendChild(grid);
    } else if (_viewMode === 'table') {
      if (groupTasks.length) {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'overflow-x:auto;border:1px solid var(--color-border);border-radius:var(--radius-lg);margin-bottom:var(--space-2);';
        const t = document.createElement('table');
        t.style.cssText = 'width:100%;border-collapse:collapse;font-size:var(--text-sm);min-width:700px;';
        t.innerHTML = '<thead><tr style="background:var(--color-surface);border-bottom:2px solid var(--color-border);"><th style="padding:8px 12px;text-align:left;font-weight:var(--weight-bold);font-size:var(--text-xs);color:var(--color-text-muted);"></th><th style="padding:8px 12px;text-align:left;">Title</th><th style="padding:8px 12px;text-align:left;">Status</th><th style="padding:8px 12px;text-align:left;">Date</th><th style="padding:8px 12px;text-align:left;">Priority</th><th style="padding:8px 12px;text-align:left;">Context</th><th style="padding:8px 12px;text-align:left;">Tags</th><th style="padding:8px 12px;text-align:left;">Notes</th></tr></thead>';
        const tbody = document.createElement('tbody');
        let _rowIdx = 0;
        groupTasks.forEach((tk, i) => {
          _rowIdx++;
          const tr = document.createElement('tr');
          tr.style.cssText = 'border-bottom:1px solid var(--color-border);cursor:pointer;transition:background 0.1s;';
          tr.addEventListener('mouseenter', () => { tr.style.background = 'var(--color-surface)'; });
          tr.addEventListener('mouseleave', () => { tr.style.background = 'transparent'; });
          const due = tk.dueDate ? new Date(tk.dueDate + 'T00:00:00').toLocaleDateString('en-US', {year:'numeric',month:'long',day:'numeric'}) : '';
          const ov = tk.dueDate && tk.dueDate.slice(0,10) < _todayStr() && tk.status !== 'Done';
          const tags = Array.isArray(tk.tags) ? tk.tags.join(', ') : '';
          const bodyTxt = tk.details ? String(tk.details).replace(/<[^>]+>/g,' ').trim() : '';
          const wc = bodyTxt ? bodyTxt.split(/\s+/).length : 0;
          tr.innerHTML = '<td style="padding:8px 12px;color:var(--color-text-muted);">' + _rowIdx + '</td><td style="padding:8px 12px;font-weight:var(--weight-semibold);">' + _esc(tk.title||'') + '</td><td style="padding:8px 12px;">' + _esc(tk.status||'') + '</td><td style="padding:8px 12px;">' + due + (ov ? ' <span style="color:var(--color-danger);font-size:var(--text-xs);">Overdue</span>' : '') + '</td><td style="padding:8px 12px;">' + _esc(tk.priority||'') + '</td><td style="padding:8px 12px;">' + _esc(tk.context||'') + '</td><td style="padding:8px 12px;">' + _esc(tags) + '</td><td style="padding:8px 12px;">\u270E ' + wc + ' words</td>';
          tr.addEventListener('click', () => emit(EVENTS.PANEL_OPENED, { entityType: 'task', entityId: tk.id }));
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

on(EVENTS.ENTITY_SAVED, ({ entity } = {}) => {
  const KANBAN_REFRESH_TYPES = new Set(['task', 'person', 'project']);
  if (entity && !KANBAN_REFRESH_TYPES.has(entity.type)) return;
  const viewActive = document.getElementById('view-kanban')?.classList.contains('active');
  if (!viewActive) return;
  if (_viewMode === 'kanban') {
    _loadData().then(() => _rerenderColumns()).catch(() => {});
  } else {
    renderKanban({ _internal: true }).catch(() => {});
  }
});

on(EVENTS.ENTITY_DELETED, ({ entity } = {}) => {
  const entityType = entity?.type;
  if (entityType && !['task', 'person', 'project'].includes(entityType)) return;
  const viewActive = document.getElementById('view-kanban')?.classList.contains('active');
  if (!viewActive) return;
  if (_viewMode === 'kanban') {
    _loadData().then(() => _rerenderColumns()).catch(() => {});
  } else {
    renderKanban({ _internal: true }).catch(() => {});
  }
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

registerView('kanban', renderKanban);

export { renderKanban };
