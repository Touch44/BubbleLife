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
]);

// Dedup guard: tracks last activityType written per entityId.
// Prevents spam when auto-save fires repeatedly on completed/overdue tasks.
const _lastWritten    = new Map(); // entityId -> activityType
const _lastProjStatus  = new Map(); // projectId -> last-seen status (dedup statusChanged)
const _lastTaskUrgency = new Map(); // taskId -> last-seen urgency (dedup task:overdue)

async function _writeActivity(activityType, entity, overrides = {}) {
  try {
    // Skip if same activityType already written for this entity this session
    if (_lastWritten.get(entity.id) === activityType) return;
    _lastWritten.set(entity.id, activityType);

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
    'task:completed':        `${actor} completed "${title}"`,
    'task:overdue':          `Task "${title}" is now overdue`,
    'project:created':       `New project "${title}" started`,
    'project:statusChanged': `Project "${title}" status updated`,
    'event:created':         `New event "${title}" added`,
    'note:created':          `New note "${title}" added`,
    'budgetEntry:created':   `New budget entry: ${entity.description || title}`,
    'recipe:created':        `New recipe "${title}" added`,
    'document:created':      `Document "${title}" added`,
    'entity:deleted':        `${title} was deleted`,
    'type:created':          `New object type "${title}" created`,
  };
  return map[activityType] || `${title} was updated`;
}

export function initActivityService() {
  // ── Entity saved ──────────────────────────────────────────
  on(EVENTS.ENTITY_SAVED, async ({ entity, isNew } = {}) => {
    if (!entity || SKIP_TYPES.has(entity.type)) return;
    if (!TRACK_TYPES.has(entity.type)) return;

    if (isNew) {
      await _writeActivity(`${entity.type}:created`, entity);
    } else if (entity.type === 'task' && entity.status === 'Done') {
      await _writeActivity('task:completed', entity);
    } else if (entity.type === 'task' && entity.urgency === 'Overdue') {
      // Only write if urgency just became Overdue (wasn't Overdue last save)
      if (_lastTaskUrgency.get(entity.id) !== 'Overdue') {
        _lastTaskUrgency.set(entity.id, 'Overdue');
        await _writeActivity('task:overdue', entity);
      }
    } else if (entity.type === 'task' && entity.urgency !== 'Overdue') {
      // Reset tracking when urgency clears (task was rescheduled or completed)
      _lastTaskUrgency.delete(entity.id);
    } else if (entity.type === 'project' && entity.status) {
      // Only write if status actually changed since last save
      if (_lastProjStatus.get(entity.id) !== entity.status) {
        _lastProjStatus.set(entity.id, entity.status);
        await _writeActivity('project:statusChanged', entity);
      }
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
