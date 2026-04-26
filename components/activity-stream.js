/**
 * FamilyHub v3.0 — components/activity-stream.js
 * Reusable activity/chatter component for the entity panel.
 * Implements Prompt 15 spec exactly.
 *
 * Features:
 *   1. Loads activity log from data service key 'activities:{entityId}'
 *   2. Reverse-chronological list with: timestamp (relative), author, type icon, description
 *   3. Comment input at bottom — Enter adds comment entry
 *   4. Auto-generates entries for: entity creation, field edits, status changes
 *   5. Mounts inside entity panel below fields section
 *   6. Activities stored per entity under 'activities:{entityId}' key
 *
 * Usage:
 *   import { mountActivityStream } from './components/activity-stream.js';
 *   const cleanup = mountActivityStream(containerEl, entityId, entityType);
 *   // call cleanup() to unmount
 */

import { getSetting, setSetting } from '../core/db.js';
import { getAccount }              from '../core/auth.js';
import { on, EVENTS }             from '../core/events.js';

const TYPE_ICONS = {
  create:  '✨',
  edit:    '✏️',
  comment: '💬',
  status:  '🔄',
  attach:  '📎',
  delete:  '🗑️',
};

function _relativeTime(isoStr) {
  if (!isoStr) return '';
  const diff = Date.now() - new Date(isoStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60)  return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h} hour${h !== 1 ? 's' : ''} ago`;
  const d = Math.floor(h / 24);
  if (d < 30)  return `${d} day${d !== 1 ? 's' : ''} ago`;
  return new Date(isoStr).toLocaleDateString();
}

function _activityKey(entityId) {
  return `activities:${entityId}`;
}

async function _loadActivities(entityId) {
  try {
    return (await getSetting(_activityKey(entityId))) || [];
  } catch {
    return [];
  }
}

async function _saveActivities(entityId, activities) {
  await setSetting(_activityKey(entityId), activities);
}

async function _addActivity(entityId, entry) {
  const activities = await _loadActivities(entityId);
  activities.push({
    id:        `act-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type:      entry.type || 'edit',
    author:    entry.author || 'System',
    authorId:  entry.authorId || null,
    text:      entry.text || '',
    at:        new Date().toISOString(),
  });
  // Cap at 200 entries
  if (activities.length > 200) activities.splice(0, activities.length - 200);
  await _saveActivities(entityId, activities);
  return activities;
}

/**
 * Auto-record a creation activity for an entity.
 * @param {string} entityId
 * @param {string} entityLabel
 */
export async function recordCreated(entityId, entityLabel) {
  const account = getAccount();
  await _addActivity(entityId, {
    type:     'create',
    author:   account?.username || 'Unknown',
    authorId: account?.id,
    text:     `Created ${entityLabel || 'entity'}`,
  });
}

/**
 * Auto-record a field-edit activity.
 * @param {string} entityId
 * @param {string} field
 * @param {*} oldVal
 * @param {*} newVal
 */
export async function recordFieldEdit(entityId, field, oldVal, newVal) {
  const account = getAccount();
  const oldStr = String(oldVal ?? '').slice(0, 60) || '—';
  const newStr = String(newVal ?? '').slice(0, 60) || '—';
  await _addActivity(entityId, {
    type:     'edit',
    author:   account?.username || 'Unknown',
    authorId: account?.id,
    text:     `${field} changed from "${oldStr}" to "${newStr}"`,
  });
}

/**
 * Auto-record a status change activity.
 * @param {string} entityId
 * @param {string} newStatus
 */
export async function recordStatusChange(entityId, newStatus) {
  const account = getAccount();
  await _addActivity(entityId, {
    type:     'status',
    author:   account?.username || 'Unknown',
    authorId: account?.id,
    text:     `Status changed to "${newStatus}"`,
  });
}

// ── Mount function ────────────────────────────────────────── //

/**
 * Mount the activity stream into a container element.
 * @param {HTMLElement} container
 * @param {string} entityId
 * @param {string} [entityType]
 * @returns {() => void} cleanup function
 */
export function mountActivityStream(container, entityId, entityType) {
  if (!container || !entityId) return () => {};

  container.innerHTML = '';
  container.className = 'activity-stream';

  // ── List ──────────────────────────────────────────────── //
  const listEl = document.createElement('div');
  listEl.className = 'activity-list';
  listEl.setAttribute('aria-label', 'Activity history');
  container.appendChild(listEl);

  // ── Comment input ─────────────────────────────────────── //
  const inputWrap = document.createElement('div');
  inputWrap.className = 'activity-input-wrap';

  const input = document.createElement('input');
  input.type        = 'text';
  input.className   = 'input activity-input';
  input.placeholder = 'Add a comment… (Enter to post)';
  input.setAttribute('aria-label', 'Add a comment');

  const postBtn = document.createElement('button');
  postBtn.className   = 'btn btn-primary btn-sm activity-post-btn';
  postBtn.textContent = 'Post';

  inputWrap.append(input, postBtn);
  container.appendChild(inputWrap);

  // ── Render helpers ────────────────────────────────────── //
  function _renderList(activities) {
    listEl.innerHTML = '';
    if (!activities.length) {
      listEl.innerHTML = '<div class="activity-empty">No activity yet.</div>';
      return;
    }

    // Reverse-chronological
    const sorted = [...activities].reverse();
    for (const act of sorted) {
      const row = document.createElement('div');
      row.className = 'activity-row';

      const icon = TYPE_ICONS[act.type] || '◈';
      const when = _relativeTime(act.at);

      row.innerHTML = `
        <span class="activity-icon" aria-hidden="true">${icon}</span>
        <div class="activity-body">
          <div class="activity-meta">
            <span class="activity-author">${_esc(act.author || 'Unknown')}</span>
            <span class="activity-time" title="${act.at || ''}">${when}</span>
          </div>
          <div class="activity-text">${_esc(act.text || '')}</div>
        </div>
      `;
      listEl.appendChild(row);
    }
  }

  // ── Load and render ───────────────────────────────────── //
  let _activities = [];

  async function _refresh() {
    _activities = await _loadActivities(entityId);
    _renderList(_activities);
  }

  _refresh();

  // ── Comment submission ────────────────────────────────── //
  async function _postComment() {
    const text = input.value.trim();
    if (!text) return;
    input.value   = '';
    postBtn.disabled = true;
    try {
      _activities = await _addActivity(entityId, {
        type:     'comment',
        author:   getAccount()?.username || 'Unknown',
        authorId: getAccount()?.id,
        text,
      });
      _renderList(_activities);
    } catch (err) {
      console.error('[activity-stream] Post failed:', err);
    } finally {
      postBtn.disabled = false;
      input.focus();
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); _postComment(); }
  });
  postBtn.addEventListener('click', _postComment);

  // ── Re-render on entity save (if it's this entity) ────── //
  const unsub = on(EVENTS.ENTITY_SAVED, ({ entity } = {}) => {
    if (entity?.id === entityId) _refresh();
  });

  return () => {
    unsub();
    container.innerHTML = '';
  };
}

function _esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
