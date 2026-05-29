/**
 * FamilyHub v6.5.0 — services/overlap-detector.js
 * Shared utility for detecting time-block overlaps across tasks and events.
 * Used by calendar/agenda views and kanban card rendering.
 */

import { getEntitiesByType } from '../core/db.js';

/** Parse plannedDuration string → minutes */
export function parseDurationMins(str) {
  if (!str) return 30; // [v6.5.2] default 30 min when no duration set
  const m = String(str).match(/(\d+(?:\.\d+)?)\s*(hour|hr|min|h|m)/i);
  if (!m) return 30;
  const num = parseFloat(m[1]);
  return /hour|hr|h/i.test(m[2]) ? Math.round(num * 60) : Math.round(num);
}

/** Convert dateStr + timeStr → epoch ms (local time) */
export function toEpochMs(dateStr, timeStr) {
  if (!dateStr) return null;
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h = 0, mi = 0] = (timeStr || '00:00').split(':').map(Number);
  return new Date(y, mo - 1, d, h, mi).getTime();
}

/** Format duration in minutes as "1h 30m" */
export function fmtOverlap(mins) {
  if (!mins || mins <= 0) return '<1m';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

/**
 * Compute { startMs, endMs } for any task/event entity.
 * Returns null if entity has no time block.
 */
export function getItemTimeBlock(entity) {
  if (!entity) return null;
  const type = entity.type;

  if (type === 'task' || type === 'taskInstance') {
    const dateStr = entity.executionDate;
    if (!dateStr) return null;
    const durMins = parseDurationMins(entity.plannedDuration);
    if (!durMins) return null;
    const startMs = toEpochMs(dateStr, entity.executionTime || '06:00');
    if (startMs === null) return null;
    return { startMs, endMs: startMs + durMins * 60000 };
  }

  if (type === 'event') {
    // Use endDate if available, otherwise use plannedDuration
    if (entity.endDate && entity.date) {
      const startMs = new Date(entity.date).getTime();
      const endMs   = new Date(entity.endDate).getTime();
      if (endMs > startMs) return { startMs, endMs };
    }
    const dateStr = entity.date ? String(entity.date).slice(0, 10) : null;
    if (!dateStr) return null;
    const timeStr = entity.date && entity.date.length > 10
      ? String(entity.date).slice(11, 16) : '00:00';
    const durMins = parseDurationMins(entity.plannedDuration);
    if (!durMins) return null;
    const startMs = toEpochMs(dateStr, timeStr);
    if (startMs === null) return null;
    return { startMs, endMs: startMs + durMins * 60000 };
  }

  return null;
}

/**
 * Given a list of entities (tasks + events), return a Map<entityId, [{entity, overlapMins}]>
 * of which entities overlap with each entity.
 */
export function computeOverlapMap(entities) {
  const result = new Map();
  const withBlocks = entities
    .filter(e => e && e.id && !e.deleted)  // guard null/undefined and missing id
    .map(e => ({ entity: e, block: getItemTimeBlock(e) }))
    .filter(x => x.block !== null);

  for (let i = 0; i < withBlocks.length; i++) {
    const a = withBlocks[i];
    for (let j = i + 1; j < withBlocks.length; j++) {
      const b = withBlocks[j];
      if (a.block.startMs >= b.block.endMs || b.block.startMs >= a.block.endMs) continue;
      // They overlap
      const overlapMs   = Math.min(a.block.endMs, b.block.endMs) - Math.max(a.block.startMs, b.block.startMs);
      const overlapMins = Math.round(overlapMs / 60000);

      if (!result.has(a.entity.id)) result.set(a.entity.id, []);
      if (!result.has(b.entity.id)) result.set(b.entity.id, []);
      result.get(a.entity.id).push({ entity: b.entity, overlapMins });
      result.get(b.entity.id).push({ entity: a.entity, overlapMins });
    }
  }
  return result;
}

/**
 * Load all tasks + events and compute a full overlap map.
 */
export async function loadGlobalOverlapMap() {
  const [tasks, events] = await Promise.all([
    getEntitiesByType('task').catch(() => []),
    getEntitiesByType('event').catch(() => []),
  ]);
  return computeOverlapMap([...tasks, ...events]);
}
