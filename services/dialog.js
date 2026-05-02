/**
 * FamilyHub v4.2 — services/dialog.js
 * Dialog Service — stacked dialogs, focus trap, confirm() Promise API.
 * Implements Prompt 02 spec.
 *
 * Registered as env.services.dialog via serviceRegistry.
 *
 * Public API:
 *   add(componentFn, props)            — mount a dialog; returns close()
 *   confirm(message, options?)         — Promise<boolean> confirm dialog
 *   closeTop()                         — close topmost dialog
 *   closeAll()                         — close all dialogs
 *
 * componentFn(props, close) must return an HTMLElement.
 * props.persistent = true  → backdrop click does NOT close dialog.
 */

/** Dialog stack: array of { el, backdrop, focusTrap, persistent } */
const _stack = [];

let _container = null;

function _ensureContainer() {
  if (_container?.isConnected) return _container;
  _container = document.createElement('div');
  _container.id = 'dialog-container';
  _container.setAttribute('aria-live', 'polite');
  document.body.appendChild(_container);
  return _container;
}

// ── Focus trap ────────────────────────────────────────────── //

const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

function _trapFocus(el) {
  const handler = (e) => {
    if (e.key !== 'Tab') return;
    const focusable = [...el.querySelectorAll(FOCUSABLE)].filter(f => !f.closest('[hidden]'));
    if (focusable.length === 0) { e.preventDefault(); return; }
    const first = focusable[0];
    const last  = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  el.addEventListener('keydown', handler);
  // Focus first focusable element
  const first = el.querySelector(FOCUSABLE);
  if (first) setTimeout(() => first.focus(), 50);
  return handler; // return for cleanup
}

// ── Core: add dialog ──────────────────────────────────────── //

/**
 * Mount a dialog created by componentFn.
 * @param {(props: object, close: () => void) => HTMLElement} componentFn
 * @param {object} [props]
 * @param {boolean} [props.persistent] — backdrop click won't close
 * @returns {() => void} close function
 */
function add(componentFn, props = {}) {
  const container = _ensureContainer();

  // Backdrop
  const backdrop = document.createElement('div');
  backdrop.className = 'dialog-backdrop';
  backdrop.setAttribute('aria-hidden', 'true');

  // Close function
  const close = () => _closeEntry(entry); // eslint-disable-line no-use-before-define

  // Dialog wrapper
  const wrapper = document.createElement('div');
  wrapper.className = 'dialog-wrapper';
  wrapper.setAttribute('role', 'dialog');
  wrapper.setAttribute('aria-modal', 'true');

  // Build content from componentFn
  let content;
  try {
    content = componentFn(props, close);
  } catch (err) {
    console.error('[dialog] componentFn threw:', err);
    content = document.createElement('div');
    content.textContent = 'Dialog error';
  }
  wrapper.appendChild(content);

  // Backdrop click
  backdrop.addEventListener('click', () => {
    if (!props.persistent) close();
  });
  // Prevent wrapper click from bubbling to backdrop
  wrapper.addEventListener('click', (e) => e.stopPropagation());

  // Animate in
  requestAnimationFrame(() => {
    backdrop.classList.add('dialog-backdrop-visible');
    wrapper.classList.add('dialog-wrapper-visible');
  });

  container.appendChild(backdrop);
  container.appendChild(wrapper);

  const trapHandler = _trapFocus(wrapper);
  const entry = { backdrop, wrapper, trapHandler, persistent: !!props.persistent };
  _stack.push(entry);

  return close;
}

function _closeEntry(entry) {
  const idx = _stack.indexOf(entry);
  if (idx === -1) return;
  _stack.splice(idx, 1);

  entry.wrapper.removeEventListener('keydown', entry.trapHandler);
  entry.backdrop.classList.remove('dialog-backdrop-visible');
  entry.wrapper.classList.remove('dialog-wrapper-visible');

  setTimeout(() => {
    entry.backdrop.remove();
    entry.wrapper.remove();
  }, 250);

  // Re-focus previous dialog or body
  if (_stack.length > 0) {
    const prev = _stack[_stack.length - 1].wrapper;
    prev?.querySelector(FOCUSABLE)?.focus();
  }
}

function closeTop() {
  if (_stack.length === 0) return;
  _closeEntry(_stack[_stack.length - 1]);
}

function closeAll() {
  [..._stack].reverse().forEach(e => _closeEntry(e));
}

// ── Built-in confirm dialog ───────────────────────────────── //

/**
 * Show a confirmation dialog. Returns a Promise<boolean>.
 * @param {string} message
 * @param {object} [options]
 * @param {string} [options.title]
 * @param {string} [options.confirmLabel='Confirm']
 * @param {string} [options.cancelLabel='Cancel']
 * @param {boolean} [options.persistent=true] — default true for confirm
 * @param {boolean} [options.danger=false] — styles confirm button as destructive
 * @returns {Promise<boolean>}
 */
function confirm(message, options = {}) {
  return new Promise((resolve) => {
    const {
      title        = 'Confirm',
      confirmLabel = 'Confirm',
      cancelLabel  = 'Cancel',
      persistent   = true,
      danger       = false,
    } = options;

    const close = add((props, closeFn) => {
      const el = document.createElement('div');
      el.className = 'dialog-card';
      el.innerHTML = `
        <div class="dialog-header">
          <h2 class="dialog-title">${_esc(title)}</h2>
        </div>
        <div class="dialog-body">
          <p class="dialog-message">${_esc(message)}</p>
        </div>
        <div class="dialog-footer">
          <button class="btn btn-ghost dialog-cancel">${_esc(cancelLabel)}</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'} dialog-confirm">${_esc(confirmLabel)}</button>
        </div>
      `;
      el.querySelector('.dialog-cancel').addEventListener('click', () => { closeFn(); resolve(false); });
      el.querySelector('.dialog-confirm').addEventListener('click', () => { closeFn(); resolve(true); });
      return el;
    }, { persistent });
  });
}

function _esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Service factory ───────────────────────────────────────── //

export function createDialogService() {
  // Escape key: close topmost non-persistent dialog
  if (typeof document !== 'undefined') {
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || _stack.length === 0) return;
      const top = _stack[_stack.length - 1];
      if (!top.persistent) closeTop();
    });
  }
  return { add, confirm, closeTop, closeAll };
}

export const dialogServiceDescriptor = {
  dependencies: ['notification'],
  start(env) {
    return createDialogService();
  },
};
