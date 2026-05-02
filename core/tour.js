/**
 * FamilyHub v3.0 — core/tour.js
 * Guided onboarding tour engine.
 * Implements Prompt 32 spec exactly.
 *
 * Features:
 *   - tourRegistry (Registry) — tours registered as step arrays
 *   - startTour(name, env) — spotlight + tooltip flow
 *   - Dark backdrop with clip-path cutout over target
 *   - Tooltip: title, content, step counter, Next/Skip buttons
 *   - Confetti on completion
 *   - Completion stored under 'tours:{name}:completed'
 *   - Built-in 'onboarding' tour (6 steps)
 */

import { Registry } from './registry.js';
import { getSetting, setSetting } from './db.js';

/** Registry of tour definitions. Each value is a step array. */
export const tourRegistry = new Registry('tour');

// ── Step type ─────────────────────────────────────────────── //
/**
 * @typedef {{ target: string, title: string, content: string,
 *             position?: 'top'|'bottom'|'left'|'right',
 *             action?: 'click'|'type'|null }} TourStep
 */

// ── State ─────────────────────────────────────────────────── //
let _backdrop  = null;
let _tooltip   = null;
let _stepIndex = 0;
let _steps      = [];
let _keyHandler = null;  // P-32: escape handler
let _name      = '';
let _env       = null;

// ── Public API ────────────────────────────────────────────── //

/**
 * Start a named tour.
 * If already completed, does nothing (unless force=true).
 * @param {string} name
 * @param {object} env
 * @param {boolean} [force=false]
 */
export async function startTour(name, env, force = false) {
  if (!tourRegistry.has(name)) {
    console.warn(`[tour] Tour "${name}" not found`);
    return;
  }

  if (!force) {
    const done = await getSetting(`tours:${name}:completed`);
    if (done) return;
  }

  _name      = name;
  _env       = env;
  _steps     = tourRegistry.get(name) || [];
  _stepIndex = 0;

  if (_steps.length === 0) return;

  _mountBackdrop();
  _showStep(_stepIndex);
}

/**
 * Check if a tour has been completed.
 * @param {string} name
 * @returns {Promise<boolean>}
 */
export async function isTourComplete(name) {
  return (await getSetting(`tours:${name}:completed`)) === true;
}

/**
 * Reset tour completion for development / restart.
 * @param {string} name
 */
export async function resetTour(name) {
  await setSetting(`tours:${name}:completed`, false);
}

// ── Internal ──────────────────────────────────────────────── //

function _mountBackdrop() {
  _teardown();

  _backdrop = document.createElement('div');
  _backdrop.id = 'fh-tour-backdrop';
  _backdrop.style.cssText = `
    position: fixed; inset: 0; z-index: 89999;
    background: rgba(0,0,0,0.55);
    transition: clip-path 0.3s ease;
    pointer-events: auto;
  `;
  // Clicking OUTSIDE the spotlight skips the tour (BUG-2 fix: check rect)
  _backdrop.addEventListener('click', (e) => {
    const step   = _steps[_stepIndex];
    const target = step?.target ? document.querySelector(step.target) : null;
    if (target) {
      const pad = 8;
      const r   = target.getBoundingClientRect();
      const inX = e.clientX >= r.left - pad && e.clientX <= r.right  + pad;
      const inY = e.clientY >= r.top  - pad && e.clientY <= r.bottom + pad;
      if (inX && inY) return; // click inside spotlight — let event reach target
    }
    _skip();
  });
  document.body.appendChild(_backdrop);

  // Escape key ends tour (P-32)
  _keyHandler = (e) => { if (e.key === 'Escape') _skip(); };
  document.addEventListener('keydown', _keyHandler);

  _tooltip = document.createElement('div');
  _tooltip.id = 'fh-tour-tooltip';
  _tooltip.style.cssText = `
    position: fixed; z-index: 90000;
    background: var(--color-bg,#fff);
    border: 1px solid var(--color-border,#e2e8f0);
    border-radius: 12px;
    box-shadow: 0 25px 50px rgba(15,23,42,0.22);
    padding: 20px 22px;
    max-width: 320px;
    min-width: 240px;
    font-family: system-ui, sans-serif;
    pointer-events: auto;
  `;
  document.body.appendChild(_tooltip);
}

function _showStep(index) {
  if (index >= _steps.length) { _complete(); return; }

  const step = _steps[index];
  const target = document.querySelector(step.target);

  // Update spotlight
  _updateSpotlight(target);

  // Render tooltip
  const pos     = step.position || 'bottom';
  const total   = _steps.length;
  const current = index + 1;

  _tooltip.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <span style="font-size:11px;color:var(--color-text-muted,#64748b);font-weight:600;letter-spacing:.04em;">
        STEP ${current} OF ${total}
      </span>
      <button id="fh-tour-skip" style="background:none;border:none;cursor:pointer;
        color:var(--color-text-muted,#64748b);font-size:12px;padding:2px 6px;
        border-radius:4px;" aria-label="Skip tour">Skip</button>
    </div>
    <h3 style="margin:0 0 8px;font-size:16px;font-weight:700;
      font-family:var(--font-heading,Georgia,serif);
      color:var(--color-text,#0f172a);">${_esc(step.title)}</h3>
    <p style="margin:0 0 16px;font-size:13px;line-height:1.5;
      color:var(--color-text-muted,#64748b);">${_esc(step.content)}</p>
    <div style="display:flex;justify-content:flex-end;gap:8px;">
      <button id="fh-tour-next" style="
        padding:7px 18px;background:var(--color-accent,#3B82F6);
        color:#fff;border:none;border-radius:8px;cursor:pointer;
        font-size:13px;font-weight:600;" aria-label="Next step">
        ${current === total ? 'Finish 🎉' : 'Next →'}
      </button>
    </div>
  `;

  document.getElementById('fh-tour-skip')?.addEventListener('click', (e) => { e.stopPropagation(); _skip(); });
  document.getElementById('fh-tour-next')?.addEventListener('click', (e) => { e.stopPropagation(); _next(); });

  // Position tooltip relative to target
  _positionTooltip(target, pos);
}

function _updateSpotlight(target) {
  if (!_backdrop) return;
  if (!target) {
    // No target — full dark overlay
    _backdrop.style.clipPath = 'none';
    _backdrop.style.background = 'rgba(0,0,0,0.55)';
    return;
  }
  const r = target.getBoundingClientRect();
  const pad = 8;
  const x1 = r.left   - pad,  y1 = r.top    - pad;
  const x2 = r.right  + pad,  y2 = r.bottom  + pad;
  const W  = window.innerWidth, H = window.innerHeight;

  // clip-path polygon with a rectangular cutout
  _backdrop.style.clipPath = `polygon(
    0 0, ${W}px 0, ${W}px ${H}px, 0 ${H}px, 0 0,
    ${x1}px ${y1}px, ${x1}px ${y2}px,
    ${x2}px ${y2}px, ${x2}px ${y1}px, ${x1}px ${y1}px
  )`;

  // Prevent backdrop from capturing clicks over target
  _backdrop.style.pointerEvents = 'auto';
}

function _positionTooltip(target, pos) {
  if (!_tooltip) return;

  // First paint needed for tooltip size
  requestAnimationFrame(() => {
    const tRect = _tooltip.getBoundingClientRect();
    let top, left;

    if (!target) {
      top  = (window.innerHeight - tRect.height) / 2;
      left = (window.innerWidth  - tRect.width)  / 2;
    } else {
      const r   = target.getBoundingClientRect();
      const gap = 14;
      if (pos === 'bottom') {
        top  = r.bottom + gap;
        left = r.left + (r.width - tRect.width) / 2;
      } else if (pos === 'top') {
        top  = r.top - tRect.height - gap;
        left = r.left + (r.width - tRect.width) / 2;
      } else if (pos === 'right') {
        top  = r.top + (r.height - tRect.height) / 2;
        left = r.right + gap;
      } else { // left
        top  = r.top + (r.height - tRect.height) / 2;
        left = r.left - tRect.width - gap;
      }
    }

    // Clamp to viewport
    left = Math.max(12, Math.min(left, window.innerWidth  - tRect.width  - 12));
    top  = Math.max(12, Math.min(top,  window.innerHeight - tRect.height - 12));

    _tooltip.style.top  = `${top}px`;
    _tooltip.style.left = `${left}px`;
  });
}

function _next() {
  _stepIndex++;
  _showStep(_stepIndex);
}

function _skip() {
  _teardown();
}

async function _complete() {
  _teardown();

  // Confetti
  _env?.services?.effects?.play('confetti');

  // Completion card
  const card = document.createElement('div');
  card.style.cssText = `
    position: fixed; z-index: 90001;
    top: 50%; left: 50%; transform: translate(-50%,-50%);
    background: var(--color-bg,#fff);
    border-radius: 16px; box-shadow: 0 25px 50px rgba(15,23,42,0.22);
    padding: 40px 48px; text-align: center;
    font-family: system-ui, sans-serif;
    animation: tourCardIn 0.3s cubic-bezier(0.22,1,0.36,1);
  `;
  card.innerHTML = `
    <div style="font-size:48px;margin-bottom:12px;">🎉</div>
    <h2 style="font-size:22px;font-weight:700;margin:0 0 8px;
      font-family:var(--font-heading,Georgia,serif);
      color:var(--color-text,#0f172a);">You're ready!</h2>
    <p style="color:var(--color-text-muted,#64748b);margin:0 0 20px;font-size:14px;">
      You've completed the FamilyHub tour. Enjoy!
    </p>
    <button id="fh-tour-done" style="
      padding:10px 24px;background:var(--color-accent,#3B82F6);
      color:#fff;border:none;border-radius:8px;
      cursor:pointer;font-size:14px;font-weight:600;">
      Get started
    </button>
  `;

  const style = document.createElement('style');
  style.textContent = `@keyframes tourCardIn{from{opacity:0;transform:translate(-50%,-50%) scale(0.85)}to{opacity:1;transform:translate(-50%,-50%) scale(1)}}`;
  document.head.appendChild(style);

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:90000;background:rgba(0,0,0,0.4);';
  document.body.append(overlay, card);

  const closeCard = () => { overlay.remove(); card.remove(); };
  document.getElementById('fh-tour-done')?.addEventListener('click', closeCard);

  // Store completion
  try {
    await setSetting(`tours:${_name}:completed`, true);
  } catch { /* non-fatal */ }
}

function _teardown() {
  _backdrop?.remove(); _backdrop = null;
  _tooltip?.remove();  _tooltip  = null;
  // BUG-1 fix: remove Escape keydown handler
  if (_keyHandler) {
    document.removeEventListener('keydown', _keyHandler);
    _keyHandler = null;
  }
  _stepIndex = 0;
  _steps     = [];
}

function _esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Built-in 'onboarding' tour (6 steps) ─────────────────── //

tourRegistry.add('onboarding', [
  {
    target:   '#sidebar',
    title:    'Welcome to FamilyHub',
    content:  'Use the sidebar to navigate between all your family views — Daily, Tasks, Calendar, Wall, and more.',
    position: 'right',
  },
  {
    target:   '[data-view="kanban"]',
    title:    'Tasks & Kanban',
    content:  'Track tasks on a visual board. Drag cards between columns, set priorities, and mark items done.',
    position: 'right',
  },
  {
    target:   '.kanban-quick-add',
    title:    'Quick-Create Tasks',
    content:  'Click "+ Add task" at the bottom of any column to instantly add a card without opening a form.',
    position: 'top',
  },
  {
    target:   '#entity-panel',
    title:    'Entity Panel',
    content:  'Click any card or item to open its detail panel. Edit fields inline and track activity history.',
    position: 'left',
  },
  {
    target:   '[data-view="calendar"]',
    title:    'Calendar',
    content:  'Click any empty slot to create an event instantly. Drag events to reschedule them.',
    position: 'right',
  },
  {
    target:   '[data-view="settings"]',
    title:    'Settings & Customisation',
    content:  'Adjust your theme, manage family members, generate invite codes, and export your data here.',
    position: 'right',
  },
]);
