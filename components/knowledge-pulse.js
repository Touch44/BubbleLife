/**
 * components/knowledge-pulse.js
 * KLRE — Knowledge Pulse widget for the dashboard.
 * Shows proactively surfaced items the user should revisit.
 * [v6.6.0]
 */

import { getPulseItems } from '../services/klre-resurfacing.js';
import { openPanel }     from '../components/entity-panel.js';
import { getEntityTypeConfig } from '../core/graph-engine.js';
import { getSetting }    from '../core/db.js';

// ── Local _esc (never import) ─────────────────────────────── //
function _esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Style injection ───────────────────────────────────────── //
function _injectStyles() {
  if (document.getElementById('klre-pulse-styles')) return;
  const style = document.createElement('style');
  style.id = 'klre-pulse-styles';
  style.textContent = `
    .klre-pulse-item{display:flex;align-items:flex-start;gap:10px;padding:10px 0;
      border-bottom:1px solid var(--color-border);cursor:pointer;transition:background .12s}
    .klre-pulse-item:last-child{border-bottom:none}
    .klre-pulse-item:hover .klre-pulse-title{color:var(--color-accent)}
    .klre-pulse-icon{font-size:20px;width:28px;flex-shrink:0;padding-top:2px}
    .klre-pulse-body{flex:1;min-width:0}
    .klre-pulse-title{font-size:13px;font-weight:500;color:var(--color-text);
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .klre-pulse-reason{font-size:11px;color:var(--color-text-muted);margin-top:2px}
    .klre-pulse-badge{font-size:10px;padding:2px 7px;border-radius:100px;
      font-weight:700;flex-shrink:0;margin-top:3px;display:inline-block}
    .klre-pulse-badge-forgotten{background:rgba(240,180,41,.12);
      border:1px solid rgba(240,180,41,.25);color:#ffd26b}
    .klre-pulse-badge-date{background:rgba(124,110,247,.12);
      border:1px solid rgba(124,110,247,.25);color:var(--color-accent)}
    .klre-pulse-badge-tag{background:rgba(62,207,176,.1);
      border:1px solid rgba(62,207,176,.2);color:#3ecfb0}
    .klre-pulse-badge-stale{background:rgba(240,106,90,.1);
      border:1px solid rgba(240,106,90,.2);color:#f09488}
    .klre-pulse-empty{font-size:13px;color:var(--color-text-muted);
      text-align:center;padding:20px 0;line-height:1.5}
    .klre-pulse-skeleton{height:40px;border-radius:6px;background:var(--color-bg-3);
      margin-bottom:8px;animation:klre-pulse-shimmer 1.2s ease infinite}
    @keyframes klre-pulse-shimmer{0%{opacity:.4}50%{opacity:.8}100%{opacity:.4}}
  `;
  document.head.appendChild(style);
}

// Badge config
const BADGE_CLASS = {
  FORGOTTEN_RELEVANT: 'klre-pulse-badge-forgotten',
  DATE_ADJACENT:      'klre-pulse-badge-date',
  TAG_ACTIVATED:      'klre-pulse-badge-tag',
  STALE_TASK:         'klre-pulse-badge-stale',
};
const BADGE_LABEL = {
  FORGOTTEN_RELEVANT: 'resurface',
  DATE_ADJACENT:      'event link',
  TAG_ACTIVATED:      'tag match',
  STALE_TASK:         'stale',
};

// ── Public: render ────────────────────────────────────────── //

/**
 * Render the Knowledge Pulse widget into containerEl.
 * Checks klre_pulse_enabled setting before rendering.
 * @param {HTMLElement} containerEl
 */
export async function renderKnowledgePulse(containerEl) {
  if (!containerEl) return;

  // Check if pulse widget is enabled (default: true)
  const enabled = await getSetting('klre_pulse_enabled');
  if (enabled === false) {
    containerEl.innerHTML = '';
    return;
  }

  _injectStyles();

  // Show skeleton immediately
  containerEl.innerHTML = `
    <div class="klre-pulse-skeleton"></div>
    <div class="klre-pulse-skeleton" style="width:80%"></div>
    <div class="klre-pulse-skeleton" style="width:70%"></div>
  `;

  let items;
  try {
    items = await getPulseItems();
  } catch (e) {
    console.warn('[KLRE] Knowledge Pulse failed:', e);
    if (containerEl.isConnected) {
      containerEl.innerHTML = '<div class="klre-pulse-empty">Could not load pulse items.</div>';
    }
    return;
  }

  // B30: User may have navigated away while getPulseItems was computing
  if (!containerEl.isConnected) return;

  containerEl.innerHTML = '';

  if (!items || !items.length) {
    containerEl.innerHTML = `
      <div class="klre-pulse-empty">
        Knowledge Pulse will populate as you add more content.
      </div>
    `;
    return;
  }

  for (const item of items) {
    const cfg  = getEntityTypeConfig(item.entityType);
    const icon = cfg?.icon || '📄';
    const rawTitle = (item.title || '');
    const titleText = rawTitle.length > 55 ? rawTitle.slice(0, 55) + '…' : rawTitle;

    const row = document.createElement('div');
    row.className = 'klre-pulse-item';

    const iconEl = document.createElement('div');
    iconEl.className = 'klre-pulse-icon';
    iconEl.textContent = icon;

    const bodyEl = document.createElement('div');
    bodyEl.className = 'klre-pulse-body';

    const titleEl = document.createElement('div');
    titleEl.className = 'klre-pulse-title';
    titleEl.textContent = titleText;

    const reasonEl = document.createElement('div');
    reasonEl.className = 'klre-pulse-reason';
    reasonEl.textContent = item.reason || '';

    const badgeEl = document.createElement('span');
    badgeEl.className = ('klre-pulse-badge ' + (BADGE_CLASS[item.pulseType] || '')).trim();
    badgeEl.textContent = BADGE_LABEL[item.pulseType] || '';

    bodyEl.appendChild(titleEl);
    bodyEl.appendChild(reasonEl);
    bodyEl.appendChild(badgeEl);

    row.appendChild(iconEl);
    row.appendChild(bodyEl);
    row.addEventListener('click', () => openPanel(item.entityId));

    containerEl.appendChild(row);
  }
}
