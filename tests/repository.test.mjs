import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRepository } from '../src/repositories/memory-repository.js';
import { LocalRepository } from '../src/repositories/local-repository.js';
import { ConflictError, NotFoundError } from '../src/repositories/repository.js';
import { createMetric } from '../src/core/models/metric.js';

test('new record must be saved with expectedVersion null and gets version 1', async () => {
  const repo = new MemoryRepository();
  const m = createMetric({ name: 'Revenue', code: 'M.000001' });
  const saved = await repo.saveMetric(m, null);
  assert.equal(saved.version, 1);
  assert.equal(saved.id, m.id);
  await assert.rejects(() => repo.saveMetric(createMetric({ name: 'X' }), 3), ConflictError);
});

test('optimistic concurrency: stale expectedVersion is rejected with the current record', async () => {
  const repo = new MemoryRepository();
  const base = await repo.saveMetric(createMetric({ name: 'Revenue', code: 'M.000001' }), null);
  // User A and user B both hold version 1.
  const a = { ...base, name: 'Revenue (A)' };
  const b = { ...base, name: 'Revenue (B)' };
  const savedA = await repo.saveMetric(a, 1);
  assert.equal(savedA.version, 2);
  let err = null;
  try {
    await repo.saveMetric(b, 1);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof ConflictError);
  assert.equal(err.expectedVersion, 1);
  assert.equal(err.current.version, 2);
  assert.equal(err.current.name, 'Revenue (A)');
  // Stored record was not overwritten.
  assert.equal((await repo.getMetric(base.id)).name, 'Revenue (A)');
  // B reloads and saves with the fresh version.
  const savedB = await repo.saveMetric({ ...b, name: 'Revenue (B, merged)' }, 2);
  assert.equal(savedB.version, 3);
});

test('remove honours expectedVersion and reports missing records', async () => {
  const repo = new MemoryRepository();
  const saved = await repo.saveMetric(createMetric({ name: 'X', code: 'M.1' }), null);
  await assert.rejects(() => repo.deleteMetric(saved.id, 99), ConflictError);
  await repo.deleteMetric(saved.id, 1);
  await assert.rejects(() => repo.deleteMetric(saved.id, 1), NotFoundError);
  assert.equal(await repo.getMetric(saved.id), null);
});

test('returned records are copies: mutating them does not mutate storage', async () => {
  const repo = new MemoryRepository();
  const saved = await repo.saveMetric(createMetric({ name: 'X', code: 'M.1' }), null);
  saved.name = 'mutated';
  assert.equal((await repo.getMetric(saved.id)).name, 'X');
});

test('saveMany / replaceAll / loadAll bulk operations', async () => {
  const repo = new MemoryRepository();
  await repo.saveMany('metrics', [createMetric({ id: 'a', name: 'A', code: 'M.1' }), createMetric({ id: 'b', name: 'B', code: 'M.2' })]);
  assert.equal((await repo.listMetrics()).length, 2);
  await repo.replaceAll({ metrics: [createMetric({ id: 'c', name: 'C', code: 'M.3' })] });
  const all = await repo.loadAll();
  assert.deepEqual(all.metrics.map((m) => m.id), ['c']);
  assert.equal(all.metrics[0].version, 1);
});

test('LocalRepository degrades to memory when IndexedDB is unavailable', async () => {
  const repo = new LocalRepository({ indexedDB: null });
  await repo.init();
  assert.equal(repo.describe().persistent, false);
  const saved = await repo.saveMetric(createMetric({ name: 'X', code: 'M.1' }), null);
  assert.equal(saved.version, 1);
  await assert.rejects(() => repo.saveMetric(saved, 5), ConflictError);
});
