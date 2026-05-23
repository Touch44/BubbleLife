/**
 * FamilyHub v6.2.0 — components/timer-panel.js
 * [MAJOR] Floating Timer Panel — shows all active/alarmed timer sessions.
 *
 * Opened by the ⏱️ topbar button. Shows:
 *   - Running timers with live countdown/elapsed
 *   - Alarmed timers with end/continue prompt
 *   - Navigate-to-task button per session
 *   - Pause / Stop / Continue controls per session
 *
 * Singleton panel — only one instance at a time.
 * Auto-closes when clicking outside.
 */

import { emit, on, EVENTS }          from '../core/events.js';
import { navigate, VIEW_KEYS }        from '../core/router.js';

// ── Module state ─────────────────────────────────────────── //
let _panel       = null;
let _tickUnsub   = null;
let _isOpen      = false;
let _tt          = null; // time-tracker module (lazy loaded)

function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Lazy-load time-tracker ────────────────────────────────── //
async function _ensureTT() {
  if (_tt) return _tt;
  try {
    _tt = await import('../services/time-tracker.js');
  } catch (e) {
    console.error('[timer-panel] Failed to load time-tracker:', e);
  }
  return _tt;
}

// ── Panel DOM ────────────────────────────────────────────── //

function _buildPanel() {
  const el = document.createElement('div');
  el.id = 'timer-panel';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Active Timers');
  el.style.cssText = [
    'position:fixed;',
    'top:calc(var(--topbar-height) + var(--tab-bar-height, 36px) + 8px);',
    'right:12px;',
    'width:320px;max-width:calc(100vw - 24px);',
    'background:var(--color-bg);',
    'border:1px solid var(--color-border);',
    'border-radius:var(--radius-lg);',
    'box-shadow:var(--shadow-xl,0 8px 32px rgba(0,0,0,.18));',
    'z-index:calc(var(--z-modal) + 5);',
    'overflow:hidden;',
    'display:flex;flex-direction:column;',
    'max-height:80dvh;',
  ].join('');
  return el;
}

// ── Render sessions list ──────────────────────────────────── //

async function _render() {
  if (!_panel || !_isOpen) return;
  const tt = await _ensureTT();
  if (!tt) { _panel.innerHTML = '<div style="padding:16px;color:var(--color-text-muted);">Timer service unavailable.</div>'; return; }

  const sessions = Object.values(tt.sessionsSignal.value || {});
  const active   = sessions.filter(s => s.running);
  const alarmed  = sessions.filter(s => s.alarmed);
  const paused   = sessions.filter(s => !s.running && !s.alarmed && (s.baseSecs || 0) > 0);

  _panel.innerHTML = '';

  // ── Header ──
  const hdr = document.createElement('div');
  hdr.style.cssText = [
    'display:flex;align-items:center;gap:8px;',
    'padding:12px 16px 10px;',
    'border-bottom:1px solid var(--color-border);',
    'font-weight:var(--weight-semibold);font-size:var(--text-sm);',
    'color:var(--color-text);flex-shrink:0;',
  ].join('');
  hdr.innerHTML = `
    <span style="font-size:1.1rem;">⏱️</span>
    <span>Active Timers</span>
    <span style="flex:1;"></span>
    <span style="font-size:var(--text-xs);color:var(--color-text-muted);">
      ${active.length + alarmed.length + paused.length} session${(active.length + alarmed.length + paused.length) !== 1 ? 's' : ''}
    </span>
    <button id="timer-panel-close" style="
      background:none;border:none;cursor:pointer;padding:4px;
      color:var(--color-text-muted);font-size:1rem;line-height:1;
      border-radius:var(--radius-sm);
    " aria-label="Close timer panel">✕</button>
  `;
  hdr.querySelector('#timer-panel-close').addEventListener('click', closeTimerPanel);
  _panel.appendChild(hdr);

  // ── Session list ──
  const list = document.createElement('div');
  list.style.cssText = 'overflow-y:auto;flex:1;';
  _panel.appendChild(list);

  const allSessions = [...alarmed, ...active, ...paused];

  if (allSessions.length === 0) {
    list.innerHTML = `
      <div style="padding:24px 16px;text-align:center;color:var(--color-text-muted);font-size:var(--text-sm);">
        <div style="font-size:2rem;margin-bottom:8px;">⏱️</div>
        <div>No active timers</div>
        <div style="font-size:var(--text-xs);margin-top:4px;">Start a timer from any task to track time.</div>
      </div>`;
    return;
  }

  for (const session of allSessions) {
    list.appendChild(await _buildSessionRow(session, tt));
  }
}

async function _buildSessionRow(session, tt) {
  const { taskId, taskTitle, mode, running, alarmed, blockSecs } = session;
  const elapsed   = tt.getElapsed(session);
  const remaining = tt.getRemaining(session);
  const isBlock   = mode === 'block';

  const row = document.createElement('div');
  row.dataset.taskId = taskId;
  row.style.cssText = [
    'padding:12px 16px;border-bottom:1px solid var(--color-border);',
    alarmed ? 'background:var(--color-danger-bg,#fef2f2);' : '',
  ].join('');

  // Title + navigate
  const titleRow = document.createElement('div');
  titleRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:6px;';
  titleRow.innerHTML = `
    <span style="font-size:var(--text-sm);font-weight:var(--weight-semibold);flex:1;
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--color-text);"
      title="${_esc(taskTitle)}">${_esc(taskTitle || 'Untitled Task')}</span>
    <button class="tp-nav-btn" title="Open task" style="
      background:none;border:none;cursor:pointer;color:var(--color-accent);
      font-size:0.8rem;padding:2px 4px;border-radius:var(--radius-sm);
      white-space:nowrap;font-size:var(--text-xs);
    ">→ Open</button>
  `;
  titleRow.querySelector('.tp-nav-btn').addEventListener('click', () => {
    closeTimerPanel();
    // Open the task entity panel directly — much more useful than navigating to a list
    emit(EVENTS.PANEL_OPENED, { entityId: taskId, entityType: 'task' });
  });
  row.appendChild(titleRow);

  // Time display
  const timeDisplay = document.createElement('div');
  timeDisplay.dataset.timeDisplay = taskId;
  timeDisplay.style.cssText = [
    'font-size:1.4rem;font-weight:var(--weight-bold);',
    'font-variant-numeric:tabular-nums;letter-spacing:-0.01em;',
    'color:', alarmed ? 'var(--color-danger)' : running ? 'var(--color-accent)' : 'var(--color-text)',
    ';margin-bottom:4px;',
  ].join('');
  timeDisplay.textContent = isBlock && remaining != null
    ? tt.formatDurationCompact(remaining) + ' left'
    : tt.formatDurationCompact(elapsed);
  row.appendChild(timeDisplay);

  // Status badge
  const statusBadge = document.createElement('div');
  statusBadge.style.cssText = 'font-size:var(--text-xs);color:var(--color-text-muted);margin-bottom:8px;';
  if (alarmed) {
    statusBadge.style.color = 'var(--color-danger)';
    statusBadge.textContent = '🔔 Block complete! What would you like to do?';
  } else if (running) {
    statusBadge.textContent = isBlock ? '⏲ Block running' : '⏱ Free run';
  } else {
    statusBadge.textContent = `⏸ Paused — ${tt.formatDuration(elapsed)} recorded`;
  }
  row.appendChild(statusBadge);

  // Controls
  const ctrlRow = document.createElement('div');
  ctrlRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';

  const _btn = (label, accent = false, danger = false) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = [
      'padding:4px 10px;border-radius:var(--radius-md);font-size:var(--text-xs);',
      'font-weight:var(--weight-semibold);cursor:pointer;border:1px solid var(--color-border);',
      'transition:all 0.12s;',
      accent  ? 'background:var(--color-accent);color:#fff;border-color:var(--color-accent);' :
      danger  ? 'background:var(--color-surface);color:var(--color-danger);border-color:var(--color-danger);' :
                'background:var(--color-surface);color:var(--color-text);',
    ].join('');
    return b;
  };

  if (alarmed) {
    // Block complete: two choices
    const continueBtn = _btn('▶ Continue counting', true);
    continueBtn.addEventListener('click', async () => {
      tt.clearAlarm(taskId);
      const entity = await _getEntity(taskId);
      await tt.startFreeRun(taskId, entity);
      _render();
    });

    const endBtn = _btn('⏹ End & save', false, true);
    endBtn.addEventListener('click', async () => {
      await tt.stopSession(taskId);
      _render();
    });

    ctrlRow.appendChild(continueBtn);
    ctrlRow.appendChild(endBtn);

  } else if (running) {
    const pauseBtn = _btn('⏸ Pause');
    pauseBtn.addEventListener('click', async () => {
      await tt.stopSession(taskId);
      _render();
    });
    const stopBtn = _btn('⏹ Stop & save', false, true);
    stopBtn.addEventListener('click', async () => {
      await tt.stopSession(taskId);
      _render();
    });
    ctrlRow.appendChild(pauseBtn);
    ctrlRow.appendChild(stopBtn);

  } else {
    const continueBtn = _btn('▶ Continue', true);
    continueBtn.addEventListener('click', async () => {
      const entity = await _getEntity(taskId);
      await tt.startFreeRun(taskId, entity);
      _render();
    });
    const resetBtn = _btn('✕ Reset');
    resetBtn.addEventListener('click', async () => {
      await tt.resetSession(taskId);
      _render();
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

// ── Live tick updates ─────────────────────────────────────── //

let _alarmUnsub = null; // [v6.2.0 fix] track alarm listener for cleanup

function _startLiveTick() {
  _stopLiveTick();
  _tickUnsub = on('timer:tick', () => {
    if (!_isOpen || !_panel) return;
    _updateTimeDisplays();
  });
  // [v6.2.0 fix] Store alarm unsub so it's cleaned up when panel closes
  _alarmUnsub = on('timer:alarm', () => { if (_isOpen) _render(); });
}

function _stopLiveTick() {
  if (_tickUnsub)  { _tickUnsub();  _tickUnsub  = null; }
  if (_alarmUnsub) { _alarmUnsub(); _alarmUnsub = null; }
}

async function _updateTimeDisplays() {
  const tt = await _ensureTT();
  if (!tt || !_panel) return;
  const sessions = Object.values(tt.sessionsSignal.value || {});
  for (const session of sessions) {
    const el = _panel.querySelector(`[data-time-display="${session.taskId}"]`);
    if (!el) continue;
    const elapsed   = tt.getElapsed(session);
    const remaining = tt.getRemaining(session);
    const isBlock   = session.mode === 'block';
    el.textContent = isBlock && remaining != null
      ? tt.formatDurationCompact(remaining) + ' left'
      : tt.formatDurationCompact(elapsed);
  }
}

// ── Public API ────────────────────────────────────────────── //

/**
 * Toggle the timer panel open/closed.
 * Called by the topbar ⏱️ button.
 */
export function toggleTimerPanel() {
  if (_isOpen) {
    closeTimerPanel();
  } else {
    openTimerPanel();
  }
}

export function openTimerPanel() {
  if (_isOpen) return;

  if (!_panel) {
    _panel = _buildPanel();
    document.body.appendChild(_panel);
  }

  _isOpen = true;
  _panel.style.display = 'flex';
  _render();
  _startLiveTick();

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('mousedown', _onOutsideClick);
    document.addEventListener('keydown',   _onEscKey, { once: true });
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
  if (_panel && !_panel.contains(e.target)) {
    const timerBtn = document.getElementById('topbar-timer-btn');
    if (timerBtn && timerBtn.contains(e.target)) return; // let button toggle handle it
    closeTimerPanel();
    document.removeEventListener('mousedown', _onOutsideClick);
  }
}

function _onEscKey(e) {
  if (e.key === 'Escape') closeTimerPanel();
}

/**
 * Init — call once at app boot.
 * Wires timer alarm listener for badge updates.
 */
export function initTimerPanel() {
  // Re-render panel on alarm if it's open
  on('timer:alarm', () => {
    if (_isOpen) _render();
  });
  // Update button badge on every tick
  on('timer:tick', _updateTopbarBadge);
  on('timer:alarm', _updateTopbarBadge);
  on('timer:saved', _updateTopbarBadge);
}

async function _updateTopbarBadge() {
  const tt  = await _ensureTT();
  const btn = document.getElementById('topbar-timer-btn');
  if (!btn || !tt) return;
  const badge = btn.querySelector('.topbar-timer-badge');
  if (!badge) return;
  const count = tt.activeTaskIds.value.size + tt.alarmedTaskIds.value.size;
  badge.textContent   = count > 0 ? String(count) : '';
  badge.style.display = count > 0 ? '' : 'none';
  badge.style.background = tt.alarmedTaskIds.value.size > 0
    ? 'var(--color-danger)'
    : 'var(--color-accent)';
}
