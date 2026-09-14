import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext, TT, GD } from './_setup.mjs';
import { writeWorkbook, readWorkbook } from '../src/services/xlsx.js';
import { buildTemplateWorkbook, TEMPLATE_SHEETS, catalogueRows } from '../src/services/excel-template.js';
import { readTemplateWorkbook, planExcelImport, previewExcelImport, applyExcelImport } from '../src/services/excel-import.js';
import { buildExportWorkbook, defaultExportSelection, exportSource, EXPORT_DATASETS } from '../src/services/excel-export.js';
import { validateAll } from '../src/services/validation-service.js';

/** A workbook from { SheetName: [[header...], [row...]...] }. */
async function workbookOf(sheets) {
  const bytes = await writeWorkbook({ sheets: Object.entries(sheets).map(([name, rows]) => ({ name, rows })) });
  return readWorkbook(bytes);
}

test('the blank template imports nothing: hint and example rows are skipped, every sheet is recognised', async () => {
  const ctx = await createContext();
  const bytes = await buildTemplateWorkbook({ store: ctx.store, language: 'en' });
  const { plan } = await previewExcelImport(bytes, ctx.store);
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  assert.deepEqual(plan.sheetsFound.sort(), TEMPLATE_SHEETS.map((s) => s.key).sort());
  for (const key of TEMPLATE_SHEETS.map((s) => s.key)) assert.equal(plan.rowsRead[key], 0);
  for (const c of Object.keys(plan.changes)) {
    assert.equal(plan.changes[c].created, 0, c);
    assert.equal(plan.changes[c].updated, 0, c);
  }
  assert.deepEqual(plan.warnings, []);
});

test('the template filled with the catalogue round-trips with no change at all', async () => {
  const ctx = await createContext();
  const bytes = await buildTemplateWorkbook({ store: ctx.store, language: 'vi', includeData: true });
  const { plan } = await previewExcelImport(bytes, ctx.store);
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  for (const c of Object.keys(plan.changes)) {
    assert.equal(plan.changes[c].created, 0, `${c} created`);
    assert.equal(plan.changes[c].updated, 0, `${c} updated`);
    assert.equal(plan.changes[c].removed, 0, `${c} removed`);
  }
  assert.equal(plan.changes.metrics.unchanged, ctx.store.count('metrics'));
  assert.equal(plan.changes.bindings.unchanged, ctx.store.count('bindings'));
  assert.deepEqual(plan.parsed.repairs, [], 'nothing for the schema boundary to repair');
  assert.equal(JSON.stringify(plan.snapshot), JSON.stringify(ctx.store.snapshot()));
});

test('an upsert by code: updates by code, creates the rest, resolves codes across sheets, formulas resolve', async () => {
  const ctx = await createContext();
  const revenue = ctx.store.get('metrics', 'm-revenue');
  const before = ctx.store.count('metrics');
  const wb = await workbookOf({
    Units: [['Code', 'Name', 'Skip'], ['SKIPPED', 'skipped', 'x'], ['KWH', 'Kilowatt hour', '']],
    Structure: [['Code *', 'Name *', 'Parent_Code'], ['NEW_GRP', 'New group', ''], ['NEW_SUB', 'New sub group', 'NEW_GRP']],
    Metrics: [
      ['Skip', 'Code', 'Name', 'Unit_Code', 'Status', 'Owners', 'Structure_Codes', 'Dimension_Codes'],
      ['', revenue.code, 'Doanh thu thuần', '', '', 'Finance; Sales', '', ''],
      ['', 'ENERGY', 'Energy used', 'KWH', 'approved', 'Ops', 'NEW_SUB; NEW_GRP', ''],
      ['x', 'IGNORED', 'Ignored row', '', '', '', '', ''],
    ],
    Bindings: [
      ['Metric_Code', 'Scenario_Code', 'Type', 'Formula', 'Formula_Mode', 'Source_System', 'Source_Dataset', 'Source_Field', 'Source_Frequency', 'Assumption_Value', 'Assumption_Basis', 'Status', 'Note'],
      ['ENERGY', 'TT', 'source', '', '', 'SCADA', 'meters', 'kwh_total', 'monthly', '', '', 'approved', ''],
      ['ENERGY', 'GD', 'formula', `[TT:ENERGY] * (1 + [${revenue.code}])`, 'expression', '', '', '', '', '', '', 'draft', 'plan'],
      ['energy', 'gd', 'formula', '', '', '', '', '', '', '', '', '', 'duplicate pair, different case'],
    ],
  });
  const read = readTemplateWorkbook(wb);
  assert.equal(read.sheets.units.rows.length, 1, 'the x row is skipped even with a Skip column that is not first');
  let plan = planExcelImport(read, ctx.store);
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.errors.map((e) => [e.sheet, e.row]), [['Bindings', 4]]);
  assert.match(plan.errors[0].message, /Duplicate of row 3/);

  // Drop the duplicate row and plan again.
  wb.sheets.find((s) => s.name === 'Bindings').rows.pop();
  plan = planExcelImport(readTemplateWorkbook(wb), ctx.store);
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  assert.equal(plan.changes.units.created, 1);
  assert.equal(plan.changes.structureNodes.created, 2);
  assert.equal(plan.changes.metrics.created, 1);
  assert.equal(plan.changes.metrics.updated, 1);
  assert.equal(plan.changes.metricStructures.created, 2);
  assert.equal(plan.changes.bindings.created, 2);
  assert.deepEqual(plan.parsed.repairs, []);

  const { restorePoint } = await applyExcelImport(plan, ctx.backup);
  assert.ok(restorePoint, 'a restore point was taken first');
  assert.equal(ctx.store.count('metrics'), before + 1);
  const updated = ctx.store.get('metrics', 'm-revenue');
  assert.equal(updated.name, 'Doanh thu thuần');
  assert.deepEqual(updated.owners, ['Finance', 'Sales']);
  assert.equal(updated.unitId, revenue.unitId, 'a blank cell keeps the value');
  assert.equal(updated.version, revenue.version + 1);
  const energy = ctx.store.list('metrics').find((m) => m.code === 'ENERGY');
  assert.ok(energy);
  assert.equal(ctx.store.get('units', energy.unitId).code, 'KWH');
  const placements = ctx.selectors.placementsByMetric(energy.id);
  assert.equal(placements.length, 2);
  const sub = ctx.store.list('structureNodes').find((n) => n.code === 'NEW_SUB');
  assert.equal(placements.find((p) => p.isPrimary).structureNodeId, sub.id, 'the first structure code is the primary placement');
  assert.equal(ctx.store.get('structureNodes', sub.parentId).code, 'NEW_GRP');
  const gd = ctx.selectors.bindingFor(energy.id, GD);
  assert.equal(gd.type, 'formula');
  assert.deepEqual(gd.parsedReferences.map((r) => r.status), ['resolved', 'resolved']);
  assert.equal(gd.parsedReferences[0].scenarioId, TT);
  assert.deepEqual(gd.formulaErrors, []);
  const tt = ctx.selectors.bindingFor(energy.id, TT);
  assert.equal(tt.source.system, 'SCADA');
  assert.equal(tt.source.frequency, 'monthly');
  assert.equal(ctx.dependencies.edgesFrom(`${energy.id}|${GD}`).length, 2);
});

test('rows that cannot be applied are errors with sheet and row; nothing is imported until fixed', async () => {
  const ctx = await createContext();
  const product = ctx.store.get('dimensions', 'd-product').code;
  const wb = await workbookOf({
    Metrics: [['Code', 'Name', 'Unit_Code', 'Status'], ['A1', 'One', 'NOPE', ''], ['A2', 'Two', '', 'live'], ['', 'No code', '', ''], ['A4', '', '', '']],
    Bindings: [['Metric_Code', 'Scenario_Code', 'Type', 'Formula'], ['A1', 'XX', 'formula', '[A2]'], [ctx.store.get('metrics', 'm-trip-capacity').code, 'GD', 'formula', ''], ['A1', 'TT', 'guess', '']],
    Members: [['Dimension_Code', 'Code', 'Name', 'Parent_Code'], ['NODIM', 'M1', 'Member', ''], [product, 'M2', 'Loop', 'M2']],
    Extra: [['whatever'], ['x']],
  });
  const plan = planExcelImport(readTemplateWorkbook(wb), ctx.store);
  assert.equal(plan.ok, false);
  const where = plan.errors.map((e) => `${e.sheet}:${e.row}`);
  assert.deepEqual(where, ['Members:2', 'Members:3', 'Metrics:2', 'Metrics:3', 'Metrics:4', 'Metrics:5', 'Bindings:2', 'Bindings:3', 'Bindings:4']);
  assert.match(plan.errors.find((e) => e.row === 3 && e.sheet === 'Members').message, /its own parent/);
  assert.match(plan.errors.find((e) => e.row === 2 && e.sheet === 'Metrics').message, /Unit_Code "NOPE"/);
  assert.match(plan.errors.find((e) => e.row === 3 && e.sheet === 'Metrics').message, /Status must be one of/);
  assert.match(plan.errors.find((e) => e.row === 3 && e.sheet === 'Bindings').message, /Formula is required/);
  assert.ok(plan.warnings.some((w) => w.code === 'UNKNOWN_SHEET' && w.sheet === 'Extra'));
  assert.equal(plan.snapshot, null);
  assert.throws(() => applyExcelImport(plan, ctx.backup), /has errors/);
});

test('a missing required column is reported once, on the header row; a title row above the header is fine', async () => {
  const ctx = await createContext();
  const wb = await workbookOf({
    Dimensions: [['My dimensions', ''], [], ['code', 'name', 'Sort order'], ['REGION', 'Region', 3]],
    Scenarios: [['Name', 'Description'], ['Only a name', 'no code column']],
  });
  const plan = planExcelImport(readTemplateWorkbook(wb), ctx.store);
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.errors, [{ sheet: 'Scenarios', row: 1, message: 'Required column(s) missing: Code' }]);
  const read = readTemplateWorkbook(wb);
  assert.equal(read.sheets.dimensions.headerRow, 3);
  assert.deepEqual(read.sheets.dimensions.rows[0].values, { Code: 'REGION', Name: 'Region', Sort_Order: 3 });
});

test('a dash clears a value; replacing placements removes the ones not listed; members re-parent and re-level', async () => {
  const ctx = await createContext();
  const revenue = ctx.store.get('metrics', 'm-revenue');
  const placementsBefore = ctx.selectors.placementsByMetric('m-revenue').length;
  const root = ctx.store.list('structureNodes').find((n) => !n.parentId);
  const child = ctx.store.list('structureNodes').find((n) => n.parentId === root.id);
  const product = ctx.store.get('dimensions', 'd-product');
  const members = ctx.store.list('dimensionMembers').filter((m) => m.dimensionId === product.id);
  const leaf = members.find((m) => m.parentId);
  const wb = await workbookOf({
    Structure: [['Code', 'Name', 'Parent_Code'], [child.code, '', '-']],
    Metrics: [['Code', 'Name', 'Unit_Code', 'Structure_Codes', 'Dimension_Codes'], [revenue.code, '', '-', root.code, '-']],
    Members: [['Dimension_Code', 'Code', 'Name', 'Parent_Code'], [product.code, leaf.code, '', '-']],
  });
  const plan = planExcelImport(readTemplateWorkbook(wb), ctx.store);
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  assert.equal(plan.changes.metricStructures.removed, placementsBefore - (ctx.selectors.placementsByMetric('m-revenue').some((p) => p.structureNodeId === root.id) ? 1 : 0));
  assert.ok(plan.changes.metricDimensions.removed >= 1);
  await applyExcelImport(plan, ctx.backup);
  assert.equal(ctx.store.get('metrics', 'm-revenue').unitId, null);
  assert.deepEqual(ctx.selectors.placementsByMetric('m-revenue').map((p) => p.structureNodeId), [root.id]);
  assert.equal(ctx.selectors.metricDimensions('m-revenue').length, 0);
  assert.equal(ctx.store.get('structureNodes', child.id).parentId, null);
  const relevelled = ctx.store.get('dimensionMembers', leaf.id);
  assert.equal(relevelled.parentId, null);
  assert.equal(relevelled.level, 1);
});

test('free-text formulas import as text mode and are warnings, not syntax errors', async () => {
  const ctx = await createContext();
  const revenue = ctx.store.get('metrics', 'm-revenue');
  const wb = await workbookOf({
    Bindings: [['Metric_Code', 'Scenario_Code', 'Type', 'Formula', 'Formula_Mode'], [revenue.code, 'GD', 'formula', `Per the SOP table from [${revenue.code}] and [TT:${revenue.code}] (see appendix`, 'text']],
  });
  const plan = planExcelImport(readTemplateWorkbook(wb), ctx.store);
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  await applyExcelImport(plan, ctx.backup);
  const b = ctx.selectors.bindingFor('m-revenue', GD);
  assert.equal(b.formulaMode, 'text');
  assert.deepEqual(b.formulaErrors, []);
  assert.equal(b.parsedReferences.length, 2);
  const issues = validateAll({ store: ctx.store, selectors: ctx.selectors, dependencies: ctx.dependencies }).filter((i) => i.entity.id === b.id);
  assert.ok(issues.some((i) => i.code === 'BINDING_FORMULA_FREE_TEXT'));
  assert.ok(!issues.some((i) => i.code === 'BINDING_FORMULA_SYNTAX'));
});

test('the Excel report: chosen datasets and fields, a cover sheet, themed headers', async () => {
  const ctx = await createContext();
  const issues = validateAll({ store: ctx.store, selectors: ctx.selectors, dependencies: ctx.dependencies });
  const source = exportSource({ store: ctx.store, dependencies: ctx.dependencies, issues, describeIssue: (i) => i.message });
  const all = defaultExportSelection();
  assert.equal(all.length, EXPORT_DATASETS.length);
  const { bytes, sheets } = await buildExportWorkbook(source, [
    { key: 'metrics', fields: ['Code', 'Name', 'Unit_Name', 'Structure_Path'] },
    { key: 'bindings', fields: ['Metric_Code', 'Scenario_Code', 'Type', 'Formula', 'Formula_Mode'] },
    { key: 'quality', fields: ['Severity', 'Rule', 'Metric_Code', 'Message'] },
    { key: 'dependencies', fields: ['Edge_ID', 'Target_Code', 'Source_Code', 'Sequence'] },
  ], { language: 'vi' });
  assert.deepEqual(sheets.map((s) => s.name), ['Chỉ tiêu', 'Gắn kịch bản', 'Vấn đề chất lượng', 'Cạnh phụ thuộc']);
  const wb = await readWorkbook(bytes);
  assert.deepEqual(wb.sheets.map((s) => s.name), ['Báo cáo', 'Chỉ tiêu', 'Gắn kịch bản', 'Vấn đề chất lượng', 'Cạnh phụ thuộc']);
  assert.deepEqual(wb.sheets[1].rows[0], ['Mã', 'Tên', 'Tên đơn vị', 'Vị trí chính']);
  assert.equal(wb.sheets[1].rows.length, ctx.store.count('metrics') + 1);
  const revenueRow = wb.sheets[1].rows.find((r) => r[0] === ctx.store.get('metrics', 'm-revenue').code);
  assert.ok(revenueRow[3].includes('›'), 'the primary placement path is spelled out');
  assert.equal(wb.sheets[2].rows.length, ctx.store.count('bindings') + 1);
  assert.ok(wb.sheets[2].rows.some((r) => r[4] === 'text'), 'the free-text demo formula shows its mode');
  assert.equal(wb.sheets[3].rows.length, issues.length + 1);
  assert.equal(wb.sheets[4].rows.length, ctx.dependencies.referenceRows().length + 1);
  assert.equal(wb.sheets[0].rows[0][0], 'Metric Studio — báo cáo');
  await assert.rejects(buildExportWorkbook(source, [], {}), /Nothing selected/);

  // Every dataset, every field, still builds and reads.
  const full = await buildExportWorkbook(source, all, { language: 'en', cover: false });
  const fullWb = await readWorkbook(full.bytes);
  assert.equal(fullWb.sheets.length, EXPORT_DATASETS.length);
  const rows = catalogueRows(ctx.store);
  assert.equal(fullWb.sheets[0].rows.length, rows.metrics.length + 1);
});
