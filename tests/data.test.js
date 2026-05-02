/**
 * FamilyHub v4.2 — tests/data.test.js
 * Tests for the mock data service (CRUD operations).
 */

import { test, assert, assertEqual } from './runner.js';
import { buildMockEnv, resetMockData } from './mock-env.js';

let env;

test('Setup mock env', async () => {
  env = await buildMockEnv();
  resetMockData();
  assert(env.services.data, 'data service should exist');
});

test('saveEntity: creates new entity with generated id', async () => {
  const data = env.services.data;
  const saved = await data.saveEntity({ type: 'task', title: 'Test Task' }, 'user-1');
  assert(saved.id, 'saved entity should have an id');
  assert(saved.createdAt, 'saved entity should have createdAt');
  assertEqual(saved.type, 'task', 'type should be preserved');
  assertEqual(saved.title, 'Test Task', 'title should be preserved');
  assertEqual(saved.createdBy, 'user-1', 'createdBy should be set');
});

test('saveEntity: updates existing entity', async () => {
  const data = env.services.data;
  const created = await data.saveEntity({ type: 'note', title: 'Original' });
  const updated = await data.saveEntity({ ...created, title: 'Updated' });
  assertEqual(updated.id, created.id, 'id should be preserved on update');
  assertEqual(updated.title, 'Updated', 'title should be updated');
  assert(updated.updatedAt > created.updatedAt || updated.updatedAt === updated.createdAt, 'updatedAt should be fresh');
});

test('getEntity: returns entity by id', async () => {
  const data = env.services.data;
  const saved = await data.saveEntity({ type: 'idea', title: 'My Idea' });
  const found = await data.getEntity(saved.id);
  assert(found, 'entity should be found');
  assertEqual(found.title, 'My Idea', 'title should match');
});

test('getEntity: returns null for unknown id', async () => {
  const data = env.services.data;
  const found = await data.getEntity('non-existent-id');
  assert(found === null, 'should return null for missing entity');
});

test('getEntitiesByType: returns only matching type', async () => {
  const data = env.services.data;
  resetMockData();
  await data.saveEntity({ type: 'task', title: 'Task A' });
  await data.saveEntity({ type: 'task', title: 'Task B' });
  await data.saveEntity({ type: 'note', title: 'Note A' });
  const tasks = await data.getEntitiesByType('task');
  assertEqual(tasks.length, 2, 'should return 2 tasks');
  assert(tasks.every(t => t.type === 'task'), 'all results should be tasks');
});

test('deleteEntity: soft-deletes entity', async () => {
  const data = env.services.data;
  const saved = await data.saveEntity({ type: 'task', title: 'To Delete' });
  await data.deleteEntity(saved.id);
  const found = await data.getEntity(saved.id);
  assert(found === null, 'deleted entity should not be returned by getEntity');
});

test('saveEdge: creates edge between entities', async () => {
  const data = env.services.data;
  const e1 = await data.saveEntity({ type: 'task', title: 'Task' });
  const e2 = await data.saveEntity({ type: 'person', name: 'Alice' });
  const edge = await data.saveEdge({ fromId: e1.id, toId: e2.id, relation: 'assignedTo' }, 'user-1');
  assert(edge.id, 'edge should have id');
  assertEqual(edge.fromId, e1.id, 'fromId should match');
  assertEqual(edge.toId, e2.id, 'toId should match');
  assertEqual(edge.relation, 'assignedTo', 'relation should match');
});

test('getEdgesFrom: returns edges from entity', async () => {
  const data = env.services.data;
  resetMockData();
  const e1 = await data.saveEntity({ type: 'task', title: 'Task' });
  const e2 = await data.saveEntity({ type: 'person', name: 'Bob' });
  const e3 = await data.saveEntity({ type: 'person', name: 'Carol' });
  await data.saveEdge({ fromId: e1.id, toId: e2.id, relation: 'assignedTo' });
  await data.saveEdge({ fromId: e1.id, toId: e3.id, relation: 'assignedTo' });
  const edges = await data.getEdgesFrom(e1.id, 'assignedTo');
  assertEqual(edges.length, 2, 'should return 2 edges');
});

test('getSetting / setSetting: stores and retrieves values', async () => {
  const data = env.services.data;
  await data.setSetting('test:key', { value: 42, name: 'hello' });
  const result = await data.getSetting('test:key');
  assertEqual(result, { value: 42, name: 'hello' }, 'setting should round-trip');
});

test('getSetting: returns undefined for missing key', async () => {
  const data = env.services.data;
  const result = await data.getSetting('non-existent-key');
  assert(result === undefined, 'missing key should return undefined');
});

test('exportAll: includes all entities and edges', async () => {
  const data = env.services.data;
  resetMockData();
  await data.saveEntity({ type: 'task', title: 'T1' });
  await data.saveEntity({ type: 'note', title: 'N1' });
  const exported = await data.exportAll();
  assert(Array.isArray(exported.entities), 'entities should be array');
  assertEqual(exported.entities.length, 2, 'should export 2 entities');
});
