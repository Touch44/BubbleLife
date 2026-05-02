/**
 * FamilyHub v3 — core/object-type-registry.js
 * [MAJOR] Capacities-Inspired Object Type Registry
 *
 * Thin orchestration layer over graph-engine.js.
 * All persistence and in-memory registry management is handled by
 * graph-engine — this module adds:
 *   • Capacities-style property type catalog (PROPERTY_FIELD_TYPES)
 *   • View mode definitions (VIEW_MODES)
 *   • Dashboard section definitions (DASHBOARD_SECTION_DEFS)
 *   • A safe "custom type" save/delete API that guards built-ins
 *   • canDelete flag on every returned config
 *
 * Storage key: graph-engine uses 'entityTypes' in IDB settings — same key,
 * no duplication. Custom types saved here are immediately visible to
 * entity-form.js, entity-panel.js, and graph-engine itself.
 *
 * Exports:
 *   PROPERTY_FIELD_TYPES          — full property type catalog
 *   PROPERTY_CATEGORIES           — grouped categories for the picker UI
 *   VIEW_MODES                    — List / Gallery / Table / Wall
 *   DASHBOARD_SECTION_DEFS        — dashboard section definitions
 *   BUILT_IN_TYPE_KEYS            — Set<string> — guard set
 *   makeDefaultField(overrides?)  → ObjectField
 *   isBuiltInType(key)            → boolean
 *   generateTypeKey(label)        → string (camelCase)
 *   getAllObjectTypes()            → Promise<ObjectTypeConfig[]>
 *   getObjectTypeConfig(key)      → Promise<ObjectTypeConfig|null>
 *   getCustomObjectTypes()        → Promise<ObjectTypeConfig[]>
 *   saveCustomObjectType(config)  → Promise<ObjectTypeConfig>
 *   deleteCustomObjectType(key)   → Promise<void>
 */

import {
  getAllEntityTypes,
  getEntityTypeConfig as _getConfig,
  saveEntityType,
  archiveEntityType,
}                           from './graph-engine.js';
import { uid }              from './db.js';
import { emit, EVENTS }     from './events.js';

// ── Property Field Type Catalog ───────────────────────────────────
// Drives the property type picker in the type editor.

export const PROPERTY_FIELD_TYPES = {
  // Basic
  text:        { label: 'Text',         icon: '📝', category: 'basic',    description: 'Single-line text',          inputType: 'text' },
  richtext:    { label: 'Rich Text',    icon: '📄', category: 'basic',    description: 'Multi-line formatted text', inputType: 'richtext' },
  number:      { label: 'Number',       icon: '#',  category: 'basic',    description: 'Integer or decimal',        inputType: 'number' },
  date:        { label: 'Date',         icon: '📅', category: 'basic',    description: 'Calendar date',            inputType: 'date' },
  datetime:    { label: 'Date & Time',  icon: '🕐', category: 'basic',    description: 'Date with specific time',  inputType: 'datetime-local' },
  checkbox:    { label: 'Checkbox',     icon: '✅', category: 'basic',    description: 'True / false toggle',      inputType: 'checkbox' },
  tags:        { label: 'Tags',         icon: '🏷', category: 'basic',    description: 'Comma-separated tags',     inputType: 'tags' },
  // Choice
  select:      { label: 'Select',       icon: '⌄',  category: 'choice',   description: 'One option from a list',  inputType: 'select',      hasOptions: true },
  multiselect: { label: 'Multi-select', icon: '☑',  category: 'choice',   description: 'Multiple options',        inputType: 'multiselect', hasOptions: true },
  rating:      { label: 'Rating',       icon: '⭐', category: 'choice',   description: '1–5 star rating',          inputType: 'rating' },
  // Contact
  url:         { label: 'URL',          icon: '🔗', category: 'contact',  description: 'Web link / URL',           inputType: 'url' },
  email:       { label: 'Email',        icon: '✉',  category: 'contact',  description: 'Email address',           inputType: 'email' },
  phone:       { label: 'Phone',        icon: '📞', category: 'contact',  description: 'Phone number',             inputType: 'tel' },
  // Advanced
  relation:    { label: 'Relation',     icon: '⇄',  category: 'advanced', description: 'Link to another type',    inputType: 'relation', hasTargetType: true },
  color:       { label: 'Color',        icon: '🎨', category: 'advanced', description: 'Color picker value',       inputType: 'color' },
};

/** Grouped categories for the property type picker UI */
export const PROPERTY_CATEGORIES = [
  { key: 'basic',    label: 'Basic' },
  { key: 'choice',   label: 'Choice' },
  { key: 'contact',  label: 'Contact' },
  { key: 'advanced', label: 'Advanced' },
];

// ── Data View Modes ───────────────────────────────────────────────
// Mirrors Capacities Data Views: List, Gallery, Table, Wall

export const VIEW_MODES = [
  { key: 'list',  label: 'List',    icon: '☰', description: 'Compact row list' },
  { key: 'grid',  label: 'Gallery', icon: '📊', description: 'Card grid view' },
  { key: 'table', label: 'Table',   icon: '📋', description: 'Spreadsheet table' },
  { key: 'wall',  label: 'Wall',    icon: '🧱', description: 'Masonry card wall' },
];

// ── Dashboard Section Definitions ────────────────────────────────

export const DASHBOARD_SECTION_DEFS = [
  { key: 'recentlyOpened', label: 'Recently Opened',     icon: '🕐' },
  { key: 'recentlyAdded',  label: 'Recently Added',      icon: '✨' },
  { key: 'allObjects',     label: 'All Objects',          icon: '📦' },
  { key: 'untagged',       label: 'Untagged Objects',    icon: '🏷' },
  { key: 'noCollection',   label: 'Not in a Collection', icon: '📁' },
  { key: 'noBacklinks',    label: 'No Backlinks',         icon: '🔗' },
];

// ── Built-in type guard ───────────────────────────────────────────
// Used to show the lock icon in the UI and prevent accidental overwrites.
// Source of truth is graph-engine's isBuiltIn flag; this Set is a fast
// UI guard so we can check without an async call.

export const BUILT_IN_TYPE_KEYS = new Set([
  'task', 'person', 'event', 'note', 'project', 'document', 'tag',
  'budgetEntry', 'recipe', 'contact', 'dateEntity', 'idea', 'research',
  'book', 'trip', 'place', 'weblink', 'mealPlan', 'shoppingItem',
  'medication', 'appointment', 'goal', 'habit',
  'activity', // system activity feed entries — not user-editable
]);

export function isBuiltInType(key) {
  // Check registry flag first (authoritative), fall back to guard set
  try {
    const cfg = _getConfig(key);
    if (cfg) return cfg.isBuiltIn === true;
  } catch { /* graph-engine not yet initialised */ }
  return BUILT_IN_TYPE_KEYS.has(key);
}

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Build a default field descriptor for a new property.
 * @param {object} [overrides]
 * @returns {ObjectField}
 */
export function makeDefaultField(overrides = {}) {
  const key = overrides.key || `field_${uid()}`;
  return {
    key,
    label:      'New Property',
    type:       'text',
    required:   false,
    isTitle:    false,
    options:    [],
    targetType: null,
    ...overrides,
    key, // ensure key is not clobbered when explicitly passed
  };
}

/**
 * Convert a display label into a safe camelCase type key.
 * e.g. "Meeting Notes" → "meetingNotes"
 * @param {string} label
 * @returns {string}
 */
export function generateTypeKey(label) {
  const words = (label || '')
    .trim()
    .replace(/[^a-zA-Z0-9 ]/g, '')
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return `type${Date.now()}`;
  return words
    .map((w, i) => i === 0
      ? w.toLowerCase()
      : w[0].toUpperCase() + w.slice(1).toLowerCase()
    )
    .join('');
}

// ── Public Read API ───────────────────────────────────────────────
// Delegates to graph-engine; adds canDelete flag.

/**
 * Return all object types: built-in + custom, with canDelete flag.
 * @returns {Promise<ObjectTypeConfig[]>}
 */
export async function getAllObjectTypes() {
  const all = getAllEntityTypes({ includeArchived: false });
  return all.map(t => ({ ...t, canDelete: !t.isBuiltIn }));
}

/**
 * Get config for a single type, or null if not found.
 * @param {string} key
 * @returns {Promise<ObjectTypeConfig|null>}
 */
export async function getObjectTypeConfig(key) {
  const cfg = _getConfig(key);
  if (!cfg) return null;
  return { ...cfg, canDelete: !cfg.isBuiltIn };
}

/**
 * Get only the user-created (non-built-in) types.
 * @returns {Promise<ObjectTypeConfig[]>}
 */
export async function getCustomObjectTypes() {
  const all = getAllEntityTypes({ includeArchived: false });
  return all
    .filter(t => !t.isBuiltIn)
    .map(t => ({ ...t, canDelete: true }));
}

// ── Public Write API ──────────────────────────────────────────────
// Delegates persistence and event emission to graph-engine.

/**
 * Create or update a custom object type.
 * Delegates to graph-engine.saveEntityType() which handles persistence
 * (IDB key 'entityTypes'), in-memory registry, and fires EVENTS.TYPE_CREATED.
 *
 * @param {object} config - Must have at minimum: { label }
 * @returns {Promise<ObjectTypeConfig>}
 */
export async function saveCustomObjectType(config) {
  if (!config.label) throw new Error('Object type requires a label');

  const key = config.key || generateTypeKey(config.label);

  // Guard: don't allow structural replacement of a built-in type
  if (isBuiltInType(key) && !config._allowBuiltInOverride) {
    throw new Error(`Cannot overwrite built-in type "${key}"`);
  }

  const titleField = {
    key: 'title', label: 'Title', type: 'text',
    isTitle: true, required: true,
  };

  const toSave = {
    // Defaults
    icon:              '📎',
    color:             '#6366f1',
    defaultView:       'list',
    graphVisible:      true,
    fields:            [titleField],
    defaultSort:       '-createdAt',
    dashboardSections: ['recentlyOpened', 'allObjects'],
    description:       '',
    // Caller's config overrides defaults
    ...config,
    // Ensure key and timestamps are correct
    key,
    isBuiltIn:  false,
    updatedAt:  new Date().toISOString(),
    createdAt:  config.createdAt || new Date().toISOString(),
  };

  // Ensure a title field always exists
  if (!toSave.fields.some(f => f.isTitle)) {
    toSave.fields = [titleField, ...toSave.fields];
  }

  // graph-engine handles: _registry update, IDB persist, TYPE_CREATED emit
  return saveEntityType(toSave);
}

/**
 * Delete a custom object type.
 * Built-in types throw. Custom types are removed from the registry.
 * Emits TYPE_FIELD_REMOVED { deleted: true } so the Object Studio re-renders.
 *
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function deleteCustomObjectType(key) {
  if (isBuiltInType(key)) {
    throw new Error(`Built-in type "${key}" cannot be deleted`);
  }
  // archiveEntityType removes custom types from the registry and persists
  await archiveEntityType(key);
  // archiveEntityType doesn't emit an event — signal the UI ourselves
  emit(EVENTS.TYPE_FIELD_REMOVED, { typeKey: key, deleted: true });
}
