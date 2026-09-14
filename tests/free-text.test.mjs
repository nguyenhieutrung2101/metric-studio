import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext, TT, GD } from './_setup.mjs';
import { parseFormula } from '../src/services/formula-parser.js';
import { validateAll } from '../src/services/validation-service.js';
import { parseSnapshot } from '../src/services/snapshot-schema.js';
import { bindingRows, BINDING_COLUMNS, EDGE_COLUMNS } from '../src/services/export-tables.js';
import { isFreeTextFormula } from '../src/core/models/binding.js';

const TEXT = 'Weighted by the SOP v3 table: [VOLUME] against [TT:TRIP_CAPACITY], seasonally adjusted (appendix 2) [';

test('text mode: no syntax errors, references from brackets only, unclosed bracket is prose', () => {
  const asExpression = parseFormula(TEXT);
  assert.ok(asExpression.errors.length > 0, 'the same text is a syntax error as an expression');
  const p = parseFormula(TEXT, { mode: 'text' });
  assert.equal(p.ok, true);
  assert.deepEqual(p.errors, []);
  assert.equal(p.ast, null);
  assert.deepEqual(p.references.map((r) => [r.token, r.scenarioCode]), [['VOLUME', null], ['TRIP_CAPACITY', 'TT']]);
  assert.equal(p.references[0].start, TEXT.indexOf('[VOLUME]'));
  assert.equal(parseFormula('   ', { mode: 'text' }).isEmpty, true);
  assert.deepEqual(parseFormula('nothing [] here', { mode: 'text' }).references, []);
});

test('a free-text formula saves without errors, resolves its declared references and is a warning, not an error', async () => {
  const ctx = await createContext();
  const { binding, resolution } = await ctx.bindings.setBinding('m-trip-capacity', GD, { type: 'formula', formulaText: TEXT, formulaMode: 'text' });
  assert.equal(binding.formulaMode, 'text');
  assert.deepEqual(binding.formulaErrors, []);
  assert.equal(resolution.mode, 'text');
  assert.deepEqual(binding.parsedReferences.map((r) => r.status), ['resolved', 'resolved']);
  assert.equal(isFreeTextFormula(binding), true);

  const issues = validateAll({ store: ctx.store, selectors: ctx.selectors, dependencies: ctx.dependencies }).filter((i) => i.entity.id === binding.id);
  assert.ok(!issues.some((i) => i.code === 'BINDING_FORMULA_SYNTAX'), 'never a syntax error');
  const warn = issues.find((i) => i.code === 'BINDING_FORMULA_FREE_TEXT');
  assert.ok(warn, 'always a free-text warning');
  assert.equal(warn.severity, 'warning');
  assert.equal(warn.params.count, 2);

  // The graph still knows what the description says it consists of.
  const edges = ctx.dependencies.edgesFrom(`m-trip-capacity|${GD}`);
  assert.equal(edges.length, 2);
  assert.ok(edges.every((e) => e.formulaMode === 'text'));
  assert.ok(edges.some((e) => e.isCrossScenario && e.targetScenarioId === TT));
  const rows = ctx.dependencies.referenceRows().filter((r) => r.bindingId === binding.id);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].astPath, '', 'no AST, no path');
});

test('a free-text formula with no bracketed input warns about it, with count 0', async () => {
  const ctx = await createContext();
  const { binding } = await ctx.bindings.setBinding('m-trip-capacity', GD, { type: 'formula', formulaText: 'See the capacity model in the planning workbook', formulaMode: 'text' });
  const warn = validateAll({ store: ctx.store, selectors: ctx.selectors, dependencies: ctx.dependencies }).find((i) => i.entity.id === binding.id && i.code === 'BINDING_FORMULA_FREE_TEXT');
  assert.ok(warn);
  assert.equal(warn.params.count, 0);
  assert.match(warn.message, /declares no metric reference/);
});

test('switching back to expression mode checks the text again', async () => {
  const ctx = await createContext();
  await ctx.bindings.setBinding('m-trip-capacity', GD, { type: 'formula', formulaText: TEXT, formulaMode: 'text' });
  const { binding } = await ctx.bindings.setBinding('m-trip-capacity', GD, { type: 'formula', formulaText: TEXT, formulaMode: 'expression' });
  assert.equal(binding.formulaMode, 'expression');
  assert.ok(binding.formulaErrors.length > 0);
});

test('formula mode survives export → import and the schema boundary reparses in the right mode', async () => {
  const ctx = await createContext();
  await ctx.bindings.setBinding('m-trip-capacity', GD, { type: 'formula', formulaText: TEXT, formulaMode: 'text' });
  const json = ctx.backup.exportJson();
  const parsed = parseSnapshot(json);
  assert.equal(parsed.ok, true);
  const b = parsed.data.bindings.find((x) => x.metricId === 'm-trip-capacity' && x.scenarioId === GD);
  assert.equal(b.formulaMode, 'text');
  assert.deepEqual(b.formulaErrors, [], 'reparsed as text, so no syntax error is invented');
  assert.equal(b.parsedReferences.length, 2);
  // An older file without the field is an expression, as it always was.
  const legacy = parseSnapshot({ metrics: [{ id: 'a', name: 'A', code: 'A' }], scenarios: [{ id: 's', code: 'TT', name: 'Actual' }], bindings: [{ id: 'b', metricId: 'a', scenarioId: 's', type: 'formula', formulaText: 'hello world' }] });
  assert.equal(legacy.data.bindings[0].formulaMode, 'expression');
  assert.ok(legacy.data.bindings[0].formulaErrors.length > 0);
});

test('the demo catalogue carries one free-text example and the export tables say which mode a formula is in', async () => {
  const ctx = await createContext();
  const demo = ctx.store.list('bindings').filter(isFreeTextFormula);
  assert.equal(demo.length, 1);
  assert.equal(demo[0].metricId, 'm-vehicle-utilization');
  const rows = bindingRows(ctx.store);
  const col = BINDING_COLUMNS.find(([name]) => name === 'Formula_Mode')[1];
  assert.equal(col(rows.find((r) => r.bindingId === demo[0].id)), 'text');
  assert.equal(col(rows.find((r) => r.metricId === 'm-revenue' && r.scenario === 'TT')), 'expression');
  assert.equal(col(rows.find((r) => r.type === 'source')), '');
  assert.ok(EDGE_COLUMNS.some(([name]) => name === 'Formula_Mode'));
});
