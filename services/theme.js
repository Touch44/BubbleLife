/**
 * FamilyHub v6.0.0 — services/theme.js
 * Runtime CSS Variable Theme Service — extended with full typography control.
 *
 * Preference keys:
 *   accent       — hex color,           default '#3B82F6'
 *   mode         — 'light'|'dark'|'auto'
 *   density      — 'compact'|'comfortable'|'spacious'
 *   fontSize     — 0.80–1.30 multiplier  (was 0.85–1.15)
 *   fontFamily   — 'plus-jakarta-sans'|'inter'|'dm-sans'|'system'|'geist'|'outfit'
 *   letterSpacing— 'tight'|'normal'|'wide'
 *   lineHeight   — 'compact'|'normal'|'relaxed'
 */

const DEFAULTS = {
  accent:        '#3B82F6',
  mode:          'auto',
  density:       'comfortable',
  fontSize:      1.0,
  fontFamily:    'plus-jakarta-sans',
  letterSpacing: 'normal',
  lineHeight:    'normal',
};

// ── Font stacks ───────────────────────────────────────────── //
export const FONT_OPTIONS = [
  {
    key:   'plus-jakarta-sans',
    label: 'Plus Jakarta Sans',
    tag:   'Recommended',
    stack: "'Plus Jakarta Sans', 'PJS-Fallback', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif",
  },
  {
    key:   'inter',
    label: 'Inter',
    tag:   'Neutral',
    stack: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif",
    googleUrl: 'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap',
  },
  {
    key:   'dm-sans',
    label: 'DM Sans',
    tag:   'Friendly',
    stack: "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif",
    googleUrl: 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&display=swap',
  },
  {
    key:   'outfit',
    label: 'Outfit',
    tag:   'Expressive',
    stack: "Outfit, -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif",
    googleUrl: 'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap',
  },
  {
    key:   'system',
    label: 'System Default',
    tag:   'Native',
    stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
  },
];

// ── Letter spacing map ────────────────────────────────────── //
const LETTER_SPACING = {
  tight:  { heading: '-0.04em', body: '-0.01em', label: '-0.01em' },
  normal: { heading: '-0.02em', body:  '0em',    label:  '0.01em' },
  wide:   { heading:  '0em',   body:  '0.02em',  label:  '0.06em' },
};

// ── Line height map ───────────────────────────────────────── //
const LINE_HEIGHT = {
  compact:  { body: '1.35', heading: '1.15' },
  normal:   { body: '1.55', heading: '1.25' },
  relaxed:  { body: '1.75', heading: '1.40' },
};

// ── Density → spacing/radius ──────────────────────────────── //
const DENSITY_SPACING = {
  compact:     '0.875rem',
  comfortable: '1rem',
  spacious:    '1.25rem',
};
const DENSITY_RADIUS = {
  compact:     '4px',
  comfortable: '8px',
  spacious:    '12px',
};

const STORAGE_KEY = 'settings:theme';
const STYLE_ID    = 'fh-theme-overrides';
const FONT_LINK_ID = 'fh-font-loader';

let _prefs       = { ...DEFAULTS };
let _styleEl     = null;
let _mq          = null;
let _mqHandler   = null;
let _dataService = null;

// ── CSS builder ───────────────────────────────────────────── //
function _resolveMode(mode) {
  if (mode !== 'auto') return mode;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function _buildCss(prefs) {
  const spacing  = DENSITY_SPACING[prefs.density]  || DENSITY_SPACING.comfortable;
  const radius   = DENSITY_RADIUS[prefs.density]   || DENSITY_RADIUS.comfortable;
  const accent   = prefs.accent || DEFAULTS.accent;
  const scale    = Math.max(0.80, Math.min(1.30, prefs.fontSize || 1.0));
  const lsKey    = prefs.letterSpacing || 'normal';
  const lhKey    = prefs.lineHeight    || 'normal';
  const ls       = LETTER_SPACING[lsKey]  || LETTER_SPACING.normal;
  const lh       = LINE_HEIGHT[lhKey]     || LINE_HEIGHT.normal;

  const fontOpt  = FONT_OPTIONS.find(f => f.key === (prefs.fontFamily || 'plus-jakarta-sans'))
                 || FONT_OPTIONS[0];
  const stack    = fontOpt.stack;

  const accentRgb  = _hexToRgb(accent);
  const accentMuted = accentRgb ? `rgba(${accentRgb}, 0.12)` : 'rgba(59,130,246,0.12)';

  return `
:root {
  --color-accent:         ${accent};
  --color-accent-muted:   ${accentMuted};
  --spacing-unit:         ${spacing};
  --radius-base:          ${radius};
  --font-size-scale:      ${scale};
  --font-family-primary:  ${stack};
  --font-body:            ${stack};
  --font-heading:         ${stack};
  --tracking-heading:     ${ls.heading};
  --tracking-body:        ${ls.body};
  --tracking-label:       ${ls.label};
  --leading-normal:       ${lh.body};
  --leading-tight:        ${lh.heading};
}
html {
  font-size: calc(16px * ${scale});
}
body, input, button, select, textarea {
  font-family: ${stack};
  letter-spacing: ${ls.body};
  line-height: ${lh.body};
}
h1, h2, h3, h4, h5, h6,
.view-title, .page-title, .stab-label,
.entity-panel-title, .modal-title {
  font-family: ${stack};
  letter-spacing: ${ls.heading};
  line-height: ${lh.heading};
}
.nav-label, .col-header, .srow-label,
.badge, .tab-btn, .stab-btn {
  font-family: ${stack};
  letter-spacing: ${ls.label};
}
[data-theme="dark"] {
  --color-accent:       ${accent};
  --color-accent-muted: ${accentMuted};
}
  `.trim();
}

// ── Load Google Fonts link for non-PJS fonts ──────────────── //
function _loadGoogleFont(fontOpt) {
  // Remove any existing loader
  const existing = document.getElementById(FONT_LINK_ID);
  if (existing) existing.remove();
  if (!fontOpt?.googleUrl) return; // PJS and System don't need external load
  const link = document.createElement('link');
  link.id   = FONT_LINK_ID;
  link.rel  = 'stylesheet';
  link.href = fontOpt.googleUrl;
  document.head.appendChild(link);
}

function _applyTheme(prefs) {
  if (!_styleEl || !_styleEl.isConnected) {
    _styleEl = document.getElementById(STYLE_ID);
    if (!_styleEl) {
      _styleEl = document.createElement('style');
      _styleEl.id = STYLE_ID;
      document.head.appendChild(_styleEl);
    }
  }
  _styleEl.textContent = _buildCss(prefs);

  const resolved = _resolveMode(prefs.mode);
  document.documentElement.setAttribute('data-theme', resolved);
  localStorage.setItem('fh_theme', resolved);

  // Load external font if needed (non-PJS)
  const fontOpt = FONT_OPTIONS.find(f => f.key === (prefs.fontFamily || 'plus-jakarta-sans'));
  _loadGoogleFont(fontOpt);

  if (prefs.mode === 'auto') {
    if (!_mq) {
      _mq = window.matchMedia('(prefers-color-scheme: dark)');
      _mqHandler = () => _applyTheme(_prefs);
      _mq.addEventListener('change', _mqHandler);
    }
  } else {
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

  function getPrefs() { return { ..._prefs }; }

  async function setTheme(patch) {
    _prefs = { ..._prefs, ...patch };
    _prefs.fontSize = Math.max(0.80, Math.min(1.30, _prefs.fontSize || 1.0));
    _applyTheme(_prefs);

    const resolved = _resolveMode(_prefs.mode);
    try {
      const { emit, EVENTS } = await import('../core/events.js');
      emit(EVENTS.THEME_CHANGED, { theme: resolved });
    } catch {}

    if (_dataService?.setSetting) {
      try { await _dataService.setSetting(STORAGE_KEY, _prefs); }
      catch { localStorage.setItem(STORAGE_KEY, JSON.stringify(_prefs)); }
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(_prefs));
    }
  }

  async function reset() { await setTheme({ ...DEFAULTS }); }

  return { getPrefs, setTheme, reset, FONT_OPTIONS };
}

// ── Service descriptor ────────────────────────────────────── //
export const themeServiceDescriptor = {
  dependencies: ['data'],
  async start(env) {
    const dataService = env.services.data;
    let saved = null;
    try {
      if (dataService?.getSetting) saved = await dataService.getSetting(STORAGE_KEY);
    } catch {}
    if (!saved) {
      try { const raw = localStorage.getItem(STORAGE_KEY); if (raw) saved = JSON.parse(raw); }
      catch {}
    }
    _prefs = { ...DEFAULTS, ...(saved || {}) };
    if (typeof document !== 'undefined') _applyTheme(_prefs);
    return createThemeService(dataService);
  },
};
