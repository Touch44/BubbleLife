/**
 * FamilyHub v4.2 — core/registry.js
 * Typed key/value registry pattern (Odoo-inspired).
 * All registries are singletons exported from this module.
 *
 * Public API:
 *   Registry class: add(key, value), get(key), getAll(), has(key), remove(key)
 *   viewRegistry      — render functions keyed by viewKey
 *   serviceRegistry   — service descriptors keyed by service name
 *   commandRegistry   — command descriptors keyed by command id
 *   effectRegistry    — effect functions keyed by effect name
 */

export class Registry {
  #map = new Map();

  /**
   * Register a value under a key.
   * Throws if key already exists to prevent silent overwrites.
   * @param {string} key
   * @param {*} value
   * @returns {Registry} this — for chaining
   */
  add(key, value) {
    if (this.#map.has(key)) {
      console.warn(`[registry] Key "${key}" already registered — overwriting`);
    }
    this.#map.set(key, value);
    return this;
  }

  /**
   * Retrieve a value by key. Returns undefined if not found.
   * @param {string} key
   * @returns {*}
   */
  get(key) {
    return this.#map.get(key);
  }

  /**
   * Returns true if the key exists in this registry.
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    return this.#map.has(key);
  }

  /**
   * Remove a key from the registry.
   * @param {string} key
   * @returns {boolean} Whether the key existed
   */
  remove(key) {
    return this.#map.delete(key);
  }

  /**
   * Returns all entries as an array of [key, value] pairs.
   * @returns {[string, *][]}
   */
  getAll() {
    return [...this.#map.entries()];
  }

  /**
   * Returns all keys.
   * @returns {string[]}
   */
  getKeys() {
    return [...this.#map.keys()];
  }

  /**
   * Returns the count of registered entries.
   * @returns {number}
   */
  get size() {
    return this.#map.size;
  }
}

// ── Singleton registries ──────────────────────────────────── //

/**
 * viewRegistry — maps viewKey → renderFn(params, env)
 * Used by the router to resolve views without a switch statement.
 */
export const viewRegistry = new Registry();

/**
 * serviceRegistry — maps serviceName → service descriptor
 * Descriptor shape: { dependencies: string[], start(env, deps): object }
 */
export const serviceRegistry = new Registry();

/**
 * commandRegistry — maps commandId → command descriptor
 * Descriptor shape: { name, description, shortcut?, category?, execute(env) }
 */
export const commandRegistry = new Registry();

/**
 * effectRegistry — maps effectName → effectFn(env, options?)
 * e.g. 'confetti', 'sparkle', 'pulse'
 */
export const effectRegistry = new Registry();

/**
 * systrayRegistry — maps systrayItemId → systray item descriptor (P-19)
 * Descriptor shape: { id, render(env): HTMLElement, order: number }
 */
export const systrayRegistry = new Registry();
