import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext } from './_setup.mjs';
import { freshFactory, freshDbName, openRepo, openTab, reload, rawOpen, rawDone, rawAll } from './_idb.mjs';
import { DB_VERSION } from '../src/repositories/local-repository.js';
import { COLLECTIONS } from '../src/repositories/repository.js';
import { validateAll } from '../src/services/validation-service.js';
import { parseSnapshot } from '../src/services/snapshot-schema.js';
import { buildDemoSnapshot } from '../src/data/seed.js';
import { Store } from '../src/core/store/store.js';
import { createSelectors } from '../src/core/store/selectors.js';
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

// ---------------------------------------------------------------- two tabs, one database
/**
 * R02 / R09. A link's token says what the link was, never what its target is
 * or what a folder holds. Everything a move or a kind change depends on is
 * therefore re-read where the data lives, inside the transaction that writes.
 */
test('two tabs: a link cannot be moved into a report another tab deleted', async () => {
  const factory = freshFactory();
  const dbName = freshDbName();
  const a = await openTab(factory, dbName, { seed: true });
  const b = await openTab(factory, dbName);
  await b.reports.delete('r-hotel-m', { strategy: 'moveToParent' });
  // Tab A still sees the report and the metric's link to another one.
  assert.ok(a.store.has('reports', 'r-hotel-m'), 'the stale tab has not noticed');
  await assert.rejects(() => a.reports.moveLink('m-revenue', 'r-fin-q', 'r-hotel-m'), (e) => e.name === 'NotFoundError');
  await assert.rejects(() => a.reports.linkMetric('m-revenue', 'r-hotel-m'), (e) => e.name === 'NotFoundError');
  const stored = await rawAll(await rawOpen(factory, dbName, DB_VERSION), 'metricReports');
  assert.equal(stored.some((l) => l.reportId === 'r-hotel-m'), false, 'no link points at the deleted report');
  assert.ok(stored.some((l) => l.metricId === 'm-revenue' && l.reportId === 'r-fin-q'), 'the source link is untouched');
  a.repo.close(); b.repo.close();
});

test('two tabs: merging a link into a report that has just lost it does not leave the metric in neither', async () => {
  const factory = freshFactory();
  const dbName = freshDbName();
  const a = await openTab(factory, dbName, { seed: true });
  const b = await openTab(factory, dbName);
  // Both reports show the metric; tab A is about to move the BOD tháng link
  // into Tài chính quý, which already has one.
  const targetLink = a.selectors.reportLinksByMetric('m-revenue').find((l) => l.reportId === 'r-fin-q');
  assert.ok(targetLink, 'the demo has the metric in both reports');
  await b.reports.unlinkMetric(targetLink.id);
  await assert.rejects(() => a.reports.moveLink('m-revenue', 'r-bod-m', 'r-fin-q'), (e) => e.name === 'NotFoundError');
  const stored = await rawAll(await rawOpen(factory, dbName, DB_VERSION), 'metricReports');
  assert.ok(stored.some((l) => l.metricId === 'm-revenue' && l.reportId === 'r-bod-m'), 'the source link survived the refused move');
  a.repo.close(); b.repo.close();
});

test('two tabs: a folder cannot become a report while another tab is putting something in it', async () => {
  const factory = freshFactory();
  const dbName = freshDbName();
  const a = await openTab(factory, dbName, { seed: true });
  const b = await openTab(factory, dbName);
  const folder = await a.reports.create({ name: 'Ban kiểm soát', kind: ReportKind.FOLDER, code: 'RPT.BKS' });
  await reload(b);
  // A sees an empty folder and decides it should be a report; B fills it.
  await b.reports.create({ parentId: folder.id, name: 'BKS quý', code: 'RPT.BKS.Q' });
  assert.equal(a.selectors.reportTree().byId.get(folder.id).children.length, 0, 'the stale tab still sees it empty');
  await assert.rejects(() => a.reports.update(folder.id, { kind: ReportKind.REPORT }), (e) => e.name === 'ValidationFailure' && e.field === 'kind');
  const stored = await rawAll(await rawOpen(factory, dbName, DB_VERSION), 'reports');
  assert.equal(stored.find((r) => r.id === folder.id).kind, 'folder', 'the parent of the new child is still a folder');
  a.repo.close(); b.repo.close();
});

test('two tabs: a report cannot become a folder while another tab is linking a metric to it', async () => {
  const factory = freshFactory();
  const dbName = freshDbName();
  const a = await openTab(factory, dbName, { seed: true });
  const b = await openTab(factory, dbName);
  const report = await a.reports.create({ name: 'Trống', kind: ReportKind.REPORT, code: 'RPT.EMPTY' });
  await reload(b);
  await b.reports.linkMetric('m-revenue', report.id);
  assert.equal(a.selectors.reportLinks(report.id).length, 0, 'the stale tab still sees it empty');
  await assert.rejects(() => a.reports.update(report.id, { kind: ReportKind.FOLDER }), (e) => e.name === 'ValidationFailure' && e.field === 'kind');
  const stored = await rawAll(await rawOpen(factory, dbName, DB_VERSION), 'reports');
  assert.equal(stored.find((r) => r.id === report.id).kind, 'report');
  // Renaming the same record is not a question about what it holds, so it still works.
  await a.reports.rename(report.id, 'Vẫn là báo cáo');
  assert.equal(a.store.get('reports', report.id).name, 'Vẫn là báo cáo');
  a.repo.close(); b.repo.close();
});

test('two tabs: a metric cannot be moved into a structure group another tab deleted', async () => {
  const factory = freshFactory();
  const dbName = freshDbName();
  const a = await openTab(factory, dbName, { seed: true });
  const b = await openTab(factory, dbName);
  const empty = await a.structure.createNode({ name: 'Nhóm trống', code: 'TRONG' });
  await reload(b);
  await b.structure.deleteNode(empty.id);
  await assert.rejects(() => a.structure.moveMetric('m-revenue', 's-kd-dt', empty.id), (e) => e.name === 'NotFoundError');
  const stored = await rawAll(await rawOpen(factory, dbName, DB_VERSION), 'metricStructures');
  assert.equal(stored.some((l) => l.structureNodeId === empty.id), false, 'no placement points at the deleted group');
  assert.ok(stored.some((l) => l.metricId === 'm-revenue' && l.structureNodeId === 's-kd-dt'), 'the original placement is untouched');
  // And the metric still has exactly one primary placement.
  const primaries = stored.filter((l) => l.metricId === 'm-revenue' && l.isPrimary);
  assert.equal(primaries.length, 1);
  a.repo.close(); b.repo.close();
});

/**
 * R10. The rule the UI and the service enforce — a folder shows no metrics,
 * a report holds no sub-items — is the same rule a file has to obey. The
 * import refuses the row; the backup boundary, which may never refuse a
 * legacy file, repairs it and says so.
 */
test('Excel: a kind the file\'s own contents contradict is refused on the row that asked for it', async () => {
  const ctx = await createContext();
  const holdsMetrics = await workbookOf({
    Reports: [['Code *', 'Name *', 'Kind'], ['RPT.BOD.M', '', 'folder']],
  });
  const refused = planExcelImport(readTemplateWorkbook(holdsMetrics), ctx.store);
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.errors.map((e) => [e.sheet, e.row]), [['Reports', 2]]);
  assert.match(refused.errors[0].message, /still shows 6 metric\(s\); a folder cannot show metrics/);

  const holdsItems = await workbookOf({
    Reports: [['Code *', 'Name *', 'Kind'], ['RPT.BOD', '', 'report']],
  });
  const refusedToo = planExcelImport(readTemplateWorkbook(holdsItems), ctx.store);
  assert.equal(refusedToo.ok, false);
  assert.match(refusedToo.errors[0].message, /still holds 2 sub-item\(s\); a report cannot hold sub-items/);

  // Emptying the report in the same file makes the same change legitimate.
  const emptied = await workbookOf({
    Reports: [['Code *', 'Name *', 'Kind'], ['RPT.BOD.M', '', 'folder']],
    Metrics: [
      ['Code', 'Name', 'Report_Codes'],
      ['M.000001', '', '-'], ['M.000018', '', '-'], ['M.000019', '', '-'],
      ['M.000002', '', '-'], ['M.000005', '', '-'], ['M.000020', '', '-'],
    ],
  });
  const ok = planExcelImport(readTemplateWorkbook(emptied), ctx.store);
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.equal(ok.snapshot.reports.find((r) => r.id === 'r-bod-m').kind, 'folder');
  assert.equal(ok.snapshot.metricReports.some((l) => l.reportId === 'r-bod-m'), false);

  // A kind this file never mentions is the catalogue's business: an item
  // already in a state the app would refuse must not refuse the whole file.
  const untouched = planExcelImport(readTemplateWorkbook(await workbookOf({
    Units: [['Code *', 'Name *'], ['KWH', 'Kilowatt hour']],
  })), ctx.store);
  assert.equal(untouched.ok, true, JSON.stringify(untouched.errors));
});

test('the backup boundary makes kind and content agree instead of importing a state the app refuses', () => {
  const full = buildDemoSnapshot();
  const parsed = parseSnapshot({
    ...full,
    reports: [...full.reports, { id: 'r-folder-only-metrics', parentId: null, kind: 'folder', name: 'Thật ra là báo cáo', code: 'RPT.X' }],
    metricReports: [
      ...full.metricReports,
      { id: 'mr-x', metricId: 'm-revenue', reportId: 'r-folder-only-metrics' },
      // A folder that holds sub-items cannot also show a metric.
      { id: 'mr-bod', metricId: 'm-revenue', reportId: 'r-bod' },
    ],
  });
  assert.equal(parsed.ok, true, parsed.errors.join('; '));
  const repairs = Object.fromEntries(parsed.repairs.map((r) => [r.code, r.count]));
  assert.equal(repairs.REPORT_KIND_REPORT, 1, 'a folder that only shows metrics is a report');
  assert.equal(repairs.REPORT_LINK_TO_FOLDER_DROPPED, 1, 'the link to a real folder is dropped, and reported');
  assert.equal(parsed.data.reports.find((r) => r.id === 'r-folder-only-metrics').kind, 'report');
  assert.equal(parsed.data.reports.find((r) => r.id === 'r-bod').kind, 'folder');
  assert.equal(parsed.data.metricReports.some((l) => l.reportId === 'r-bod'), false);
  assert.ok(parsed.data.metricReports.some((l) => l.id === 'mr-x'));

  // What comes out of the boundary never trips the rule it just repaired.
  const store = new Store();
  store.hydrate(parsed.data);
  const selectors = createSelectors(store);
  const issues = validateAll({ store, selectors, dependencies: null });
  assert.deepEqual(issues.filter((i) => i.code === 'REPORT_LINK_TO_FOLDER'), []);
  assert.deepEqual(issues.filter((i) => i.code === 'REPORT_PARENT_NOT_FOLDER'), []);
});
