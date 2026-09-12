import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext } from './_setup.mjs';
import { BackupService } from '../src/services/backup-service.js';
import { buildLargeSnapshot } from '../src/data/seed.js';

test('export → import round-trips every collection byte for byte', async () => {
  const ctx = await createContext();
  const json = ctx.backup.exportJson();
  const parsed = JSON.parse(json);
  assert.equal(parsed.app, 'metric-studio');
  assert.equal(parsed.schemaVersion, 1);
  const fresh = await createContext({ seed: false });
  const counts = await fresh.backup.importSnapshot(json);
  assert.equal(counts.metrics, ctx.store.count('metrics'));
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
});

test('large synthetic dataset stays acyclic, resolves and indexes quickly', async () => {
  const t0 = Date.now();
  const snap = buildLargeSnapshot({ metrics: 3000, dimensions: 120 });
  const fresh = await createContext({ seed: false });
  const saved = await fresh.repo.replaceAll(snap);
  fresh.store.hydrate(saved);
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
