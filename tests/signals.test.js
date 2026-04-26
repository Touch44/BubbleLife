/**
 * FamilyHub v3.0 — tests/signals.test.js
 * Tests for the reactive signal system (core/signals.js).
 */

import { test, assert, assertEqual } from './runner.js';
import { signal, computed, effect, batch, peek } from '../core/signals.js';

test('signal: initial value readable', () => {
  const s = signal(42);
  assertEqual(s.value, 42, 'signal should return initial value');
});

test('signal: value settable', () => {
  const s = signal(0);
  s.value = 99;
  assertEqual(s.value, 99, 'signal should update on set');
});

test('signal: peek reads without tracking', () => {
  const s = signal(7);
  const peeked = s.peek();
  assertEqual(peeked, 7, 'peek should return current value');
});

test('computed: derives from signal', () => {
  const s = signal(5);
  const doubled = computed(() => s.value * 2);
  assertEqual(doubled.value, 10, 'computed should derive from signal');
});

test('computed: updates when dependency changes', () => {
  const s = signal(3);
  const squared = computed(() => s.value * s.value);
  assertEqual(squared.value, 9, 'computed should be 9');
  s.value = 4;
  assertEqual(squared.value, 16, 'computed should update to 16');
});

test('computed: chains work', () => {
  const a = signal(2);
  const b = computed(() => a.value + 1);
  const c = computed(() => b.value * 2);
  assertEqual(c.value, 6, 'chained computed should work');
  a.value = 4;
  assertEqual(c.value, 10, 'chained computed should update');
});

test('effect: runs when dependency changes', () => {
  const s = signal(0);
  let calls = 0;
  let lastVal;
  const cleanup = effect(() => { calls++; lastVal = s.value; });
  assertEqual(calls, 1, 'effect runs immediately');
  s.value = 5;
  assertEqual(calls, 2, 'effect runs on change');
  assertEqual(lastVal, 5, 'effect sees new value');
  cleanup();
  s.value = 10;
  assertEqual(calls, 2, 'effect stops after cleanup');
});

test('batch: defers notifications', () => {
  const a = signal(1);
  const b = signal(2);
  let computeCount = 0;
  const sum = computed(() => { computeCount++; return a.value + b.value; });
  const _ = sum.value; // prime
  computeCount = 0;

  batch(() => {
    a.value = 10;
    b.value = 20;
  });
  // Should only recompute once after batch ends
  const result = sum.value;
  assertEqual(result, 30, 'batch result should be 30');
  assert(computeCount <= 2, 'computed should not run more than twice in batch');
});

test('signal: does not notify on same value', () => {
  const s = signal('hello');
  let count = 0;
  const stop = effect(() => { count++; const _ = s.value; });
  assertEqual(count, 1, 'initial run');
  s.value = 'hello'; // same value
  assertEqual(count, 1, 'should not re-run for same value');
  s.value = 'world';
  assertEqual(count, 2, 'should run for new value');
  stop();
});
