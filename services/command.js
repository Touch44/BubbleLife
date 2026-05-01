/**
 * FamilyHub v3.0 — services/command.js
 * Command service — registers, removes, and executes named commands.
 * Used by the command palette (⌘K) and keyboard shortcuts.
 *
 * Commands are backed by commandRegistry (core/registry.js).
 * Each command descriptor:
 *   {
 *     id:          string   — unique command key (e.g. 'nav.daily')
 *     label:       string   — display name in palette (e.g. 'Go to Daily Review')
 *     description: string?  — subtitle shown in palette
 *     shortcut:    string?  — hotkey hint shown in palette (e.g. 'D')
 *     category:    string?  — grouping label (e.g. 'Navigation', 'Create', 'Settings')
 *     icon:        string?  — emoji or glyph
 *     scopes:      string[] — view keys where command is visible; [] = always visible
 *     execute:     (env) => void | Promise<void>
 *   }
 *
 * Public service API (returned from start()):
 *   add(descriptor)              — register a command
 *   remove(id)                   — deregister a command
 *   execute(id, env)             — run a command by id
 *   getAll(scope?)               — all commands, optionally filtered by current scope
 *   search(query, scope?)        — fuzzy-search commands for palette
 */

import { commandRegistry } from '../core/registry.js';
import { fuzzyMatch }      from '../core/utils.js';

/** @type {Map<string, object>} — live command map (mirrors commandRegistry) */
const _commands = new Map();

/**
 * Create the command service.
 * Called by buildEnv() — no dependencies required.
 * @param {object} env
 * @returns {object} command service instance
 */
export function createCommandService(env) {

  /**
   * Register a command descriptor.
   * If a command with the same id already exists, it is replaced.
   * @param {object} descriptor
   */
  function add(descriptor) {
    if (!descriptor?.id)      throw new Error('[command] descriptor.id is required');
    if (!descriptor?.label)   throw new Error('[command] descriptor.label is required');
    if (typeof descriptor.execute !== 'function') {
      throw new Error(`[command] descriptor.execute must be a function (id: ${descriptor.id})`);
    }

    const cmd = {
      id:          descriptor.id,
      label:       descriptor.label,
      description: descriptor.description || '',
      shortcut:    descriptor.shortcut    || '',
      category:    descriptor.category    || 'General',
      icon:        descriptor.icon        || '',
      scopes:      descriptor.scopes      || [],   // empty = global
      execute:     descriptor.execute,
    };

    _commands.set(cmd.id, cmd);

    // Mirror into commandRegistry for external introspection
    if (commandRegistry.has(cmd.id)) {
      commandRegistry.remove(cmd.id);
    }
    commandRegistry.add(cmd.id, cmd);
  }

  /**
   * Remove a registered command by id.
   * @param {string} id
   */
  function remove(id) {
    _commands.delete(id);
    commandRegistry.remove(id);
  }

  /**
   * Execute a command by id.
   * @param {string} id
   * @param {object} [execEnv] — env to pass to execute(); defaults to the service's own env
   * @returns {Promise<void>}
   */
  async function execute(id, execEnv) {
    const cmd = _commands.get(id);
    if (!cmd) {
      console.warn(`[command] Unknown command: "${id}"`);
      return;
    }
    try {
      await cmd.execute(execEnv || env);
    } catch (err) {
      console.error(`[command] Error executing "${id}":`, err);
    }
  }

  /**
   * Get all commands, optionally filtered to those visible in the given scope.
   * Commands with scopes=[] are always included.
   * @param {string} [scope] — current view key (e.g. 'kanban')
   * @returns {object[]}
   */
  function getAll(scope) {
    const all = [..._commands.values()];
    if (!scope) return all;
    return all.filter(cmd =>
      cmd.scopes.length === 0 || cmd.scopes.includes(scope)
    );
  }

  /**
   * Fuzzy-search commands by label/description/shortcut.
   * Returns results sorted by score descending.
   * @param {string} query
   * @param {string} [scope]
   * @returns {{ cmd: object, score: number }[]}
   */
  function search(query, scope) {
    const pool = getAll(scope);
    if (!query?.trim()) {
      return pool.map(cmd => ({ cmd, score: 1 }));
    }

    const q = query.trim().toLowerCase();
    const results = [];

    for (const cmd of pool) {
      const labelScore    = fuzzyMatch(q, cmd.label.toLowerCase());
      const descScore     = cmd.description ? fuzzyMatch(q, cmd.description.toLowerCase()) * 0.6 : 0;
      const shortcutScore = cmd.shortcut    ? fuzzyMatch(q, cmd.shortcut.toLowerCase()) * 0.4 : 0;
      const categoryScore = cmd.category    ? fuzzyMatch(q, cmd.category.toLowerCase()) * 0.3 : 0;

      const score = Math.max(labelScore, descScore, shortcutScore, categoryScore);
      if (score > 0) {
        results.push({ cmd, score });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  // ── Seed built-in navigation commands ──────────────────── //
  _seedBuiltins(env, add);

  return { add, remove, execute, getAll, search };
}

/**
 * Register built-in navigation and utility commands.
 * @param {object} env
 * @param {Function} add
 */
function _seedBuiltins(env, add) {
  const NAV_COMMANDS = [
    { id: 'nav.dashboard', label: 'Go to Dashboard',        shortcut: 'H', icon: '⊹', category: 'Navigate', view: 'dashboard' },
    { id: 'nav.daily',    label: 'Go to Daily Review',    shortcut: 'D', icon: '◈', category: 'Navigate', view: 'daily'    },
    { id: 'nav.kanban',   label: 'Go to Tasks / Kanban',  shortcut: 'K', icon: '⊡', category: 'Navigate', view: 'kanban'   },
    { id: 'nav.calendar', label: 'Go to Calendar',        shortcut: 'C', icon: '▦', category: 'Navigate', view: 'calendar' },
    { id: 'nav.wall',     label: 'Go to Activity Center',           icon: '⬡', category: 'Navigate', view: 'activity-center' },
    { id: 'nav.graph',    label: 'Go to Knowledge Graph', shortcut: 'G', icon: '◎', category: 'Navigate', view: 'graph'    },
    { id: 'nav.notes',    label: 'Go to Notes',                     icon: '≡', category: 'Navigate', view: 'notes'    },
    { id: 'nav.budget',   label: 'Go to Budget',                    icon: '◷', category: 'Navigate', view: 'budget'   },
    { id: 'nav.recipes',  label: 'Go to Recipes',                   icon: '⊛', category: 'Navigate', view: 'recipes'  },
    { id: 'nav.settings', label: 'Go to Settings',                  icon: '⊙', category: 'Navigate', view: 'settings' },
  ];

  for (const { id, label, shortcut, icon, category, view } of NAV_COMMANDS) {
    add({
      id, label, shortcut, icon, category,
      description: `Open the ${label.replace('Go to ', '')} view`,
      scopes: [],  // global — available from any view
      execute: async () => {
        const { navigate } = await import('../core/router.js');
        navigate(view);
      },
    });
  }

  // Create commands
  const CREATE_COMMANDS = [
    { id: 'create.task',  label: 'New Task',  icon: '✅', type: 'task'  },
    { id: 'create.note',  label: 'New Note',  icon: '📝', type: 'note'  },
    { id: 'create.event', label: 'New Event', icon: '📅', type: 'event' },
    { id: 'create.idea',  label: 'New Idea',  icon: '💡', type: 'idea'  },
    { id: 'create.post',  label: 'New Post',  icon: '📌', type: 'post'  },
  ];

  for (const { id, label, icon, type } of CREATE_COMMANDS) {
    add({
      id, label, icon,
      category: 'Create',
      description: `Create a new ${type}`,
      scopes: [],
      execute: async () => {
        const { emit, EVENTS } = await import('../core/events.js');
        emit(EVENTS.FAB_CREATE, { entityType: type });
      },
    });
  }

  // Utility commands
  add({
    id: 'util.toggleTheme',
    label: 'Toggle Dark / Light Mode',
    icon: '◑',
    category: 'Settings',
    description: 'Switch between dark and light theme',
    scopes: [],
    execute: async () => {
      const current = document.documentElement.getAttribute('data-theme') || 'light';
      const next    = current === 'dark' ? 'light' : 'dark';

      // Use themeService if available — persists properly to 'settings:theme'
      const themeSvc = window._fhEnv?.services?.theme;
      if (themeSvc) {
        await themeSvc.setTheme({ mode: next });
      } else {
        // Fallback: direct DOM update + localStorage
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('fh_theme', next);
        const { emit, EVENTS } = await import('../core/events.js');
        emit(EVENTS.THEME_CHANGED, { theme: next });
      }
    },
  });

  add({
    id: 'util.shortcuts',
    label: 'Show Keyboard Shortcuts',
    icon: '⌨',
    shortcut: '?',
    category: 'Help',
    description: 'Open the keyboard shortcuts reference',
    scopes: [],
    execute: () => {
      const so = document.getElementById('shortcuts-overlay');
      if (so) {
        so.classList.add('open');
        so.setAttribute('aria-hidden', 'false');
        so.removeAttribute('inert');
      }
    },
  });
}

// ── Service descriptor for serviceRegistry ────────────────── //

/**
 * Service descriptor — registered in serviceRegistry so buildEnv() starts it.
 * @type {object}
 */
export const commandServiceDescriptor = {
  dependencies: [],
  start(env) {
    return createCommandService(env);
  },
};
