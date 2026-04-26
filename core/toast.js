/**
 * FamilyHub v3.0 — core/toast.js
 * Global toast notification system.
 * Renders into #toast-container (already in index.html).
 *
 * Public API:
 *   showToast(message, options?)
 *   toast.success(message, options?)
 *   toast.error(message, options?)
 *   toast.warn(message, options?)
 *   toast.info(message, options?)
 *
 * Options: { duration?: number (ms), action?: { label, onClick } }
 */

const DEFAULTS = {
  duration: 3000,
};

let _container = null;

function _getContainer() {
  if (!_container) {
    _container = document.getElementById('toast-container');
  }
  return _container;
}

/**
 * Show a toast notification.
 * @param {string} message
 * @param {'success'|'error'|'warn'|'info'} [type='info']
 * @param {object} [options]
 * @param {number} [options.duration=3000] — ms before auto-dismiss (0 = persistent)
 * @param {{label: string, onClick: Function}} [options.action] — optional action button
 */
export function showToast(message, type = 'info', options = {}) {
  const container = _getContainer();
  if (!container) {
    console.warn('[toast]', type, message);
    return;
  }

  const { duration = DEFAULTS.duration, action } = options;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');

  const icon = { success: '✓', error: '✕', warn: '⚠', info: 'ℹ' }[type] || 'ℹ';

  toast.innerHTML = `
    <span class="toast-icon" aria-hidden="true">${icon}</span>
    <span class="toast-message">${_esc(message)}</span>
    ${action ? `<button class="toast-action">${_esc(action.label)}</button>` : ''}
    <button class="toast-close" aria-label="Dismiss">&times;</button>
  `;

  if (action) {
    toast.querySelector('.toast-action').addEventListener('click', () => {
      action.onClick?.();
      _dismiss(toast);
    });
  }

  toast.querySelector('.toast-close').addEventListener('click', () => {
    _dismiss(toast);
  });

  container.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => {
    toast.classList.add('toast-visible');
  });

  // Auto-dismiss
  if (duration > 0) {
    setTimeout(() => _dismiss(toast), duration);
  }

  return toast;
}

function _dismiss(toast) {
  if (!toast.isConnected) return;
  toast.classList.remove('toast-visible');
  toast.classList.add('toast-hiding');
  setTimeout(() => toast.remove(), 300);
}

function _esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Convenience shorthands
export const toast = {
  success: (msg, opts) => showToast(msg, 'success', opts),
  error:   (msg, opts) => showToast(msg, 'error',   { duration: 5000, ...opts }),
  warn:    (msg, opts) => showToast(msg, 'warn',     opts),
  info:    (msg, opts) => showToast(msg, 'info',     opts),
};
