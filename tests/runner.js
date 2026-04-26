/**
 * FamilyHub v3.0 — tests/runner.js
 * Minimal test runner — browser and Node compatible.
 */

const _tests = [];
let _results = [];

export function test(name, fn) { _tests.push({ name, fn }); }

export function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

export function assertEqual(a, b, label) {
  const as = JSON.stringify(a), bs = JSON.stringify(b);
  if (as !== bs) throw new Error(`${label || 'assertEqual'}: ${as} !== ${bs}`);
}

export async function assertThrows(fn, label) {
  try { await fn(); } catch { return; }
  throw new Error(`${label || 'assertThrows'}: expected throw, did not`);
}

export async function run() {
  _results = [];
  let passed = 0, failed = 0;
  for (const { name, fn } of _tests) {
    const t0 = performance.now();
    try {
      await fn();
      const ms = Math.round(performance.now() - t0);
      _results.push({ name, ok: true, ms });
      passed++;
    } catch (err) {
      const ms = Math.round(performance.now() - t0);
      _results.push({ name, ok: false, ms, error: err.message });
      failed++;
    }
  }
  return { passed, failed, total: _tests.length, results: _results };
}

export function getResults() { return _results; }
