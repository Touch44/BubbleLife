/**
 * FamilyHub v3.0 — core/pwa.js
 * PWA Install Prompt — engagement-gated install banner.
 * Implements Prompt 22 spec exactly.
 *
 * Features:
 *   1. Captures beforeinstallprompt, stores deferred prompt
 *   2. Engagement threshold: 3+ views navigated OR 5+ entities created
 *   3. Shows subtle bottom banner after threshold
 *   4. Install button: calls deferredPrompt.prompt()
 *   5. Dismiss: 7-day cooldown in localStorage
 *   6. Standalone mode detection (hide if already installed)
 *   7. appinstalled event → success notification
 *   8. Exports getInstallPrompt() for Settings view "Install App" button
 */

import { on, EVENTS } from './events.js';

const COOLDOWN_KEY      = 'fh_pwa_dismiss_ts';
const COOLDOWN_MS       = 7 * 24 * 60 * 60 * 1000; // 7 days
const VIEWS_THRESHOLD   = 3;
const ENTITIES_THRESHOLD = 5;

let _deferredPrompt  = null;
let _banner          = null;
let _viewsNavigated  = new Set();
let _entitiesCreated = 0;
let _thresholdMet    = false;
let _notifSvc        = null;

// ── Init ──────────────────────────────────────────────────── //

/**
 * Initialise PWA install handling.
 * Call once after env is built.
 * @param {object} env
 */
export function initPWA(env) {
  _notifSvc = env?.services?.notification;

  // Don't show if already in standalone mode
  if (window.matchMedia('(display-mode: standalone)').matches) return;
  if (navigator.standalone) return; // iOS

  // Capture deferred prompt
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    _deferredPrompt = e;
    _checkThreshold();
  });

  // Track navigation for engagement
  on(EVENTS.VIEW_CHANGED, ({ viewKey }) => {
    if (viewKey) _viewsNavigated.add(viewKey);
    _checkThreshold();
  });

  // Track entity creation
  on(EVENTS.ENTITY_SAVED, ({ isNew }) => {
    if (isNew) {
      _entitiesCreated++;
      _checkThreshold();
    }
  });

  // appinstalled event
  window.addEventListener('appinstalled', () => {
    _hideBanner();
    _deferredPrompt = null;
    _notifSvc?.success?.('FamilyHub added to your home screen!') ||
      console.log('[pwa] App installed');
  });
}

/**
 * Returns the deferred install prompt (for Settings view button).
 * Null if not available (already installed or not supported).
 * @returns {Event|null}
 */
export function getInstallPrompt() {
  return _deferredPrompt;
}

/**
 * Trigger the install prompt manually (for Settings view).
 * @returns {Promise<'accepted'|'dismissed'|null>}
 */
export async function promptInstall() {
  if (!_deferredPrompt) return null;
  try {
    _deferredPrompt.prompt();
    const { outcome } = await _deferredPrompt.userChoice;
    _deferredPrompt = null;
    _hideBanner();
    return outcome;
  } catch {
    return null;
  }
}

// ── Internal ──────────────────────────────────────────────── //

function _checkThreshold() {
  if (_thresholdMet || !_deferredPrompt) return;

  const viewsMet    = _viewsNavigated.size >= VIEWS_THRESHOLD;
  const entitiesMet = _entitiesCreated   >= ENTITIES_THRESHOLD;

  if (!viewsMet && !entitiesMet) return;

  // Check cooldown
  const lastDismiss = parseInt(localStorage.getItem(COOLDOWN_KEY) || '0', 10);
  if (Date.now() - lastDismiss < COOLDOWN_MS) return;

  _thresholdMet = true;
  _showBanner();
}

function _showBanner() {
  if (_banner) return;

  _banner = document.createElement('div');
  _banner.id = 'fh-pwa-banner';
  _banner.setAttribute('role', 'banner');
  _banner.setAttribute('aria-label', 'Install FamilyHub');
  _banner.style.cssText = `
    position: fixed; bottom: 0; left: 0; right: 0;
    z-index: 9000;
    background: var(--color-bg);
    border-top: 1px solid var(--color-border);
    box-shadow: 0 -4px 16px rgba(15,23,42,0.08);
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px; padding: 12px 20px;
    animation: pwaSlideUp 0.3s cubic-bezier(0.22,1,0.36,1);
    font-family: system-ui, sans-serif;
  `;

  const style = document.createElement('style');
  style.textContent = `@keyframes pwaSlideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}`;
  document.head.appendChild(style);

  _banner.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;">
      <span style="font-size:20px;" aria-hidden="true">📱</span>
      <div>
        <div style="font-weight:600;font-size:14px;color:var(--color-text);">Add FamilyHub to your home screen</div>
        <div style="font-size:12px;color:var(--color-text-muted);">Works offline · Fast · No app store needed</div>
      </div>
    </div>
    <div style="display:flex;gap:8px;flex-shrink:0;">
      <button id="fh-pwa-dismiss" style="
        padding:7px 14px;background:none;
        border:1px solid var(--color-border);border-radius:8px;
        cursor:pointer;font-size:13px;color:var(--color-text-muted);">
        Later
      </button>
      <button id="fh-pwa-install" style="
        padding:7px 18px;background:var(--color-accent,#0A7B6C);
        color:#fff;border:none;border-radius:8px;
        cursor:pointer;font-size:13px;font-weight:600;">
        Install
      </button>
    </div>
  `;

  document.body.appendChild(_banner);

  document.getElementById('fh-pwa-install')?.addEventListener('click', async () => {
    const outcome = await promptInstall();
    if (outcome === 'accepted') {
      _notifSvc?.success?.('Installing FamilyHub…');
    }
  });

  document.getElementById('fh-pwa-dismiss')?.addEventListener('click', () => {
    localStorage.setItem(COOLDOWN_KEY, String(Date.now()));
    _hideBanner();
  });
}

function _hideBanner() {
  _banner?.remove();
  _banner = null;
}
