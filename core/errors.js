/**
 * FamilyHub v4.2 — core/errors.js
 * Typed error taxonomy and result-tuple convention.
 *
 * Convention: all async service methods return [error|null, value|null] tuples.
 * Never throw. Use ok() and err() helpers to construct tuples.
 *
 * Public API:
 *   UserError, ValidationError, StorageError, NotFoundError, ConflictError
 *   ok(value)      → [null, value]
 *   err(error)     → [error, null]
 *   unwrap(result, fallback) → value or fallback
 *   isAppError(e)  → boolean
 */

// ══════════════════════════════════════════════════════════════
// Error Classes
// ══════════════════════════════════════════════════════════════

/**
 * UserError — the user did something correctable.
 * Shows as a warning toast. User can retry.
 * @example throw new UserError('Title is required')
 */
export class UserError extends Error {
  /** @type {'UserError'} */
  type = 'UserError';

  /**
   * @param {string} message — Human-readable, shown directly in UI
   */
  constructor(message) {
    super(message);
    this.name = 'UserError';
  }
}

/**
 * ValidationError — a field-level data constraint was violated.
 * Shows as inline field highlight rather than a toast.
 * @example throw new ValidationError('dueDate', 'Due date cannot be in the past')
 */
export class ValidationError extends Error {
  /** @type {'ValidationError'} */
  type = 'ValidationError';

  /**
   * @param {string} field   — The field name that failed validation
   * @param {string} message — Human-readable error
   */
  constructor(field, message) {
    super(message);
    this.name = 'ValidationError';
    /** @type {string} */
    this.field = field;
  }
}

/**
 * StorageError — an IndexedDB operation failed.
 * Shows as a persistent danger dialog with "Report & Reload" option.
 * @example throw new StorageError('Failed to save task', originalErr)
 */
export class StorageError extends Error {
  /** @type {'StorageError'} */
  type = 'StorageError';

  /**
   * @param {string} message
   * @param {Error}  [cause]  — Original error from IndexedDB
   */
  constructor(message, cause) {
    super(message);
    this.name = 'StorageError';
    if (cause) this.cause = cause;
  }
}

/**
 * NotFoundError — requested entity ID does not exist.
 * Shows as a warning toast. Caller should navigate away or refresh.
 * @example throw new NotFoundError('task', 'abc-123')
 */
export class NotFoundError extends Error {
  /** @type {'NotFoundError'} */
  type = 'NotFoundError';

  /**
   * @param {string} entityType
   * @param {string} entityId
   */
  constructor(entityType, entityId) {
    super(`${entityType} not found: ${entityId}`);
    this.name = 'NotFoundError';
    this.entityType = entityType;
    this.entityId = entityId;
  }
}

/**
 * ConflictError — concurrent modification detected.
 * Shows as a warning toast with "Reload" action.
 * @example throw new ConflictError('task', 'abc-123')
 */
export class ConflictError extends Error {
  /** @type {'ConflictError'} */
  type = 'ConflictError';

  /**
   * @param {string} entityType
   * @param {string} entityId
   */
  constructor(entityType, entityId) {
    super(`Conflict: ${entityType} ${entityId} was modified by another session`);
    this.name = 'ConflictError';
    this.entityType = entityType;
    this.entityId = entityId;
  }
}

// ══════════════════════════════════════════════════════════════
// Result Tuple Helpers
//
// Convention: [error|null, value|null]
//   [null, value] — success
//   [error, null] — failure
//
// Usage:
//   const [err, result] = await dataService.create('tasks', {...});
//   if (err) { handleError(err); return; }
//   use(result);
// ══════════════════════════════════════════════════════════════

/**
 * Wrap a successful value in a result tuple.
 * @template T
 * @param {T} value
 * @returns {[null, T]}
 */
// ── AuthError ────────────────────────────────────────────── //
/**
 * Thrown when an action requires authentication or authorisation
 * that the current session does not have.
 */
export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
  }
}

// ── NetworkError ──────────────────────────────────────────── //
/**
 * Thrown for network-level failures (HTTP errors, timeouts, offline).
 * @property {number} [statusCode] — HTTP status code if available
 */
export class NetworkError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'NetworkError';
    this.statusCode = statusCode ?? null;
  }
}

export function ok(value) {
  return [null, value];
}

/**
 * Wrap an error in a result tuple.
 * @param {Error} error
 * @returns {[Error, null]}
 */
export function err(error) {
  return [error, null];
}

/**
 * Unwrap a result tuple, returning the value or a fallback on error.
 * Shorthand for callers that want to ignore errors with a safe default.
 *
 * @template T
 * @param {[Error|null, T|null]} result
 * @param {T} fallback
 * @returns {T}
 *
 * @example
 * const tasks = unwrap(await dataService.list('tasks'), []);
 */
export function unwrap(result, fallback) {
  if (!Array.isArray(result)) return fallback;
  const [error, value] = result;
  if (error) return fallback;
  return value ?? fallback;
}

// ══════════════════════════════════════════════════════════════
// Type Guard
// ══════════════════════════════════════════════════════════════

/** All FamilyHub error type names */
/**
 * Returns true if the value is one of FamilyHub's typed error classes.
 * @param {*} e
 * @returns {boolean}
 */
export function isAppError(e) {
  return e instanceof UserError
      || e instanceof ValidationError
      || e instanceof StorageError
      || e instanceof NotFoundError
      || e instanceof ConflictError
      || e instanceof AuthError
      || e instanceof NetworkError;
}

// ══════════════════════════════════════════════════════════════
// Notification Integration Helper
// Uses core/toast.js as fallback when env.services.notification absent
//
// Views and services call handleAppError(err, env) to display
// the right UI for each error type without knowing the details.
// ══════════════════════════════════════════════════════════════

/**
 * Route a typed AppError to the appropriate UI feedback.
 * - ValidationError  → inline field highlight (emits 'error:validation' on bus)
 * - UserError        → warning toast
 * - StorageError     → persistent danger dialog with reload option
 * - NotFoundError    → warning toast
 * - ConflictError    → warning toast with reload suggestion
 * - unknown          → danger toast (unexpected error)
 *
 * Requires env.bus and optionally env.services.notification.
 * Falls back to console.error if no notification service is available.
 *
 * @param {Error} error
 * @param {Object} env  — the shared env object
 */
export function handleAppError(error, env) {
  const notify = env?.services?.notification;
  const bus    = env?.bus;

  if (error instanceof ValidationError) {
    // Emit bus event so the entity panel can highlight the field
    bus?.emit('error:validation', { field: error.field, message: error.message });
    // Also show a subtle toast so the user knows what's wrong
    notify?.warn?.(error.message) ?? console.warn('[ValidationError]', error.message);
    return;
  }

  if (error instanceof StorageError) {
    // BUG-F fix: use toast, not browser confirm()
    const msg = `Storage error: ${error.message}. Your data may not have been saved.`;
    console.error('[StorageError]', error.message, error.cause);
    if (notify?.danger) {
      notify.danger(msg, { persistent: true, action: { label: 'Reload', onClick: () => window.location.reload() } });
    } else {
      import('./toast.js').then(({ showToast }) => {
        showToast(msg, 'error', { duration: 0, action: { label: 'Reload', onClick: () => window.location.reload() } });
      }).catch(() => console.error('[StorageError] no UI:', msg));
    }
    return;
  }

  if (error instanceof ConflictError) {
    const msg = `${error.message}. Please reload to get the latest version.`;
    notify?.warn?.(msg) ?? console.warn('[ConflictError]', msg);
    return;
  }

  if (error instanceof NotFoundError) {
    notify?.warn?.(error.message) ?? console.warn('[NotFoundError]', error.message);
    return;
  }

  if (error instanceof UserError) {
    notify?.warn?.(error.message) ?? console.warn('[UserError]', error.message);
    return;
  }

  // Unknown / unexpected error
  const msg = error?.message || 'An unexpected error occurred.';
  notify?.danger?.(msg) ?? console.error('[UnknownError]', error);
}
