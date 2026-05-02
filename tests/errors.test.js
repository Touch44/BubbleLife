/**
 * FamilyHub v4.2 — tests/errors.test.js
 * Tests for error classes and result tuple helpers.
 */

import { test, assert, assertEqual, assertThrows } from './runner.js';
import {
  ok, err,
  AppError, ValidationError, NotFoundError, AuthError, NetworkError,
  isAppError,
} from '../core/errors.js';

test('ok() returns [null, value] tuple', () => {
  const [error, value] = ok(42);
  assert(error === null, 'ok() error slot should be null');
  assertEqual(value, 42, 'ok() value slot');
});

test('err() returns [error, null] tuple', () => {
  const e = new Error('boom');
  const [error, value] = err(e);
  assert(error === e, 'err() error slot should be the error');
  assert(value === null, 'err() value slot should be null');
});

test('ValidationError is an AppError', () => {
  const e = new ValidationError('email', 'Invalid format');
  assert(isAppError(e), 'ValidationError should pass isAppError');
  assert(e instanceof AppError, 'should be instanceof AppError');
  assert(e.field === 'email', 'should have field');
  assert(e.message.includes('Invalid'), 'should have message');
});

test('NotFoundError has correct properties', () => {
  const e = new NotFoundError('task', 'abc-123');
  assert(isAppError(e), 'NotFoundError should be AppError');
  assert(e.entityType === 'task', 'should have entityType');
  assert(e.entityId   === 'abc-123', 'should have entityId');
});

test('AuthError is an AppError', () => {
  const e = new AuthError('Not logged in');
  assert(isAppError(e), 'AuthError should be AppError');
});

test('NetworkError is an AppError', () => {
  const e = new NetworkError('Timeout', 408);
  assert(isAppError(e), 'NetworkError should be AppError');
  assert(e.statusCode === 408, 'should have statusCode');
});

test('isAppError returns false for plain Error', () => {
  const e = new Error('plain');
  assert(!isAppError(e), 'plain Error should not pass isAppError');
});

test('ok() with undefined value', () => {
  const [error, value] = ok();
  assert(error === null, 'error should be null');
  assert(value === undefined, 'value should be undefined');
});
