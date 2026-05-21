/**
 * FamilyHub v5.6.0 — views/projects.js
 * [MAJOR] V-02 — Projects View — Full Blueprint Implementation
 *
 * Features:
 *   - Status filter tabs: All | Active | On Hold | Complete | Archived
 *   - Project cards in grid: name, status badge, goal preview, deadline,
 *     member avatar stack, task progress bar, "+ Add Task" chip
 *   - Task-to-project linking via dual-path lookup (direct field + graph edge)
 *   - Click card → entity panel; "+ New Project" → openForm
 *   - [F1] Project Health Score — computed 0-100 ring (green/amber/red)
 *   - [F2] Project Template Library — 6 built-in + user-saved templates
 *   - [F3] Project Focus Mode — sessionStorage pin, cross-view filter
 *   - [F4] Weekly Digest & Stall Detection — auto-rules integration
 *   - [F5] Project Timeline View — canvas Gantt, Grid|Timeline toggle
 *   - [F6] Smart Task Prioritisation — "What's next?" graph-ranked popover
 *
 * Registration: registerView('projects', renderProjects)
 */

import { registerView } from '../core/router.js';
import { getEntitiesByType, getEdgesTo, getEdgesFrom, saveEntity } from '../core/db.js';
import { emit, on, EVENTS } from '../core/events.js';
import { filterByContext, getActiveContext } from '../core/context.js';
import { openForm } from '../components/entity-form.js';
import { getAccount } from '../core/auth.js';

// ── Inject CSS once — reset .view padding for full-bleed layout ──────────────
(function _injectStyles() {
  if (document.getElementById('projects-view-styles')) return;
  const style = document.createElement('style');
  style.id = 'projects-view-styles';
  style.textContent = `
    #view-projects.active { padding: 0; }
  `;
  document.head.appendChild(style);
})();

// ── Module state ───────────────────────────────────────────────
let _projects = [];
let _tasks    = [];
let _persons  = [];
let _personMap  = new Map();
let _activeFilter = 'All';
let _viewMode = 'grid'; // 'grid' | 'timeline'
let _projectTaskEdgeMap   = new Map(); // projectId → Set<taskId>
let _projectMemberEdgeMap = new Map(); // projectId → [personId, ...]
let _listenersRegistered  = false;

// ── [F3] Focus Mode ────────────────────────────────────────────
const FOCUS_KEY = 'fh_focusProjectId';

export function getFocusProjectId() { return sessionStorage.getItem(FOCUS_KEY) || null; }
export function setFocusProject(id) {
  if (id) sessionStorage.setItem(FOCUS_KEY, id);
  else sessionStorage.removeItem(FOCUS_KEY);
  _renderFocusBanner();
  emit('projects:focusChanged', { id }); // dedicated event — doesn't pollute ENTITY_SAVED
}
export function clearFocusProject() { setFocusProject(null); }

function _renderFocusBanner() {
  let banner = document.getElementById('focus-mode-banner');
  const focusId = getFocusProjectId();
  if (!focusId) {
    if (banner) banner.remove();
    _applyBannerOffset(false);
    return;
  }
  const proj = _projects.find(p => p.id === focusId);
  const name = proj ? (proj.name || proj.title || 'Project') : 'Project…';
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'focus-mode-banner';
    banner.style.cssText = `
      position:fixed;top:0;left:0;right:0;z-index:450;
      background:var(--color-accent);color:#fff;
      padding:6px 16px;display:flex;align-items:center;gap:10px;
      font-size:var(--text-sm);font-weight:var(--weight-semibold);
      box-shadow:0 2px 8px rgba(0,0,0,0.2);
    `;
    document.body.appendChild(banner);
    // push app content down
    _applyBannerOffset(true);
  }
  banner.innerHTML = `
    <span>🎯</span>
    <span>Focus Mode: <strong>${_esc(name)}</strong></span>
    <span style="margin-left:auto;opacity:0.8;font-size:var(--text-xs);">All views filtered to this project</span>
    <button id="focus-exit-btn" style="
      background:rgba(255,255,255,0.2);border:none;color:#fff;cursor:pointer;
      padding:2px 10px;border-radius:var(--radius-full);font-size:var(--text-xs);font-weight:var(--weight-bold);">
      ✕ Exit Focus
    </button>
  `;
  banner.querySelector('#focus-exit-btn').addEventListener('click', () => clearFocusProject());
}

function _applyBannerOffset(show) {
  // Focus banner sits at top:0 above the topbar. Offset the topbar and main grid down.
  const topbar = document.getElementById('topbar');
  const appEl  = document.getElementById('app');
  const OFFSET = '36px';
  if (topbar) topbar.style.marginTop = show ? OFFSET : '';
  if (appEl)  appEl.style.marginTop  = show ? OFFSET : '';
}

// ── [F1] Health Score ──────────────────────────────────────────
function _computeHealthScore(project, projTasks) {
  let score = 0;

  // Signal 1: Goal field set (10 pts)
  if (project.goal && project.goal.trim()) score += 10;

  // Signal 2: Recent activity — any task saved in last 14 days (10 pts)
  const now = Date.now();
  const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1000;
  const hasRecentActivity = projTasks.some(t => {
    const updated = t.updatedAt ? new Date(t.updatedAt).getTime() : 0;
    return (now - updated) < FOURTEEN_DAYS;
  });
  if (hasRecentActivity) score += 10;

  // Signal 3: Progress velocity (30 pts) — has progress moved in last 7 days?
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  const snapRaw = project._lastProgressSnapshot;
  const snapTs  = project._lastProgressSnapshotAt;
  const doneTasks = projTasks.filter(t => _isTaskDone(t));
  const currentPct = projTasks.length > 0 ? Math.round((doneTasks.length / projTasks.length) * 100) : 0;

  if (snapRaw != null && snapTs && (now - new Date(snapTs).getTime()) < SEVEN_DAYS) {
    if (currentPct > snapRaw) score += 30;       // progress advanced this week
    else if (currentPct === 100) score += 25;    // complete — max velocity credit
    else if (projTasks.length === 0) score += 15; // no tasks yet — partial credit
    else score += 8;                              // maintained (not stalled, not advanced)
  } else if (projTasks.length === 0) {
    score += 15; // new project with no tasks — partial credit
  } else if (currentPct === 100) {
    score += 25; // complete with no recent snapshot
  } else {
    score += 0; // genuinely stalled
  }

  // Signal 4: Deadline proximity (25 pts)
  if (!project.deadline) {
    score += 12; // no deadline — neutral
  } else {
    const deadline = new Date(project.deadline + 'T00:00:00');
    const created  = project.createdAt ? new Date(project.createdAt) : new Date(now - 30 * 24 * 60 * 60 * 1000);
    const totalDur = Math.max(deadline - created, 1);
    const remaining = deadline - now;
    const pctRemaining = remaining / totalDur;
    if (remaining < 0) score += 0;          // overdue
    else if (pctRemaining > 0.5) score += 25; // lots of time
    else if (pctRemaining > 0.25) score += 15;
    else if (pctRemaining > 0.1)  score += 8;
    else score += 3;
  }

  // Signal 5: Overdue task ratio (25 pts)
  const today = new Date(); today.setHours(0,0,0,0);
  const overdueCount = projTasks.filter(t => {
    if (_isTaskDone(t)) return false;
    if (!t.dueDate) return false;
    return new Date(t.dueDate + 'T00:00:00') < today;
  }).length;
  const overdueRatio = projTasks.length > 0 ? overdueCount / projTasks.length : 0;
  if (overdueRatio === 0) score += 25;
  else if (overdueRatio < 0.1) score += 20;
  else if (overdueRatio < 0.25) score += 12;
  else if (overdueRatio < 0.5)  score += 5;
  else score += 0;

  return Math.min(100, Math.max(0, score));
}

function _healthColor(score) {
  if (score >= 70) return '#16a34a'; // green
  if (score >= 40) return '#d97706'; // amber
  return '#dc2626'; // red
}

function _healthLabel(score) {
  if (score >= 70) return 'Healthy';
  if (score >= 40) return 'At Risk';
  return 'Critical';
}

function _healthRingSvg(score) {
  const color = _healthColor(score);
  const r = 14; const circ = 2 * Math.PI * r;
  const dash = (score / 100) * circ;
  return `<svg width="36" height="36" viewBox="0 0 36 36" style="transform:rotate(-90deg)">
    <circle cx="18" cy="18" r="${r}" fill="none" stroke="var(--color-surface)" stroke-width="3"/>
    <circle cx="18" cy="18" r="${r}" fill="none" stroke="${color}" stroke-width="3"
      stroke-dasharray="${dash.toFixed(1)} ${(circ - dash).toFixed(1)}"
      stroke-linecap="round"/>
    <text x="18" y="22" text-anchor="middle" fill="${color}"
      font-size="9" font-weight="bold" transform="rotate(90,18,18)">
      ${score}
    </text>
  </svg>`;
}

// ── [F2] Template Library ──────────────────────────────────────
const BUILT_IN_TEMPLATES = [
  {
    id: 'tpl-renovation', name: '🏠 Home Renovation', goal: 'Complete renovation on time and within budget',
    tasks: [
      { title: 'Define scope and get contractor quotes', daysOffset: -90, priority: 'High' },
      { title: 'Permits approved', daysOffset: -75, priority: 'High' },
      { title: 'Demolition complete', daysOffset: -60, priority: 'Medium' },
      { title: 'Rough work (plumbing/electrical)', daysOffset: -45, priority: 'High' },
      { title: 'Drywall and finishes', daysOffset: -30, priority: 'Medium' },
      { title: 'Fixtures and hardware installed', daysOffset: -14, priority: 'Medium' },
      { title: 'Final inspection passed', daysOffset: -7, priority: 'High' },
      { title: 'Punch list complete', daysOffset: -3, priority: 'Low' },
      { title: 'Final payment made', daysOffset: 0, priority: 'High' },
      { title: 'Document warranties and manuals', daysOffset: 0, priority: 'Low' },
      { title: 'Photographer scheduled', daysOffset: 0, priority: 'Low' },
      { title: 'Celebration!', daysOffset: 0, priority: 'Low' },
    ]
  },
  {
    id: 'tpl-vacation', name: '✈️ Family Vacation', goal: 'Plan and execute a great trip on time and on budget',
    tasks: [
      { title: 'Choose destination and dates', daysOffset: -90, priority: 'High' },
      { title: 'Book flights', daysOffset: -80, priority: 'High' },
      { title: 'Book accommodation', daysOffset: -75, priority: 'High' },
      { title: 'Apply for visas (if needed)', daysOffset: -60, priority: 'High' },
      { title: 'Research activities and restaurants', daysOffset: -30, priority: 'Medium' },
      { title: 'Book activities and tours', daysOffset: -21, priority: 'Medium' },
      { title: 'Arrange travel insurance', daysOffset: -21, priority: 'Medium' },
      { title: 'Pack list finalised', daysOffset: -7, priority: 'Low' },
      { title: 'Check passport expiry dates', daysOffset: -7, priority: 'High' },
      { title: 'Pack bags', daysOffset: -1, priority: 'Medium' },
    ]
  },
  {
    id: 'tpl-event', name: '🎉 Event Planning', goal: 'Host a memorable event on the target date',
    tasks: [
      { title: 'Set date and guest count', daysOffset: -60, priority: 'High' },
      { title: 'Book venue', daysOffset: -45, priority: 'High' },
      { title: 'Arrange catering / menu', daysOffset: -30, priority: 'High' },
      { title: 'Send invitations', daysOffset: -21, priority: 'High' },
      { title: 'Arrange decorations and flowers', daysOffset: -14, priority: 'Medium' },
      { title: 'Confirm RSVPs', daysOffset: -7, priority: 'Medium' },
      { title: 'Final headcount to caterer', daysOffset: -3, priority: 'High' },
      { title: 'Event setup', daysOffset: 0, priority: 'High' },
    ]
  },
  {
    id: 'tpl-moving', name: '📦 Moving House', goal: 'Complete the move and be settled by the deadline',
    tasks: [
      { title: 'Sign lease / contracts', daysOffset: -60, priority: 'High' },
      { title: 'Hire removalist / truck', daysOffset: -45, priority: 'High' },
      { title: 'Notify utilities — old address', daysOffset: -30, priority: 'High' },
      { title: 'Set up utilities — new address', daysOffset: -21, priority: 'High' },
      { title: 'Pack non-essentials', daysOffset: -14, priority: 'Medium' },
      { title: 'Redirect mail', daysOffset: -14, priority: 'Medium' },
      { title: 'Moving day — load', daysOffset: -1, priority: 'High' },
      { title: 'Moving day — unload', daysOffset: 0, priority: 'High' },
      { title: 'Update address — bank, govt, insurance', daysOffset: 0, priority: 'High' },
      { title: 'Return keys to old address', daysOffset: 0, priority: 'High' },
      { title: 'Unpack essentials', daysOffset: 0, priority: 'Medium' },
      { title: 'Final clean of old property', daysOffset: 0, priority: 'Medium' },
      { title: 'Settle in and celebrate!', daysOffset: 0, priority: 'Low' },
      { title: 'Bond / deposit recovered', daysOffset: 7, priority: 'High' },
      { title: 'All boxes unpacked', daysOffset: 14, priority: 'Low' },
    ]
  },
  {
    id: 'tpl-financial', name: '💰 Financial Goal', goal: 'Reach the savings or financial milestone by the deadline',
    tasks: [
      { title: 'Set savings target and deadline', daysOffset: -90, priority: 'High' },
      { title: 'Review current budget', daysOffset: -85, priority: 'High' },
      { title: 'Set up automatic transfer', daysOffset: -80, priority: 'High' },
      { title: '25% milestone reached', daysOffset: -60, priority: 'Medium' },
      { title: '50% milestone reached', daysOffset: -30, priority: 'Medium' },
      { title: '75% milestone reached', daysOffset: -14, priority: 'Medium' },
      { title: 'Goal achieved!', daysOffset: 0, priority: 'High' },
    ]
  },
  {
    id: 'tpl-learning', name: '🎓 Learning Goal', goal: 'Reach the target skill level or certification by the deadline',
    tasks: [
      { title: 'Define learning goal and resources', daysOffset: -90, priority: 'High' },
      { title: 'Set up study schedule', daysOffset: -85, priority: 'High' },
      { title: 'Complete beginner module', daysOffset: -60, priority: 'Medium' },
      { title: 'Complete intermediate module', daysOffset: -30, priority: 'Medium' },
      { title: 'Practice project / portfolio piece', daysOffset: -14, priority: 'Medium' },
      { title: 'Certification exam / assessment', daysOffset: 0, priority: 'High' },
    ]
  },
];

async function _openTemplateModal() {
  let userTemplates = [];
  try {
    const all = await getEntitiesByType('projectTemplate');
    userTemplates = all.filter(t => !t.deleted);
  } catch { /* no user templates yet */ }

  const all = [...BUILT_IN_TEMPLATES, ...userTemplates];

  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:3000;background:rgba(0,0,0,0.5);
    display:flex;align-items:center;justify-content:center;padding:var(--space-4);
  `;
  overlay.innerHTML = `
    <div style="background:var(--color-bg);border-radius:var(--radius-lg);max-width:560px;width:100%;
      max-height:80vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:var(--shadow-lg);">
      <div style="padding:var(--space-4) var(--space-5);border-bottom:1px solid var(--color-border);
        display:flex;align-items:center;justify-content:space-between;">
        <span style="font-weight:var(--weight-bold);font-size:var(--text-base);">📋 Choose a Template</span>
        <button id="tpl-close" style="background:none;border:none;cursor:pointer;font-size:1.2em;color:var(--color-text-muted);">✕</button>
      </div>
      <div style="overflow-y:auto;padding:var(--space-4);">
        <div style="display:flex;flex-direction:column;gap:var(--space-2);" id="tpl-list">
          ${all.map(t => `
            <button class="tpl-item" data-tpl-id="${_esc(t.id)}" style="
              display:flex;align-items:center;gap:var(--space-3);padding:var(--space-3) var(--space-4);
              background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-md);
              cursor:pointer;text-align:left;transition:border-color 0.12s;">
              <div style="flex:1;">
                <div style="font-weight:var(--weight-semibold);font-size:var(--text-sm);">${_esc(t.name)}</div>
                <div style="font-size:var(--text-xs);color:var(--color-text-muted);margin-top:2px;">
                  ${t.tasks ? `${t.tasks.length} tasks` : ''} ${t.goal ? '· ' + _esc(t.goal.substring(0, 60)) + (t.goal.length > 60 ? '…' : '') : ''}
                </div>
              </div>
              <span style="color:var(--color-text-muted);font-size:var(--text-xs);">→</span>
            </button>
          `).join('')}
        </div>
        <div style="margin-top:var(--space-3);padding-top:var(--space-3);border-top:1px solid var(--color-border);">
          <button id="tpl-blank" style="
            width:100%;padding:var(--space-3) var(--space-4);
            background:none;border:1px dashed var(--color-border);border-radius:var(--radius-md);
            cursor:pointer;color:var(--color-text-muted);font-size:var(--text-sm);">
            + Start from scratch (no template)
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.querySelector('#tpl-close').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#tpl-blank').addEventListener('click', () => {
    overlay.remove();
    _openNewProjectForm(null);
  });
  overlay.querySelector('#tpl-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.tpl-item');
    if (!btn) return;
    const tplId = btn.dataset.tplId;
    const tpl = all.find(t => t.id === tplId);
    overlay.remove();
    if (tpl) _openNewProjectForm(tpl);
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

async function _openNewProjectForm(template) {
  const ctx = getActiveContext();
  const prefill = { context: ctx === 'all' ? 'family' : ctx };
  if (template) {
    prefill.goal = template.goal || '';
  }
  // [B-01 fix] Pass onSave callback so template tasks are created after project is saved
  openForm('project', prefill, template ? async (savedProject) => {
    if (savedProject && savedProject.id) {
      await applyTemplateToProject(savedProject, template);
    }
  } : null);
}

export async function applyTemplateToProject(project, template) {
  if (!template || !template.tasks) return;
  const account = getAccount();
  const deadline = project.deadline ? new Date(project.deadline + 'T00:00:00') : new Date();
  for (const taskDef of template.tasks) {
    const dueDate = new Date(deadline);
    dueDate.setDate(dueDate.getDate() + (taskDef.daysOffset || 0));
    const dueDateStr = `${dueDate.getFullYear()}-${String(dueDate.getMonth()+1).padStart(2,'0')}-${String(dueDate.getDate()).padStart(2,'0')}`;
    const task = {
      type: 'task',
      title: taskDef.title,
      status: 'Not Started',
      priority: taskDef.priority || 'Medium',
      dueDate: dueDateStr,
      project: project.id,
      context: project.context || 'family',
      createdBy: account?.id,
    };
    try {
      await saveEntity(task, account?.id);
    } catch { /* non-fatal */ }
  }
}

// ── [F6] Smart Task Prioritisation ────────────────────────────
async function _computeProjectNextActions(projectId) {
  const projTasks = _getProjectTasks(projectId);
  const pending = projTasks.filter(t => !_isTaskDone(t) && t.status !== 'Skipped');

  // Build blocker map for each task
  const blockerMap = new Map();
  for (const t of pending) {
    try {
      const edges = await getEdgesFrom(t.id, 'blockedBy');
      const unresolvedBlockers = edges.filter(e => {
        const blocker = _tasks.find(bt => bt.id === e.toId);
        return blocker && !_isTaskDone(blocker);
      });
      blockerMap.set(t.id, unresolvedBlockers.length);
    } catch {
      blockerMap.set(t.id, 0);
    }
  }

  // Exclude tasks with unresolved blockers
  const unblocked = pending.filter(t => (blockerMap.get(t.id) || 0) === 0);

  const today = new Date(); today.setHours(0,0,0,0);
  const PRIORITY_WEIGHT = { High: 3, Medium: 2, Low: 1 };

  const scored = unblocked.map(t => {
    let score = 0;
    // Days to deadline (40%) — closer = higher score
    if (t.dueDate) {
      const due = new Date(t.dueDate + 'T00:00:00');
      const days = Math.max(0, Math.ceil((due - today) / 86400000));
      const daysScore = days === 0 ? 40 : days < 3 ? 35 : days < 7 ? 28 : days < 14 ? 20 : days < 30 ? 10 : 5;
      score += daysScore;
    } else {
      score += 5; // no deadline — low urgency
    }
    // Priority field (35%)
    const pw = PRIORITY_WEIGHT[t.priority] || 2;
    score += pw * (35 / 3);
    // No dependencies (25%)
    score += 25; // all tasks here are unblocked
    return { task: t, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 3);
}

function _showNextActionsPopover(btn, projectId) {
  const existing = document.getElementById('next-actions-popover');
  if (existing) existing.remove();

  const popover = document.createElement('div');
  popover.id = 'next-actions-popover';
  popover.style.cssText = `
    position:fixed;z-index:4000;background:var(--color-bg);border:1px solid var(--color-border);
    border-radius:var(--radius-lg);box-shadow:var(--shadow-lg);padding:var(--space-3) var(--space-4);
    min-width:280px;max-width:380px;
  `;
  popover.innerHTML = `<div style="font-size:var(--text-xs);color:var(--color-text-muted);margin-bottom:var(--space-2);">⏳ Loading recommendations…</div>`;
  document.body.appendChild(popover);

  // Position near button
  const rect = btn.getBoundingClientRect();
  popover.style.top  = `${Math.min(rect.bottom + 6, window.innerHeight - 200)}px`;
  popover.style.left = `${Math.min(rect.left, window.innerWidth - 400)}px`;

  _computeProjectNextActions(projectId).then(actions => {
    if (actions.length === 0) {
      popover.innerHTML = `
        <div style="font-weight:var(--weight-semibold);font-size:var(--text-sm);margin-bottom:var(--space-2);">🎯 What's Next?</div>
        <div style="font-size:var(--text-xs);color:var(--color-text-muted);">All tasks are done or blocked. 🎉</div>
      `;
      return;
    }
    popover.innerHTML = `
      <div style="font-weight:var(--weight-semibold);font-size:var(--text-sm);margin-bottom:var(--space-3);">🎯 Top Next Actions</div>
      ${actions.map((a, i) => {
        const t = a.task;
        const dueLabel = t.dueDate ? `📅 ${t.dueDate}` : '';
        const priBadge = t.priority ? `<span style="font-size:9px;padding:1px 5px;border-radius:10px;
          background:${t.priority==='High'?'#fee2e2':t.priority==='Medium'?'#fef3c7':'#f0fdf4'};
          color:${t.priority==='High'?'#dc2626':t.priority==='Medium'?'#d97706':'#16a34a'};">${t.priority}</span>` : '';
        return `
          <div style="padding:var(--space-2) 0;border-bottom:1px solid var(--color-border);display:flex;align-items:flex-start;gap:var(--space-2);">
            <span style="font-size:var(--text-xs);color:var(--color-text-muted);font-weight:var(--weight-bold);width:16px;flex-shrink:0;">${i+1}.</span>
            <div style="flex:1;min-width:0;">
              <div style="font-size:var(--text-xs);font-weight:var(--weight-semibold);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(t.title)}</div>
              <div style="display:flex;gap:var(--space-1);margin-top:2px;align-items:center;flex-wrap:wrap;">
                ${priBadge}
                ${dueLabel ? `<span style="font-size:9px;color:var(--color-text-muted);">${dueLabel}</span>` : ''}
              </div>
            </div>
            <button class="na-open-btn" data-task-id="${_esc(t.id)}"
              style="font-size:9px;color:var(--color-accent);background:none;border:none;cursor:pointer;white-space:nowrap;padding:0;">Open →</button>
          </div>
        `;
      }).join('')}
      <div style="margin-top:var(--space-2);font-size:9px;color:var(--color-text-muted);">
        Ranked by deadline proximity, priority, and unblocked status.
      </div>
    `;
    popover.querySelectorAll('.na-open-btn').forEach(b => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        emit(EVENTS.PANEL_OPENED, { entityId: b.dataset.taskId });
        popover.remove();
      });
    });
  }).catch(() => {
    popover.innerHTML = `<div style="font-size:var(--text-xs);color:var(--color-danger);">Failed to compute actions.</div>`;
  });

  // Close on outside click — check if popover still mounted before removing
  setTimeout(() => {
    document.addEventListener('click', function _close() {
      if (popover.isConnected) popover.remove();
      document.removeEventListener('click', _close);
    });
  }, 0);
}

// ── [F4] Weekly Digest & Stall Detection ──────────────────────
export async function runWeeklyProjectDigest(force = false) {
  const DIGEST_KEY = 'fh_lastProjectDigest';
  const lastRun = localStorage.getItem(DIGEST_KEY);
  const now = Date.now();

  if (!force && lastRun && (now - parseInt(lastRun)) < 6 * 24 * 60 * 60 * 1000) return; // max once per 6 days

  const account = getAccount();
  let projects, tasks;
  try {
    [projects, tasks] = await Promise.all([
      getEntitiesByType('project'),
      getEntitiesByType('task'),
    ]);
  } catch { return; }

  const activeProjects = projects.filter(p => !p.deleted && p.status === 'Active');
  if (activeProjects.length === 0) return;

  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  const today = new Date(); today.setHours(0,0,0,0);

  const stalled = [];
  const dueSoon = [];
  const justCompleted = [];
  const newThisWeek = [];

  for (const proj of activeProjects) {
    const projTasks = tasks.filter(t => !t.deleted && (t.project === proj.id));
    const doneTasks = projTasks.filter(t => _isTaskDone(t));
    const progress = projTasks.length > 0 ? Math.round((doneTasks.length / projTasks.length) * 100) : 0;

    // Just hit 100%?
    if (progress === 100 && projTasks.length > 0) {
      const lastCompleted = doneTasks.reduce((max, t) => {
        const ts = t.updatedAt ? new Date(t.updatedAt).getTime() : 0;
        return ts > max ? ts : max;
      }, 0);
      if ((now - lastCompleted) < SEVEN_DAYS) justCompleted.push({ proj, progress });
    }

    // Stalled — no task activity in 7 days?
    const lastActivity = projTasks.reduce((max, t) => {
      const ts = t.updatedAt ? new Date(t.updatedAt).getTime() : 0;
      return ts > max ? ts : max;
    }, proj.createdAt ? new Date(proj.createdAt).getTime() : 0);

    if ((now - lastActivity) > SEVEN_DAYS && progress < 100) {
      stalled.push({ proj, progress, daysSince: Math.floor((now - lastActivity) / 86400000) });
    }

    // Due soon?
    if (proj.deadline) {
      const deadlineDate = new Date(proj.deadline + 'T00:00:00');
      const daysUntil = Math.ceil((deadlineDate - today) / 86400000);
      if (daysUntil >= 0 && daysUntil <= 14) dueSoon.push({ proj, daysUntil, progress });
    }

    // New this week?
    if (proj.createdAt && (now - new Date(proj.createdAt).getTime()) < SEVEN_DAYS) {
      newThisWeek.push({ proj });
    }
  }

  if (stalled.length === 0 && dueSoon.length === 0 && justCompleted.length === 0) {
    localStorage.setItem(DIGEST_KEY, String(now));
    return;
  }

  // Build digest post body
  let body = `=== Weekly Project Digest === ${today.toLocaleDateString()}\n\n`;
  if (stalled.length > 0) {
    body += `🚨 STALLED PROJECTS (no activity in 7+ days):\n${stalled.map(s => `  • ${s.proj.name || s.proj.title} — ${s.progress}% done, stalled ${s.daysSince} days`).join('\n')}\n\n`;
  }
  if (dueSoon.length > 0) {
    body += `📅 DUE SOON (within 14 days):\n${dueSoon.map(d => `  • ${d.proj.name || d.proj.title} — ${d.daysUntil === 0 ? 'due today' : `${d.daysUntil} days left`}, ${d.progress}% done`).join('\n')}\n\n`;
  }
  if (justCompleted.length > 0) {
    body += `🎉 COMPLETED THIS WEEK:\n${justCompleted.map(c => `  • ${c.proj.name || c.proj.title}`).join('\n')}\n\n`;
  }
  if (newThisWeek.length > 0) {
    body += `🆕 STARTED THIS WEEK:\n${newThisWeek.map(n => `  • ${n.proj.name || n.proj.title}`).join('\n')}`;
  }

  const digestPost = {
    type: 'post',
    title: `Weekly Project Digest — ${today.toLocaleDateString()}`,
    body: body.trim(),
    context: 'family',
    tags: ['digest', 'projects'],
    createdBy: account?.id,
    _isDigest: true,
  };

  try {
    await saveEntity(digestPost, account?.id);
    localStorage.setItem(DIGEST_KEY, String(now));
  } catch { /* non-fatal */ }
}

// ── [F5] Timeline View ─────────────────────────────────────────
function _renderTimeline(el, projects) {
  const container = document.createElement('div');
  container.style.cssText = `padding:var(--space-5);overflow-x:auto;`;

  if (projects.length === 0) {
    container.innerHTML = `<div style="text-align:center;color:var(--color-text-muted);padding:var(--space-8);">No projects to display on timeline.</div>`;
    el.appendChild(container);
    return;
  }

  // Calculate date range — rolling 3-month window centered on today
  const today = new Date(); today.setHours(0,0,0,0);
  const windowStart = new Date(today); windowStart.setDate(today.getDate() - 30);
  const windowEnd   = new Date(today); windowEnd.setDate(today.getDate() + 60);
  const totalDays = Math.ceil((windowEnd - windowStart) / 86400000);
  const CANVAS_WIDTH = Math.max(800, totalDays * 12);
  const ROW_HEIGHT = 44;

  // Sort by deadline soonest first
  const sorted = [...projects].filter(p => p.status !== 'Archived').sort((a, b) => {
    const da = a.deadline || '9999-12-31';
    const db = b.deadline || '9999-12-31';
    return da.localeCompare(db);
  });

  const header = document.createElement('div');
  header.style.cssText = `
    display:flex;gap:var(--space-3);align-items:center;margin-bottom:var(--space-3);
    font-size:var(--text-xs);color:var(--color-text-muted);
  `;
  header.innerHTML = `
    <span>📅 Timeline — <strong>${windowStart.toLocaleDateString()}</strong> to <strong>${windowEnd.toLocaleDateString()}</strong></span>
    <span style="margin-left:auto;">Today: <strong>${today.toLocaleDateString()}</strong></span>
  `;
  container.appendChild(header);

  const canvas = document.createElement('canvas');
  canvas.style.cssText = `display:block;max-width:100%;`;
  container.appendChild(canvas);
  el.appendChild(container);

  const ctx = canvas.getContext('2d');
  // roundRect polyfill for browsers that don't support it natively
  if (!ctx.roundRect) {
    ctx.roundRect = function(x, y, w, h, r) {
      const R = Math.min(r, w/2, h/2);
      this.moveTo(x+R, y);
      this.lineTo(x+w-R, y); this.arcTo(x+w, y, x+w, y+R, R);
      this.lineTo(x+w, y+h-R); this.arcTo(x+w, y+h, x+w-R, y+h, R);
      this.lineTo(x+R, y+h); this.arcTo(x, y+h, x, y+h-R, R);
      this.lineTo(x, y+R); this.arcTo(x, y, x+R, y, R);
      this.closePath();
    };
  }
  const LABEL_W = 180;
  const dpr = window.devicePixelRatio || 1;
  const LOGICAL_W = CANVAS_WIDTH + LABEL_W + 20;
  const LOGICAL_H = (sorted.length + 2) * ROW_HEIGHT + 40;
  canvas.width  = LOGICAL_W * dpr;
  canvas.height = LOGICAL_H * dpr;
  canvas.style.width  = `${LOGICAL_W}px`;
  canvas.style.height = `${LOGICAL_H}px`;
  ctx.scale(dpr, dpr);

  // Colours from CSS vars (approximate)
  const isDark = document.documentElement.classList.contains('dark');
  const textColor   = isDark ? '#d1d5db' : '#374151';
  const borderColor = isDark ? '#374151' : '#e5e7eb';
  const bgColor     = isDark ? '#1f2937' : '#f9fafb';
  const todayColor  = '#7c3aed';

  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

  function dayX(date) {
    const days = Math.ceil((date - windowStart) / 86400000);
    return LABEL_W + (days / totalDays) * CANVAS_WIDTH;
  }

  // Draw month grid lines
  ctx.font = '10px sans-serif';
  ctx.fillStyle = textColor;
  // [B-21] Start month cursor from first of windowStart's month,
  // but skip rendering if the line would be before windowStart
  const monthCursor = new Date(windowStart); monthCursor.setDate(1);
  while (monthCursor <= windowEnd) {
    const x = dayX(monthCursor);
    if (x >= LABEL_W) { // [B-21] only draw months within the visible window
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, 30); ctx.lineTo(x, LOGICAL_H); ctx.stroke();
      ctx.fillStyle = textColor;
      ctx.fillText(monthCursor.toLocaleDateString('en', { month: 'short', year: '2-digit' }), x + 4, 20);
    }
    monthCursor.setMonth(monthCursor.getMonth() + 1);
  }

  // Draw today line
  const todayX = dayX(today);
  ctx.strokeStyle = todayColor;
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 2]);
  ctx.beginPath(); ctx.moveTo(todayX, 0); ctx.lineTo(todayX, LOGICAL_H); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = todayColor;
  ctx.font = 'bold 10px sans-serif';
  ctx.fillText('Today', todayX + 3, 20);

  // Draw project bars
  sorted.forEach((proj, i) => {
    const y = 40 + i * ROW_HEIGHT;
    const projTasks = _getProjectTasks(proj.id);
    const doneTasks = projTasks.filter(t => _isTaskDone(t));
    const progress = projTasks.length > 0 ? (doneTasks.length / projTasks.length) : 0;
    const health = _computeHealthScore(proj, projTasks);
    const color = _healthColor(health);

    // Label
    ctx.font = '12px sans-serif';
    ctx.fillStyle = textColor;
    const label = (proj.name || proj.title || 'Project').substring(0, 22);
    ctx.fillText(label, 4, y + ROW_HEIGHT / 2 + 4);

    // Bar range
    const startDate = proj.createdAt ? new Date(proj.createdAt) : new Date(today); startDate.setHours(0,0,0,0);
    const endDate   = proj.deadline  ? new Date(proj.deadline + 'T00:00:00') : new Date(today.getTime() + 30 * 86400000);

    const x1 = Math.max(LABEL_W, dayX(startDate));
    const x2 = Math.min(LABEL_W + CANVAS_WIDTH, dayX(endDate));
    const barW = Math.max(x2 - x1, 4);
    const barH = 18;
    const barY = y + (ROW_HEIGHT - barH) / 2;

    // Background bar
    ctx.fillStyle = isDark ? '#374151' : '#e5e7eb';
    ctx.beginPath(); ctx.roundRect(x1, barY, barW, barH, 4); ctx.fill();

    // Progress fill
    const fillW = barW * progress;
    if (fillW > 0) {
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.8;
      ctx.beginPath(); ctx.roundRect(x1, barY, fillW, barH, 4); ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Overdue extension
    if (proj.deadline && endDate < today) {
      const overdueX = dayX(endDate);
      const overdueEnd = dayX(today);
      if (overdueEnd > overdueX) {
        ctx.fillStyle = '#fca5a5';
        ctx.globalAlpha = 0.5;
        ctx.fillRect(overdueX, barY, overdueEnd - overdueX, barH);
        ctx.globalAlpha = 1;
      }
    }

    // Border
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.roundRect(x1, barY, barW, barH, 4); ctx.stroke();

    // % label inside bar
    if (barW > 30) {
      ctx.font = 'bold 9px sans-serif';
      ctx.fillStyle = '#fff';
      ctx.fillText(`${Math.round(progress * 100)}%`, x1 + 4, barY + barH - 5);
    }
  });

  // Click to open panel
  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = LOGICAL_W / rect.width;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * (LOGICAL_H / rect.height);
    const i = Math.floor((y - 40) / ROW_HEIGHT);
    if (i >= 0 && i < sorted.length) {
      emit(EVENTS.PANEL_OPENED, { entityId: sorted[i].id });
    }
  });
  canvas.style.cursor = 'pointer';
}

// ── Helpers ────────────────────────────────────────────────────
function _esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function _getInitials(name) {
  return (name || '?').split(/\s+/).map(w => w[0]?.toUpperCase() || '').join('').slice(0, 2);
}
function _isOverdue(dateStr) {
  if (!dateStr) return false;
  const today = new Date(); today.setHours(0,0,0,0);
  return new Date(dateStr + 'T00:00:00') < today;
}
function _isTaskDone(t) {
  const s = (t.status || '').toLowerCase();
  return s === 'done' || s === 'completed' || s === 'complete';
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
  await _buildProjectTaskEdgeMap();
  // [F1] Update progress snapshots for health scoring
  _updateProgressSnapshots();
}

let _snapshotUpdateInFlight = false;
function _updateProgressSnapshots() {
  if (_snapshotUpdateInFlight) return;
  _snapshotUpdateInFlight = true;
  const now = new Date().toISOString();
  const account = getAccount();
  for (const proj of _projects) {
    const projTasks = _getProjectTasks(proj.id);
    const doneTasks = projTasks.filter(t => _isTaskDone(t));
    const pct = projTasks.length > 0 ? Math.round((doneTasks.length / projTasks.length) * 100) : 0;
    // Only write if snapshot is >7 days old or missing
    const lastTs = proj._lastProgressSnapshotAt;
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    if (!lastTs || (Date.now() - new Date(lastTs).getTime()) > SEVEN_DAYS) {
      // Non-blocking background save
      const updated = { ...proj, _lastProgressSnapshot: pct, _lastProgressSnapshotAt: now };
      saveEntity(updated, account?.id).catch(() => {});
    }
  }
  // Reset flag after a tick so saves complete before next render cycle
  setTimeout(() => { _snapshotUpdateInFlight = false; }, 0);
}

async function _buildProjectTaskEdgeMap() {
  _projectTaskEdgeMap.clear();
  _projectMemberEdgeMap.clear();
  for (const proj of _projects) {
    try {
      // Query both 'project' (current) and 'part of' (pre-fix legacy) relation labels
      // so existing IDB data from before B-02/B-03 fix continues to count toward progress
      const [edgesProject, edgesPartOf] = await Promise.all([
        getEdgesTo(proj.id, 'project').catch(() => []),
        getEdgesTo(proj.id, 'part of').catch(() => []),
      ]);
      const taskIds = new Set([...edgesProject, ...edgesPartOf].map(e => e.fromId));
      if (taskIds.size > 0) _projectTaskEdgeMap.set(proj.id, taskIds);
    } catch { /* non-fatal */ }
    if (!proj.members || proj.members.length === 0) {
      try {
        const memberEdges = await getEdgesFrom(proj.id, 'members');
        if (memberEdges.length > 0) _projectMemberEdgeMap.set(proj.id, memberEdges.map(e => e.toId));
      } catch { /* non-fatal */ }
    }
  }
}

function _getProjectTasks(projectId) {
  const edgeTaskIds = _projectTaskEdgeMap.get(projectId) || new Set();
  return _tasks.filter(t => t.project === projectId || edgeTaskIds.has(t.id));
}

// ── Main Render ────────────────────────────────────────────────
async function renderProjects(params = {}) {
  const el = document.getElementById('view-projects');
  if (!el) return;

  if (!params._internal) {
    try {
      await _loadData();
    } catch (err) {
      console.error('[projects] _loadData failed:', err);
      el.innerHTML = `<div style="padding:var(--space-6);color:var(--color-text-muted);text-align:center;">Failed to load projects. Please try again.</div>`;
      return;
    }
  }

  // [F3] Restore focus banner if active
  _renderFocusBanner();

  el.innerHTML = '';

  const focusId = getFocusProjectId();

  const _filteredCount = _activeFilter === 'All' ? _projects.length : _projects.filter(p => p.status === _activeFilter).length;
  const _countLabel = _activeFilter === 'All' ? `${_projects.length}` : `${_filteredCount} of ${_projects.length}`;

  // ── Header ──────────────────────────────────────────────────
  const header = document.createElement('div');
  header.style.cssText = `
    padding:var(--space-4) var(--space-5);display:flex;align-items:center;justify-content:space-between;
    border-bottom:1px solid var(--color-border);flex-wrap:wrap;gap:var(--space-2);
  `;

  const titleGroup = document.createElement('div');
  titleGroup.style.cssText = `display:flex;align-items:center;gap:var(--space-2);`;
  titleGroup.innerHTML = `
    <span style="font-size:1.3em;">📁</span>
    <span style="font-weight:var(--weight-bold);font-size:var(--text-lg);color:var(--color-text);">Projects</span>
    <span style="font-size:var(--text-sm);color:var(--color-text-muted);">(${_countLabel})</span>
  `;

  const ctrlGroup = document.createElement('div');
  ctrlGroup.style.cssText = `display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap;`;

  // [F5] View toggle Grid | Timeline
  const viewToggle = document.createElement('div');
  viewToggle.style.cssText = `display:flex;border:1px solid var(--color-border);border-radius:var(--radius-md);overflow:hidden;`;
  ['grid','timeline'].forEach(mode => {
    const btn = document.createElement('button');
    btn.textContent = mode === 'grid' ? '⊞ Grid' : '📅 Timeline';
    btn.style.cssText = `
      padding:4px 10px;font-size:var(--text-xs);font-weight:var(--weight-semibold);border:none;cursor:pointer;
      background:${_viewMode === mode ? 'var(--color-accent)' : 'var(--color-surface)'};
      color:${_viewMode === mode ? '#fff' : 'var(--color-text)'};
      transition:all 0.12s;
    `;
    btn.addEventListener('click', () => { _viewMode = mode; renderProjects({ _internal: true }); });
    viewToggle.appendChild(btn);
  });
  ctrlGroup.appendChild(viewToggle);

  // [F2] New Project button with template option
  const newBtn = document.createElement('button');
  newBtn.textContent = '+ New Project';
  newBtn.style.cssText = `
    padding:6px 14px;font-size:var(--text-sm);font-weight:var(--weight-semibold);
    background:var(--color-accent);color:#fff;border:none;border-radius:var(--radius-md);cursor:pointer;
  `;
  newBtn.addEventListener('click', () => _openTemplateModal().catch(e => console.error('[projects] template modal error:', e)));
  ctrlGroup.appendChild(newBtn);

  header.appendChild(titleGroup);
  header.appendChild(ctrlGroup);
  el.appendChild(header);

  // ── Focus Mode Banner (inline, below header) ─────────────────
  if (focusId) {
    const focusBadge = document.createElement('div');
    focusBadge.style.cssText = `
      padding:var(--space-2) var(--space-5);background:var(--color-accent)22;border-bottom:1px solid var(--color-accent)44;
      display:flex;align-items:center;gap:var(--space-2);font-size:var(--text-xs);
    `;
    const focusedProj = _projects.find(p => p.id === focusId);
    focusBadge.innerHTML = `
      <span style="color:var(--color-accent);">🎯 Focus Mode active: <strong>${_esc(focusedProj?.name || focusedProj?.title || 'Unknown Project')}</strong></span>
      <button style="margin-left:auto;background:none;border:none;cursor:pointer;font-size:var(--text-xs);color:var(--color-accent);" id="proj-exit-focus">Exit Focus</button>
    `;
    focusBadge.querySelector('#proj-exit-focus').addEventListener('click', () => {
      clearFocusProject();
      renderProjects({ _internal: true });
    });
    el.appendChild(focusBadge);
  }

  // ── Filter Tabs ─────────────────────────────────────────────
  const filterBar = document.createElement('div');
  filterBar.style.cssText = `
    padding:var(--space-3) var(--space-5);display:flex;gap:var(--space-2);flex-wrap:wrap;
    border-bottom:1px solid var(--color-border);
  `;
  for (const f of ['All', 'Active', 'On Hold', 'Complete', 'Archived']) {
    const btn = document.createElement('button');
    btn.textContent = f;
    const isActive = _activeFilter === f;
    btn.style.cssText = `
      padding:4px 12px;font-size:var(--text-xs);font-weight:var(--weight-semibold);
      border-radius:var(--radius-full);cursor:pointer;border:1px solid var(--color-border);
      background:${isActive ? 'var(--color-accent)' : 'var(--color-surface)'};
      color:${isActive ? '#fff' : 'var(--color-text)'};transition:all 0.12s;
    `;
    btn.addEventListener('click', () => { _activeFilter = f; renderProjects({ _internal: true }); });
    filterBar.appendChild(btn);
  }
  el.appendChild(filterBar);

  let filtered = _activeFilter === 'All' ? _projects : _projects.filter(p => p.status === _activeFilter);

  // Sort: Active first, then by deadline
  const STATUS_SORT = { Active: 0, 'On Hold': 1, Complete: 2, Archived: 3 };
  filtered = [...filtered].sort((a, b) => {
    const sa = STATUS_SORT[a.status] ?? 9, sb = STATUS_SORT[b.status] ?? 9;
    if (sa !== sb) return sa - sb;
    return (a.deadline || 'zzzz').localeCompare(b.deadline || 'zzzz');
  });

  // [F3] Highlight focused project at top
  if (focusId) {
    const focusIdx = filtered.findIndex(p => p.id === focusId);
    if (focusIdx > 0) {
      const [fp] = filtered.splice(focusIdx, 1);
      filtered.unshift(fp);
    }
  }

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

  // ── [F5] Timeline Mode ──────────────────────────────────────
  if (_viewMode === 'timeline') {
    _renderTimeline(el, filtered);
    return;
  }

  // ── Grid Mode ───────────────────────────────────────────────
  const grid = document.createElement('div');
  grid.style.cssText = `
    display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:var(--space-4);
    padding:var(--space-5);
  `;

  const STATUS_COLORS = {
    Active:   'var(--color-accent)',
    'On Hold': '#d97706',
    Complete: '#16a34a',
    Archived: '#6b7280',
  };

  for (const project of filtered) {
    const projTasks = _getProjectTasks(project.id);
    const doneTasks = projTasks.filter(t => _isTaskDone(t));
    const progress  = projTasks.length > 0 ? Math.round((doneTasks.length / projTasks.length) * 100) : 0;

    // [F1] Health Score
    const health = _computeHealthScore(project, projTasks);
    const healthColor = _healthColor(health);

    const statusColor   = STATUS_COLORS[project.status] || '#6b7280';
    const deadlineOverdue = _isOverdue(project.deadline);

    // Member avatars
    const directMembers = Array.isArray(project.members) ? project.members : [];
    const members = directMembers.length > 0 ? directMembers : (_projectMemberEdgeMap.get(project.id) || []);
    const avatarHtml = members.slice(0, 4).map(memberId => {
      const person = _personMap.get(memberId);
      const initials = _getInitials(person?.name || person?.title);
      return `<div style="width:24px;height:24px;border-radius:50%;background:var(--color-accent);color:#fff;
        display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:var(--weight-bold);
        border:2px solid var(--color-bg);margin-left:-6px;">${initials}</div>`;
    }).join('');
    const extraMembers = members.length > 4 ? `<span style="font-size:10px;color:var(--color-text-muted);margin-left:4px;">+${members.length - 4}</span>` : '';

    const isFocused = project.id === focusId;

    const card = document.createElement('div');
    card.style.cssText = `
      padding:var(--space-4);background:var(--color-bg);
      border:${isFocused ? '2px solid var(--color-accent)' : '1px solid var(--color-border)'};
      border-radius:var(--radius-lg);cursor:pointer;transition:box-shadow 0.15s,border-color 0.15s;
      display:flex;flex-direction:column;gap:var(--space-3);position:relative;
    `;
    card.addEventListener('mouseenter', () => { if (!isFocused) card.style.borderColor = 'var(--color-accent)'; });
    card.addEventListener('mouseleave', () => { if (!isFocused) card.style.borderColor = 'var(--color-border)'; });

    card.innerHTML = `
      <!-- [F1] Health ring — top right -->
      <div style="position:absolute;top:var(--space-3);right:var(--space-3);" title="Health Score: ${health}/100 — ${_healthLabel(health)}">
        ${_healthRingSvg(health)}
      </div>

      <div style="display:flex;align-items:flex-start;gap:var(--space-2);padding-right:44px;">
        <div style="font-weight:var(--weight-bold);font-size:var(--text-sm);color:var(--color-text);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
          ${isFocused ? '🎯 ' : ''}${_esc(project.name || project.title || 'Untitled')}
        </div>
        <span style="padding:2px 8px;border-radius:var(--radius-full);font-size:10px;font-weight:var(--weight-bold);
          background:${statusColor}22;color:${statusColor};white-space:nowrap;flex-shrink:0;">
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
          <span style="color:${healthColor};font-weight:var(--weight-semibold);">${progress}%</span>
        </div>
        <div style="height:6px;background:var(--color-surface);border-radius:3px;overflow:hidden;">
          <div style="height:100%;width:${progress}%;background:${healthColor};border-radius:3px;transition:width 0.3s;"></div>
        </div>
      </div>

      <div style="display:flex;gap:var(--space-2);margin-top:auto;flex-wrap:wrap;">
        <button class="proj-add-task-btn" data-project-id="${_esc(project.id)}" data-project-name="${_esc(project.name || project.title || '')}"
          style="padding:3px 10px;font-size:10px;font-weight:var(--weight-semibold);background:var(--color-surface);
          color:var(--color-text-muted);border:1px solid var(--color-border);border-radius:var(--radius-full);cursor:pointer;">
          + Add Task
        </button>
        <button class="proj-focus-btn" data-project-id="${_esc(project.id)}"
          style="padding:3px 10px;font-size:10px;font-weight:var(--weight-semibold);
          background:${isFocused ? 'var(--color-accent)' : 'var(--color-surface)'};
          color:${isFocused ? '#fff' : 'var(--color-text-muted)'};
          border:1px solid ${isFocused ? 'var(--color-accent)' : 'var(--color-border)'};border-radius:var(--radius-full);cursor:pointer;">
          ${isFocused ? '🎯 Focused' : '🎯 Focus'}
        </button>
        <button class="proj-next-btn" data-project-id="${_esc(project.id)}"
          style="padding:3px 10px;font-size:10px;font-weight:var(--weight-semibold);background:var(--color-surface);
          color:var(--color-text-muted);border:1px solid var(--color-border);border-radius:var(--radius-full);cursor:pointer;">
          ⚡ What's next?
        </button>
      </div>
    `;

    // Card click → panel
    card.addEventListener('click', (e) => {
      if (e.target.closest('.proj-add-task-btn,.proj-focus-btn,.proj-next-btn')) return;
      emit(EVENTS.PANEL_OPENED, { entityId: project.id });
    });

    // + Add Task
    const addTaskBtn = card.querySelector('.proj-add-task-btn');
    addTaskBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const ctx = getActiveContext();
      openForm('task', {
        project: project.id,
        projectTitle: project.name || project.title,
        context: ctx === 'all' ? 'family' : ctx,
      });
    });

    // [F3] Focus button
    const focusBtn = card.querySelector('.proj-focus-btn');
    focusBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isFocused) clearFocusProject();
      else setFocusProject(project.id);
      renderProjects({ _internal: true });
    });

    // [F6] What's next?
    const nextBtn = card.querySelector('.proj-next-btn');
    nextBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      _showNextActionsPopover(nextBtn, project.id);
    });

    grid.appendChild(card);
  }

  el.appendChild(grid);
}

// ── Module-level listeners ─────────────────────────────────────
let _projRefreshTimer = null;
function _debouncedProjectRefresh() {
  if (!document.getElementById('view-projects')?.classList.contains('active')) return;
  clearTimeout(_projRefreshTimer);
  _projRefreshTimer = setTimeout(() => renderProjects(), 400);
}

function _registerListeners() {
  if (_listenersRegistered) return;
  _listenersRegistered = true;

  on(EVENTS.ENTITY_SAVED, ({ entity } = {}) => {
    const PROJ_REFRESH_TYPES = new Set(['project', 'task', 'person']);
    // (projects:focusChanged handled separately below)
    if (entity && !PROJ_REFRESH_TYPES.has(entity.type)) return;
    _debouncedProjectRefresh();
  });

  on(EVENTS.ENTITY_DELETED, ({ entity } = {}) => {
    const t = entity?.type;
    if (t === 'project' || t === 'task' || !t) _debouncedProjectRefresh();
  });

  on('context:changed', () => {
    if (document.getElementById('view-projects')?.classList.contains('active')) renderProjects();
  });

  on('projects:focusChanged', () => {
    _renderFocusBanner();
    _debouncedProjectRefresh();
  });
}
_registerListeners();

// ── Registration ───────────────────────────────────────────────
registerView('projects', renderProjects);
export { renderProjects };
