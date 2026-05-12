/**
 * FamilyHub v5.0.0 — components/reminder-form.js
 * Reminder create/edit modal.
 *
 * Public API:
 *   openReminderForm(opts)   — open form
 *   closeReminderForm()      — close and clean up
 *
 * opts: { reminderId?, targetEntityId?, targetEntity?, prefill? }
 */

import { getEntity, saveEntity, getEdgesFrom } from '../core/db.js';
import { presetToRrule, rruleToHuman }          from '../services/rrule-lite.js';
import { createReminder }                        from '../services/reminder.js';
import { emit, EVENTS }                          from '../core/events.js';
import { getAccount }                            from '../core/auth.js';

let _modal   = null;
let _overlay = null;

function _esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _localISO(d) {
  const p = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── Public API ────────────────────────────────────────────── //

export async function openReminderForm(opts = {}) {
  closeReminderForm();
  const { reminderId, targetEntityId, targetEntity: passedTarget, prefill = {} } = opts;

  let existing  = null;
  let targetEnt = passedTarget || null;

  if (reminderId) {
    existing = await getEntity(reminderId);
    if (!existing) return;
  }
  if (!targetEnt && targetEntityId) {
    targetEnt = await getEntity(targetEntityId).catch(() => null);
  }
  if (!targetEnt && existing) {
    const edges = await getEdgesFrom(existing.id, 'reminds');
    if (edges[0]) targetEnt = await getEntity(edges[0].toId).catch(() => null);
  }

  _buildModal(existing, targetEnt, prefill);
}

export function closeReminderForm() {
  _modal?.remove();
  _overlay?.remove();
  _modal = _overlay = null;
}

// ── Build modal ───────────────────────────────────────────── //

function _buildModal(existing, targetEnt, prefill) {
  _overlay = document.createElement('div');
  _overlay.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:1100;
    display:flex;align-items:center;justify-content:center;padding:16px;
  `;
  _overlay.addEventListener('click', e => { if (e.target === _overlay) closeReminderForm(); });

  _modal = document.createElement('div');
  _modal.style.cssText = `
    background:var(--color-surface,#fff);border-radius:16px;
    width:min(560px,100%);max-height:90vh;overflow-y:auto;
    box-shadow:0 20px 60px rgba(0,0,0,0.25);padding:28px;
  `;

  const isEdit = !!existing;
  const d = existing || prefill;
  const now = new Date();
  const quick = [
    { label: 'In 10m', iso: _localISO(new Date(now.getTime() + 600000)) },
    { label: 'In 1h',  iso: _localISO(new Date(now.getTime() + 3600000)) },
    { label: 'Tomorrow 9am', iso: _localISO(new Date(now.getFullYear(), now.getMonth(), now.getDate()+1, 9)) },
  ];

  // M-04 fix: strip Z suffix or timezone offset before slicing for datetime-local input
  const _rawFireAt = d.fireAt || quick[1].iso;
  const defaultFireAt = _rawFireAt.replace(/Z$/, '').replace(/[+-]\d{2}:\d{2}$/, '').slice(0, 16);
  const currentRrule   = d.rrule || '';
  const rruleHuman     = currentRrule ? rruleToHuman(currentRrule) : 'Does not repeat';

  const targetChip = targetEnt
    ? `<div style="padding:6px 12px;background:var(--color-surface-raised,#f1f5f9);border-radius:6px;
        font-size:0.8rem;display:inline-flex;align-items:center;gap:6px;">
        📎 ${_esc(targetEnt.title || targetEnt.name || 'Entity')}
       </div>`
    : `<span style="font-size:0.8rem;color:var(--color-text-muted,#94a3b8);">No entity linked</span>`;

  const priorityRadios = ['Urgent','High','Normal','Low'].map(p => {
    const active = (d.priority || 'Normal') === p;
    const color  = { Urgent:'#ef4444', High:'#f59e0b', Normal:'#3b82f6', Low:'#94a3b8' }[p];
    return `<label style="flex:1;cursor:pointer;">
      <input type="radio" name="rf-priority" value="${p}" class="rf-pri-input"
        ${active ? 'checked' : ''} style="display:none;" />
      <span class="rf-pri-lbl" data-val="${p}" style="display:block;text-align:center;
        padding:6px 4px;border-radius:8px;font-size:0.75rem;border:2px solid ${active ? color : 'var(--color-border,#e2e8f0)'};
        background:${active ? color + '20' : 'transparent'};color:${active ? color : 'inherit'};">
        ${p}
      </span>
    </label>`;
  }).join('');

  // C-04 fix: detect whether currentRrule matches any preset
  const _presetList = [
    ['one-time','Does not repeat'],['daily','Daily'],['weekdays','Weekdays'],
    ['weekends','Weekends'],['weekly','Weekly'],['biweekly','Every 2 weeks'],
    ['monthly','Monthly'],['monthly-first-monday','1st Monday of month'],['yearly','Annually'],
  ];
  const _hasPresetMatch = currentRrule
    ? _presetList.some(([val]) => presetToRrule(val) === currentRrule)
    : true; // no rrule = one-time, which has a preset

  const rruleOptions = _presetList.map(([val, lbl]) => {
    const rule    = presetToRrule(val);
    const matches = rule ? rule === currentRrule : !currentRrule;
    return `<option value="${val}" ${matches ? 'selected' : ''}>${lbl}</option>`;
  }).join('') + (!_hasPresetMatch && currentRrule
    ? `<option value="__custom__" selected>Custom (${_esc(rruleToHuman(currentRrule))})</option>`
    : '');

  _modal.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
      <h2 style="margin:0;font-size:1.1rem;">${isEdit ? '✏️ Edit Reminder' : '🔔 New Reminder'}</h2>
      <button id="rf-x" style="font-size:1.2rem;background:none;border:none;cursor:pointer;
        color:var(--color-text-muted,#94a3b8);padding:4px;">✕</button>
    </div>

    ${!isEdit ? `<div style="margin-bottom:16px;">
      <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.06em;
        color:var(--color-text-muted,#94a3b8);margin-bottom:8px;">Quick set</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        ${quick.map(q => `<button class="rf-quick" data-iso="${_esc(q.iso)}"
          style="font-size:0.75rem;padding:5px 12px;border-radius:20px;cursor:pointer;
          border:1px solid var(--color-border,#e2e8f0);background:var(--color-surface-raised,#f8fafc);">
          ${q.label}</button>`).join('')}
      </div>
    </div>` : ''}

    <div style="display:flex;flex-direction:column;gap:14px;">
      <!-- Title -->
      <div>
        <label style="${_lbl()}">Title</label>
        <input id="rf-title" type="text" value="${_esc(d.title || '')}"
          placeholder="${targetEnt ? _esc(targetEnt.title || targetEnt.name || 'Reminder') : 'Reminder title'}"
          style="${_inp()}" />
      </div>

      <!-- Target -->
      <div>
        <label style="${_lbl()}">Linked To</label>
        ${targetChip}
      </div>

      <!-- When -->
      <div>
        <label style="${_lbl()}">When</label>
        <input id="rf-fire-at" type="datetime-local" value="${_esc(defaultFireAt)}" style="${_inp()}" />
      </div>

      <!-- Repeat -->
      <div>
        <label style="${_lbl()}">Repeat</label>
        <select id="rf-rrule" style="${_inp()}">${rruleOptions}</select>
        <div id="rf-rrule-preview" style="font-size:0.73rem;color:var(--color-text-muted,#94a3b8);margin-top:4px;">
          ${_esc(rruleHuman)}
        </div>
      </div>

      <!-- Priority -->
      <div>
        <label style="${_lbl()}">Priority</label>
        <div style="display:flex;gap:6px;">${priorityRadios}</div>
      </div>

      <!-- Channels -->
      <div>
        <label style="${_lbl()}">Notify via</label>
        <div style="display:flex;gap:14px;flex-wrap:wrap;">
          ${[
            ['rf-ch-inapp', 'In-app',  d.channelInApp !== false],
            ['rf-ch-toast', 'Toast',   d.channelToast !== false],
            ['rf-ch-push',  'Push',    !!d.channelPush],
            ['rf-ch-audio', 'Audio',   !!d.channelAudio],
          ].map(([id, lbl, checked]) =>
            `<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:0.85rem;">
              <input id="${id}" type="checkbox" ${checked ? 'checked' : ''} /> ${lbl}
            </label>`
          ).join('')}
        </div>
      </div>

      <!-- Notes -->
      <div>
        <label style="${_lbl()}">Notes</label>
        <textarea id="rf-notes" rows="2" placeholder="Optional…"
          style="${_inp()}resize:vertical;">${_esc(d.notes || '')}</textarea>
      </div>
    </div>

    <div id="rf-error" style="display:none;color:var(--color-danger,#ef4444);font-size:0.8rem;margin-top:12px;"></div>

    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px;">
      <button id="rf-cancel" style="padding:9px 20px;border-radius:8px;border:1px solid
        var(--color-border,#e2e8f0);cursor:pointer;font-size:0.875rem;background:transparent;">
        Cancel
      </button>
      <button id="rf-save" style="padding:9px 22px;border-radius:8px;border:none;cursor:pointer;
        font-size:0.875rem;background:var(--color-primary,#4f8ef7);color:#fff;font-weight:600;">
        ${isEdit ? 'Save changes' : '🔔 Set reminder'}
      </button>
    </div>
  `;

  _overlay.appendChild(_modal);
  document.body.appendChild(_overlay);

  // Wire
  _modal.querySelector('#rf-x')?.addEventListener('click', closeReminderForm);
  _modal.querySelector('#rf-cancel')?.addEventListener('click', closeReminderForm);

  _modal.querySelectorAll('.rf-quick').forEach(btn => {
    btn.addEventListener('click', () => {
      const fi = _modal.querySelector('#rf-fire-at');
      if (fi) fi.value = btn.dataset.iso;
    });
  });

  const rruleEl   = _modal.querySelector('#rf-rrule');
  const rrulePrev = _modal.querySelector('#rf-rrule-preview');
  rruleEl?.addEventListener('change', () => {
    const val = rruleEl.value;
    if (val === '__custom__') {
      // NEW-C-03 fix: show human text for the custom rule being preserved
      rrulePrev.textContent = existing?.rrule ? rruleToHuman(existing.rrule) : 'Custom recurrence';
    } else {
      const rule = presetToRrule(val);
      rrulePrev.textContent = rule ? rruleToHuman(rule) : 'Does not repeat';
    }
  });

  _modal.querySelectorAll('.rf-pri-input').forEach(radio => {
    radio.addEventListener('change', () => {
      _modal.querySelectorAll('.rf-pri-lbl').forEach(lbl => {
        const col   = { Urgent:'#ef4444', High:'#f59e0b', Normal:'#3b82f6', Low:'#94a3b8' }[lbl.dataset.val];
        const act   = lbl.dataset.val === radio.value;
        lbl.style.borderColor = act ? col : 'var(--color-border,#e2e8f0)';
        lbl.style.background  = act ? col + '20' : 'transparent';
        lbl.style.color       = act ? col : 'inherit';
      });
    });
  });

  _modal.querySelector('#rf-save')?.addEventListener('click', () => _save(existing, targetEnt));
  setTimeout(() => _modal?.querySelector('#rf-title')?.focus(), 50);
}

function _lbl() {
  return 'font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;' +
         'color:var(--color-text-muted,#64748b);display:block;margin-bottom:4px;';
}
function _inp() {
  return 'width:100%;padding:8px 12px;border:1px solid var(--color-border,#e2e8f0);border-radius:8px;' +
         'font-size:0.875rem;box-sizing:border-box;background:var(--color-surface,#fff);' +
         'color:var(--color-text,#1e293b);';
}

async function _save(existing, targetEnt) {
  const errEl  = _modal?.querySelector('#rf-error');
  const saveBtn = _modal?.querySelector('#rf-save');
  if (!_modal) return;

  const fireAtRaw = _modal.querySelector('#rf-fire-at')?.value;
  if (!fireAtRaw) {
    if (errEl) { errEl.textContent = 'Please set a reminder time.'; errEl.style.display = 'block'; }
    return;
  }

  // NEW-H-08 fix: warn if the selected time is in the past (will fire immediately)
  const fireAtDate = new Date(fireAtRaw.length === 16 ? fireAtRaw + ':00' : fireAtRaw);
  if (fireAtDate < new Date() && !existing) {
    if (errEl) {
      errEl.textContent = '⚠ This time is in the past — the reminder will fire immediately.';
      errEl.style.display = 'block';
    }
    // Don't return — allow save (e.g. for test or intentional immediate fire)
    // Just warn
  }

  // datetime-local gives "YYYY-MM-DDTHH:MM" — safe local string, no Z
  const fireAt = fireAtRaw.length === 16 ? fireAtRaw + ':00' : fireAtRaw;

  const title    = _modal.querySelector('#rf-title')?.value?.trim()
    || (targetEnt ? (targetEnt.title || targetEnt.name || 'Reminder') : 'Reminder');
  const preset   = _modal.querySelector('#rf-rrule')?.value || 'one-time';
  // C-04 fix: preserve existing rrule when custom is selected (no preset match)
  const rrule    = preset === '__custom__'
    ? (existing?.rrule || null)
    : presetToRrule(preset);
  const priority = _modal.querySelector('input[name="rf-priority"]:checked')?.value || 'Normal';

  const data = {
    title,
    notes:        _modal.querySelector('#rf-notes')?.value?.trim() || '',
    priority,
    fireAt,
    nextFireAt:   fireAt,
    rrule,
    channelInApp: !!_modal.querySelector('#rf-ch-inapp')?.checked,
    channelToast: !!_modal.querySelector('#rf-ch-toast')?.checked,
    channelPush:  !!_modal.querySelector('#rf-ch-push')?.checked,
    channelAudio: !!_modal.querySelector('#rf-ch-audio')?.checked,
    timezone:     Intl.DateTimeFormat().resolvedOptions().timeZone,
    // NEW-H-09 fix: when editing a dismissed/expired reminder, only reactivate if
    // the user explicitly set a new fireAt in the future. Otherwise preserve status.
    status: (() => {
      if (!existing) return 'active'; // create mode always active
      const wasDone = existing.status === 'dismissed' || existing.status === 'expired';
      if (!wasDone) return 'active'; // was already active/snoozed/paused — reactivate
      // Was dismissed/expired: reactivate only if new fireAt is in the future
      const newFire = new Date(fireAt);
      return newFire > new Date() ? 'active' : (existing.status || 'dismissed');
    })(),
    // M-09 fix: do NOT include recurrenceEnd — let the existing value persist via ...existing
    // spread in saveEntity. Setting it unconditionally to 'never' wipes the user's end setting.
    // recurrenceEnd is a Phase 2 form field; for now preserve whatever value is in IDB.
  };

  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
  if (errEl)  errEl.style.display = 'none';

  try {
    if (existing) {
      const updated = await saveEntity({ ...existing, ...data }, getAccount()?.id);
      emit(EVENTS.REMINDER_UPDATED, { reminder: updated });
    } else {
      await createReminder(data, targetEnt?.id);
    }
    closeReminderForm();
  } catch (err) {
    console.error('[reminder-form] save failed:', err);
    if (errEl) { errEl.textContent = 'Failed to save. Please try again.'; errEl.style.display = 'block'; }
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = existing ? 'Save changes' : '🔔 Set reminder'; }
  }
}
