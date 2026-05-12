/**
 * FamilyHub v5.0.0 — views/reminders.js
 * Reminders management hub view.
 * Registration: registerView('reminders', renderRemindersView)
 */

import { registerView }                from '../core/router.js';
import { getEntitiesByType, getEntity,
         deleteEntity }                from '../core/db.js';
import { on, emit, EVENTS }            from '../core/events.js';
import { getAccount }                  from '../core/auth.js';
import { rruleToHuman }                from '../services/rrule-lite.js';
import { openReminderForm }            from '../components/reminder-form.js';

let _container   = null;
let _unsubs      = [];
let _searchQ     = '';
let _filterStatus = 'all';
let _renderGen   = 0;

function _esc(s) { return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function _formatFireAt(iso) {
  if (!iso) return '—';
  try {
    const d   = new Date(iso.includes('T') ? iso : iso + 'T00:00:00');
    const now = new Date();
    const ms  = d - now;
    if (ms < 0) return `${_ago(iso)} ⚠ overdue`;
    if (Math.abs(ms) < 30000) return 'now'; // NEW-L-04: within 30s = 'now' not 'in 0m'
    const m = Math.floor(ms / 60000);
    if (m < 60)   return `in ${m}m`;
    if (m < 1440) return `in ${Math.floor(m/60)}h`;
    if (m < 10080)return `in ${Math.floor(m/1440)}d`;
    return d.toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' });
  } catch { return iso; }
}

function _ago(iso) {
  const m = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.floor(m/60)}h ago`;
  return `${Math.floor(m/1440)}d ago`;
}

function _isToday(iso) {
  const d = new Date(iso.includes('T') ? iso : iso + 'T00:00:00');
  const n = new Date();
  return d.getFullYear()===n.getFullYear() && d.getMonth()===n.getMonth() && d.getDate()===n.getDate();
}

const PDOT = { Urgent:'🔴', High:'🟠', Normal:'🔵', Low:'⚪' };

// ════════════════════════════════════════════════════════════
async function renderRemindersView(params, env) {
  const gen = ++_renderGen;
  _container = document.getElementById('view-reminders');
  if (!_container) return;

  _unsubs.forEach(fn => { try { fn(); } catch {} });
  _unsubs = [];

  _container.innerHTML = `
    <div style="max-width:860px;margin:0 auto;padding:24px 20px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:10px;">
        <h1 style="margin:0;font-size:1.4rem;font-weight:700;">🔔 Reminders</h1>
        <button id="rm-new"
          style="padding:9px 18px;background:var(--color-primary,#4f8ef7);color:#fff;
          border:none;border-radius:8px;cursor:pointer;font-weight:600;font-size:0.875rem;">
          + New Reminder
        </button>
      </div>
      <div style="display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap;">
        <input id="rm-search" type="search" placeholder="Search reminders…" value="${_esc(_searchQ)}"
          style="flex:1;min-width:180px;padding:8px 12px;border:1px solid var(--color-border,#e2e8f0);
          border-radius:8px;font-size:0.875rem;background:var(--color-surface,#fff);
          color:var(--color-text,#1e293b);" />
        <select id="rm-filter"
          style="padding:8px 12px;border:1px solid var(--color-border,#e2e8f0);border-radius:8px;
          font-size:0.875rem;background:var(--color-surface,#fff);color:var(--color-text,#1e293b);">
          <option value="all" ${_filterStatus==='all'?'selected':''}>All statuses</option>
          <option value="active" ${_filterStatus==='active'?'selected':''}>Active</option>
          <option value="snoozed" ${_filterStatus==='snoozed'?'selected':''}>Snoozed</option>
          <option value="paused" ${_filterStatus==='paused'?'selected':''}>Paused</option>
          <option value="dismissed" ${_filterStatus==='dismissed'?'selected':''}>Dismissed</option>
          <option value="isTemplate" ${_filterStatus==='isTemplate'?'selected':''}>Templates</option>
        </select>
      </div>
      <div id="rm-body">
        <div style="text-align:center;padding:40px;color:var(--color-text-muted,#94a3b8);">Loading…</div>
      </div>
    </div>
  `;

  _container.querySelector('#rm-new')?.addEventListener('click', () => openReminderForm({}));
  _container.querySelector('#rm-search')?.addEventListener('input', e => { _searchQ = e.target.value; _renderList(gen); });
  _container.querySelector('#rm-filter')?.addEventListener('change', e => { _filterStatus = e.target.value; _renderList(gen); });

  const refreshOn = [EVENTS.REMINDER_CREATED, EVENTS.REMINDER_UPDATED,
                     EVENTS.REMINDER_DISMISSED, EVENTS.REMINDER_PAUSED, EVENTS.REMINDER_RESUMED];
  for (const evt of refreshOn) {
    _unsubs.push(on(evt, () => _renderList(gen)));
  }

  // M-06 fix: clean up event subscriptions on navigation away to prevent memory leaks
  const _navUnsub = on(EVENTS.VIEW_CHANGED, () => {
    _unsubs.forEach(fn => { try { fn(); } catch {} });
    _unsubs = [];
    _navUnsub(); // also remove this listener
  });

  await _renderList(gen);
}

async function _renderList(gen) {
  if (gen !== _renderGen) return;
  const body = _container?.querySelector('#rm-body');
  if (!body) return;

  let all = await getEntitiesByType('reminder');

  if (_searchQ.trim()) {
    const q = _searchQ.toLowerCase();
    all = all.filter(r => (r.title||'').toLowerCase().includes(q) || (r.notes||'').toLowerCase().includes(q));
  }

  const now = new Date();
  const groups = {
    overdue:   all.filter(r => !r.isTemplate && r.status==='active' && r.nextFireAt && new Date(r.nextFireAt)<now),
    today:     all.filter(r => !r.isTemplate && r.status==='active' && r.nextFireAt && _isToday(r.nextFireAt) && new Date(r.nextFireAt)>=now),
    upcoming:  all.filter(r => !r.isTemplate && r.status==='active' && r.nextFireAt && new Date(r.nextFireAt)>now && !_isToday(r.nextFireAt)),
    snoozed:   all.filter(r => !r.isTemplate && r.status==='snoozed'),
    paused:    all.filter(r => !r.isTemplate && r.status==='paused'),
    done:      all.filter(r => !r.isTemplate && (r.status==='dismissed'||r.status==='expired')),
    templates: all.filter(r => r.isTemplate),
  };

  // Apply status filter
  let filtered;
  if (_filterStatus === 'isTemplate') {
    filtered = groups.templates;
  } else if (_filterStatus !== 'all') {
    filtered = all.filter(r => r.status === _filterStatus && !r.isTemplate);
    // C-03 fix: show empty state whenever filtered is empty, even if data exists for other statuses
    if (!filtered.length) {
      body.innerHTML = _emptyState(); return;
    }
    body.innerHTML = filtered.map(_row).join('');
    _wireRows(body, gen); return;
  } else {
    filtered = null; // show all groups
  }

  if (filtered !== null) {
    if (!filtered.length) { body.innerHTML = _emptyState(); return; }
    body.innerHTML = filtered.map(_row).join('');
    _wireRows(body, gen); return;
  }

  const sections = [
    { label: '🔴 Overdue',      items: groups.overdue },
    { label: '⏰ Today',         items: groups.today },
    { label: '📅 Upcoming',      items: groups.upcoming },
    { label: '💤 Snoozed',       items: groups.snoozed },
    { label: '⏸ Paused',         items: groups.paused },
    { label: '✓ Done / Expired', items: groups.done },
    { label: '📋 Templates',     items: groups.templates },
  ].filter(s => s.items.length > 0);

  if (!sections.length) { body.innerHTML = _emptyState(); return; }

  body.innerHTML = sections.map(s => `
    <div style="margin-bottom:24px;">
      <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;
        color:var(--color-text-muted,#64748b);margin-bottom:8px;padding-bottom:6px;
        border-bottom:1px solid var(--color-border,#e2e8f0);">${s.label}</div>
      ${s.items.map(_row).join('')}
    </div>`).join('');

  _wireRows(body, gen);
}

function _emptyState() {
  return `<div style="text-align:center;padding:60px 20px;color:var(--color-text-muted,#94a3b8);">
    <div style="font-size:2.5rem;margin-bottom:12px;">🔔</div>
    <div style="font-weight:600;margin-bottom:6px;">No reminders yet</div>
    <div style="font-size:0.85rem;">Add one from any entity panel, or click "+ New Reminder"</div>
  </div>`;
}

function _row(r) {
  const dot   = PDOT[r.priority] || '🔵';
  const fire  = r.nextFireAt ? _formatFireAt(r.nextFireAt) : (r.dismissedAt ? '✓ Done' : '—');
  const recur = r.rrule ? `<span style="font-size:0.67rem;color:var(--color-text-muted,#94a3b8);">🔁 ${_esc(rruleToHuman(r.rrule))}</span>` : '';

  const btns = [];
  if (r.status === 'active' || r.status === 'snoozed') {
    btns.push(`<button data-act="edit" data-id="${_esc(r.id)}" title="Edit" style="${_bs()}">✏️</button>`);
    btns.push(`<button data-act="pause" data-id="${_esc(r.id)}" title="Pause" style="${_bs()}">⏸</button>`);
    btns.push(`<button data-act="dismiss" data-id="${_esc(r.id)}" title="Dismiss" style="${_bs()}">✓</button>`);
  }
  if (r.status === 'paused') {
    btns.push(`<button data-act="resume" data-id="${_esc(r.id)}" title="Resume" style="${_bs()}">▶</button>`);
    btns.push(`<button data-act="edit" data-id="${_esc(r.id)}" title="Edit" style="${_bs()}">✏️</button>`);
  }
  if (r.isTemplate) {
    btns.push(`<button data-act="edit" data-id="${_esc(r.id)}" title="Edit" style="${_bs()}">✏️</button>`);
    btns.push(`<button data-act="duplicate" data-id="${_esc(r.id)}" title="Duplicate" style="${_bs()}">⧉</button>`);
  }
  btns.push(`<button data-act="delete" data-id="${_esc(r.id)}" title="Delete" style="${_bs(true)}">🗑</button>`);

  return `<div class="rm-row" data-id="${_esc(r.id)}" style="
    display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;
    border:1px solid var(--color-border,#e2e8f0);margin-bottom:6px;cursor:pointer;
    background:var(--color-surface,#fff);">
    <span title="${_esc(r.priority||'Normal')}" style="font-size:0.9rem;flex-shrink:0;">${dot}</span>
    <div style="flex:1;min-width:0;">
      <div style="font-weight:600;font-size:0.875rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
        ${_esc(r.title||'Untitled Reminder')}
      </div>
      <div style="font-size:0.73rem;color:var(--color-text-muted,#94a3b8);display:flex;gap:8px;flex-wrap:wrap;margin-top:2px;align-items:center;">
        <span>${fire}</span>${recur}
        ${r.isTemplate ? '<span style="background:#e0e7ff;color:#3730a3;padding:1px 6px;border-radius:4px;font-size:0.65rem;font-weight:600;">TEMPLATE</span>' : ''}
      </div>
    </div>
    <div style="display:flex;gap:4px;flex-shrink:0;">${btns.join('')}</div>
  </div>`;
}

function _bs(danger) {
  return `padding:5px 8px;border-radius:6px;border:1px solid var(--color-border,#e2e8f0);
    cursor:pointer;font-size:0.8rem;background:transparent;
    color:${danger ? 'var(--color-danger,#ef4444)' : 'var(--color-text-muted,#64748b)'};`;
}

function _wireRows(body, gen) {
  body.querySelectorAll('[data-act]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      await _action(btn.dataset.act, btn.dataset.id);
      _renderList(gen);
    });
  });
  body.querySelectorAll('.rm-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('[data-act]')) return;
      // M-01 fix: row click opens reminder edit form, not entity panel for the reminder entity
      // (opening reminder entity in panel shows raw fields, not useful UX)
      openReminderForm({ reminderId: row.dataset.id });
    });
  });
}

async function _action(act, id) {
  const svc = window._fhEnv?.services?.reminder;
  switch (act) {
    case 'edit':    openReminderForm({ reminderId: id }); break;
    case 'pause':   await svc?.pause(id); break;
    case 'resume':  await svc?.resume(id); break;
    case 'dismiss':
      await svc?.dismiss(id);
      // H-09 fix: also clear any active in-memory alert for this reminder
      // so the FAB badge count updates immediately
      if (svc) {
        const alerts = svc.getActiveAlerts();
        for (const a of alerts) {
          if (a.reminderId === id) svc.dismissAlert(a.id);
        }
      }
      break;
    case 'duplicate': {
      // M-08 fix: pass result to event so handlers receive useful data
      const result = await svc?.duplicate(id, null);
      if (result) emit(EVENTS.REMINDER_CREATED, { reminder: result });
      break;
    }
    case 'delete':
      if (confirm('Delete this reminder?')) await deleteEntity(id, getAccount()?.id);
      break;
  }
}

registerView('reminders', renderRemindersView);
