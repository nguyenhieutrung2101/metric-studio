import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext, TT, GD } from './_setup.mjs';
import { MemoryRepository, UniquenessError } from '../src/repositories/memory-repository.js';
import { ConflictError, tokenOf, COLLECTIONS } from '../src/repositories/repository.js';
import { Store } from '../src/core/store/store.js';
import { createSelectors } from '../src/core/store/selectors.js';
import { BackupService } from '../src/services/backup-service.js';
import { parseSnapshot } from '../src/services/snapshot-schema.js';
import { MetricService } from '../src/services/metric-service.js';
import { StructureService } from '../src/services/structure-service.js';
import { DimensionService } from '../src/services/dimension-service.js';
import { buildDemoSnapshot } from '../src/data/seed.js';
import { createMetric } from '../src/core/models/metric.js';

/**
 * Failure integrity: what the store looks like when persistence fails
 * halfway. Every test here injects a failure and then asserts that nothing
 * was applied, in the durable store and in the memory mirror alike.
 */

/** A repository whose durable commit fails on the Nth call. */
class FlakyRepository extends MemoryRepository {
  constructor({ failOnCommit = 0, failRestorePoint = false } = {}) {
    super();
    this.failOnCommit = failOnCommit;
    this.failRestorePoint = failRestorePoint;
    this.commits = 0;
    this.durable = { puts: 0, deletes: 0, clears: 0 };
  }

  describe() {
    return { persistent: true, kind: 'flaky', atomicBatch: true, restorePoints: true };
  }

  reset({ failOnCommit = 0, failRestorePoint = false } = {}) {
    this.failOnCommit = failOnCommit;
    this.failRestorePoint = failRestorePoint;
    this.commits = 0;
    this.durable = { puts: 0, deletes: 0, clears: 0 };
  }

  async _commit(plan) {
    this.commits += 1;
    if (this.failOnCommit && this.commits === this.failOnCommit) throw new Error('disk is full');
    if (plan.clearAll) this.durable.clears += 1;
    this.durable.puts += (plan.puts || []).length;
    this.durable.deletes += (plan.deletes || []).length;
  }

  async _commitRestorePoint() {
    if (this.failRestorePoint) throw new Error('restore point storage is full');
  }
}

async function flakyContext({ failOnCommit = 0, failRestorePoint = false, seed = true } = {}) {
  const repo = new FlakyRepository();
  const store = new Store();
  const selectors = createSelectors(store);
  if (seed) store.hydrate(await repo.replaceAll(parseSnapshot(buildDemoSnapshot()).data));
  repo.reset({ failOnCommit, failRestorePoint });
  return {
    repo,
    store,
    selectors,
    metrics: new MetricService({ store, selectors, repo }),
    structure: new StructureService({ store, selectors, repo }),
    dimensions: new DimensionService({ store, selectors, repo }),
    backup: new BackupService({ store, repo }),
  };
}

// ---------------------------------------------------------------- persistence ordering
test('a failed write leaves the memory mirror untouched', async () => {
  const repo = new FlakyRepository({ failOnCommit: 1 });
  await assert.rejects(() => repo.saveMetric(createMetric({ id: 'm1', name: 'Revenue', code: 'M.1' }), null), /disk is full/);
  assert.equal(await repo.getMetric('m1'), null, 'nothing was mirrored');
  assert.deepEqual(await repo.listMetrics(), []);
});

test('a failed bulk write leaves the memory mirror untouched', async () => {
  const repo = new FlakyRepository({ failOnCommit: 1 });
  const records = [createMetric({ id: 'a', name: 'A', code: 'M.1' }), createMetric({ id: 'b', name: 'B', code: 'M.2' })];
  await assert.rejects(() => repo.saveMany('metrics', records), /disk is full/);
  assert.deepEqual(await repo.listMetrics(), [], 'no partial bulk write reaches the mirror');
});

// ---------------------------------------------------------------- replaceAll
test('a failed replaceAll keeps every collection exactly as it was', async () => {
  const ctx = await flakyContext({ failOnCommit: 1 });
  const before = JSON.stringify(await ctx.repo.loadAll());
  const metricsBefore = ctx.store.count('metrics');
  await assert.rejects(() => ctx.backup.replaceWith(buildDemoSnapshot(), { label: 'x' }), /disk is full/);
  assert.equal(JSON.stringify(await ctx.repo.loadAll()), before, 'the old catalogue survived');
  assert.equal(ctx.store.count('metrics'), metricsBefore);
  assert.equal(ctx.repo.durable.clears, 0, 'the database was never cleared without the inserts landing');
});

test('a replace still happens when the restore point cannot be written, and says so', async () => {
  const ctx = await flakyContext({ failRestorePoint: true });
  const result = await ctx.backup.replaceWith(buildDemoSnapshot(), { label: 'x' });
  assert.equal(result.restorePoint, null);
  assert.ok(result.restorePointError, 'the caller is told the safety net is missing');
  assert.ok(ctx.store.count('metrics') > 0, 'the operation itself went through');
});

test('replaceAll clears and inserts in a single commit', async () => {
  const ctx = await flakyContext();
  await ctx.backup.replaceWith(buildDemoSnapshot(), { label: 'x' });
  assert.equal(ctx.repo.commits, 1, `the whole replace is one transaction, saw ${ctx.repo.commits}`);
  assert.equal(ctx.repo.durable.clears, 1);
});

// ---------------------------------------------------------------- cascades
test('a failed cascade delete removes nothing at all', async () => {
  const ctx = await flakyContext({ failOnCommit: 1 });
  const before = {
    metrics: ctx.store.count('metrics'),
    bindings: ctx.store.count('bindings'),
    placements: ctx.store.count('metricStructures'),
    links: ctx.store.count('metricDimensions'),
  };
  await assert.rejects(() => ctx.metrics.remove('m-revenue'), /disk is full/);
  assert.ok(ctx.store.get('metrics', 'm-revenue'), 'the metric is still there');
  assert.equal(ctx.store.count('bindings'), before.bindings, 'its bindings are still there');
  assert.equal(ctx.store.count('metricStructures'), before.placements);
  assert.equal(ctx.store.count('metricDimensions'), before.links);
  assert.equal(ctx.store.count('metrics'), before.metrics);
});

test('a successful cascade delete leaves no orphan behind', async () => {
  const ctx = await createContext();
  await ctx.metrics.remove('m-revenue');
  for (const c of ['metricStructures', 'bindings', 'metricDimensions']) {
    assert.equal(ctx.store.list(c).some((r) => r.metricId === 'm-revenue'), false, `${c} has no orphan`);
  }
});

test('a failed structure delete does not move the children first', async () => {
  const ctx = await flakyContext({ failOnCommit: 1 });
  const childParents = ctx.store.list('structureNodes').filter((n) => n.parentId === 's-vh-dv').map((n) => n.id).sort();
  await assert.rejects(() => ctx.structure.deleteNode('s-vh-dv', { strategy: 'moveToParent' }), /disk is full/);
  assert.ok(ctx.store.get('structureNodes', 's-vh-dv'), 'the node survived');
  assert.deepEqual(ctx.store.list('structureNodes').filter((n) => n.parentId === 's-vh-dv').map((n) => n.id).sort(), childParents, 'its children did not move');
});

test('deleting a dimension reports a failure instead of swallowing it', async () => {
  const ctx = await flakyContext({ failOnCommit: 1 });
  const members = ctx.selectors.membersByDimension('d-product').length;
  await assert.rejects(() => ctx.dimensions.deleteDimension('d-product'), /disk is full/);
  assert.ok(ctx.store.get('dimensions', 'd-product'), 'the dimension survived');
  assert.equal(ctx.selectors.membersByDimension('d-product').length, members, 'its members survived');
});

test('deleting a dimension takes its members and links with it', async () => {
  const ctx = await createContext();
  await ctx.dimensions.deleteDimension('d-product');
  assert.equal(ctx.store.get('dimensions', 'd-product'), null);
  assert.equal(ctx.store.list('dimensionMembers').some((m) => m.dimensionId === 'd-product'), false);
  assert.equal(ctx.store.list('metricDimensions').some((l) => l.dimensionId === 'd-product'), false);
});

test('creating a metric with a placement is one transaction', async () => {
  const ctx = await flakyContext({ failOnCommit: 1 });
  const before = ctx.store.count('metrics');
  await assert.rejects(() => ctx.metrics.create({ name: 'New one' }, { structureNodeId: 's-tc' }), /disk is full/);
  assert.equal(ctx.store.count('metrics'), before, 'no metric without its placement');
});

// ---------------------------------------------------------------- uniqueness at the boundary
test('the repository refuses a second binding for the same metric and scenario', async () => {
  const ctx = await createContext();
  const existing = ctx.selectors.bindingFor('m-revenue', TT);
  await assert.rejects(() => ctx.repo.saveBinding({ ...existing, id: 'another-binding' }, null), UniquenessError);
});

test('the repository refuses a duplicate placement and a duplicate dimension link', async () => {
  const ctx = await createContext();
  const placement = ctx.selectors.placementsByMetric('m-revenue')[0];
  await assert.rejects(() => ctx.repo.saveMetricStructure({ ...placement, id: 'dup' }, null), UniquenessError);
  const link = ctx.selectors.metricDimensions('m-revenue')[0];
  await assert.rejects(() => ctx.repo.saveMetricDimension({ ...link, id: 'dup' }, null), UniquenessError);
});

test('a batch may free a unique relationship and re-create it elsewhere', async () => {
  const ctx = await createContext();
  const placement = ctx.selectors.placementsByMetric('m-revenue')[0];
  const result = await ctx.repo.applyBatch([
    { op: 'remove', collection: 'metricStructures', id: placement.id, expectedToken: tokenOf(placement) },
    { op: 'save', collection: 'metricStructures', record: { ...placement, id: 'ms-new' }, expectedToken: null },
  ]);
  assert.equal(result.saved.length, 1);
  assert.equal(result.removed.length, 1);
});

test('business codes are NOT rejected by the repository: duplicates must stay reportable', async () => {
  const ctx = await createContext();
  const metric = ctx.store.get('metrics', 'm-revenue');
  // Legacy workbooks do contain duplicated codes; the warning centre reports
  // them, the persistence layer does not refuse the import.
  const saved = await ctx.repo.saveMetric(createMetric({ name: 'Doanh thu (legacy)', code: metric.code }), null);
  assert.equal(saved.code, metric.code);
});

// ---------------------------------------------------------------- schema boundary
test('a half file that would orphan its own records is refused', () => {
  const full = buildDemoSnapshot();
  const half = { metrics: full.metrics, bindings: full.bindings };
  const parsed = parseSnapshot(half);
  assert.equal(parsed.ok, false);
  assert.match(parsed.errors.join(' '), /scenarios/);
});

test('duplicate ids and unusable records are refused, not repaired', () => {
  assert.equal(parseSnapshot({ metrics: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }] }).ok, false);
  assert.equal(parseSnapshot({ metrics: [{ id: 'a' }] }).ok, false, 'a metric with no name has no identity');
  assert.equal(parseSnapshot({ metrics: [{ id: 'a', name: 'A' }, 'nope'] }).ok, false);
});

test('orphans and duplicates inside an otherwise sound file are dropped and reported', () => {
  const full = buildDemoSnapshot();
  const parsed = parseSnapshot({
    ...full,
    bindings: [...full.bindings, { id: 'b-ghost', metricId: 'm-does-not-exist', scenarioId: TT, type: 'source' }],
    metricDimensions: [...full.metricDimensions, { id: 'md-dup', metricId: 'm-revenue', dimensionId: 'd-entity' }],
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.bindings.some((b) => b.id === 'b-ghost'), false);
  assert.equal(parsed.data.metricDimensions.filter((l) => l.metricId === 'm-revenue' && l.dimensionId === 'd-entity').length, 1);
  const codes = parsed.repairs.map((r) => r.code);
  assert.ok(codes.includes('BINDING_ORPHAN_DROPPED'));
  assert.ok(codes.includes('LINK_DUPLICATE_DROPPED'));
});

test('imported records are normalised, so no view can meet a missing field', () => {
  const parsed = parseSnapshot({ metrics: [{ id: 'm1', name: 'Revenue' }] });
  const m = parsed.data.metrics[0];
  assert.deepEqual(m.aliases, [], 'list fields always exist');
  assert.deepEqual(m.tags, []);
  assert.equal(m.status, 'draft');
  assert.equal(m.unitId, null);
  assert.equal(typeof m.definition, 'string');
});

test('a structural cycle in an imported file is broken, not carried in', () => {
  const parsed = parseSnapshot({
    metrics: [{ id: 'm1', name: 'A' }],
    structureNodes: [
      { id: 'n1', name: 'One', parentId: 'n2' },
      { id: 'n2', name: 'Two', parentId: 'n1' },
    ],
  });
  assert.equal(parsed.ok, true);
  const roots = parsed.data.structureNodes.filter((n) => !n.parentId);
  assert.equal(roots.length, 1, 'exactly one link of the cycle was cut');
  assert.ok(parsed.repairs.some((r) => r.code === 'STRUCTURE_CYCLE_BROKEN'));
});

test('member levels are recomputed from the real depth', () => {
  const parsed = parseSnapshot({
    metrics: [{ id: 'm1', name: 'A' }],
    dimensions: [{ id: 'd1', code: 'DIM01', name: 'Product' }],
    dimensionMembers: [
      { id: 'root', dimensionId: 'd1', code: 'R', name: 'Root', level: 9 },
      { id: 'child', dimensionId: 'd1', parentId: 'root', code: 'C', name: 'Child', level: 1 },
    ],
  });
  const byId = new Map(parsed.data.dimensionMembers.map((m) => [m.id, m]));
  assert.equal(byId.get('root').level, 1);
  assert.equal(byId.get('child').level, 2);
});

test('the import preview says what a file would delete', async () => {
  const ctx = await createContext();
  const onlyMetrics = { metrics: buildDemoSnapshot().metrics };
  const preview = ctx.backup.preview(onlyMetrics);
  assert.equal(preview.ok, true);
  assert.ok(preview.deleteTotal > 0, 'the user is told records would disappear');
  assert.ok(preview.willDelete.bindings > 0);
  assert.ok(preview.willDelete.dimensions > 0);
});

// ---------------------------------------------------------------- restore points
test('a restore point is written before a replace and can undo it', async () => {
  const ctx = await createContext();
  const metricsBefore = ctx.store.count('metrics');
  await ctx.metrics.create({ name: 'Only in the original' }, { structureNodeId: 's-tc' });
  const { restorePoint } = await ctx.backup.replaceWith({}, { label: 'Before clearing' });
  assert.ok(restorePoint, 'a restore point was taken');
  assert.equal(ctx.store.count('metrics'), 0, 'the catalogue really was cleared');
  await ctx.backup.restore(restorePoint.id);
  assert.equal(ctx.store.count('metrics'), metricsBefore + 1, 'everything came back');
  assert.ok(ctx.store.list('metrics').some((m) => m.name === 'Only in the original'));
});

test('restore points are capped and listed newest first', async () => {
  const ctx = await createContext();
  for (const label of ['one', 'two', 'three', 'four']) await ctx.repo.createRestorePoint(label);
  const points = await ctx.backup.listRestorePoints();
  assert.equal(points.length, 3, 'only the most recent ones are kept');
  assert.equal(points[0].label, 'four');
});

test('restoring is itself undoable', async () => {
  const ctx = await createContext();
  const first = await ctx.repo.createRestorePoint('original');
  await ctx.metrics.create({ name: 'Added after the snapshot' }, { structureNodeId: 's-tc' });
  await ctx.backup.restore(first.id);
  const points = await ctx.backup.listRestorePoints();
  assert.ok(points.some((p) => p.label === 'Before restore'), 'the pre-restore state was captured too');
});

// ---------------------------------------------------------------- concurrency contract
test('services pass an opaque token, never an arithmetic version', async () => {
  const ctx = await createContext();
  const metric = ctx.store.get('metrics', 'm-revenue');
  const saved = await ctx.metrics.update('m-revenue', { name: 'Doanh thu (A)' }, tokenOf(metric));
  assert.equal(saved.version, metric.version + 1);
  await assert.rejects(() => ctx.metrics.update('m-revenue', { name: 'Doanh thu (B)' }, tokenOf(metric)), ConflictError);
  assert.equal(ctx.store.get('metrics', 'm-revenue').name, 'Doanh thu (A)', 'the first writer is not overwritten');
});

test('a conflict inside a batch applies nothing', async () => {
  const ctx = await createContext();
  const binding = ctx.selectors.bindingFor('m-revenue', TT);
  const placement = ctx.selectors.placementsByMetric('m-revenue')[0];
  await assert.rejects(() => ctx.repo.applyBatch([
    { op: 'remove', collection: 'metricStructures', id: placement.id, expectedToken: tokenOf(placement) },
    { op: 'remove', collection: 'bindings', id: binding.id, expectedToken: 'stale' },
  ]), ConflictError);
  assert.ok(ctx.store.get('metricStructures', placement.id), 'the first removal did not happen either');
  assert.ok(await ctx.repo.get('bindings', binding.id));
});

// ---------------------------------------------------------------- store atomicity
test('the store applies a batch before any listener sees it', async () => {
  const ctx = await createContext();
  const seen = [];
  ctx.store.events.on('change', () => {
    seen.push({ metrics: ctx.store.count('metrics'), bindings: ctx.store.list('bindings').filter((b) => b.metricId === 'm-revenue').length });
  });
  await ctx.metrics.remove('m-revenue');
  assert.ok(seen.length > 0);
  for (const snapshot of seen) {
    assert.equal(snapshot.bindings, 0, 'no listener ever saw the metric gone but its bindings still there');
  }
});

// ---------------------------------------------------------------- dimension-aware references
test('the same metric with different dimension contexts stays two references', async () => {
  const ctx = await createContext();
  const preview = ctx.bindings.preview('[ROOM_NIGHTS_SOLD | Product=HRC] + [ROOM_NIGHTS_SOLD | Product=Car]', GD);
  assert.equal(preview.references.length, 2, 'two different slices are two inputs');
  assert.deepEqual(preview.references.map((r) => r.dimensionContext[0].member), ['HRC', 'Car']);
  const same = ctx.bindings.preview('[ROOM_NIGHTS_SOLD] + [room_nights_sold]', GD);
  assert.equal(same.references.length, 1, 'the same reference twice is still one');
});

test('a saved formula keeps every distinct dimension context', async () => {
  const ctx = await createContext();
  const { binding } = await ctx.bindings.setBinding('m-occupancy', GD, { type: 'formula', formulaText: '[ROOM_NIGHTS_SOLD | Entity=GSM-VN] / [ROOM_NIGHTS_AVAILABLE | Entity=GSM-VN] + [ROOM_NIGHTS_SOLD | Entity=GSM-LA]' });
  assert.equal(binding.parsedReferences.length, 3);
  const contexts = binding.parsedReferences.filter((r) => r.token === 'ROOM_NIGHTS_SOLD').map((r) => r.dimensionContext[0].member);
  assert.deepEqual(contexts, ['GSM-VN', 'GSM-LA']);
});

// ---------------------------------------------------------------- end to end
test('every collection survives an export, import and reload cycle', async () => {
  const ctx = await createContext();
  const json = ctx.backup.exportJson();
  const fresh = await createContext({ seed: false });
  await fresh.backup.importSnapshot(json);
  for (const c of COLLECTIONS) {
    assert.equal(fresh.store.count(c), ctx.store.count(c), `${c} round-tripped`);
  }
  const reloaded = await fresh.repo.loadAll();
  for (const c of COLLECTIONS) {
    assert.equal(reloaded[c].length, ctx.store.count(c), `${c} is durable, not just in memory`);
  }
});
