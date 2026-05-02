/**
 * FamilyHub v4.2 — services/theme.js
 * Runtime CSS Variable Theme Service.
 * Implements Prompt 26 spec exactly.
 *
 * Registered as env.services.theme via serviceRegistry.
 *
 * On start():
 *   1. Loads saved preferences from data service (key: 'settings:theme')
 *   2. Injects <style id="fh-theme-overrides"> into document.head
 *   3. Applies preferences as :root { ... } CSS variable overrides
 *
 * Preference keys:
 *   accent   — hex color, default '#4f8ef7'
 *   mode     — 'light' | 'dark' | 'auto' (auto = prefers-color-scheme)
 *   density  — 'compact' | 'comfortable' | 'spacious' (affects --spacing-unit)
 *   fontSize — 0.85–1.15 multiplier on --font-size-base
 *
 * Public API (env.services.theme):
 *   getPrefs()          — current preferences object
 *   setTheme(prefs)     — merge+apply+persist preferences (no reload)
 *   reset()             — restore defaults
 */

const DEFAULTS = {
  accent:   '#4f8ef7',
  mode:     'auto',
  density:  'comfortable',
  fontSize: 1.0,
};

const DENSITY_SPACING = {
  compact:     '0.875rem',   // ~14px base spacing unit
  comfortable: '1rem',       // 16px (default)
  spacious:    '1.25rem',    // 20px
};

const DENSITY_RADIUS = {
  compact:     '4px',
  comfortable: '8px',
  spacious:    '12px',
};

const STORAGE_KEY = 'settings:theme';
const STYLE_ID    = 'fh-theme-overrides';

let _prefs     = { ...DEFAULTS };
let _styleEl   = null;
let _mq        = null;   // prefers-color-scheme media query
let _mqHandler = null;   // stored so we can remove it on reset
let _dataService = null; // injected at start()

// ── Apply ─────────────────────────────────────────────────── //

function _resolveMode(mode) {
  if (mode !== 'auto') return mode;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function _buildCss(prefs) {
  const mode    = _resolveMode(prefs.mode);
  const spacing = DENSITY_SPACING[prefs.density] || DENSITY_SPACING.comfortable;
  const radius  = DENSITY_RADIUS[prefs.density]  || DENSITY_RADIUS.comfortable;
  const accent  = prefs.accent || DEFAULTS.accent;
  const scale   = Math.max(0.85, Math.min(1.15, prefs.fontSize || 1.0));

  // Derive tints/shades from accent hex
  const accentRgb = _hexToRgb(accent);
  const accentMuted = accentRgb ? `rgba(${accentRgb}, 0.12)` : 'rgba(79,142,247,0.12)';

  return `
:root {
  --color-accent:       ${accent};
  --color-accent-muted: ${accentMuted};
  --spacing-unit:       ${spacing};
  --radius-base:        ${radius};
  --font-size-scale:    ${scale};
}
[data-theme="dark"] {
  --color-accent:       ${accent};
  --color-accent-muted: ${accentMuted};
}
  `.trim();
}

function _applyTheme(prefs) {
  // Inject or update the override style tag
  if (!_styleEl || !_styleEl.isConnected) {
    _styleEl = document.getElementById(STYLE_ID);
    if (!_styleEl) {
      _styleEl = document.createElement('style');
      _styleEl.id = STYLE_ID;
      document.head.appendChild(_styleEl);
    }
  }
  _styleEl.textContent = _buildCss(prefs);

  // Apply mode to <html> data-theme attribute
  const resolved = _resolveMode(prefs.mode);
  document.documentElement.setAttribute('data-theme', resolved);
  localStorage.setItem('fh_theme', resolved);

  // Wire auto-mode media query listener
  if (prefs.mode === 'auto') {
    if (!_mq) {
      _mq = window.matchMedia('(prefers-color-scheme: dark)');
      _mqHandler = () => _applyTheme(_prefs);
      _mq.addEventListener('change', _mqHandler);
    }
  } else {
    // Remove listener if not auto
    if (_mq && _mqHandler) {
      _mq.removeEventListener('change', _mqHandler);
      _mq = null; _mqHandler = null;
    }
  }
}

function _hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return null;
  return `${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}`;
}

// ── Service factory ───────────────────────────────────────── //

export function createThemeService(dataService) {
  _dataService = dataService;

  /**
   * Get current theme preferences.
   * @returns {object}
   */
  function getPrefs() {
    return { ..._prefs };
  }

  /**
   * Merge, apply, and persist theme preferences.
   * No page reload required.
   * @param {Partial<typeof DEFAULTS>} patch
   */
  async function setTheme(patch) {
    _prefs = { ..._prefs, ...patch };

    // Clamp fontSize
    _prefs.fontSize = Math.max(0.85, Math.min(1.15, _prefs.fontSize));

    _applyTheme(_prefs);

    // Notify the app so the fast-boot 'fh_theme' key stays in sync
    const resolved = _resolveMode(_prefs.mode);
    if (typeof window !== 'undefined') {
      import('../core/events.js').then(({ emit, EVENTS }) => {
        emit(EVENTS.THEME_CHANGED, { theme: resolved });
      }).catch(() => {});
    }

    // Persist to data service
    if (_dataService?.setSetting) {
      try {
        await _dataService.setSetting(STORAGE_KEY, _prefs);
      } catch (err) {
        console.warn('[theme] Could not persist preferences:', err);
        // Fallback to localStorage
        localStorage.setItem(STORAGE_KEY, JSON.stringify(_prefs));
      }
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(_prefs));
    }
  }

  /**
   * Reset to defaults.
   */
  async function reset() {
    await setTheme({ ...DEFAULTS });
  }

  return { getPrefs, setTheme, reset };
}

// ── Service descriptor ────────────────────────────────────── //

export const themeServiceDescriptor = {
  dependencies: ['data'],
  async start(env) {
    const dataService = env.services.data;

    // Load saved preferences
    let saved = null;
    try {
      if (dataService?.getSetting) {
        saved = await dataService.getSetting(STORAGE_KEY);
      }
    } catch { /* first run */ }

    // Fallback to localStorage
    if (!saved) {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) saved = JSON.parse(raw);
      } catch { /* ignore */ }
    }

    _prefs = { ...DEFAULTS, ...(saved || {}) };

    // Apply initial theme (only in browser)
    if (typeof document !== 'undefined') {
      _applyTheme(_prefs);
    }

    return createThemeService(dataService);
  },
};
