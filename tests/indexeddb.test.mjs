import test from 'node:test';
import assert from 'node:assert/strict';
import { freshFactory, freshDbName, openRepo, openTab, reload, rawOpen, rawDone, rawAll } from './_idb.mjs';
import { TT, GD } from './_setup.mjs';
import { COLLECTIONS, tokenOf } from '../src/repositories/repository.js';
import { createMetric } from '../src/core/models/metric.js';
import { createBinding } from '../src/core/models/binding.js';
import { createStructureNode } from '../src/core/models/structure.js';

/**
 * The IndexedDB adapter, exercised against a real IndexedDB implementation.
 *
 * Everything here is invisible to the MemoryRepository suite: transaction
 * ordering, unique indexes, schema upgrades, and two connections that share
 * a database but not a mirror. Each test that models two tabs opens two
 * repositories on one factory.
 */

// ------------------------------------------------------------ schema upgrade

test('upgrading a database that holds a duplicate relationship keeps the data', async () => {
  const factory = freshFactory();
  const dbName = freshDbName();
  // A version-2 database as the previous release wrote it: no unique index,
  // and the same metric placed twice in one node, which v2 allowed.
  const db = await rawOpen(factory, dbName, 2, (d) => {
    for (const c of COLLECTIONS) d.createObjectStore(c, { keyPath: 'id' });
    d.createObjectStore('_restorePoints', { keyPath: 'id' });
  });
  const tx = db.transaction(['metrics', 'structureNodes', 'metricStructures'], 'readwrite');
  tx.objectStore('metrics').put({ id: 'm-1', name: 'Chỉ tiêu quan trọng', code: 'M.000001', version: 1, aliases: [], tags: [] });
  tx.objectStore('structureNodes').put({ id: 's-1', name: 'Nhóm', parentId: null, sortOrder: 1, version: 1 });
  tx.objectStore('metricStructures').put({ id: 'ms-1', metricId: 'm-1', structureNodeId: 's-1', isPrimary: true, version: 1 });
  tx.objectStore('metricStructures').put({ id: 'ms-2', metricId: 'm-1', structureNodeId: 's-1', isPrimary: false, version: 1 });
  await rawDone(tx);
  db.close();

  const repo = await openRepo(factory, dbName);
  const info = repo.describe();
  assert.equal(info.persistent, true, `the upgrade must succeed: ${info.detail}`);
  const snapshot = await repo.loadAll();
  assert.equal(snapshot.metrics.length, 1, 'the user still sees their metric');
  assert.equal(snapshot.metricStructures.length, 1, 'one of the two duplicate placements was kept');
  assert.equal(snapshot.metricStructures[0].id, 'ms-1', 'the primary placement is the one kept');
  assert.ok(info.migration && info.migration.deduplicated === 1, 'the repair is reported');
  repo.close();
});

test('an upgrade blocked by an older tab is reported as blocked, not as an empty catalogue', async () => {
  const factory = freshFactory();
  const dbName = freshDbName();
  // An old tab holds a v2 connection and, being old code, never closes it on
  // versionchange.
  const old = await rawOpen(factory, dbName, 2, (d) => {
    for (const c of COLLECTIONS) d.createObjectStore(c, { keyPath: 'id' });
  });
  const tx = old.transaction('metrics', 'readwrite');
  tx.objectStore('metrics').put({ id: 'm-1', name: 'Dữ liệu của tôi', code: 'M.000001', version: 1 });
  await rawDone(tx);

  const repo = await openRepo(factory, dbName);
  const info = repo.describe();
  assert.equal(info.persistent, false);
  assert.equal(info.reason, 'blocked', `reason: ${info.reason} (${info.detail})`);
  assert.equal(info.hasExistingData, true, 'the app must not seed a demo over this');
  old.close();
  repo.close();
});

test('a repository closes its connection when another tab upgrades the database', async () => {
  const factory = freshFactory();
  const dbName = freshDbName();
  const first = await openRepo(factory, dbName);
  await first.save('metrics', createMetric({ id: 'm-1', name: 'A', code: 'M.000001' }));
  // A newer release opens the same database at a higher version.
  const later = await new Promise((resolve, reject) => {
    const req = factory.open(dbName, 99);
    req.onupgradeneeded = () => {};
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('the old connection did not step aside'));
  });
  later.close();
  assert.equal(first.describe().persistent, false, 'the superseded connection reports it can no longer persist');
  assert.equal(first.describe().reason, 'superseded');
});

// ------------------------------------------------------------ write order

test('a batch may free a unique relationship and re-create it in the same transaction', async () => {
  const factory = freshFactory();
  const repo = await openRepo(factory, freshDbName());
  const old = await repo.save('bindings', createBinding({ metricId: 'm-1', scenarioId: TT, type: 'source' }));
  const fresh = createBinding({ metricId: 'm-1', scenarioId: TT, type: 'formula', formulaText: '[X]' });
  await repo.applyBatch([
    { op: 'remove', collection: 'bindings', id: old.id, expectedToken: tokenOf(old) },
    { op: 'save', collection: 'bindings', record: fresh, expectedToken: null },
  ]);
  const rows = await repo.list('bindings');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, fresh.id);
  assert.equal(rows[0].type, 'formula');
  repo.close();
});

test('a batch that fails leaves the database untouched, including its deletes', async () => {
  const factory = freshFactory();
  const repo = await openRepo(factory, freshDbName());
  const a = await repo.save('bindings', createBinding({ metricId: 'm-1', scenarioId: TT, type: 'source' }));
  const b = await repo.save('bindings', createBinding({ metricId: 'm-2', scenarioId: TT, type: 'source' }));
  await assert.rejects(() => repo.applyBatch([
    { op: 'remove', collection: 'bindings', id: a.id, expectedToken: tokenOf(a) },
    // Duplicates b: the unique index refuses, and the delete above must roll back too.
    { op: 'save', collection: 'bindings', record: createBinding({ metricId: 'm-2', scenarioId: TT, type: 'source' }), expectedToken: null },
  ]), (e) => e.name === 'UniquenessError');
  const rows = await repo.list('bindings');
  assert.deepEqual(rows.map((r) => r.id).sort(), [a.id, b.id].sort(), 'a is still there');
  repo.close();
});

// ------------------------------------------------------------ two tabs

test('two tabs cannot allocate the same code, even after one of them imported a catalogue', async () => {
  const factory = freshFactory();
  const dbName = freshDbName();
  const a = await openTab(factory, dbName);
  const b = await openTab(factory, dbName);

  // Tab B replaces the catalogue with one that already uses M.000001.
  b.store.hydrate(await b.repo.replaceAll({ metrics: [createMetric({ id: 'm-imported', name: 'Nhập khẩu', code: 'M.000001', version: 1 })] }));
  // Tab A, which knows nothing of that, creates a metric.
  const m = await a.metrics.create({ name: 'Từ tab A' });
  assert.notEqual(m.code, 'M.000001', 'the code the other tab imported is taken');

  // And allocating from both tabs at once never collides.
  const codes = await Promise.all([1, 2, 3].flatMap(() => [
    a.metrics.create({ name: 'a' }).then((x) => x.code),
    b.metrics.create({ name: 'b' }).then((x) => x.code),
  ]));
  assert.equal(new Set(codes).size, codes.length, `duplicates in ${codes.join(' ')}`);
  a.repo.close();
  b.repo.close();
});

test('deleting a metric takes the binding another tab just created with it', async () => {
  const factory = freshFactory();
  const dbName = freshDbName();
  const a = await openTab(factory, dbName, { seed: true });
  const b = await openTab(factory, dbName);
  const metric = await a.metrics.create({ name: 'Sắp bị xoá' });
  await reload(b);

  await b.bindings.setBinding(metric.id, GD, { type: 'source' });
  assert.equal(a.store.list('bindings').some((x) => x.metricId === metric.id), false, 'tab A has not heard of it');

  await a.metrics.remove(metric.id);
  await reload(b);
  const left = b.store.list('bindings').filter((x) => x.metricId === metric.id);
  assert.deepEqual(left, [], 'no binding outlives its metric');
  a.repo.close();
  b.repo.close();
});

test('a node cannot be moved under a parent another tab has deleted', async () => {
  const factory = freshFactory();
  const dbName = freshDbName();
  const a = await openTab(factory, dbName);
  const b = await openTab(factory, dbName);
  const victim = await a.structure.createNode({ name: 'Sắp bị xoá' });
  const mover = await a.structure.createNode({ name: 'Sẽ di chuyển' });
  await reload(b);

  await a.structure.deleteNode(victim.id);
  await assert.rejects(() => b.structure.moveNode(mover.id, victim.id), (e) => e.name === 'NotFoundError');
  await reload(b);
  const stored = b.store.get('structureNodes', mover.id);
  assert.equal(stored.parentId, null, 'the move did not land');
  a.repo.close();
  b.repo.close();
});

test('a child cannot be created under a parent another tab has deleted', async () => {
  const factory = freshFactory();
  const dbName = freshDbName();
  const a = await openTab(factory, dbName);
  const b = await openTab(factory, dbName);
  const victim = await a.structure.createNode({ name: 'Sắp bị xoá' });
  await reload(b);

  await a.structure.deleteNode(victim.id);
  await assert.rejects(() => b.structure.createNode({ name: 'Mồ côi', parentId: victim.id }), (e) => e.name === 'NotFoundError');
  await reload(b);
  assert.equal(b.store.count('structureNodes'), 0);
  a.repo.close();
  b.repo.close();
});

test('a binding cannot be created for a metric another tab has deleted', async () => {
  const factory = freshFactory();
  const dbName = freshDbName();
  const a = await openTab(factory, dbName, { seed: true });
  const b = await openTab(factory, dbName);
  const metric = await a.metrics.create({ name: 'Sắp bị xoá' });
  await reload(b);

  await a.metrics.remove(metric.id);
  await assert.rejects(() => b.bindings.setBinding(metric.id, TT, { type: 'source' }), (e) => e.name === 'NotFoundError');
  await reload(b);
  assert.equal(b.store.list('bindings').some((x) => x.metricId === metric.id), false);
  a.repo.close();
  b.repo.close();
});

test('a stale token from another tab is refused and the mirror learns the truth', async () => {
  const factory = freshFactory();
  const dbName = freshDbName();
  const a = await openRepo(factory, dbName);
  const b = await openRepo(factory, dbName);
  const saved = await a.save('metrics', createMetric({ id: 'm-1', name: 'v1', code: 'M.000001' }));
  const bView = await b.get('metrics', 'm-1');
  assert.equal(bView, null, 'b opened before the record existed');
  // b catches up, then a moves on.
  await b.refresh();
  await a.save('metrics', { ...saved, name: 'v2' }, tokenOf(saved));
  await assert.rejects(() => b.save('metrics', { ...saved, name: 'from b' }, tokenOf(saved)), (e) => e.name === 'ConflictError');
  assert.equal((await b.get('metrics', 'm-1')).name, 'v2', 'b now mirrors what the database holds');
  a.close();
  b.close();
});

// ------------------------------------------------------------ wholesale replacement

test('replaceAll resets the code sequence in the same transaction as the data', async () => {
  const factory = freshFactory();
  const dbName = freshDbName();
  const repo = await openRepo(factory, dbName);
  await repo.allocateCode('metrics', { prefix: 'M.', width: 6, pattern: /^M\.(\d+)$/ });
  await repo.allocateCode('metrics', { prefix: 'M.', width: 6, pattern: /^M\.(\d+)$/ });
  await repo.replaceAll({ metrics: [createMetric({ id: 'm-x', name: 'x', code: 'M.000010', version: 1 })] });
  const code = await repo.allocateCode('metrics', { prefix: 'M.', width: 6, pattern: /^M\.(\d+)$/ });
  assert.equal(code, 'M.000011', 'the sequence follows the new catalogue, not the old one');
  const db = await rawOpen(factory, dbName);
  const seq = await rawAll(db, '_sequences');
  db.close();
  assert.ok(seq.every((s) => s.next === 12), 'the durable sequence matches');
  repo.close();
});
