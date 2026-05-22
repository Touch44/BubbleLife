/**
 * FamilyHub v6.0.2 — core/banner.js
 * Global Context & Focus Mode Banner System
 *
 * Renders a slim banner at the top of the app (above the topbar) to indicate:
 *   1. FOCUS MODE: when a project is focused via projects.js setFocusProject()
 *   2. CONTEXT MODE: when active context is not 'all' (family/personal/business)
 *
 * Focus banner takes priority over context banner (they don't stack).
 *
 * Called from:
 *   - index.html boot (after auth)
 *   - projects.js setFocusProject() / clearFocusProject()
 *   - context:changed event listener (wired in initBanner)
 *   - view:changed event (persists banner across all navigations)
 *
 * Public API:
 *   initBanner()        — wire event listeners (call once at boot)
 *   renderBanner()      — re-evaluate and show/hide banner (safe to call any time)
 */

import { on, EVENTS } from './events.js';

const BANNER_ID     = 'fh-global-banner';
const OFFSET_CSS    = '--banner-offset';
const BANNER_H      = 36; // px
const FOCUS_KEY     = 'fh_focusProjectId';

// ── Context colours + labels ──────────────────────────────────────
const CTX_CONFIG = {
  family:   { label: 'Family',   icon: '🏠', bg: '#0891b2', text: '#fff' },
  personal: { label: 'Personal', icon: '👤', bg: '#7c3aed', text: '#fff' },
  business: { label: 'Business', icon: '💼', bg: '#b45309', text: '#fff' },
};

// ── Module state ──────────────────────────────────────────────────
let _listening = false;
let _projectsCache = null; // shallow cache for project name lookup

// ── Public: init (call once) ──────────────────────────────────────
export function initBanner() {
  if (_listening) return;
  _listening = true;

  // Re-render on context change
  on('context:changed', () => renderBanner());

  // Re-render on focus change (from projects.js)
  on('projects:focusChanged', () => renderBanner());

  // Re-render on every navigation — keeps banner visible across all views
  on(EVENTS.VIEW_CHANGED, () => renderBanner());

  // Re-render when entities saved (project name might have changed)
  on(EVENTS.ENTITY_SAVED, ({ entity } = {}) => {
    if (entity?.type === 'project') {
      _projectsCache = null; // bust cache
      renderBanner();
    }
  });

  // Initial render
  renderBanner();
}

// ── Public: render ────────────────────────────────────────────────
export async function renderBanner() {
  const focusId = _getFocusId();
  const ctx     = _getActiveContext();

  if (focusId) {
    await _showFocusBanner(focusId);
  } else if (ctx && ctx !== 'all') {
    _showContextBanner(ctx);
  } else {
    _hideBanner();
  }
}

// ── Focus banner ──────────────────────────────────────────────────
async function _showFocusBanner(focusId) {
  let name = 'Project';
  try {
    const projects = await _getProjects();
    const proj = projects.find(p => p.id === focusId);
    name = proj ? (proj.name || proj.title || 'Project') : 'Project';
  } catch { /* non-fatal */ }

  const el = _ensureBanner();
  el.style.background = 'var(--color-accent)';
  el.innerHTML = `
    <span style="font-size:1rem;line-height:1;">🎯</span>
    <span style="font-weight:600;">Focus Mode:</span>
    <span id="banner-proj-name">${_esc(name)}</span>
    <span style="flex:1;"></span>
    <span style="opacity:0.85;font-size:var(--text-xs);">All views filtered to this project</span>
    <button id="banner-exit-btn" style="
      background:rgba(255,255,255,0.22);border:none;color:inherit;cursor:pointer;
      padding:3px 12px;border-radius:var(--radius-full);
      font-size:var(--text-xs);font-weight:700;white-space:nowrap;
      transition:background 0.12s;
    " onmouseenter="this.style.background='rgba(255,255,255,0.35)'"
       onmouseleave="this.style.background='rgba(255,255,255,0.22)'">
      ✕ Exit Focus
    </button>
  `;
  el.querySelector('#banner-exit-btn').addEventListener('click', _exitFocus);
  _applyOffset(true);
}

// ── Context banner ────────────────────────────────────────────────
function _showContextBanner(ctx) {
  const cfg = CTX_CONFIG[ctx];
  if (!cfg) { _hideBanner(); return; }

  const el = _ensureBanner();
  el.style.background = cfg.bg;
  el.innerHTML = `
    <span style="font-size:1rem;line-height:1;">${cfg.icon}</span>
    <span style="font-weight:600;">${cfg.label} Context</span>
    <span style="opacity:0.8;font-size:var(--text-xs);">Views filtered to ${cfg.label.toLowerCase()} items</span>
    <span style="flex:1;"></span>
    <button id="banner-ctx-all" style="
      background:rgba(255,255,255,0.22);border:none;color:inherit;cursor:pointer;
      padding:3px 12px;border-radius:var(--radius-full);
      font-size:var(--text-xs);font-weight:700;white-space:nowrap;
      transition:background 0.12s;
    " onmouseenter="this.style.background='rgba(255,255,255,0.35)'"
       onmouseleave="this.style.background='rgba(255,255,255,0.22)'">
      ✕ Clear
    </button>
  `;
  el.querySelector('#banner-ctx-all').addEventListener('click', _clearContext);
  _applyOffset(true);
}

// ── Hide ──────────────────────────────────────────────────────────
function _hideBanner() {
  const el = document.getElementById(BANNER_ID);
  if (el) el.remove();
  _applyOffset(false);
}

// ── DOM helpers ───────────────────────────────────────────────────
function _ensureBanner() {
  let el = document.getElementById(BANNER_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = BANNER_ID;
    el.style.cssText = `
      position:fixed;top:0;left:0;right:0;
      height:${BANNER_H}px;z-index:calc(var(--z-topbar) + 10);
      display:flex;align-items:center;gap:10px;
      padding:0 16px;
      color:#fff;
      font-size:var(--text-sm);
      font-family:var(--font-body);
      box-shadow:0 2px 8px rgba(0,0,0,0.18);
      transition:background 0.2s;
    `;
    document.body.appendChild(el);
  }
  return el;
}

function _applyOffset(show) {
  const topbar = document.getElementById('topbar');
  const appEl  = document.getElementById('app');
  const sidebar = document.getElementById('sidebar');
  const px = show ? `${BANNER_H}px` : '';
  if (topbar)  topbar.style.marginTop  = px;
  if (appEl)   appEl.style.marginTop   = px;
  if (sidebar) sidebar.style.paddingTop = px;
  // On mobile, sidebar doesn't exist in grid — also offset the body for the app grid
  document.documentElement.style.setProperty('--banner-offset', show ? `${BANNER_H}px` : '0px');
}

// ── Actions ───────────────────────────────────────────────────────
function _exitFocus() {
  try {
    sessionStorage.removeItem('fh_focusProjectId');
  } catch {}
  // Also call projects.js clearFocusProject if loaded
  try {
    const projMod = window._fhModules?.projects;
    if (projMod?.clearFocusProject) projMod.clearFocusProject();
  } catch {}
  // Emit event so projects view refreshes
  import('./events.js').then(({ emit }) => {
    emit('projects:focusChanged', { id: null });
  }).catch(() => {});
  renderBanner();
}

function _clearContext() {
  import('./context.js').then(({ setActiveContext }) => {
    setActiveContext('all');
  }).catch(() => {});
}

// ── Data helpers ──────────────────────────────────────────────────
function _getFocusId() {
  try { return sessionStorage.getItem('fh_focusProjectId') || null; } catch { return null; }
}

function _getActiveContext() {
  try {
    return localStorage.getItem('fh_active_context') || 'all';
  } catch { return 'all'; }
}

async function _getProjects() {
  if (_projectsCache) return _projectsCache;
  const { getEntitiesByType } = await import('./db.js');
  _projectsCache = (await getEntitiesByType('project')).filter(p => !p.deleted);
  return _projectsCache;
}

function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
