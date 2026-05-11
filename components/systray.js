/**
 * FamilyHub v4.2 — components/systray.js
 * Systray — right-side topbar ambient awareness zone.
 * Implements Prompt 28 spec exactly.
 *
 * Built-in items:
 *   TasksDueItem    — badge of overdue tasks; click → kanban overdue
 *   EventsUpcoming  — events in next 24h; 🎂 if birthday within 3d; click → calendar today
 *   PresenceItem    — active tab count from sync service
 *
 * Items use computed signals for auto-updates (no polling).
 * Items register via systrayRegistry: { id, render(env): HTMLElement, order: number }
 *
 * Usage:
 *   import { initSystray } from './components/systray.js';
 *   initSystray(env);  // called after buildEnv()
 */

import { systrayRegistry } from '../core/registry.js';
import { computed, signal, effect } from '../core/signals.js';
import { navigate, VIEW_KEYS } from '../core/router.js';
import { on, EVENTS } from '../core/events.js';

let _env    = null;
let _mount  = null;

// ── Shared data signals (updated on ENTITY_SAVED and sync events) ────── //

const _overdueTasks   = signal([]);
const _upcomingEvents = signal([]);
const _birthdayAlert  = signal(false);

async function _refreshData() {
  if (!_env?.services?.data) return;
  const data = _env.services.data;
  const now  = new Date();

  // Helper: local YYYY-MM-DD string (avoids UTC offset shift)
  function _localDateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  try {
    // Overdue tasks: dueDate < today (local) and not done/deleted
    // Bug fix: use local date string, not UTC (toISOString shifts in UTC-negative zones)
    // Bug fix: task status is 'Done' (capital D), not 'done'
    const tasks = await data.getEntitiesByType('task') || [];
    const today = _localDateStr(now);
    const DONE_STATUSES = new Set(['Done', 'done', 'Completed', 'completed', 'Cancelled', 'cancelled']);
    _overdueTasks.value = tasks.filter(t =>
      !t.deleted &&
      t.dueDate &&
      (t.dueDate && (t.dueDate.length === 10 ? t.dueDate : t.dueDate.slice(0,10)) < today) && // NEW-04: timezone-safe
      !DONE_STATUSES.has(t.status)
    );
  } catch { _overdueTasks.value = []; }

  try {
    // Upcoming events in next 24h
    const events = await data.getEntitiesByType('event') || [];
    const cutoff = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    _upcomingEvents.value = events.filter(e =>
      !e.deleted && e.date && e.date >= now.toISOString() && e.date <= cutoff
    );
  } catch { _upcomingEvents.value = []; }

  try {
    // Birthday alert: contacts with birthday (MM-DD) within next 3 days
    // Bug fix: handle year-wrap correctly (e.g. Dec 29 → Jan 2)
    const contacts = await data.getEntitiesByType('contact') || [];
    const now3 = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

    // Build set of MM-DD strings for the next 3 days (handles year-wrap)
    const upcomingMMDD = new Set();
    for (let i = 0; i <= 3; i++) {
      const d = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
      upcomingMMDD.add(`${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }

    _birthdayAlert.value = contacts.some(c => {
      const bday = c.birthday ? String(c.birthday).slice(5, 10) : null;
      return bday ? upcomingMMDD.has(bday) : false;
    });
  } catch { _birthdayAlert.value = false; }
}

// ── Built-in: TasksDueItem ────────────────────────────────── //

function _buildTasksDueItem() {
  const el = document.createElement('div');
  el.className = 'st-item';
  el.title = 'Overdue tasks';
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');

  const badge = document.createElement('span');
  badge.className = 'st-badge st-badge-danger';
  const icon = document.createElement('span');
  icon.textContent = '✅';
  icon.className = 'st-icon';

  el.append(icon, badge);

  // Reactive update
  effect(() => {
    const count = _overdueTasks.value.length;
    badge.textContent = count > 0 ? String(count) : '';
    badge.style.display = count > 0 ? '' : 'none';
    el.title = count > 0 ? `${count} overdue task${count !== 1 ? 's' : ''}` : 'No overdue tasks';
    el.classList.toggle('st-item-alert', count > 0);
  });

  el.addEventListener('click', () => {
    navigate(VIEW_KEYS.KANBAN, { filter: 'overdue' });
  });

  return el;
}

// ── Built-in: EventsUpcomingItem ──────────────────────────── //

function _buildEventsItem() {
  const el = document.createElement('div');
  el.className = 'st-item';
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');

  const icon = document.createElement('span');
  icon.className = 'st-icon';
  const badge = document.createElement('span');
  badge.className = 'st-badge st-badge-info';

  el.append(icon, badge);

  effect(() => {
    const count    = _upcomingEvents.value.length;
    const birthday = _birthdayAlert.value;

    icon.textContent = birthday ? '🎂' : '📅';
    badge.textContent = count > 0 ? String(count) : '';
    badge.style.display = count > 0 ? '' : 'none';
    el.title = birthday
      ? `Birthday in the next 3 days!${count ? ` + ${count} event${count !== 1 ? 's' : ''} today` : ''}`
      : count > 0
        ? `${count} event${count !== 1 ? 's' : ''} in the next 24h`
        : 'No upcoming events';
    el.classList.toggle('st-item-alert', birthday);
  });

  el.addEventListener('click', () => {
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    navigate(VIEW_KEYS.CALENDAR, { date: today });
  });

  return el;
}

// ── Built-in: PresenceItem (sync service) ─────────────────── //

function _buildPresenceItem() {
  const el = document.createElement('div');
  el.className = 'st-item';
  el.setAttribute('role', 'status');

  const icon  = document.createElement('span');
  icon.className = 'st-icon';
  icon.textContent = '🟢';
  const label = document.createElement('span');
  label.className = 'st-presence-count';

  el.append(icon, label);

  // Use activeTabs signal from sync service if available
  const syncSvc = _env?.services?.sync;
  if (syncSvc?.activeTabs) {
    effect(() => {
      const count = syncSvc.activeTabs.value;
      label.textContent = String(count);
      el.title = `${count} tab${count !== 1 ? 's' : ''} open`;
      icon.style.color = count > 1 ? 'var(--color-success)' : 'var(--color-text-muted)';
    });
  } else {
    label.textContent = '1';
    el.title = '1 tab open';
  }

  return el;
}

// ── Render systray ────────────────────────────────────────── //

function _render() {
  if (!_mount) return;
  _mount.innerHTML = '';

  // Collect all items from registry + built-ins
  const items = systrayRegistry.getAll().sort(([, a], [, b]) => (a.order || 0) - (b.order || 0));

  for (const [, descriptor] of items) {
    try {
      const el = descriptor.render(_env);
      if (el) _mount.appendChild(el);
    } catch (err) {
      console.error('[systray] Item render error:', err);
    }
  }
}

// ── Init ──────────────────────────────────────────────────── //

/**
 * Initialize the systray.
 * @param {object} env — the shared env object
 * @param {string} [mountId='topbar-systray'] — ID of the systray container
 */
export function initSystray(env, mountId = 'topbar-systray') {
  _env   = env;
  _mount = document.getElementById(mountId);

  if (!_mount) {
    console.warn('[systray] Mount element not found:', mountId, '— systray will not render');
    return;
  }

  _mount.className = 'st-bar';

  // Register built-in items
  systrayRegistry.add('tasks-due', {
    order:  10,
    render: () => _buildTasksDueItem(),
  });

  systrayRegistry.add('events-upcoming', {
    order:  20,
    render: () => _buildEventsItem(),
  });

  systrayRegistry.add('presence', {
    order:  30,
    render: () => _buildPresenceItem(),
  });

  // Initial render
  _render();

  // Refresh data on entity changes and view changes
  _refreshData();
  on(EVENTS.ENTITY_SAVED,   () => _refreshData());
  on(EVENTS.ENTITY_DELETED, () => _refreshData());
  on(EVENTS.VIEW_CHANGED,   () => _refreshData());
}
