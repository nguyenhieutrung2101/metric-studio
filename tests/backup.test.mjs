import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext } from './_setup.mjs';
import { BackupService } from '../src/services/backup-service.js';
import { buildLargeSnapshot } from '../src/data/seed.js';
import { freshFactory, freshDbName, openTab, rawOpen, rawAll } from './_idb.mjs';
import { DB_VERSION } from '../src/repositories/local-repository.js';
import { writeWorkbook } from '../src/services/xlsx.js';
import { previewExcelImport, applyExcelImport } from '../src/services/excel-import.js';

test('export → import round-trips every collection byte for byte', async () => {
  const ctx = await createContext();
  const json = ctx.backup.exportJson();
  const parsed = JSON.parse(json);
  assert.equal(parsed.app, 'metric-studio');
  assert.equal(parsed.schemaVersion, 1);
  const fresh = await createContext({ seed: false });
  const { counts, repairs } = await fresh.backup.importSnapshot(json);
  assert.equal(counts.metrics, ctx.store.count('metrics'));
  assert.deepEqual(repairs, [], 'our own export needs no repair');
  const a = JSON.stringify(ctx.store.snapshot());
  const b = JSON.stringify(fresh.store.snapshot());
  assert.equal(a, b);
  assert.equal(fresh.selectors.bindingFor('m-revenue', 'scn-gd').parsedReferences.length, 2);
});

test('inspect rejects malformed backups', () => {
  assert.equal(BackupService.inspect('not json').ok, false);
  assert.equal(BackupService.inspect({ app: 'other', data: { metrics: [] } }).ok, false);
  assert.equal(BackupService.inspect({ data: { metrics: [{ name: 'no id' }] } }).ok, false);
  assert.equal(BackupService.inspect({ data: { metrics: 'nope' } }).ok, false);
  const good = BackupService.inspect({ metrics: [{ id: 'a', name: 'A' }] });
  assert.equal(good.ok, true);
  assert.equal(good.counts.metrics, 1);
  assert.equal(good.data.metrics[0].status, 'draft', 'records come back fully normalised');
});

test('large synthetic dataset stays acyclic, resolves and indexes quickly', async () => {
  const t0 = Date.now();
  const snap = buildLargeSnapshot({ metrics: 3000, dimensions: 120 });
  const fresh = await createContext({ seed: false });
  const { counts } = await fresh.backup.replaceWith(snap, { label: 'large' });
  assert.equal(counts.metrics, 3000);
  assert.equal(fresh.store.count('metrics'), 3000);
  assert.ok(fresh.store.count('dimensions') >= 120);
  assert.ok(fresh.store.count('metricDimensions') > 5000);
  const t1 = Date.now();
  fresh.selectors.structureTree();
  fresh.selectors.coverageSummary();
  const hits = fresh.selectors.searchMetrics('doanh thu');
  assert.ok(hits.size > 0);
  assert.equal(fresh.dependencies.findCycles().length, 0);
  const g = fresh.dependencies.subgraph({ metricId: 'L-m2999', scenarioId: 'scn-tt', depthDown: 3, depthUp: 2 });
  assert.ok(g.nodes.size < 500, 'subgraph stays focused');
  const t2 = Date.now();
  assert.ok(t2 - t1 < 2000, `indexing took ${t2 - t1}ms`);
  assert.ok(t1 - t0 < 15000, `generation took ${t1 - t0}ms`);
});

// ---------------------------------------------------------------- two tabs, one database
/**
 * F03. A restore point exists so that a destructive operation can be undone
 * without taking anything else with it. Read the catalogue, write the
 * backup, then replace: a write that lands in the middle survives the
 * operation and is missing from the backup, so undoing deletes it. The three
 * have to be one thing.
 */
test('two tabs: a write landing between the plan and the commit is inside the restore point', async () => {
  const factory = freshFactory();
  const dbName = freshDbName();
  const a = await openTab(factory, dbName, { seed: true });
  const b = await openTab(factory, dbName);
  const before = a.store.get('metrics', 'm-revenue').name;

  const wb = await writeWorkbook({ sheets: [{ name: 'Metrics', rows: [['Code', 'Name'], ['M.000001', 'Doanh thu (từ file)']] }] });
  const { plan } = await previewExcelImport(wb, a.store);
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));

  // Slip the other tab's write into the one gap there is: after this tab has
  // planned and caught up, before its own transaction opens.
  const realApply = a.repo.applyBatch.bind(a.repo);
  a.repo.applyBatch = (ops, options) => {
    a.repo.applyBatch = realApply;
    return b.metrics.create({ name: 'Chen vào giữa', code: 'M.900001' }).then(() => realApply(ops, options));
  };

  const { restorePoint } = await applyExcelImport(plan, a.backup);
  assert.ok(restorePoint, 'the import is undoable');
  const point = await a.repo.getRestorePoint(restorePoint.id);
  assert.ok(point.data.metrics.some((m) => m.code === 'M.900001'), 'the backup holds what the database held when it was written');
  assert.equal(point.data.metrics.find((m) => m.id === 'm-revenue').name, before);

  // Which is the whole point: undoing the import puts the old name back and
  // leaves the other tab's metric alone.
  await a.backup.restore(restorePoint.id);
  const stored = await rawAll(await rawOpen(factory, dbName, DB_VERSION), 'metrics');
  assert.ok(stored.some((m) => m.code === 'M.900001'), 'the other tab still has its work');
  assert.equal(stored.find((m) => m.id === 'm-revenue').name, before);
  a.repo.close(); b.repo.close();
});

test('two tabs: a JSON import replaces everything, and its restore point can put everything back', async () => {
  const factory = freshFactory();
  const dbName = freshDbName();
  const a = await openTab(factory, dbName, { seed: true });
  const b = await openTab(factory, dbName);
  // The file this tab is about to import was exported before B got to work.
  const json = a.backup.exportJson();
  const added = await b.metrics.create({ name: 'Của tab bên cạnh', code: 'M.900002' });

  const { restorePoint } = await a.backup.importSnapshot(json, { label: 'Before import' });
  const afterImport = await rawAll(await rawOpen(factory, dbName, DB_VERSION), 'metrics');
  assert.equal(afterImport.some((m) => m.id === added.id), false, 'replacing is what a JSON import does');

  // And the backup it took is of the database as it was, not as this tab
  // last saw it, so the operation is genuinely undoable.
  const point = await a.repo.getRestorePoint(restorePoint.id);
  assert.ok(point.data.metrics.some((m) => m.id === added.id), 'the backup holds the work the import was about to replace');
  await a.backup.restore(restorePoint.id);
  const restored = await rawAll(await rawOpen(factory, dbName, DB_VERSION), 'metrics');
  assert.ok(restored.some((m) => m.id === added.id), 'undo brings it back');
  a.repo.close(); b.repo.close();
});
