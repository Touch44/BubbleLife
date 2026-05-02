/**
 * FamilyHub v4.2 — services/notification.js
 * Notification Service — typed toasts with action buttons, auto-dismiss.
 * Implements Prompt 01 spec exactly.
 *
 * Registered as env.services.notification via serviceRegistry.
 *
 * Public API (on env.services.notification):
 *   info(message, options?)      — blue informational toast
 *   success(message, options?)   — green success toast
 *   warning(message, options?)   — amber warning toast (also: warn)
 *   danger(message, options?)    — red danger toast (also: error)
 *   dismiss(id)                  — programmatically dismiss a toast
 *
 * Options:
 *   duration?:  number (ms) — 0 = permanent; default 4000
 *   action?:    { label: string, fn: () => void } — action button
 *   id?:        string — custom ID for programmatic dismiss
 *
 * Toasts stack vertically in bottom-right, 12px gap.
 * Entry: slides in from right + fade. Exit: slides out + fade.
 */

let _container = null;
let _idCounter  = 0;

/** Active toast map: id → { el, timer } */
const _active = new Map();

/** Type → CSS class and icon */
const TYPE_CONFIG = {
  info:    { cls: 'notif-info',    icon: 'ℹ' },
  success: { cls: 'notif-success', icon: '✓' },
  warning: { cls: 'notif-warning', icon: '⚠' },
  danger:  { cls: 'notif-danger',  icon: '✕' },
};

// ── DOM setup ─────────────────────────────────────────────── //

function _ensureContainer() {
  if (typeof document === 'undefined') return null;   // SSR / Node guard
  if (_container?.isConnected) return _container;

  // Use existing #toast-container from index.html, or create one
  _container = document.getElementById('toast-container');
  if (!_container) {
    _container = document.createElement('div');
    _container.id = 'toast-container';
    document.body.appendChild(_container);
  }
  return _container;
}

// ── Core show function ────────────────────────────────────── //

/**
 * Show a notification toast.
 * @param {string} type — 'info' | 'success' | 'warning' | 'danger'
 * @param {string} message
 * @param {object} [opts]
 * @returns {string} toast id
 */
function _show(type, message, opts = {}) {
  if (typeof document === 'undefined') {
    // Non-browser environment (Node/test) — log and return a no-op id
    console.log(`[notification:${type}] ${message}`);
    return `notif-noop-${++_idCounter}`;
  }
  const { duration = 4000, action, id: customId } = opts;
  const id = customId || `notif-${++_idCounter}`;
  const config = TYPE_CONFIG[type] || TYPE_CONFIG.info;

  const container = _ensureContainer();

  const el = document.createElement('div');
  el.className = `toast toast-${type.replace('warning', 'warn')} notif-toast ${config.cls}`;
  el.setAttribute('role', type === 'danger' ? 'alert' : 'status');
  el.setAttribute('data-notif-id', id);

  el.innerHTML = `
    <span class="toast-icon notif-icon" aria-hidden="true">${config.icon}</span>
    <span class="toast-message notif-message">${_esc(message)}</span>
    ${action ? `<button class="toast-action notif-action">${_esc(action.label)}</button>` : ''}
    <button class="toast-close notif-close" aria-label="Dismiss">×</button>
  `;

  if (action) {
    el.querySelector('.notif-action')?.addEventListener('click', () => {
      try { (action.onClick ?? action.fn)?.(); } catch(e) { console.error('[notification] action handler threw:', e); }
      _dismiss(id);
    });
  }
  el.querySelector('.notif-close')?.addEventListener('click', () => _dismiss(id));

  container.appendChild(el);

  // Animate in (next frame so transition applies)
  requestAnimationFrame(() => el.classList.add('toast-visible'));

  // Auto-dismiss
  let timer = null;
  if (duration > 0) {
    timer = setTimeout(() => _dismiss(id), duration);
  }

  _active.set(id, { el, timer });
  return id;
}

function _dismiss(id) {
  const entry = _active.get(id);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  const { el } = entry;
  el.classList.remove('toast-visible');
  el.classList.add('toast-hiding');
  setTimeout(() => { el.remove(); _active.delete(id); }, 300);
}

function _esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Service factory ───────────────────────────────────────── //

export function createNotificationService() {
  return {
    info    : (msg, opts) => _show('info',    msg, opts),
    success : (msg, opts) => _show('success', msg, opts),
    warning : (msg, opts) => _show('warning', msg, opts),
    warn    : (msg, opts) => _show('warning', msg, opts),   // alias
    danger  : (msg, opts) => _show('danger',  msg, opts),
    error   : (msg, opts) => _show('danger',  msg, opts),   // alias
    dismiss : (id)        => _dismiss(id),
  };
}

// ── Service descriptor ────────────────────────────────────── //

export const notificationServiceDescriptor = {
  dependencies: [],
  start() {
    return createNotificationService();
  },
};
