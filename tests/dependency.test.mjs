import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext, TT, GD } from './_setup.mjs';
import { DependencyService } from '../src/services/dependency-service.js';

test('edges are generated from formula bindings and cached per revision', async () => {
  const ctx = await createContext();
  const out = ctx.dependencies.edgesFrom(`m-revenue|${TT}`);
  assert.deepEqual(out.map((e) => e.targetMetricId).sort(), ['m-price', 'm-volume']);
  assert.ok(out.every((e) => e.targetScenarioId === TT && !e.isCrossScenario && e.resolved));
  const first = ctx.dependencies.edges();
  assert.equal(ctx.dependencies.edges(), first, 'cached instance reused');
  await ctx.bindings.setBinding('m-price', TT, { type: 'formula', formulaText: '[REVENUE] / [VOLUME]' });
  assert.notEqual(ctx.dependencies.edges(), first, 'cache invalidated after change');
});

test('explicit cross-scenario references produce edges into the other scenario', async () => {
  const ctx = await createContext();
  const out = ctx.dependencies.edgesFrom(`m-revenue|${GD}`);
  const cross = out.find((e) => e.targetMetricId === 'm-revenue');
  assert.ok(cross, 'GD revenue references TT revenue');
  assert.equal(cross.targetScenarioId, TT);
  assert.equal(cross.isCrossScenario, true);
  const growth = out.find((e) => e.targetMetricId === 'm-growth-rate');
  assert.equal(growth.targetScenarioId, GD);
  assert.equal(growth.isCrossScenario, false);
  // Incoming index sees the cross edge from the TT side.
  assert.ok(ctx.dependencies.edgesTo(`m-revenue|${TT}`).some((e) => e.from === `m-revenue|${GD}`));
});

test('unresolved references are kept as unresolved edges and never create metrics', async () => {
  const ctx = await createContext();
  const count = ctx.store.count('metrics');
  const out = ctx.dependencies.edgesFrom(`m-room-nights-available|${GD}`);
  const missing = out.find((e) => e.token === 'DAYS_IN_PERIOD');
  assert.ok(missing);
  assert.equal(missing.resolved, false);
  assert.equal(missing.targetMetricId, null);
  assert.equal(ctx.store.count('metrics'), count);
});

test('focused subgraph respects depth, mode and expansion', async () => {
  const ctx = await createContext();
  const same = ctx.dependencies.subgraph({ metricId: 'm-revenue', scenarioId: GD, mode: 'same', depthDown: 3, depthUp: 1 });
  assert.equal(same.root, `m-revenue|${GD}`);
  const ttRevenue = same.nodes.get(`m-revenue|${TT}`);
  assert.ok(ttRevenue, 'cross-scenario target shown');
  assert.equal(ttRevenue.external, true, 'but marked external in same-scenario mode');
  assert.equal(same.nodes.has(`m-volume|${TT}`), false, 'external node is not expanded');

  const cross = ctx.dependencies.subgraph({ metricId: 'm-revenue', scenarioId: GD, mode: 'cross', depthDown: 3, depthUp: 1 });
  assert.ok(cross.nodes.has(`m-volume|${TT}`), 'cross mode follows into the other scenario');

  const shallow = ctx.dependencies.subgraph({ metricId: 'm-revenue', scenarioId: TT, depthDown: 0, depthUp: 0 });
  assert.equal(shallow.nodes.size, 1);
  assert.equal(shallow.nodes.get(`m-revenue|${TT}`).hasMoreDown, true);
  assert.equal(shallow.nodes.get(`m-revenue|${TT}`).hasMoreUp, true);

  const expanded = ctx.dependencies.subgraph({ metricId: 'm-revenue', scenarioId: TT, depthDown: 0, depthUp: 0, expanded: new Set([`m-revenue|${TT}`]) });
  assert.ok(expanded.nodes.has(`m-volume|${TT}`));
  const collapsed = ctx.dependencies.subgraph({ metricId: 'm-margin', scenarioId: TT, depthDown: 5, collapsed: new Set([`m-revenue|${TT}`]) });
  assert.equal(collapsed.nodes.has(`m-volume|${TT}`), false);
  assert.equal(collapsed.nodes.get(`m-revenue|${TT}`).hasMoreDown, true);
});

test('upstream (dependents) are included up to depthUp', async () => {
  const ctx = await createContext();
  const g = ctx.dependencies.subgraph({ metricId: 'm-volume', scenarioId: TT, depthDown: 0, depthUp: 2 });
  assert.ok(g.nodes.has(`m-revenue|${TT}`));
  assert.ok(g.nodes.has(`m-margin|${TT}`), 'two levels up');
  assert.ok(g.nodes.get(`m-revenue|${TT}`).depth < 0);
});

test('cycle detection finds direct and indirect cycles', async () => {
  const ctx = await createContext();
  assert.equal(ctx.dependencies.findCycles().length, 0, 'demo data is acyclic');
  await ctx.bindings.setBinding('m-price', TT, { type: 'formula', formulaText: '[REVENUE] / [VOLUME]' });
  const cycles = ctx.dependencies.findCycles();
  assert.equal(cycles.length, 1);
  assert.deepEqual([...cycles[0]].sort(), [`m-price|${TT}`, `m-revenue|${TT}`]);
  assert.ok(ctx.dependencies.cycleMembers().has(`m-revenue|${TT}`));
  await ctx.bindings.setBinding('m-trip-capacity', TT, { type: 'formula', formulaText: '[TRIP_CAPACITY] * 1' });
  assert.equal(ctx.dependencies.findCycles().length, 2, 'self reference is a cycle');
});

test('reachable helper walks a subgraph in either direction', async () => {
  const ctx = await createContext();
  const g = ctx.dependencies.subgraph({ metricId: 'm-margin', scenarioId: TT, depthDown: 4, depthUp: 0 });
  const down = DependencyService.reachable(`m-margin|${TT}`, g.edges, 'down');
  assert.ok(down.has(`m-volume|${TT}`));
  const up = DependencyService.reachable(`m-volume|${TT}`, g.edges, 'up');
  assert.ok(up.has(`m-margin|${TT}`));
});

test('formula resolution suggests metrics and reports ambiguity without creating anything', async () => {
  const ctx = await createContext();
  const preview = ctx.bindings.preview('[VOLUM] + [TT:OPEX] + [XX:REVENUE]', GD);
  const volum = preview.references.find((r) => r.token === 'VOLUM');
  assert.equal(volum.status, 'missing');
  assert.ok(volum.suggestions.some((s) => s.id === 'm-volume'));
  const opex = preview.references.find((r) => r.token === 'OPEX');
  assert.equal(opex.status, 'resolved');
  assert.equal(opex.isCrossScenario, true);
  assert.equal(preview.references.find((r) => r.token === 'REVENUE').status, 'unknown-scenario');
  await ctx.metrics.create({ name: 'Doanh thu', code: 'M.900001' });
  const amb = ctx.bindings.preview('[Doanh thu]', TT);
  assert.equal(amb.references[0].status, 'ambiguous');
  assert.equal(amb.references[0].candidates.length, 2);
});

test('createDraftFromReference is explicit, keeps the token as alias and re-resolves the binding', async () => {
  const ctx = await createContext();
  const binding = ctx.selectors.bindingFor('m-room-nights-available', GD);
  await assert.rejects(() => ctx.bindings.createDraftFromReference(binding.id, 'DAYS_IN_PERIOD', {}), /structure node/);
  const { metric, binding: refreshed } = await ctx.bindings.createDraftFromReference(binding.id, 'DAYS_IN_PERIOD', { structureNodeId: 's-gd', name: 'Số ngày trong kỳ' });
  assert.equal(metric.status, 'draft');
  assert.deepEqual(metric.aliases, ['DAYS_IN_PERIOD']);
  assert.ok(ctx.selectors.placementsByMetric(metric.id).some((p) => p.structureNodeId === 's-gd'));
  assert.ok(refreshed.parsedReferences.find((r) => r.token === 'DAYS_IN_PERIOD').metricId === metric.id);
  assert.ok(ctx.dependencies.edgesFrom(`m-room-nights-available|${GD}`).every((e) => e.resolved));
});
