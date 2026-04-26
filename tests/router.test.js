/**
 * FamilyHub v3.0 — tests/router.test.js
 * Tests for action-based router: serialisation, deserialisation, history stack.
 */

import { test, assert, assertEqual } from './runner.js';

// Router uses window — provide minimal shim for Node
if (typeof window === 'undefined') {
  global.window = {
    location: { hash: '' },
    addEventListener: () => {},
    history:   { pushState: () => {}, replaceState: () => {} },
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
  };
  global.document = {
    querySelectorAll: () => [],
    getElementById:   () => null,
    addEventListener:  () => {},
  };
}

import {
  navigate, back, forward, getCurrentView, getHistory,
  canGoBack, canGoForward, getState, VIEW_KEYS,
} from '../core/router.js';

// Reset router state between tests by re-navigating
test('navigate: records entry in history', () => {
  navigate(VIEW_KEYS.DAILY);
  const cur = getCurrentView();
  assert(cur !== null, 'should have a current view');
  assert(cur.viewKey === 'daily', 'should be daily');
});

test('navigate: same view deduplicates', () => {
  navigate(VIEW_KEYS.DAILY);
  const lenBefore = getHistory().length;
  navigate(VIEW_KEYS.DAILY);
  const lenAfter = getHistory().length;
  assertEqual(lenBefore, lenAfter, 'same view should not push new entry');
});

test('navigate: different view pushes new entry', () => {
  navigate(VIEW_KEYS.DAILY);
  const lenBefore = getHistory().length;
  navigate(VIEW_KEYS.KANBAN);
  const lenAfter = getHistory().length;
  assert(lenAfter > lenBefore, 'different view should push new entry');
});

test('getState: returns current action shape', () => {
  navigate(VIEW_KEYS.KANBAN);
  const state = getState();
  assert(state !== null, 'state should not be null');
  assert(state.view === 'kanban', 'state.view should be kanban');
  assert(typeof state.params === 'object', 'state.params should be object');
});

test('navigate with params: preserved in state', () => {
  navigate('entity-type', { entityType: 'idea', filter: 'recent' });
  const state = getState();
  assertEqual(state.view, 'entity-type', 'view');
  assertEqual(state.entityType, 'idea', 'entityType');
  assertEqual(state.filter, 'recent', 'filter');
});

test('back(): returns false when at start of history', () => {
  // Navigate forward first
  navigate(VIEW_KEYS.DAILY);
  navigate(VIEW_KEYS.KANBAN);
  // Go all the way back
  while (canGoBack()) back();
  assert(!canGoBack(), 'should not be able to go back further');
  const result = back();
  assert(result === false, 'back() should return false at start');
});

test('canGoForward: true after going back', () => {
  navigate(VIEW_KEYS.DAILY);
  navigate(VIEW_KEYS.KANBAN);
  back();
  assert(canGoForward(), 'should be able to go forward after back');
});

test('forward(): moves forward in history', () => {
  navigate(VIEW_KEYS.DAILY);
  navigate(VIEW_KEYS.KANBAN);
  back();
  const result = forward();
  assert(result === true, 'forward() should return true');
  assertEqual(getCurrentView().viewKey, 'kanban', 'should be back at kanban');
});

test('navigate action object: accepted', () => {
  navigate({ view: 'calendar', date: '2026-01-01', label: 'Jan 1' });
  const cur = getCurrentView();
  assertEqual(cur.viewKey, 'calendar', 'action object view');
  assertEqual(cur.params.date, '2026-01-01', 'action object date');
});
