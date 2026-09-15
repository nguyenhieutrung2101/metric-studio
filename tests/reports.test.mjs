import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext } from './_setup.mjs';
import { freshFactory, freshDbName, openRepo, openTab, rawOpen, rawDone, rawAll } from './_idb.mjs';
import { DB_VERSION } from '../src/repositories/local-repository.js';
import { COLLECTIONS } from '../src/repositories/repository.js';
import { validateAll } from '../src/services/validation-service.js';
import { parseSnapshot } from '../src/services/snapshot-schema.js';
import { buildDemoSnapshot } from '../src/data/seed.js';
import { writeWorkbook, readWorkbook } from '../src/services/xlsx.js';
import { readTemplateWorkbook, planExcelImport, previewExcelImport } from '../src/services/excel-import.js';
import { buildTemplateWorkbook } from '../src/services/excel-template.js';
import { buildExportWorkbook, exportSource, EXPORT_DATASETS } from '../src/services/excel-export.js';
import { ReportKind } from '../src/core/models/report.js';

/**
 * Reports: where a metric is shown, as opposed to where it belongs.
 *
 * A folder holds folders and reports; a report holds metrics. The service
 * enforces both, the schema boundary repairs what a file gets wrong, the
 * validator reports what is left, and the database carries the two new
 * stores through an upgrade without touching the old ones.
 */

const run = (ctx) => validateAll({ store: ctx.store, selectors: ctx.selectors, dependencies: ctx.dependencies });
const codes = (issues) => issues.map((i) => i.code);

async function workbookOf(sheets) {
  const bytes = await writeWorkbook({ sheets: Object.entries(sheets).map(([name, rows]) => ({ name, rows })) });
  return readWorkbook(bytes);
}

// ---------------------------------------------------------------- selectors over the demo
test('demo reports: folders hold reports, reports hold metrics, and the read models agree', async () => {
  const ctx = await createContext();
  const { selectors } = ctx;
  const tree = selectors.reportTree();
  assert.deepEqual(tree.roots.map((r) => r.node.id), ['r-bod', 'r-ops', 'r-fin-q', 'r-hotel-m']);
  assert.deepEqual(selectors.reportCounts('r-bod'), { direct: 0, total: 8, reports: 2, folders: 0 }, 'distinct metrics across BOD tháng and BOD quý');
  assert.equal(selectors.reportCounts('r-bod-m').direct, 6);
  assert.deepEqual(selectors.reportLinksByMetric('m-revenue').map((l) => l.reportId), ['mr-r-bod-m-m-revenue', 'mr-r-bod-q-m-revenue', 'mr-r-fin-q-m-revenue'].map((id) => ctx.store.get('metricReports', id).reportId));
  assert.equal(selectors.reportPathLabel('r-bod-m'), 'Báo cáo Ban điều hành / BOD tháng');
  assert.ok(selectors.reportsSorted().every((r) => r.kind === ReportKind.REPORT), 'pickers never offer a folder');
  assert.equal(selectors.reportsSorted()[0].id, 'r-bod-m', 'reports come in the order of the tree');
  assert.ok(selectors.metricIdsUnderReport('r-ops').has('m-complaints'));
  assert.equal(selectors.metricIdsInReport('r-ops').size, 0, 'a folder shows nothing directly');
});

// ---------------------------------------------------------------- the service
test('a folder holds folders and reports; a report holds metrics and nothing else', async () => {
  const ctx = await createContext();
  const folder = await ctx.reports.create({ name: 'Ban kiểm soát', kind: ReportKind.FOLDER, code: 'RPT.BKS' });
  assert.equal(folder.kind, 'folder');
  assert.equal(folder.sortOrder, 5, 'appended after the four demo roots');
  const report = await ctx.reports.create({ parentId: folder.id, name: 'BKS quý', code: 'RPT.BKS.Q' });
  assert.equal(report.kind, 'report', 'the default kind');
  assert.equal(report.parentId, folder.id);
  await assert.rejects(() => ctx.reports.create({ parentId: report.id, name: 'Under a report' }), (e) => e.name === 'ValidationFailure' && e.field === 'parentId');
  await assert.rejects(() => ctx.reports.create({ parentId: 'nope', name: 'Orphan' }), (e) => e.name === 'NotFoundError');
  await assert.rejects(() => ctx.reports.create({ name: '  ' }), (e) => e.name === 'ValidationFailure');

  await assert.rejects(() => ctx.reports.linkMetric('m-revenue', folder.id), (e) => e.name === 'ValidationFailure' && e.field === 'reportId');
  const link = await ctx.reports.linkMetric('m-revenue', report.id);
  assert.equal(link.sortOrder, 1);
  const again = await ctx.reports.linkMetric('m-revenue', report.id);
  assert.equal(again.id, link.id, 'linking twice returns the one link');
  const second = await ctx.reports.linkMetric('m-opex', report.id, { note: 'with YoY' });
  assert.equal(second.sortOrder, 2);
  assert.equal(second.note, 'with YoY');
  assert.deepEqual(ctx.selectors.reportLinks(report.id).map((l) => l.metricId), ['m-revenue', 'm-opex']);

  // Kind follows content: a report showing metrics stays a report, a folder holding items stays a folder.
  await assert.rejects(() => ctx.reports.update(report.id, { kind: ReportKind.FOLDER }), (e) => e.name === 'ValidationFailure' && e.field === 'kind');
  await assert.rejects(() => ctx.reports.update(folder.id, { kind: ReportKind.REPORT }), (e) => e.name === 'ValidationFailure' && e.field === 'kind');
  const empty = await ctx.reports.create({ name: 'Empty', kind: ReportKind.FOLDER });
  const turned = await ctx.reports.update(empty.id, { kind: ReportKind.REPORT, name: 'Now a report' });
  assert.equal(turned.kind, 'report');
  await ctx.reports.unlinkMetric(second.id);
  assert.equal(ctx.store.has('metricReports', second.id), false);
  await assert.rejects(() => ctx.reports.unlinkMetric(second.id), (e) => e.name === 'NotFoundError');
});

test('moving report items: cycles and non-folder parents are refused, siblings are re-sequenced', async () => {
  const ctx = await createContext();
  await assert.rejects(() => ctx.reports.move('r-bod', 'r-bod'), (e) => e.name === 'ValidationFailure');
  await assert.rejects(() => ctx.reports.move('r-bod', 'r-bod-m'), (e) => e.name === 'ValidationFailure', 'a report cannot hold its own folder');
  await assert.rejects(() => ctx.reports.move('r-fin-q', 'r-bod-m'), (e) => e.name === 'ValidationFailure', 'only a folder can hold reports');
  const moved = await ctx.reports.move('r-fin-q', 'r-bod', 0);
  assert.equal(moved.parentId, 'r-bod');
  assert.deepEqual(ctx.selectors.reportTree().byId.get('r-bod').children.map((c) => c.node.id), ['r-fin-q', 'r-bod-m', 'r-bod-q']);
  await ctx.reports.moveRelative('r-fin-q', 'r-bod-q', 'after');
  assert.deepEqual(ctx.selectors.reportTree().byId.get('r-bod').children.map((c) => c.node.id), ['r-bod-m', 'r-bod-q', 'r-fin-q']);
  await ctx.reports.reorder('r-fin-q', 'up');
  assert.deepEqual(ctx.selectors.reportTree().byId.get('r-bod').children.map((c) => c.node.id), ['r-bod-m', 'r-fin-q', 'r-bod-q']);
  const roots = ctx.selectors.reportTree().roots.map((r) => r.node.id);
  assert.deepEqual(roots, ['r-bod', 'r-ops', 'r-hotel-m']);
  // Moving a folder into its own subtree is a cycle, refused where the data lives.
  await assert.rejects(() => ctx.reports.move('r-ops', 'r-ops-w'), (e) => e.name === 'ValidationFailure');
  const back = await ctx.reports.move('r-fin-q', null);
  assert.equal(back.parentId, null);
  // A metric's link moves between reports as one record; onto a report that already shows it, the old link simply goes.
  const link = ctx.selectors.reportLinksByMetric('m-cost-growth')[0];
  const movedLink = await ctx.reports.moveLink('m-cost-growth', 'r-fin-q', 'r-bod-q');
  assert.equal(movedLink.id, link.id);
  assert.equal(movedLink.reportId, 'r-bod-q');
  await ctx.reports.moveLink('m-revenue', 'r-fin-q', 'r-bod-m');
  assert.equal(ctx.selectors.reportLinksByMetric('m-revenue').filter((l) => l.reportId === 'r-bod-m').length, 1);
  assert.equal(ctx.selectors.reportLinksByMetric('m-revenue').some((l) => l.reportId === 'r-fin-q'), false);
});

test('deleting: refused while it holds anything; the cascade moves sub-items up and drops the metric links', async () => {
  const ctx = await createContext();
  await assert.rejects(() => ctx.reports.delete('r-bod'), (e) => e.name === 'ValidationFailure');
  await assert.rejects(() => ctx.reports.delete('r-bod-m'), (e) => e.name === 'ValidationFailure');
  const before = ctx.store.count('metricReports');
  const bodLinks = ctx.selectors.reportLinks('r-bod-m').length;
  await ctx.reports.delete('r-bod-m', { strategy: 'moveToParent' });
  assert.equal(ctx.store.has('reports', 'r-bod-m'), false);
  assert.equal(ctx.store.count('metricReports'), before - bodLinks, 'a folder cannot show metrics, so the links go');
  await ctx.reports.delete('r-bod', { strategy: 'moveToParent' });
  assert.equal(ctx.store.get('reports', 'r-bod-q').parentId, null, 'the remaining report moved up to the root');
  assert.deepEqual(ctx.selectors.reportTree().roots.map((r) => r.node.id), ['r-ops', 'r-fin-q', 'r-hotel-m', 'r-bod-q']);
  await assert.rejects(() => ctx.reports.delete('r-bod'), (e) => e.name === 'NotFoundError');
  // Deleting a metric takes its report links with it, like every other link.
  await ctx.metrics.remove('m-occupancy');
  assert.equal(ctx.store.list('metricReports').some((l) => l.metricId === 'm-occupancy'), false);
});

// ---------------------------------------------------------------- the schema boundary
test('the schema boundary repairs report data instead of refusing the file', () => {
  const full = buildDemoSnapshot();
  const parsed = parseSnapshot({
    ...full,
    reports: [
      ...full.reports,
      { id: 'r-lost', parentId: 'r-gone', kind: 'report', name: 'Lost parent', code: 'RPT.LOST' },
      { id: 'r-odd', parentId: null, kind: 'banana', name: 'Odd kind' },
      { id: 'r-parent', parentId: null, kind: 'report', name: 'Holds a child' },
      { id: 'r-child', parentId: 'r-parent', kind: 'report', name: 'The child' },
    ],
    metricReports: [
      ...full.metricReports,
      { id: 'mr-orphan-1', metricId: 'm-nope', reportId: 'r-bod-m' },
      { id: 'mr-orphan-2', metricId: 'm-revenue', reportId: 'r-nope' },
      { id: 'mr-dup', metricId: 'm-revenue', reportId: 'r-bod-m' },
    ],
  });
  assert.equal(parsed.ok, true, parsed.errors.join('; '));
  const repairs = Object.fromEntries(parsed.repairs.map((r) => [r.code, r.count]));
  assert.equal(repairs.REPORT_PARENT_CLEARED, 1);
  assert.equal(repairs.REPORT_KIND_FOLDER, 1);
  assert.equal(repairs.REPORT_LINK_ORPHAN_DROPPED, 2);
  assert.equal(repairs.REPORT_LINK_DUPLICATE_DROPPED, 1);
  const byId = new Map(parsed.data.reports.map((r) => [r.id, r]));
  assert.equal(byId.get('r-lost').parentId, null);
  assert.equal(byId.get('r-odd').kind, 'report', 'an unknown kind is a report');
  assert.equal(byId.get('r-parent').kind, 'folder', 'a report holding items is a folder in all but name');
  assert.equal(parsed.data.metricReports.length, full.metricReports.length);
  assert.equal(parsed.counts.reports, full.reports.length + 4);

  const truncated = parseSnapshot({ ...full, reports: [] });
  assert.equal(truncated.ok, false);
  assert.match(truncated.errors[0], /"reports" is missing or empty while \d+ metricReports reference it/);
});

// ---------------------------------------------------------------- validation
test('report rules: empty report, link to a folder, item under a report, duplicate code, orphan link, cycle', async () => {
  const ctx = await createContext();
  const demo = run(ctx);
  assert.deepEqual(codes(demo.filter((i) => i.code.startsWith('REPORT'))), [], 'the demo catalogue is clean');
  await ctx.repo.saveMany('reports', [
    { id: 'r-empty', parentId: null, kind: 'report', name: 'Nothing here', code: 'RPT.BOD', sortOrder: 9, version: 1 },
    { id: 'r-under', parentId: 'r-bod-m', kind: 'report', name: 'Under a report', code: '', sortOrder: 1, version: 1 },
    { id: 'r-noname', parentId: null, kind: 'folder', name: '', code: '', sortOrder: 10, version: 1 },
    { id: 'c1', parentId: 'c2', kind: 'folder', name: 'C1', sortOrder: 1, version: 1 },
    { id: 'c2', parentId: 'c1', kind: 'folder', name: 'C2', sortOrder: 1, version: 1 },
  ]);
  await ctx.repo.saveMany('metricReports', [
    { id: 'mr-folder', metricId: 'm-revenue', reportId: 'r-bod', sortOrder: 1, version: 1 },
    { id: 'mr-orphan', metricId: 'm-revenue', reportId: 'r-nope', sortOrder: 1, version: 1 },
  ]);
  ctx.store.hydrate(await ctx.repo.loadAll());
  const issues = run(ctx);
  const of = (code) => issues.filter((i) => i.code === code);
  assert.equal(of('REPORT_EMPTY').length, 2, 'the empty report and the one under a report');
  assert.equal(of('REPORT_EMPTY')[0].severity, 'info');
  assert.equal(of('REPORT_EMPTY')[0].reportId, 'r-empty');
  assert.equal(of('REPORT_LINK_TO_FOLDER').length, 1);
  assert.equal(of('REPORT_LINK_TO_FOLDER')[0].metricId, 'm-revenue');
  assert.equal(of('REPORT_LINK_TO_FOLDER')[0].reportId, 'r-bod');
  assert.equal(of('REPORT_PARENT_NOT_FOLDER').length, 1);
  assert.equal(of('REPORT_PARENT_NOT_FOLDER')[0].params.parent, 'BOD tháng');
  assert.equal(of('REPORT_DUPLICATE_CODE').length, 2, 'both holders of RPT.BOD');
  assert.equal(of('REPORT_MISSING_NAME').length, 1);
  assert.equal(of('REPORT_LINK_ORPHAN').length, 1);
  assert.equal(of('REPORT_LINK_ORPHAN')[0].severity, 'error');
  assert.ok(of('REPORT_CYCLE').length >= 1, 'a cycle is surfaced on at least the node that closes it');
  assert.ok(issues.every((i) => i.entity.type !== 'report' || i.reportId), 'every report issue can be jumped to');
});

// ---------------------------------------------------------------- IndexedDB upgrade
test('a v4 database opens at v5 with its data intact and the two new stores in place', async () => {
  const factory = freshFactory();
  const dbName = freshDbName();
  const old = COLLECTIONS.filter((c) => c !== 'reports' && c !== 'metricReports');
  const db = await rawOpen(factory, dbName, 4, (d) => {
    for (const c of old) d.createObjectStore(c, { keyPath: 'id' });
    d.createObjectStore('_restorePoints', { keyPath: 'id' });
    d.createObjectStore('_sequences', { keyPath: 'id' });
  });
  const tx = db.transaction(['metrics', 'structureNodes'], 'readwrite');
  tx.objectStore('metrics').put({ id: 'm-1', name: 'Doanh thu', code: 'M.000001', owners: ['Alice'], aliases: [], tags: [], version: 3, concurrencyToken: '3' });
  tx.objectStore('structureNodes').put({ id: 's-1', name: 'Nhóm', parentId: null, sortOrder: 1, version: 1 });
  await rawDone(tx);
  db.close();

  const tab = await openTab(factory, dbName);
  const info = tab.repo.describe();
  assert.equal(info.persistent, true, info.detail);
  assert.equal(tab.store.count('metrics'), 1, 'the metric is still there');
  assert.equal(tab.store.count('reports'), 0);
  const folder = await tab.reports.create({ name: 'Ban điều hành', kind: ReportKind.FOLDER, code: 'RPT.BOD' });
  const report = await tab.reports.create({ parentId: folder.id, name: 'BOD tháng', code: 'RPT.BOD.M' });
  await tab.reports.linkMetric('m-1', report.id);
  // The unique index refuses a second link for the same pair, whatever the mirror thinks.
  await assert.rejects(() => tab.repo.save('metricReports', { id: 'dup', metricId: 'm-1', reportId: report.id, sortOrder: 9, version: 0 }), (e) => e.name === 'UniquenessError' || /already has a record|unique|constraint/i.test(e.message));
  tab.repo.close();

  const raw = await rawOpen(factory, dbName, DB_VERSION);
  assert.ok(raw.objectStoreNames.contains('reports') && raw.objectStoreNames.contains('metricReports'));
  assert.equal((await rawAll(raw, 'reports')).length, 2);
  assert.equal((await rawAll(raw, 'metricReports')).length, 1);
  assert.equal((await rawAll(raw, 'metrics'))[0].name, 'Doanh thu');
  raw.close();
});

// ---------------------------------------------------------------- Excel
test('Excel: Reports and Report_Metrics sheets import, Report_Codes replaces a metric\'s links, folders are refused as targets', async () => {
  const ctx = await createContext();
  const revenue = ctx.store.get('metrics', 'm-revenue');
  const opex = ctx.store.get('metrics', 'm-opex');
  const wb = await workbookOf({
    Reports: [
      ['Code *', 'Name *', 'Kind', 'Parent_Code', 'Owner', 'Sort_Order'],
      ['RPT.BKS', 'Ban kiểm soát', 'folder', '', 'BKS', 6],
      ['RPT.BKS.Q', 'BKS quý', '', 'RPT.BKS', '', 1],
      ['RPT.BOD.M', 'BOD tháng (đổi tên)', 'report', 'RPT.BOD', '', ''],
    ],
    Metrics: [
      ['Code', 'Name', 'Report_Codes'],
      [revenue.code, '', 'RPT.BKS.Q'],
    ],
    Report_Metrics: [
      ['Report_Code', 'Metric_Code', 'Sort_Order', 'Note'],
      ['RPT.BKS.Q', opex.code, 2, 'With the quarter before'],
      ['RPT.BKS.Q', revenue.code, 1, ''],
    ],
  });
  const plan = planExcelImport(readTemplateWorkbook(wb), ctx.store);
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  assert.equal(plan.changes.reports.created, 2);
  assert.equal(plan.changes.reports.updated, 1, 'the renamed demo report');
  assert.equal(plan.changes.metricReports.created, 2, 'revenue and opex in BKS quý');
  assert.equal(plan.changes.metricReports.removed, 3, 'Report_Codes replaced the three demo links of revenue');
  const bks = plan.snapshot.reports.find((r) => r.code === 'RPT.BKS.Q');
  assert.equal(bks.kind, 'report', 'blank Kind is a report');
  assert.equal(bks.parentId, plan.snapshot.reports.find((r) => r.code === 'RPT.BKS').id);
  const links = plan.snapshot.metricReports.filter((l) => l.reportId === bks.id).sort((a, b) => a.sortOrder - b.sortOrder);
  assert.deepEqual(links.map((l) => [l.metricId, l.sortOrder, l.note]), [['m-revenue', 1, ''], ['m-opex', 2, 'With the quarter before']]);
  assert.equal(plan.snapshot.reports.find((r) => r.id === 'r-bod-m').name, 'BOD tháng (đổi tên)');

  const bad = await workbookOf({
    Reports: [['Code *', 'Name *', 'Kind', 'Parent_Code'], ['RPT.X', 'Under a report', 'report', 'RPT.BOD.M'], ['RPT.Y', 'Bad kind', 'thing', '']],
    Metrics: [['Code', 'Name', 'Report_Codes'], [revenue.code, '', 'RPT.BOD']],
    Report_Metrics: [['Report_Code', 'Metric_Code'], ['RPT.OPS', revenue.code], ['RPT.NOPE', revenue.code]],
  });
  const refused = planExcelImport(readTemplateWorkbook(bad), ctx.store);
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.errors.map((e) => [e.sheet, e.row]).sort(), [['Metrics', 2], ['Report_Metrics', 2], ['Report_Metrics', 3], ['Reports', 2], ['Reports', 3]]);
  assert.ok(refused.errors.some((e) => /is a folder/.test(e.message)));
  assert.ok(refused.errors.some((e) => /only a folder can hold items/.test(e.message)));
});

test('Excel: the filled template carries reports both ways, and the export offers them as datasets', async () => {
  const ctx = await createContext();
  const bytes = await buildTemplateWorkbook({ store: ctx.store, language: 'en', includeData: true });
  const { workbook, plan } = await previewExcelImport(bytes, ctx.store);
  assert.ok(workbook.sheets.some((s) => s.name === 'Reports') && workbook.sheets.some((s) => s.name === 'Report_Metrics'));
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  assert.equal(plan.changes.reports.unchanged, ctx.store.count('reports'));
  assert.equal(plan.changes.metricReports.unchanged, ctx.store.count('metricReports'));
  assert.equal(plan.changes.metricReports.removed, 0);
  const metricsSheet = workbook.sheets.find((s) => s.name === 'Metrics');
  const header = metricsSheet.rows[0].map((c) => (c && c.v != null ? String(c.v) : c));
  assert.ok(header.some((v) => String(v).startsWith('Report_Codes')), 'Metrics carries a Report_Codes column');

  const keys = EXPORT_DATASETS.map((d) => d.key);
  assert.ok(keys.includes('reports') && keys.includes('reportMetrics'));
  const source = exportSource({ store: ctx.store });
  const out = await buildExportWorkbook(source, [{ key: 'reports', fields: ['Code', 'Name', 'Kind', 'Path'] }, { key: 'reportMetrics', fields: null }], { language: 'en', cover: false });
  assert.equal(out.sheets[0].rows, ctx.store.count('reports'));
  assert.equal(out.sheets[1].rows, ctx.store.count('metricReports'));
  const read = await readWorkbook(out.bytes);
  const rows = read.sheets[0].rows;
  assert.deepEqual(rows[0], ['Code', 'Name', 'Kind', 'Path']);
  assert.ok(rows.some((r) => r[3] && String(r[3]).includes('›')), 'the path shows the folder');
});
