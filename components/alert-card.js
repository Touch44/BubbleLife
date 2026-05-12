/**
 * FamilyHub v5.0.0 — components/alert-card.js
 * Alert drawer: slide-in panel showing reminder fire alerts.
 * Wires FAB badge via ALERT_COUNT_CHANGED.
 *
 * CRITICAL: removeAttribute('data-alerts') when count=0 — NOT setAttribute('','0')
 * CSS uses [data-alerts]::after so attribute must be absent to hide badge.
 *
 * Public API:
 *   mountAlertDrawer()       — call once from index.html init
 *   toggleAlertDrawer()      — show/hide drawer
 */

import { on, EVENTS } from '../core/events.js'; // emit removed (unused)

let _drawer     = null;
let _drawerList = null;
let _mounted    = false;
let _userClosed = false; // NEW-L-02: track manual close to avoid auto-reopen

const PRIORITY_COLOR = {
  Urgent: '#ef4444',
  High:   '#f59e0b',
  Normal: '#3b82f6',
  Low:    '#94a3b8',
};

function _esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _ago(iso) {
  if (!iso) return '';
  const m = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m/60)}h ago`;
}

// ════════════════════════════════════════════════════════════
// MOUNT
// ════════════════════════════════════════════════════════════

export function mountAlertDrawer() {
  if (_mounted) return;
  _mounted = true;

  // ── Build drawer DOM ─────────────────────────────────────
  _drawer = document.createElement('div');
  _drawer.id = 'alert-drawer';
  _drawer.setAttribute('role', 'dialog');
  _drawer.setAttribute('aria-label', 'Active reminders');
  _drawer.setAttribute('aria-hidden', 'true');
  Object.assign(_drawer.style, {
    position:   'fixed',
    right:      '0',
    top:        '0',
    height:     '100vh',
    width:      'min(380px, 100vw)',
    zIndex:     '950',  // NEW-H-01 fix: above entity panel (~800-900), below modals (1100)
    background: 'var(--color-surface, #fff)',
    borderLeft: '1px solid var(--color-border, #e2e8f0)',
    boxShadow:  '-4px 0 24px rgba(0,0,0,0.12)',
    display:    'flex',
    flexDirection: 'column',
    transform:  'translateX(100%)',
    transition: 'transform 0.28s cubic-bezier(0.4,0,0.2,1)',
    overflow:   'hidden',
  });

  const header = document.createElement('div');
  header.style.cssText = `
    display:flex;align-items:center;justify-content:space-between;
    padding:16px 20px;border-bottom:1px solid var(--color-border,#e2e8f0);flex-shrink:0;
  `;
  header.innerHTML = `
    <span style="font-weight:600;font-size:1rem;">🔔 Active Reminders</span>
    <div style="display:flex;gap:8px;align-items:center;">
      <button id="alert-dismiss-all"
        style="font-size:0.73rem;padding:4px 10px;border:1px solid var(--color-border,#e2e8f0);
        border-radius:6px;cursor:pointer;background:transparent;color:var(--color-text-muted,#64748b);">
        Dismiss all
      </button>
      <button id="alert-drawer-close" aria-label="Close"
        style="font-size:1.1rem;background:none;border:none;cursor:pointer;
        color:var(--color-text-muted,#64748b);padding:4px;line-height:1;">✕</button>
    </div>
  `;

  _drawerList = document.createElement('div');
  _drawerList.style.cssText = 'flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;';

  _drawer.appendChild(header);
  _drawer.appendChild(_drawerList);
  document.body.appendChild(_drawer);

  header.querySelector('#alert-drawer-close')?.addEventListener('click', () => { _userClosed = true; _hide(); });
  header.querySelector('#alert-dismiss-all')?.addEventListener('click', async () => {
    // C-02 fix: dismiss underlying reminder IDB entities, not just clear in-memory alerts
    const svc = _svc();
    if (svc) {
      const alerts = svc.getActiveAlerts();
      // Dismiss each reminder entity so scheduler doesn't refire within 30s
      for (const alert of alerts) {
        svc.dismiss(alert.reminderId).catch(console.error);
      }
      svc.clearAllAlerts();
    }
    _hide();
  });

  // ── Event subscriptions ──────────────────────────────────
  on(EVENTS.ALERT_ADDED, (alert) => {
    _addCard(alert);
    // NEW-L-02 fix: don't auto-open if user manually closed the drawer
    if (!_userClosed) _show();
  });

  on(EVENTS.ALERT_DISMISSED, ({ alertId }) => {
    document.getElementById(`ac-${alertId}`)?.remove();
    if (!_drawerList.children.length) _hide();
  });

  on(EVENTS.ALERT_CLEARED_ALL, () => {
    _drawerList.innerHTML = '';
    _userClosed = false; // NEW-L-02: reset so next reminder can auto-open
    _hide();
  });

  // FAB badge wiring — removeAttribute when 0 (NOT setAttribute '0')
  on(EVENTS.ALERT_COUNT_CHANGED, (count) => {
    const btn = document.getElementById('fab-main-btn');
    if (!btn) return;
    if (count > 0) {
      btn.setAttribute('data-alerts', String(count));
    } else {
      btn.removeAttribute('data-alerts'); // ← MUST remove, not set '0'
    }
  });

  // M-07 fix: single delegated listener on document to close ALL snooze menus
  // instead of one permanent listener per card (which leaks)
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.ac-snooze-btn') && !e.target.closest('.ac-snooze-menu')) {
      _drawerList?.querySelectorAll('.ac-snooze-menu').forEach(m => m.style.display = 'none');
    }
  });

  console.log('[alert-drawer] Mounted');
}

// ════════════════════════════════════════════════════════════
// RENDER CARD
// ════════════════════════════════════════════════════════════

function _addCard(alert) {
  if (!_drawerList) return;

  const color = PRIORITY_COLOR[alert.priority] || PRIORITY_COLOR.Normal;
  const card  = document.createElement('div');
  card.id = `ac-${alert.id}`;
  card.style.cssText = `
    border:1px solid var(--color-border,#e2e8f0);
    border-left:4px solid ${color};border-radius:8px;
    padding:12px 14px;background:var(--color-surface-raised,#f8fafc);
  `;

  const targetText = alert.targets.map(t => t.title).join(', ');

  card.innerHTML = `
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap;">
      <span style="font-size:0.65rem;font-weight:700;padding:2px 6px;border-radius:4px;
        background:${color};color:var(--color-white,#fff);text-transform:uppercase;letter-spacing:0.05em;">
        ${_esc(alert.priority)}
      </span>
      <span style="font-weight:600;font-size:0.875rem;">${_esc(alert.title)}</span>
    </div>
    ${targetText ? `<div style="font-size:0.75rem;color:var(--color-text-muted,#64748b);margin-bottom:4px;">📎 ${_esc(targetText)}</div>` : ''}
    ${alert.notes ? `<div style="font-size:0.8rem;margin-bottom:6px;color:var(--color-text,#1e293b);">${_esc(alert.notes)}</div>` : ''}
    <div style="font-size:0.7rem;color:var(--color-text-muted,#94a3b8);margin-bottom:10px;">
      Fired ${_ago(alert.firedAt)} · #${alert.fireCount}
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
      <div style="position:relative;display:inline-block;">
        <button class="ac-snooze-btn" style="font-size:0.75rem;padding:5px 10px;
          border-radius:6px;border:1px solid var(--color-border,#e2e8f0);
          cursor:pointer;background:var(--color-surface,#fff);">Snooze ▾</button>
        <div class="ac-snooze-menu" style="display:none;position:absolute;bottom:110%;left:0;
          background:var(--color-surface,#fff);border:1px solid var(--color-border,#e2e8f0);
          border-radius:8px;padding:4px;min-width:130px;z-index:10;
          box-shadow:0 4px 16px rgba(0,0,0,0.1);">
          ${[['10m',10],['30m',30],['1h',60],['Tomorrow','tomorrow']].map(([lbl,mins]) =>
            `<button class="ac-snooze-opt" data-mins="${mins}"
              style="display:block;width:100%;text-align:left;padding:6px 10px;
              border:none;background:none;cursor:pointer;border-radius:4px;font-size:0.8rem;">
              ${lbl}
            </button>`
          ).join('')}
        </div>
      </div>
      ${alert.targets[0]?.id ? `
        <button class="ac-open-btn" data-id="${_esc(alert.targets[0].id)}"
          style="font-size:0.75rem;padding:5px 10px;border-radius:6px;
          border:1px solid var(--color-border,#e2e8f0);cursor:pointer;background:var(--color-surface,#fff);">
          Open Entity
        </button>` : ''}
      <button class="ac-dismiss-btn"
        style="font-size:0.75rem;padding:5px 12px;border-radius:6px;border:none;
        cursor:pointer;background:var(--color-primary,#4f8ef7);color:var(--color-white,#fff);margin-left:auto;font-weight:600;">
        ✓ Done
      </button>
    </div>
  `;

  // Wire snooze dropdown
  const snoozeBtn  = card.querySelector('.ac-snooze-btn');
  const snoozeMenu = card.querySelector('.ac-snooze-menu');
  snoozeBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    snoozeMenu.style.display = snoozeMenu.style.display === 'block' ? 'none' : 'block';
  });
  snoozeMenu?.querySelectorAll('.ac-snooze-opt').forEach(opt => {
    opt.addEventListener('click', () => {
      const svc = _svc();
      // C-05 fix: 'tomorrow' = next calendar day at 9am, not a fixed minute count
      if (opt.dataset.mins === 'tomorrow') {
        const now = new Date();
        const tom = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0);
        const msUntilTom = tom - now;
        const minsUntilTom = Math.ceil(msUntilTom / 60000);
        svc?.snooze(alert.reminderId, minsUntilTom);
      } else {
        const mins = parseInt(opt.dataset.mins, 10);
        svc?.snooze(alert.reminderId, mins);
      }
      svc?.dismissAlert(alert.id);
    });
  });
  // M-07 fix: outside-click handled by single delegated listener in mountAlertDrawer

  // Wire open entity — H-06 fix: close over the button directly, don't re-querySelector
  const openBtn = card.querySelector('.ac-open-btn');
  openBtn?.addEventListener('click', () => {
    const id = openBtn.dataset.id;
    if (id) import('./entity-panel.js').then(m => m.openPanel(id)).catch(console.error);
  });

  // Wire dismiss
  card.querySelector('.ac-dismiss-btn')?.addEventListener('click', () => {
    const svc = _svc();
    svc?.dismiss(alert.reminderId);
    svc?.dismissAlert(alert.id);
  });

  _drawerList.prepend(card);
}

// ── Drawer visibility ─────────────────────────────────────── //

function _show() {
  if (!_drawer) return;
  _drawer.style.transform = 'translateX(0)';
  _drawer.setAttribute('aria-hidden', 'false');
}

function _hide() {
  if (!_drawer) return;
  _drawer.style.transform = 'translateX(100%)';
  _drawer.setAttribute('aria-hidden', 'true');
}

export function toggleAlertDrawer() {
  if (!_drawer) return;
  const open = _drawer.style.transform === 'translateX(0)' ||
               _drawer.style.transform === 'translateX(0px)';
  open ? _hide() : _show();
}

function _svc() { return window._fhEnv?.services?.reminder || null; }
