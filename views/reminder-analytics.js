/**
 * FamilyHub v5.2.0 — views/reminder-analytics.js
 * [MAJOR] Phase 3: Reminder Analytics — shows fire rates, completion, snooze patterns.
 *
 * Data source: reminderLog entities (type='reminderLog') written by reminder.js.
 * Registration: registerView('reminder-analytics', renderReminderAnalytics)
 *
 * Sections:
 *   1. Summary cards (total fired, done%, snoozed%, skipped%)
 *   2. Activity chart (fires per day, last 30 days) — pure DOM/CSS bar chart
 *   3. Top reminders by fire count
 *   4. Snooze heatmap (hour-of-day × day-of-week)
 */

import { registerView }              from '../core/router.js';
import { getEntitiesByType }         from '../core/db.js';

// ── Helpers ────────────────────────────────────────────────────── //

const _esc = (s) => !s ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const _pct = (n, d) => d === 0 ? '0%' : `${Math.round((n / d) * 100)}%`;
const _clr = (pct) => pct >= 70 ? '#22c55e' : pct >= 40 ? `var(--color-warning,#f59e0b)` : '#ef4444';

// Day/hour labels
const DAYS  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const HOURS = Array.from({length:24}, (_, i) => {
  const h = i % 12 || 12; return `${h}${i < 12 ? 'a' : 'p'}`;
});

// ── Main render ─────────────────────────────────────────────────── //

async function renderReminderAnalytics() {
  const el = document.getElementById('view-reminder-analytics');
  if (!el) return;

  el.innerHTML = `<div style="padding:16px;font-size:var(--text-sm);color:var(--color-text-muted);">⏳ Loading analytics…</div>`;

  // Subscribe to reminder events for live refresh (unsub when view navigates away)
  let _refreshSubs = [];
  const _cleanup = () => { _refreshSubs.forEach(fn => { try { fn(); } catch {} }); _refreshSubs = []; };
  try {
    const { on: _on, EVENTS: _EVTS } = await import('../core/events.js');
    [_EVTS.REMINDER_DISMISSED, _EVTS.REMINDER_SNOOZED, _EVTS.REMINDER_CREATED, _EVTS.VIEW_CHANGED].forEach(evt => {
      _refreshSubs.push(_on(evt, () => {
        if (evt === _EVTS.VIEW_CHANGED) { _cleanup(); return; }
        // Debounce refresh by 1s to batch rapid events
        clearTimeout(el._refreshTimer);
        el._refreshTimer = setTimeout(() => renderReminderAnalytics(), 1000);
      }));
    });
  } catch {} // non-fatal if events not available

  // Load all reminderLog entities
  let logs = [];
  try {
    const all = await getEntitiesByType('reminderLog');
    const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
    logs = all.filter(l => !l.deleted && (l.firedAt || l.createdAt || '') >= cutoff);
  } catch (err) {
    _cleanup();
    el.innerHTML = `<div style="padding:32px;text-align:center;color:var(--color-danger);">
      ⚠ Could not load data: ${err.message}<br>
      <span style="font-size:var(--text-xs);color:var(--color-text-muted);">Try navigating away and back, or reload the page.</span>
    </div>`;
    return;
  }

  const total    = logs.length;
  const done     = logs.filter(l => l.outcome === 'done'    || l.outcome === 'dismissed').length;
  const snoozed  = logs.filter(l => l.outcome === 'snoozed').length;
  const skipped  = logs.filter(l => l.outcome === 'skipped').length;
  const fired    = logs.filter(l => l.outcome === 'fired').length;

  // ── Per-reminder stats ──────────────────────────────────────────
  const byReminder = new Map();
  logs.forEach(l => {
    if (!l.reminderId) return;
    const e = byReminder.get(l.reminderId) || {
      id:      l.reminderId,
      title:   l.reminderTitle || l.title?.split(' — fire #')[0] || 'Untitled',
      fired:   0, done: 0, snoozed: 0,
    };
    e.fired++;
    if (l.outcome === 'done' || l.outcome === 'dismissed') e.done++;
    if (l.outcome === 'snoozed') e.snoozed++;
    byReminder.set(l.reminderId, e);
  });
  const topReminders = [...byReminder.values()].sort((a, b) => b.fired - a.fired).slice(0, 10);

  // ── Daily activity (last 30 days) ──────────────────────────────
  const todayMs  = new Date().setHours(0,0,0,0);
  const days30   = Array.from({length:30}, (_, i) => {
    const d = new Date(todayMs - (29 - i) * 86400000);
    const p = n => String(n).padStart(2,'0');
    return { key: `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`, fired: 0, done: 0 };
  });
  const dayMap = new Map(days30.map(d => [d.key, d]));

  logs.forEach(l => {
    if (!l.firedAt) return;
    const k = l.firedAt.slice(0, 10);
    const d = dayMap.get(k);
    if (d) { d.fired++; if (l.outcome === 'done' || l.outcome === 'dismissed') d.done++; }
  });

  const maxFired = Math.max(...days30.map(d => d.fired), 1);

  // ── Snooze heatmap (hour × day-of-week) ───────────────────────
  const heatmap = Array.from({length:7}, () => new Array(24).fill(0));
  logs.filter(l => l.outcome === 'snoozed' && l.firedAt).forEach(l => {
    const d = new Date(l.firedAt);
    if (!isNaN(d.getTime())) heatmap[d.getDay()][d.getHours()]++;
  });
  const maxHeat = Math.max(...heatmap.flat(), 1);

  // ── Render ──────────────────────────────────────────────────────
  el.innerHTML = `
    <div style="max-width:900px;margin:0 auto;padding:var(--space-6) var(--space-4);">
      <div style="display:flex;align-items:center;gap:var(--space-3);margin-bottom:var(--space-6);">
        <h2 style="font-size:var(--text-xl);font-weight:var(--weight-bold);color:var(--color-text);margin:0;flex:1;">
          📊 Reminder Analytics
        </h2>
        <button id="ra-refresh-btn" style="
          padding:6px 14px;font-size:var(--text-xs);font-weight:600;
          background:var(--color-surface);color:var(--color-text-muted);
          border:1px solid var(--color-border);border-radius:var(--radius-md);cursor:pointer;">
          ↻ Refresh
        </button>
        <span style="font-size:var(--text-xs);color:var(--color-text-muted);">Last 90 days</span>
      </div>

      <!-- Summary cards -->
      <div id="ra-summary" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:var(--space-3);margin-bottom:var(--space-6);"></div>

      <!-- Daily activity -->
      <div style="border:1px solid var(--color-border);border-radius:var(--radius-md);padding:var(--space-4);margin-bottom:var(--space-6);">
        <h3 style="font-size:var(--text-sm);font-weight:var(--weight-semibold);color:var(--color-text);margin-bottom:var(--space-4);">Daily Activity — Last 30 Days</h3>
        <div id="ra-chart" style="display:flex;align-items:flex-end;gap:2px;height:80px;"></div>
        <div style="display:flex;justify-content:space-between;margin-top:4px;font-size:10px;color:var(--color-text-muted);">
          <span>${days30[0].key.slice(5)}</span><span>Today</span>
        </div>
      </div>

      <!-- Top reminders -->
      <div style="border:1px solid var(--color-border);border-radius:var(--radius-md);padding:var(--space-4);margin-bottom:var(--space-6);">
        <h3 style="font-size:var(--text-sm);font-weight:var(--weight-semibold);color:var(--color-text);margin-bottom:var(--space-3);">Top Reminders by Fires</h3>
        <div id="ra-top-list"></div>
      </div>

      <!-- Snooze heatmap -->
      <div style="border:1px solid var(--color-border);border-radius:var(--radius-md);padding:var(--space-4);">
        <h3 style="font-size:var(--text-sm);font-weight:var(--weight-semibold);color:var(--color-text);margin-bottom:var(--space-3);">Snooze Patterns (by day &amp; hour)</h3>
        <div id="ra-heatmap" style="overflow-x:auto;"></div>
      </div>
    </div>
  `;

  // ── Fill summary cards ──────────────────────────────────────────
  el.querySelector('#ra-refresh-btn')?.addEventListener('click', () => renderReminderAnalytics());
  const summaryEl = el.querySelector('#ra-summary');
  const _card = (label, value, sub = '', color = 'var(--color-accent)') => {
    const div = document.createElement('div');
    div.style.cssText = `border:1px solid var(--color-border);border-radius:var(--radius-md);padding:var(--space-3);background:var(--color-surface);`;
    div.innerHTML = `
      <div style="font-size:1.5rem;font-weight:var(--weight-bold);color:${color};">${value}</div>
      <div style="font-size:var(--text-xs);font-weight:var(--weight-semibold);color:var(--color-text);margin-top:2px;">${label}</div>
      ${sub ? `<div style="font-size:10px;color:var(--color-text-muted);margin-top:2px;">${sub}</div>` : ''}
    `;
    summaryEl.appendChild(div);
  };

  _card('Total Fires', total, 'across all reminders');
  _card('Completed', _pct(done, total), `${done} dismissed`,
    total === 0 ? 'var(--color-text-muted)' : _clr(Math.round(done/total*100)));
  _card('Snoozed', _pct(snoozed, total), `${snoozed} deferred`,
    total === 0 ? 'var(--color-text-muted)' : `var(--color-warning,#f59e0b)`);
  _card('Skipped', _pct(skipped, total), `${skipped} skipped`, `var(--color-text-muted,#94a3b8)`);
  _card('Tracked Reminders', byReminder.size, 'with at least 1 fire recorded');

  // ── Fill daily chart ───────────────────────────────────────────
  const chartEl = el.querySelector('#ra-chart');
  days30.forEach(d => {
    const col = document.createElement('div');
    col.style.cssText = 'flex:1;display:flex;flex-direction:column;align-items:center;gap:1px;';
    const firedH = d.fired === 0 ? 1 : Math.max(4, Math.round((d.fired / maxFired) * 76));
    const bar = document.createElement('div');
    bar.style.cssText = `height:${firedH}px;width:100%;background:${d.fired === 0 ? 'var(--color-border)' : 'var(--color-accent)'};border-radius:2px 2px 0 0;opacity:${d.fired === 0 ? '0.4' : '0.85'};`;
    bar.title = `${d.key}: ${d.fired} fired, ${d.done} done`;
    col.appendChild(bar);
    chartEl.appendChild(col);
  });

  // ── Fill top reminders ─────────────────────────────────────────
  const topEl = el.querySelector('#ra-top-list');
  if (topReminders.length === 0) {
    topEl.textContent = 'No reminder activity recorded yet.';
    topEl.style.cssText = 'color:var(--color-text-muted);font-size:var(--text-sm);';
  } else {
    topReminders.forEach((r, i) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:var(--space-3);padding:6px 0;border-bottom:1px solid var(--color-border);font-size:var(--text-sm);';
      const donePct = Math.round((r.done / r.fired) * 100);
      row.innerHTML = `
        <span style="color:var(--color-text-muted);min-width:20px;text-align:right;">${i+1}.</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--color-text);">${_esc(r.title)}</span>
        <span style="color:var(--color-text-muted);white-space:nowrap;">${r.fired} fires</span>
        <span style="color:${_clr(donePct)};white-space:nowrap;font-weight:600;">${donePct}% done</span>
      `;
      topEl.appendChild(row);
    });
  }

  // ── Fill snooze heatmap ────────────────────────────────────────
  const hmEl = el.querySelector('#ra-heatmap');
  const table = document.createElement('table');
  table.style.cssText = 'border-collapse:collapse;font-size:9px;color:var(--color-text-muted);';

  // Header row (hours)
  const thead = table.createTHead();
  const hr = thead.insertRow();
  const corner = document.createElement('th');
  corner.style.cssText = 'padding:2px 6px 2px 0;';
  hr.appendChild(corner);
  HOURS.forEach((h, i) => {
    if (i % 3 !== 0) return; // show every 3 hours
    const th = document.createElement('th');
    th.colSpan = 3;
    th.style.cssText = 'padding:2px 0;text-align:center;font-weight:normal;';
    th.textContent = h;
    hr.appendChild(th);
  });

  // Body rows (days)
  const tbody = table.createTBody();
  DAYS.forEach((day, di) => {
    const tr = tbody.insertRow();
    const dayCell = tr.insertCell();
    dayCell.textContent = day;
    dayCell.style.cssText = 'padding:2px 6px 2px 0;white-space:nowrap;';
    heatmap[di].forEach((count, hour) => {
      const td = tr.insertCell();
      const intensity = Math.round((count / maxHeat) * 100);
      const bg = count === 0 ? 'var(--color-surface)' :
                 `rgba(99,102,241,${(intensity / 100 * 0.8 + 0.1).toFixed(2)})`;
      td.style.cssText = `width:14px;height:14px;background:${bg};border-radius:2px;`;
      if (count > 0) td.title = `${day} ${HOURS[hour]}: ${count} snooze(s)`;
    });
    tbody.appendChild(tr);
  });

  hmEl.appendChild(table);

  if (total === 0) {
    el.innerHTML = `
      <div style="max-width:900px;margin:0 auto;padding:var(--space-6) var(--space-4);">
        <h2 style="font-size:var(--text-xl);font-weight:var(--weight-bold);color:var(--color-text);margin-bottom:var(--space-6);">📊 Reminder Analytics</h2>
        <div style="text-align:center;padding:48px;color:var(--color-text-muted);">
          <div style="font-size:2rem;margin-bottom:var(--space-3);">📭</div>
          <div style="font-weight:600;margin-bottom:var(--space-2);">No reminder activity yet</div>
          <div style="font-size:var(--text-sm);">Fire a reminder to start seeing analytics.</div>
        </div>
      </div>`;
    _cleanup();
    return;
  }
}

registerView('reminder-analytics', async (params, env) => {
  try {
    await renderReminderAnalytics(params, env);
  } catch (err) {
    const el = document.getElementById('view-reminder-analytics');
    if (el) {
      el.innerHTML = `<div style="padding:32px;text-align:center;color:var(--color-danger);">
        ⚠ Analytics failed to load: ${err.message}
        <br><button onclick="window.location.reload()" style="margin-top:16px;padding:8px 16px;border:1px solid currentColor;border-radius:8px;background:none;cursor:pointer;color:var(--color-danger);">Reload</button>
      </div>`;
    }
    console.error('[reminder-analytics] Render failed:', err);
  }
});
