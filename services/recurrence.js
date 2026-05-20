/**
 * FamilyHub v5.3.4 — services/recurrence.js
 * Ghost Instance scheduler. Pattern mirrors services/reminder.js.
 *
 * Responsibilities:
 *   - Materialise ghost taskInstance entities for recurring tasks up to N days ahead
 *   - Prune stale ghost instances older than keepDays
 *   - completeInstance: O(1) streak update, milestone detection, sync-flag removal
 *   - skipInstance: mark occurrence Skipped without deleting
 *   - stopSeries: turn off recurrence and hard-delete pending ghosts
 *   - getActiveInstanceForTemplate: find today's open instance for a template
 *
 * Init: call initRecurrenceService() from index.html after initReminderService().
 */

import { getEntitiesByType, getEntity, saveEntity, getEdgesFrom, getEdgesTo,
         saveEdge, hardDeleteEntity, getSetting, logActivity, uid }
  from '../core/db.js';
import { emit, EVENTS }        from '../core/events.js';
import { getAccount }          from '../core/auth.js';
import { nextDate, nextNDates } from './rrule-lite.js';

// ── Module state ──────────────────────────────────────────────
let _schedulerInterval = null;
let _schedulerRunning  = false;
let _initialized       = false;
let _tickCount         = 0; // [N60 fix] prune runs every 10 ticks (5 min) not every 30s

// ── Date helpers ──────────────────────────────────────────────

/** Return a local ISO datetime string (YYYY-MM-DDTHH:MM:SS) without UTC shift. */
function _localISO(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
}

/** Return today as YYYY-MM-DD using local time (never toISOString). */
function _todayStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}

/** Build a YYYY-MM-DD string from a Date object (local time). */
function _dateToStr(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}

// ── Scheduler init ────────────────────────────────────────────

/**
 * Start the recurrence scheduler.
 * Called once from index.html after auth resolves.
 * Double-init protected.
 */
export function initRecurrenceService() {
  if (_initialized) {
    console.warn('[recurrence] already initialized — skipping');
    return;
  }
  _initialized = true;
  _schedulerInterval = setInterval(_tick, 30_000);
  _tick(); // immediate first run
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') _tick();
  });
  console.log('[recurrence] scheduler active');
}

// ── Scheduler tick ────────────────────────────────────────────

async function _tick() {
  if (_schedulerRunning || !getAccount()) return;
  _schedulerRunning = true;
  _tickCount++;
  try {
    await _materializeInstances();
    // [N60 fix] Prune only every 10 ticks (~5 min) — reduces full taskInstance scan frequency
    if (_tickCount % 10 === 1) {
      await _pruneStaleGhosts();
    }
  } catch (err) {
    console.error('[recurrence] tick error:', err);
  } finally {
    _schedulerRunning = false;
  }
}

// ── Materialise instances ─────────────────────────────────────

/**
 * For each active recurring template, create ghost instances up to previewDays ahead.
 * Idempotent: uses periodStart dedup so re-runs never create duplicates.
 * Save guard: only writes template when nextOccurrenceDate actually changes —
 * prevents 2880 dirty-queue writes/day on 30s interval.
 */
async function _materializeInstances() {
  const acct     = getAccount();
  const allTasks = await getEntitiesByType('task');
  const templates = allTasks.filter(t =>
    t.isRecurring && t.rrule && !t.deleted &&
    !(t.pausedUntil && t.pausedUntil > _todayStr())
  );

  // [B8 fix] Load global defaults once — used as fallback per-template
  const [globalPreview, globalKeep] = await Promise.all([
    getSetting('recurrencePreviewDays').catch(() => 7),
    getSetting('recurrenceKeepDays').catch(() => 30),
  ]);

  for (const tmpl of templates) {
    // Check series end conditions
    // [P10 fix] recurrenceCount=0 or null means unlimited; only apply count limit when count >= 1
    if (tmpl.recurrenceEnd === 'count' &&
        (tmpl.recurrenceCount || 0) >= 1 &&
        (tmpl.occurrenceCount || 0) >= (tmpl.recurrenceCount || 0)) continue;
    // [P11 fix] recurrenceEndDate: stop on OR after the end date (>= not just >)
    if (tmpl.recurrenceEnd === 'date' &&
        tmpl.recurrenceEndDate && _todayStr() >= tmpl.recurrenceEndDate) continue;

    const previewDays = Math.max(1, Math.min(tmpl.instancePreviewDays ?? globalPreview ?? 7, 90));
    const horizon = new Date();
    horizon.setDate(horizon.getDate() + previewDays);
    const horizonStr = _dateToStr(horizon);

    // Load existing instance periodStarts for O(1) dedup (never re-create)
    // [B45 fix] Filter deleted instances so re-create can happen if manually deleted
    const existingEdges  = await getEdgesTo(tmpl.id, 'instanceOf').catch(() => []);
    const existingRaw    = await Promise.all(existingEdges.map(e => getEntity(e.fromId).catch(() => null)));
    const existingStarts = new Set(
      existingRaw.filter(i => i && !i.deleted).map(i => i.periodStart?.slice(0, 10)).filter(Boolean)
    );

    // [N16 fix] Cap cursor start to prevent creating instances for every past day on first tick.
    // If template has a very old executionDate and nextOccurrenceDate is stale/null,
    // we'd otherwise create one instance per past occurrence (e.g. 144 for a 5-month-old daily task).
    const earliestAllowed = _dateToStr(new Date(new Date().setDate(new Date().getDate() - Math.max(1, previewDays))));
    let cursor = (tmpl.nextOccurrenceDate || tmpl.executionDate || _todayStr()).slice(0, 10);
    // Clamp cursor: never start further back than earliestAllowed
    if (cursor < earliestAllowed) cursor = earliestAllowed;
    let localInstanceCount = 0; // [B3 fix] track instances created in this tick

    while (cursor && cursor <= horizonStr) {
      if (!existingStarts.has(cursor)) {
        await _createInstance(tmpl, cursor, acct, existingStarts.size + localInstanceCount);
        localInstanceCount++;
      }
      const nextRaw = nextDate(tmpl.rrule, cursor + 'T00:00:00',
        (tmpl.executionDate || cursor) + 'T00:00:00');
      cursor = nextRaw ? nextRaw.slice(0, 10) : null;
    }

    // Save guard: only write template when nextOccurrenceDate actually changed
    // [P05 fix] Use _streakUpdate flag so this administrative save doesn't trigger a full kanban re-render
    if (cursor !== null && cursor !== tmpl.nextOccurrenceDate) {
      await saveEntity({ ...tmpl, nextOccurrenceDate: cursor, _streakUpdate: true }, acct?.id);
    }
  }
}

// ── Create ghost instance ─────────────────────────────────────

/**
 * Create a single ghost taskInstance for the given template and period start date.
 * Inherits context, assignedTo, checklist (unchecked copy) from template.
 */
async function _createInstance(tmpl, periodStart, acct, baseIndex = 0) {
  const inst = await saveEntity({
    type:           'taskInstance',
    title:          tmpl.title,
    templateId:     tmpl.id,
    periodStart:    periodStart,   // always YYYY-MM-DD
    executionDate:  periodStart,
    executionTime:  tmpl.executionTime || tmpl.dueTime || null,
    // [v5.4.3] dueDate = periodStart: the deadline for an occurrence is the day it occurs
    dueDate:        periodStart,
    status:         'Not Started',
    context:        tmpl.context,  // inherit for filterByContext
    assignedTo:     tmpl.assignedTo,
    checklist:      _cloneChecklist(tmpl.checklist),
    occurrenceIndex: (tmpl.occurrenceCount || 0) + baseIndex + 1, // [B3 fix] unique per tick
    isGhost:        true,
    _noSync:        true,
  }, acct?.id);

  await saveEdge({
    fromId:   inst.id,
    toId:     tmpl.id,
    fromType: 'taskInstance',
    toType:   'task',
    relation: 'instanceOf',
  }, acct?.id);

  emit(EVENTS.RECURRENCE_MATERIALIZED, { instance: inst, templateId: tmpl.id });
  return inst;
}

/** Deep-clone a checklist array with fresh IDs and all items unchecked. */
function _cloneChecklist(src) {
  if (!Array.isArray(src)) return [];
  return src.map(item => ({ ...item, id: uid(), checked: false, done: false }));
}

// ── completeInstance ──────────────────────────────────────────

/**
 * Mark a taskInstance as Completed.
 * - Removes _noSync so the completed instance syncs to MySQL
 * - Updates template streak/count fields (O(1) via lastCompletedPeriod cursor)
 * - Fires milestone activity if applicable
 * @param {string} instanceId
 * @returns {Promise<object>} saved instance
 */
export async function completeInstance(instanceId) {
  const inst = await getEntity(instanceId);
  if (!inst || inst.type !== 'taskInstance')
    throw new Error('[recurrence] Not a taskInstance: ' + instanceId);
  // [B18 fix] Idempotency: if already completed, return existing saved state
  if (inst.status === 'Completed') {
    console.warn('[recurrence] completeInstance: already completed, skipping', instanceId);
    return inst;
  }

  // Resolve template via instanceOf edge
  const edges      = await getEdgesFrom(instanceId, 'instanceOf');
  const templateId = edges[0]?.toId;
  const tmpl       = templateId ? await getEntity(templateId) : null;

  // Strip _noSync so completed instance syncs to MySQL
  const { _noSync: _removed, ...instClean } = inst;
  const saved = await saveEntity({
    ...instClean,
    status:      'Completed',
    completedAt: _localISO(new Date()),
    isGhost:     false,
  }, getAccount()?.id);

  // O(1) streak update using lastCompletedPeriod cursor on template
  if (tmpl) {
    const p = inst.periodStart?.slice(0, 10) || _todayStr(); // [P12 fix] fallback to today if periodStart missing
    const lastP   = tmpl.lastCompletedPeriod?.slice(0, 10);

    // Streak continues if the previous next-occurrence after lastP equals current p
    const prevNext = lastP
      ? nextDate(tmpl.rrule, lastP + 'T00:00:00', lastP + 'T00:00:00')?.slice(0, 10)
      : null;
    const streakContinues = !lastP || prevNext === p;
    const newStreak = streakContinues ? (tmpl.currentStreak || 0) + 1 : 1;
    const newBest   = Math.max(newStreak, tmpl.longestStreak || 0);
    const newCount  = (tmpl.occurrenceCount || 0) + 1;

    // Milestone: 1, 5, 10, 25, 50, 100 completions OR every 7-day streak
    const isMilestone = [1, 5, 10, 25, 50, 100].includes(newCount)
                      || (newStreak > 0 && newStreak % 7 === 0);

    // [N07 fix] Pass _streakUpdate flag so the template save doesn't trigger a second full kanban re-render.
    // saveEntity always emits ENTITY_SAVED; the kanban listener checks for this flag and skips re-render
    // when it fires as part of an ongoing completeInstance operation.
    const { _streakUpdate: _su, ...tmplNoStreak } = tmpl; // strip any existing flag
    await saveEntity({
      ...tmplNoStreak,
      occurrenceCount:     newCount,
      currentStreak:       newStreak,
      longestStreak:       newBest,
      lastCompletedPeriod: p,
      _streakUpdate:       true, // [N07] filtered by kanban/daily listeners — stripped before IDB by SKIP_FIELDS
    }, getAccount()?.id);

    if (isMilestone) {
      const celebrate = await getSetting('recurrenceCelebrations').catch(() => true);
      if (celebrate !== false) {
        const label = (newStreak % 7 === 0)
          ? `${tmpl.title} — ${newStreak}-day streak`
          : `${tmpl.title} — #${newCount}`;
        await logActivity({
          action:      newStreak % 7 === 0 ? 'recurrence:streak' : 'recurrence:milestone',
          entityType:  'task',
          entityId:    tmpl.id,
          entityTitle: label,
          byAccountId: getAccount()?.id,
        }).catch(() => {});
        emit(EVENTS.RECURRENCE_STREAK_UPDATED, {
          templateId: tmpl.id, streak: newStreak, count: newCount,
        });
      }
    }
  }

  emit(EVENTS.ENTITY_SAVED, { entity: saved, isNew: false });
  emit(EVENTS.RECURRENCE_INSTANCE_COMPLETED, { instance: saved, templateId: tmpl?.id });
  return saved;
}

// ── skipInstance ──────────────────────────────────────────────

/**
 * Mark a taskInstance as Skipped without deleting it.
 * @param {string} instanceId
 * @param {string} [reason]
 * @returns {Promise<object>}
 */
export async function skipInstance(instanceId, reason = '') {
  const inst = await getEntity(instanceId);
  if (!inst) return;
  // [P06 fix] Keep _noSync — taskInstance is local-only until server schema exists (N17)
  // Strip isGhost to promote it from auto-generated to user-actioned
  const { isGhost: _ig, ...clean } = inst;
  const saved = await saveEntity({
    ...clean,
    status:        'Skipped',
    skippedReason: reason,
    isGhost:       false,
  }, getAccount()?.id);
  emit(EVENTS.ENTITY_SAVED, { entity: saved, isNew: false });
  emit(EVENTS.RECURRENCE_INSTANCE_SKIPPED, { instance: saved });
  return saved;
}

// ── stopSeries ────────────────────────────────────────────────

/**
 * Stop a recurring series:
 * - Sets isRecurring=false and clears nextOccurrenceDate on the template
 * - Hard-deletes all pending (Not Started) ghost instances
 * @param {string} templateId
 * @returns {Promise<void>}
 */
export async function stopSeries(templateId) {
  const tmpl = await getEntity(templateId);
  if (!tmpl) return;

  const saved = await saveEntity(
    { ...tmpl, isRecurring: false, nextOccurrenceDate: null },
    getAccount()?.id
  );

  const edges = await getEdgesTo(templateId, 'instanceOf').catch(() => []);
  const insts = await Promise.all(edges.map(e => getEntity(e.fromId).catch(() => null)));

  await Promise.all(
    // [P15 fix] Only delete ghost Not Started instances — preserve In Progress / Skipped / Completed
    insts.filter(i => i && i.status === 'Not Started' && i.isGhost)
         .map(i => hardDeleteEntity(i.id).catch(() => {}))
  );

  emit(EVENTS.RECURRENCE_SERIES_STOPPED, { templateId });
  emit(EVENTS.ENTITY_SAVED, { entity: saved, isNew: false }); // [B21 fix] use freshly saved entity
}

// ── getActiveInstanceForTemplate ──────────────────────────────

/**
 * Find the open (Not Started) taskInstance for a template whose periodStart
 * is on or before today. Used by reminder.js to route alerts to the instance.
 * @param {string} templateId
 * @returns {Promise<object|null>}
 */
export async function getActiveInstanceForTemplate(templateId) {
  const today = _todayStr();
  const edges = await getEdgesTo(templateId, 'instanceOf').catch(() => []);
  const insts = await Promise.all(edges.map(e => getEntity(e.fromId).catch(() => null)));
  return insts
    .filter(i => i && i.status === 'Not Started' && (i.periodStart?.slice(0, 10) || '') <= today)
    .sort((a, b) => (b.periodStart || '0').localeCompare(a.periodStart || '0'))[0] || null;
}

// ── Prune stale ghost instances ───────────────────────────────

/**
 * Hard-delete ghost instances older than template.instanceKeepDays.
 * Batches template lookups to avoid O(N×M) sequential IDB reads (C17).
 */
async function _pruneStaleGhosts() {
  const insts  = await getEntitiesByType('taskInstance');
  const ghosts = insts.filter(i => i.isGhost && i.status === 'Not Started' && i.templateId);
  if (!ghosts.length) return;

  // [B8 fix] global fallback for keepDays
  const globalKeep = await getSetting('recurrenceKeepDays').catch(() => 30);

  // Batch template lookups (C17 fix: pre-build Map before loop)
  const tmplIds = [...new Set(ghosts.map(i => i.templateId))];
  const tmpls   = await Promise.all(tmplIds.map(id => getEntity(id).catch(() => null)));
  const tmplMap = new Map(tmplIds.map((id, i) => [id, tmpls[i]]));

  const cutoffBase = new Date();

  for (const inst of ghosts) {
    const tmpl     = tmplMap.get(inst.templateId);
    const rawKeep  = tmpl?.instanceKeepDays ?? globalKeep ?? 30; // [B8] global as fallback
    if (rawKeep < 0) continue; // -1 = keep forever (check BEFORE Math.max clamps it)
    const keepDays = Math.min(Math.max(0, rawKeep), 3650); // clamp 0–10 years

    const cutoffDate = new Date(cutoffBase);
    cutoffDate.setDate(cutoffDate.getDate() - keepDays);

    // Parse periodStart as local time (never Date constructor with bare string)
    const pParts = (inst.periodStart || '').split('-');
    if (pParts.length < 3) continue;
    const pStart = new Date(
      parseInt(pParts[0], 10),
      parseInt(pParts[1], 10) - 1,
      parseInt(pParts[2], 10)
    );

    if (pStart < cutoffDate) {
      await hardDeleteEntity(inst.id).catch(() => {});
    }
  }
}

// ── Service descriptor ────────────────────────────────────────

export const recurrenceServiceDescriptor = {
  dependencies: ['data'],
  start(env) {
    return {
      completeInstance,
      skipInstance,
      stopSeries,
      getActiveInstanceForTemplate,
    };
  },
};
