/**
 * FamilyHub v4.9.2 — services/time-tracker.js
 * [MAJOR] Comprehensive time tracking service.
 *
 * Architecture:
 *   - One active session at a time per task (freeRun OR block countdown)
 *   - State stored in IDB via setSetting('timeTrackerSessions', map)
 *   - Signals broadcast live updates to all subscribers (kanban cards, panel, systray)
 *   - Alarm fires via Notification API + emits TIMER_ALARM event
 *   - Total seconds persisted to entity.timeTracked field on stop/save
 *
 * Public API:
 *   initTimeTracker()           — call once on app boot
 *   getSession(taskId)          — returns live session or null
 *   startFreeRun(taskId, task)  — start free-running stopwatch
 *   startBlock(taskId, task, blockSecs) — start countdown block
 *   stopSession(taskId)         — stop & save elapsed to entity
 *   resetSession(taskId)        — stop & discard elapsed (keep timeTracked)
 *   adjustSession(taskId, secs) — set elapsed to specific value, continue
 *   activeTaskIds               — signal: Set of currently running task IDs
 *   alarmedTaskIds              — signal: Set of task IDs where block expired
 *   clearAlarm(taskId)          — dismiss alarm for task
 *   formatDuration(secs)        — '2d 3h 15m 42s'
 *   formatDurationCompact(secs) — '51:22' or '2:03:15'
 */

import { signal, computed, effect } from '../core/signals.js';
import { getEntity, saveEntity, getSetting, setSetting } from '../core/db.js';
import { emit, on, EVENTS } from '../core/events.js';

// ── Public event keys ─────────────────────────────────────── //
export const TIMER_TICK   = 'timer:tick';   // emitted every second
export const TIMER_ALARM  = 'timer:alarm';  // emitted when block exhausted
export const TIMER_SAVED  = 'timer:saved';  // emitted when session saved to entity

// ── Session shape ──────────────────────────────────────────── //
// {
//   taskId:      string,
//   taskTitle:   string,
//   mode:        'freeRun' | 'block',
//   startedAt:   ISO string (when current run began),
//   baseSecs:    number (accumulated before current run),
//   blockSecs:   number | null (block duration),
//   running:     boolean,
//   alarmed:     boolean,
// }

// ── Module state ───────────────────────────────────────────── //
const DB_KEY = 'timeTrackerSessions';  // settings key → { [taskId]: session }

/** All live sessions: taskId → session object */
let _sessions = {};

/** Main tick interval handle */
let _tickInterval = null;
let _tickRunning  = false; // prevents concurrent tick executions from setInterval overlap

// ── Signals ────────────────────────────────────────────────── //
/** Set of taskIds currently running (freeRun or block, not alarmed) */
export const activeTaskIds  = signal(new Set());
/** Set of taskIds with an expired block alarm */
export const alarmedTaskIds = signal(new Set());
/** Full sessions map (reactive) */
export const sessionsSignal = signal({});

// ── Helpers ────────────────────────────────────────────────── //

export function formatDuration(totalSecs) {
  if (!totalSecs || totalSecs < 0) totalSecs = 0;
  const d = Math.floor(totalSecs / 86400);
  const h = Math.floor((totalSecs % 86400) / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = Math.floor(totalSecs % 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  // Only show seconds when no hours/days (keeps large durations clean: "1h 23m" not "1h 23m 0s")
  if (!d && !h && (s > 0 || !m)) parts.push(`${s}s`);
  return parts.join(' ') || '0s';
}

export function formatDurationCompact(totalSecs) {
  if (!totalSecs || totalSecs < 0) totalSecs = 0;
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = Math.floor(totalSecs % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${mm}:${ss}`;
  return `${mm}:${ss}`;
}

/** Elapsed seconds for a session (including current running segment) */
export function getElapsed(session) {
  if (!session) return 0;
  let secs = session.baseSecs || 0;
  if (session.running && session.startedAt) {
    secs += Math.floor((Date.now() - new Date(session.startedAt).getTime()) / 1000);
  }
  return secs;
}

/** Remaining seconds for a block session */
export function getRemaining(session) {
  if (!session || session.mode !== 'block' || !session.blockSecs) return null;
  return Math.max(0, session.blockSecs - getElapsed(session));
}

// ── Persistence ───────────────────────────────────────────── //

async function _persist() {
  try {
    await setSetting(DB_KEY, _sessions);
  } catch (err) {
    console.error('[time-tracker] Persist failed:', err);
  }
}

async function _load() {
  try {
    const saved = await getSetting(DB_KEY);
    if (saved && typeof saved === 'object') _sessions = saved;
  } catch { _sessions = {}; }
}

// ── Signal refresh ─────────────────────────────────────────── //

function _refreshSignals() {
  const active  = new Set();
  const alarmed = new Set();
  for (const [id, s] of Object.entries(_sessions)) {
    if (s.alarmed)        alarmed.add(id);
    else if (s.running)   active.add(id);
  }
  activeTaskIds.value  = active;
  alarmedTaskIds.value = alarmed;
  sessionsSignal.value = { ..._sessions };
}

// ── Tick loop ─────────────────────────────────────────────── //

function _startTick() {
  if (_tickInterval) return;
  _tickInterval = setInterval(_tick, 1000);
}

function _stopTickIfIdle() {
  const hasRunning = Object.values(_sessions).some(s => s.running);
  if (!hasRunning && _tickInterval) {
    clearInterval(_tickInterval);
    _tickInterval = null;
  }
}

async function _tick() {
  if (_tickRunning) return; // prevent overlap if IDB is slow
  _tickRunning = true;
  try {
  let dirty = false;
  for (const [taskId, session] of Object.entries(_sessions)) {
    if (!session.running) continue;

    const elapsed = getElapsed(session);
    emit(TIMER_TICK, { taskId, elapsed, session });

    // Block countdown alarm
    if (session.mode === 'block' && session.blockSecs) {
      const remaining = session.blockSecs - elapsed;
      if (remaining <= 0 && !session.alarmed) {
        // [v6.2.0] Do NOT auto-save — let the user decide: end timer or continue.
        // baseSecs tracks the block duration so the display shows "block fully elapsed".
        session.baseSecs = session.blockSecs;
        session.alarmed  = true;
        session.running  = false;
        dirty = true;
        // DO NOT call _saveElapsedToEntity here — user must explicitly end the timer.
        _fireAlarm(session);
      }
    }
  }
  if (dirty) {
    _refreshSignals();
    await _persist();
    _stopTickIfIdle();
  }
  // Refresh signals every tick for live display
  _refreshSignals();
  } finally {
    _tickRunning = false;
  }
}

// ── Alarm ──────────────────────────────────────────────────── //

/**
 * Persist elapsed seconds to entity.timeTracked and emit TIMER_SAVED.
 * Used by alarm handler and reconnect logic so block completions are never lost.
 */
async function _saveElapsedToEntity(taskId, elapsed) {
  try {
    const entity = await getEntity(taskId);
    if (entity) {
      const updated = { ...entity, timeTracked: elapsed };
      await saveEntity(updated);
      emit(TIMER_SAVED, { taskId, elapsed, entity: updated });
    }
  } catch (err) {
    console.error('[time-tracker] Failed to save elapsed to entity:', err);
  }
}

function _fireAlarm(session) {
  const title = session.taskTitle || 'Task';
  const msg   = `⏱️ Time block complete for "${title}"`;

  // Browser notification
  if ('Notification' in window) {
    if (Notification.permission === 'granted') {
      try {
        const n = new Notification('FamilyHub — Timer Done', {
          body: msg,
          icon: '/icons/icon-192.png',
          tag:  `timer-${session.taskId}`,
        });
        setTimeout(() => n.close(), 8000);
      } catch { /* fallback below */ }
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then(p => {
        if (p === 'granted') _fireAlarm(session);
      });
    }
  }

  // In-app event (systray badge + dashboard section pick this up)
  emit(TIMER_ALARM, { taskId: session.taskId, taskTitle: session.taskTitle, session });
}

// ── Public API ────────────────────────────────────────────── //

export function getSession(taskId) {
  return _sessions[taskId] || null;
}

/**
 * Start a free-run timer for an inbox task created on-the-fly.
 * The session is marked reassignable so the user can link it to a real task later.
 */
export async function startInboxTimer(tempId, title) {
  _sessions[tempId] = {
    taskId:    tempId,
    taskTitle: title || 'Quick Timer',
    mode:      'freeRun',
    startedAt: new Date().toISOString(),
    baseSecs:  0,
    blockSecs: null,
    running:   true,
    alarmed:   false,
    isInboxTask:      true,
    taskReassignable: true,
  };
  _refreshSignals();
  _startTick();
  await _persist();
}

export async function startFreeRun(taskId, task) {
  const existing = _sessions[taskId];
  // baseSecs = accumulated time before this run:
  // - If existing session: use its elapsed (getElapsed returns baseSecs since running=false after stop)
  // - After block alarm: existing.baseSecs = blockSecs (set by alarm handler). entity.timeTracked
  //   may have been saved BEFORE the block started. Use the larger of the two so no time is lost.
  let baseSecs;
  if (existing) {
    const sessElapsed  = getElapsed(existing);
    const entitySaved  = task?.timeTracked || 0;
    // After block alarm, entity.timeTracked = blockSecs (saved by alarm handler).
    // After pause, entity.timeTracked = full elapsed (saved by stopSession).
    // Either way, take the maximum to ensure no time is lost.
    baseSecs = Math.max(sessElapsed, entitySaved);
  } else {
    baseSecs = task?.timeTracked || 0;
  }
  _sessions[taskId] = {
    taskId,
    // [v6.3.3] Fall back to existing session title when task entity lookup returns null
    taskTitle:        task?.title || existing?.taskTitle || 'Untitled',
    mode:             'freeRun',
    startedAt:        new Date().toISOString(),
    baseSecs,
    blockSecs:        null,
    running:          true,
    alarmed:          false,
    isInboxTask:      existing?.isInboxTask      || false,
    taskReassignable: existing?.taskReassignable || false,
  };
  _refreshSignals();
  _startTick();
  await _persist();
}

export async function startBlock(taskId, task, blockSecs) {
  const existing = _sessions[taskId];

  // FIX: if a freeRun is currently running, stop and save it to entity.timeTracked
  // before starting the block. This prevents the accumulated freeRun time from
  // consuming the block countdown immediately (e.g. 10m freeRun + 5m block = alarm fires instantly).
  if (existing?.running && existing.mode === 'freeRun') {
    await stopSession(taskId); // saves elapsed to entity, updates baseSecs
  }

  // Block countdown ALWAYS starts fresh from 0 elapsed (counts down from blockSecs).
  // Previously accumulated time is already saved in entity.timeTracked via the stopSession above.
  _sessions[taskId] = {
    taskId,
    // [v6.3.3] Fall back to existing session title when task entity lookup returns null
    taskTitle:        task?.title || existing?.taskTitle || 'Untitled',
    mode:             'block',
    startedAt:        new Date().toISOString(),
    baseSecs:         0,
    blockSecs,
    running:          true,
    alarmed:          false,
    isInboxTask:      existing?.isInboxTask      || false,
    taskReassignable: existing?.taskReassignable || false,
  };
  _refreshSignals();
  _startTick();
  await _persist();
}

export async function stopSession(taskId) {
  const session = _sessions[taskId];
  if (!session) return;

  const elapsed = getElapsed(session);
  // FIX: update baseSecs BEFORE clearing running, so subsequent getElapsed()
  // and startFreeRun() both see the full accumulated time (not stale pre-run value).
  session.baseSecs = elapsed;
  session.running  = false;
  _refreshSignals();
  _stopTickIfIdle();
  await _persist();

  // Persist to entity
  try {
    const entity = await getEntity(taskId);
    if (entity) {
      const updated = { ...entity, timeTracked: elapsed };
      await saveEntity(updated);
      emit(TIMER_SAVED, { taskId, elapsed, entity: updated });
    }
  } catch (err) {
    console.error('[time-tracker] Failed to save timeTracked:', err);
  }
}

/**
 * Reassign a session to a different task entity.
 * Only works while the session has not been dismissed.
 * Updates taskId, taskTitle, and persists. The old taskId key is removed.
 */
export async function reassignSession(oldTaskId, newTaskId, newTask) {
  const session = _sessions[oldTaskId];
  if (!session) return;
  // [v6.3.1 fix Bug 6] Guard: if target already has an active session, merge elapsed instead of overwriting
  const existing = _sessions[newTaskId];
  if (existing) {
    // Merge: add inbox elapsed onto existing session's base
    const inboxElapsed = getElapsed(session);
    existing.baseSecs = (existing.baseSecs || 0) + inboxElapsed;
    existing.taskReassignable = true;
    delete _sessions[oldTaskId];
    _refreshSignals();
    await _persist();
    return;
  }
  const updated = {
    ...session,
    taskId:    newTaskId,
    taskTitle: newTask?.title || 'Untitled',
    isInboxTask: false,
    taskReassignable: true, // stays reassignable until dismissed
  };
  delete _sessions[oldTaskId];
  _sessions[newTaskId] = updated;
  _refreshSignals();
  await _persist();
}

/**
 * Save elapsed time to entity AND remove the session entirely.
 * Use for "End & save" and "Stop & save" — the session is done.
 * Use stopSession() only for "Pause" (keeps session in list as paused).
 */
export async function endSession(taskId) {
  const session = _sessions[taskId];
  if (!session) return;

  const elapsed = getElapsed(session);
  delete _sessions[taskId];
  _refreshSignals();
  _stopTickIfIdle();
  await _persist();

  const isInbox = session.isInboxTask || String(taskId).startsWith('inbox-');

  if (isInbox) {
    // [v6.3.4 fix] Inbox/quick timer ended — create a real Inbox task in IDB
    // so the tracked time is preserved and the task shows up in the Inbox tab for follow-up
    try {
      // getAccount is not imported here — use the env bridge which is set up post-boot
      const acctId = window._fhEnv?.auth?.getAccount?.()?.id || null;
      const now    = new Date().toISOString();
      const newTask = {
        type:        'task',
        title:       session.taskTitle || 'Quick Timer',
        status:      'Not Started',
        timeTracked: elapsed,
        createdAt:   now,
        updatedAt:   now,
        _timerNote:  `Created from quick timer — ${Math.round(elapsed / 60)}m tracked`,
      };
      const saved = await saveEntity(newTask, acctId);
      if (saved) {
        emit(TIMER_SAVED, { taskId, elapsed, entity: saved });
        console.log('[time-tracker] Inbox task created from quick timer:', saved.title, saved.id);
      }
    } catch (err) {
      console.error('[time-tracker] endSession: failed to create inbox task:', err);
    }
  } else {
    // Real task — persist elapsed to existing entity
    try {
      const entity = await getEntity(taskId);
      if (entity) {
        const updated = { ...entity, timeTracked: elapsed };
        await saveEntity(updated);
        emit(TIMER_SAVED, { taskId, elapsed, entity: updated });
      }
    } catch (err) {
      console.error('[time-tracker] endSession: failed to save timeTracked:', err);
    }
  }
}

export async function resetSession(taskId) {
  if (_sessions[taskId]) {
    delete _sessions[taskId];
    _refreshSignals();
    _stopTickIfIdle();
    await _persist();
  }
}

export async function adjustSession(taskId, newSecs, task) {
  const clamped = Math.max(0, newSecs);
  const session = _sessions[taskId];
  if (session) {
    session.baseSecs  = clamped;
    session.startedAt = session.running ? new Date().toISOString() : session.startedAt;
    session.alarmed   = false;
  } else {
    // Create a paused session at the adjusted time
    _sessions[taskId] = {
      taskId,
      taskTitle: task?.title || 'Untitled',
      mode:      'freeRun',
      startedAt: null,
      baseSecs:  clamped,
      blockSecs: null,
      running:   false,
      alarmed:   false,
    };
  }
  _refreshSignals();
  await _persist();
  // Also save to entity so value persists if form is closed without pausing
  _saveElapsedToEntity(taskId, clamped);
}

export function clearAlarm(taskId) {
  const session = _sessions[taskId];
  if (session?.alarmed) {
    // Keep the accumulated time but mark alarm cleared
    session.alarmed = false;
    _refreshSignals();
    _persist().catch(() => {});
  }
}

// ── Init ──────────────────────────────────────────────────── //

export async function initTimeTracker() {
  await _load();

  // Reconnect any sessions that were running before page reload
  for (const session of Object.values(_sessions)) {
    if (session.running) {
      // Validate: if startedAt is > 24h ago, auto-stop to avoid runaway timers
      if (session.startedAt) {
        const age = (Date.now() - new Date(session.startedAt).getTime()) / 1000;
        if (age > 86400) {
          session.running = false;
          session.baseSecs = getElapsed(session);
          session.startedAt = null;
        }
      }
    }
  }

  _refreshSignals();
  const hasRunning = Object.values(_sessions).some(s => s.running);
  if (hasRunning) _startTick();

  // Re-evaluate block alarms that may have expired while page was closed
  for (const [taskId, session] of Object.entries(_sessions)) {
    if (session.mode === 'block' && session.running && session.blockSecs) {
      const elapsed = getElapsed(session);
      if (elapsed >= session.blockSecs) {
        session.baseSecs = session.blockSecs;
        session.alarmed  = true;
        session.running  = false;
        // [v6.2.0] Do NOT auto-save — user must manually end via timer panel.
        _fireAlarm(session);
      }
    }
  }
  _refreshSignals();
  await _persist();

  console.log('[time-tracker] Initialized,', Object.keys(_sessions).length, 'session(s)');
}
