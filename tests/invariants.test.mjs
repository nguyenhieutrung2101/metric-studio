import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext, TT, GD } from './_setup.mjs';
import { ValidationFailure } from '../src/services/metric-service.js';

test('a metric exists once; TT and GD are bindings of the same identity', async () => {
  const ctx = await createContext();
  const revenue = ctx.store.get('metrics', 'm-revenue');
  const tt = ctx.selectors.bindingFor('m-revenue', TT);
  const gd = ctx.selectors.bindingFor('m-revenue', GD);
  assert.ok(revenue && tt && gd);
  assert.equal(tt.metricId, gd.metricId);
  assert.equal(tt.type, 'formula');
  assert.equal(gd.type, 'formula');
  assert.equal(tt.legacyCode, 'TT-KD001');
  assert.equal(gd.legacyCode, 'GD-KD001');
  // Legacy codes live on bindings, not on the metric.
  assert.equal(revenue.code, 'M.000001');
  // Exactly one binding per metric × scenario.
  const pairs = new Set(ctx.store.list('bindings').map((b) => `${b.metricId}|${b.scenarioId}`));
  assert.equal(pairs.size, ctx.store.count('bindings'));
});

test('metric id and code are stable across edits; codes are unique and auto-allocated', async () => {
  const ctx = await createContext();
  const created = await ctx.metrics.create({ name: 'New metric' }, { structureNodeId: 's-kd' });
  assert.match(created.code, /^M\.\d{6}$/);
  const updated = await ctx.metrics.update(created.id, { name: 'Renamed', definition: 'x' });
  assert.equal(updated.id, created.id);
  assert.equal(updated.code, created.code);
  assert.equal(updated.version, created.version + 1);
  await assert.rejects(() => ctx.metrics.create({ name: 'Dup', code: 'm.000001' }), ValidationFailure);
  await assert.rejects(() => ctx.metrics.update(created.id, { code: 'M.000001' }), ValidationFailure);
});

test('moving a metric between structure nodes does not change its bindings or id', async () => {
  const ctx = await createContext();
  const before = JSON.stringify(ctx.selectors.bindingsByMetric('m-revenue').get(TT));
  const beforeGd = JSON.stringify(ctx.selectors.bindingsByMetric('m-revenue').get(GD));
  const bindingsRev = ctx.store.revision.bindings;
  await ctx.structure.moveMetric('m-revenue', 's-kd-dt', 's-tc');
  const placements = ctx.selectors.placementsByMetric('m-revenue');
  assert.deepEqual(placements.map((p) => p.structureNodeId), ['s-tc']);
  assert.equal(JSON.stringify(ctx.selectors.bindingsByMetric('m-revenue').get(TT)), before);
  assert.equal(JSON.stringify(ctx.selectors.bindingsByMetric('m-revenue').get(GD)), beforeGd);
  assert.equal(ctx.store.revision.bindings, bindingsRev, 'bindings collection untouched');
  assert.equal(ctx.store.get('metrics', 'm-revenue').id, 'm-revenue');
  // Dependency edges are unchanged too.
  const edges = ctx.dependencies.edgesFrom('m-revenue|scn-tt').map((e) => e.targetMetricId).sort();
  assert.deepEqual(edges, ['m-price', 'm-volume']);
});

test('changing a binding does not change structural placement', async () => {
  const ctx = await createContext();
  const placementsBefore = JSON.stringify(ctx.selectors.placementsByMetric('m-volume'));
  const rev = ctx.store.revision.metricStructures;
  await ctx.bindings.setBinding('m-volume', GD, { type: 'assumption', assumption: { value: '1000000', basis: 'test' } });
  assert.equal(JSON.stringify(ctx.selectors.placementsByMetric('m-volume')), placementsBefore);
  assert.equal(ctx.store.revision.metricStructures, rev);
  assert.equal(ctx.selectors.bindingFor('m-volume', GD).type, 'assumption');
});

test('structure node moves never rewrite formulas', async () => {
  const ctx = await createContext();
  const formulas = ctx.store.list('bindings').map((b) => [b.id, b.formulaText]);
  await ctx.structure.moveNode('s-kd-dt', 's-vh');
  await ctx.structure.reorderNode('s-vh-dv-tx', 'up');
  assert.deepEqual(ctx.store.list('bindings').map((b) => [b.id, b.formulaText]), formulas);
  assert.equal(ctx.store.get('structureNodes', 's-kd-dt').parentId, 's-vh');
  await assert.rejects(() => ctx.structure.moveNode('s-vh', 's-vh-dv-cl'), ValidationFailure);
});

test('dimension members never create metrics; links are normalised', async () => {
  const ctx = await createContext();
  const metricCount = ctx.store.count('metrics');
  const dim = await ctx.dimensions.createDimension({ name: 'Product test' });
  const steel = await ctx.dimensions.createMember({ dimensionId: dim.id, name: 'Steel' });
  const hrc = await ctx.dimensions.createMember({ dimensionId: dim.id, parentId: steel.id, name: 'HRC' });
  assert.equal(hrc.level, 2);
  assert.equal(ctx.store.count('metrics'), metricCount);
  const link = await ctx.dimensions.linkMetric('m-revenue', dim.id, { required: true, maxLevel: 2 });
  const again = await ctx.dimensions.linkMetric('m-revenue', dim.id);
  assert.equal(link.id, again.id, 'linking twice is idempotent');
  assert.ok(ctx.selectors.metricDimensions('m-revenue').some((l) => l.dimensionId === dim.id));
  assert.equal(ctx.selectors.memberTree(dim.id).depth, 2);
  await ctx.dimensions.moveMember(hrc.id, null);
  assert.equal(ctx.store.get('dimensionMembers', hrc.id).level, 1);
  await assert.rejects(() => ctx.dimensions.moveMember(steel.id, steel.id), ValidationFailure);
  await ctx.dimensions.unlink(link.id);
  assert.equal(ctx.selectors.metricDimensions('m-revenue').some((l) => l.dimensionId === dim.id), false);
  assert.equal(ctx.store.count('metrics'), metricCount);
});

test('deleting a metric cascades its links but leaves referencing formulas as visible missing references', async () => {
  const ctx = await createContext();
  await ctx.metrics.remove('m-volume');
  assert.equal(ctx.store.get('metrics', 'm-volume'), null);
  assert.equal(ctx.store.list('bindings').some((b) => b.metricId === 'm-volume'), false);
  assert.equal(ctx.store.list('metricStructures').some((l) => l.metricId === 'm-volume'), false);
  assert.equal(ctx.store.list('metricDimensions').some((l) => l.metricId === 'm-volume'), false);
  const revenueTT = ctx.selectors.bindingFor('m-revenue', TT);
  assert.equal(revenueTT.formulaText, '[VOLUME] * [PRICE]');
  const edges = ctx.dependencies.edgesFrom('m-revenue|scn-tt');
  assert.ok(edges.some((e) => e.token === 'VOLUME' && !e.resolved));
});

test('structure node deletion refuses non-empty nodes unless contents move to parent', async () => {
  const ctx = await createContext();
  await assert.rejects(() => ctx.structure.deleteNode('s-kd'), ValidationFailure);
  await ctx.structure.deleteNode('s-kd-dt', { strategy: 'moveToParent' });
  assert.equal(ctx.store.get('structureNodes', 's-kd-dt'), null);
  assert.ok(ctx.selectors.placementsByMetric('m-revenue').some((p) => p.structureNodeId === 's-kd'));
  assert.equal(ctx.selectors.bindingFor('m-revenue', TT).formulaText, '[VOLUME] * [PRICE]');
});

test('primary placement bookkeeping', async () => {
  const ctx = await createContext();
  const extra = await ctx.structure.placeMetric('m-revenue', 's-tc');
  assert.equal(extra.isPrimary, false);
  await ctx.structure.setPrimary(extra.id);
  const links = ctx.selectors.placementsByMetric('m-revenue');
  assert.equal(links.filter((l) => l.isPrimary).length, 1);
  assert.equal(links.find((l) => l.isPrimary).structureNodeId, 's-tc');
});
