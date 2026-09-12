import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext, TT, GD } from './_setup.mjs';
import { validateAll, indexIssues, worstSeverity } from '../src/services/validation-service.js';

const run = (ctx) => validateAll({ store: ctx.store, selectors: ctx.selectors, dependencies: ctx.dependencies });
const codes = (issues) => issues.map((i) => i.code);

test('demo data reports the intentional missing reference and unplaced draft, nothing else at error level', async () => {
  const ctx = await createContext();
  const issues = run(ctx);
  const errors = issues.filter((i) => i.severity === 'error');
  assert.deepEqual(codes(errors), ['BINDING_REF_MISSING']);
  assert.equal(errors[0].metricId, 'm-room-nights-available');
  assert.ok(issues.some((i) => i.code === 'METRIC_UNPLACED' && i.metricId === 'm-ebitda'));
  assert.ok(issues.some((i) => i.code === 'BINDING_CROSS_SCENARIO' && i.metricId === 'm-revenue'));
  const idx = indexIssues(issues);
  assert.equal(worstSeverity(idx.byMetric.get('m-room-nights-available')), 'error');
  assert.equal(idx.bySeverity.error, 1);
});

test('metric rules: duplicate code, missing name, approved unplaced, missing unit', async () => {
  const ctx = await createContext();
  await ctx.repo.saveMany('metrics', [
    { id: 'x1', code: 'M.000001', name: 'Dup', status: 'approved', aliases: [], version: 1 },
    { id: 'x2', code: 'M.999', name: '', status: 'draft', aliases: [], version: 1 },
    { id: 'x3', code: 'M.998', name: 'Approved but lost', status: 'approved', unitId: 'u-missing', aliases: [], version: 1 },
  ]);
  ctx.store.hydrate(await ctx.repo.loadAll());
  const c = codes(run(ctx));
  assert.ok(c.includes('METRIC_DUPLICATE_CODE'));
  assert.ok(c.includes('METRIC_MISSING_NAME'));
  assert.ok(c.includes('METRIC_APPROVED_UNPLACED'));
  assert.ok(c.includes('METRIC_UNIT_MISSING'));
});

test('binding rules: syntax, ambiguous, unbound target, missing source info, assumption basis', async () => {
  const ctx = await createContext();
  await ctx.bindings.setBinding('m-co2-per-trip', TT, { type: 'formula', formulaText: '[VOLUME] *' });
  await ctx.bindings.setBinding('m-ebitda', TT, { type: 'source', source: {} });
  await ctx.bindings.setBinding('m-ebitda', GD, { type: 'assumption', assumption: { value: '', basis: '' } });
  await ctx.bindings.setBinding('m-margin', GD, { type: 'formula', formulaText: '[COMPLAINTS]' }); // complaints has no GD binding
  const c = codes(run(ctx));
  assert.ok(c.includes('BINDING_FORMULA_SYNTAX'));
  assert.ok(c.includes('BINDING_SOURCE_MISSING_INFO'));
  assert.ok(c.includes('BINDING_ASSUMPTION_MISSING_VALUE'));
  assert.ok(c.includes('BINDING_ASSUMPTION_MISSING_BASIS'));
  assert.ok(c.includes('BINDING_REF_TARGET_UNBOUND'));
});

test('dependency cycles are reported as errors with the path', async () => {
  const ctx = await createContext();
  await ctx.bindings.setBinding('m-price', TT, { type: 'formula', formulaText: '[REVENUE] / [VOLUME]' });
  const issues = run(ctx).filter((i) => i.code === 'DEPENDENCY_CYCLE');
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /Doanh thu/);
  assert.equal(issues[0].cycle.length, 2);
});

test('dimension rules: duplicate code, invalid parent, maxLevel beyond depth, orphan link', async () => {
  const ctx = await createContext();
  await ctx.repo.saveMany('dimensions', [{ id: 'dx', code: 'dim01', name: 'Dup dim', version: 1 }]);
  await ctx.repo.saveMany('dimensionMembers', [{ id: 'mx', dimensionId: 'd-entity', parentId: 'dm-taxi', code: 'MX', name: 'Wrong parent', level: 2, version: 1 }]);
  await ctx.repo.saveMany('metricDimensions', [
    { id: 'lx', metricId: 'm-revenue', dimensionId: 'd-channel', maxLevel: 5, required: false, version: 1 },
    { id: 'ly', metricId: 'm-gone', dimensionId: 'd-channel', required: false, version: 1 },
  ]);
  ctx.store.hydrate(await ctx.repo.loadAll());
  const c = codes(run(ctx));
  assert.ok(c.includes('DIMENSION_DUPLICATE_CODE'));
  assert.ok(c.includes('MEMBER_INVALID_PARENT'));
  assert.ok(c.includes('METRIC_DIMENSION_MAXLEVEL'));
  assert.ok(c.includes('METRIC_DIMENSION_ORPHAN'));
  assert.ok(c.includes('METRIC_DIMENSION_DUPLICATE'));
});

test('structure rules: parent cycle is surfaced, never hidden', async () => {
  const ctx = await createContext();
  await ctx.repo.saveMany('structureNodes', [
    { id: 'c1', parentId: 'c2', name: 'C1', sortOrder: 1, version: 1 },
    { id: 'c2', parentId: 'c1', name: 'C2', sortOrder: 1, version: 1 },
  ]);
  ctx.store.hydrate(await ctx.repo.loadAll());
  const tree = ctx.selectors.structureTree();
  assert.ok(tree.byId.get('c1') && tree.byId.get('c2'));
  assert.ok(codes(run(ctx)).includes('STRUCTURE_CYCLE'));
});
