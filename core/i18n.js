/**
 * FamilyHub v4.2 — core/i18n.js
 * Minimal internationalisation scaffold.
 * Zero-cost: if no translation is loaded, t() returns the original string.
 * Designed to wrap strings now so full i18n can be added later without refactoring.
 *
 * Public API:
 *   t(string)                    — eager translation (use inside functions/templates)
 *   lt(string)                   — lazy translation (use for module-level constants)
 *   loadTranslations(lang, map)  — load a flat key:value translation map
 *   currentLang()                — active language code
 *
 * Usage:
 *   import { t, lt } from './core/i18n.js';
 *
 *   // Inside a render function:
 *   el.textContent = t('Save');
 *
 *   // Module-level constant (evaluated at call time, not import time):
 *   const LABEL_SAVE = lt('Save');
 *   // Later: LABEL_SAVE() → 'Guardar' (after Spanish loaded)
 */

/** @type {Record<string, string>} — current translation map */
let _translations = {};

/** @type {string} — current language code */
let _lang = '';

// ── Language detection ────────────────────────────────────── //

/**
 * Returns the active language code.
 * Defaults to navigator.language (e.g. 'en-US', 'es', 'fr').
 * @returns {string}
 */
export function currentLang() {
  return _lang || navigator.language || 'en';
}

// ── Load translations ─────────────────────────────────────── //

/**
 * Load a flat key:value translation map.
 * Replaces any previously loaded translations.
 * Keys are the English source strings; values are the translated strings.
 *
 * @param {string}             langCode — e.g. 'es', 'fr', 'en-US'
 * @param {Record<string, string>} map  — flat { "English": "Translated" } object
 */
export function loadTranslations(langCode, map) {
  _lang = langCode;
  _translations = map || {};
  console.log(`[i18n] Loaded ${Object.keys(_translations).length} strings for "${langCode}"`);
}

// ── t() — eager translation ───────────────────────────────── //

/**
 * Translate a string eagerly.
 * Looks up the string in the loaded translation map.
 * Returns the original string if no translation is found (passthrough).
 * Use inside render functions and templates where the language is already loaded.
 *
 * @param {string} str — English source string
 * @returns {string}
 */
export function t(str, vars) {
  if (!str) return str;
  let result = _translations[str] ?? str;
  // Interpolate {var} placeholders if vars provided
  if (vars && typeof vars === 'object') {
    result = result.replace(/\{(\w+)\}/g, (_, key) =>
      Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : `{${key}}`
    );
  }
  return result;
}

// ── lt() — lazy translation ───────────────────────────────── //

/**
 * Lazy translation — returns a getter function that translates when called.
 * Use for module-level string constants defined before translations are loaded.
 *
 * Without lt(), a module-level const would be frozen at import time
 * (before loadTranslations() has run), always returning English.
 *
 * @param {string} str — English source string
 * @returns {() => string} — call to get the current translation
 *
 * @example
 * const LABEL = lt('Save');   // defined at module load
 * // ...later, after loadTranslations('es', {...}) runs:
 * console.log(LABEL());       // → 'Guardar'
 */
export function lt(str) {
  return () => t(str);
}

// ── Auto-load from i18n/ directory ───────────────────────────//

/**
 * Attempt to load translations for the browser's preferred language.
 * Called by buildEnv() before services start.
 * Silently falls back to English (passthrough) if the file is not found.
 *
 * @returns {Promise<void>}
 */
export async function autoLoadTranslations() {
  const lang = navigator.language || 'en';
  const langCode = lang.split('-')[0].toLowerCase(); // 'en-US' → 'en'

  // Always try the full code first, then the base code
  const candidates = [lang.toLowerCase(), langCode].filter(Boolean);

  // English is the source language — no file needed, passthrough works
  if (langCode === 'en') {
    _lang = lang;
    return;
  }

  for (const code of candidates) {
    try {
      const res = await fetch(`./i18n/${code}.json`);
      if (res.ok) {
        const map = await res.json();
        loadTranslations(code, map);
        return;
      }
    } catch {
      // File not found or network error — try next candidate
    }
  }

  // No translation file found — passthrough (English source strings used as-is)
  _lang = lang;
  console.log(`[i18n] No translation file for "${lang}" — using source strings`);
}
