/**
 * FamilyHub v6.3.0 — components/timer-panel.js
 * [MAJOR] Floating Timer Panel — full timer management hub.
 *
 * Features:
 *   - Quick-start launcher: search tasks by title/due date or create inbox task on-the-fly
 *   - Live session list: running, alarmed, paused sessions with controls
 *   - Block alarm center overlay (not a modal backdrop — click anywhere dismisses and continues)
 *   - Reassign inbox/on-the-fly sessions to a real task at any time before dismissal
 *   - Single stopwatch icon entry point (systray) — no duplicate topbar button
 */

import { emit, on, EVENTS }     from '../core/events.js';
import { navigate, VIEW_KEYS }  from '../core/router.js';

// ── Module state ───────────────────────────────────────── //
let _panel       = null;
let _tickUnsub   = null;
let _alarmUnsub  = null;
let _isOpen      = false;
let _tt          = null;

// Quick-start state
let _qs_tasks        = [];   // all non-done tasks, sorted by due
let _qs_filtered     = [];   // current filtered list
let _qs_query        = '';
let _qs_searchTimer  = null;

function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Lazy-load time-tracker ─────────────────────────────── //
async function _ensureTT() {
  if (_tt) return _tt;
  try { _tt = await import('../services/time-tracker.js'); } catch {}
  return _tt;
}

/**
 * [v6.4.4] Deduplicate sessions array.
 * If an inbox/freeRun session and a real-task session share the same taskTitle,
 * keep only the real-task session (non-inbox wins). This prevents a "quick timer"
 * with a label matching a task name from showing twice alongside the real session.
 */
function _dedupeSessions(sessions) {
  // Build a map of title → best session (real task beats inbox)
  const byTitle = new Map();
  for (const s of sessions) {
    const key = (s.taskTitle || '').trim().toLowerCase();
    if (!key) continue;
    const existing = byTitle.get(key);
    if (!existing) { byTitle.set(key, s); continue; }
    // Real task (not inbox) wins over inbox session
    if (existing.isInboxTask && !s.isInboxTask) byTitle.set(key, s);
  }
  // Return sessions that are the "winner" for their title, plus any with blank/unique titles
  const winners = new Set(byTitle.values());
  return sessions.filter(s => {
    const key = (s.taskTitle || '').trim().toLowerCase();
    if (!key) return true; // blank title — always show
    return winners.has(s);
  });
}

// ── Lazy-load tasks for quick-start ───────────────────── //
async function _loadTaskList() {
  try {
    const { getEntitiesByType } = await import('../core/db.js');
    const tasks = await getEntitiesByType('task');
    const DONE = new Set(['Done','done','Completed','completed','Cancelled','cancelled']);
    _qs_tasks = tasks
      .filter(t => !t.deleted && !DONE.has(t.status))
      .sort((a, b) => {
        // Sort by executionDate then dueDate then title
        const da = a.executionDate || a.dueDate || '9999';
        const db2 = b.executionDate || b.dueDate || '9999';
        return da < db2 ? -1 : da > db2 ? 1 : (a.title || '').localeCompare(b.title || '');
      });
    _qs_filtered = _qs_tasks.slice(0, 8);
  } catch { _qs_tasks = []; _qs_filtered = []; }
}

function _filterTasks(query) {
  const q = query.toLowerCase().trim();
  if (!q) { _qs_filtered = _qs_tasks.slice(0, 8); return; }
  _qs_filtered = _qs_tasks
    .filter(t => (t.title || '').toLowerCase().includes(q))
    .slice(0, 8);
}

// ── Panel DOM ──────────────────────────────────────────── //
function _buildPanel() {
  const el = document.createElement('div');
  el.id = 'timer-panel';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Timers');
  el.style.cssText = [
    'position:fixed;',
    'top:calc(var(--topbar-height) + var(--tab-bar-height,36px) + 8px);',
    'right:12px;',
    'width:340px;max-width:calc(100vw - 24px);',
    'background:var(--color-bg);',
    'border:1px solid var(--color-border);',
    'border-radius:var(--radius-lg);',
    'box-shadow:var(--shadow-xl,0 8px 32px rgba(0,0,0,.18));',
    'z-index:calc(var(--z-modal) + 5);',
    'overflow:hidden;display:flex;flex-direction:column;',
    'max-height:85dvh;',
  ].join('');
  return el;
}

// ── Quick-start launcher section ──────────────────────── //
function _buildQuickStart(container) {
  const wrap = document.createElement('div');
  wrap.id = 'tp-quickstart';
  wrap.style.cssText = [
    'padding:12px 14px 0;border-bottom:1px solid var(--color-border);',
    'flex-shrink:0;',
  ].join('');

  // Section label
  const lbl = document.createElement('div');
  lbl.style.cssText = 'font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--color-text-muted);margin-bottom:8px;';
  lbl.textContent = '▶ Quick Start Timer';
  wrap.appendChild(lbl);

  // Search input
  const searchRow = document.createElement('div');
  searchRow.style.cssText = 'display:flex;gap:6px;align-items:center;';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Search tasks…';
  input.id = 'tp-qs-input';
  input.setAttribute('autocomplete', 'off');
  input.style.cssText = [
    'flex:1;padding:6px 10px;border:1px solid var(--color-border);',
    'border-radius:var(--radius-md);background:var(--color-surface);',
    'color:var(--color-text);font-size:var(--text-sm);outline:none;',
  ].join('');

  searchRow.appendChild(input);
  wrap.appendChild(searchRow);

  // Dropdown list
  const dropdown = document.createElement('div');
  dropdown.id = 'tp-qs-dropdown';
  dropdown.style.cssText = [
    'max-height:180px;overflow-y:auto;margin:4px 0 0;',
    'border:1px solid var(--color-border);border-radius:var(--radius-md);',
    'background:var(--color-bg);display:none;',
  ].join('');
  wrap.appendChild(dropdown);

  // Inbox task row (always visible below search)
  const inboxRow = document.createElement('div');
  inboxRow.style.cssText = 'padding:8px 0 10px;';
  inboxRow.innerHTML = `
    <div style="font-size:var(--text-xs);color:var(--color-text-muted);margin-bottom:4px;">
      — or start without a task —
    </div>
    <div style="display:flex;gap:6px;align-items:center;">
      <input id="tp-inbox-title" type="text" placeholder="Quick timer label (optional)"
        style="flex:1;padding:5px 9px;border:1px solid var(--color-border);border-radius:var(--radius-md);
               background:var(--color-surface);color:var(--color-text);font-size:var(--text-sm);outline:none;" />
      <button id="tp-inbox-start" style="
        padding:5px 12px;border-radius:var(--radius-md);border:none;
        background:var(--color-accent);color:#fff;font-size:var(--text-xs);
        font-weight:600;cursor:pointer;white-space:nowrap;">
        ▶ Start
      </button>
    </div>
  `;
  wrap.appendChild(inboxRow);

  container.appendChild(wrap);

  // ── Wire events ──

  // Debounced search
  input.addEventListener('focus', async () => {
    if (_qs_tasks.length === 0) await _loadTaskList();
    _filterTasks(input.value);
    _renderDropdown(dropdown, input);
    dropdown.style.display = 'block';
  });

  input.addEventListener('input', () => {
    clearTimeout(_qs_searchTimer);
    _qs_searchTimer = setTimeout(() => {
      _filterTasks(input.value);
      _renderDropdown(dropdown, input);
      dropdown.style.display = 'block';
    }, 120);
  });

  input.addEventListener('blur', () => {
    // Delay hide so click on item fires first
    setTimeout(() => { dropdown.style.display = 'none'; }, 180);
  });

  // Inbox start
  container.querySelector('#tp-inbox-start').addEventListener('click', async () => {
    const label = container.querySelector('#tp-inbox-title').value.trim() || 'Quick Timer';
    const tt = await _ensureTT();
    if (!tt) return;
    const tempId = 'inbox-' + Date.now();
    await tt.startInboxTimer(tempId, label);
    container.querySelector('#tp-inbox-title').value = '';
    await _render();
  });
}

function _renderDropdown(dropdown, input) {
  dropdown.innerHTML = '';
  if (_qs_filtered.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:10px 12px;color:var(--color-text-muted);font-size:var(--text-sm);';
    empty.textContent = 'No matching tasks';
    dropdown.appendChild(empty);
    return;
  }
  for (const task of _qs_filtered) {
    const item = document.createElement('div');
    item.style.cssText = [
      'padding:8px 12px;cursor:pointer;font-size:var(--text-sm);',
      'border-bottom:1px solid var(--color-border);',
      'transition:background 0.1s;',
    ].join('');
    const due = task.executionDate || task.dueDate;
    const dueStr = due ? `<span style="color:var(--color-text-muted);font-size:var(--text-xs);margin-left:6px;">${_esc(due)}</span>` : '';
    item.innerHTML = `<span style="font-weight:500;">${_esc(task.title)}</span>${dueStr}`;
    item.addEventListener('mouseenter', () => item.style.background = 'var(--color-surface)');
    item.addEventListener('mouseleave', () => item.style.background = '');
    item.addEventListener('mousedown', async (e) => {
      e.preventDefault(); // prevent blur before click
      dropdown.style.display = 'none';
      input.value = '';
      const tt = await _ensureTT();
      if (!tt) return;
      await tt.startFreeRun(task.id, task);
      await _render();
    });
    dropdown.appendChild(item);
  }
}

// ── Main render ────────────────────────────────────────── //

/**
 * [v6.3.1 fix Bug 7] Lightweight re-render: rebuild only the session list,
 * preserving the quick-start section's input focus and typed text.
 * Called by alarm/saved/tick structural changes when panel is already open.
 */
async function _renderSessionList() {
  if (!_panel || !_isOpen) return;
  const tt = await _ensureTT();
  if (!tt) return;

  const _rawSessions = _dedupeSessions(Object.values(tt.sessionsSignal.value || {}));
  const alarmed  = _rawSessions.filter(s => s.alarmed);
  const active   = _rawSessions.filter(s => s.running && !s.alarmed);
  const paused   = _rawSessions.filter(s => !s.running && !s.alarmed);
  const allSessions = [...alarmed, ...active, ...paused];

  // Update the session count in the header
  const total = allSessions.length;
  const countEl = _panel.querySelector('#tp-session-count');
  if (countEl) countEl.textContent = total > 0 ? `${total} session${total !== 1 ? 's' : ''}` : '';

  // Rebuild only the list — not the header or quick-start
  const list = _panel.querySelector('#tp-session-list');
  if (!list) { await _render(); return; } // fallback: full render if list not found
  list.innerHTML = '';

  if (allSessions.length === 0) {
    list.innerHTML = `
      <div style="padding:20px 16px;text-align:center;color:var(--color-text-muted);font-size:var(--text-sm);">
        <div style="opacity:.4;margin-bottom:6px;">
          <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="13" r="8"/><polyline points="12 9 12 13 15 13"/>
            <line x1="9" y1="2" x2="15" y2="2"/><line x1="12" y1="2" x2="12" y2="4"/>
          </svg>
        </div>
        <div style="font-weight:500;">No active timers</div>
        <div style="font-size:var(--text-xs);margin-top:4px;">Search a task above or start a quick timer.</div>
      </div>`;
    return;
  }
  for (const session of allSessions) {
    list.appendChild(await _buildSessionRow(session, tt));
  }
}

async function _render() {
  if (!_panel || !_isOpen) return;
  const tt = await _ensureTT();
  if (!tt) {
    _panel.innerHTML = '<div style="padding:16px;color:var(--color-text-muted);">Timer service unavailable.</div>';
    return;
  }

  const _rawSessions = _dedupeSessions(Object.values(tt.sessionsSignal.value || {}));
  const alarmed  = _rawSessions.filter(s => s.alarmed);
  const active   = _rawSessions.filter(s => s.running && !s.alarmed);
  const paused   = _rawSessions.filter(s => !s.running && !s.alarmed);

  _panel.innerHTML = '';

  // ── Header ──
  const hdr = document.createElement('div');
  hdr.style.cssText = [
    'display:flex;align-items:center;gap:8px;',
    'padding:12px 14px 10px;border-bottom:1px solid var(--color-border);',
    'font-weight:var(--weight-semibold);font-size:var(--text-sm);',
    'color:var(--color-text);flex-shrink:0;',
  ].join('');
  const total = alarmed.length + active.length + paused.length;
  hdr.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="13" r="8"/><polyline points="12 9 12 13 15 13"/>
      <line x1="9" y1="2" x2="15" y2="2"/><line x1="12" y1="2" x2="12" y2="4"/>
    </svg>
    <span>Timers</span>
    <span style="flex:1;"></span>
    <span id="tp-session-count" style="font-size:var(--text-xs);color:var(--color-text-muted);">${total > 0 ? `${total} session${total !== 1 ? 's' : ''}` : ''}</span>
    <button id="timer-panel-close" style="background:none;border:none;cursor:pointer;padding:4px;
      color:var(--color-text-muted);font-size:1rem;line-height:1;border-radius:var(--radius-sm);"
      aria-label="Close">✕</button>
  `;
  hdr.querySelector('#timer-panel-close').addEventListener('click', closeTimerPanel);
  _panel.appendChild(hdr);

  // ── Quick-start launcher ──
  _buildQuickStart(_panel);

  // ── Session list ──
  const list = document.createElement('div');
  list.id = 'tp-session-list';
  list.style.cssText = 'overflow-y:auto;flex:1;';
  _panel.appendChild(list);

  const allSessions = [...alarmed, ...active, ...paused];

  if (allSessions.length === 0) {
    list.innerHTML = `
      <div style="padding:20px 16px;text-align:center;color:var(--color-text-muted);font-size:var(--text-sm);">
        <div style="opacity:.4;margin-bottom:6px;">
          <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="13" r="8"/><polyline points="12 9 12 13 15 13"/>
            <line x1="9" y1="2" x2="15" y2="2"/><line x1="12" y1="2" x2="12" y2="4"/>
          </svg>
        </div>
        <div style="font-weight:500;">No active timers</div>
        <div style="font-size:var(--text-xs);margin-top:4px;">Search a task above or start a quick timer.</div>
      </div>`;
    return;
  }

  for (const session of allSessions) {
    list.appendChild(await _buildSessionRow(session, tt));
  }
}

// ── Session row ────────────────────────────────────────── //
async function _buildSessionRow(session, tt) {
  const { taskId, taskTitle, mode, running, alarmed, isInboxTask, taskReassignable } = session;
  const elapsed   = tt.getElapsed(session);
  const remaining = tt.getRemaining(session);
  const isBlock   = mode === 'block';

  const row = document.createElement('div');
  row.dataset.taskId = taskId;
  row.style.cssText = [
    'padding:11px 14px;border-bottom:1px solid var(--color-border);',
    alarmed ? 'background:var(--color-danger-bg,#fef2f2);' : '',
  ].join('');

  // ── Title row ──
  const titleRow = document.createElement('div');
  titleRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:5px;';

  const titleEl = document.createElement('span');
  titleEl.style.cssText = [
    'font-size:var(--text-sm);font-weight:var(--weight-semibold);flex:1;',
    'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--color-text);',
    isInboxTask ? 'color:var(--color-text-muted);font-style:italic;' : '',
  ].join('');
  titleEl.title = taskTitle || 'Untitled';
  titleEl.textContent = taskTitle || 'Quick Timer';

  const openBtn = document.createElement('button');
  openBtn.textContent = '→ Open';
  openBtn.title = isInboxTask ? 'Assign to task first' : 'Open task panel';
  openBtn.disabled = isInboxTask;
  openBtn.style.cssText = [
    'background:none;border:none;cursor:pointer;color:var(--color-accent);',
    'font-size:var(--text-xs);padding:2px 4px;border-radius:var(--radius-sm);white-space:nowrap;',
    isInboxTask ? 'opacity:0.4;cursor:default;' : '',
  ].join('');
  if (!isInboxTask) {
    openBtn.addEventListener('click', () => {
      closeTimerPanel();
      emit(EVENTS.PANEL_OPENED, { entityId: taskId, entityType: 'task' });
    });
  }

  titleRow.appendChild(titleEl);
  titleRow.appendChild(openBtn);
  row.appendChild(titleRow);

  // ── Reassign row (inbox tasks or any reassignable session) ──
  if (taskReassignable || isInboxTask) {
    const reassignWrap = document.createElement('div');
    reassignWrap.style.cssText = 'margin-bottom:6px;';
    reassignWrap.innerHTML = `
      <div style="display:flex;gap:5px;align-items:center;">
        <input class="tp-reassign-input" type="text" placeholder="Assign to task…"
          style="flex:1;padding:4px 8px;border:1px solid var(--color-border);border-radius:var(--radius-sm);
                 background:var(--color-surface);color:var(--color-text);font-size:11px;outline:none;" />
        <button class="tp-reassign-btn" style="padding:4px 9px;border-radius:var(--radius-sm);border:1px solid var(--color-border);
          background:var(--color-surface);color:var(--color-text);font-size:11px;cursor:pointer;">Assign</button>
      </div>
      <div class="tp-reassign-results" style="display:none;max-height:120px;overflow-y:auto;
        border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-bg);margin-top:2px;"></div>
    `;

    const rInput  = reassignWrap.querySelector('.tp-reassign-input');
    const rBtn    = reassignWrap.querySelector('.tp-reassign-btn');
    const rResults = reassignWrap.querySelector('.tp-reassign-results');

    const _showReassignResults = async () => {
      if (_qs_tasks.length === 0) await _loadTaskList();
      const q = rInput.value.toLowerCase().trim();
      const matches = _qs_tasks.filter(t => !q || (t.title || '').toLowerCase().includes(q)).slice(0, 6);
      rResults.innerHTML = '';
      if (!matches.length) { rResults.style.display = 'none'; return; }
      rResults.style.display = 'block';
      for (const task of matches) {
        const item = document.createElement('div');
        item.style.cssText = 'padding:6px 10px;cursor:pointer;font-size:11px;border-bottom:1px solid var(--color-border);';
        item.textContent = task.title;
        item.addEventListener('mouseenter', () => item.style.background = 'var(--color-surface)');
        item.addEventListener('mouseleave', () => item.style.background = '');
        item.addEventListener('mousedown', async (e) => {
          e.preventDefault();
          rResults.style.display = 'none';
          const tt2 = await _ensureTT();
          if (!tt2) return;
          await tt2.reassignSession(taskId, task.id, task);
          await _render();
        });
        rResults.appendChild(item);
      }
    };

    rInput.addEventListener('focus', _showReassignResults);
    rInput.addEventListener('input', () => {
      clearTimeout(_qs_searchTimer);
      _qs_searchTimer = setTimeout(_showReassignResults, 120);
    });
    rInput.addEventListener('blur', () => setTimeout(() => { rResults.style.display = 'none'; }, 180));
    rBtn.addEventListener('click', _showReassignResults);

    row.appendChild(reassignWrap);
  }

  // ── Time display ──
  const timeDisplay = document.createElement('div');
  timeDisplay.dataset.timeDisplay = taskId;
  timeDisplay.style.cssText = [
    'font-size:1.35rem;font-weight:var(--weight-bold);',
    'font-variant-numeric:tabular-nums;letter-spacing:-0.01em;',
    'color:', alarmed ? 'var(--color-danger)' : running ? 'var(--color-accent)' : 'var(--color-text)',
    ';margin-bottom:3px;',
  ].join('');
  timeDisplay.textContent = isBlock && remaining != null
    ? tt.formatDurationCompact(remaining) + ' left'
    : tt.formatDurationCompact(elapsed);
  row.appendChild(timeDisplay);

  // ── Status text ──
  const statusEl = document.createElement('div');
  statusEl.style.cssText = 'font-size:var(--text-xs);margin-bottom:7px;';
  if (alarmed) {
    statusEl.style.color = 'var(--color-danger)';
    statusEl.textContent = '🔔 Block complete! What would you like to do?';
  } else if (running) {
    statusEl.style.color = 'var(--color-text-muted)';
    statusEl.textContent = isBlock ? '⏲ Block running' : '⏱ Free run';
  } else {
    statusEl.style.color = 'var(--color-text-muted)';
    statusEl.textContent = `⏸ Paused — ${tt.formatDuration(elapsed)} recorded`;
  }
  row.appendChild(statusEl);

  // ── Controls ──
  const ctrlRow = document.createElement('div');
  ctrlRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';

  const _btn = (label, accent = false, danger = false) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = [
      'padding:4px 10px;border-radius:var(--radius-md);font-size:var(--text-xs);',
      'font-weight:600;cursor:pointer;border:1px solid var(--color-border);transition:all .12s;',
      accent ? 'background:var(--color-accent);color:#fff;border-color:var(--color-accent);' :
      danger ? 'background:var(--color-surface);color:var(--color-danger);border-color:var(--color-danger);' :
               'background:var(--color-surface);color:var(--color-text);',
    ].join('');
    return b;
  };

  if (alarmed) {
    const continueBtn = _btn('▶ Continue counting', true);
    continueBtn.addEventListener('click', async () => {
      tt.clearAlarm(taskId);
      const entity = await _getEntity(taskId);
      await tt.startFreeRun(taskId, entity);
      _renderSessionList(); // [v6.3.1 Bug 7: preserve quick-start state]
    });
    const endBtn = _btn('⏹ End & save', false, true);
    endBtn.addEventListener('click', async () => {
      await tt.endSession(taskId); // saves + removes session entirely
      _renderSessionList();
    });
    ctrlRow.appendChild(continueBtn);
    ctrlRow.appendChild(endBtn);
  } else if (running) {
    const pauseBtn = _btn('⏸ Pause');
    pauseBtn.addEventListener('click', async () => {
      await tt.stopSession(taskId); // pause: keep session in list as paused
      _renderSessionList();
    });
    const stopBtn = _btn('⏹ Stop & save', false, true);
    stopBtn.addEventListener('click', async () => {
      await tt.endSession(taskId); // saves + removes session entirely
      _renderSessionList();
    });
    ctrlRow.appendChild(pauseBtn);
    ctrlRow.appendChild(stopBtn);
  } else {
    const continueBtn = _btn('▶ Continue', true);
    continueBtn.addEventListener('click', async () => {
      const entity = await _getEntity(taskId);
      await tt.startFreeRun(taskId, entity);
      _renderSessionList();
    });
    const resetBtn = _btn('✕ Dismiss');
    resetBtn.addEventListener('click', async () => {
      await tt.resetSession(taskId);
      _renderSessionList();
    });
    ctrlRow.appendChild(continueBtn);
    ctrlRow.appendChild(resetBtn);
  }

  row.appendChild(ctrlRow);
  return row;
}

async function _getEntity(taskId) {
  try {
    const { getEntity } = await import('../core/db.js');
    return await getEntity(taskId);
  } catch { return null; }
}

// ── Block Alarm Center Overlay ─────────────────────────── //

let _alarmOverlay = null;

/**
 * Show a centered overlay notification when a block timer expires.
 * Clicking anywhere outside it (or pressing Escape) dismisses it and
 * continues counting — per the spec.
 */
async function _showAlarmOverlay(session) {
  // Remove any existing overlay first
  _dismissAlarmOverlay();

  // [v6.3.1 fix Bug 1] _tt may be null if alarm fires before panel opened; always await
  const tt = await _ensureTT();

  const overlay = document.createElement('div');
  overlay.id = 'timer-alarm-overlay';
  overlay.setAttribute('role', 'alertdialog');
  overlay.setAttribute('aria-live', 'assertive');
  overlay.setAttribute('aria-label', 'Block timer complete');
  overlay.style.cssText = [
    'position:fixed;top:50%;left:50%;',
    'transform:translate(-50%,-50%);',
    'width:340px;max-width:calc(100vw - 32px);',
    'background:var(--color-bg);',
    'border:2px solid var(--color-danger);',
    'border-radius:var(--radius-lg);',
    'box-shadow:0 12px 48px rgba(0,0,0,.28),0 0 0 1px var(--color-danger);',
    'z-index:calc(var(--z-modal) + 50);',
    'padding:22px 22px 18px;',
    'animation:tp-alarm-in .22s cubic-bezier(.34,1.56,.64,1);',
  ].join('');

  // Inject keyframe if not present
  if (!document.getElementById('tp-alarm-keyframe')) {
    const style = document.createElement('style');
    style.id = 'tp-alarm-keyframe';
    style.textContent = `
      @keyframes tp-alarm-in {
        from { opacity:0; transform:translate(-50%,-54%) scale(.92); }
        to   { opacity:1; transform:translate(-50%,-50%) scale(1); }
      }
    `;
    document.head.appendChild(style);
  }

  const taskTitle = _esc(session.taskTitle || 'Timer');
  const elapsed   = tt ? tt.formatDuration(session.blockSecs || 0) : '';

  overlay.innerHTML = `
    <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:14px;">
      <div style="font-size:1.6rem;flex-shrink:0;line-height:1;">🔔</div>
      <div>
        <div style="font-weight:700;font-size:15px;color:var(--color-text);margin-bottom:2px;">
          Block Complete
        </div>
        <div style="font-size:var(--text-sm);color:var(--color-text-muted);">
          ${taskTitle} — ${_esc(elapsed)}
        </div>
      </div>
      <button id="tao-dismiss-x" style="margin-left:auto;background:none;border:none;cursor:pointer;
        color:var(--color-text-muted);font-size:1rem;padding:2px;line-height:1;flex-shrink:0;"
        title="Dismiss — continues counting">✕</button>
    </div>
    <div style="font-size:var(--text-sm);color:var(--color-text-muted);margin-bottom:14px;">
      Dismiss this notice to <strong style="color:var(--color-text);">continue counting</strong>, or choose below:
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      <button id="tao-continue" style="
        flex:1;padding:8px 12px;border-radius:var(--radius-md);border:none;
        background:var(--color-accent);color:#fff;font-size:var(--text-sm);
        font-weight:600;cursor:pointer;">
        ▶ Continue counting
      </button>
      <button id="tao-end" style="
        flex:1;padding:8px 12px;border-radius:var(--radius-md);
        border:1px solid var(--color-danger);background:var(--color-surface);
        color:var(--color-danger);font-size:var(--text-sm);font-weight:600;cursor:pointer;">
        ⏹ End &amp; save
      </button>
    </div>
    <div style="text-align:center;margin-top:10px;font-size:var(--text-xs);color:var(--color-text-muted);">
      Click anywhere · Esc — continues counting
    </div>
  `;

  _alarmOverlay = overlay;
  document.body.appendChild(overlay);

  const { taskId } = session;

  // Continue counting: clear alarm, start freeRun, dismiss overlay
  overlay.querySelector('#tao-continue').addEventListener('click', async (e) => {
    e.stopPropagation();
    _removeOverlayListeners(); // [v6.3.1 fix Bug 2]
    _dismissAlarmOverlay();
    const tt2 = await _ensureTT();
    if (!tt2) return;
    tt2.clearAlarm(taskId);
    const entity = await _getEntity(taskId);
    await tt2.startFreeRun(taskId, entity);
    if (_isOpen) _render();
  });

  // End & save
  overlay.querySelector('#tao-end').addEventListener('click', async (e) => {
    e.stopPropagation();
    _removeOverlayListeners(); // [v6.3.1 fix Bug 2]
    _dismissAlarmOverlay();
    const tt2 = await _ensureTT();
    if (!tt2) return;
    await tt2.endSession(taskId); // saves + removes session entirely
    if (_isOpen) _renderSessionList();
  });

  // X button — dismiss = continues counting (session stays alarmed in panel)
  overlay.querySelector('#tao-dismiss-x').addEventListener('click', (e) => {
    e.stopPropagation();
    _removeOverlayListeners(); // [v6.3.1 fix Bug 2]
    _dismissAlarmOverlay();
  });

  // [v6.3.1 fix Bug 2+3] Store listeners so they're always cleaned up together
  let _overlayListenersAttached = false;

  const _removeOverlayListeners = () => {
    document.removeEventListener('mousedown', _outsideClick);
    document.removeEventListener('keydown',   _overlayEscKey);
  };

  const _outsideClick = (e) => {
    if (!overlay.contains(e.target)) {
      _dismissAlarmOverlay();
      _removeOverlayListeners();
    }
  };
  // [v6.3.1 fix Bug 3] Esc only dismisses overlay — does NOT close panel
  const _overlayEscKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation(); // prevent panel _onEscKey from also firing
      _dismissAlarmOverlay();
      _removeOverlayListeners();
    }
  };

  // Small delay so the triggering event doesn't immediately dismiss the overlay
  setTimeout(() => {
    document.addEventListener('mousedown', _outsideClick);
    document.addEventListener('keydown',   _overlayEscKey);
    _overlayListenersAttached = true;
  }, 50);
}

function _dismissAlarmOverlay() {
  if (_alarmOverlay) {
    _alarmOverlay.remove();
    _alarmOverlay = null;
  }
}

// ── Live tick updates ──────────────────────────────────── //

function _startLiveTick() {
  _stopLiveTick();
  _tickUnsub = on('timer:tick', () => {
    if (!_isOpen || !_panel) return;
    _updateTimeDisplays();
  });
  // [v6.3.1 fix Bug 4] Alarm render handled solely by initTimerPanel — no duplicate here
}

function _stopLiveTick() {
  if (_tickUnsub)  { _tickUnsub();  _tickUnsub  = null; }
  // _alarmUnsub kept as null (alarm handled by initTimerPanel module-level listener)
}

async function _updateTimeDisplays() {
  const tt = await _ensureTT();
  if (!tt || !_panel) return;
  const sessions = Object.values(tt.sessionsSignal.value || {});
  for (const s of sessions) {
    const el = _panel.querySelector(`[data-time-display="${s.taskId}"]`);
    if (!el) continue;
    const elapsed   = tt.getElapsed(s);
    const remaining = tt.getRemaining(s);
    el.textContent = s.mode === 'block' && remaining != null
      ? tt.formatDurationCompact(remaining) + ' left'
      : tt.formatDurationCompact(elapsed);
  }
}

// ── Public API ─────────────────────────────────────────── //

export function toggleTimerPanel() {
  _isOpen ? closeTimerPanel() : openTimerPanel();
}

export function openTimerPanel() {
  if (_isOpen) return;
  if (!_panel) { _panel = _buildPanel(); document.body.appendChild(_panel); }
  _isOpen = true;
  _panel.style.display = 'flex';
  _render();
  _startLiveTick();
  // Load tasks in background for quick-start
  _loadTaskList();
  setTimeout(() => {
    document.addEventListener('mousedown', _onOutsideClick);
    document.addEventListener('keydown', _onEscKey, { once: true });
  }, 0);
}

export function closeTimerPanel() {
  if (!_isOpen) return;
  _isOpen = false;
  if (_panel) _panel.style.display = 'none';
  _stopLiveTick();
  document.removeEventListener('mousedown', _onOutsideClick);
}

function _onOutsideClick(e) {
  if (!_panel || _panel.contains(e.target)) return;
  const systrayItem = document.getElementById('st-timer-item');
  if (systrayItem && systrayItem.contains(e.target)) return;
  // [v6.3.1 fix Bug 5] Don't close panel when clicking alarm overlay buttons
  const alarmOverlay = document.getElementById('timer-alarm-overlay');
  if (alarmOverlay && alarmOverlay.contains(e.target)) return;
  closeTimerPanel();
  document.removeEventListener('mousedown', _onOutsideClick);
}

function _onEscKey(e) {
  if (e.key === 'Escape') closeTimerPanel();
}

export function initTimerPanel() {
  // Show center alarm overlay on block completion
  on('timer:alarm', ({ session }) => {
    if (session) _showAlarmOverlay(session); // async — fire and forget
    // [v6.3.1 fix Bug 7] Use lightweight list-only render to preserve quick-start state
    if (_isOpen) _renderSessionList();
    _updateSystrayBadge();
  });
  on('timer:tick',  _updateSystrayBadge);
  on('timer:saved', () => {
    _updateSystrayBadge();
    // [v6.3.1 fix Bug 7] Use lightweight render — preserves quick-start typed text
    if (_isOpen) _renderSessionList();
  });
}

async function _updateSystrayBadge() {
  const tt    = await _ensureTT();
  const badge = document.getElementById('st-timer-badge');
  if (!badge || !tt) return;
  const activeCount  = tt.activeTaskIds.value.size;
  const alarmedCount = tt.alarmedTaskIds.value.size;
  const count = activeCount + alarmedCount;
  badge.textContent   = count > 0 ? String(count) : '';
  badge.style.display = count > 0 ? '' : 'none';
  badge.className = alarmedCount > 0 ? 'st-badge st-badge-danger' : 'st-badge st-badge-info';
}
