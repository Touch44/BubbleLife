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
import { getEntitiesByType, getEdgesTo, getEdgesFrom, saveEntity, saveEdge, getSetting, setSetting } from '../core/db.js';
import { getGamificationState, getProjectStreak, getMemberStats, getLeaderboard,
         awardXP, BADGE_DEFS, LEVELS, _levelFor, _nextLevel, XP } from '../services/gamification.js';
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

// [v6.0.2] Focus banner now owned by core/banner.js (global across all views).
// _renderFocusBanner() is kept as a thin shim so existing call-sites do not break.
function _renderFocusBanner() {
  import('../core/banner.js').then(({ renderBanner }) => renderBanner()).catch(() => {});
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


// ── [F2+] Template Editor View ──────────────────────────────

const TEMPLATE_IDB_KEY = 'fh_project_templates_v1';

async function _loadUserTemplates() {
  try {
    const raw = await getSetting(TEMPLATE_IDB_KEY).catch(() => null);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

async function _saveUserTemplates(templates) {
  try {
    await setSetting(TEMPLATE_IDB_KEY, JSON.stringify(templates));
  } catch (e) { console.error('[projects] saveUserTemplates:', e); }
}

function _uid() {
  return 'tpl-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

async function _renderTemplatesView(el) {
  const userTemplates = await _loadUserTemplates();

  // Render the template manager UI
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;height:100%;overflow:hidden;';

  // ── Left panel: template list ──────────────────────────────
  const sidebar = document.createElement('div');
  sidebar.style.cssText = `
    width:260px;flex-shrink:0;border-right:1px solid var(--color-border);
    display:flex;flex-direction:column;overflow:hidden;
  `;

  const sideHeader = document.createElement('div');
  sideHeader.style.cssText = 'padding:var(--space-4);border-bottom:1px solid var(--color-border);display:flex;align-items:center;justify-content:space-between;';
  sideHeader.innerHTML = `
    <span style="font-weight:var(--weight-semibold);font-size:var(--text-sm);">Templates</span>
  `;
  const newTplBtn = document.createElement('button');
  newTplBtn.textContent = '+ New';
  newTplBtn.style.cssText = 'padding:4px 10px;font-size:var(--text-xs);font-weight:var(--weight-semibold);background:var(--color-accent);color:#fff;border:none;border-radius:var(--radius-sm);cursor:pointer;';
  sideHeader.appendChild(newTplBtn);
  sidebar.appendChild(sideHeader);

  const tplList = document.createElement('div');
  tplList.style.cssText = 'flex:1;overflow-y:auto;padding:var(--space-2);';
  sidebar.appendChild(tplList);

  // ── Right panel: template editor ──────────────────────────
  const editor = document.createElement('div');
  editor.style.cssText = 'flex:1;overflow-y:auto;padding:var(--space-5);';

  wrap.appendChild(sidebar);
  wrap.appendChild(editor);
  el.appendChild(wrap);

  let _selectedTplId = null;

  function _renderList() {
    tplList.innerHTML = '';

    // Built-in section
    const biLabel = document.createElement('div');
    biLabel.style.cssText = 'font-size:10px;font-weight:var(--weight-semibold);color:var(--color-text-muted);text-transform:uppercase;letter-spacing:0.06em;padding:var(--space-2) var(--space-1);';
    biLabel.textContent = 'Built-in';
    tplList.appendChild(biLabel);

    for (const tpl of BUILT_IN_TEMPLATES) {
      const row = _makeTplRow(tpl, true);
      tplList.appendChild(row);
    }

    if (userTemplates.length > 0) {
      const myLabel = document.createElement('div');
      myLabel.style.cssText = 'font-size:10px;font-weight:var(--weight-semibold);color:var(--color-text-muted);text-transform:uppercase;letter-spacing:0.06em;padding:var(--space-2) var(--space-1);margin-top:var(--space-2);';
      myLabel.textContent = 'My Templates';
      tplList.appendChild(myLabel);
      for (const tpl of userTemplates) {
        const row = _makeTplRow(tpl, false);
        tplList.appendChild(row);
      }
    }
  }

  function _makeTplRow(tpl, isBuiltIn) {
    const row = document.createElement('button');
    const isSelected = _selectedTplId === tpl.id;
    row.style.cssText = `
      display:flex;align-items:center;gap:var(--space-2);padding:var(--space-2) var(--space-2);
      border-radius:var(--radius-sm);border:none;width:100%;text-align:left;cursor:pointer;
      background:${isSelected ? 'var(--color-accent)' : 'transparent'};
      color:${isSelected ? '#fff' : 'var(--color-text)'};
      font-size:var(--text-xs);transition:background 0.12s;
    `;
    row.innerHTML = `
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(tpl.name)}</span>
      ${isBuiltIn ? '<span style="opacity:0.5;font-size:9px;">built-in</span>' : ''}
    `;
    row.addEventListener('click', () => {
      _selectedTplId = tpl.id;
      _renderList();
      _renderEditor(tpl, true, isBuiltIn);
    });
    return row;
  }

  function _renderEditor(tpl, isEditable, isBuiltIn = false) {
    editor.innerHTML = '';

    const isNew = !tpl.id;
    const title = document.createElement('div');
    title.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-4);';
    const titleText = isNew ? '✨ New Template' : isBuiltIn ? '✏️ Customize Built-in' : '✏️ Edit Template';
    title.innerHTML = `<span style="font-weight:var(--weight-bold);font-size:var(--text-base);">${titleText}</span>`;
    if (isBuiltIn && !isNew) {
      const forkNote = document.createElement('span');
      forkNote.style.cssText = 'font-size:10px;color:var(--color-text-muted);background:var(--color-surface);padding:2px 8px;border-radius:var(--radius-full);border:1px solid var(--color-border);margin-left:auto;';
      forkNote.textContent = '→ Saves as new My Template';
      title.appendChild(forkNote);
    }

    if (isEditable && !isNew && !isBuiltIn) {
      const delBtn = document.createElement('button');
      delBtn.textContent = '🗑 Delete';
      delBtn.style.cssText = 'font-size:var(--text-xs);color:var(--color-danger);background:none;border:1px solid var(--color-danger);padding:4px 10px;border-radius:var(--radius-sm);cursor:pointer;';
      delBtn.addEventListener('click', async () => {
        if (!window.confirm('Delete this template?')) return;
        const idx = userTemplates.findIndex(t => t.id === tpl.id);
        if (idx >= 0) userTemplates.splice(idx, 1);
        await _saveUserTemplates(userTemplates);
        _selectedTplId = null;
        editor.innerHTML = '<div style="padding:var(--space-8);text-align:center;color:var(--color-text-muted);">Select a template to view or edit it.</div>';
        _renderList();
      });
      title.appendChild(delBtn);
    }

    editor.appendChild(title);

    // ── Template meta fields ──────────────────────────────────
    const meta = document.createElement('div');
    meta.style.cssText = 'display:flex;flex-direction:column;gap:var(--space-3);margin-bottom:var(--space-5);';

    const mkField = (labelText, val, key, type = 'text') => {
      const wrap = document.createElement('div');
      const lbl = document.createElement('label');
      lbl.textContent = labelText;
      lbl.style.cssText = 'font-size:var(--text-xs);font-weight:var(--weight-semibold);color:var(--color-text-muted);display:block;margin-bottom:4px;';
      wrap.appendChild(lbl);
      const inp = document.createElement('input');
      inp.type = type;
      inp.value = val || '';
      inp.readOnly = !isEditable;
      inp.style.cssText = `width:100%;padding:7px 10px;border:1px solid var(--color-border);border-radius:var(--radius-sm);font-size:var(--text-sm);background:${isEditable ? 'var(--color-bg)' : 'var(--color-surface)'};color:var(--color-text);`;
      inp.dataset.key = key;
      wrap.appendChild(inp);
      meta.appendChild(wrap);
      return inp;
    };

    const nameInp = mkField('Template Name', tpl.name, 'name');
    const goalInp = mkField('Default Goal', tpl.goal, 'goal');

    // Completion Mode default
    const modeWrap = document.createElement('div');
    const modeLbl = document.createElement('label');
    modeLbl.textContent = 'Default Task Mode';
    modeLbl.style.cssText = 'font-size:var(--text-xs);font-weight:var(--weight-semibold);color:var(--color-text-muted);display:block;margin-bottom:4px;';
    modeWrap.appendChild(modeLbl);
    const modeSelect = document.createElement('select');
    modeSelect.style.cssText = 'width:100%;padding:7px 10px;border:1px solid var(--color-border);border-radius:var(--radius-sm);font-size:var(--text-sm);background:var(--color-bg);color:var(--color-text);';
    modeSelect.disabled = !isEditable;
    ['Parallel','Sequential'].forEach(m => {
      const opt = document.createElement('option');
      opt.value = m; opt.textContent = m;
      if ((tpl.completionMode || 'Parallel') === m) opt.selected = true;
      modeSelect.appendChild(opt);
    });
    modeWrap.appendChild(modeSelect);
    meta.appendChild(modeWrap);

    editor.appendChild(meta);

    // ── Task list ─────────────────────────────────────────────
    const taskHdr = document.createElement('div');
    taskHdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-3);';
    taskHdr.innerHTML = `<span style="font-weight:var(--weight-semibold);font-size:var(--text-sm);">📋 Tasks (${(tpl.tasks||[]).length})</span>`;

    const tasks = tpl.tasks ? [...tpl.tasks] : [];

    if (isEditable) {
      const addTaskBtn = document.createElement('button');
      addTaskBtn.textContent = '+ Add Task';
      addTaskBtn.style.cssText = 'font-size:var(--text-xs);font-weight:var(--weight-semibold);background:var(--color-accent);color:#fff;border:none;padding:4px 10px;border-radius:var(--radius-sm);cursor:pointer;';
      addTaskBtn.addEventListener('click', () => {
        tasks.push({ title: '', daysOffset: 0, priority: 'Medium' });
        _renderTaskList();
      });
      taskHdr.appendChild(addTaskBtn);
    }
    editor.appendChild(taskHdr);

    const taskListEl = document.createElement('div');
    taskListEl.style.cssText = 'display:flex;flex-direction:column;gap:var(--space-2);margin-bottom:var(--space-5);';
    editor.appendChild(taskListEl);

    function _renderTaskList() {
      taskListEl.innerHTML = '';
      if (tasks.length === 0) {
        taskListEl.innerHTML = '<div style="font-size:var(--text-xs);color:var(--color-text-muted);padding:var(--space-2);">No tasks yet.</div>';
        return;
      }
      tasks.forEach((task, idx) => {
        const row = document.createElement('div');
        row.style.cssText = `
          display:grid;gap:var(--space-2);
          grid-template-columns:${isEditable ? '20px ' : ''}1fr 80px 90px ${isEditable ? '28px' : ''};
          align-items:center;padding:var(--space-2) var(--space-2);
          background:var(--color-surface);border-radius:var(--radius-sm);
          border:1px solid var(--color-border);
        `;

        // Title input
        const titleInp = document.createElement('input');
        titleInp.type = 'text';
        titleInp.value = task.title || '';
        titleInp.placeholder = 'Task title';
        titleInp.readOnly = !isEditable;
        titleInp.style.cssText = 'width:100%;border:none;background:transparent;font-size:var(--text-xs);color:var(--color-text);padding:2px 4px;';
        titleInp.addEventListener('input', () => { tasks[idx].title = titleInp.value; });

        // Days offset
        const offsetWrap = document.createElement('div');
        offsetWrap.style.cssText = 'display:flex;align-items:center;gap:4px;';
        const offsetLbl = document.createElement('span');
        offsetLbl.style.cssText = 'font-size:9px;color:var(--color-text-muted);white-space:nowrap;';
        offsetLbl.textContent = 'days';
        const offsetInp = document.createElement('input');
        offsetInp.type = 'number';
        offsetInp.value = task.daysOffset || 0;
        offsetInp.readOnly = !isEditable;
        offsetInp.style.cssText = 'width:48px;border:1px solid var(--color-border);border-radius:var(--radius-sm);font-size:var(--text-xs);padding:2px 4px;background:var(--color-bg);color:var(--color-text);';
        offsetInp.title = 'Days from deadline (negative = before)';
        offsetInp.addEventListener('input', () => { tasks[idx].daysOffset = parseInt(offsetInp.value) || 0; });
        offsetWrap.appendChild(offsetInp);
        offsetWrap.appendChild(offsetLbl);

        // Priority
        const prioSelect = document.createElement('select');
        prioSelect.style.cssText = 'font-size:var(--text-xs);border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:2px 4px;background:var(--color-bg);color:var(--color-text);';
        prioSelect.disabled = !isEditable;
        ['Critical','High','Medium','Low'].forEach(p => {
          const opt = document.createElement('option');
          opt.value = p; opt.textContent = p;
          if (task.priority === p) opt.selected = true;
          prioSelect.appendChild(opt);
        });
        prioSelect.addEventListener('change', () => { tasks[idx].priority = prioSelect.value; });

        if (isEditable) {
          // Drag handle / move up-down buttons
          const moveWrap = document.createElement('div');
          moveWrap.style.cssText = 'display:flex;flex-direction:column;gap:0;';
          const upBtn = document.createElement('button');
          upBtn.textContent = '▲';
          upBtn.title = 'Move up';
          upBtn.style.cssText = 'background:none;border:none;color:var(--color-text-muted);cursor:pointer;font-size:8px;padding:0;line-height:1;';
          upBtn.disabled = idx === 0;
          upBtn.addEventListener('click', () => {
            if (idx > 0) { [tasks[idx-1], tasks[idx]] = [tasks[idx], tasks[idx-1]]; _renderTaskList(); }
          });
          const dnBtn = document.createElement('button');
          dnBtn.textContent = '▼';
          dnBtn.title = 'Move down';
          dnBtn.style.cssText = 'background:none;border:none;color:var(--color-text-muted);cursor:pointer;font-size:8px;padding:0;line-height:1;';
          dnBtn.disabled = idx === tasks.length - 1;
          dnBtn.addEventListener('click', () => {
            if (idx < tasks.length - 1) { [tasks[idx], tasks[idx+1]] = [tasks[idx+1], tasks[idx]]; _renderTaskList(); }
          });
          moveWrap.appendChild(upBtn);
          moveWrap.appendChild(dnBtn);
          row.appendChild(moveWrap);
        }

        row.appendChild(titleInp);
        row.appendChild(offsetWrap);
        row.appendChild(prioSelect);

        if (isEditable) {
          const delBtn = document.createElement('button');
          delBtn.textContent = '×';
          delBtn.style.cssText = 'background:none;border:none;color:var(--color-danger);cursor:pointer;font-size:1.1em;font-weight:var(--weight-bold);padding:0;';
          delBtn.addEventListener('click', () => { tasks.splice(idx, 1); _renderTaskList(); });
          row.appendChild(delBtn);
        }

        taskListEl.appendChild(row);
      });

      // Column headers (only when tasks exist)
      if (tasks.length > 0 && !taskListEl.querySelector('.tpl-task-hdr')) {
        const hdr = document.createElement('div');
        hdr.className = 'tpl-task-hdr';
        hdr.style.cssText = `
          display:grid;gap:var(--space-2);
          grid-template-columns:${isEditable ? '20px ' : ''}1fr 80px 90px ${isEditable ? '28px' : ''};
          padding:0 var(--space-2);
        `;
        hdr.innerHTML = `
          ${isEditable ? '<span></span>' : ''}
          <span style="font-size:9px;color:var(--color-text-muted);font-weight:600;text-transform:uppercase;">Task Title</span>
          <span style="font-size:9px;color:var(--color-text-muted);font-weight:600;text-transform:uppercase;">Days</span>
          <span style="font-size:9px;color:var(--color-text-muted);font-weight:600;text-transform:uppercase;">Priority</span>
          ${isEditable ? '<span></span>' : ''}
        `;
        taskListEl.insertBefore(hdr, taskListEl.firstChild);
      }
    }

    _renderTaskList();

    // ── Save / Use buttons ────────────────────────────────────
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:var(--space-3);margin-top:var(--space-4);';

    if (isEditable) {
      const saveBtn = document.createElement('button');
      saveBtn.textContent = isBuiltIn ? '💾 Save as My Template' : '💾 Save Template';
      saveBtn.style.cssText = 'padding:8px 16px;background:var(--color-accent);color:#fff;border:none;border-radius:var(--radius-md);font-size:var(--text-sm);font-weight:var(--weight-semibold);cursor:pointer;';
      saveBtn.addEventListener('click', async () => {
        const name = nameInp.value.trim();
        if (!name) { alert('Template name is required'); return; }
        // Store tasks with explicit order index so sequential mode respects it
        const orderedTasks = tasks.filter(t => t.title?.trim()).map((t, i) => ({ ...t, order: i }));
        const updated = {
          // Built-ins fork: always new ID so original is preserved
          id:             isBuiltIn ? _uid() : (tpl.id || _uid()),
          name,
          goal:           goalInp.value.trim(),
          completionMode: modeSelect.value,
          tasks:          orderedTasks,
        };
        const existingIdx = userTemplates.findIndex(t => t.id === updated.id);
        if (existingIdx >= 0) userTemplates[existingIdx] = updated;
        else userTemplates.push(updated);
        await _saveUserTemplates(userTemplates);
        _selectedTplId = updated.id;
        saveBtn.textContent = '✓ Saved!';
        const origLabel = isBuiltIn ? '💾 Save as My Template' : '💾 Save Template';
        setTimeout(() => { saveBtn.textContent = origLabel; }, 1500);
        _renderList();
        _renderEditor(updated, true, false);
      });
      btnRow.appendChild(saveBtn);
    }

    // Use template button (both built-in and user)
    const useBtn = document.createElement('button');
    useBtn.textContent = '🚀 Use This Template';
    useBtn.style.cssText = `
      padding:8px 16px;background:${isEditable ? 'var(--color-surface)' : 'var(--color-accent)'};
      color:${isEditable ? 'var(--color-text)' : '#fff'};
      border:1px solid var(--color-border);border-radius:var(--radius-md);
      font-size:var(--text-sm);font-weight:var(--weight-semibold);cursor:pointer;
    `;
    useBtn.addEventListener('click', () => {
      const tplToUse = {
        ...tpl,
        name: nameInp?.value?.trim() || tpl.name,
        goal: goalInp?.value?.trim() || tpl.goal,
        completionMode: modeSelect?.value || tpl.completionMode,
        tasks: tasks.filter(t => t.title?.trim()),
      };
      _viewMode = 'grid';
      _openNewProjectForm(tplToUse);
    });
    btnRow.appendChild(useBtn);

    editor.appendChild(btnRow);
  }

  _renderList();
  editor.innerHTML = '<div style="padding:var(--space-8);text-align:center;color:var(--color-text-muted);font-size:var(--text-sm);">← Select a template to preview or edit, or create a new one.</div>';

  newTplBtn.addEventListener('click', () => {
    _selectedTplId = null;
    _renderList();
    _renderEditor({ id: null, name: '', goal: '', completionMode: 'Parallel', tasks: [] }, true, false);
  });
}

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
  const prefill = { context: ctx === 'all' ? 'family' : ctx, status: 'Active' };
  if (template) {
    prefill.goal           = template.goal || '';
    prefill.completionMode = template.completionMode || 'Parallel';
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
  for (let idx_tpl = 0; idx_tpl < template.tasks.length; idx_tpl++) {
    const taskDef = template.tasks[idx_tpl];
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
      // [v5.9.5] Store order + daysOffset so sequential mode sorts correctly
      order:      typeof taskDef.order === 'number' ? taskDef.order : idx_tpl,
      daysOffset: taskDef.daysOffset || 0,
    };
    try {
      const saved = await saveEntity(task, account?.id);
      // [fix] Create graph edge so task appears as linked in entity-form and panel
      await saveEdge({
        fromId:   saved.id,
        fromType: 'task',
        toId:     project.id,
        toType:   'project',
        relation: 'project',
      }, account?.id).catch(() => {});
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


// ── [MAJOR] Sequential Task Mode ──────────────────────────────
/**
 * For a Sequential project, determine which task is "current" (next to complete)
 * and which are blocked behind it.
 * Tasks are ordered by: daysOffset ASC (relative to deadline), then createdAt ASC.
 * @param {object} project
 * @param {object[]} tasks - all tasks for this project (filtered by project)
 * @returns {{ currentId: string|null, blockedIds: Set<string> }}
 */
export function getSequentialTaskState(project, tasks) {
  if (!project || project.completionMode !== 'Sequential') {
    return { currentId: null, blockedIds: new Set() };
  }

  const DONE = new Set(['Done', 'Completed', 'Skipped']);
  const pending = tasks.filter(t => !DONE.has(t.status) && !t.deleted);

  if (pending.length === 0) return { currentId: null, blockedIds: new Set() };

  // Sort order: explicit task.order field first (set from template), then daysOffset, then createdAt
  // This ensures sequential mode respects the user-defined task ordering in template editor
  const sorted = [...pending].sort((a, b) => {
    const aOrd = typeof a.order === 'number' ? a.order : null;
    const bOrd = typeof b.order === 'number' ? b.order : null;
    // Both have explicit order → use it
    if (aOrd !== null && bOrd !== null) return aOrd - bOrd;
    // One has order → ordered one comes first
    if (aOrd !== null) return -1;
    if (bOrd !== null) return 1;
    // Fall back to daysOffset
    const aOff = typeof a.daysOffset === 'number' ? a.daysOffset : 999;
    const bOff = typeof b.daysOffset === 'number' ? b.daysOffset : 999;
    if (aOff !== bOff) return aOff - bOff;
    return (a.createdAt || '').localeCompare(b.createdAt || '');
  });

  const currentId = sorted[0].id;
  const blockedIds = new Set(sorted.slice(1).map(t => t.id));
  return { currentId, blockedIds };
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

  // [v6.1.3] Auto-switch to a specific tab if requested (e.g. after converting to template)
  if (params._tab && ['grid','timeline','templates'].includes(params._tab)) {
    _viewMode = params._tab;
  }

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
  ['grid','timeline','templates'].forEach(mode => {
    const btn = document.createElement('button');
    btn.textContent = mode === 'grid' ? '⊞ Grid' : mode === 'timeline' ? '📅 Timeline' : '📋 Templates';
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
  // Hide filter bar in templates mode — irrelevant there
  if (_viewMode !== 'templates') el.appendChild(filterBar);

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
  if (_viewMode === 'templates') {
    await _renderTemplatesView(el);
    return;
  }

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
        ${project.completionMode === 'Sequential' ? `<span style="padding:2px 8px;border-radius:var(--radius-full);font-size:10px;font-weight:var(--weight-bold);background:#7c3aed22;color:#7c3aed;white-space:nowrap;flex-shrink:0;">🔢 Sequential</span>` : ''}
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
        <button class="proj-analytics-btn" data-project-id="${_esc(project.id)}"
          style="padding:3px 10px;font-size:10px;font-weight:var(--weight-semibold);background:var(--color-surface);
          color:var(--color-text-muted);border:1px solid var(--color-border);border-radius:var(--radius-full);cursor:pointer;">
          📊 Analytics
        </button>
      </div>
    `;

    // Card click → panel
    card.addEventListener('click', (e) => {
      if (e.target.closest('.proj-add-task-btn,.proj-focus-btn,.proj-next-btn,.proj-analytics-btn')) return;
      emit(EVENTS.PANEL_OPENED, { entityId: project.id });
    });

    // + Add Task
    const addTaskBtn = card.querySelector('.proj-add-task-btn');
    addTaskBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const ctx = getActiveContext();
      const _acct = getAccount();
      openForm('task', {
        project:      project.id,
        projectTitle: project.name || project.title,
        context:      ctx === 'all' ? 'family' : ctx,
        ...(_acct?.memberId ? { assignedTo: _acct.memberId } : {}),
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

    // [v6.0.2] Analytics modal
    const analyticsBtn = card.querySelector('.proj-analytics-btn');
    analyticsBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      _showProjectAnalytics(project.id);
    });

    grid.appendChild(card);
  }

  el.appendChild(grid);
}

// ── [v6.0.2] Project Analytics Modal ─────────────────────────────
async function _showProjectAnalytics(projectId) {
  // Remove any existing overlay
  document.getElementById('proj-analytics-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'proj-analytics-overlay';
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:var(--z-modal);
    background:var(--color-overlay);
    display:flex;align-items:center;justify-content:center;
    padding:var(--space-4);animation:fadeIn 0.15s ease;
  `;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  const modal = document.createElement('div');
  modal.style.cssText = `
    background:var(--color-bg);border-radius:var(--radius-lg);
    width:100%;max-width:860px;max-height:90vh;
    display:flex;flex-direction:column;
    box-shadow:var(--shadow-2xl);overflow:hidden;
  `;
  modal.innerHTML = `
    <div id="pa-header" style="display:flex;align-items:center;justify-content:space-between;
      padding:14px 20px;border-bottom:1px solid var(--color-border);flex-shrink:0;
      background:var(--color-surface);">
      <div style="display:flex;align-items:center;gap:10px;">
        <span style="font-size:1.3rem;">📊</span>
        <div>
          <div style="font-size:var(--text-lg);font-weight:var(--weight-bold);line-height:1.2;" id="pa-title">Analytics</div>
          <div style="font-size:var(--text-xs);color:var(--color-text-muted);" id="pa-subtitle">Project Intelligence</div>
        </div>
      </div>
      <button id="pa-close" style="background:none;border:none;cursor:pointer;font-size:1.3rem;
        color:var(--color-text-muted);padding:6px 10px;border-radius:var(--radius-md);
        transition:background 0.12s;" onmouseover="this.style.background='var(--color-surface-2)'"
        onmouseout="this.style.background='none'">✕</button>
    </div>
    <div id="pa-tabs" style="display:flex;border-bottom:1px solid var(--color-border);
      flex-shrink:0;background:var(--color-surface);padding:0 20px;gap:2px;">
      ${['overview','timeline','team','badges'].map((t,i) => `
        <button class="pa-tab" data-tab="${t}" style="
          padding:10px 16px;font-size:var(--text-sm);font-weight:var(--weight-medium);
          border:none;cursor:pointer;border-bottom:2px solid ${i===0?'var(--color-accent)':'transparent'};
          background:none;color:${i===0?'var(--color-accent)':'var(--color-text-muted)'};
          transition:all 0.12s;white-space:nowrap;
        ">
          ${t==='overview'?'📈 Overview':t==='timeline'?'📅 Timeline':t==='team'?'👥 Team':'🏆 Badges'}
        </button>
      `).join('')}
    </div>
    <div id="pa-body" style="flex:1;overflow-y:auto;padding:20px;">
      <div style="color:var(--color-text-muted);text-align:center;padding:40px;">
        <div style="font-size:2rem;margin-bottom:8px;">⏳</div>
        Loading analytics…
      </div>
    </div>
  `;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Wire close
  modal.querySelector('#pa-close').addEventListener('click', () => overlay.remove());
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); }
  });

  // Wire tabs
  let _activeTab = 'overview';
  const proj       = _projects.find(p => p.id === projectId);
  const projTasks  = _getProjectTasks(projectId);

  // Load gamification data
  let gamState = null, projStreak = null, leaderboard = null, memberStats = {};
  try {
    [gamState, projStreak, leaderboard] = await Promise.all([
      getGamificationState(),
      getProjectStreak(projectId),
      getLeaderboard(),
    ]);
    // Load per-member stats for team members
    const members = _projectMemberEdgeMap.get(projectId) || [];
    for (const mid of members) {
      memberStats[mid] = await getMemberStats(mid).catch(() => null);
    }
  } catch(e) { console.warn('[analytics] gamification load error', e); }

  if (proj) {
    modal.querySelector('#pa-title').textContent   = proj.name || proj.title || 'Project';
    modal.querySelector('#pa-subtitle').textContent = `${proj.status || 'Active'} · ${projTasks.length} tasks`;
  }

  async function renderTab(tab) {
    _activeTab = tab;
    modal.querySelectorAll('.pa-tab').forEach(btn => {
      const active = btn.dataset.tab === tab;
      btn.style.borderBottomColor = active ? 'var(--color-accent)' : 'transparent';
      btn.style.color             = active ? 'var(--color-accent)' : 'var(--color-text-muted)';
      btn.style.fontWeight        = active ? 'var(--weight-semibold)' : 'var(--weight-medium)';
    });
    const body = modal.querySelector('#pa-body');
    body.innerHTML = '';
    try {
      if (tab === 'overview')  { body.innerHTML = _buildOverviewHTML(proj, projTasks, projStreak); _renderAllCharts(body, projTasks, proj); }
      if (tab === 'timeline')  { body.innerHTML = _buildTimelineHTML(proj, projTasks); _renderTimelineCharts(body, projTasks, proj); }
      if (tab === 'team')      { body.innerHTML = _buildTeamHTML(proj, projectId, leaderboard, memberStats); }
      if (tab === 'badges')    { body.innerHTML = _buildBadgesHTML(gamState, leaderboard, projStreak); }
    } catch(err) {
      body.innerHTML = `<div style="color:var(--color-danger);padding:20px;">Error: ${_esc(err.message)}</div>`;
      console.error('[analytics] tab render error:', err);
    }
  }

  modal.querySelectorAll('.pa-tab').forEach(btn => {
    btn.addEventListener('click', () => renderTab(btn.dataset.tab));
  });

  await renderTab('overview');
}

// ── Overview Tab ──────────────────────────────────────────────────
function _buildOverviewHTML(proj, tasks, projStreak) {
  if (!proj) return '<div style="color:var(--color-text-muted);text-align:center;padding:40px;">Project not found.</div>';

  const total    = tasks.length;
  const done     = tasks.filter(t => _isTaskDone(t)).length;
  const inProg   = tasks.filter(t => t.status === 'In Progress' || t.status === 'Next Up').length;
  const blocked  = tasks.filter(t => t.blocked).length;
  const overdue  = tasks.filter(t => _isOverdue(t.dueDate) && !_isTaskDone(t)).length;
  const pct      = total > 0 ? Math.round((done / total) * 100) : 0;
  const health   = _computeHealthScore(proj, tasks);
  const hColor   = _healthColor(health);
  const hLabel   = _healthLabel(health);

  // Days remaining
  const today = new Date(); today.setHours(0,0,0,0);
  let daysRemaining = null, dlStr = 'No deadline', dlOverdue = false;
  if (proj.deadline) {
    const dl = new Date(proj.deadline + 'T00:00:00');
    daysRemaining = Math.round((dl - today) / 86400000);
    dlStr = dl.toLocaleDateString(undefined, {month:'short',day:'numeric',year:'numeric'});
    dlOverdue = daysRemaining < 0;
  }

  // Velocity: tasks completed in last 7 days
  const SEVEN_DAYS = 7*86400000;
  const recentDone = tasks.filter(t => _isTaskDone(t) && t.updatedAt &&
    (Date.now() - new Date(t.updatedAt).getTime()) < SEVEN_DAYS).length;

  // Predicted completion
  let predicted = '';
  if (total > done && recentDone > 0) {
    const remaining = total - done;
    const daysToComplete = Math.ceil(remaining / (recentDone / 7));
    const pd = new Date(); pd.setDate(pd.getDate() + daysToComplete);
    predicted = pd.toLocaleDateString(undefined, {month:'short',day:'numeric'});
  } else if (done === total && total > 0) {
    predicted = '✓ Complete';
  }

  // Risk signals
  const risks = [];
  if (overdue > 0)  risks.push({ icon:'🚨', msg:`${overdue} overdue task${overdue>1?'s':''}`, sev:'danger' });
  if (blocked > 0)  risks.push({ icon:'🔒', msg:`${blocked} blocked task${blocked>1?'s':''}`, sev:'warning' });
  if (dlOverdue)    risks.push({ icon:'📅', msg:'Project deadline passed', sev:'danger' });
  if (recentDone === 0 && done < total) risks.push({ icon:'😴', msg:'No activity in 7 days', sev:'warning' });
  if (daysRemaining !== null && daysRemaining <= 7 && done < total)
    risks.push({ icon:'⏰', msg:'Less than 7 days to deadline', sev:'warning' });

  const streak = projStreak || { current: 0, best: 0 };

  const SEV_COLORS = { danger:'var(--color-danger)', warning:'var(--color-warning)' };
  const SEV_BG     = { danger:'var(--color-danger-bg)', warning:'var(--color-warning-bg)' };

  const PRIO_COLORS = { Critical:'#dc2626', High:'#f97316', Medium:'#f59e0b', Low:'#6b7280' };
  const STATUS_COLORS = { 'Not Started':'#94a3b8','Next Up':'#60a5fa','In Progress':'#3b82f6','Blocked':'#ef4444','Done':'#10b981' };
  const STATUS_LIST   = ['Not Started','Next Up','In Progress','Blocked','Done'];
  const statusCount   = {}; STATUS_LIST.forEach(s => { statusCount[s] = tasks.filter(t => (t.status||'Not Started')===s).length; });
  const PRIOS         = ['Critical','High','Medium','Low'];
  const prioCount     = {}; PRIOS.forEach(p => { prioCount[p] = tasks.filter(t=>t.priority===p&&!_isTaskDone(t)).length; });

  return `
    <!-- Hero metrics row -->
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;margin-bottom:20px;">
      <!-- Health score -->
      <div style="grid-column:1;padding:16px;background:var(--color-surface);border-radius:var(--radius-lg);
        border:1px solid var(--color-border);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;">
        ${_healthRingSvg(health)}
        <div style="font-size:var(--text-xs);font-weight:var(--weight-semibold);color:${hColor};text-transform:uppercase;letter-spacing:0.06em;">${hLabel}</div>
        <div style="font-size:10px;color:var(--color-text-muted);">Health Score</div>
      </div>
      <!-- Progress -->
      <div style="padding:16px;background:var(--color-surface);border-radius:var(--radius-lg);border:1px solid var(--color-border);">
        <div style="font-size:2rem;font-weight:var(--weight-bold);color:${hColor};line-height:1;">${pct}%</div>
        <div style="font-size:var(--text-xs);color:var(--color-text-muted);margin:4px 0 10px;">Complete</div>
        <div style="height:6px;background:var(--color-surface-2);border-radius:99px;overflow:hidden;">
          <div style="height:100%;width:${pct}%;background:${hColor};border-radius:99px;"></div>
        </div>
        <div style="font-size:10px;color:var(--color-text-muted);margin-top:6px;">${done} of ${total} tasks</div>
      </div>
      <!-- Deadline -->
      <div style="padding:16px;background:var(--color-surface);border-radius:var(--radius-lg);border:1px solid var(--color-border);">
        <div style="font-size:1.4rem;font-weight:var(--weight-bold);
          color:${dlOverdue?'var(--color-danger)':daysRemaining!==null&&daysRemaining<=7?'var(--color-warning)':'var(--color-text)'};line-height:1;">
          ${daysRemaining===null?'—':Math.abs(daysRemaining)}
        </div>
        <div style="font-size:var(--text-xs);color:var(--color-text-muted);margin:4px 0 6px;">
          ${daysRemaining===null?'No deadline':dlOverdue?'days overdue':'days left'}
        </div>
        <div style="font-size:10px;color:var(--color-text-muted);">${dlStr}</div>
        ${predicted?`<div style="font-size:10px;color:var(--color-text-muted);margin-top:4px;">Est. done: <strong>${_esc(predicted)}</strong></div>`:''}
      </div>
      <!-- Streak -->
      <div style="padding:16px;background:var(--color-surface);border-radius:var(--radius-lg);border:1px solid var(--color-border);">
        <div style="font-size:1.8rem;line-height:1;">${streak.current >= 3 ? '🔥' : '📆'}</div>
        <div style="font-size:1.4rem;font-weight:var(--weight-bold);color:${streak.current>=7?'#f97316':streak.current>=3?'#f59e0b':'var(--color-text)'};margin:4px 0 2px;">${streak.current}d</div>
        <div style="font-size:var(--text-xs);color:var(--color-text-muted);">Current streak</div>
        <div style="font-size:10px;color:var(--color-text-muted);margin-top:4px;">Best: ${streak.best}d</div>
      </div>
    </div>

    <!-- Secondary metrics -->
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px;">
      ${[
        { icon:'⚡', val:inProg,     label:'In Progress', c:inProg>0?'#3b82f6':'var(--color-text-muted)' },
        { icon:'🚨', val:overdue,    label:'Overdue',     c:overdue>0?'var(--color-danger)':'var(--color-text-muted)' },
        { icon:'🔒', val:blocked,    label:'Blocked',     c:blocked>0?'var(--color-warning)':'var(--color-text-muted)' },
        { icon:'📈', val:recentDone, label:'This Week',   c:recentDone>0?'var(--color-success)':'var(--color-text-muted)' },
      ].map(m=>`
        <div style="padding:12px;background:var(--color-surface);border-radius:var(--radius-md);border:1px solid var(--color-border);text-align:center;">
          <div style="font-size:1.1rem;margin-bottom:4px;">${m.icon}</div>
          <div style="font-size:1.4rem;font-weight:var(--weight-bold);color:${m.c};">${m.val}</div>
          <div style="font-size:10px;color:var(--color-text-muted);">${m.label}</div>
        </div>
      `).join('')}
    </div>

    <!-- Risk signals -->
    ${risks.length > 0 ? `
    <div style="margin-bottom:20px;">
      <div style="font-size:var(--text-xs);font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:var(--color-text-muted);margin-bottom:8px;">⚠ Risk Signals</div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        ${risks.map(r=>`
          <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;
            background:${SEV_BG[r.sev]};border-radius:var(--radius-md);
            border-left:3px solid ${SEV_COLORS[r.sev]};">
            <span>${r.icon}</span>
            <span style="font-size:var(--text-sm);color:${SEV_COLORS[r.sev]};font-weight:var(--weight-medium);">${_esc(r.msg)}</span>
          </div>
        `).join('')}
      </div>
    </div>` : `
    <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--color-success-bg);
      border-radius:var(--radius-md);border-left:3px solid var(--color-success);margin-bottom:20px;">
      <span>✅</span><span style="font-size:var(--text-sm);color:var(--color-success-text);font-weight:500;">No risk signals — project is on track</span>
    </div>`}

    <!-- Status breakdown -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">
      <div>
        <div style="font-size:var(--text-xs);font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:var(--color-text-muted);margin-bottom:10px;">Status Breakdown</div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${STATUS_LIST.filter(s=>statusCount[s]>0).map(s => {
            const cnt  = statusCount[s];
            const pctS = total > 0 ? Math.round((cnt/total)*100) : 0;
            const col  = STATUS_COLORS[s]||'#94a3b8';
            return `
              <div>
                <div style="display:flex;justify-content:space-between;margin-bottom:3px;">
                  <span style="font-size:var(--text-xs);color:var(--color-text-muted);">${s}</span>
                  <span style="font-size:var(--text-xs);font-weight:600;color:${col};">${cnt}</span>
                </div>
                <div style="height:7px;background:var(--color-surface-2);border-radius:99px;overflow:hidden;">
                  <div style="height:100%;width:${pctS}%;background:${col};border-radius:99px;"></div>
                </div>
              </div>`;
          }).join('')}
          ${STATUS_LIST.every(s=>!statusCount[s])?'<div style="color:var(--color-text-muted);font-size:var(--text-sm);">No tasks yet</div>':''}
        </div>
      </div>
      <div>
        <div style="font-size:var(--text-xs);font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:var(--color-text-muted);margin-bottom:10px;">Open Tasks by Priority</div>
        ${PRIOS.some(p=>prioCount[p]>0) ? `<div style="display:flex;flex-direction:column;gap:8px;">
          ${PRIOS.filter(p=>prioCount[p]>0).map(p => {
            const cnt  = prioCount[p];
            const open = tasks.filter(t=>!_isTaskDone(t)).length;
            const pctP = open > 0 ? Math.round((cnt/open)*100) : 0;
            return `
              <div>
                <div style="display:flex;justify-content:space-between;margin-bottom:3px;">
                  <span style="font-size:var(--text-xs);color:${PRIO_COLORS[p]};">${p}</span>
                  <span style="font-size:var(--text-xs);font-weight:600;color:${PRIO_COLORS[p]};">${cnt}</span>
                </div>
                <div style="height:7px;background:var(--color-surface-2);border-radius:99px;overflow:hidden;">
                  <div style="height:100%;width:${pctP}%;background:${PRIO_COLORS[p]};border-radius:99px;"></div>
                </div>
              </div>`;
          }).join('')}</div>` : '<div style="color:var(--color-text-muted);font-size:var(--text-sm);">No open tasks</div>'}
      </div>
    </div>

    <!-- Completion velocity chart -->
    <div style="margin-bottom:16px;">
      <div style="font-size:var(--text-xs);font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:var(--color-text-muted);margin-bottom:8px;">Completion Velocity</div>
      <canvas id="pa-velocity-canvas" height="140" style="width:100%;display:block;border-radius:var(--radius-md);background:var(--color-surface);border:1px solid var(--color-border);"></canvas>
    </div>

    <!-- Goal -->
    ${proj.goal ? `
    <div style="padding:14px 16px;background:var(--color-surface);border-radius:var(--radius-md);
      border-left:3px solid var(--color-accent);">
      <div style="font-size:10px;font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:var(--color-accent);margin-bottom:6px;">🎯 Project Goal</div>
      <div style="font-size:var(--text-sm);color:var(--color-text);line-height:1.6;">${_esc(proj.goal)}</div>
    </div>` : ''}
  `;
}

// ── Timeline Tab ──────────────────────────────────────────────────
function _buildTimelineHTML(proj, tasks) {
  const hasTasks = tasks.length > 0;
  return `
    <div style="margin-bottom:20px;">
      <div style="font-size:var(--text-xs);font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:var(--color-text-muted);margin-bottom:8px;">Cumulative Completions</div>
      <canvas id="pa-burndown-canvas" height="180" style="width:100%;display:block;border-radius:var(--radius-md);background:var(--color-surface);border:1px solid var(--color-border);"></canvas>
    </div>
    <div style="margin-bottom:20px;">
      <div style="font-size:var(--text-xs);font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:var(--color-text-muted);margin-bottom:8px;">Weekly Activity Heatmap</div>
      <div id="pa-heatmap" style="overflow-x:auto;"></div>
    </div>
    <div>
      <div style="font-size:var(--text-xs);font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:var(--color-text-muted);margin-bottom:10px;">Task History</div>
      <div style="display:flex;flex-direction:column;gap:6px;max-height:280px;overflow-y:auto;">
        ${tasks.filter(t=>_isTaskDone(t)).sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||'')).slice(0,20).map(t=>{
          const d = (t.completedAt||t.updatedAt||'').slice(0,10);
          const PRIO_C = { Critical:'#dc2626',High:'#f97316',Medium:'#f59e0b',Low:'#6b7280' };
          return `<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;
            background:var(--color-surface);border-radius:var(--radius-md);border:1px solid var(--color-border);">
            <span style="font-size:0.9rem;">✅</span>
            <div style="flex:1;min-width:0;">
              <div style="font-size:var(--text-sm);font-weight:500;color:var(--color-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_esc(t.title||t.name||'Task')}</div>
              ${t.priority?`<div style="font-size:10px;color:${PRIO_C[t.priority]||'#94a3b8'};">${t.priority}</div>`:''}
            </div>
            <div style="font-size:10px;color:var(--color-text-muted);flex-shrink:0;">${d}</div>
          </div>`;
        }).join('')}
        ${tasks.filter(t=>_isTaskDone(t)).length===0?'<div style="color:var(--color-text-muted);font-size:var(--text-sm);text-align:center;padding:20px;">No completed tasks yet</div>':''}
      </div>
    </div>
  `;
}

// ── Team Tab ──────────────────────────────────────────────────────
function _buildTeamHTML(proj, projectId, leaderboard, memberStats) {
  const memberIds = _projectMemberEdgeMap.get(projectId) || [];
  if (memberIds.length === 0) {
    return `<div style="text-align:center;padding:40px;color:var(--color-text-muted);">
      <div style="font-size:3rem;margin-bottom:12px;">👥</div>
      <div style="font-size:var(--text-md);font-weight:500;">No team members assigned</div>
      <div style="font-size:var(--text-sm);margin-top:6px;">Add members to this project via the entity panel</div>
    </div>`;
  }

  const lbByMember = new Map((leaderboard||[]).map(r=>[r.memberId, r]));
  return `
    <div style="margin-bottom:20px;">
      <div style="font-size:var(--text-xs);font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:var(--color-text-muted);margin-bottom:12px;">Family Leaderboard</div>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${(leaderboard||[]).slice(0,8).map((r,i)=>{
          const lv = r;
          const isMember = memberIds.includes(r.memberId);
          return `
          <div style="display:flex;align-items:center;gap:12px;padding:12px 14px;
            background:${isMember?'var(--color-accent-muted)':'var(--color-surface)'};
            border-radius:var(--radius-md);border:1px solid ${isMember?'var(--color-accent)':'var(--color-border)'};
            ${isMember?'box-shadow:0 0 0 2px var(--color-accent)22;':''}">
            <div style="width:24px;height:24px;border-radius:50%;background:${i===0?'#f59e0b':i===1?'#94a3b8':i===2?'#b45309':'var(--color-surface-2)'};
              display:flex;align-items:center;justify-content:center;font-size:0.75rem;font-weight:700;color:#fff;flex-shrink:0;">
              ${i===0?'🥇':i===1?'🥈':i===2?'🥉':i+1}
            </div>
            <div style="width:32px;height:32px;border-radius:50%;background:var(--color-accent-muted);
              display:flex;align-items:center;justify-content:center;font-size:1.2rem;flex-shrink:0;">
              ${r.avatar||'👤'}
            </div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:var(--text-sm);font-weight:600;color:var(--color-text);">${_esc(r.name)}</div>
              <div style="font-size:10px;color:var(--color-text-muted);">${r.levelIcon} ${r.levelTitle} · Lv ${r.level}</div>
            </div>
            <div style="text-align:right;flex-shrink:0;">
              <div style="font-size:var(--text-sm);font-weight:700;color:var(--color-accent);">${r.xp.toLocaleString()} XP</div>
              <div style="font-size:10px;color:var(--color-text-muted);">${r.tasksDone} tasks · ${r.badges} badges</div>
            </div>
          </div>`;
        }).join('')}
        ${(leaderboard||[]).length===0?'<div style="color:var(--color-text-muted);text-align:center;padding:20px;">No leaderboard data yet — complete some tasks!</div>':''}
      </div>
    </div>

    <!-- Project members detail -->
    <div>
      <div style="font-size:var(--text-xs);font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:var(--color-text-muted);margin-bottom:12px;">Project Members</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;">
        ${memberIds.map(mid => {
          const lb  = lbByMember.get(mid);
          const ms  = memberStats[mid];
          if (!lb) return `<div style="padding:14px;background:var(--color-surface);border-radius:var(--radius-md);border:1px solid var(--color-border);">
            <div style="font-size:var(--text-xs);color:var(--color-text-muted);">Member ID: ${_esc(mid.slice(0,8))}…</div></div>`;
          const nxt = ms?.nextLevel;
          const xpPct = nxt ? Math.round(((ms.xp - (ms.level?.xp||0)) / (nxt.xp - (ms.level?.xp||0))) * 100) : 100;
          return `
          <div style="padding:14px;background:var(--color-surface);border-radius:var(--radius-lg);border:1px solid var(--color-border);">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
              <div style="width:36px;height:36px;border-radius:50%;background:var(--color-accent-muted);
                display:flex;align-items:center;justify-content:center;font-size:1.3rem;">${lb.avatar||'👤'}</div>
              <div>
                <div style="font-size:var(--text-sm);font-weight:600;color:var(--color-text);">${_esc(lb.name)}</div>
                <div style="font-size:10px;color:var(--color-text-muted);">${lb.levelIcon} Lv ${lb.level}</div>
              </div>
            </div>
            <div style="margin-bottom:8px;">
              <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--color-text-muted);margin-bottom:3px;">
                <span>${lb.xp.toLocaleString()} XP</span>
                ${nxt?`<span>→ Lv ${nxt.level}: ${nxt.xp.toLocaleString()}</span>`:'<span>Max Level</span>'}
              </div>
              <div style="height:5px;background:var(--color-surface-2);border-radius:99px;overflow:hidden;">
                <div style="height:100%;width:${Math.min(xpPct,100)}%;background:var(--color-accent);border-radius:99px;"></div>
              </div>
            </div>
            <div style="display:flex;gap:6px;font-size:10px;color:var(--color-text-muted);">
              <span>✅ ${lb.tasksDone}</span>
              <span>🏅 ${lb.badges}</span>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>
  `;
}

// ── Badges Tab ────────────────────────────────────────────────────
function _buildBadgesHTML(gamState, leaderboard, projStreak) {
  const allEarned = new Set();
  for (const m of Object.values(gamState?.members||{})) {
    (m.earnedBadgeIds||[]).forEach(id => allEarned.add(id));
  }

  // Group badges
  const groups = [
    { label:'🏁 Task Milestones', ids:['first_task','tasks_10','tasks_50','tasks_100','tasks_250','tasks_500'] },
    { label:'🔥 Streaks',          ids:['streak_3','streak_7','streak_14','streak_30'] },
    { label:'🚀 Projects',         ids:['proj_first','proj_5','proj_on_time','proj_speedrun'] },
    { label:'🚨 Priority',         ids:['critical_5','critical_20'] },
    { label:'⭐ Levels',           ids:['level_5','level_10','level_15'] },
  ];

  const streak = projStreak || { current: 0, best: 0 };

  return `
    <!-- Streak spotlight -->
    <div style="display:flex;align-items:center;gap:14px;padding:16px 20px;
      background:${streak.current>=3?'linear-gradient(135deg,#f97316 0%,#f59e0b 100%)':'var(--color-surface)'};
      border-radius:var(--radius-lg);border:1px solid ${streak.current>=3?'transparent':'var(--color-border)'};
      margin-bottom:24px;color:${streak.current>=3?'#fff':'var(--color-text)'};">
      <div style="font-size:3rem;line-height:1;">${streak.current>=7?'🔥':streak.current>=3?'⚡':'📅'}</div>
      <div>
        <div style="font-size:1.6rem;font-weight:var(--weight-bold);line-height:1;">${streak.current} day${streak.current!==1?'s':''}</div>
        <div style="font-size:var(--text-sm);opacity:${streak.current>=3?0.9:1};color:${streak.current>=3?'inherit':'var(--color-text-muted)'};">
          ${streak.current===0?'Start your streak by completing a task today':'Current project streak'}
        </div>
        <div style="font-size:10px;opacity:0.75;margin-top:2px;">All-time best: ${streak.best} days</div>
      </div>
    </div>

    <!-- Badge groups -->
    ${groups.map(group => `
      <div style="margin-bottom:20px;">
        <div style="font-size:var(--text-xs);font-weight:700;letter-spacing:0.07em;text-transform:uppercase;
          color:var(--color-text-muted);margin-bottom:10px;">${group.label}</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;">
          ${group.ids.map(id => {
            const def    = BADGE_DEFS.find(b=>b.id===id);
            const earned = allEarned.has(id);
            if (!def) return '';
            return `
            <div style="padding:12px;background:${earned?def.color+'14':'var(--color-surface)'};
              border-radius:var(--radius-md);border:1.5px solid ${earned?def.color:'var(--color-border)'};
              opacity:${earned?1:0.45};text-align:center;transition:all 0.2s;
              ${earned?'box-shadow:0 2px 8px '+def.color+'28;':''}">
              <div style="font-size:1.8rem;margin-bottom:6px;">${def.icon}</div>
              <div style="font-size:var(--text-xs);font-weight:${earned?600:400};color:${earned?def.color:'var(--color-text-muted)'};line-height:1.3;">${def.label}</div>
              <div style="font-size:10px;color:var(--color-text-muted);margin-top:4px;line-height:1.3;">${def.desc}</div>
              ${earned?`<div style="font-size:10px;font-weight:700;color:${def.color};margin-top:6px;">✓ Earned</div>`:''}
            </div>`;
          }).join('')}
        </div>
      </div>
    `).join('')}

    <!-- Family total badges -->
    <div style="padding:14px 16px;background:var(--color-surface);border-radius:var(--radius-md);border:1px solid var(--color-border);display:flex;align-items:center;justify-content:space-between;">
      <div style="font-size:var(--text-sm);color:var(--color-text-muted);">Family badges earned</div>
      <div style="font-size:var(--text-lg);font-weight:var(--weight-bold);color:var(--color-accent);">
        ${allEarned.size} / ${BADGE_DEFS.length}
      </div>
    </div>
  `;
}

// ── Chart renderers ───────────────────────────────────────────────
function _renderAllCharts(body, tasks, proj) {
  _renderVelocityChart(body.querySelector('#pa-velocity-canvas'), tasks);
}

function _renderTimelineCharts(body, tasks, proj) {
  _renderBurndownChart(body.querySelector('#pa-burndown-canvas'), tasks);
  _renderHeatmap(body.querySelector('#pa-heatmap'), tasks);
}

function _renderVelocityChart(canvas, tasks) {
  if (!canvas) return;
  const W = canvas.offsetWidth || 800; const H = 140;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Build weekly buckets: completions per week over last 10 weeks
  const WEEKS = 10;
  const now = new Date(); now.setHours(0,0,0,0);
  const buckets = Array.from({length:WEEKS}, (_,i) => {
    const end = new Date(now); end.setDate(end.getDate() - i*7);
    const start = new Date(end); start.setDate(start.getDate() - 7);
    const count = tasks.filter(t => {
      if (!_isTaskDone(t)) return false;
      const d = new Date(t.updatedAt||'');
      return !isNaN(d) && d >= start && d < end;
    }).length;
    const label = end.toLocaleDateString(undefined,{month:'short',day:'numeric'});
    return { label, count };
  }).reverse();

  const maxVal = Math.max(...buckets.map(b=>b.count), 1);
  const PAD = {top:16, right:16, bottom:28, left:32};
  const cW = W - PAD.left - PAD.right;
  const cH = H - PAD.top  - PAD.bottom;
  const barW = cW / WEEKS * 0.6;
  const barGap = cW / WEEKS;

  // Grid
  ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 1;
  [0,0.5,1].forEach(f => {
    const y = PAD.top + cH - f*cH;
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(W-PAD.right, y); ctx.stroke();
    ctx.fillStyle='#94a3b8'; ctx.font='10px sans-serif'; ctx.textAlign='right';
    ctx.fillText(Math.round(f*maxVal), PAD.left-4, y+3);
  });

  // Bars with gradient
  buckets.forEach(({label,count},i) => {
    const x = PAD.left + i*barGap + (barGap-barW)/2;
    const bH = cH * (count/maxVal);
    const y  = PAD.top + cH - bH;
    const grad = ctx.createLinearGradient(x, y, x, y+bH);
    grad.addColorStop(0, '#3b82f6');
    grad.addColorStop(1, '#3b82f680');
    ctx.fillStyle = count > 0 ? grad : '#e2e8f0';
    const r = Math.min(4, barW/2);
    ctx.beginPath();
    ctx.moveTo(x+r,y); ctx.lineTo(x+barW-r,y);
    ctx.arcTo(x+barW,y,x+barW,y+r,r);
    ctx.lineTo(x+barW,y+bH); ctx.lineTo(x,y+bH);
    ctx.arcTo(x,y,x+r,y,r); ctx.closePath();
    ctx.fill();

    if (count > 0) {
      ctx.fillStyle='#1e293b'; ctx.font='bold 10px sans-serif'; ctx.textAlign='center';
      ctx.fillText(count, x+barW/2, y-3);
    }

    ctx.fillStyle='#94a3b8'; ctx.font='9px sans-serif'; ctx.textAlign='center';
    if (i%2===0) ctx.fillText(label.split(' ')[0], x+barW/2, H-4);
  });
}

function _renderBurndownChart(canvas, tasks) {
  if (!canvas) return;
  const W = canvas.offsetWidth || 800; const H = 180;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  const completed = tasks
    .filter(t => _isTaskDone(t) && (t.completedAt||t.updatedAt))
    .map(t => (t.completedAt||t.updatedAt||'').slice(0,10))
    .filter(Boolean).sort();

  if (completed.length === 0) {
    ctx.fillStyle='#94a3b8'; ctx.font='13px sans-serif'; ctx.textAlign='center';
    ctx.fillText('No completed tasks yet', W/2, H/2);
    return;
  }

  const dateMap = {};
  completed.forEach(d => { dateMap[d] = (dateMap[d]||0)+1; });
  const dates = Object.keys(dateMap).sort();
  let cum = 0;
  const points = dates.map(d => { cum += dateMap[d]; return {date:d, count:cum}; });

  const PAD = {top:16, right:16, bottom:32, left:40};
  const cW = W-PAD.left-PAD.right; const cH = H-PAD.top-PAD.bottom;
  const maxV = points[points.length-1].count;

  ctx.strokeStyle='#e2e8f0'; ctx.lineWidth=1;
  [0,0.25,0.5,0.75,1].forEach(f => {
    const y = PAD.top+cH-f*cH;
    ctx.beginPath(); ctx.moveTo(PAD.left,y); ctx.lineTo(W-PAD.right,y); ctx.stroke();
    ctx.fillStyle='#94a3b8'; ctx.font='10px sans-serif'; ctx.textAlign='right';
    ctx.fillText(Math.round(f*maxV), PAD.left-6, y+3);
  });

  const px = i => PAD.left + (i/Math.max(points.length-1,1))*cW;
  const py = v => PAD.top + cH - (v/maxV)*cH;

  // Fill
  ctx.beginPath();
  points.forEach(({count},i) => { i===0 ? ctx.moveTo(px(i),py(count)) : ctx.lineTo(px(i),py(count)); });
  ctx.lineTo(px(points.length-1), PAD.top+cH); ctx.lineTo(px(0), PAD.top+cH); ctx.closePath();
  ctx.fillStyle='rgba(59,130,246,0.12)'; ctx.fill();

  // Line
  ctx.beginPath(); ctx.strokeStyle='#3b82f6'; ctx.lineWidth=2.5; ctx.lineJoin='round';
  points.forEach(({count},i) => { i===0 ? ctx.moveTo(px(i),py(count)) : ctx.lineTo(px(i),py(count)); });
  ctx.stroke();

  // Dots
  ctx.fillStyle='#3b82f6';
  points.forEach(({count},i) => { ctx.beginPath(); ctx.arc(px(i),py(count),3.5,0,Math.PI*2); ctx.fill(); });

  // X labels
  ctx.fillStyle='#94a3b8'; ctx.font='10px sans-serif';
  ctx.textAlign='left';  if(dates.length>0) ctx.fillText(dates[0].slice(5), PAD.left, H-4);
  ctx.textAlign='right'; if(dates.length>1) ctx.fillText(dates[dates.length-1].slice(5), W-PAD.right, H-4);
}

function _renderHeatmap(container, tasks) {
  if (!container) return;
  // Build last 12 weeks heatmap
  const WEEKS = 12; const DAYS = 7;
  const today = new Date(); today.setHours(0,0,0,0);

  const countMap = {};
  tasks.filter(t => _isTaskDone(t) && (t.completedAt||t.updatedAt)).forEach(t => {
    const d = (t.completedAt||t.updatedAt||'').slice(0,10);
    countMap[d] = (countMap[d]||0)+1;
  });
  const maxCount = Math.max(...Object.values(countMap), 1);

  const cells = [];
  for (let w=WEEKS-1; w>=0; w--) {
    const week = [];
    for (let d=0; d<DAYS; d++) {
      const date = new Date(today);
      date.setDate(date.getDate() - w*7 - (today.getDay()-d+7)%7);
      const key = date.toISOString().slice(0,10);
      week.push({ key, count: countMap[key]||0, future: date > today });
    }
    cells.push(week);
  }

  const DAYS_LABEL = ['S','M','T','W','T','F','S'];
  const size = 14; const gap = 3;

  let html = `<div style="display:flex;gap:${gap}px;align-items:flex-start;">
    <div style="display:flex;flex-direction:column;gap:${gap}px;margin-top:18px;">
      ${DAYS_LABEL.map(l=>`<div style="height:${size}px;font-size:9px;color:var(--color-text-muted);line-height:${size}px;">${l}</div>`).join('')}
    </div>`;
  cells.forEach((week, wi) => {
    const firstDay = week[0];
    const monthLabel = wi===0 || (firstDay.key.slice(5,7) !== (cells[wi-1]?.[0]?.key.slice(5,7)||''))
      ? new Date(firstDay.key+'T00:00:00').toLocaleDateString(undefined,{month:'short'}) : '';
    html += `<div>
      <div style="height:16px;font-size:9px;color:var(--color-text-muted);text-align:center;">${monthLabel}</div>
      <div style="display:flex;flex-direction:column;gap:${gap}px;">
        ${week.map(cell => {
          const intensity = cell.future ? 0 : Math.min(cell.count/maxCount, 1);
          const bg = cell.future ? 'var(--color-surface)'
            : intensity===0 ? 'var(--color-surface-2)'
            : `rgba(59,130,246,${0.15 + intensity*0.85})`;
          const title = cell.future ? 'Future' : cell.count===0 ? 'No activity' : `${cell.count} task${cell.count>1?'s':''} on ${cell.key}`;
          return `<div title="${title}" style="width:${size}px;height:${size}px;border-radius:3px;background:${bg};
            border:1px solid var(--color-border);flex-shrink:0;cursor:default;"></div>`;
        }).join('')}
      </div>
    </div>`;
  });
  html += '</div>';
  container.innerHTML = html;
}

// ── Module-level listeners ─────────────────────────────────────
let _projRefreshTimer = null;
/** [v6.1.1] Auto-update project deadline to the latest task dueDate in real-time.
 *  Called whenever a task is saved (even without explicitly saving the project).
 *  Only writes if the new latest date differs from the current project deadline. */
async function _autoUpdateProjectDeadline(savedTask) {
  // Find which project this task belongs to
  const projId = savedTask.project || (() => {
    for (const [pid, ids] of _projectTaskEdgeMap) {
      if (ids.has(savedTask.id)) return pid;
    }
    return null;
  })();
  if (!projId) return;

  const proj = _projects.find(p => p.id === projId);
  if (!proj) return;

  // Gather all tasks for this project (including the just-saved one)
  const projTasks = _getProjectTasks(projId);
  // Also include the saved task (may not be in _tasks yet if first save)
  const allTasks  = projTasks.find(t => t.id === savedTask.id)
    ? projTasks
    : [...projTasks, savedTask];

  const validDates = allTasks
    .map(t => t.dueDate)
    .filter(d => d && /^\d{4}-\d{2}-\d{2}/.test(String(d)));

  if (validDates.length === 0) return;

  const latestDate = validDates.reduce((max, d) => d > max ? d : max, validDates[0]);

  // Only write if deadline actually changes
  if (proj.deadline === latestDate) return;

  const account = getAccount();
  const updated = { ...proj, deadline: latestDate };
  try {
    const saved = await saveEntity(updated, account?.id);
    // Update in-memory immediately for real-time feel
    const idx = _projects.findIndex(p => p.id === projId);
    if (idx >= 0) _projects[idx] = saved;
    console.log(`[projects] auto-deadline: ${proj.name} → ${latestDate}`);
  } catch (err) {
    console.warn('[projects] auto-deadline save failed:', err);
  }
}

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
    if (entity && !PROJ_REFRESH_TYPES.has(entity.type)) return;
    // [v6.1.1] Auto-update project deadline when a task dueDate changes
    if (entity?.type === 'task' && entity.dueDate) {
      _autoUpdateProjectDeadline(entity).catch(() => {});
    }
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
