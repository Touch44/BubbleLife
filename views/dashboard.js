/**
 * FamilyHub v3.9.0 — views/dashboard.js
 * [MAJOR] Dashboard — personalized home screen with summary cards and glance widgets.
 *
 * Registers viewKey: 'dashboard'  →  renders into #view-dashboard
 *
 * Layout:
 *   1. Greeting header + context switcher
 *   2. Dismissible alert banner (highest-priority issue)
 *   3. Primary cards strip (horizontal scroll) — 6 cards
 *   4. Glance widgets grid (2-col) — 6 widgets
 *
 * Data loading pattern:
 *   - Render skeleton synchronously (shimmer placeholders)
 *   - Fetch all entity types in parallel via Promise.all
 *   - Populate each card/widget in-place (no full re-render)
 *
 * Re-renders:
 *   - ENTITY_SAVED / ENTITY_DELETED → debounced 400ms refresh (only when view active)
 *   - context:changed               → immediate full re-render
 *
 * Key constraints honoured:
 *   - No toISOString().slice(0,10) — local date arithmetic only
 *   - No backtick template literals inside onclick="" attributes
 *   - CSS injected once (idempotent id check)
 *   - navigate() used for all routing (never window.location.hash)
 *   - saveEntity() used for shopping item toggle
 */

import { registerView, navigate, VIEW_KEYS } from '../core/router.js';
import { getEntitiesByType, saveEntity,
              getEdgesFrom, getEntity }             from '../core/db.js';
import { on, emit, EVENTS }                   from '../core/events.js';
import { getActiveContext, filterByContext }  from '../core/context.js';
import { getAccount }                         from '../core/auth.js';
import { openForm }                           from '../components/entity-form.js';
// [fix] Stubs replaced at runtime by dynamic import in renderDashboard() — 
// prevents module crash if time-tracker.js not yet deployed on server.
let _tt_activeTaskIds   = { value: new Set() };
let _tt_alarmedTaskIds  = { value: new Set() };
let _tt_sessionsSignal  = { value: {} };
let _tt_getElapsed      = () => 0;
let _tt_getRemaining    = () => null;
let _tt_formatDurationCompact = (s) => { const m=Math.floor((s||0)/60),sc=Math.floor((s||0)%60); return String(m).padStart(2,'0')+':'+String(sc).padStart(2,'0'); };
let _tt_formatDuration  = (s) => { if(!s||s<0)return '0s'; const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=Math.floor(s%60); return [h&&h+'h',m&&m+'m',sec+'s'].filter(Boolean).join(' '); };
let _tt_TIMER_TICK      = 'timer:tick';
let _tt_TIMER_ALARM     = 'timer:alarm';
let _tt_loaded          = false;

// ── Constants ────────────────────────────────────────────────────────────────

const VIEW_KEY       = 'dashboard';
const STYLE_ID       = 'dashboard-styles';
const BANNER_SS_KEY  = 'fh-dashboard-banner-dismissed';
const DEBOUNCE_MS    = 400;

// Render mutex — prevents double-render race when ENTITY_SAVED fires during
// the async _resolveFirstName() gap at the start of renderDashboard().
let _rendering = false;

// Person colour map (matches graph-engine PERSON_COLORS)
const PERSON_COLOR_MAP = {
  Red:    '#ef4444', Orange: '#f97316', Yellow: '#eab308',
  Green:  '#22c55e', Teal:   '#14b8a6', Blue:   '#3b82f6',
  Purple: '#a855f7', Pink:   '#ec4899',
};
const DEFAULT_AVATAR_COLORS = ['#14b8a6','#3b82f6','#a855f7','#f97316','#22c55e','#ec4899'];

// ── CSS injection (idempotent) ────────────────────────────────────────────────

function _injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
/* ── Dashboard root ─────────────────────────────────────── */
#view-dashboard {
  padding: var(--space-5) var(--space-5) var(--space-10);
  overflow-y: auto;
  height: 100%;
  box-sizing: border-box;
}

/* ── Greeting header ────────────────────────────────────── */
.dash-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  margin-bottom: var(--space-5);
  flex-wrap: wrap;
}
.dash-greeting-name {
  font-family: var(--font-heading);
  font-size: var(--text-2xl);
  font-weight: var(--weight-bold);
  color: var(--color-accent);
  line-height: 1.2;
}
.dash-greeting-date {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  margin-top: var(--space-1);
}

/* ── Banner ─────────────────────────────────────────────── */
.dash-banner {
  background: var(--color-info-bg);
  border: 1px solid var(--color-info);
  border-radius: var(--radius-md);
  padding: var(--space-3) var(--space-4);
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  margin-bottom: var(--space-5);
}
.dash-banner-icon  { font-size: 1.1rem; flex-shrink: 0; margin-top: 1px; }
.dash-banner-body  { flex: 1; min-width: 0; }
.dash-banner-title {
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  color: var(--color-info-text);
  margin-bottom: var(--space-1);
}
.dash-banner-msg   { font-size: var(--text-sm); color: var(--color-text-muted); }
.dash-banner-cta {
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  color: var(--color-info-text);
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
  text-decoration: underline;
  margin-top: var(--space-1);
  display: inline-block;
}
.dash-banner-dismiss {
  flex-shrink: 0;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--color-text-muted);
  font-size: 1.1rem;
  line-height: 1;
  padding: 0;
  opacity: 0.6;
  transition: opacity 0.15s;
}
.dash-banner-dismiss:hover { opacity: 1; }

/* ── Section label ──────────────────────────────────────── */
.dash-section-label {
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-text-muted);
  margin-bottom: var(--space-3);
}

/* ── Primary cards strip ────────────────────────────────── */
.dash-cards-scroll {
  display: flex;
  gap: var(--space-4);
  overflow-x: auto;
  padding-bottom: var(--space-3);
  margin-bottom: var(--space-6);
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.dash-cards-scroll::-webkit-scrollbar { display: none; }

/* ── Scroll button wrapper ───────────────────────────────── */
.dash-cards-wrap {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0;
  margin-bottom: var(--space-6);
}
.dash-cards-wrap .dash-cards-scroll {
  margin-bottom: 0;
  flex: 1;
  min-width: 0;
}
.dash-scroll-btn {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  color: var(--color-text);
  font-size: 1.4rem;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background var(--transition-fast), opacity var(--transition-fast);
  z-index: 2;
  opacity: 0.7;
  padding: 0;
}
.dash-scroll-btn:hover { background: var(--color-surface-2); opacity: 1; }
.dash-scroll-btn:disabled { opacity: 0.25; cursor: default; }
.dash-scroll-btn-left  { margin-right: var(--space-2); }
.dash-scroll-btn-right { margin-left:  var(--space-2); }

.dash-card {
  flex: 0 0 230px;
  min-width: 0;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  box-shadow: var(--shadow-sm);
  transition: box-shadow 0.15s ease, transform 0.15s ease;
  min-height: 200px;
}
.dash-card:hover {
  box-shadow: var(--shadow-md);
  transform: translateY(-2px);
}
.dash-card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-2);
}
.dash-card-icon     { font-size: 1.6rem; line-height: 1; }
.dash-card-badge {
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  padding: 2px 8px;
  border-radius: var(--radius-full);
  letter-spacing: 0.03em;
}
.dash-card-badge.ok      { background: var(--color-success-bg); color: var(--color-success-text); }
.dash-card-badge.warn    { background: var(--color-warning-bg); color: var(--color-warning-text); }
.dash-card-badge.danger  { background: var(--color-danger-bg);  color: var(--color-danger-text); }
.dash-card-badge.neutral { background: var(--color-surface-2);  color: var(--color-text-muted); }

.dash-card-title {
  font-size: var(--text-base);
  font-weight: var(--weight-bold);
  color: var(--color-text);
}
.dash-card-stat {
  font-size: var(--text-xl);
  font-weight: var(--weight-bold);
  color: var(--color-accent);
  line-height: 1.25;
  word-break: break-word;
  overflow-wrap: break-word;
  max-height: 3.2em;
  overflow: hidden;
}
.dash-card-stat.text-stat {
  font-size: var(--text-md);
  font-weight: var(--weight-semibold);
}
.dash-card-stat.danger  { color: var(--color-danger); }
.dash-card-stat.success { color: var(--color-success); }
.dash-card-sub {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  flex: 1;
  line-height: 1.5;
}
.dash-card-cta {
  margin-top: var(--space-2);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-full);
  border: 1.5px solid var(--color-accent);
  background: transparent;
  color: var(--color-accent);
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.dash-card-cta:hover {
  background: var(--color-accent);
  color: #fff;
}

/* ── Shimmer loading ────────────────────────────────────── */
.dash-shimmer {
  background: linear-gradient(
    90deg,
    var(--color-border) 25%,
    var(--color-surface-2) 50%,
    var(--color-border) 75%
  );
  background-size: 200% 100%;
  animation: dash-shimmer 1.4s ease infinite;
  border-radius: var(--radius-sm);
}
@keyframes dash-shimmer {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
.dash-shimmer-line {
  height: 14px;
  margin-bottom: var(--space-2);
  border-radius: var(--radius-sm);
}

/* ── Glance widget grid ─────────────────────────────────── */
.dash-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-4);
  margin-bottom: var(--space-6);
}
@media (max-width: 640px) {
  .dash-grid { grid-template-columns: 1fr; }
  .dash-card { flex: 0 0 200px; }
}

.dash-widget {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: var(--space-4);
  box-shadow: var(--shadow-sm);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.dash-widget-full { grid-column: 1 / -1; }

.dash-widget-title {
  font-size: var(--text-sm);
  font-weight: var(--weight-bold);
  color: var(--color-text);
  margin-bottom: var(--space-1);
}
.dash-widget-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1-5) 0;
  border-bottom: 1px solid var(--color-border);
  font-size: var(--text-sm);
  color: var(--color-text);
  cursor: pointer;
  transition: color 0.1s;
}
.dash-widget-row:last-child { border-bottom: none; }
.dash-widget-row:hover      { color: var(--color-accent); }
.dash-widget-row-label  { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dash-widget-row-badge  {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  white-space: nowrap;
  flex-shrink: 0;
}
.dash-widget-empty {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  text-align: center;
  padding: var(--space-4) 0;
}
.dash-widget-footer {
  margin-top: var(--space-2);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.dash-widget-add-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: var(--text-sm);
  color: var(--color-accent);
  font-weight: var(--weight-semibold);
  padding: var(--space-1) 0;
  text-align: left;
  transition: opacity 0.15s;
}
.dash-widget-add-btn:hover { opacity: 0.7; }

/* ── Person avatar chips ─────────────────────────────────── */
.dash-avatar-strip {
  display: flex;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.dash-avatar-chip {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  cursor: pointer;
  transition: opacity 0.15s;
}
.dash-avatar-chip:hover { opacity: 0.75; }
.dash-avatar-circle {
  width: 40px; height: 40px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-base);
  font-weight: var(--weight-bold);
  color: #fff;
  flex-shrink: 0;
}
.dash-avatar-name {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  max-width: 48px;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── Shopping list checkboxes ───────────────────────────── */
.dash-shop-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1-5) 0;
  border-bottom: 1px solid var(--color-border);
  font-size: var(--text-sm);
}
.dash-shop-row:last-child   { border-bottom: none; }
.dash-shop-row input[type=checkbox] { cursor: pointer; flex-shrink: 0; }
.dash-shop-row label {
  flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  cursor: pointer;
  color: var(--color-text);
}
.dash-shop-row label.checked {
  color: var(--color-text-muted);
  text-decoration: line-through;
}
.dash-shop-qty {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  flex-shrink: 0;
}

/* ── Daily review widget CTA ─────────────────────────────── */
.dash-daily-widget {
  background: linear-gradient(135deg, rgba(10,123,108,0.08) 0%, rgba(10,123,108,0.03) 100%);
  border-color: rgba(10,123,108,0.25);
}
.dash-daily-cta {
  width: 100%;
  margin-top: var(--space-2);
  padding: var(--space-2-5) var(--space-4);
  border-radius: var(--radius-full);
  border: none;
  background: var(--color-accent);
  color: #fff;
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  cursor: pointer;
  transition: opacity 0.15s;
}
.dash-daily-cta:hover { opacity: 0.85; }

/* ── Date badge colours ──────────────────────────────────── */
.dash-date-soon  { color: var(--color-danger); font-weight: var(--weight-semibold); }
.dash-date-near  { color: var(--color-warning-text); }
.dash-date-ok    { color: var(--color-text-muted); }
`;
  document.head.appendChild(s);
}

// ── Local date utilities ──────────────────────────────────────────────────────
// NEVER use toISOString().slice(0,10) — UTC-shift bug in negative-offset zones.

function _todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function _monthStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}

/** Days until a YYYY-MM-DD date string (negative = past). Local time. */
function _daysUntil(dateStr) {
  if (!dateStr) return null;
  const parts = String(dateStr).slice(0, 10).split('-').map(Number);
  const target = new Date(parts[0], parts[1]-1, parts[2]);
  const today  = new Date(); today.setHours(0,0,0,0);
  return Math.round((target - today) / 86400000);
}

/** Friendly relative label. */
function _relLabel(dateStr) {
  const n = _daysUntil(dateStr);
  if (n === null)  return '';
  if (n <  0)      return `${Math.abs(n)}d overdue`;
  if (n === 0)     return 'Today';
  if (n === 1)     return 'Tomorrow';
  const d = new Date(new Date().getFullYear(), 0, 1); // placeholder
  const parts = String(dateStr).slice(0,10).split('-').map(Number);
  const dt = new Date(parts[0], parts[1]-1, parts[2]);
  return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Time-ago helper (for posts/notes). */
function _timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h/24)}d ago`;
}

/** Next occurrence of a birthday month-day, relative to today. */
function _daysUntilBirthday(dateStr) {
  if (!dateStr) return null;
  const parts = String(dateStr).slice(0,10).split('-').map(Number);
  const today = new Date(); today.setHours(0,0,0,0);
  const thisYear = new Date(today.getFullYear(), parts[1]-1, parts[2]);
  if (thisYear >= today) return Math.round((thisYear - today) / 86400000);
  const nextYear = new Date(today.getFullYear()+1, parts[1]-1, parts[2]);
  return Math.round((nextYear - today) / 86400000);
}

/** Escape HTML. */
function _esc(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/** Truncate text. */
function _trunc(str, len) {
  const s = String(str || '');
  return s.length > len ? s.slice(0, len) + '…' : s;
}

/** Avatar background colour for a person. */
function _avatarColor(person, index) {
  if (person?.color && PERSON_COLOR_MAP[person.color]) return PERSON_COLOR_MAP[person.color];
  return DEFAULT_AVATAR_COLORS[index % DEFAULT_AVATAR_COLORS.length];
}

// ── Greeting helpers ──────────────────────────────────────────────────────────

function _salutation() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function _formattedDate() {
  return new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

async function _resolveFirstName() {
  try {
    const account = getAccount();
    if (!account) return 'there';
    if (account.memberId) {
      const { getEntity } = await import('../core/db.js');
      const person = await getEntity(account.memberId);
      if (person?.name) return person.name.split(' ')[0];
    }
    return account.username || 'there';
  } catch {
    return 'there';
  }
}

// ── Shimmer skeleton builders ─────────────────────────────────────────────────

// Deterministic shimmer widths — cycling pattern avoids layout flicker
// that Math.random() causes on debounced re-renders.
const _SHIMMER_WIDTHS = ['75%', '55%', '85%', '60%', '70%', '80%', '50%'];
function _shimmerLines(count = 3) {
  return Array.from({ length: count }, (_, i) =>
    `<div class="dash-shimmer dash-shimmer-line" style="width:${_SHIMMER_WIDTHS[i % _SHIMMER_WIDTHS.length]}"></div>`
  ).join('');
}

function _cardSkeleton(id, title, icon) {
  return `
    <div class="dash-card" data-dash-card="${_esc(id)}">
      <div class="dash-card-top">
        <div class="dash-card-icon">${icon}</div>
        <div class="dash-card-badge neutral dash-card-badge-el">—</div>
      </div>
      <div class="dash-card-title">${_esc(title)}</div>
      <div class="dash-card-stat dash-shimmer dash-shimmer-line" style="width:60%;height:22px;"></div>
      <div class="dash-card-sub">${_shimmerLines(2)}</div>
      <button class="dash-card-cta" disabled>Loading…</button>
    </div>`;
}

// ── Main render function ──────────────────────────────────────────────────────

async function renderDashboard() {
  // [fix] Lazy-load time-tracker on first render — safe even if file not yet deployed
  if (!_tt_loaded) {
    try {
      const tt = await import('../services/time-tracker.js');
      _tt_activeTaskIds  = tt.activeTaskIds;
      _tt_alarmedTaskIds = tt.alarmedTaskIds;
      _tt_sessionsSignal = tt.sessionsSignal;
      _tt_getElapsed     = tt.getElapsed;
      _tt_getRemaining   = tt.getRemaining;
      _tt_formatDurationCompact = tt.formatDurationCompact;
      _tt_formatDuration = tt.formatDuration;
      _tt_TIMER_TICK     = tt.TIMER_TICK;
      _tt_TIMER_ALARM    = tt.TIMER_ALARM;
    } catch (e) { console.warn('[dashboard] time-tracker not available:', e.message); }
    _tt_loaded = true;
  }

  // Render mutex — prevents double-render race when ENTITY_SAVED fires
  // during the async _resolveFirstName() gap below.
  if (_rendering) return;
  _rendering = true;

  const el = document.getElementById(`view-${VIEW_KEY}`);
  if (!el) { _rendering = false; return; }

  _injectStyles();

  // Resolve name asynchronously but render skeleton immediately
  const firstName = await _resolveFirstName();

  // Re-check active after the await — user may have navigated away
  if (!_isActive()) { _rendering = false; return; }

  el.innerHTML = `
    <!-- Greeting -->
    <div class="dash-header">
      <div>
        <div class="dash-greeting-name">${_esc(_salutation())}, ${_esc(firstName)}! 👋</div>
        <div class="dash-greeting-date">${_esc(_formattedDate())}</div>
      </div>
    </div>

    <!-- Alert banner placeholder (replaced by _loadBanner) -->
    <div id="dash-banner-wrap"></div>

    <!-- Primary cards -->
    <div class="dash-section-label">At a Glance</div>
    <div class="dash-cards-wrap">
      <button class="dash-scroll-btn dash-scroll-btn-left" id="dash-scroll-left" aria-label="Scroll left">&#8249;</button>
      <div class="dash-cards-scroll" id="dash-cards-scroll">
        ${_cardSkeleton('tasks',    'Tasks',       '✅')}
        ${_cardSkeleton('calendar', 'This Week',   '📅')}
        ${_cardSkeleton('budget',   'Budget',      '💰')}
        ${_cardSkeleton('messages', 'Messages',      '💬')}
        ${_cardSkeleton('wall',     'Activity Wall', '🏠')}
        ${_cardSkeleton('recipes',  'Recipes',     '🍳')}
        ${_cardSkeleton('documents','Documents',   '📄')}
      </div>
      <button class="dash-scroll-btn dash-scroll-btn-right" id="dash-scroll-right" aria-label="Scroll right">&#8250;</button>
    </div>

    <!-- Glance widgets -->
    <div class="dash-section-label">Your Family</div>
    <div class="dash-grid" id="dash-grid">

      <!-- Widget: Family Members (full width) -->
      <div class="dash-widget dash-widget-full" id="dash-widget-members">
        <div class="dash-widget-title">👥 Family Members</div>
        <div class="dash-avatar-strip" id="dash-avatar-strip">
          <div class="dash-shimmer dash-shimmer-line" style="width:100%;height:40px;border-radius:50px;"></div>
        </div>
      </div>

      <!-- Widget: Shopping List -->
      <div class="dash-widget" id="dash-widget-shopping">
        <div class="dash-widget-title">🛒 Shopping List</div>
        <div id="dash-shop-list">${_shimmerLines(3)}</div>
        <button class="dash-widget-add-btn" id="dash-shop-add">+ Add item</button>
      </div>

      <!-- Widget: Active Projects -->
      <div class="dash-widget" id="dash-widget-projects">
        <div class="dash-widget-title">📁 Projects</div>
        <div id="dash-proj-list">${_shimmerLines(3)}</div>
        <button class="dash-widget-add-btn" id="dash-proj-nav">View all projects →</button>
      </div>

      <!-- Widget: Upcoming Dates -->
      <div class="dash-widget" id="dash-widget-dates">
        <div class="dash-widget-title">🎂 Upcoming Dates</div>
        <div id="dash-dates-list">${_shimmerLines(3)}</div>
      </div>

      <!-- Widget: Recent Notes -->
      <div class="dash-widget" id="dash-widget-notes">
        <div class="dash-widget-title">📝 Recent Notes</div>
        <div id="dash-notes-list">${_shimmerLines(3)}</div>
        <button class="dash-widget-add-btn" id="dash-note-add">+ New Note</button>
      </div>

      <!-- Widget: Daily Review -->
      <div class="dash-widget dash-daily-widget" id="dash-widget-daily">
        <div class="dash-widget-title">🌅 Daily Review</div>
        <div class="dash-card-sub">Review your day, capture tasks and notes, plan tomorrow.</div>
        <div id="dash-daily-stat" style="font-size:var(--text-sm);color:var(--color-text-muted);"></div>
        <button class="dash-daily-cta" id="dash-daily-btn">Start Daily Review</button>
      </div>

      <!-- Widget: Active Timers -->
      <div class="dash-widget dash-widget-full" id="dash-widget-timers" style="display:none;">
        <div class="dash-widget-title">⏱️ Active Timers</div>
        <div id="dash-timers-list"></div>
      </div>

    </div>
  `;

  // Wire static buttons
  el.querySelector('#dash-shop-add')?.addEventListener('click', () => openForm('shoppingItem'));
  el.querySelector('#dash-proj-nav')?.addEventListener('click', () => navigate(VIEW_KEYS.PROJECTS));
  el.querySelector('#dash-note-add')?.addEventListener('click', () => openForm('note'));
  el.querySelector('#dash-daily-btn')?.addEventListener('click', () => navigate(VIEW_KEYS.DAILY));

  // ── Active Timers Widget ────────────────────────────────────
  {
    const timerWidget = el.querySelector('#dash-widget-timers');
    const timerList   = el.querySelector('#dash-timers-list');

    // TT-9 fix: lightweight tick-updates (badge text only); structural rebuild only on alarm/save
    // TT-13 fix: timer row click also opens the task panel directly
    const _rowRefs = new Map(); // taskId → { badge, icon, subText }

    function _buildTimerWidget() {
      if (!timerWidget || !timerList) return;
      const sessions = _tt_sessionsSignal.value;
      const active   = _tt_activeTaskIds.value;
      const alarmed  = _tt_alarmedTaskIds.value;
      const relevant = [...active, ...alarmed];
      if (relevant.length === 0) { timerWidget.style.display = 'none'; _rowRefs.clear(); return; }
      timerWidget.style.display = '';
      const relSet = new Set(relevant);
      for (const [tid] of _rowRefs) {
        if (!relSet.has(tid)) { timerList.querySelector('[data-ttask="' + tid + '"]')?.remove(); _rowRefs.delete(tid); }
      }
      for (const taskId of relevant) {
        const session = sessions[taskId];
        if (!session) continue;
        if (_rowRefs.has(taskId)) { _tickTimerRow(taskId); continue; }
        const row = document.createElement('div');
        row.className = 'dash-widget-row';
        row.dataset.ttask = taskId;
        row.style.cssText = 'display:flex;align-items:center;gap:var(--space-3);padding:var(--space-2) 0;cursor:pointer;';
        const icon = document.createElement('span'); icon.style.cssText = 'font-size:1.1rem;flex-shrink:0;';
        const info = document.createElement('div'); info.style.cssText = 'flex:1;min-width:0;';
        info.innerHTML = '<div style="font-size:var(--text-sm);font-weight:var(--weight-semibold);color:var(--color-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + (session.taskTitle || 'Task') + '</div>';
        const subText = document.createElement('div'); subText.style.cssText = 'font-size:var(--text-xs);';
        info.appendChild(subText);
        const badge = document.createElement('span');
        badge.style.cssText = 'font-size:var(--text-xs);font-weight:var(--weight-bold);font-variant-numeric:tabular-nums;padding:2px 8px;border-radius:var(--radius-full);color:#fff;';
        row.append(icon, info, badge);
        row.addEventListener('click', () => {
          navigate(VIEW_KEYS.KANBAN, { filterTab: 'today' });
          setTimeout(() => emit(EVENTS.PANEL_OPENED, { entityType: 'task', entityId: taskId }), 300);
        });
        timerList.appendChild(row);
        _rowRefs.set(taskId, { badge, icon, subText });
        _tickTimerRow(taskId);
      }
    }

    function _tickTimerRow(taskId) {
      const refs = _rowRefs.get(taskId); if (!refs) return;
      const sessions = _tt_sessionsSignal.value; const alarmed = _tt_alarmedTaskIds.value;
      const session = sessions[taskId]; if (!session) return;
      const { badge, icon, subText } = refs;
      const isAlarmed = alarmed.has(taskId);
      const elapsed   = _tt_getElapsed(session);
      const remaining = session.mode === 'block' && session.blockSecs ? _tt_getRemaining(session) : null;
      icon.textContent = isAlarmed ? '\uD83D\uDD14' : session.mode === 'block' ? '\u23F2\uFE0F' : '\u23F1\uFE0F';
      if (isAlarmed) {
        subText.style.color = 'var(--color-danger)'; badge.style.background = 'var(--color-danger)';
        subText.textContent = '\uD83D\uDD14 Block complete \u2014 ' + _tt_formatDuration(elapsed) + ' recorded'; badge.textContent = 'DONE';
      } else if (session.mode === 'block' && remaining !== null) {
        const u = remaining <= 60; subText.style.color = u ? 'var(--color-danger)' : 'var(--color-text-muted)';
        badge.style.background = u ? 'var(--color-danger)' : 'var(--color-accent)';
        subText.textContent = '\u23F2 ' + _tt_formatDurationCompact(remaining) + ' remaining of ' + _tt_formatDuration(session.blockSecs);
        badge.textContent = _tt_formatDurationCompact(remaining);
      } else {
        subText.style.color = 'var(--color-text-muted)'; badge.style.background = 'var(--color-accent)';
        subText.textContent = '\u23F1 Running \u2014 ' + _tt_formatDuration(elapsed);
        badge.textContent = _tt_formatDurationCompact(elapsed);
      }
    }

    _buildTimerWidget();
    on(_tt_TIMER_TICK,  () => { for (const [tid] of _rowRefs) _tickTimerRow(tid); }); // badge-only, no DOM rebuild
    on(_tt_TIMER_ALARM, _buildTimerWidget); // structural refresh
    on(TIMER_SAVED, _buildTimerWidget);
  }

  // Wire scroll buttons for cards strip
  {
    const scroll = el.querySelector('#dash-cards-scroll');
    const btnL   = el.querySelector('#dash-scroll-left');
    const btnR   = el.querySelector('#dash-scroll-right');
    if (scroll && btnL && btnR) {
      const STEP = 240;
      const _updateBtns = () => {
        btnL.disabled = scroll.scrollLeft <= 0;
        btnR.disabled = scroll.scrollLeft + scroll.clientWidth >= scroll.scrollWidth - 2;
      };
      btnL.addEventListener('click', () => { scroll.scrollBy({ left: -STEP, behavior: 'smooth' }); setTimeout(_updateBtns, 350); });
      btnR.addEventListener('click', () => { scroll.scrollBy({ left:  STEP, behavior: 'smooth' }); setTimeout(_updateBtns, 350); });
      scroll.addEventListener('scroll', _updateBtns, { passive: true });
      // Defer initial check — card content loads async so scrollWidth isn't final yet
      requestAnimationFrame(() => requestAnimationFrame(_updateBtns));

      // Clean up scroll listener when navigating away — prevents listener accumulation
      const _cleanupScroll = () => scroll.removeEventListener('scroll', _updateBtns);
      const _unsubScroll = on(EVENTS.VIEW_CHANGED, () => { _cleanupScroll(); _unsubScroll(); });
    }
  }

  // Release mutex before async load — allows debounce re-renders to queue
  // while data is fetching without blocking them entirely.
  _rendering = false;

  // Load all data in parallel then populate
  _loadAndPopulate(el);
}

// ── Data loading and population ───────────────────────────────────────────────

async function _loadAndPopulate(el) {
  try {
    const [
      tasks, events, appointments, budgetEntries,
      posts, recipes, documents, persons,
      shoppingItems, projects, dateEntities, notes,
    ] = await Promise.all([
      getEntitiesByType('task'),
      getEntitiesByType('event'),
      getEntitiesByType('appointment'),
      getEntitiesByType('budgetEntry'),
      getEntitiesByType('post'),
      getEntitiesByType('recipe'),
      getEntitiesByType('document'),
      getEntitiesByType('person'),
      getEntitiesByType('shoppingItem'),
      getEntitiesByType('project'),
      getEntitiesByType('dateEntity'),
      getEntitiesByType('note'),
    ]);

    // Guard: user may have navigated away while IDB was resolving.
    // Writing to a hidden view wastes work and can flash content briefly.
    if (!_isActive()) return;

    // Apply context filter to all entity lists
    const ctx = getActiveContext();
    const _f  = (arr) => filterByContext(arr.filter(e => !e.deleted), ctx);


    const data = {
      tasks:         _f(tasks),
      events:        _f(events),
      appointments:  _f(appointments),
      budgetEntries: _f(budgetEntries),
      posts:         _f(posts),
      recipes:       _f(recipes),
      documents:     _f(documents),
      persons:       persons.filter(p => !p.deleted), // persons don't use context filter
      shoppingItems: _f(shoppingItems),
      projects:      _f(projects),
      dateEntities:  _f(dateEntities),
      notes:         _f(notes),
    };

    // Populate cards
    _populateTaskCard(el, data.tasks);
    _populateCalendarCard(el, data.events, data.appointments);
    _populateBudgetCard(el, data.budgetEntries);
    await _populateMessagesCard(el);
    _populateWallCard(el, data.posts);
    _populateRecipesCard(el, data.recipes);
    _populateDocumentsCard(el, data.documents);

    // Populate banner (after data loaded)
    _populateBanner(el, data.tasks, data.documents, data.posts);

    // Populate widgets
    _populateMembersWidget(el, data.persons);
    _populateShoppingWidget(el, data.shoppingItems);
    _populateProjectsWidget(el, data.projects);
    _populateDatesWidget(el, data.dateEntities, data.persons);
    _populateNotesWidget(el, data.notes);

  } catch (err) {
    console.error('[dashboard] Data load failed:', err);
  }
}

// ── Card populators ───────────────────────────────────────────────────────────

function _populateTaskCard(el, tasks) {
  const card = el.querySelector('[data-dash-card="tasks"]');
  if (!card) return;

  const today    = _todayStr();
  const open     = tasks.filter(t => t.status !== 'Done' && t.status !== 'Completed'); // SYS-07
  const _safeDate = (d) => { if (!d) return null; const s = String(d); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0,10) : null; };
  const dueToday = open.filter(t => _safeDate(t.dueDate) === today); // SYS-09
  const overdue  = open.filter(t => _safeDate(t.dueDate) && _safeDate(t.dueDate) < today);

  const hasAlert = overdue.length > 0;
  const badgeClass = hasAlert ? 'danger' : dueToday.length > 0 ? 'warn' : 'ok';
  const badgeText  = hasAlert ? `${overdue.length} overdue` : dueToday.length > 0 ? `${dueToday.length} due today` : 'All clear';
  const statClass  = hasAlert ? 'danger' : '';
  const statText   = open.length > 0 ? `${open.length} open` : 'No open tasks';

  let sub = '';
  if (dueToday.length > 0) sub += `${dueToday.length} due today. `;
  if (overdue.length > 0)  sub += `${overdue.length} overdue.`;
  if (!sub) sub = 'Nothing due today.';

  card.querySelector('.dash-card-badge-el').className = `dash-card-badge ${badgeClass} dash-card-badge-el`;
  card.querySelector('.dash-card-badge-el').textContent = badgeText;
  card.querySelector('.dash-card-stat').className = `dash-card-stat ${statClass}`;
  card.querySelector('.dash-card-stat').textContent = statText;
  card.querySelector('.dash-card-sub').innerHTML = _esc(sub);

  const btn = card.querySelector('.dash-card-cta');
  btn.disabled = false;
  btn.textContent = 'Open Tasks';
  btn.onclick = () => navigate(VIEW_KEYS.KANBAN);
}

function _populateCalendarCard(el, events, appointments) {
  const card = el.querySelector('[data-dash-card="calendar"]');
  if (!card) return;

  const today   = _todayStr();
  const in7     = new Date(); in7.setDate(in7.getDate() + 7);
  const in7Str  = `${in7.getFullYear()}-${String(in7.getMonth()+1).padStart(2,'0')}-${String(in7.getDate()).padStart(2,'0')}`;

  const combined = [
    ...events.map(e => ({ ...e, _kind: 'event' })),
    ...appointments.map(a => ({ ...a, _kind: 'appt', date: a.date })),
  ]
    .filter(e => {
      const d = String(e.date || '').slice(0,10);
      return d >= today && d <= in7Str;
    })
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const next3 = combined.slice(0, 3);
  const statText = combined.length > 0 ? `${combined.length} this week` : 'Nothing this week';
  const statClass = combined.length > 0 ? '' : 'text-stat';

  let sub = '';
  if (next3.length === 0) {
    sub = 'No events in the next 7 days.';
  } else {
    sub = next3.map(e => {
      const label = _relLabel(String(e.date).slice(0,10));
      const title = _trunc(e.title || e.label || 'Untitled', 28);
      return `<span style="display:block;">${_esc(label)}: ${_esc(title)}</span>`;
    }).join('');
  }

  card.querySelector('.dash-card-badge-el').className = `dash-card-badge ${combined.length > 0 ? 'ok' : 'neutral'} dash-card-badge-el`;
  card.querySelector('.dash-card-badge-el').textContent = combined.length > 0 ? `${combined.length} upcoming` : 'Empty';
  card.querySelector('.dash-card-stat').className = `dash-card-stat ${statClass}`;
  card.querySelector('.dash-card-stat').textContent = statText;
  card.querySelector('.dash-card-sub').innerHTML = sub;

  const btn = card.querySelector('.dash-card-cta');
  btn.disabled = false;
  btn.textContent = 'Open Calendar';
  btn.onclick = () => navigate(VIEW_KEYS.CALENDAR);
}

function _populateBudgetCard(el, entries) {
  const card = el.querySelector('[data-dash-card="budget"]');
  if (!card) return;

  const month = _monthStr();
  const thisMonth = entries.filter(e => String(e.date || '').slice(0,7) === month);

  let income = 0, expenses = 0;
  for (const e of thisMonth) {
    const amt = parseFloat(e.amount) || 0;
    if (e._subtype === 'Income' || e.type === 'Income') income += amt;
    else expenses += amt;
  }
  const net = income - expenses;

  const fmt = (n) => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const statClass = net >= 0 ? 'success' : 'danger';
  const statText  = (net >= 0 ? '+' : '−') + fmt(net);

  const sub = thisMonth.length > 0
    ? `Income: ${fmt(income)} · Expenses: ${fmt(expenses)}`
    : 'No entries this month.';

  card.querySelector('.dash-card-badge-el').className = `dash-card-badge ${net >= 0 ? 'ok' : 'danger'} dash-card-badge-el`;
  card.querySelector('.dash-card-badge-el').textContent = net >= 0 ? 'Positive' : 'Deficit';
  card.querySelector('.dash-card-stat').className = `dash-card-stat ${statClass}`;
  card.querySelector('.dash-card-stat').textContent = statText;
  card.querySelector('.dash-card-sub').textContent = sub;

  const btn = card.querySelector('.dash-card-cta');
  btn.disabled = false;
  btn.textContent = 'Open Budget';
  btn.onclick = () => navigate(VIEW_KEYS.BUDGET);
}

function _populateWallCard(el, posts) {
  const card = el.querySelector('[data-dash-card="wall"]');
  if (!card) return;

  // Sort descending by createdAt
  const sorted = [...posts].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const latest  = sorted[0];

  const in7  = new Date(); in7.setDate(in7.getDate() - 7);
  const weekPosts = posts.filter(p => p.createdAt && new Date(p.createdAt) >= in7);

  let sub = '';
  if (latest) {
    const body = latest.body
      ? String(latest.body).replace(/<[^>]+>/g, '').trim()
      : '';
    sub = `<span style="display:block;font-style:italic;">"${_esc(_trunc(body || '(no content)', 60))}"</span>`;
    sub += `<span style="display:block;margin-top:4px;color:var(--color-text-muted);">${_esc(_timeAgo(latest.createdAt))}</span>`;
  } else {
    sub = 'No posts yet — open the Activity Wall to get started!';
  }

  card.querySelector('.dash-card-badge-el').className = `dash-card-badge ${weekPosts.length > 0 ? 'ok' : 'neutral'} dash-card-badge-el`;
  card.querySelector('.dash-card-badge-el').textContent = weekPosts.length > 0 ? `${weekPosts.length} this week` : 'Quiet';
  card.querySelector('.dash-card-stat').className = 'dash-card-stat';
  card.querySelector('.dash-card-stat').textContent = `${posts.length} total`;
  card.querySelector('.dash-card-sub').innerHTML = sub;

  const btn = card.querySelector('.dash-card-cta');
  btn.disabled = false;
  btn.textContent = 'Open Activity Wall';
  btn.onclick = () => navigate(VIEW_KEYS.ACTIVITY_CENTER);
}

async function _populateMessagesCard(el) {
  const card = el.querySelector('[data-dash-card="messages"]');
  if (!card) return;
  const acct = getAccount();
  if (!acct?.memberId) return;
  try {
    const edges  = await getEdgesFrom(acct.memberId, 'participates-in');
    const convos = (await Promise.all(edges.map(e => getEntity(e.toId)))).filter(Boolean);
    const total  = convos.reduce((s, c2) => s + (c2.unreadCounts?.[acct.memberId] ?? 0), 0);
    const unreadConvos = convos.filter(c2 => (c2.unreadCounts?.[acct.memberId] ?? 0) > 0);

    card.querySelector('.dash-card-badge-el').className =
      `dash-card-badge ${total > 0 ? 'danger' : 'neutral'} dash-card-badge-el`;
    card.querySelector('.dash-card-badge-el').textContent =
      total > 0 ? `${total} unread` : 'All read';
    card.querySelector('.dash-card-stat').className = 'dash-card-stat';
    card.querySelector('.dash-card-stat').textContent =
      `${convos.length} conversation${convos.length !== 1 ? 's' : ''}`;

    let sub = '';
    if (total > 0) {
      sub = `<span style="display:block;">${unreadConvos.length} conversation${unreadConvos.length!==1?'s':''} with new messages</span>`;
    } else if (convos.length > 0) {
      sub = `<span style="display:block;color:var(--color-text-muted);">All caught up ✓</span>`;
    } else {
      sub = `<span style="display:block;color:var(--color-text-muted);">No conversations yet</span>`;
    }
    card.querySelector('.dash-card-sub').innerHTML = sub;

    const btn = card.querySelector('.dash-card-cta');
    btn.disabled    = false;
    btn.textContent = total > 0 ? 'View Messages' : 'Open Messages';
    btn.onclick     = () => navigate(VIEW_KEYS.MESSAGES);
  } catch (e) {
    console.warn('[dashboard] messages card failed:', e);
  }
}

function _populateRecipesCard(el, recipes) {
  const card = el.querySelector('[data-dash-card="recipes"]');
  if (!card) return;

  const sorted = [...recipes].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const latest = sorted[0];

  const sub = latest
    ? `Last added: ${_esc(_trunc(latest.title || 'Untitled', 40))}`
    : 'No recipes saved yet.';

  card.querySelector('.dash-card-badge-el').className = `dash-card-badge ${recipes.length > 0 ? 'ok' : 'neutral'} dash-card-badge-el`;
  card.querySelector('.dash-card-badge-el').textContent = recipes.length > 0 ? `${recipes.length} saved` : 'Empty';
  card.querySelector('.dash-card-stat').className = 'dash-card-stat';
  card.querySelector('.dash-card-stat').textContent = `${recipes.length} recipe${recipes.length !== 1 ? 's' : ''}`;
  card.querySelector('.dash-card-sub').textContent = sub;

  const btn = card.querySelector('.dash-card-cta');
  btn.disabled = false;
  btn.textContent = 'Open Recipes';
  btn.onclick = () => navigate(VIEW_KEYS.RECIPES);
}

function _populateDocumentsCard(el, documents) {
  const card = el.querySelector('[data-dash-card="documents"]');
  if (!card) return;

  const withExpiry  = documents.filter(d => d.expiryDate);
  const expiringSoon = withExpiry.filter(d => {
    const n = _daysUntil(d.expiryDate);
    return n !== null && n >= 0 && n <= 90;
  }).sort((a, b) => _daysUntil(a.expiryDate) - _daysUntil(b.expiryDate));

  const next = expiringSoon[0];
  const hasUrgent = expiringSoon.some(d => _daysUntil(d.expiryDate) <= 30);

  const statText = documents.length > 0
    ? `${documents.length} document${documents.length !== 1 ? 's' : ''}`
    : 'No documents';

  let sub = '';
  if (next) {
    const days = _daysUntil(next.expiryDate);
    const color = days <= 30 ? 'var(--color-danger)' : 'var(--color-warning-text)';
    sub = `<span>Next expiry: <strong style="color:${color}">${_esc(_trunc(next.name || 'Untitled', 24))}</strong> in ${days}d</span>`;
    if (expiringSoon.length > 1) sub += `<span style="display:block;margin-top:4px;">${expiringSoon.length} expiring within 90 days</span>`;
  } else {
    sub = 'No documents expiring soon.';
  }

  card.querySelector('.dash-card-badge-el').className = `dash-card-badge ${hasUrgent ? 'danger' : expiringSoon.length > 0 ? 'warn' : 'ok'} dash-card-badge-el`;
  card.querySelector('.dash-card-badge-el').textContent = hasUrgent ? 'Expiring soon' : expiringSoon.length > 0 ? `${expiringSoon.length} expiring` : 'Up to date';
  card.querySelector('.dash-card-stat').className = 'dash-card-stat';
  card.querySelector('.dash-card-stat').textContent = statText;
  card.querySelector('.dash-card-sub').innerHTML = sub;

  const btn = card.querySelector('.dash-card-cta');
  btn.disabled = false;
  btn.textContent = 'Open Documents';
  btn.onclick = () => navigate(VIEW_KEYS.DOCUMENTS);
}

// ── Widget populators ─────────────────────────────────────────────────────────

function _populateMembersWidget(el, persons) {
  const strip = el.querySelector('#dash-avatar-strip');
  if (!strip) return;

  if (persons.length === 0) {
    strip.innerHTML = `<div class="dash-widget-empty">No family members yet.</div>`;
    return;
  }

  strip.innerHTML = persons.map((p, i) => {
    const name    = p.name || 'Unknown';
    const initials = name.split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
    const color   = _avatarColor(p, i);
    return `
      <div class="dash-avatar-chip" data-person-id="${_esc(p.id)}" title="${_esc(name)}">
        <div class="dash-avatar-circle" style="background:${color};">${_esc(initials)}</div>
        <div class="dash-avatar-name">${_esc(name.split(' ')[0])}</div>
      </div>`;
  }).join('');

  strip.querySelectorAll('.dash-avatar-chip').forEach(chip => {
    chip.addEventListener('click', () => emit(EVENTS.PANEL_OPENED, { entityId: chip.dataset.personId }));
  });
}

function _populateShoppingWidget(el, items) {
  const list = el.querySelector('#dash-shop-list');
  if (!list) return;

  const unchecked = items.filter(i => !i.checked);
  const checked   = items.filter(i =>  i.checked);

  if (items.length === 0) {
    list.innerHTML = `<div class="dash-widget-empty">Shopping list is empty.</div>`;
    return;
  }

  // Show up to 5 unchecked, then note checked count
  const show = unchecked.slice(0, 5);

  list.innerHTML = show.map(item => {
    const qty = item.quantity ? ` (${_esc(item.quantity)})` : '';
    return `
      <div class="dash-shop-row" data-item-id="${_esc(item.id)}">
        <input type="checkbox" id="shop-${_esc(item.id)}" aria-label="${_esc(item.title || 'Item')}">
        <label for="shop-${_esc(item.id)}">${_esc(_trunc(item.title || 'Item', 36))}${qty}</label>
      </div>`;
  }).join('');

  if (unchecked.length > 5) {
    list.innerHTML += `<div class="dash-widget-footer">${unchecked.length - 5} more item${unchecked.length-5 !== 1 ? 's' : ''} not shown</div>`;
  }

  const footer = checked.length > 0
    ? `<div class="dash-widget-footer">${checked.length} item${checked.length !== 1 ? 's' : ''} checked off</div>`
    : '';
  list.innerHTML += footer;

  // Wire checkboxes
  list.querySelectorAll('.dash-shop-row').forEach(row => {
    const cb = row.querySelector('input[type=checkbox]');
    const lbl = row.querySelector('label');
    cb.addEventListener('change', async () => {
      const id = row.dataset.itemId;
      const item = items.find(i => i.id === id);
      if (!item) return;
      try {
        lbl.classList.add('checked');
        row.style.opacity = '0.5';
        await saveEntity({ ...item, checked: true, updatedAt: new Date().toISOString() }, getAccount()?.id);
        // Re-populate this widget only
        _populateShoppingWidget(el, items.map(i => i.id === id ? { ...i, checked: true } : i));
      } catch (err) {
        console.error('[dashboard] Shopping item save failed:', err);
        // Rollback visual state so user knows the save failed
        cb.checked = false;
        lbl.classList.remove('checked');
        row.style.opacity = '';
      }
    });
  });
}

function _populateProjectsWidget(el, projects) {
  const list = el.querySelector('#dash-proj-list');
  if (!list) return;

  const active = projects.filter(p => p.status !== 'Complete' && p.status !== 'Archived');
  const show   = active.slice(0, 4);

  if (show.length === 0) {
    list.innerHTML = `<div class="dash-widget-empty">No active projects.</div>`;
    return;
  }

  list.innerHTML = show.map(p => {
    const statusColor = p.status === 'On Hold' ? 'var(--color-warning-text)' : 'var(--color-accent)';
    return `
      <div class="dash-widget-row" data-proj-id="${_esc(p.id)}">
        <span class="dash-widget-row-label">📁 ${_esc(_trunc(p.name || 'Untitled', 30))}</span>
        <span class="dash-widget-row-badge" style="color:${statusColor}">${_esc(p.status || 'Active')}</span>
      </div>`;
  }).join('');

  list.querySelectorAll('.dash-widget-row').forEach(row => {
    row.addEventListener('click', () => emit(EVENTS.PANEL_OPENED, { entityId: row.dataset.projId }));
  });
}

function _populateDatesWidget(el, dateEntities, persons) {
  const list = el.querySelector('#dash-dates-list');
  if (!list) return;

  // Build person lookup map
  const personMap = {};
  for (const p of persons) personMap[p.id] = p;

  // Compute next occurrence for each date entity
  const withDays = dateEntities
    .filter(d => d.date)
    .map(d => {
      const isBirthday = d.type === 'Birthday' || d.type === 'Anniversary';
      const days = isBirthday ? _daysUntilBirthday(d.date) : _daysUntil(d.date);
      return { ...d, _daysUntil: days };
    })
    .filter(d => d._daysUntil !== null && d._daysUntil >= 0)
    .sort((a, b) => a._daysUntil - b._daysUntil)
    .slice(0, 5);

  if (withDays.length === 0) {
    list.innerHTML = `<div class="dash-widget-empty">No upcoming dates.</div>`;
    return;
  }

  const typeIcons = { Birthday: '🎂', Anniversary: '💍', Holiday: '🎉', Milestone: '🏆' };

  list.innerHTML = withDays.map(d => {
    const icon  = typeIcons[d.type] || '📅';
    const label = d.label || 'Untitled';
    const person = d.person ? personMap[d.person] : null;
    const who   = person?.name ? ` · ${person.name.split(' ')[0]}` : '';
    const days  = d._daysUntil;
    const cls   = days === 0 ? 'dash-date-soon' : days <= 7 ? 'dash-date-near' : 'dash-date-ok';
    const daysLabel = days === 0 ? 'Today!' : days === 1 ? 'Tomorrow' : `${days}d`;
    return `
      <div class="dash-widget-row">
        <span class="dash-widget-row-label">${icon} ${_esc(_trunc(label + who, 32))}</span>
        <span class="dash-widget-row-badge ${cls}">${_esc(daysLabel)}</span>
      </div>`;
  }).join('');
}

function _populateNotesWidget(el, notes) {
  const list = el.querySelector('#dash-notes-list');
  if (!list) return;

  const sorted = [...notes].sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
  const show   = sorted.slice(0, 3);

  if (show.length === 0) {
    list.innerHTML = `<div class="dash-widget-empty">No notes yet.</div>`;
    return;
  }

  list.innerHTML = show.map(n => {
    const body = n.body ? String(n.body).replace(/<[^>]+>/g, '').trim() : '';
    return `
      <div class="dash-widget-row" data-note-id="${_esc(n.id)}">
        <span class="dash-widget-row-label" title="${_esc(n.title || 'Untitled')}">
          ${_esc(_trunc(n.title || 'Untitled', 30))}
        </span>
        <span class="dash-widget-row-badge">${_esc(_timeAgo(n.updatedAt || n.createdAt))}</span>
      </div>`;
  }).join('');

  list.querySelectorAll('.dash-widget-row').forEach(row => {
    row.addEventListener('click', () => emit(EVENTS.PANEL_OPENED, { entityId: row.dataset.noteId }));
  });
}

// ── Banner populator ──────────────────────────────────────────────────────────

function _populateBanner(el, tasks, documents, posts) {
  const wrap = el.querySelector('#dash-banner-wrap');
  if (!wrap) return;

  // Already dismissed this session
  if (sessionStorage.getItem(BANNER_SS_KEY) === '1') {
    wrap.innerHTML = '';
    return;
  }

  const today    = _todayStr();
  const openTasks = tasks.filter(t => t.status !== 'Done' && t.status !== 'Completed'); // SYS-08
  const _safeDate2 = (d) => { if (!d) return null; const s = String(d); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0,10) : null; };
  const overdue  = openTasks.filter(t => _safeDate2(t.dueDate) && _safeDate2(t.dueDate) < today); // SYS-09c

  const expiringSoon = documents.filter(d => {
    const n = _daysUntil(d.expiryDate);
    return n !== null && n >= 0 && n <= 30;
  });

  const in7  = new Date(); in7.setDate(in7.getDate() - 7);
  const recentPosts = posts.filter(p => p.createdAt && new Date(p.createdAt) >= in7);

  // Priority: overdue tasks > expiring docs > recent posts
  let icon = '', title = '', msg = '', ctaLabel = '', ctaView = null;

  if (overdue.length > 0) {
    icon     = '⚠️';
    title    = `${overdue.length} overdue task${overdue.length !== 1 ? 's' : ''}`;
    msg      = 'Some tasks are past their due date and need attention.';
    ctaLabel = 'Review Tasks';
    ctaView  = VIEW_KEYS.KANBAN;
  } else if (expiringSoon.length > 0) {
    icon     = '📄';
    title    = `${expiringSoon.length} document${expiringSoon.length !== 1 ? 's' : ''} expiring within 30 days`;
    msg      = 'Check your documents before they expire.';
    ctaLabel = 'View Documents';
    ctaView  = VIEW_KEYS.DOCUMENTS;
  } else if (recentPosts.length > 0) {
    icon     = '💬';
    title    = `${recentPosts.length} new post${recentPosts.length !== 1 ? 's' : ''} on the Activity Wall this week`;
    msg      = 'See what\'s been shared recently.';
    ctaLabel = 'Open Activity Wall';
    ctaView  = VIEW_KEYS.ACTIVITY_CENTER;
  } else {
    wrap.innerHTML = '';
    return;
  }

  wrap.innerHTML = `
    <div class="dash-banner">
      <div class="dash-banner-icon">${icon}</div>
      <div class="dash-banner-body">
        <div class="dash-banner-title">${_esc(title)}</div>
        <div class="dash-banner-msg">${_esc(msg)}</div>
        <button class="dash-banner-cta" id="dash-banner-cta-btn">${_esc(ctaLabel)}</button>
      </div>
      <button class="dash-banner-dismiss" id="dash-banner-dismiss" aria-label="Dismiss">✕</button>
    </div>`;

  wrap.querySelector('#dash-banner-cta-btn')?.addEventListener('click', () => {
    if (ctaView) navigate(ctaView);
  });

  wrap.querySelector('#dash-banner-dismiss')?.addEventListener('click', () => {
    sessionStorage.setItem(BANNER_SS_KEY, '1');
    wrap.innerHTML = '';
  });
}

// ── Reactive refresh ──────────────────────────────────────────────────────────

let _debounceTimer = null;

function _isActive() {
  return document.getElementById(`view-${VIEW_KEY}`)?.classList.contains('active');
}

function _scheduleRefresh() {
  if (!_isActive()) return;
  clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => {
    if (_isActive()) renderDashboard();
  }, DEBOUNCE_MS);
}

// Subscribe once at module load (not per-render)
on(EVENTS.ENTITY_SAVED,   _scheduleRefresh);
on(EVENTS.ENTITY_DELETED, _scheduleRefresh);

// Context change → immediate re-render
on('context:changed', () => {
  if (_isActive()) renderDashboard();
});

// ── Register view ─────────────────────────────────────────────────────────────

registerView(VIEW_KEY, renderDashboard);
