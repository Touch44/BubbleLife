/**
 * FamilyHub v5.0.0 — services/reminder.js
 * Core Reminder Service: scheduler, CRUD, channel fan-out.
 *
 * Init pattern (same as time-tracker.js):
 *   Call initReminderService() directly from index.html after auth resolves.
 *   Also export reminderServiceDescriptor for env.services.reminder.
 *
 * Architecture notes:
 *   - Zero IDB schema changes — reminders stored as type='reminder' entities
 *   - reminderLog stored as type='reminderLog' entities (no separate IDB table)
 *   - Scheduler: 30s setInterval (primary) + visibilitychange catch-up + SW insurance
 *   - evaluateCondition is always async — always awaited in tick loop
 *   - getAccount().memberId used for person routing (NOT window._fhEnv.account.linkedPersonId)
 *   - 'reminder' and 'reminderLog' must be in SKIP_TYPES in activity.js (already done)
 */

import { getEntitiesByType, getEntity, saveEntity, deleteEntity,
         getEdgesFrom, getEdgesTo, saveEdge, deleteEdge, uid,
         getSetting } from '../core/db.js';
import { emit, on, EVENTS }          from '../core/events.js';
import { getAccount }                from '../core/auth.js';
import { nextDate, rruleToHuman }    from './rrule-lite.js';

// condition-eval lazy-loaded (Phase 2) so Phase 1 works without it
let _evalFn = null;
async function _getEval() {
  if (_evalFn) return _evalFn;
  try {
    const m = await import('./condition-eval.js');
    _evalFn = m.evaluateCondition;
  } catch { _evalFn = async () => true; }
  return _evalFn;
}

// ── Module state ──────────────────────────────────────────── //
let _schedulerInterval = null;
let _schedulerRunning  = false;  // concurrency guard — never run overlapping ticks
let _notifSvc          = null;   // set in start()
const _alerts          = [];     // in-memory active alerts
let _alertCounter      = 0;
let _initialized       = false; // H-04: double-init guard

// ── Local ISO (no UTC shift) ──────────────────────────────── //
function _localISO(date) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth()+1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}:00`;
}

// ════════════════════════════════════════════════════════════
// PUBLIC INIT (called from index.html)
// ════════════════════════════════════════════════════════════

export function initReminderService() {
  // H-04 fix: guard against double-initialization (hot reload, test reruns)
  if (_initialized) {
    console.warn('[reminder] initReminderService called again — skipping');
    return;
  }
  _initialized = true;

  _startScheduler();

  // Catch-up tick on tab focus (handles backgrounded tabs)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') _tick();
  });

  // AudioContext: create on first user interaction so it's ready when needed.
  // Use once:true so listeners self-remove after first successful creation.
  const _initAudio = () => {
    if (!window._fhAudioCtx) {
      try { window._fhAudioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch {}
    }
  };
  document.addEventListener('click',   _initAudio, { once: true });
  document.addEventListener('keydown', _initAudio, { once: true });

  // Handle SW notification action replies (snooze/dismiss from OS notification)
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type !== 'NOTIF_ACTION') return;
      const { action, reminderId, targetId } = e.data;
      if (action === 'snooze')  _snooze(reminderId, 10).catch(console.error);
      if (action === 'dismiss') _dismiss(reminderId).catch(console.error);
      if (!action && targetId) {
        import('../components/entity-panel.js')
          .then(m => m.openPanel(targetId)).catch(console.error);
      }
    });
  }

  // Sync upcoming reminders to SW as insurance timers
  _syncPushSchedules().catch(console.error);

  console.log('[reminder] initReminderService — 30s scheduler active');
}

// ════════════════════════════════════════════════════════════
// SCHEDULER
// ════════════════════════════════════════════════════════════

function _startScheduler() {
  if (_schedulerInterval) clearInterval(_schedulerInterval);
  _schedulerInterval = setInterval(_tick, 30_000);
  _tick(); // immediate first tick
}

async function _tick() {
  if (_schedulerRunning) return; // concurrency guard
  // 3P-C-03 fix: don't fire reminders before user is logged in
  if (!getAccount()) return;
  _schedulerRunning = true;  // set BEFORE any await to prevent concurrent ticks
  try {
    // [v5.1.0] QUIET HOURS GATE — must be inside the guard to prevent race conditions
    if (await _isQuietHours()) {
      console.debug('[reminder] quiet hours active — skipping tick');
      return;
    }
    const now = new Date();
    // Use existing 'type' index — no new IDB indexes needed
    const all = await getEntitiesByType('reminder');
    const due = all.filter(r =>
      (r.status === 'active' || r.status === 'snoozed') &&
      r.nextFireAt &&
      new Date(r.nextFireAt) <= now &&
      !(r.status === 'snoozed' && r.snoozeUntil && new Date(r.snoozeUntil) > now)
    );
    for (const reminder of due) {
      await _fireReminder(reminder, now);
    }
  } catch (err) {
    console.error('[reminder] tick error:', err);
  } finally {
    _schedulerRunning = false; // always release guard
  }
}

async function _fireReminder(reminder, now) {
  // ── Person routing (memberId, not linkedPersonId) ───────
  const myPersonId    = getAccount()?.memberId;
  const assigneeEdges = await getEdgesFrom(reminder.id, 'assignedTo');
  if (assigneeEdges.length && myPersonId &&
      !assigneeEdges.some(e => e.toId === myPersonId)) {
    return; // not assigned to current user — silent skip
  }

  // ── Resolve target entities ─────────────────────────────
  const targetEdges = await getEdgesFrom(reminder.id, 'reminds');
  const targets     = (await Promise.all(
    targetEdges.map(e => getEntity(e.toId).catch(() => null))
  )).filter(Boolean);

  // ── Condition evaluation (async, always awaited) ────────
  if (reminder.conditionMode && reminder.conditionMode !== 'none' && reminder.conditionJson) {
    const evalFn = await _getEval();
    const passed = [];
    for (const t of targets) {
      // conditionJson always parsed inside evaluateCondition if it's a string
      // H-07 fix: pass memberId (person entity ID) so 'me' condition resolves correctly
      if (await evalFn(reminder.conditionJson, t, getAccount()?.id, getAccount()?.memberId)) passed.push(t);
    }
    if (!passed.length) {
      await _advanceNextFire(reminder, now);
      return; // condition failed — skip, advance recurrence
    }
    targets.length = 0;
    targets.push(...passed);
  }

  // ── Build alert ─────────────────────────────────────────
  const alert = {
    id:           `alert-${++_alertCounter}`,
    reminderId:   reminder.id,
    title:        reminder.title || 'Reminder',
    notes:        reminder.notes || '',
    priority:     reminder.priority || 'Normal',
    targets:      targets.map(t => ({
      id: t.id, type: t.type,
      title: t.title || t.name || t.label || 'Untitled',
    })),
    firedAt:      now.toISOString(),
    fireCount:    (reminder.fireCount || 0) + 1,
    channels: {
      inApp: reminder.channelInApp !== false,
      toast: reminder.channelToast !== false,
      push:  !!reminder.channelPush,
      audio: !!reminder.channelAudio,
    },
    acknowledged: false,
    snoozable:    true,
    snoozeMinutes: reminder.snoozeMinutes || 10,
  };

  // ── Fan out ─────────────────────────────────────────────
  emit(EVENTS.REMINDER_FIRED, { reminder, targets, alert });
  await _fanOut(reminder, alert);

  // ── Alert drawer ────────────────────────────────────────
  if (alert.channels.inApp) {
    _alerts.push(alert);
    emit(EVENTS.ALERT_ADDED, alert);
    emit(EVENTS.ALERT_COUNT_CHANGED, _alerts.length);
  }

  // ── Cancel SW insurance timer to prevent duplicate push notification (3P-C-01) ──
  _cancelSWTimer(reminder.id);

  // ── Advance recurrence ──────────────────────────────────
  await _advanceNextFire(reminder, now);

  // ── Reminder log (entities store, type='reminderLog') ───
  _writeLog(reminder, alert, 'fired').catch(console.error);
}

async function _fanOut(reminder, alert) {
  // Toast channel
  if (alert.channels.toast && _notifSvc) {
    const targetText = alert.targets.map(t => t.title).join(', ');
    const msg        = targetText ? `${alert.title} — ${targetText}` : alert.title;
    const type       = alert.priority === 'Urgent' ? 'danger'
                     : alert.priority === 'High'   ? 'warning'
                     : 'info';
    _notifSvc[type](msg, {
      duration: 8000,
      action: {
        label: 'View',
        onClick: () => {
          if (alert.targets[0]?.id) {
            import('../components/entity-panel.js')
              .then(m => m.openPanel(alert.targets[0].id)).catch(console.error);
          }
        },
      },
    });
  }

  // PWA push via SW (in-page tab active = skip, SW handles background)
  if (alert.channels.push &&
      typeof Notification !== 'undefined' &&
      Notification.permission === 'granted' &&
      navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({
      type:  'SHOW_NOTIFICATION',
      title: alert.title,
      body:  alert.targets.map(t => t.title).join(', ') || '',
      data:  { reminderId: reminder.id, targetId: alert.targets[0]?.id },
    });
  }

  // Audio tone
  if (alert.channels.audio) _playTone(reminder.audioTone || 'chime');
}

function _playTone(tone) {
  const ctx = window._fhAudioCtx;
  if (!ctx || ctx.state === 'suspended') return;
  const TONES = {
    alarm:  { freq: 880, type: 'square',   dur: 0.3 },
    bell:   { freq: 659, type: 'sine',     dur: 0.5 },
    chime:  { freq: 528, type: 'sine',     dur: 0.6 },
    ping:   { freq: 440, type: 'triangle', dur: 0.2 },
    gentle: { freq: 396, type: 'sine',     dur: 0.8 },
  };
  const t = TONES[tone] || TONES.chime;
  try {
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type            = t.type;
    osc.frequency.value = t.freq;
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t.dur);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + t.dur);
  } catch (err) { console.warn('[reminder] Audio failed:', err); }
}

async function _advanceNextFire(reminder, now) {
  const updated = { ...reminder, fireCount: (reminder.fireCount || 0) + 1 };

  if (!reminder.rrule) {
    // One-shot — auto-dismiss
    updated.status     = 'dismissed';
    updated.nextFireAt = null;
    updated.dismissedAt = _localISO(now);
  } else {
    const next = nextDate(reminder.rrule, reminder.nextFireAt, reminder.fireAt);

    let exhausted = !next;
    if (!exhausted && reminder.recurrenceEnd === 'count' && reminder.recurrenceCount) {
      exhausted = updated.fireCount >= Number(reminder.recurrenceCount);
    }
    if (!exhausted && reminder.recurrenceEnd === 'date' && reminder.recurrenceEndDate) {
      exhausted = next && new Date(next) > new Date(reminder.recurrenceEndDate + 'T23:59:59');
    }

    if (exhausted) {
      updated.status     = 'expired';
      updated.nextFireAt = null;
    } else {
      updated.nextFireAt  = next;
      updated.lastFiredAt = _localISO(now);
      // Intermittent: snooze between re-fires
      if (reminder.intermittent && reminder.intermittentInterval) {
        const maxFires = reminder.intermittentMax || 5;
        if (updated.fireCount < maxFires) {
          const snoozeMs     = (reminder.intermittentInterval || 30) * 60000;
          updated.snoozeUntil = _localISO(new Date(now.getTime() + snoozeMs));
        }
      }
    }
  }

  await saveEntity(updated, getAccount()?.id);
  emit(EVENTS.REMINDER_UPDATED, { reminder: updated });
}

async function _writeLog(reminder, alert, outcome) {
  try {
    // 3P-C-04 fix: use saveEntity then immediately mark it as not-dirty to prevent
    // sync queue flooding. reminderLog entries are local audit trail, not synced to MySQL.
    // We use the fact that saveEntity adds to dirtyEntities — we clear it after save.
    const log = await saveEntity({
      type:          'reminderLog',
      title:         `${reminder.title || 'Reminder'} — fire #${alert.fireCount}`,
      reminderId:    reminder.id,
      reminderTitle: reminder.title || 'Reminder', // explicit field for analytics
      outcome,
      firedAt:       alert.firedAt,
      resolvedAt:    _localISO(new Date()),
      fireCount:     alert.fireCount,
      targetId:      alert.targets[0]?.id || null,
    }, getAccount()?.id);
  } catch (err) { console.warn('[reminder] log write failed:', err); }
}

// ════════════════════════════════════════════════════════════
// CRUD
// ════════════════════════════════════════════════════════════

export async function createReminder(data, targetId) {
  const acct   = getAccount();
  const fireAt = data.fireAt || _localISO(new Date(Date.now() + 3600000));

  const reminder = {
    type:               'reminder',
    title:              data.title || 'Reminder',
    notes:              data.notes || '',
    context:            data.context || 'family',
    priority:           data.priority || 'Normal',
    fireAt,
    timezone:           data.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    rrule:              data.rrule   || null,
    recurrenceEnd:      data.recurrenceEnd || 'never',
    recurrenceEndDate:  data.recurrenceEndDate || null,
    recurrenceCount:    data.recurrenceCount   || null,
    intermittent:       !!data.intermittent,
    intermittentInterval: data.intermittentInterval || 30,
    intermittentMax:    data.intermittentMax || 5,
    snoozeMinutes:      data.snoozeMinutes || 10,
    targetType:         data.targetType   || null,
    conditionMode:      data.conditionMode || 'none',
    conditionJson:      data.conditionJson || null,
    channelInApp:       data.channelInApp  !== false,
    channelToast:       data.channelToast  !== false,
    channelPush:        !!data.channelPush,
    channelAudio:       !!data.channelAudio,
    audioTone:          data.audioTone || 'chime',
    status:             'active',
    nextFireAt:         fireAt,
    lastFiredAt:        null,
    fireCount:          0,
    snoozeUntil:        null,
    dismissedAt:        null,
    dismissedBy:        null,
    isTemplate:         !!data.isTemplate,
    autoGenerated:      !!data.autoGenerated,
  };

  // L-02 fix: store firstTargetId on reminder for SW notification routing
  if (targetId) reminder.firstTargetId = targetId;
  const saved = await saveEntity(reminder, acct?.id);

  // Link to target via graph edge (relation: 'reminds')
  if (targetId) {
    const target = await getEntity(targetId).catch(() => null);
    await saveEdge({
      fromId: saved.id, toId: targetId,
      fromType: 'reminder', toType: target?.type || 'entity',
      relation: 'reminds',
    }, acct?.id);
  }

  // L-06 fix: emit REMINDER_CREATED after edge is saved so listeners see the edge
  emit(EVENTS.REMINDER_CREATED, { reminder: saved });

  _scheduleSWTimer(saved, targetId);
  return saved;
}

async function _dismiss(reminderId, by) {
  const r = await getEntity(reminderId);
  if (!r) return;
  await saveEntity({
    ...r,
    status:      'dismissed',
    nextFireAt:  null,
    dismissedAt: _localISO(new Date()),
    dismissedBy: by || getAccount()?.id || null,
  }, getAccount()?.id);
  _cancelSWTimer(reminderId);
  emit(EVENTS.REMINDER_DISMISSED, { reminderId });

  // [v5.2.0] Phase 3: Chained reminder — fire the next in chain after dismiss
  // Fires if chainedTo (template ID) OR chainTitle (fresh reminder) is set.
  // Zero delays are valid — _fireChainedReminder enforces a 60s minimum.
  if (r.chainedTo || r.chainTitle) {
    _fireChainedReminder(r).catch(err => console.warn('[reminder] Chain fire failed:', err));
  }
}

/**
 * Fire the next reminder in the chain after the given one is dismissed.
 * chainDelayDays + chainDelayHours determine the offset from now.
 * chainTitle overrides the title; targetId is inherited from the original.
 */
const _chainedFiring = new Set(); // prevent double-fire on rapid double-dismiss

async function _fireChainedReminder(dismissed) {
  if (_chainedFiring.has(dismissed.id)) return;
  _chainedFiring.add(dismissed.id);
  setTimeout(() => _chainedFiring.delete(dismissed.id), 5000); // 5s dedup window
  const delayMs = ((dismissed.chainDelayDays  || 0) * 86400000) +
                  ((dismissed.chainDelayHours || 0) * 3600000);
  const fireAt  = _localISO(new Date(Date.now() + Math.max(delayMs, 60000))); // min 1 min

  // If chainedTo points to an existing reminder, clone it
  if (dismissed.chainedTo) {
    const template = await getEntity(dismissed.chainedTo).catch(() => null);
    if (template) {
      const targetId = dismissed.firstTargetId || null;
      await _duplicate(template.id, targetId, { fireAt, nextFireAt: fireAt, status: 'active' });
      console.log(`[reminder] Chained: cloned reminder ${template.id} → fires at ${fireAt}`);
      return;
    }
    // chainedTo entity is missing — fall back to chainTitle if available
    console.warn(`[reminder] chainedTo ${dismissed.chainedTo} not found — falling back to chainTitle`);
  }

  // Create a fresh reminder from chainTitle (or generate a default title)
  const title = dismissed.chainTitle || `Follow-up: ${dismissed.title || 'Reminder'}`;
  if (!dismissed.chainTitle) {
    console.log(`[reminder] Chain: no chainTitle set, using default title "${title}"`);
  }
  const targetId = dismissed.firstTargetId || null;
  await createReminder({
    title,
    fireAt,
    nextFireAt: fireAt,
    status:     'active',
    priority:   dismissed.priority || 'Normal',
    notes:      `Chained from: ${dismissed.title || dismissed.id}`,
    autoGenerated: true,
  }, targetId);
  console.log(`[reminder] Chained: created "${title}" → fires at ${fireAt}`);
}

async function _snooze(reminderId, minutes) {
  const r = await getEntity(reminderId);
  if (!r) return;
  // [v5.1.0] Use adaptive snooze minutes if caller didn't specify explicit duration
  const ms          = ((minutes != null ? minutes : _adaptiveSnoozeMinutes(r)) || 10) * 60000;
  const snoozeUntil = _localISO(new Date(Date.now() + ms));
  const updated     = await saveEntity({
    ...r, status: 'snoozed', snoozeUntil, nextFireAt: snoozeUntil,
  }, getAccount()?.id);
  _scheduleSWTimer(updated);
  emit(EVENTS.REMINDER_SNOOZED, { reminderId, snoozeUntil });
  _writeLog(r, { firedAt: new Date().toISOString(), fireCount: r.fireCount || 0, targets: [] }, 'snoozed').catch(console.error);
}

async function _pause(reminderId) {
  const r = await getEntity(reminderId);
  if (!r) return;
  await saveEntity({ ...r, status: 'paused' }, getAccount()?.id);
  _cancelSWTimer(reminderId);
  emit(EVENTS.REMINDER_PAUSED, { reminderId });
}

async function _resume(reminderId) {
  const r = await getEntity(reminderId);
  if (!r) return;
  const now      = new Date();
  const nextFire = r.nextFireAt && new Date(r.nextFireAt) > now
    ? r.nextFireAt
    : _localISO(new Date(now.getTime() + 1000));
  const updated  = await saveEntity({
    ...r, status: 'active', nextFireAt: nextFire, snoozeUntil: null,
  }, getAccount()?.id);
  _scheduleSWTimer(updated);
  emit(EVENTS.REMINDER_RESUMED, { reminderId });
}

async function _duplicate(reminderId, newTargetId, overrides = {}) {
  const orig = await getEntity(reminderId);
  if (!orig) return null;

  // C-06 fix: destructure private flags out of overrides before spreading into entity
  const { _fromTemplate, ...cleanOverrides } = overrides;

  const fireAt = cleanOverrides.fireAt || orig.fireAt || _localISO(new Date(Date.now() + 3600000));
  const copy   = {
    ...orig, fireAt, nextFireAt: fireAt,
    status: 'active', fireCount: 0,
    lastFiredAt: null, snoozeUntil: null,
    dismissedAt: null, dismissedBy: null,
    isTemplate: false, autoGenerated: false,
    ...cleanOverrides, // spread clean overrides — no private flags
  };
  delete copy.id;
  const saved = await saveEntity(copy, getAccount()?.id);
  if (newTargetId) {
    const target = await getEntity(newTargetId).catch(() => null);
    await saveEdge({
      fromId: saved.id, toId: newTargetId,
      fromType: 'reminder', toType: target?.type || 'entity',
      relation: 'reminds',
    }, getAccount()?.id);
  }
  // Write clonedFrom edge when duplicating from a template (uses _fromTemplate flag)
  if (orig.isTemplate || _fromTemplate) {
    await saveEdge({
      fromId: saved.id, toId: reminderId,
      fromType: 'reminder', toType: 'reminder', relation: 'clonedFrom',
    }, getAccount()?.id);
  }
  emit(EVENTS.REMINDER_CREATED, { reminder: saved });
  return saved;
}

async function _applyTemplate(templateId, targetType, conditionJson) {
  const all = await getEntitiesByType(targetType);
  let matched = all;
  if (conditionJson) {
    // Always parse conditionJson from string before evaluateCondition
    const condObj = typeof conditionJson === 'string' ? JSON.parse(conditionJson) : conditionJson;
    const evalFn  = await _getEval();
    matched = [];
    for (const e of all) {
      if (await evalFn(condObj, e, getAccount()?.id, getAccount()?.memberId)) matched.push(e);
    }
  }
  const results = (await Promise.all(matched.map(e => _duplicate(templateId, e.id, { _fromTemplate: true })))).filter(Boolean);
  // NEW-H-05 fix: sync SW insurance timers for all newly created reminders
  if (results.length > 0) _syncPushSchedules().catch(console.error);
  return results;
}

// ── Alert management ──────────────────────────────────────── //

function _dismissAlert(alertId) {
  const idx = _alerts.findIndex(a => a.id === alertId);
  if (idx === -1) return;
  _alerts.splice(idx, 1);
  emit(EVENTS.ALERT_DISMISSED, { alertId });
  emit(EVENTS.ALERT_COUNT_CHANGED, _alerts.length);
}

function _clearAllAlerts() {
  _alerts.length = 0;
  emit(EVENTS.ALERT_CLEARED_ALL, {});
  emit(EVENTS.ALERT_COUNT_CHANGED, 0);
}

// ── SW push schedule sync ─────────────────────────────────── //

function _scheduleSWTimer(reminder, targetId) {
  if (!navigator.serviceWorker?.controller) return;
  if (!reminder.nextFireAt || reminder.status !== 'active') return;
  const ms = new Date(reminder.nextFireAt) - Date.now();
  if (ms <= 0 || ms > 86400000) return; // only schedule within 24h as insurance
  // L-02 fix: include targetId so SW notificationclick can route to target entity
  // targetId may be passed explicitly or fall back to reminder.firstTargetId (stored at create time)
  const _targetId = targetId || reminder.firstTargetId || null;
  navigator.serviceWorker.controller.postMessage({
    type: 'SCHEDULE_REMINDER', reminderId: reminder.id,
    msUntilFire: ms, title: reminder.title || 'Reminder',
    body: '', data: { reminderId: reminder.id, targetId: _targetId },
  });
}

function _cancelSWTimer(reminderId) {
  navigator.serviceWorker?.controller?.postMessage({ type: 'CANCEL_REMINDER', reminderId });
}

async function _syncPushSchedules() {
  try {
    const all = await getEntitiesByType('reminder');
    for (const r of all) {
      if (r.status === 'active' && r.nextFireAt) _scheduleSWTimer(r);
    }
  } catch (err) { console.warn('[reminder] syncPushSchedules failed:', err); }
}

// [v5.0.0] Reminder insurance timers are already done above. Below: Phase 2 additions.

// ════════════════════════════════════════════════════════════
// [v5.1.0] PHASE 2 — QUIET HOURS + SNOOZE HEURISTICS + PUSH PERMISSION
// ════════════════════════════════════════════════════════════

/**
 * Check if the current time falls within the user's configured quiet hours.
 * Quiet hours stored as { enabled: bool, start: "HH:MM", end: "HH:MM" }.
 * Returns true if now is inside the quiet window and quiet hours are enabled.
 */
async function _isQuietHours() {
  try {
    const qh = await getSetting('reminderQuietHours');
    if (!qh || !qh.enabled) return false;
    const now   = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const [startH, startM] = (qh.start || '22:00').split(':').map(Number);
    const [endH,   endM]   = (qh.end   || '07:00').split(':').map(Number);
    const startMin = startH * 60 + startM;
    const endMin   = endH   * 60 + endM;
    // [BUG-23 FIX] Same start/end = invalid config (not "always quiet"), treat as disabled
    if (startMin === endMin) return false;
    // Handle overnight ranges (e.g. 22:00 → 07:00)
    if (startMin <= endMin) return nowMin >= startMin && nowMin < endMin;
    return nowMin >= startMin || nowMin < endMin; // wraps midnight
  } catch { return false; }
}

/**
 * Adaptive snooze: return suggested snooze minutes based on firing history.
 * Heuristic: snooze grows linearly for the first 5 fires, then caps at 60m.
 * @param {object} reminder
 * @returns {number} minutes
 */
function _adaptiveSnoozeMinutes(reminder) {
  const base      = reminder.snoozeMinutes || 10;
  const fireCount = reminder.fireCount     || 0;
  // Phase 2 heuristic: base × (1 + clamp(fireCount − 1, 0, 4)) capped at 60
  const multiplier = 1 + Math.min(Math.max(fireCount - 1, 0), 4);
  return Math.min(base * multiplier, 60);
}

/**
 * Request push notification permission from the browser.
 * Persists approval state and syncs upcoming reminders to SW.
 * Exported for Settings page and reminder-form.
 */
export async function requestPushPermission() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') {
    await _syncPushSchedules();
    return 'granted';
  }
  if (Notification.permission === 'denied') return 'denied';
  const result = await Notification.requestPermission();
  if (result === 'granted') {
    await _syncPushSchedules();
    // Persist so Settings page can reflect state without re-requesting
    import('../core/db.js').then(m => m.setSetting('pushPermissionGranted', true)).catch(() => {});
  }
  return result;
}

// ════════════════════════════════════════════════════════════
// PHASE 3 SCAFFOLD — future extension points (not implemented)
// ════════════════════════════════════════════════════════════
// Phase 3 will add:
//   - Auto-reminder rules engine  (services/auto-reminder-rules.js)
//   - Chained reminders           (chained field on reminder entity)
//   - Analytics panel             (views/reminder-analytics.js)
//   - Location geofencing         (services/geofence.js — Geolocation API + PostGIS)
//   - Person-routed delivery      (per-account push token table in MySQL)
//   - Export / CSV audit trail    (api/reminder-export.php)
//
// [BUG-36 FIX] Stubs are async so callers can safely await them without try-catch surprises.
export const phase3Stubs = {
  // nlpInput intentionally not implemented — app has no external API dependencies
  nlpInput:         async () => Promise.reject(new Error('[Not implemented] FamilyHub has no external API dependencies')),
  // [v5.2.0] autoRulesEngine now implemented in services/auto-reminder-rules.js
  autoRulesEngine:  async (opts) => {
    const { getLoadedRules } = await import('./auto-reminder-rules.js');
    return getLoadedRules();
  },
  // [v5.2.0] chainedReminders now implemented via chainTitle/chainDelayDays/chainDelayHours fields on reminder entity
  // Chain triggers automatically in _dismiss() — no separate API needed.
  // This stub returns chain config for a given reminder ID.
  chainedReminders: async (reminderId) => {
    if (!reminderId) return null;
    const r = await getEntity(reminderId).catch(() => null);
    if (!r) return null;
    return { chainTitle: r.chainTitle, chainDelayDays: r.chainDelayDays, chainDelayHours: r.chainDelayHours };
  },
  geofence:         async () => Promise.reject(new Error('[Phase 3] Geofencing not yet implemented')),
};

export const reminderServiceDescriptor = {
  dependencies: ['data', 'notification'],
  start(env) {
    _notifSvc = env.services.notification;
    return {
      dismiss:               (id, by)            => _dismiss(id, by),
      snooze:                (id, mins)          => _snooze(id, mins),
      pause:                 (id)                => _pause(id),
      resume:                (id)                => _resume(id),
      duplicate:             (id, tId, ovr)      => _duplicate(id, tId, ovr),
      applyTemplate:         (tId, type, cJson)  => _applyTemplate(tId, type, cJson),
      getActiveAlerts:       ()                  => [..._alerts],
      dismissAlert:          (alertId)           => _dismissAlert(alertId),
      clearAllAlerts:        ()                  => _clearAllAlerts(),
      syncPushSchedules:     ()                  => _syncPushSchedules(),
      createReminder:        (data, targetId)    => createReminder(data, targetId),
      // [v5.1.0] Phase 2 additions
      requestPushPermission: ()                  => requestPushPermission(),
      isQuietHours:          ()                  => _isQuietHours(),
      adaptiveSnooze:        (r)                 => _adaptiveSnoozeMinutes(r),
    };
  },
};
