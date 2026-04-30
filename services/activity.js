/**
 * FamilyHub v3 — services/activity.js
 * [MAJOR] System activity feed service
 * Listens to app events and writes activity entities to IDB.
 * These are displayed in the Activity Center (views/family-wall.js).
 */

import { on, EVENTS }       from '../core/events.js';
import { saveEntity }       from '../core/db.js';
import { getAccount }       from '../core/auth.js';
import { getActiveContext } from '../core/context.js';

// Types to never generate activity for
const SKIP_TYPES  = new Set(['post', 'comment', 'activity']);

// Types that DO generate activity cards
const TRACK_TYPES = new Set([
  'task', 'project', 'event', 'note', 'budgetEntry',
  'recipe', 'document', 'contact', 'idea', 'goal', 'habit',
  'shoppingItem', 'appointment', 'medication', 'activityLog',
  'expense', 'workout', 'journalEntry', 'wish',
]);

// Milestone activityTypes shown with special card styling in Activity Center
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

  console.log('[activity] [MAJOR] Activity service initialized');
}
