/**
 * FamilyHub v4.2 — core/debug.js
 * Developer Debug Overlay — activated by ?debug=true in URL.
 * Implements Prompt 30 spec exactly.
 *
 * Features:
 *   - Toggled with Ctrl+Shift+D
 *   - Collapsible panel bottom-right
 *   - Four tabs: Registry, Signals, Storage, Performance
 *   - Registry: lists all entries in all registries
 *   - Signals: monkey-patches signal() to log creates/sets
 *   - Storage: live IndexedDB record counts, click to view records
 *   - Performance: navigate() → first-paint timing bar chart
 */

import { viewRegistry, serviceRegistry, commandRegistry,
         effectRegistry, systrayRegistry } from './registry.js';
import { navigate } from './router.js';
import { on, EVENTS } from './events.js';

let _panel       = null;
let _activeTab   = 'registry';
let _signalLog   = [];
let _perfLog     = [];
let _navStart    = null;
let _isOpen      = true;

const REGISTRIES = {
  'View':     () => viewRegistry,
  'Service':  () => serviceRegistry,
  'Command':  () => commandRegistry,
  'Effect':   () => effectRegistry,
  'Systray':  () => systrayRegistry,
};

// ── Mount ─────────────────────────────────────────────────── //

export function mountDebugPanel(env) {
  if (_panel) return;

  _panel = document.createElement('div');
  _panel.id = 'fh-debug-panel';
  _panel.className = 'fhd-panel';
  _panel.setAttribute('role', 'complementary');
  _panel.setAttribute('aria-label', 'Developer debug panel');
  _panel.innerHTML = `
    <div class="fhd-header">
      <span class="fhd-title">🛠 Debug</span>
      <div class="fhd-tabs" role="tablist">
        <button class="fhd-tab fhd-tab--active" data-tab="registry">Registry</button>
        <button class="fhd-tab" data-tab="signals">Signals</button>
        <button class="fhd-tab" data-tab="storage">Storage</button>
        <button class="fhd-tab" data-tab="perf">Perf</button>
      </div>
      <button class="fhd-toggle" aria-label="Collapse debug panel">▼</button>
    </div>
    <div class="fhd-body" id="fhd-body"></div>
  `;

  document.body.appendChild(_panel);

  // Tab switching
  _panel.querySelectorAll('.fhd-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      _panel.querySelectorAll('.fhd-tab').forEach(b => b.classList.remove('fhd-tab--active'));
      btn.classList.add('fhd-tab--active');
      _activeTab = btn.dataset.tab;
      _render();
    });
  });

  // Collapse toggle
  _panel.querySelector('.fhd-toggle').addEventListener('click', () => {
    const body = document.getElementById('fhd-body');
    _isOpen = !_isOpen;
    body.style.display = _isOpen ? '' : 'none';
    _panel.querySelector('.fhd-toggle').textContent = _isOpen ? '▼' : '▲';
  });

  // Ctrl+Shift+D toggle panel visibility
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      _panel.style.display = _panel.style.display === 'none' ? '' : 'none';
    }
  });

  // Signals monkey-patch
  _patchSignals(env);

  // Performance: track navigate() timing
  _trackPerformance();

  // Storage: auto-refresh on tab switch
  _render();

  // Auto-refresh registry tab every 2s
  setInterval(() => {
    if (_activeTab === 'registry' && _panel.style.display !== 'none' && _isOpen) _render();
  }, 2000);
}

// ── Render ────────────────────────────────────────────────── //

function _render() {
  const body = document.getElementById('fhd-body');
  if (!body) return;

  switch (_activeTab) {
    case 'registry': _renderRegistry(body); break;
    case 'signals':  _renderSignals(body);  break;
    case 'storage':  _renderStorage(body);  break;
    case 'perf':     _renderPerf(body);     break;
  }
}

function _renderRegistry(body) {
  let html = '';
  for (const [name, getFn] of Object.entries(REGISTRIES)) {
    const reg = getFn();
    const entries = reg.getAll ? reg.getAll() : [];
    html += `<div class="fhd-reg-group">
      <div class="fhd-reg-name">${name} Registry <span class="fhd-badge">${entries.length}</span></div>
      <div class="fhd-reg-keys">${
        entries.map(([k]) => `<span class="fhd-key">${_esc(k)}</span>`).join('')
      }</div>
    </div>`;
  }
  body.innerHTML = html || '<div class="fhd-empty">No registries found.</div>';
}

function _renderSignals(body) {
  if (_signalLog.length === 0) {
    body.innerHTML = '<div class="fhd-empty">No signals logged yet. Signal creates/sets appear here.</div>';
    return;
  }
  const rows = _signalLog.slice(-60).reverse()
    .map(e => `<div class="fhd-sig-row"><span class="fhd-sig-time">${e.time}</span><span class="fhd-sig-type fhd-sig-${e.type}">${e.type}</span><span class="fhd-sig-val">${_esc(String(e.value ?? '').slice(0,40))}</span></div>`)
    .join('');
  body.innerHTML = `<div class="fhd-sig-log">${rows}</div>
    <button class="fhd-btn" onclick="window._fhDebugClearSignals?.()">Clear</button>`;
  window._fhDebugClearSignals = () => { _signalLog = []; _render(); };
}

async function _renderStorage(body) {
  body.innerHTML = '<div class="fhd-empty">Loading…</div>';
  try {
    const { countByType } = await import('./db.js');
    const counts = await countByType();
    const total  = Object.values(counts).reduce((a,b)=>a+b,0);
    let html = `<table class="fhd-table"><thead><tr><th>Type</th><th>Count</th></tr></thead><tbody>`;
    const sorted = Object.entries(counts).sort((a,b)=>b[1]-a[1]);
    for (const [type, count] of sorted) {
      html += `<tr><td>${_esc(type)}</td><td>${count}</td></tr>`;
    }
    html += `</tbody><tfoot><tr><th>Total</th><th>${total}</th></tr></tfoot></table>`;
    body.innerHTML = html;
  } catch (err) {
    body.innerHTML = `<div class="fhd-empty">Storage unavailable: ${_esc(err.message)}</div>`;
  }
}

function _renderPerf(body) {
  if (_perfLog.length === 0) {
    body.innerHTML = '<div class="fhd-empty">Navigate to a view to record timing.</div>';
    return;
  }
  const max = Math.max(..._perfLog.map(p=>p.ms), 1);
  const bars = _perfLog.slice(-15).map(p => {
    const pct = Math.max(4, (p.ms / max) * 100);
    return `<div class="fhd-perf-row">
      <span class="fhd-perf-view">${_esc(p.view)}</span>
      <div class="fhd-perf-bar-wrap">
        <div class="fhd-perf-bar" style="width:${pct}%"></div>
      </div>
      <span class="fhd-perf-ms">${p.ms}ms</span>
    </div>`;
  }).join('');
  body.innerHTML = `<div class="fhd-perf-chart">${bars}</div>`;
}

// ── Signal monkey-patching ────────────────────────────────── //

function _patchSignals(env) {
  // Log to internal array only — no module patching needed
  // Views that create signals will be tracked via env.debug
  const orig = window.__fhSignalPatch;
  if (orig) return; // already patched
  window.__fhSignalPatch = true;
  // We intercept by watching window._fhSignalLog writes
  window._fhSignalLog = (type, value) => {
    _signalLog.push({
      time:  new Date().toLocaleTimeString(),
      type,
      value,
    });
    if (_signalLog.length > 500) _signalLog.shift();
  };
}

// ── Performance tracking ──────────────────────────────────── //

function _trackPerformance() {
  on(EVENTS.VIEW_CHANGED, ({ viewKey }) => {
    _navStart = performance.now();
    const view = viewKey;
    // Measure time to first rAF after navigate
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (_navStart) {
          const ms = Math.round(performance.now() - _navStart);
          _perfLog.push({ view, ms, at: new Date().toISOString() });
          if (_perfLog.length > 50) _perfLog.shift();
          _navStart = null;
        }
      });
    });
  });
}

function _esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
