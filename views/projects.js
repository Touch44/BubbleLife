/**
 * FamilyHub v3 — views/projects.js
 * [MAJOR] V-02 — Projects View — Project cards + task breakdown
 *
 * Features:
 *   - Status filter tabs: All | Active | On Hold | Complete | Archived
 *   - Project cards in grid: name, status badge, goal preview, deadline,
 *     member avatar stack, task progress bar, "+ Add Task" chip
 *   - Task-to-project linking via task.project field
 *   - Click card → entity panel
 *   - "+ New Project" → openForm
 *
 * Registration: registerView('projects', renderProjects)
 */

import { registerView } from '../core/router.js';
import { getEntitiesByType } from '../core/db.js';
import { emit, on, EVENTS } from '../core/events.js';
import { filterByContext, getActiveContext } from '../core/context.js';
import { openForm } from '../components/entity-form.js';

// ── Module state ───────────────────────────────────────────────
let _projects = [];
let _tasks = [];
let _persons = [];
let _personMap = new Map();
let _activeFilter = 'All';

const STATUS_COLORS = {
  Active:   'var(--color-accent)',
  'On Hold': '#d97706',
  Complete: '#16a34a',
  Archived: '#6b7280',
};

const FILTER_OPTIONS = ['All', 'Active', 'On Hold', 'Complete', 'Archived'];

// ── Inject CSS once to reset .view padding for this full-bleed view ──────────
(function _injectStyles() {
  if (document.getElementById('projects-view-styles')) return;
  const style = document.createElement('style');
  style.id = 'projects-view-styles';
  style.textContent = `
    #view-projects.active { padding: 0; }
  `;
  document.head.appendChild(style);
})();

// ── Helpers ────────────────────────────────────────────────────
function _esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function _getInitials(name) {
  return (name || '?').split(/\s+/).map(w => w[0]?.toUpperCase() || '').join('').slice(0, 2);
}

function _isOverdue(dateStr) {
  if (!dateStr) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(dateStr + 'T00:00:00');
  return d < today;
}

// ── Data Loading ───────────────────────────────────────────────
async function _loadData() {
  const [projects, tasks, persons] = await Promise.all([
    getEntitiesByType('project'),
    getEntitiesByType('task'),
    getEntitiesByType('person'),
  ]);
  _projects = filterByContext(projects.filter(p => !p.deleted));
  _tasks    = filterByContext(tasks.filter(t => !t.deleted));
  _persons  = persons;
  _personMap = new Map(persons.map(p => [p.id, p]));
}

function _getProjectTasks(projectId) {
  return _tasks.filter(t => t.project === projectId);
}

// ── Main Render ────────────────────────────────────────────────
async function renderProjects(params = {}) {
  const el = document.getElementById('view-projects');
  if (!el) return;

  // Only reload from IDB on fresh navigation — not on internal filter/context re-renders
  if (!params._internal) {
    try {
      await _loadData();
    } catch (err) {
      console.error('[projects] _loadData failed:', err);
      el.innerHTML = `<div style="padding:var(--space-6);color:var(--color-text-muted);text-align:center;">Failed to load projects. Please try again.</div>`;
      return;
    }
  }

  el.innerHTML = '';

  // ── Compute filtered count early so header count is accurate ──
  const _filteredCount = _activeFilter === 'All'
    ? _projects.length
    : _projects.filter(p => p.status === _activeFilter).length;
  const _countLabel = _activeFilter === 'All'
    ? `${_projects.length}`
    : `${_filteredCount} of ${_projects.length}`;

  // ── Header ──────────────────────────────────────────────────
  const header = document.createElement('div');
  header.style.cssText = `
    padding:var(--space-4) var(--space-5);display:flex;align-items:center;justify-content:space-between;
    border-bottom:1px solid var(--color-border);
  `;
  header.innerHTML = `
    <div style="display:flex;align-items:center;gap:var(--space-2);">
      <span style="font-size:1.3em;">📁</span>
      <span style="font-weight:var(--weight-bold);font-size:var(--text-lg);color:var(--color-text);">Projects</span>
      <span style="font-size:var(--text-sm);color:var(--color-text-muted);">(${_countLabel})</span>
    </div>
  `;
  const newBtn = document.createElement('button');
  newBtn.textContent = '+ New Project';
  newBtn.style.cssText = `
    padding:6px 14px;font-size:var(--text-sm);font-weight:var(--weight-semibold);
    background:var(--color-accent);color:#fff;border:none;border-radius:var(--radius-md);cursor:pointer;
  `;
  newBtn.addEventListener('click', () => {
    const ctx = getActiveContext();
    openForm('project', { context: ctx === 'all' ? 'family' : ctx });
  });
  header.appendChild(newBtn);
  el.appendChild(header);

  // ── Filter Tabs ─────────────────────────────────────────────
  const filterBar = document.createElement('div');
  filterBar.style.cssText = `
    padding:var(--space-3) var(--space-5);display:flex;gap:var(--space-2);flex-wrap:wrap;
    border-bottom:1px solid var(--color-border);
  `;
  for (const f of FILTER_OPTIONS) {
    const btn = document.createElement('button');
    btn.textContent = f;
    const isActive = _activeFilter === f;
    btn.style.cssText = `
      padding:4px 12px;font-size:var(--text-xs);font-weight:var(--weight-semibold);
      border-radius:var(--radius-full);cursor:pointer;border:1px solid var(--color-border);
      background:${isActive ? 'var(--color-accent)' : 'var(--color-surface)'};
      color:${isActive ? '#fff' : 'var(--color-text)'};
      transition:all 0.12s;
    `;
    btn.addEventListener('click', () => {
      _activeFilter = f;
      renderProjects({ _internal: true });
    });
    filterBar.appendChild(btn);
  }
  el.appendChild(filterBar);

  // Filter projects
  let filtered = _projects;
  if (_activeFilter !== 'All') {
    filtered = _projects.filter(p => p.status === _activeFilter);
  }

  // Sort: Active first, then by deadline ascending
  const STATUS_SORT = { Active: 0, 'On Hold': 1, Complete: 2, Archived: 3 };
  filtered.sort((a, b) => {
    const sa = STATUS_SORT[a.status] ?? 9;
    const sb = STATUS_SORT[b.status] ?? 9;
    if (sa !== sb) return sa - sb;
    const da = a.deadline || 'zzzz';
    const db = b.deadline || 'zzzz';
    return da.localeCompare(db);
  });

  // ── Empty State ─────────────────────────────────────────────
  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = `
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      min-height:40vh;color:var(--color-text-muted);text-align:center;padding:var(--space-6);
    `;
    empty.innerHTML = `
      <div style="font-size:2.5rem;margin-bottom:var(--space-3);opacity:0.3;">📁</div>
      <div style="font-size:var(--text-base);font-weight:var(--weight-semibold);color:var(--color-text);">
        ${_activeFilter === 'All' ? 'No projects yet' : `No ${_activeFilter.toLowerCase()} projects`}
      </div>
      <div style="font-size:var(--text-sm);margin-top:var(--space-1);">Click "+ New Project" to get started.</div>
    `;
    el.appendChild(empty);
    return;
  }

  // ── Grid of Project Cards ───────────────────────────────────
  const grid = document.createElement('div');
  grid.style.cssText = `
    display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:var(--space-4);
    padding:var(--space-5);
  `;

  for (const project of filtered) {
    const projTasks = _getProjectTasks(project.id);
    const doneTasks = projTasks.filter(t => t.status === 'Done' || t.status === 'done');
    const progress = projTasks.length > 0 ? Math.round((doneTasks.length / projTasks.length) * 100) : 0;

    const statusColor = STATUS_COLORS[project.status] || '#6b7280';
    const deadlineOverdue = _isOverdue(project.deadline);

    // Member avatars
    const members = Array.isArray(project.members) ? project.members : [];
    const avatarHtml = members.slice(0, 4).map(memberId => {
      const person = _personMap.get(memberId);
      const initials = _getInitials(person?.name || person?.title);
      return `<div style="width:24px;height:24px;border-radius:50%;background:var(--color-accent);color:#fff;
        display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:var(--weight-bold);
        border:2px solid var(--color-bg);margin-left:-6px;">${initials}</div>`;
    }).join('');
    const extraMembers = members.length > 4 ? `<span style="font-size:10px;color:var(--color-text-muted);margin-left:4px;">+${members.length - 4}</span>` : '';

    const card = document.createElement('div');
    card.style.cssText = `
      padding:var(--space-4);background:var(--color-bg);border:1px solid var(--color-border);
      border-radius:var(--radius-lg);cursor:pointer;transition:box-shadow 0.15s,border-color 0.15s;
      display:flex;flex-direction:column;gap:var(--space-3);
    `;
    card.addEventListener('mouseenter', () => { card.style.borderColor = 'var(--color-accent)'; });
    card.addEventListener('mouseleave', () => { card.style.borderColor = 'var(--color-border)'; });

    card.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:var(--space-2);">
        <div style="font-weight:var(--weight-bold);font-size:var(--text-sm);color:var(--color-text);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
          ${_esc(project.name || project.title || 'Untitled')}
        </div>
        <span style="padding:2px 8px;border-radius:var(--radius-full);font-size:10px;font-weight:var(--weight-bold);
          background:${statusColor}22;color:${statusColor};white-space:nowrap;">
          ${_esc(project.status || 'Active')}
        </span>
      </div>

      ${project.goal ? `<div style="font-size:var(--text-xs);color:var(--color-text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(project.goal)}</div>` : ''}

      ${project.deadline ? `
        <div style="font-size:var(--text-xs);color:${deadlineOverdue ? 'var(--color-danger,#dc2626)' : 'var(--color-text-muted)'};">
          ${deadlineOverdue ? '⚠ Overdue: ' : '📅 '}${_esc(project.deadline)}
        </div>
      ` : ''}

      <div style="display:flex;align-items:center;gap:var(--space-2);">
        <div style="display:flex;align-items:center;padding-left:6px;">${avatarHtml}${extraMembers}</div>
      </div>

      <div>
        <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--color-text-muted);margin-bottom:4px;">
          <span>Tasks: ${doneTasks.length}/${projTasks.length}</span>
          <span>${progress}%</span>
        </div>
        <div style="height:6px;background:var(--color-surface);border-radius:3px;overflow:hidden;">
          <div style="height:100%;width:${progress}%;background:var(--color-accent);border-radius:3px;transition:width 0.3s;"></div>
        </div>
      </div>

      <div style="display:flex;gap:var(--space-2);margin-top:auto;">
        <button class="proj-add-task-btn" data-project-id="${_esc(project.id)}" data-project-name="${_esc(project.name || project.title || '')}"
          style="padding:3px 10px;font-size:10px;font-weight:var(--weight-semibold);background:var(--color-surface);
          color:var(--color-text-muted);border:1px solid var(--color-border);border-radius:var(--radius-full);cursor:pointer;">
          + Add Task
        </button>
      </div>
    `;

    // Click card → panel
    card.addEventListener('click', (e) => {
      if (e.target.closest('.proj-add-task-btn')) return;
      emit(EVENTS.PANEL_OPENED, { entityId: project.id });
    });

    // "+ Add Task" button
    const addTaskBtn = card.querySelector('.proj-add-task-btn');
    if (addTaskBtn) {
      addTaskBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const ctx = getActiveContext();
        openForm('task', {
          project: project.id,
          projectTitle: project.name || project.title,
          context: ctx === 'all' ? 'family' : ctx,
        });
      });
    }

    grid.appendChild(card);
  }

  el.appendChild(grid);
}

// ── Module-level listeners ─────────────────────────────────────
on(EVENTS.ENTITY_SAVED, ({ entity } = {}) => {
  if ((entity?.type === 'project' || entity?.type === 'task') &&
      document.getElementById('view-projects')?.classList.contains('active')) {
    // Full reload — entity data has changed
    renderProjects();
  }
});

on(EVENTS.ENTITY_DELETED, () => {
  if (document.getElementById('view-projects')?.classList.contains('active')) {
    renderProjects();
  }
});

on('context:changed', () => {
  if (document.getElementById('view-projects')?.classList.contains('active')) {
    // Full reload — context changes what data is visible
    renderProjects();
  }
});

// ── Registration ───────────────────────────────────────────────
registerView('projects', renderProjects);

export { renderProjects };
