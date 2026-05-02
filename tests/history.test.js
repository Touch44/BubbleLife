/**
 * FamilyHub v4.2 — tests/history.test.js
 * Tests for the history service (undo/redo).
 */

import { test, assert, assertEqual } from './runner.js';
import { buildMockEnv, resetMockData } from './mock-env.js';
import { createHistoryService } from '../services/history.js';

let history;

test('Setup history service', async () => {
  const env = await buildMockEnv();
  history = createHistoryService(env);
  assert(typeof history.push === 'function', 'push should exist');
  assert(typeof history.undo === 'function', 'undo should exist');
  assert(typeof history.redo === 'function', 'redo should exist');
});

test('push: executes command immediately', async () => {
  let done = false;
  await history.push({
    label: 'Set done',
    do:   async () => { done = true; },
    undo: async () => { done = false; },
  });
  assert(done, 'command.do() should have run');
  assert(history.canUndo(), 'should be able to undo');
  assert(!history.canRedo(), 'should not be able to redo yet');
});

test('undo: reverses last command', async () => {
  let value = 'original';
  await history.push({
    label: 'Change value',
    do:   async () => { value = 'changed'; },
    undo: async () => { value = 'original'; },
  });
  assertEqual(value, 'changed', 'should be changed after do');
  await history.undo();
  assertEqual(value, 'original', 'should be original after undo');
});

test('redo: re-applies undone command', async () => {
  let count = 0;
  await history.push({
    label: 'Increment',
    do:   async () => { count++; },
    undo: async () => { count--; },
  });
  assertEqual(count, 1, 'count should be 1 after do');
  await history.undo();
  assertEqual(count, 0, 'count should be 0 after undo');
  assert(history.canRedo(), 'should be able to redo');
  await history.redo();
  assertEqual(count, 1, 'count should be 1 after redo');
});

test('push: clears redo stack', async () => {
  let a = 0, b = 0;
  await history.push({ label: 'A', do: async () => { a=1; }, undo: async () => { a=0; } });
  await history.undo();
  assert(history.canRedo(), 'can redo after undo');
  // Push new command — clears redo
  await history.push({ label: 'B', do: async () => { b=1; }, undo: async () => { b=0; } });
  assert(!history.canRedo(), 'redo should be cleared after new push');
});

test('canUndo / canRedo: correct state tracking', async () => {
  history.clear();
  assert(!history.canUndo(), 'should not be able to undo on empty stack');
  assert(!history.canRedo(), 'should not be able to redo on empty stack');
  await history.push({ label: 'X', do: async () => {}, undo: async () => {} });
  assert(history.canUndo(), 'can undo after push');
  await history.undo();
  assert(history.canRedo(), 'can redo after undo');
});

test('clear: resets both stacks', async () => {
  await history.push({ label: 'clear-test', do: async () => {}, undo: async () => {} });
  assert(history.canUndo(), 'can undo before clear');
  history.clear();
  assert(!history.canUndo(), 'cannot undo after clear');
  assert(!history.canRedo(), 'cannot redo after clear');
});
