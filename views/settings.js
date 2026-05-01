/**
 * FamilyHub v3 — views/settings.js
 * [MAJOR] V-03 — Settings View — Theme, Accounts, Invites, Data
 *
 * Sections:
 *   1. Appearance (light/dark toggle)
 *   2. My Account (username, role)
 *   3. Family Members (admin only)
 *   4. Invite (admin only)
 *   5. Data (export/import/storage)
 *   6. About (version, restart tour)
 *
 * Registration: registerView('settings', renderSettings)
 */

import { registerView } from '../core/router.js';
import { exportAll, importAll, getStorageUsage } from '../core/db.js';
import { getAccount, getAllAccounts, generateInvite } from '../core/auth.js';
import { startTour } from '../core/tour.js';

// ── Inject CSS once ────────────────────────────────────────────
(function _injectStyles() {
  if (document.getElementById('settings-view-styles')) return;
  const style = document.createElement('style');
  style.id = 'settings-view-styles';
  style.textContent = `
    #view-settings.active { padding: 0; overflow-y: auto; }
  `;
  document.head.appendChild(style);
})();

// ── Helpers ────────────────────────────────────────────────────
function _esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function _section(title, icon, content) {
  return `
    <div style="margin-bottom:var(--space-6);padding:var(--space-5);background:var(--color-bg);border:1px solid var(--color-border);border-radius:var(--radius-lg);">
      <h3 style="font-size:var(--text-base);font-weight:var(--weight-bold);color:var(--color-text);margin-bottom:var(--space-4);display:flex;align-items:center;gap:var(--space-2);">
        <span style="font-size:1.1em;">${icon}</span> ${title}
      </h3>
      ${content}
    </div>
  `;
}

// ── Main Render ────────────────────────────────────────────────
async function renderSettings() {
  const el = document.getElementById('view-settings');
  if (!el) return;

  const account = getAccount();
  const isAdmin = account?.role === 'admin' || account?.role === 'parent';

  // Load data
  let accounts = [];
  let storageInfo = { used: 0, quota: 0 };
  try { accounts = await getAllAccounts() || []; } catch (e) { /* skip */ }
  try { storageInfo = await getStorageUsage() || { used: 0, quota: 0 }; } catch (e) { /* skip */ }

  const usedMB = ((storageInfo.used || 0) / (1024 * 1024)).toFixed(2);

  // Detect current theme
  const env = window._fhEnv;
  let currentMode = 'auto';
  try {
    const prefs = env?.services?.theme?.getPrefs?.();
    currentMode = prefs?.mode || 'auto';
  } catch (e) { /* fallback */ }

  el.innerHTML = `
    <div style="max-width:600px;margin:0 auto;padding:var(--space-6) var(--space-4);">
      <h2 style="font-size:var(--text-xl);font-weight:var(--weight-bold);color:var(--color-text);margin-bottom:var(--space-6);">
        ⚙️ Settings
      </h2>

      ${_section('Appearance', '🎨', `
        <div style="display:flex;align-items:center;gap:var(--space-4);">
          <span style="font-size:var(--text-sm);color:var(--color-text);">Theme</span>
          <div style="display:flex;gap:var(--space-2);">
            <button id="settings-theme-light" style="
              padding:6px 16px;font-size:var(--text-sm);border-radius:var(--radius-md);cursor:pointer;
              border:1px solid var(--color-border);font-weight:var(--weight-semibold);
              background:${currentMode === 'light' ? 'var(--color-accent)' : 'var(--color-surface)'};
              color:${currentMode === 'light' ? '#fff' : 'var(--color-text)'};
            ">☀️ Light</button>
            <button id="settings-theme-dark" style="
              padding:6px 16px;font-size:var(--text-sm);border-radius:var(--radius-md);cursor:pointer;
              border:1px solid var(--color-border);font-weight:var(--weight-semibold);
              background:${currentMode === 'dark' ? 'var(--color-accent)' : 'var(--color-surface)'};
              color:${currentMode === 'dark' ? '#fff' : 'var(--color-text)'};
            ">🌙 Dark</button>
            <button id="settings-theme-auto" style="
              padding:6px 16px;font-size:var(--text-sm);border-radius:var(--radius-md);cursor:pointer;
              border:1px solid var(--color-border);font-weight:var(--weight-semibold);
              background:${currentMode === 'auto' ? 'var(--color-accent)' : 'var(--color-surface)'};
              color:${currentMode === 'auto' ? '#fff' : 'var(--color-text)'};
            ">⚙️ Auto</button>
          </div>
        </div>
      `)}

      ${_section('My Account', '👤', `
        <div style="font-size:var(--text-sm);color:var(--color-text);display:flex;flex-direction:column;gap:var(--space-2);">
          <div><strong>Username:</strong> ${_esc(account?.username || 'Unknown')}</div>
          <div><strong>Role:</strong>
            <span style="padding:2px 8px;border-radius:var(--radius-full);font-size:var(--text-xs);font-weight:var(--weight-semibold);
              background:${account?.role === 'admin' ? 'var(--color-accent)' : 'var(--color-surface)'};
              color:${account?.role === 'admin' ? '#fff' : 'var(--color-text)'};
              border:1px solid var(--color-border);">
              ${_esc(account?.role || 'member')}
            </span>
          </div>
          <div><strong>Account ID:</strong> <code style="font-size:var(--text-xs);color:var(--color-text-muted);">${_esc(account?.id || '')}</code></div>
        </div>
      `)}

      ${isAdmin ? _section('Family Members', '👨‍👩‍👧‍👦', `
        <div id="settings-members-list" style="display:flex;flex-direction:column;gap:var(--space-2);">
          ${accounts.map(a => `
            <div style="display:flex;align-items:center;gap:var(--space-3);padding:var(--space-2) var(--space-3);background:var(--color-surface);border-radius:var(--radius-md);border:1px solid var(--color-border);">
              <div style="width:32px;height:32px;border-radius:50%;background:var(--color-accent);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:var(--weight-bold);font-size:var(--text-sm);">
                ${_esc((a.username || '?')[0].toUpperCase())}
              </div>
              <div style="flex:1;">
                <div style="font-size:var(--text-sm);font-weight:var(--weight-semibold);color:var(--color-text);">${_esc(a.username)}</div>
                <div style="font-size:var(--text-xs);color:var(--color-text-muted);">${_esc(a.role || 'member')}</div>
              </div>
            </div>
          `).join('')}
          ${accounts.length === 0 ? '<div style="font-size:var(--text-sm);color:var(--color-text-muted);">No accounts found.</div>' : ''}
        </div>
      `) : ''}

      ${isAdmin ? _section('Invite Family Member', '🔗', `
        <div style="display:flex;flex-direction:column;gap:var(--space-3);">
          <div style="display:flex;gap:var(--space-2);">
            <select id="settings-invite-role" style="padding:6px 10px;font-size:var(--text-sm);border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-bg);color:var(--color-text);">
              <option value="member">Member</option>
              <option value="parent">Parent</option>
            </select>
            <button id="settings-invite-btn" style="
              padding:6px 16px;font-size:var(--text-sm);font-weight:var(--weight-semibold);
              background:var(--color-accent);color:#fff;border:none;border-radius:var(--radius-md);cursor:pointer;
            ">Generate Invite</button>
          </div>
          <div id="settings-invite-result" style="display:none;padding:var(--space-3);background:var(--color-surface);border:1px dashed var(--color-border);border-radius:var(--radius-md);font-family:monospace;font-size:var(--text-sm);color:var(--color-text);word-break:break-all;"></div>
        </div>
      `) : ''}

      ${_section('Data Management', '💾', `
        <div style="display:flex;flex-direction:column;gap:var(--space-3);">
          <div style="font-size:var(--text-sm);color:var(--color-text-muted);">
            Storage used: <strong style="color:var(--color-text);">${usedMB} MB</strong>
          </div>
          <div style="display:flex;gap:var(--space-2);flex-wrap:wrap;">
            <button id="settings-export-btn" style="
              padding:6px 16px;font-size:var(--text-sm);font-weight:var(--weight-semibold);
              background:var(--color-surface);color:var(--color-text);border:1px solid var(--color-border);
              border-radius:var(--radius-md);cursor:pointer;
            ">📥 Export Data</button>
            <label id="settings-import-label" style="
              padding:6px 16px;font-size:var(--text-sm);font-weight:var(--weight-semibold);
              background:var(--color-surface);color:var(--color-text);border:1px solid var(--color-border);
              border-radius:var(--radius-md);cursor:pointer;display:inline-flex;align-items:center;
            ">
              📤 Import Data
              <input type="file" id="settings-import-file" accept=".json" style="display:none;" />
            </label>
          </div>
          <div id="settings-data-status" style="font-size:var(--text-xs);color:var(--color-text-muted);display:none;"></div>
        </div>
      `)}

      ${_section('About', 'ℹ️', `
        <div style="font-size:var(--text-sm);color:var(--color-text);display:flex;flex-direction:column;gap:var(--space-2);">
          <div><strong>FamilyHub</strong> v3.9.0</div>
          <div style="color:var(--color-text-muted);">Multi-context family management PWA</div>
          <button id="settings-tour-btn" style="
            margin-top:var(--space-2);padding:6px 16px;font-size:var(--text-sm);font-weight:var(--weight-semibold);
            background:var(--color-surface);color:var(--color-text);border:1px solid var(--color-border);
            border-radius:var(--radius-md);cursor:pointer;width:fit-content;
          ">🎓 Restart Tour</button>
        </div>
      `)}
    </div>
  `;

  // ── Wire event handlers ───────────────────────────────────

  // Theme toggle
  const _applyTheme = (mode) => {
    if (env?.services?.theme) {
      env.services.theme.setTheme({ mode });
      renderSettings(); // re-render to update button states
    } else {
      // Fallback: apply theme directly via data-theme attribute
      const html = document.documentElement;
      if (mode === 'auto') {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        html.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
      } else {
        html.setAttribute('data-theme', mode);
      }
      try { localStorage.setItem('fh_theme', mode); } catch { /* ignore */ }
      renderSettings();
    }
  };
  el.querySelector('#settings-theme-light')?.addEventListener('click', () => _applyTheme('light'));
  el.querySelector('#settings-theme-dark')?.addEventListener('click',  () => _applyTheme('dark'));
  el.querySelector('#settings-theme-auto')?.addEventListener('click',  () => _applyTheme('auto'));

  // Invite
  el.querySelector('#settings-invite-btn')?.addEventListener('click', async () => {
    const roleSelect = el.querySelector('#settings-invite-role');
    const resultDiv = el.querySelector('#settings-invite-result');
    const role = roleSelect?.value || 'member';

    try {
      const result = await generateInvite(role, account.id);
      if (result?.ok && result?.code) {
        resultDiv.style.display = 'block';
        resultDiv.innerHTML = `
          <div style="margin-bottom:var(--space-2);font-size:var(--text-xs);color:var(--color-text-muted);">Invite code (click to copy):</div>
          <div id="settings-invite-code" style="cursor:pointer;padding:var(--space-2);background:var(--color-bg);border-radius:var(--radius-sm);user-select:all;">${_esc(result.code)}</div>
        `;
        el.querySelector('#settings-invite-code')?.addEventListener('click', () => {
          navigator.clipboard.writeText(result.code).catch(() => {});
        });
      } else {
        resultDiv.style.display = 'block';
        resultDiv.textContent = 'Failed: ' + (result?.error || 'Unknown error');
        resultDiv.style.color = 'var(--color-danger, #dc2626)';
      }
    } catch (err) {
      const resultDiv2 = el.querySelector('#settings-invite-result');
      if (resultDiv2) {
        resultDiv2.style.display = 'block';
        resultDiv2.textContent = 'Error: ' + err.message;
        resultDiv2.style.color = 'var(--color-danger, #dc2626)';
      }
    }
  });

  // Export
  el.querySelector('#settings-export-btn')?.addEventListener('click', async () => {
    const statusDiv = el.querySelector('#settings-data-status');
    try {
      const data = await exportAll();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // Use local date, not toISOString() which would shift in UTC-negative timezones
      const _nd = new Date();
      const _ds = `${_nd.getFullYear()}-${String(_nd.getMonth()+1).padStart(2,'0')}-${String(_nd.getDate()).padStart(2,'0')}`;
      a.download = `familyhub-export-${_ds}.json`;
      a.click();
      URL.revokeObjectURL(url);
      if (statusDiv) {
        statusDiv.style.display = 'block';
        statusDiv.textContent = '✅ Export downloaded successfully.';
        statusDiv.style.color = 'var(--color-accent)';
      }
    } catch (err) {
      if (statusDiv) {
        statusDiv.style.display = 'block';
        statusDiv.textContent = '❌ Export failed: ' + err.message;
        statusDiv.style.color = 'var(--color-danger, #dc2626)';
      }
    }
  });

  // Import
  el.querySelector('#settings-import-file')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const statusDiv = el.querySelector('#settings-data-status');
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      await importAll(data);
      if (statusDiv) {
        statusDiv.style.display = 'block';
        statusDiv.textContent = '✅ Import complete. Refreshing…';
        statusDiv.style.color = 'var(--color-accent)';
      }
      setTimeout(() => location.reload(), 1000);
    } catch (err) {
      if (statusDiv) {
        statusDiv.style.display = 'block';
        statusDiv.textContent = '❌ Import failed: ' + err.message;
        statusDiv.style.color = 'var(--color-danger, #dc2626)';
      }
    }
  });

  // Restart Tour
  el.querySelector('#settings-tour-btn')?.addEventListener('click', () => {
    startTour('onboarding', window._fhEnv, true);
  });
}

// ── Registration ───────────────────────────────────────────────
registerView('settings', renderSettings);

export { renderSettings };
