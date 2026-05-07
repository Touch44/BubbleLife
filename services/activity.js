/**
 * FamilyHub v3 — services/activity.js
 * [MAJOR] System activity feed service
 * Listens to app events and writes activity entities to IDB.
 * These are displayed in the Activity Wall (views/family-wall.js).
 */

import { on, EVENTS }                  from '../core/events.js';
import { saveEntity, getEntitiesByType } from '../core/db.js';
import { getAccount }                   from '../core/auth.js';
import { getActiveContext }             from '../core/context.js';

// Types to never generate activity for
const SKIP_TYPES  = new Set(['post', 'comment', 'activity']);

// Types that DO generate activity cards
const TRACK_TYPES = new Set([
  'task', 'project', 'event', 'note', 'budgetEntry',
  'recipe', 'document', 'contact', 'idea', 'goal', 'habit',
  'shoppingItem', 'appointment', 'medication', 'activityLog',
  'expense', 'workout', 'journalEntry', 'wish',
]);

// Milestone activityTypes shown with special card styling in Activity Wall
// Exported so views (e.g. family-wall.js) can import for consistent milestone detection
export const MILESTONE_TYPES = new Set([
  'task:completed', 'project:completed', 'goal:achieved',
  'habit:streak', 'event:attended', 'milestone:posted',
]);

// Dedup guard: tracks last activityType written per entityId.
// Prevents spam when auto-save fires repeatedly on completed/overdue tasks.
const _lastWritten    = new Map(); // entityId -> activityType
const _lastProjStatus  = new Map(); // projectId -> last-seen status (dedup statusChanged)
const _lastTaskUrgency = new Map(); // taskId -> last-seen urgency (dedup task:overdue)

async function _writeActivity(activityType, entity, overrides = {}) {
  try {
    // Skip if same activityType already written for this entity this session
    // Key includes activityType so different types don't block each other per entity
    const _dedupKey = (entity.id || '') + ':' + activityType;
    if (_lastWritten.get(_dedupKey) === activityType) return;
    _lastWritten.set(_dedupKey, activityType);

    const acct  = getAccount();
    const title = entity.title || entity.name || entity.description || entity.id;

    await saveEntity({
      type:         'activity',
      activityType,
      entityId:     entity.id,
      entityType:   entity.type,
      entityTitle:  title,
      actorId:       acct?.id       || null,
      actorPersonId: acct?.memberId  || null,   // person entity ID for member filter matching
      actorName:     acct?.username  || 'Someone',
      context:      entity.context || getActiveContext(),
      body:         overrides.body || _buildBody(activityType, entity, acct),
      ...overrides,
    }, acct?.id);
  } catch (err) {
    console.error('[activity] write failed:', err);
  }
}

function _buildBody(activityType, entity, acct) {
  const actor = acct?.username || 'Someone';
  const title = entity.title || entity.name || entity.description || 'Untitled';
  const map = {
    'task:created':          `${actor} created task "${title}"`,
    'task:completed':        `${actor} completed task "${title}"`,
    'task:overdue':          `Task "${title}" is now overdue`,
    'task:assigned':         `${actor} assigned task "${title}"`,
    'project:created':       `New project "${title}" started`,
    'project:statusChanged': `Project "${title}" status updated`,
    'project:completed':     `${actor} completed project "${title}"`,
    'event:created':         `New event "${title}" scheduled`,
    'event:attended':        `${actor} attended "${title}"`,
    'note:created':          `${actor} added note "${title}"`,
    'budgetEntry:created':   `New budget entry: ${entity.description || title}`,
    'recipe:created':        `New recipe "${title}" added`,
    'document:created':      `Document "${title}" added`,
    'contact:created':       `${actor} added contact "${title}"`,
    'idea:created':          `${actor} captured idea "${title}"`,
    'goal:created':          `${actor} set goal "${title}"`,
    'goal:achieved':         `${actor} achieved goal "${title}"`,
    'habit:created':         `${actor} started habit "${title}"`,
    'habit:streak':          `${actor} is on a streak with "${title}"`,
    'shoppingItem:created':  `${actor} added "${title}" to shopping`,
    'appointment:created':   `New appointment "${title}" scheduled`,
    'medication:created':    `Medication "${title}" added`,
    'activityLog:created':   `${actor} logged activity "${title}"`,
    'expense:created':       `${actor} logged expense "${title}"`,
    'workout:created':       `${actor} logged workout "${title}"`,
    'journalEntry:created':  `${actor} added a journal entry`,
    'wish:created':          `${actor} added wish "${title}"`,
    'shoppingItem:checked':  `${actor} checked off "${title}" from the shopping list`,
    'entity:deleted':        `${title} was deleted`,
    'type:created':          `New object type "${title}" created`,
    'milestone:posted':      `${actor} posted a milestone: "${title}"`,
  };
  return map[activityType] || `${actor} updated "${title}"`;
}

export function initActivityService() {
  // ── Entity saved ──────────────────────────────────────────
  on(EVENTS.ENTITY_SAVED, async ({ entity, isNew } = {}) => {
    if (!entity || SKIP_TYPES.has(entity.type)) return;
    if (!TRACK_TYPES.has(entity.type)) return;

    // New entity: always write :created activity
    if (isNew) {
      await _writeActivity(`${entity.type}:created`, entity);
      return;
    }

    // Task state transitions
    if (entity.type === 'task') {
      if (entity.status === 'Done') {
        await _writeActivity('task:completed', entity);
      } else if (entity.urgency === 'Overdue') {
        if (_lastTaskUrgency.get(entity.id) !== 'Overdue') {
          _lastTaskUrgency.set(entity.id, 'Overdue');
          await _writeActivity('task:overdue', entity);
        }
      } else {
        _lastTaskUrgency.delete(entity.id);
      }
      return;
    }

    // Project status transitions
    if (entity.type === 'project' && entity.status) {
      if (_lastProjStatus.get(entity.id) !== entity.status) {
        _lastProjStatus.set(entity.id, entity.status);
        const actType = (entity.status === 'Completed' || entity.status === 'Done')
          ? 'project:completed'
          : 'project:statusChanged';
        await _writeActivity(actType, entity);
      }
      return;
    }

    // Goal achieved
    if (entity.type === 'goal' && entity.status === 'Achieved') {
      await _writeActivity('goal:achieved', entity);
      return;
    }

    // Shopping item checked off
    if (entity.type === 'shoppingItem' && entity.checked) {
      const _dedupChecked = entity.id + ':shoppingItem:checked';
      if (!_lastWritten.get(_dedupChecked)) {
        await _writeActivity('shoppingItem:checked', entity);
      }
      return;
    }

    // Event attended (marked complete/attended)
    if (entity.type === 'event' && entity.attended) {
      await _writeActivity('event:attended', entity);
      return;
    }
  });

  // ── Milestone post created ────────────────────────────────
  on(EVENTS.ENTITY_SAVED, async ({ entity, isNew } = {}) => {
    if (!entity || entity.type !== 'post' || !isNew) return;
    if (entity.postType === 'Milestone') {
      await _writeActivity('milestone:posted', {
        id:      entity.id,
        type:    'post',
        title:   entity.body || entity.title || 'Family Milestone',
        context: entity.context,
      });
    }
  });

  // ── Entity deleted ────────────────────────────────────────
  on(EVENTS.ENTITY_DELETED, async ({ entity } = {}) => {
    // entity is present in payload after the db.js fix
    if (!entity || SKIP_TYPES.has(entity.type)) return;
    await _writeActivity('entity:deleted', entity);
  });

  // ── Custom type created ───────────────────────────────────
  on(EVENTS.TYPE_CREATED, async ({ config } = {}) => {
    if (!config) return;
    // Built-in saves also fire TYPE_CREATED — only write activity for genuinely new custom types
    if (config.isBuiltIn) return;
    await _writeActivity('type:created', {
      id:      config.key,
      type:    'objectType',
      title:   config.label,
      context: 'all',
    });
  });

  // ── Task assignment ──────────────────────────────────────
  // Track when a task gains an assignee during an update (not new, has assignedTo)
  on(EVENTS.ENTITY_SAVED, async ({ entity, isNew } = {}) => {
    if (!entity || entity.type !== 'task' || isNew) return;
    if (entity.assignedTo && !_lastWritten.get(entity.id + ':task:assigned')) {
      await _writeActivity('task:assigned', entity);
    }
  });

  console.log('[activity] [MAJOR] Activity service initialized');
}

/**
 * Seed the activity feed from existing entities so the Activity Wall
 * is not empty on first visit. Writes at most one :created activity per
 * entity; dedup map prevents duplication if called again.
 * Called once after initActivityService() and IDB is ready.
 */
export async function seedActivityFeed() {
  try {
    // Check if already seeded this session
    if (window._fhActivitySeeded) return;
    window._fhActivitySeeded = true;

    const SEED_TYPES = [
      'task', 'project', 'event', 'note', 'budgetEntry',
      'recipe', 'document', 'contact', 'idea', 'goal', 'habit',
    ];

    // Load existing activities from IDB to build dedup set — prevents re-seeding on reload
    let existingActivityIds = new Set();
    try {
      const existing = await getEntitiesByType('activity');
      for (const a of existing) {
        if (a.entityId && a.activityType) {
          existingActivityIds.add(a.entityId + ':' + a.activityType);
        }
      }
    } catch { /* if load fails, dedup falls back to in-memory only */ }

    for (const type of SEED_TYPES) {
      const entities = await getEntitiesByType(type);
      // Seed only the 20 most recent per type to avoid flooding
      const recent = entities
        .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
        .slice(0, 20);
      for (const entity of recent) {
        const actKey  = (entity.id || '') + ':' + type + ':created';
        const dedupKey = actKey;
        // Skip if already in IDB or in-memory map
        if (existingActivityIds.has(actKey)) continue;
        if (_lastWritten.get(dedupKey)) continue;
        await _writeActivity(`${type}:created`, entity);
      }
    }
    console.log('[activity] Seed complete');
  } catch (err) {
    console.error('[activity] Seed failed:', err);
  }
}
