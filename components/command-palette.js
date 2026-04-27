/**
 * FamilyHub v3.0 — components/command-palette.js
 * Command Palette UI — floating overlay, ⌘K trigger, fuzzy search, category groups.
 * Implements Prompt 06 spec exactly.
 *
 * Features:
 *   - Floating overlay activated by Ctrl+K / Cmd+K
 *   - Shows all commands from commandService where when() is truthy
 *   - Input filters by fuzzy match on command name (uses commandService.search())
 *   - Arrow keys navigate, Enter executes, Escape closes
 *   - Groups commands by category with labeled separators
 *   - Keyboard shortcut hints shown on right side
 *
 * Usage:
 *   import { initCommandPalette } from './components/command-palette.js';
 *   initCommandPalette(); // called after DOM ready
 */

import { on, emit, EVENTS } from '../core/events.js';

let _overlay = null;
let _input   = null;
let _list    = null;
let _items   = [];
let _selIdx  = -1;
let _env     = null;

// ── Public API ────────────────────────────────────────────── //

export function openPalette() {
  if (!_overlay) _build();
  _overlay.classList.add('cp-open');
  _overlay.setAttribute('aria-hidden', 'false');
  _overlay.removeAttribute('inert');
  _input.value = '';
  _render('');
  setTimeout(() => _input?.focus(), 30);
}

export function closePalette() {
  if (!_overlay) return;
  _overlay.classList.remove('cp-open');
  _overlay.setAttribute('aria-hidden', 'true');
  _overlay.setAttribute('inert', '');
}

/**
 * Initialize the command palette.
 * @param {object} [env] — env object (optional, falls back to window._fhEnv)
 */
export function initCommandPalette(env) {
  _env = env || null;
  _build();

  // BUG-B fix: close command palette on any view navigation
  import('../core/events.js').then(({ on, EVENTS }) => {
    on(EVENTS.VIEW_CHANGED, () => {
      if (_overlay?.classList.contains('cp-open')) closePalette();
    });
  }).catch(() => {});

  // Cmd+K is handled by hotkeyService (P-09) which calls openPalette()/closePalette().
  // No duplicate listener here — avoids double-fire.
}

// ── Build DOM ─────────────────────────────────────────────── //

function _build() {
  if (_overlay) return;

  _overlay = document.createElement('div');
  _overlay.id = 'command-palette';
  _overlay.className = 'cp-overlay';
  _overlay.setAttribute('role', 'dialog');
  _overlay.setAttribute('aria-label', 'Command palette');
  _overlay.setAttribute('aria-modal', 'true');
  _overlay.setAttribute('aria-hidden', 'true');
  _overlay.setAttribute('inert', '');

  _overlay.innerHTML = `
    <div class="cp-backdrop"></div>
    <div class="cp-panel" role="combobox" aria-haspopup="listbox" aria-expanded="true">
      <div class="cp-input-wrap">
        <span class="cp-search-icon" aria-hidden="true">⌘</span>
        <input class="cp-input" type="text" placeholder="Type a command or search…"
               autocomplete="off" spellcheck="false" aria-label="Command search"
               aria-autocomplete="list" aria-controls="cp-list">
        <kbd class="cp-esc-hint">ESC</kbd>
      </div>
      <ul class="cp-list" id="cp-list" role="listbox" aria-label="Commands"></ul>
      <div class="cp-footer">
        <span><kbd>↑↓</kbd> navigate</span>
        <span><kbd>↵</kbd> execute</span>
        <span><kbd>ESC</kbd> close</span>
      </div>
    </div>
  `;

  document.body.appendChild(_overlay);

  _input = _overlay.querySelector('.cp-input');
  _list  = _overlay.querySelector('.cp-list');

  // Backdrop click closes
  _overlay.querySelector('.cp-backdrop').addEventListener('click', closePalette);

  // Input events
  _input.addEventListener('input', () => _render(_input.value));

  _input.addEventListener('keydown', (e) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        _move(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        _move(-1);
        break;
      case 'Enter':
        e.preventDefault();
        _execute();
        break;
      case 'Escape':
        e.preventDefault();
        closePalette();
        break;
    }
  });
}

// ── Render ────────────────────────────────────────────────── //

function _render(query) {
  if (!_list) return;

  const env = _env || window._fhEnv;
  const cmdService = env?.services?.command;

  // Get commands — scored + sorted if commandService available
  let groups = new Map(); // category → [{cmd, score}]

  if (cmdService) {
    const results = cmdService.search(query.trim());
    for (const { cmd, score } of results) {
      const cat = cmd.category || 'General';
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push({ cmd, score });
    }
  }

  _items = [];
  _selIdx = -1;
  _list.innerHTML = '';

  if (groups.size === 0) {
    _list.innerHTML = `
      <li class="cp-empty" role="presentation">
        ${query ? `No commands match "<strong>${_esc(query)}</strong>"` : 'No commands available'}
      </li>`;
    return;
  }

  for (const [category, cmds] of groups) {
    // Category separator
    const sep = document.createElement('li');
    sep.className = 'cp-group-label';
    sep.setAttribute('role', 'presentation');
    sep.textContent = category;
    _list.appendChild(sep);

    for (const { cmd } of cmds) {
      const li = document.createElement('li');
      li.className = 'cp-item';
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.dataset.id = cmd.id;

      const shortcut = cmd.shortcut
        ? `<kbd class="cp-shortcut">${_esc(cmd.shortcut)}</kbd>`
        : '';

      li.innerHTML = `
        <span class="cp-item-icon" aria-hidden="true">${cmd.icon || '◈'}</span>
        <span class="cp-item-text">
          <span class="cp-item-label">${_esc(cmd.label)}</span>
          ${cmd.description ? `<span class="cp-item-desc">${_esc(cmd.description)}</span>` : ''}
        </span>
        ${shortcut}
      `;

      li.addEventListener('mouseenter', () => {
        _setSelected(_items.indexOf(li));
      });
      li.addEventListener('click', () => {
        _setSelected(_items.indexOf(li));
        _execute();
      });

      _list.appendChild(li);
      _items.push(li);
    }
  }

  // Auto-select first item
  if (_items.length > 0) _setSelected(0);
}

// ── Selection ─────────────────────────────────────────────── //

function _setSelected(idx) {
  if (_selIdx >= 0 && _items[_selIdx]) {
    _items[_selIdx].classList.remove('cp-selected');
    _items[_selIdx].setAttribute('aria-selected', 'false');
  }
  _selIdx = Math.max(0, Math.min(idx, _items.length - 1));
  if (_items[_selIdx]) {
    _items[_selIdx].classList.add('cp-selected');
    _items[_selIdx].setAttribute('aria-selected', 'true');
    _items[_selIdx].scrollIntoView({ block: 'nearest' });
  }
}

function _move(dir) {
  _setSelected(_selIdx + dir);
}

function _execute() {
  const item = _items[_selIdx];
  if (!item) return;
  const id = item.dataset.id;
  const env = _env || window._fhEnv;
  const cmdService = env?.services?.command;
  closePalette();
  if (cmdService) {
    cmdService.execute(id, env);
  }
}

function _esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
