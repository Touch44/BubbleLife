/**
 * FamilyHub v4.2 — core/env.js
 * Shared environment object passed to every service and view.
 * Inspired by Odoo's env pattern.
 *
 * Public API:
 *   buildEnv()  — async, resolves services in dependency order, returns frozen env
 *   getEnv()    — returns the current env (null before buildEnv completes)
 *
 * env shape:
 *   {
 *     services: { [name]: serviceInstance },
 *     bus:      EventBus (on, off, emit, once),
 *     version:  '3.0.0',
 *     debug:    boolean,
 *   }
 */

import { serviceRegistry } from './registry.js';
import { on, off, emit, once } from './events.js';
import { autoLoadTranslations } from './i18n.js';

/** @type {Object|null} */
let _env = null;

/**
 * Returns the current env object.
 * Null before buildEnv() completes.
 * @returns {Object|null}
 */
export function getEnv() {
  return _env;
}

/**
 * Build and return the shared environment object.
 * Resolves all services from serviceRegistry in dependency order,
 * calls each service's start(env, resolvedDeps) method,
 * then freezes and returns the env.
 *
 * @returns {Promise<Object>} frozen env
 */
export async function buildEnv() {
  console.log('[env] Building environment...');

  // Check for debug mode via URL param
  const debug = new URLSearchParams(window.location.search).get('debug') === 'true';

  // Build the event bus wrapper (delegates to events.js)
  const bus = { on, off, emit, once };

  // Construct the env — services will be populated below
  const env = {
    services: {},
    bus,
    version: '3.0.0',
    debug,
  };

  // Auto-load translations for browser language (P-04)
  // Must run before services start so t() works in service start() methods
  await autoLoadTranslations();

  // Resolve and start all services in dependency order
  const started = new Set();
  const inProgress = new Set();

  /**
   * Recursively start a service after its dependencies are ready.
   * @param {string} name
   */
  async function startService(name) {
    if (started.has(name)) return;
    if (inProgress.has(name)) {
      throw new Error(`[env] Circular service dependency detected: "${name}"`);
    }

    const descriptor = serviceRegistry.get(name);
    if (!descriptor) {
      throw new Error(`[env] Service "${name}" not found in serviceRegistry`);
    }

    inProgress.add(name);

    // Start dependencies first
    const deps = descriptor.dependencies || [];
    const resolvedDeps = {};

    for (const depName of deps) {
      await startService(depName);
      resolvedDeps[depName] = env.services[depName];
    }

    // Call the service's start() method
    try {
      const instance = await descriptor.start(env, resolvedDeps);
      env.services[name] = instance || {};
      started.add(name);
      inProgress.delete(name);
      if (debug) console.log(`[env] Service started: ${name}`);
    } catch (err) {
      inProgress.delete(name);
      console.error(`[env] Failed to start service "${name}":`, err);
      throw err;
    }
  }

  // Start all registered services
  for (const [name] of serviceRegistry.getAll()) {
    await startService(name);
  }

  // Freeze env to prevent accidental mutation
  Object.freeze(env.services);
  Object.freeze(env);

  _env = env;
  console.log(`[env] Environment ready — ${started.size} service(s) loaded`);

  return env;
}
