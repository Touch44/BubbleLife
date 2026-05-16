/**
 * FamilyHub v5.1.0 — views/reminders.js
 * [v5.1.0] Phase 2: template library section, apply-template flow,
 * completion tracking (Done/Skipped/Snooze), reminderLog display.
 */

import { registerView }                from '../core/router.js';
import { getEntitiesByType, getEntity,
         deleteEntity, saveEntity }    from '../core/db.js';
import { on, emit, EVENTS }            from '../core/events.js';
import { getAccount }                  from '../core/auth.js';
import { toast }                       from '../core/toast.js';
import { rruleToHuman, nextDate }      from '../services/rrule-lite.js';
import { openReminderForm }            from '../components/reminder-form.js';

let _container   = null;
let _unsubs      = [];
let _searchQ     = '';
let _filterStatus = 'all';
let _renderGen   = 0;
let _showTemplates = false; // toggles Template Library panel

function _esc(s) { return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function _formatFireAt(iso) {
  if (!iso) return '—';
  try {
    const d   = new Date(iso.includes('T') ? iso : iso + 'T00:00:00');
    const now = new Date();
    const ms  = d - now;
    if (ms < 0) return `${_ago(iso)} ⚠ overdue`;
    if (Math.abs(ms) < 30000) return 'now';
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
  _showTemplates = false; // [BUG-13 FIX] reset panel state on every render — prevents stale toggle

  _container.innerHTML = `
    <div style="max-width:900px;margin:0 auto;padding:24px 20px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:10px;">
        <h1 style="margin:0;font-size:1.4rem;font-weight:700;">🔔 Reminders</h1>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button id="rm-analytics-btn"
            style="padding:8px 14px;border:1px solid var(--color-border,#e2e8f0);border-radius:8px;
            cursor:pointer;font-size:0.875rem;background:var(--color-surface,#fff);
            color:var(--color-text,#1e293b);">
            📊 Analytics
          </button>
          <button id="rm-templates-btn"
            style="padding:8px 14px;border:1px solid var(--color-border,#e2e8f0);border-radius:8px;
            cursor:pointer;font-size:0.875rem;background:var(--color-surface,#fff);
            color:var(--color-text,#1e293b);">
            📋 Templates
          </button>
          <button id="rm-new"
            style="padding:9px 18px;background:var(--color-primary,#4f8ef7);color:#fff;
            border:none;border-radius:8px;cursor:pointer;font-weight:600;font-size:0.875rem;">
            + New Reminder
          </button>
        </div>
      </div>

      <!-- [v5.1.0] Template Library panel (collapsible) -->
      <div id="rm-template-panel" style="display:none;background:var(--color-surface,#fff);
        border:1px solid var(--color-border,#e2e8f0);border-radius:10px;
        padding:16px;margin-bottom:20px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
          <div style="font-weight:700;font-size:0.95rem;">📋 Template Library</div>
          <button id="rm-tpl-close" style="border:none;background:none;cursor:pointer;font-size:1rem;color:var(--color-text-muted,#94a3b8);">✕</button>
        </div>
        <div id="rm-tpl-list" style="display:flex;flex-direction:column;gap:6px;">
          <div style="color:var(--color-text-muted,#94a3b8);font-size:0.85rem;">Loading templates…</div>
        </div>
        <div style="margin-top:10px;border-top:1px solid var(--color-border,#e2e8f0);padding-top:10px;">
          <button id="rm-tpl-new" style="font-size:0.8rem;padding:5px 12px;border:1px dashed var(--color-accent,#4f8ef7);
            border-radius:6px;background:transparent;color:var(--color-accent,#4f8ef7);cursor:pointer;">
            + New Template
          </button>
        </div>
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

  // Wire buttons
  _container.querySelector('#rm-new')?.addEventListener('click', () => openReminderForm({}));
  _container.querySelector('#rm-analytics-btn')?.addEventListener('click', () => {
    import('../core/router.js').then(m => m.navigate('reminder-analytics')).catch(() => {});
  });
  _container.querySelector('#rm-search')?.addEventListener('input', e => { _searchQ = e.target.value; _renderList(gen); });
  _container.querySelector('#rm-filter')?.addEventListener('change', e => { _filterStatus = e.target.value; _renderList(gen); });

  // [v5.1.0] Template panel toggle
  _container.querySelector('#rm-templates-btn')?.addEventListener('click', () => {
    _showTemplates = !_showTemplates;
    const panel = _container.querySelector('#rm-template-panel');
    if (panel) { panel.style.display = _showTemplates ? 'block' : 'none'; }
    if (_showTemplates) _renderTemplatePanel().catch(e => console.warn("[reminders] template panel error:", e));
  });
  _container.querySelector('#rm-tpl-close')?.addEventListener('click', () => {
    _showTemplates = false;
    const panel = _container.querySelector('#rm-template-panel');
    if (panel) panel.style.display = 'none';
  });
  _container.querySelector('#rm-tpl-new')?.addEventListener('click', () => {
    openReminderForm({ prefill: { isTemplate: true } });
  });

  const refreshOn = [EVENTS.REMINDER_CREATED, EVENTS.REMINDER_UPDATED,
                     EVENTS.REMINDER_DISMISSED, EVENTS.REMINDER_PAUSED,
                     EVENTS.REMINDER_RESUMED,   EVENTS.REMINDER_SNOOZED];
  for (const evt of refreshOn) {
    _unsubs.push(on(evt, () => {
      _renderList(gen);
      if (_showTemplates) _renderTemplatePanel().catch(e => console.warn("[reminders] template panel error:", e));
    }));
  }

  const _navUnsub = on(EVENTS.VIEW_CHANGED, () => {
    _unsubs.forEach(fn => { try { fn(); } catch {} });
    _unsubs = [];
    _navUnsub();
  });

  await _renderList(gen);
}

// ════════════════════════════════════════════════════════════
// [v5.1.0] TEMPLATE PANEL
// ════════════════════════════════════════════════════════════

async function _renderTemplatePanel() {
  const listEl = _container?.querySelector('#rm-tpl-list');
  if (!listEl) return;
  const all       = await getEntitiesByType('reminder');
  const templates = all.filter(r => r.isTemplate && !r.deleted);

  if (!templates.length) {
    listEl.innerHTML = '<div style="color:var(--color-text-muted,#94a3b8);font-size:0.85rem;">No templates yet. Create a reminder and check "Save as template".</div>';
    return;
  }

  listEl.innerHTML = '';
  for (const tpl of templates) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--color-border,#e2e8f0);border-radius:8px;background:var(--color-surface-raised,#f8fafc);';

    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0;';
    info.innerHTML = `
      <div style="font-weight:600;font-size:0.875rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(tpl.title||'Untitled Template')}</div>
      <div style="font-size:0.72rem;color:var(--color-text-muted,#94a3b8);">
        ${tpl.conditionMode && tpl.conditionMode !== 'none' ? '🔍 Has conditions · ' : ''}
        ${tpl.rrule ? '🔁 ' + _esc(rruleToHuman(tpl.rrule)) + ' · ' : ''}
        Priority: ${_esc(tpl.priority||'Normal')}
      </div>`;
    row.appendChild(info);

    // Apply template button
    const applyBtn = document.createElement('button');
    applyBtn.textContent = '▶ Apply';
    applyBtn.style.cssText = 'padding:4px 10px;border:1px solid var(--color-accent,#4f8ef7);border-radius:6px;background:transparent;color:var(--color-accent,#4f8ef7);cursor:pointer;font-size:0.8rem;font-weight:600;white-space:nowrap;';
    applyBtn.addEventListener('click', () => _showApplyTemplateModal(tpl));
    row.appendChild(applyBtn);

    // Edit button
    const editBtn = document.createElement('button');
    editBtn.textContent = '✏️';
    editBtn.style.cssText = 'padding:4px 8px;border:1px solid var(--color-border,#e2e8f0);border-radius:6px;background:transparent;cursor:pointer;font-size:0.8rem;';
    editBtn.addEventListener('click', () => openReminderForm({ reminderId: tpl.id }));
    row.appendChild(editBtn);

    listEl.appendChild(row);
  }
}

/**
 * [v5.1.0] Show modal to apply a reminder template to matching entities.
 */
function _showApplyTemplateModal(tpl) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9000;display:flex;align-items:center;justify-content:center;';

  const modal = document.createElement('div');
  modal.style.cssText = 'background:var(--color-bg,#fff);border-radius:12px;padding:24px;max-width:420px;width:92%;box-shadow:0 20px 60px rgba(0,0,0,.3);';

  const TARGET_TYPES = ['task','event','note','project','contact','appointment','person'];

  modal.innerHTML = `
    <h3 style="margin:0 0 4px;font-size:1rem;">Apply Template</h3>
    <p style="margin:0 0 16px;font-size:0.82rem;color:var(--color-text-muted,#94a3b8);">
      Creates a copy of <strong>${_esc(tpl.title||'template')}</strong> linked to each matching entity.
    </p>
    <div style="display:flex;flex-direction:column;gap:10px;">
      <div>
        <label style="font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--color-text-muted,#64748b);display:block;margin-bottom:4px;">Target entity type</label>
        <select id="tpl-type-sel" style="width:100%;padding:8px;border:1px solid var(--color-border,#e2e8f0);border-radius:8px;font-size:0.875rem;background:var(--color-surface,#fff);color:var(--color-text,#1e293b);">
          ${TARGET_TYPES.map(t => `<option value="${t}">${t.charAt(0).toUpperCase()+t.slice(1)}s</option>`).join('')}
        </select>
      </div>
      <div id="tpl-condition-note" style="font-size:0.75rem;color:var(--color-text-muted,#94a3b8);">
        ${tpl.conditionMode && tpl.conditionMode !== 'none'
          ? `🔍 Condition filter is active — only matching ${TARGET_TYPES[0]}s will receive a reminder.`
          : 'All entities of the selected type will receive a copy of this reminder.'}
      </div>
      <div id="tpl-apply-status" style="font-size:0.8rem;min-height:18px;color:var(--color-accent,#4f8ef7);"></div>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:20px;">
      <button id="tpl-cancel" style="padding:8px 16px;border:1px solid var(--color-border,#e2e8f0);border-radius:8px;cursor:pointer;font-size:0.875rem;background:transparent;">Cancel</button>
      <button id="tpl-apply"  style="padding:8px 18px;background:var(--color-primary,#4f8ef7);color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600;font-size:0.875rem;">Apply Template</button>
    </div>`;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const typeSel    = modal.querySelector('#tpl-type-sel');
  const condNote   = modal.querySelector('#tpl-condition-note');
  const statusEl   = modal.querySelector('#tpl-apply-status');
  const cancelBtn  = modal.querySelector('#tpl-cancel');
  const applyBtn   = modal.querySelector('#tpl-apply');

  typeSel.addEventListener('change', () => {
    if (tpl.conditionMode && tpl.conditionMode !== 'none') {
      condNote.textContent = `🔍 Condition filter is active — only matching ${typeSel.value}s will receive a reminder.`;
    }
  });

  const close = () => overlay.remove();
  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  applyBtn.addEventListener('click', async () => {
    applyBtn.disabled = true;
    applyBtn.textContent = 'Applying…';
    statusEl.textContent = '';
    const svc = window._fhEnv?.services?.reminder;
    if (!svc) {
      statusEl.style.color = 'var(--color-danger,#ef4444)';
      statusEl.textContent = 'Reminder service not ready. Please try again.';
      applyBtn.disabled = false;
      applyBtn.textContent = 'Apply Template';
      return;
    }
    try {
      const results = await svc.applyTemplate(tpl.id, typeSel.value, tpl.conditionJson || null);
      statusEl.style.color = 'var(--color-success-text,#15803d)';
      statusEl.textContent = `✓ Created ${results.length} reminder${results.length !== 1 ? 's' : ''} from template.`;
      setTimeout(close, 1800);
    } catch (err) {
      console.error('[reminders] applyTemplate failed:', err);
      statusEl.style.color = 'var(--color-danger,#ef4444)';
      statusEl.textContent = 'Failed: ' + (err.message || 'Unknown error');
      applyBtn.disabled = false;
      applyBtn.textContent = 'Apply Template';
    }
  });
}

// ════════════════════════════════════════════════════════════
// MAIN LIST
// ════════════════════════════════════════════════════════════

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

  let filtered;
  if (_filterStatus === 'isTemplate') {
    filtered = groups.templates;
  } else if (_filterStatus !== 'all') {
    filtered = all.filter(r => r.status === _filterStatus && !r.isTemplate);
    if (!filtered.length) { body.innerHTML = _emptyState(); return; }
    body.innerHTML = filtered.map(_row).join('');
    _wireRows(body, gen); return;
  } else {
    filtered = null;
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
  const hasCond = r.conditionMode && r.conditionMode !== 'none';

  const btns = [];
  if (r.status === 'active' || r.status === 'snoozed') {
    btns.push(`<button data-act="edit"    data-id="${_esc(r.id)}" title="Edit"                    style="${_bs()}">✏️</button>`);
    btns.push(`<button data-act="snooze"  data-id="${_esc(r.id)}" title="Snooze (adaptive)"       style="${_bs()}">💤</button>`);
    btns.push(`<button data-act="skip"    data-id="${_esc(r.id)}" title="Skip this occurrence"    style="${_bs()}">⏭</button>`);
    btns.push(`<button data-act="pause"   data-id="${_esc(r.id)}" title="Pause"                   style="${_bs()}">⏸</button>`);
    btns.push(`<button data-act="dismiss" data-id="${_esc(r.id)}" title="Mark done"               style="${_bs()}color:var(--color-success-text,#15803d);">✓</button>`);
  }
  if (r.status === 'paused') {
    btns.push(`<button data-act="resume" data-id="${_esc(r.id)}" title="Resume" style="${_bs()}">▶</button>`);
    btns.push(`<button data-act="edit"   data-id="${_esc(r.id)}" title="Edit"   style="${_bs()}">✏️</button>`);
  }
  if (r.isTemplate) {
    btns.push(`<button data-act="apply-template" data-id="${_esc(r.id)}" title="Apply template" style="${_bs()}color:var(--color-accent,#4f8ef7);">▶ Apply</button>`);
    btns.push(`<button data-act="edit"      data-id="${_esc(r.id)}" title="Edit"      style="${_bs()}">✏️</button>`);
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
        ${r.conditionMode && r.conditionMode !== 'none' ? '<span style="font-size:0.65rem;color:var(--color-accent,#4f8ef7);">🔍 Condition</span>' : ''}
      </div>
    </div>
    <div style="display:flex;gap:4px;flex-shrink:0;">${btns.join('')}</div>
  </div>`;
}

function _bs(danger) {
  return `padding:4px 7px;border-radius:6px;border:1px solid var(--color-border,#e2e8f0);
    cursor:pointer;font-size:0.78rem;background:transparent;
    color:${danger ? 'var(--color-danger,#ef4444)' : 'var(--color-text-muted,#64748b)'};`;
}

function _wireRows(body, gen) {
  body.querySelectorAll('[data-act]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const skipRerender = await _action(btn.dataset.act, btn.dataset.id);
      // [BUG-30 FIX] apply-template returns true to signal no re-render needed (modal handles it)
      if (!skipRerender) _renderList(gen);
    });
  });
  body.querySelectorAll('.rm-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('[data-act]')) return;
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

    // [v5.1.0] Adaptive snooze — writes reminderLog with outcome='snoozed'
    case 'snooze': {
      const r = await getEntity(id);
      const mins = svc?.adaptiveSnooze?.(r) ?? 10;
      await svc?.snooze(id, mins);
      toast.success(`Snoozed ${mins}m`);
      break;
    }

    // [v5.1.0] Skip — advance recurrence without marking done; writes reminderLog outcome='skipped'
    case 'skip': {
      const r = await getEntity(id);
      if (!r) break;
      // Write skip log before advancing
      await saveEntity({
        type:       'reminderLog',
        title:      `${r.title||'Reminder'} — skipped`,
        reminderId: id,
        outcome:    'skipped',
        firedAt:    new Date().toISOString(),
        resolvedAt: new Date().toISOString(),
        fireCount:  r.fireCount || 0,
        targetId:   null,
      }, getAccount()?.id);
      // If recurring, advance to next occurrence; otherwise just dismiss without double-logging
      if (r.rrule) {
        const next = nextDate(r.rrule, r.nextFireAt, r.fireAt);
        const updated = { ...r, nextFireAt: next || r.nextFireAt, fireCount: (r.fireCount||0)+1 };
        await saveEntity(updated, getAccount()?.id);
        emit(EVENTS.REMINDER_UPDATED, { reminder: updated });
      } else {
        // [BUG-20 FIX] Use saveEntity directly to avoid svc.dismiss writing a duplicate log
        const dismissed = { ...r, status: 'dismissed', nextFireAt: null, dismissedAt: new Date().toISOString() };
        await saveEntity(dismissed, getAccount()?.id);
        emit(EVENTS.REMINDER_DISMISSED, { reminderId: id });
      }
      toast.info('Skipped');
      break;
    }

    // [v5.1.0] Completion tracking — marks done and writes reminderLog outcome='done'
    case 'dismiss': {
      await svc?.dismiss(id);
      // Clear any active in-memory alert
      if (svc) {
        for (const a of svc.getActiveAlerts()) {
          if (a.reminderId === id) svc.dismissAlert(a.id);
        }
      }
      const r = await getEntity(id).catch(() => null);
      if (r) {
        await saveEntity({
          type:       'reminderLog',
          title:      `${r.title||'Reminder'} — done`,
          reminderId: id,
          outcome:    'done',
          firedAt:    r.lastFiredAt || new Date().toISOString(),
          resolvedAt: new Date().toISOString(),
          fireCount:  r.fireCount || 0,
          targetId:   null,
        }, getAccount()?.id).catch(() => {});
      }
      break;
    }

    // [v5.1.0] Apply template directly from the row button
    case 'apply-template': {
      const tpl = await getEntity(id);
      if (tpl) _showApplyTemplateModal(tpl);
      return true; // [BUG-30 FIX] signal _wireRows to skip _renderList (modal handles refresh)
    }

    case 'duplicate': {
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
