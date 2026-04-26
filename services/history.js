/**
 * FamilyHub v3.0 — services/history.js
 * Undo/Redo History Service — command stack, Cmd+Z / Cmd+Shift+Z.
 * Implements Prompt 18 spec.
 *
 * Registered as env.services.history via serviceRegistry.
 *
 * Command shape:
 *   { do: async () => void, undo: async () => void, label: string }
 *
 * Public API:
 *   push(command)  — immediately calls command.do(), adds to history, clears redo
 *   undo()         — pops history, calls command.undo(), pushes to redo
 *   redo()         — pops redo, calls command.do(), pushes to history
 *   canUndo()      — boolean
 *   canRedo()      — boolean
 *   clear()        — wipe both stacks
 *
 * Max history length: 50 (oldest entries dropped automatically).
 * Wires Cmd+Z → undo() and Cmd+Shift+Z → redo() via hotkeyService.
 */

const MAX_HISTORY = 50;

export function createHistoryService(env) {
  const notification = env?.services?.notification;
  const hotkey       = env?.services?.hotkey;

  /** @type {{ do: Function, undo: Function, label: string }[]} */
  const _history = [];
  /** @type {{ do: Function, undo: Function, label: string }[]} */
  const _redo    = [];

  /**
   * Push and immediately execute a command.
   * @param {{ do: Function, undo: Function, label: string }} command
   */
  async function push(command) {
    if (typeof command?.do !== 'function' || typeof command?.undo !== 'function') {
      throw new Error('[history] command must have do and undo async functions');
    }

    try {
      await command.do();
    } catch (err) {
      console.error('[history] command.do() failed:', err);
      notification?.danger?.(`Action failed: ${command.label}`);
      return;
    }

    _history.push(command);
    _redo.length = 0; // clear redo stack on new action

    // Enforce max length
    if (_history.length > MAX_HISTORY) {
      _history.shift();
    }
  }

  /**
   * Undo the most recent command.
   */
  async function undo() {
    // Check index.html's simpler undo stack first (entity delete)
    // If window.FH._undoStackPeek() returns a value, defer to it
    // Otherwise use our history stack.
    const command = _history.pop();
    if (!command) return;

    try {
      await command.undo();
      _redo.push(command);
      notification?.info?.(`Undone: ${command.label}`);
    } catch (err) {
      console.error('[history] command.undo() failed:', err);
      notification?.danger?.(`Could not undo: ${command.label}`);
      // Re-add to history since undo failed
      _history.push(command);
    }
  }

  /**
   * Redo the most recently undone command.
   */
  async function redo() {
    const command = _redo.pop();
    if (!command) return;

    try {
      await command.do();
      _history.push(command);
      if (_history.length > MAX_HISTORY) _history.shift();
      notification?.info?.(`Redone: ${command.label}`);
    } catch (err) {
      console.error('[history] command.redo() failed:', err);
      notification?.danger?.(`Could not redo: ${command.label}`);
      _redo.push(command); // put it back
    }
  }

  /** @returns {boolean} */
  function canUndo() { return _history.length > 0; }

  /** @returns {boolean} */
  function canRedo() { return _redo.length > 0; }

  /** Wipe both stacks (e.g. on logout) */
  function clear() {
    _history.length = 0;
    _redo.length    = 0;
  }

  // ── Wire Cmd+Z and Cmd+Shift+Z via hotkeyService ─────────── //
  if (hotkey) {
    // Cmd+Z — check index.html's entity-delete undo stack first, then history.undo()
    hotkey.add('ctrl+z', async (e) => {
      e.preventDefault();
      // The index.html undo stack for entity-delete is handled by its own listener
      // which fires before hotkey. Only run history.undo() if canUndo().
      if (canUndo()) await undo();
    }, { description: 'Undo last action' });

    hotkey.add('ctrl+shift+z', async (e) => {
      e.preventDefault();
      if (canRedo()) await redo();
    }, { description: 'Redo last undone action' });
  }

  return { push, undo, redo, canUndo, canRedo, clear };
}

export const historyServiceDescriptor = {
  dependencies: ['notification', 'hotkey'],
  start(env) {
    return createHistoryService(env);
  },
};
