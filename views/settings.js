/**
 * FamilyHub v6.0.0 — views/settings.js
 * [v6.0.0] Full typography control in Appearance tab:
 *           font family, size, letter-spacing, line-height, density, accent, mode.
 */

import { registerView } from '../core/router.js';
import { exportAll, importAll, getStorageUsage, getSetting, setSetting } from '../core/db.js';
import { getAccount, getAllAccounts, generateInvite } from '../core/auth.js';
import { startTour } from '../core/tour.js';
import { FONT_OPTIONS } from '../services/theme.js';

// ── Inject CSS once ────────────────────────────────────────────
(function _injectStyles() {
  if (document.getElementById('settings-view-styles')) return;
  const style = document.createElement('style');
  style.id = 'settings-view-styles';
  style.textContent = `
    #view-settings.active { padding: 0; overflow-y: auto; }

    .stab-nav {
      display: flex; gap: 2px; flex-wrap: wrap;
      padding: var(--space-4) var(--space-4) 0;
      border-bottom: 2px solid var(--color-border);
      background: var(--color-bg);
      position: sticky; top: 0; z-index: 10;
    }
    .stab-btn {
      padding: 8px 14px; font-size: var(--text-sm); font-weight: var(--weight-semibold);
      border: none; border-radius: var(--radius-md) var(--radius-md) 0 0;
      cursor: pointer; background: transparent; color: var(--color-text-muted);
      border-bottom: 2px solid transparent; margin-bottom: -2px;
      transition: all 0.15s; white-space: nowrap;
    }
    .stab-btn:hover { color: var(--color-text); background: var(--color-surface); }
    .stab-btn.active {
      color: var(--color-accent); border-bottom-color: var(--color-accent);
      background: var(--color-bg);
    }
    .stab-panel { display: none; padding: var(--space-5) var(--space-4); }
    .stab-panel.active { display: block; }
    #view-settings.active > .stab-panel.active,
    #settings-content > .stab-panel.active { margin: 0; }
    .stab-panels-wrap { width: 100%; max-width: 680px; box-sizing: border-box; padding: 0 var(--space-4); }

    .srow {
      display: grid; grid-template-columns: 1fr auto;
      align-items: start;
      gap: var(--space-3); padding: var(--space-3) 0;
      border-bottom: 1px solid var(--color-border);
    }
    .srow:last-child { border-bottom: none; }
    .srow-label { font-size: var(--text-sm); font-weight: var(--weight-semibold); color: var(--color-text); }
    .srow-hint { font-size: var(--text-xs); color: var(--color-text-muted); margin-top: 2px; max-width: 380px; }
    .srow-ctrl { display: flex; align-items: center; gap: var(--space-2); flex-shrink: 0; justify-content: flex-end; }
  `;
  document.head.appendChild(style);
})();

// ── Helpers ────────────────────────────────────────────────────
function _esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Default context order ──────────────────────────────────────
export const DEFAULT_CONTEXT_ORDER = ['all', 'family', 'personal', 'business'];
export const CONTEXT_LABELS = { all: 'All', family: 'Family', personal: 'Personal', business: 'Business' };
export const CONTEXT_ICONS  = { all: '🌐', family: '🏠', personal: '👤', business: '💼' };

/** Load context order from settings, fall back to default */
export async function getContextOrder() {
  try {
    const saved = await getSetting('contextOrder');
    if (Array.isArray(saved) && saved.length === 4) return saved;
  } catch {}
  return [...DEFAULT_CONTEXT_ORDER];
}

// ── Main Render ────────────────────────────────────────────────
async function renderSettings() {
  const el = document.getElementById('view-settings');
  if (!el) return;

  const account = getAccount();
  const isAdmin = account?.role === 'admin' || account?.role === 'parent';

  // Load all settings in parallel
  const [accounts, storageInfo, taskViewPrefs, taskDefaultTimeBlock, quietHours, contextOrder,
         recurrencePreviewDays, recurrenceKeepDays, recurrenceCelebrations] = await Promise.all([
    getAllAccounts().catch(() => []),
    getStorageUsage().catch(() => ({ used: 0, quota: 0 })),
    getSetting('taskViewPreferences').catch(() => ({})),
    getSetting('taskDefaultTimeBlock').catch(() => 1800),
    getSetting('reminderQuietHours').catch(() => ({ enabled: false, start: '22:00', end: '07:00' })),
    getContextOrder(),
    getSetting('recurrencePreviewDays').catch(() => 7),    // [v5.3.1]
    getSetting('recurrenceKeepDays').catch(() => 30),      // [v5.3.1]
    getSetting('recurrenceCelebrations').catch(() => true), // [v5.3.1]
  ]);

  const usedMB = ((storageInfo?.used || 0) / (1024 * 1024)).toFixed(2);
  const tvp = taskViewPrefs || {};
  const dtb = taskDefaultTimeBlock ?? 1800;
  const qh  = quietHours || { enabled: false, start: '22:00', end: '07:00' };
  let pushGranted = false;
  try { pushGranted = Notification?.permission === 'granted'; } catch {}

  // Detect current theme + full typography prefs
  const env = window._fhEnv;
  let themePrefs = { mode: 'auto', density: 'comfortable', fontSize: 1.0,
                     fontFamily: 'plus-jakarta-sans', letterSpacing: 'normal', lineHeight: 'normal',
                     accent: '#3B82F6' };
  try { themePrefs = { ...themePrefs, ...(env?.services?.theme?.getPrefs?.() || {}) }; } catch {}
  const currentMode = themePrefs.mode;

  // ── Tab definitions ─────────────────────────────────────────
  const TABS = [
    { key: 'appearance',     icon: '🎨', label: 'Appearance' },
    { key: 'account',        icon: '👤', label: 'Account' },
    { key: 'contexts',       icon: '🌐', label: 'Contexts' },
    { key: 'tasks',          icon: '✅', label: 'Tasks' },
    { key: 'notifications',  icon: '🔔', label: 'Notifications' },
    { key: 'family',         icon: '👨‍👩‍👧‍👦', label: 'Family', adminOnly: true },
    { key: 'data',           icon: '💾', label: 'Data' },
    { key: 'about',          icon: 'ℹ️', label: 'About' },
  ];

  // Build the saved active tab (default: appearance)
  // Guard: non-admin users can't access the family tab
  let savedTab = sessionStorage.getItem('fh:settings:tab') || 'appearance';
  if (savedTab === 'family' && !isAdmin) savedTab = 'appearance';
  // Guard: ensure the tab key is valid
  if (!TABS.filter(t => !t.adminOnly || isAdmin).some(t => t.key === savedTab)) savedTab = 'appearance';

  // ── Render shell ─────────────────────────────────────────────
  el.innerHTML = `
    <nav class="stab-nav" id="settings-tab-nav">
      ${TABS.filter(t => !t.adminOnly || isAdmin).map(t => `
        <button class="stab-btn${t.key === savedTab ? ' active' : ''}" data-stab="${t.key}">
          ${t.icon} ${t.label}
        </button>
      `).join('')}
    </nav>

    <!-- ─────────── APPEARANCE ─────────────────────────────── -->
    <div class="stab-panel${savedTab === 'appearance' ? ' active' : ''}" id="stab-appearance">

      <!-- Theme mode -->
      <div class="srow">
        <div>
          <div class="srow-label">Color Mode</div>
          <div class="srow-hint">Light, dark, or follow system setting</div>
        </div>
        <div class="srow-ctrl" style="gap:6px;">
          <button id="settings-theme-light" class="btn btn-sm" style="font-weight:600;
            background:${currentMode === 'light' ? 'var(--color-accent)' : 'var(--color-surface)'};
            color:${currentMode === 'light' ? '#fff' : 'var(--color-text)'};">☀️ Light</button>
          <button id="settings-theme-dark" class="btn btn-sm" style="font-weight:600;
            background:${currentMode === 'dark' ? 'var(--color-accent)' : 'var(--color-surface)'};
            color:${currentMode === 'dark' ? '#fff' : 'var(--color-text)'};">🌙 Dark</button>
          <button id="settings-theme-auto" class="btn btn-sm" style="font-weight:600;
            background:${currentMode === 'auto' ? 'var(--color-accent)' : 'var(--color-surface)'};
            color:${currentMode === 'auto' ? '#fff' : 'var(--color-text)'};">⚙️ Auto</button>
        </div>
      </div>

      <!-- Accent colour -->
      <div class="srow">
        <div>
          <div class="srow-label">Accent Color</div>
          <div class="srow-hint">Primary color used for buttons, links and highlights</div>
        </div>
        <div class="srow-ctrl" style="gap:8px;align-items:center;">
          <div id="accent-swatches" style="display:flex;gap:6px;flex-wrap:wrap;">
            ${['#3B82F6','#6366F1','#8B5CF6','#EC4899','#10B981','#F59E0B','#EF4444','#0EA5E9','#14B8A6','#F97316'].map(c => `
              <button class="accent-swatch" data-accent="${c}" title="${c}" style="
                width:22px;height:22px;border-radius:50%;background:${c};border:none;cursor:pointer;
                box-shadow: ${themePrefs.accent === c ? '0 0 0 3px var(--color-bg), 0 0 0 5px ' + c : 'none'};
                transition: box-shadow 0.15s;
              "></button>
            `).join('')}
          </div>
          <input id="settings-accent-custom" type="color" value="${themePrefs.accent || '#3B82F6'}"
            title="Custom accent color"
            style="width:28px;height:28px;border:none;border-radius:6px;padding:0;cursor:pointer;background:none;">
        </div>
      </div>

      <!-- Density -->
      <div class="srow">
        <div>
          <div class="srow-label">Density</div>
          <div class="srow-hint">Controls spacing throughout the interface</div>
        </div>
        <div class="srow-ctrl" style="gap:6px;">
          ${['compact','comfortable','spacious'].map(d => `
            <button class="btn btn-sm density-btn" data-density="${d}" style="font-weight:600;
              background:${themePrefs.density === d ? 'var(--color-accent)' : 'var(--color-surface)'};
              color:${themePrefs.density === d ? '#fff' : 'var(--color-text)'};">
              ${d === 'compact' ? '▪ Compact' : d === 'comfortable' ? '▫ Default' : '□ Spacious'}
            </button>
          `).join('')}
        </div>
      </div>

      <!-- Section divider -->
      <div style="margin:var(--space-4) 0 var(--space-2);padding-bottom:var(--space-2);
        border-bottom:2px solid var(--color-border);">
        <div style="font-size:var(--text-xs);font-weight:700;letter-spacing:0.08em;
          text-transform:uppercase;color:var(--color-text-muted);">Typography</div>
      </div>

      <!-- Font family -->
      <div class="srow" style="align-items:start;">
        <div>
          <div class="srow-label">Font Family</div>
          <div class="srow-hint">System-wide typeface. Plus Jakarta Sans is self-hosted and works offline.</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;min-width:0;">
          ${FONT_OPTIONS.map(f => `
            <button class="font-family-btn" data-font="${f.key}" style="
              display:flex;align-items:center;gap:10px;
              padding:9px 14px;border-radius:var(--radius-md);
              border:2px solid ${themePrefs.fontFamily === f.key ? 'var(--color-accent)' : 'var(--color-border)'};
              background:${themePrefs.fontFamily === f.key ? 'var(--color-accent-muted)' : 'var(--color-surface)'};
              cursor:pointer;text-align:left;width:100%;transition:all 0.15s;min-width:220px;
            ">
              <span style="font-family:${f.stack};font-size:1.1rem;font-weight:600;color:var(--color-text);line-height:1;">Aa</span>
              <span style="display:flex;flex-direction:column;gap:1px;">
                <span style="font-size:var(--text-sm);font-weight:600;color:var(--color-text);font-family:${f.stack};">${f.label}</span>
                <span style="font-size:var(--text-xs);color:var(--color-text-muted);">${f.tag}${f.googleUrl ? ' · requires network' : ' · offline-ready'}</span>
              </span>
              ${themePrefs.fontFamily === f.key ? '<span style="margin-left:auto;color:var(--color-accent);font-size:1rem;">✓</span>' : ''}
            </button>
          `).join('')}
        </div>
      </div>

      <!-- Font size -->
      <div class="srow">
        <div>
          <div class="srow-label">Font Size</div>
          <div class="srow-hint">Scale text across the entire app (80 – 130%)</div>
        </div>
        <div class="srow-ctrl" style="gap:10px;flex-direction:column;align-items:flex-end;">
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="font-size:var(--text-xs);color:var(--color-text-muted);">A</span>
            <input type="range" id="settings-font-size" min="80" max="130" step="5"
              value="${Math.round((themePrefs.fontSize || 1.0) * 100)}"
              style="width:140px;cursor:pointer;">
            <span style="font-size:var(--text-lg);font-weight:600;color:var(--color-text-muted);">A</span>
          </div>
          <div style="font-size:var(--text-xs);color:var(--color-text-muted);">
            Current: <strong id="font-size-display">${Math.round((themePrefs.fontSize || 1.0) * 100)}%</strong>
          </div>
          <!-- Live preview -->
          <div id="font-preview" style="
            padding:10px 14px;border-radius:var(--radius-md);
            background:var(--color-surface);border:1px solid var(--color-border);
            width:100%;box-sizing:border-box;margin-top:4px;
          ">
            <div style="font-size:var(--text-xl);font-weight:700;letter-spacing:-0.03em;color:var(--color-text);">FamilyHub</div>
            <div style="font-size:var(--text-sm);color:var(--color-text-muted);">Tasks · Calendar · Budget · Recipes</div>
          </div>
        </div>
      </div>

      <!-- Letter spacing -->
      <div class="srow">
        <div>
          <div class="srow-label">Letter Spacing</div>
          <div class="srow-hint">Controls character spacing across headings and body text</div>
        </div>
        <div class="srow-ctrl" style="gap:6px;">
          ${[['tight','Tight'],['normal','Default'],['wide','Wide']].map(([k,l]) => `
            <button class="btn btn-sm letter-spacing-btn" data-ls="${k}" style="font-weight:600;
              background:${themePrefs.letterSpacing === k ? 'var(--color-accent)' : 'var(--color-surface)'};
              color:${themePrefs.letterSpacing === k ? '#fff' : 'var(--color-text)'};">
              ${l}
            </button>
          `).join('')}
        </div>
      </div>

      <!-- Line height -->
      <div class="srow">
        <div>
          <div class="srow-label">Line Height</div>
          <div class="srow-hint">Controls vertical spacing between lines of text</div>
        </div>
        <div class="srow-ctrl" style="gap:6px;">
          ${[['compact','Compact'],['normal','Default'],['relaxed','Relaxed']].map(([k,l]) => `
            <button class="btn btn-sm line-height-btn" data-lh="${k}" style="font-weight:600;
              background:${themePrefs.lineHeight === k ? 'var(--color-accent)' : 'var(--color-surface)'};
              color:${themePrefs.lineHeight === k ? '#fff' : 'var(--color-text)'};">
              ${l}
            </button>
          `).join('')}
        </div>
      </div>

      <!-- Reset typography -->
      <div style="padding:var(--space-3) 0;">
        <button id="settings-typography-reset" class="btn btn-sm" style="color:var(--color-danger);">
          ↺ Reset typography to defaults
        </button>
      </div>

    </div>

    <!-- ─────────── ACCOUNT ───────────────────────────────── -->
    <div class="stab-panel${savedTab === 'account' ? ' active' : ''}" id="stab-account">
      <div style="display:flex;flex-direction:column;gap:var(--space-2);margin-bottom:var(--space-4);">
        <div class="srow-label">Username: <span style="font-weight:400;">${_esc(account?.username || 'Unknown')}</span></div>
        <div class="srow-label">Role:
          <span style="padding:2px 8px;border-radius:99px;font-size:var(--text-xs);font-weight:600;
            background:${account?.role === 'admin' ? 'var(--color-accent)' : 'var(--color-surface)'};
            color:${account?.role === 'admin' ? '#fff' : 'var(--color-text)'};
            border:1px solid var(--color-border);">
            ${_esc(account?.role || 'member')}
          </span>
        </div>
        <div style="font-size:var(--text-xs);color:var(--color-text-muted);">ID: <code>${_esc(account?.id || '')}</code></div>
      </div>
      <div style="display:flex;flex-direction:column;gap:var(--space-2);">
        <div class="srow-label" style="text-transform:uppercase;font-size:var(--text-xs);letter-spacing:.05em;color:var(--color-text-muted);">Update Profile</div>
        <input id="settings-display-name" type="text" class="input" placeholder="Display name" value="${_esc(account?.username || '')}" style="font-size:var(--text-sm);">
        <input id="settings-email" type="email" class="input" placeholder="Email (optional)" value="${_esc(account?.email || '')}" style="font-size:var(--text-sm);">
        <div class="srow-label" style="text-transform:uppercase;font-size:var(--text-xs);letter-spacing:.05em;color:var(--color-text-muted);margin-top:var(--space-2);">Change Password</div>
        <input id="settings-current-pass" type="password" class="input" placeholder="Current password" style="font-size:var(--text-sm);" autocomplete="current-password">
        <input id="settings-new-pass" type="password" class="input" placeholder="New password (min 8 chars)" style="font-size:var(--text-sm);" autocomplete="new-password">
        <div style="display:flex;gap:var(--space-2);align-items:center;">
          <button id="settings-account-save" class="btn btn-primary">Save Changes</button>
          <span id="settings-account-status" style="font-size:var(--text-xs);display:none;"></span>
        </div>
      </div>
    </div>

    <!-- ─────────── CONTEXTS ──────────────────────────────── -->
    <div class="stab-panel${savedTab === 'contexts' ? ' active' : ''}" id="stab-contexts">
      <div class="srow-hint" style="margin-bottom:var(--space-4);">
        Set the order that contexts appear everywhere — sidebar switcher, field dropdowns, and filter chips.
        Use the ↑ ↓ buttons to reorder. Save to apply globally.
      </div>
      <div id="ctx-order-list" style="display:flex;flex-direction:column;gap:var(--space-2);margin-bottom:var(--space-4);">
        ${contextOrder.map((ctx, i) => `
          <div class="ctx-order-row" data-ctx="${ctx}" style="
            display:flex;align-items:center;gap:var(--space-3);
            padding:10px 14px;background:var(--color-surface);
            border:1px solid var(--color-border);border-radius:var(--radius-md);
            user-select:none;
          ">
            <span style="font-size:1.1rem;color:var(--color-text-muted);">${i + 1}.</span>
            <span style="font-size:1.1rem;">${CONTEXT_ICONS[ctx]}</span>
            <span style="font-size:var(--text-sm);font-weight:600;flex:1;">${CONTEXT_LABELS[ctx]}</span>
            <div style="display:flex;gap:4px;">
              <button class="ctx-up btn btn-sm" data-idx="${i}" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
              <button class="ctx-dn btn btn-sm" data-idx="${i}" title="Move down" ${i === contextOrder.length - 1 ? 'disabled' : ''}>↓</button>
            </div>
          </div>
        `).join('')}
      </div>
      <div style="display:flex;gap:var(--space-2);align-items:center;">
        <button id="ctx-order-save" class="btn btn-primary">💾 Save Order</button>
        <button id="ctx-order-reset" class="btn btn-sm">Reset to Default</button>
        <span id="ctx-order-status" style="font-size:var(--text-xs);display:none;"></span>
      </div>
    </div>

    <!-- ─────────── TASKS ─────────────────────────────────── -->
    <div class="stab-panel${savedTab === 'tasks' ? ' active' : ''}" id="stab-tasks">

      <div style="font-size:var(--text-sm);font-weight:700;color:var(--color-text);margin-bottom:var(--space-3);">Default View per Tab</div>
      <div style="font-size:var(--text-xs);color:var(--color-text-muted);margin-bottom:var(--space-3);">Choose your default view mode for each task category:</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:var(--space-3);margin-bottom:var(--space-5);">
        ${[
          { id: 'inbox',      label: '📥 Inbox' },
          { id: 'today',      label: '☀️ Today' },
          { id: 'scheduled',  label: '📅 Scheduled' },
          { id: 'noprojects', label: '📌 No Projects' },
          { id: 'open',       label: '○ Open' },
          { id: 'completed',  label: '✅ Completed' },
          { id: 'all',        label: '📚 All' },
        ].map(t => `
          <div>
            <label style="font-size:var(--text-sm);font-weight:600;color:var(--color-text);display:block;margin-bottom:4px;">${t.label}</label>
            <select id="pref-${t.id}" data-tab="${t.id}" style="width:100%;padding:6px;border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-surface);color:var(--color-text);font-size:var(--text-sm);">
              <option value="list"   ${tvp[t.id] === 'list'   ? 'selected' : ''}>List</option>
              <option value="kanban" ${tvp[t.id] === 'kanban' ? 'selected' : ''}>Kanban</option>
              <option value="table"  ${tvp[t.id] === 'table'  ? 'selected' : ''}>Table</option>
            </select>
          </div>
        `).join('')}
      </div>

      <div style="border-top:1px solid var(--color-border);padding-top:var(--space-4);">
        <div style="font-size:var(--text-sm);font-weight:700;color:var(--color-text);margin-bottom:var(--space-2);">Default Time Block</div>
        <div style="font-size:var(--text-xs);color:var(--color-text-muted);margin-bottom:var(--space-3);">
          Default duration preset in the Activity tab timer for <strong>new</strong> tasks. Existing tasks are not affected.
        </div>
        <div style="display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap;">
          <select id="settings-default-time-block" style="padding:6px 10px;border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-bg);color:var(--color-text);font-size:var(--text-sm);">
            ${[
              [300,'5 min'],[600,'10 min'],[900,'15 min'],[1500,'25 min (Pomodoro)'],
              [1800,'30 min (default)'],[2700,'45 min'],[3600,'1 hr'],[5400,'1.5 hr'],
              [7200,'2 hr'],[10800,'3 hr'],[14400,'4 hr'],
            ].map(([v,l]) => `<option value="${v}" ${dtb == v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
          <button id="settings-time-block-save" class="btn btn-primary">Save</button>
          <span id="settings-time-block-status" style="font-size:var(--text-xs);display:none;"></span>
        </div>
      </div>

      <div style="border-top:1px solid var(--color-border);padding-top:var(--space-4);">
        <div style="font-size:var(--text-sm);font-weight:700;color:var(--color-text);margin-bottom:var(--space-2);">🔗 Completion Follow-up</div>
        <div style="font-size:var(--text-xs);color:var(--color-text-muted);margin-bottom:var(--space-3);">
          When completing a task or event, prompt to create a connected follow-up task or event.
          Pre-fills project, priority, time block, assignees and tags from the completed item.
        </div>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:var(--text-sm);">
          <input type="checkbox" id="settings-followup-toggle"
            style="width:16px;height:16px;accent-color:var(--color-accent);" />
          <span>Ask to create a follow-up after completing a task or event</span>
        </label>
        <span id="settings-followup-status" style="font-size:var(--text-xs);display:none;margin-left:24px;"></span>
      </div>

      <div style="border-top:1px solid var(--color-border);padding-top:var(--space-4);">
        <div style="font-size:var(--text-sm);font-weight:700;color:var(--color-text);margin-bottom:var(--space-1);">🔁 Recurring Tasks</div>
        <div style="font-size:var(--text-xs);color:var(--color-text-muted);margin-bottom:var(--space-3);">
          Controls how the recurring task scheduler pre-generates occurrences and retains history.
        </div>
        <div style="display:flex;flex-direction:column;gap:var(--space-3);">

          <div style="display:flex;align-items:flex-start;gap:var(--space-3);flex-wrap:wrap;">
            <div style="min-width:160px;">
              <label for="settings-recurrence-preview" style="font-size:var(--text-sm);font-weight:500;">Preview days ahead</label>
              <div style="font-size:var(--text-xs);color:var(--color-text-muted);margin-top:2px;">How far ahead to pre-generate task occurrences. Increase if you plan tasks further out.</div>
            </div>
            <select id="settings-recurrence-preview" style="padding:6px 10px;border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-bg);color:var(--color-text);font-size:var(--text-sm);">
              ${[1,3,7,14,30].map(d => `<option value="${d}" ${(recurrencePreviewDays??7)==d?'selected':''}>${d} day${d===1?'':'s'}</option>`).join('')}
            </select>
          </div>

          <div style="display:flex;align-items:flex-start;gap:var(--space-3);flex-wrap:wrap;">
            <div style="min-width:160px;">
              <label for="settings-recurrence-keep" style="font-size:var(--text-sm);font-weight:500;">Keep history days</label>
              <div style="font-size:var(--text-xs);color:var(--color-text-muted);margin-top:2px;">How long to keep uncompleted past occurrences before auto-deleting them.</div>
            </div>
            <select id="settings-recurrence-keep" style="padding:6px 10px;border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-bg);color:var(--color-text);font-size:var(--text-sm);">
              ${[7,14,30,60,90].map(d => `<option value="${d}" ${(recurrenceKeepDays??30)==d?'selected':''}>${d} day${d===1?'':'s'}</option>`).join('')}
            </select>
          </div>

          <div style="display:flex;align-items:center;gap:var(--space-3);">
            <label style="display:flex;align-items:center;gap:var(--space-2);font-size:var(--text-sm);cursor:pointer;">
              <input type="checkbox" id="settings-recurrence-celebrations" ${recurrenceCelebrations!==false?'checked':''} style="width:16px;height:16px;accent-color:var(--color-accent);" />
              Show milestone celebrations (streaks &amp; completions)
            </label>
          </div>

          <div style="display:flex;gap:var(--space-2);align-items:center;">
            <button id="settings-recurrence-save" class="btn btn-primary">Save</button>
            <span id="settings-recurrence-status" style="font-size:var(--text-xs);display:none;"></span>
          </div>
        </div>
      </div>
    </div>

    <!-- ─────────── NOTIFICATIONS ─────────────────────────── -->
    <div class="stab-panel${savedTab === 'notifications' ? ' active' : ''}" id="stab-notifications">
      <div class="srow">
        <div>
          <div class="srow-label">Push Notifications</div>
          <div class="srow-hint">Required for reminders when app is in background</div>
        </div>
        <div class="srow-ctrl">
          <span id="settings-push-status" style="font-size:var(--text-xs);padding:3px 10px;border-radius:99px;
            ${pushGranted ? 'background:#dcfce7;color:#15803d;' : 'background:#fee2e2;color:#dc2626;'}">
            ${pushGranted ? '✓ Granted' : '✗ Not granted'}
          </span>
          ${!pushGranted ? `<button id="settings-push-btn" class="btn btn-sm" style="border-color:var(--color-accent);color:var(--color-accent);">Enable</button>` : ''}
        </div>
      </div>

      <div class="srow">
        <div>
          <div class="srow-label">Audio Alert Tone</div>
          <div class="srow-hint">Played when a reminder fires (audio channel must be enabled)</div>
        </div>
        <div class="srow-ctrl">
          <select id="settings-audio-tone" style="padding:5px 8px;border:1px solid var(--color-border);border-radius:var(--radius-md);font-size:var(--text-sm);background:var(--color-bg);color:var(--color-text);">
            <option value="chime">🔔 Chime</option>
            <option value="bell">🔔 Bell</option>
            <option value="ping">📍 Ping</option>
            <option value="gentle">🌊 Gentle</option>
            <option value="alarm">🚨 Alarm</option>
          </select>
          <button id="settings-audio-test" class="btn btn-sm">▶ Test</button>
        </div>
      </div>

      <div class="srow" style="flex-direction:column;align-items:stretch;gap:var(--space-3);">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <div>
            <div class="srow-label">Quiet Hours</div>
            <div class="srow-hint">No reminders will fire during this window</div>
          </div>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
            <input id="settings-quiet-enabled" type="checkbox" ${qh.enabled ? 'checked' : ''}
              style="width:16px;height:16px;accent-color:var(--color-accent);" />
            <span style="font-size:var(--text-sm);">Enable</span>
          </label>
        </div>
        <div id="settings-quiet-times" style="display:${qh.enabled ? 'flex' : 'none'};align-items:center;gap:12px;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:6px;">
            <label style="font-size:var(--text-xs);color:var(--color-text-muted);">From</label>
            <input id="settings-quiet-start" type="time" value="${qh.start || '22:00'}"
              style="padding:4px 8px;border:1px solid var(--color-border);border-radius:var(--radius-md);font-size:var(--text-sm);background:var(--color-bg);color:var(--color-text);" />
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <label style="font-size:var(--text-xs);color:var(--color-text-muted);">To</label>
            <input id="settings-quiet-end" type="time" value="${qh.end || '07:00'}"
              style="padding:4px 8px;border:1px solid var(--color-border);border-radius:var(--radius-md);font-size:var(--text-sm);background:var(--color-bg);color:var(--color-text);" />
          </div>
          <button id="settings-quiet-save" class="btn btn-primary btn-sm">Save</button>
          <span id="settings-quiet-status" style="font-size:var(--text-xs);display:none;"></span>
        </div>
      </div>
    </div>

    <!-- ─────────── FAMILY (admin only) ───────────────────── -->
    ${isAdmin ? `
    <div class="stab-panel${savedTab === 'family' ? ' active' : ''}" id="stab-family">
      <div style="font-size:var(--text-sm);font-weight:700;margin-bottom:var(--space-3);">Members</div>
      <div style="display:flex;flex-direction:column;gap:var(--space-2);margin-bottom:var(--space-5);">
        ${(accounts || []).map(a => `
          <div style="display:flex;align-items:center;gap:var(--space-3);padding:var(--space-2) var(--space-3);background:var(--color-surface);border-radius:var(--radius-md);border:1px solid var(--color-border);">
            <div style="width:32px;height:32px;border-radius:50%;background:var(--color-accent);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:var(--text-sm);">
              ${_esc((a.username || '?')[0].toUpperCase())}
            </div>
            <div style="flex:1;">
              <div style="font-size:var(--text-sm);font-weight:600;">${_esc(a.username)}</div>
              <div style="font-size:var(--text-xs);color:var(--color-text-muted);">${_esc(a.role || 'member')}</div>
            </div>
          </div>
        `).join('')}
        ${!accounts?.length ? '<div style="font-size:var(--text-sm);color:var(--color-text-muted);">No accounts found.</div>' : ''}
      </div>

      <div style="border-top:1px solid var(--color-border);padding-top:var(--space-4);">
        <div style="font-size:var(--text-sm);font-weight:700;margin-bottom:var(--space-3);">Invite Family Member 🔗</div>
        <div style="display:flex;gap:var(--space-2);margin-bottom:var(--space-3);">
          <select id="settings-invite-role" style="padding:6px 10px;font-size:var(--text-sm);border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-bg);color:var(--color-text);">
            <option value="member">Member</option>
            <option value="parent">Parent</option>
          </select>
          <button id="settings-invite-btn" class="btn btn-primary">Generate Invite</button>
        </div>
        <div id="settings-invite-result" style="display:none;padding:var(--space-3);background:var(--color-surface);border:1px dashed var(--color-border);border-radius:var(--radius-md);font-family:monospace;font-size:var(--text-sm);word-break:break-all;"></div>
      </div>
    </div>
    ` : ''}

    <!-- ─────────── DATA ───────────────────────────────────── -->
    <div class="stab-panel${savedTab === 'data' ? ' active' : ''}" id="stab-data">
      <div class="srow">
        <div>
          <div class="srow-label">Storage Used</div>
          <div class="srow-hint">${usedMB} MB${storageInfo?.quota ? ` of ${((storageInfo.quota || 0) / (1024 * 1024)).toFixed(0)} MB quota` : ''}</div>
        </div>
      </div>
      <div class="srow">
        <div>
          <div class="srow-label">Export Data</div>
          <div class="srow-hint">Download all your data as a JSON backup file</div>
        </div>
        <div class="srow-ctrl">
          <button id="settings-export-btn" class="btn btn-sm">📥 Export</button>
        </div>
      </div>
      <div class="srow">
        <div>
          <div class="srow-label">Import Data</div>
          <div class="srow-hint">Merge a previously exported JSON file</div>
        </div>
        <div class="srow-ctrl">
          <label id="settings-import-label" class="btn btn-sm" style="cursor:pointer;">
            📤 Import
            <input type="file" id="settings-import-file" accept=".json" style="display:none;" />
          </label>
        </div>
      </div>
      <div id="settings-data-status" style="font-size:var(--text-xs);color:var(--color-text-muted);margin-top:var(--space-2);display:none;"></div>
    </div>

    <!-- ─────────── ABOUT ──────────────────────────────────── -->
    <div class="stab-panel${savedTab === 'about' ? ' active' : ''}" id="stab-about">
      <div class="srow">
        <div>
          <div class="srow-label">Version</div>
          <div class="srow-hint">FamilyHub v6.6.3 — Multi-context family management PWA</div>
        </div>
      </div>
      <div class="srow">
        <div>
          <div class="srow-label">Onboarding Tour</div>
          <div class="srow-hint">Replay the guided walkthrough</div>
        </div>
        <div class="srow-ctrl">
          <button id="settings-tour-btn" class="btn btn-sm">🎓 Restart Tour</button>
        </div>
      </div>
    </div>
  `;

  // ── Tab switching ──────────────────────────────────────────
  el.querySelectorAll('.stab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.stab;
      sessionStorage.setItem('fh:settings:tab', key);
      el.querySelectorAll('.stab-btn').forEach(b => b.classList.toggle('active', b === btn));
      el.querySelectorAll('.stab-panel').forEach(p => p.classList.toggle('active', p.id === `stab-${key}`));
    });
  });

  // ── Theme + Typography wiring ─────────────────────────────
  const _applyThemePatch = async (patch) => {
    if (env?.services?.theme) {
      await env.services.theme.setTheme(patch);
    } else {
      // Fallback when theme service not ready
      if (patch.mode) {
        const html = document.documentElement;
        html.setAttribute('data-theme', patch.mode === 'auto'
          ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
          : patch.mode);
        try { localStorage.setItem('settings:theme', JSON.stringify({ mode: patch.mode })); } catch {}
      }
    }
    renderSettings();
  };

  // Color mode
  el.querySelector('#settings-theme-light')?.addEventListener('click', () => _applyThemePatch({ mode: 'light' }));
  el.querySelector('#settings-theme-dark')?.addEventListener('click',  () => _applyThemePatch({ mode: 'dark' }));
  el.querySelector('#settings-theme-auto')?.addEventListener('click',  () => _applyThemePatch({ mode: 'auto' }));

  // Accent colour swatches
  el.querySelectorAll('.accent-swatch').forEach(btn => {
    btn.addEventListener('click', () => _applyThemePatch({ accent: btn.dataset.accent }));
  });
  // Accent custom picker: live-preview via CSS var on 'input' (no re-render — avoids
  // hundreds of re-renders while dragging). Persist + re-render only on 'change'.
  el.querySelector('#settings-accent-custom')?.addEventListener('input', (e) => {
    const hex = e.target.value;
    document.documentElement.style.setProperty('--color-accent', hex);
    // Derive muted (12% opacity) inline for live feedback
    document.documentElement.style.setProperty('--color-accent-muted',
      hex + '1f'); // appended alpha for hex8 fallback — theme.js will set proper rgba on change
  });
  el.querySelector('#settings-accent-custom')?.addEventListener('change', (e) => {
    _applyThemePatch({ accent: e.target.value });
  });

  // Density
  el.querySelectorAll('.density-btn').forEach(btn => {
    btn.addEventListener('click', () => _applyThemePatch({ density: btn.dataset.density }));
  });

  // Font family
  el.querySelectorAll('.font-family-btn').forEach(btn => {
    btn.addEventListener('click', () => _applyThemePatch({ fontFamily: btn.dataset.font }));
  });

  // Font size slider — live preview without full re-render
  const fontSizeSlider = el.querySelector('#settings-font-size');
  const fontSizeDisplay = el.querySelector('#font-size-display');
  if (fontSizeSlider) {
    fontSizeSlider.addEventListener('input', () => {
      const pct = parseInt(fontSizeSlider.value, 10);
      if (fontSizeDisplay) fontSizeDisplay.textContent = pct + '%';
      // Live preview — update font-size-scale immediately without re-render
      document.documentElement.style.setProperty('--font-size-scale', String(pct / 100));
      document.documentElement.style.fontSize = `calc(16px * ${pct / 100})`;
    });
    fontSizeSlider.addEventListener('change', () => {
      const pct = parseInt(fontSizeSlider.value, 10);
      _applyThemePatch({ fontSize: pct / 100 });
    });
  }

  // Letter spacing
  el.querySelectorAll('.letter-spacing-btn').forEach(btn => {
    btn.addEventListener('click', () => _applyThemePatch({ letterSpacing: btn.dataset.ls }));
  });

  // Line height
  el.querySelectorAll('.line-height-btn').forEach(btn => {
    btn.addEventListener('click', () => _applyThemePatch({ lineHeight: btn.dataset.lh }));
  });

  // Reset typography
  el.querySelector('#settings-typography-reset')?.addEventListener('click', async () => {
    await _applyThemePatch({
      fontFamily: 'plus-jakarta-sans', fontSize: 1.0,
      letterSpacing: 'normal', lineHeight: 'normal', density: 'comfortable',
    });
  });

  // ── Account ────────────────────────────────────────────────
  (async () => {
    if (account?.memberId) {
      try {
        const { getEntity } = await import('../core/db.js');
        const person = await getEntity(account.memberId);
        const displayInput = el.querySelector('#settings-display-name');
        if (displayInput && person) displayInput.value = person.name || person.title || '';
      } catch {}
    }
  })();

  el.querySelector('#settings-account-save')?.addEventListener('click', async () => {
    const { updateAccount } = await import('../core/auth.js');
    const displayName = el.querySelector('#settings-display-name')?.value.trim() || '';
    const email       = el.querySelector('#settings-email')?.value.trim() || '';
    const currentPass = el.querySelector('#settings-current-pass')?.value || '';
    const newPass     = el.querySelector('#settings-new-pass')?.value || '';
    const statusEl    = el.querySelector('#settings-account-status');
    const saveBtn     = el.querySelector('#settings-account-save');
    if (statusEl) statusEl.style.display = 'none';
    if (saveBtn)  { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    const changes = {};
    if (displayName) changes.displayName     = displayName;
    if (email)       changes.email           = email;
    if (newPass)     changes.newPassword     = newPass;
    if (currentPass) changes.currentPassword = currentPass;
    if (!Object.keys(changes).length) {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Changes'; }
      return;
    }
    const result = await updateAccount(changes).catch(err => ({ ok: false, error: err.message }));
    if (statusEl) {
      statusEl.style.display = 'inline';
      statusEl.textContent   = result.ok ? '✅ Updated.' : `❌ ${result.error}`;
      statusEl.style.color   = result.ok ? 'var(--color-accent)' : 'var(--color-danger)';
    }
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Changes'; }
    if (result.ok) {
      el.querySelector('#settings-current-pass') && (el.querySelector('#settings-current-pass').value = '');
      el.querySelector('#settings-new-pass') && (el.querySelector('#settings-new-pass').value = '');
    }
  });

  // ── Context Order ─────────────────────────────────────────
  {
    let _ctxOrder = [...contextOrder];

    const _renderCtxList = () => {
      const list = el.querySelector('#ctx-order-list');
      if (!list) return;
      list.innerHTML = _ctxOrder.map((ctx, i) => `
        <div class="ctx-order-row" data-ctx="${ctx}" style="
          display:flex;align-items:center;gap:var(--space-3);
          padding:10px 14px;background:var(--color-surface);
          border:1px solid var(--color-border);border-radius:var(--radius-md);
          user-select:none;
        ">
          <span style="font-size:1.1rem;color:var(--color-text-muted);">${i + 1}.</span>
          <span style="font-size:1.1rem;">${CONTEXT_ICONS[ctx]}</span>
          <span style="font-size:var(--text-sm);font-weight:600;flex:1;">${CONTEXT_LABELS[ctx]}</span>
          <div style="display:flex;gap:4px;">
            <button class="ctx-up btn btn-sm" data-idx="${i}" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="ctx-dn btn btn-sm" data-idx="${i}" title="Move down" ${i === _ctxOrder.length - 1 ? 'disabled' : ''}>↓</button>
          </div>
        </div>
      `).join('');

      list.querySelectorAll('.ctx-up').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.idx);
          if (idx > 0) { [_ctxOrder[idx-1], _ctxOrder[idx]] = [_ctxOrder[idx], _ctxOrder[idx-1]]; _renderCtxList(); }
        });
      });
      list.querySelectorAll('.ctx-dn').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.idx);
          if (idx < _ctxOrder.length - 1) { [_ctxOrder[idx], _ctxOrder[idx+1]] = [_ctxOrder[idx+1], _ctxOrder[idx]]; _renderCtxList(); }
        });
      });
    };
    _renderCtxList();

    el.querySelector('#ctx-order-save')?.addEventListener('click', async () => {
      const statusEl = el.querySelector('#ctx-order-status');
      try {
        await setSetting('contextOrder', _ctxOrder);
        // Notify sidebar + form controls to re-render
        window.dispatchEvent(new CustomEvent('fh:contextOrderChanged', { detail: { order: _ctxOrder } }));
        if (statusEl) { statusEl.style.display = 'inline'; statusEl.textContent = '✅ Saved — reload to apply to sidebar'; statusEl.style.color = 'var(--color-accent)'; setTimeout(() => { statusEl.style.display = 'none'; }, 3000); }
      } catch (err) {
        if (statusEl) { statusEl.style.display = 'inline'; statusEl.textContent = '❌ Failed'; statusEl.style.color = 'var(--color-danger)'; setTimeout(() => { statusEl.style.display = 'none'; }, 2000); }
      }
    });

    el.querySelector('#ctx-order-reset')?.addEventListener('click', () => {
      _ctxOrder = [...DEFAULT_CONTEXT_ORDER];
      _renderCtxList();
    });
  }

  // ── Tasks: follow-up toggle ─────────────────────────────
  const followupToggle = el.querySelector('#settings-followup-toggle');
  const followupStatus = el.querySelector('#settings-followup-status');
  if (followupToggle) {
    // Load current setting (default ON)
    getSetting('fh:followup_on_complete').then(val => {
      followupToggle.checked = val !== false;
    }).catch(() => { followupToggle.checked = true; });

    followupToggle.addEventListener('change', async () => {
      await setSetting('fh:followup_on_complete', followupToggle.checked);
      if (followupStatus) {
        followupStatus.textContent = followupToggle.checked ? '✓ Follow-up prompts enabled' : '✓ Follow-up prompts disabled';
        followupStatus.style.display = 'inline';
        followupStatus.style.color = 'var(--color-success-text,#15803d)';
        setTimeout(() => { followupStatus.style.display = 'none'; }, 2000);
      }
    });
  }

  // ── Tasks: view prefs ─────────────────────────────────────
  el.querySelectorAll('[id^="pref-"]').forEach(select => {
    select.addEventListener('change', async (e) => {
      const tabKey  = select.dataset.tab;
      const viewMode = e.target.value;
      try {
        const current = (await getSetting('taskViewPreferences')) || {};
        current[tabKey] = viewMode;
        await setSetting('taskViewPreferences', current);
        window.dispatchEvent(new CustomEvent('fh:taskViewPrefChanged', { detail: { tabKey, viewMode } }));
        const tmp = select.style.borderColor;
        select.style.borderColor = 'var(--color-accent)';
        setTimeout(() => { select.style.borderColor = tmp; }, 300);
      } catch (err) { console.error('[settings] view pref save failed:', err); }
    });
  });

  // ── Tasks: time block ─────────────────────────────────────
  el.querySelector('#settings-time-block-save')?.addEventListener('click', async () => {
    const select   = el.querySelector('#settings-default-time-block');
    const statusEl = el.querySelector('#settings-time-block-status');
    const val = parseInt(select?.value || '1800', 10);
    try {
      await setSetting('taskDefaultTimeBlock', val);
      if (statusEl) { statusEl.style.display = 'inline'; statusEl.textContent = '✅ Saved'; statusEl.style.color = 'var(--color-accent)'; setTimeout(() => { statusEl.style.display = 'none'; }, 2000); }
    } catch {
      if (statusEl) { statusEl.style.display = 'inline'; statusEl.textContent = '❌ Failed'; statusEl.style.color = 'var(--color-danger)'; setTimeout(() => { statusEl.style.display = 'none'; }, 2000); }
    }
  });

  // ── Tasks: recurring tasks [v5.3.1] ──────────────────────
  el.querySelector('#settings-recurrence-save')?.addEventListener('click', async () => {
    const previewSel = el.querySelector('#settings-recurrence-preview');
    const keepSel    = el.querySelector('#settings-recurrence-keep');
    const celebCb    = el.querySelector('#settings-recurrence-celebrations');
    const statusEl   = el.querySelector('#settings-recurrence-status');
    try {
      await Promise.all([
        setSetting('recurrencePreviewDays', parseInt(previewSel?.value || '7', 10)),
        setSetting('recurrenceKeepDays',    parseInt(keepSel?.value    || '30', 10)),
        setSetting('recurrenceCelebrations', celebCb?.checked !== false),
      ]);
      if (statusEl) { statusEl.style.display = 'inline'; statusEl.textContent = '✅ Saved'; statusEl.style.color = 'var(--color-accent)'; setTimeout(() => { statusEl.style.display = 'none'; }, 2000); }
    } catch {
      if (statusEl) { statusEl.style.display = 'inline'; statusEl.textContent = '❌ Failed'; statusEl.style.color = 'var(--color-danger)'; setTimeout(() => { statusEl.style.display = 'none'; }, 2000); }
    }
  });

  // ── Notifications ─────────────────────────────────────────
  el.querySelector('#settings-push-btn')?.addEventListener('click', async () => {
    const pushBtn = el.querySelector('#settings-push-btn');
    if (!pushBtn) return;
    pushBtn.textContent = 'Requesting…'; pushBtn.disabled = true;
    try {
      const { requestPushPermission } = await import('../services/reminder.js');
      const result = await requestPushPermission();
      if (result === 'granted') {
        const statusEl = el.querySelector('#settings-push-status');
        if (statusEl) { statusEl.textContent = '✓ Granted'; statusEl.style.background = '#dcfce7'; statusEl.style.color = '#15803d'; }
        pushBtn.remove();
      } else {
        pushBtn.textContent = 'Denied by browser'; pushBtn.style.color = 'var(--color-danger)';
      }
    } catch { pushBtn.textContent = 'Enable'; pushBtn.disabled = false; }
  });

  el.querySelector('#settings-audio-tone')?.addEventListener('change', async (e) => {
    try { await setSetting('reminderDefaultTone', e.target.value); } catch {}
  });

  el.querySelector('#settings-audio-test')?.addEventListener('click', () => {
    const tone = el.querySelector('#settings-audio-tone')?.value || 'chime';
    if (!window._fhAudioCtx) {
      try { window._fhAudioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
    }
    const ctx = window._fhAudioCtx;
    if (!ctx || ctx.state === 'suspended') { alert('Click elsewhere on the page first to enable audio, then try again'); return; }
    const TONES = { chime:{f:528,t:'sine',d:0.6}, bell:{f:659,t:'sine',d:0.5}, ping:{f:440,t:'triangle',d:0.2}, gentle:{f:396,t:'sine',d:0.8}, alarm:{f:880,t:'square',d:0.3} };
    const tp = TONES[tone] || TONES.chime;
    try {
      const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = tp.t; osc.frequency.value = tp.f;
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + tp.d);
      osc.start(ctx.currentTime); osc.stop(ctx.currentTime + tp.d);
    } catch (e) { console.warn('[settings] audio test failed:', e); }
  });

  el.querySelector('#settings-quiet-enabled')?.addEventListener('change', (e) => {
    const times = el.querySelector('#settings-quiet-times');
    if (times) times.style.display = e.target.checked ? 'flex' : 'none';
  });

  el.querySelector('#settings-quiet-save')?.addEventListener('click', async () => {
    const start   = el.querySelector('#settings-quiet-start')?.value || '22:00';
    const end     = el.querySelector('#settings-quiet-end')?.value   || '07:00';
    const enabled = el.querySelector('#settings-quiet-enabled')?.checked || false;
    const saveBtn = el.querySelector('#settings-quiet-save');
    const statEl  = el.querySelector('#settings-quiet-status');
    try {
      await setSetting('reminderQuietHours', { enabled, start, end });
      if (saveBtn) { saveBtn.textContent = '✓ Saved'; setTimeout(() => { saveBtn.textContent = 'Save'; }, 1500); }
    } catch (err) {
      if (saveBtn) { saveBtn.textContent = '⚠ Failed'; setTimeout(() => { saveBtn.textContent = 'Save'; }, 2000); }
    }
  });

  // ── Family ────────────────────────────────────────────────
  el.querySelector('#settings-invite-btn')?.addEventListener('click', async () => {
    const roleSelect = el.querySelector('#settings-invite-role');
    const resultDiv  = el.querySelector('#settings-invite-result');
    const role = roleSelect?.value || 'member';
    try {
      const result = await generateInvite(role, account.id);
      if (result?.ok && result?.code) {
        resultDiv.style.display = 'block';
        resultDiv.innerHTML = `
          <div style="margin-bottom:6px;font-size:var(--text-xs);color:var(--color-text-muted);">Invite code (click to copy):</div>
          <div id="settings-invite-code" style="cursor:pointer;padding:8px;background:var(--color-bg);border-radius:var(--radius-sm);user-select:all;">${_esc(result.code)}</div>
        `;
        el.querySelector('#settings-invite-code')?.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(result.code);
            const codeEl = el.querySelector('#settings-invite-code');
            if (codeEl) { const orig = codeEl.textContent; codeEl.textContent = '✓ Copied!'; codeEl.style.color = 'var(--color-accent)'; setTimeout(() => { codeEl.textContent = orig; codeEl.style.color = ''; }, 1500); }
          } catch {
            const codeEl = el.querySelector('#settings-invite-code');
            if (codeEl) { const r = document.createRange(); r.selectNodeContents(codeEl); const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(r); }
          }
        });
      } else {
        resultDiv.style.display = 'block';
        resultDiv.textContent = 'Failed: ' + (result?.error || 'Unknown error');
        resultDiv.style.color = 'var(--color-danger)';
      }
    } catch (err) {
      if (resultDiv) { resultDiv.style.display = 'block'; resultDiv.textContent = 'Error: ' + err.message; resultDiv.style.color = 'var(--color-danger)'; }
    }
  });

  // ── Data ──────────────────────────────────────────────────
  el.querySelector('#settings-export-btn')?.addEventListener('click', async () => {
    const statusDiv = el.querySelector('#settings-data-status');
    try {
      const data = await exportAll();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url;
      const _nd = new Date();
      const _ds = `${_nd.getFullYear()}-${String(_nd.getMonth()+1).padStart(2,'0')}-${String(_nd.getDate()).padStart(2,'0')}`;
      a.download = `familyhub-export-${_ds}.json`;
      a.click();
      URL.revokeObjectURL(url);
      if (statusDiv) { statusDiv.style.display = 'block'; statusDiv.textContent = '✅ Export downloaded successfully.'; statusDiv.style.color = 'var(--color-accent)'; }
    } catch (err) {
      if (statusDiv) { statusDiv.style.display = 'block'; statusDiv.textContent = '❌ Export failed: ' + err.message; statusDiv.style.color = 'var(--color-danger)'; }
    }
  });

  el.querySelector('#settings-import-file')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!window.confirm(`Import "${file.name}"? This will merge data into your existing FamilyHub — existing records with matching IDs will be overwritten. Continue?`)) { e.target.value = ''; return; }
    const statusDiv = el.querySelector('#settings-data-status');
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      await importAll(data);
      if (statusDiv) { statusDiv.style.display = 'block'; statusDiv.textContent = '✅ Import complete. Refreshing…'; statusDiv.style.color = 'var(--color-accent)'; }
      setTimeout(() => location.reload(), 1000);
    } catch (err) {
      if (statusDiv) { statusDiv.style.display = 'block'; statusDiv.textContent = '❌ Import failed: ' + err.message; statusDiv.style.color = 'var(--color-danger)'; }
    }
  });

  // ── About ─────────────────────────────────────────────────
  el.querySelector('#settings-tour-btn')?.addEventListener('click', () => {
    startTour('onboarding', window._fhEnv, true);
  });
}

// ── Registration ───────────────────────────────────────────────
registerView('settings', renderSettings);

export { renderSettings };
