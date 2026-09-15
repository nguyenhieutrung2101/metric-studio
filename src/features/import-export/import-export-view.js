import { h, btn, icon, clear, formatNumber } from '../../ui/dom.js';
import { t, getLanguage } from '../../ui/i18n.js';
import { confirmDialog } from '../../ui/components/confirm.js';
import { buildDemoSnapshot, buildLargeSnapshot } from '../../data/seed.js';
import { bindingRows, toCsv, BINDING_COLUMNS, EDGE_COLUMNS } from '../../services/export-tables.js';
import { buildTemplateWorkbook, TEMPLATE_SHEETS, pick } from '../../services/excel-template.js';
import { previewExcelImport, applyExcelImport } from '../../services/excel-import.js';
import { EXPORT_DATASETS, buildExportWorkbook, defaultExportSelection, exportSource } from '../../services/excel-export.js';
import { DEFAULT_THEME } from '../../services/xlsx.js';
import { COLLECTIONS } from '../../core/collections.js';
import { formatDateTime } from '../../utils/time.js';
import { getPreference, setPreference } from '../../utils/preferences.js';
import { excelExportDialog } from './excel-export-dialog.js';

/**
 * Import / Export — JSON backup, Excel template and import, Excel reports,
 * CSV tables, restore points and demo datasets.
 *
 * Every destructive action goes through BackupService, which validates the
 * incoming snapshot and writes a restore point first. The Excel import is
 * the same door: its plan becomes a snapshot that passes the schema boundary
 * like any backup would.
 */
export function mountImportExportView(container, ctx) {
  const { store, services } = ctx;
  const preview = h('div', { class: 'import-preview', hidden: true });
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  const excelInput = h('input', { type: 'file', accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', hidden: true });
  const excelPreview = h('div', { class: 'import-preview', hidden: true });
  const restoreList = h('div', { class: 'restore-list' });
  let pending = null;
  let pendingExcel = null;

  const storageLine = h('p', { class: 'small' });
  const renderStorage = () => {
    const info = ctx.storage.info;
    const ok = info.persistent && info.sync.ok && info.writable !== false;
    storageLine.replaceChildren(icon(ok ? 'check' : 'warning', { size: 14 }), ' ', ctx.storage.label());
  };
  renderStorage();
  const offStorage = ctx.storage.onChange(renderStorage);
  const storageCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', { text: t('io.storage') })),
    storageLine,
    h('div', { class: 'counts' }),
  );

  const exportCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', { text: t('io.export') })),
    h('p', { class: 'small muted', text: t('io.exportHint') }),
    h('div', { class: 'btn-row' },
      btn(t('io.downloadJson'), { kind: 'primary', size: 'sm', icon: 'download', on: { click: exportJson } }),
      btn(t('io.downloadBindingsCsv'), { size: 'sm', icon: 'download', title: t('io.bindingsCsvHint'), on: { click: () => downloadCsv('bindings', toCsv(bindingRows(store), BINDING_COLUMNS, { spreadsheetSafe: true })) } }),
      btn(t('io.downloadEdgesCsv'), { size: 'sm', icon: 'download', title: t('io.edgesCsvHint'), on: { click: () => downloadCsv('dependency-edges', toCsv(services.dependencies.referenceRows(), EDGE_COLUMNS, { spreadsheetSafe: true })) } }),
    ),
    h('p', { class: 'small muted', text: t('io.csvSafeHint') }),
  );

  const excelExportCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', { text: t('io.excelExport') })),
    h('p', { class: 'small muted', text: t('io.excelExportHint') }),
    h('div', { class: 'btn-row' },
      btn(t('io.excelExportChoose'), { kind: 'primary', size: 'sm', icon: 'download', on: { click: chooseExcelExport } }),
      btn(t('io.excelExportAll'), { size: 'sm', icon: 'download', on: { click: () => exportExcel(defaultExportSelection(), true) } }),
    ),
  );

  const importCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', { text: t('io.import') })),
    h('p', { class: 'small muted', text: t('io.importHint') }),
    h('div', { class: 'btn-row' }, btn(t('io.chooseFile'), { size: 'sm', icon: 'upload', on: { click: () => fileInput.click() } }), fileInput),
    preview,
  );

  const excelImportCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', { text: t('io.excelImport') })),
    h('p', { class: 'small muted', text: t('io.excelImportHint') }),
    h('div', { class: 'btn-row' },
      btn(t('io.templateBlank'), { size: 'sm', icon: 'download', on: { click: () => downloadTemplate(false) } }),
      btn(t('io.templateFilled'), { size: 'sm', icon: 'download', on: { click: () => downloadTemplate(true) } }),
      btn(t('io.chooseExcel'), { kind: 'primary', size: 'sm', icon: 'upload', on: { click: () => excelInput.click() } }),
      excelInput,
    ),
    h('p', { class: 'small muted', text: t('io.excelSheets', { sheets: TEMPLATE_SHEETS.map((s) => s.name).join(' · ') }) }),
    excelPreview,
  );

  const restoreCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', { text: t('io.restorePoints') })),
    h('p', { class: 'small muted', text: t('io.restoreHint') }),
    restoreList,
  );

  const demoCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', { text: t('io.demo') })),
    h('p', { class: 'small muted', text: t('io.demoHint') }),
    h('div', { class: 'btn-row' },
      btn(t('io.resetDemo'), { size: 'sm', icon: 'layers', on: { click: () => replaceWith(buildDemoSnapshot, t('io.resetDemoTitle'), t('io.resetDemoMessage'), 'Before demo reset') } }),
      btn(t('io.loadLarge'), { size: 'sm', icon: 'layers', on: { click: () => replaceWith(() => buildLargeSnapshot({ metrics: 3000, dimensions: 120 }), t('io.loadLargeTitle'), t('io.loadLargeMessage'), 'Before large dataset') } }),
      btn(t('io.clearAll'), { kind: 'danger-ghost', size: 'sm', icon: 'trash', on: { click: () => replaceWith(() => ({}), t('io.clearTitle'), t('io.clearMessage'), 'Before clearing') } }),
    ),
  );

  const root = h('div', { class: 'view-single view-scroll' }, h('div', { class: 'cards' }, storageCard, exportCard, excelExportCard, importCard, excelImportCard, restoreCard, demoCard));
  container.appendChild(root);

  // ---------------------------------------------------------------- downloads
  function download(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const stamp = () => new Date().toISOString().slice(0, 10);

  function exportJson() {
    const json = services.backup.exportJson();
    download(`metric-studio-${stamp()}.json`, new Blob([json], { type: 'application/json' }));
    ctx.toast.success(t('io.exported'));
  }

  function downloadCsv(name, csv) {
    download(`metric-studio-${name}-${stamp()}.csv`, new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    ctx.toast.success(t('io.exported'));
  }

  const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  async function downloadTemplate(includeData) {
    try {
      const bytes = await buildTemplateWorkbook({ store, language: getLanguage(), includeData, theme: readTheme() });
      download(`metric-studio-template${includeData ? '-with-data' : ''}-${stamp()}.xlsx`, new Blob([bytes], { type: XLSX_TYPE }));
      ctx.toast.success(t('io.excelTemplateDownloaded'));
    } catch (err) {
      ctx.toast.error(err.message);
    }
  }

  // ---------------------------------------------------------------- Excel export
  function source() {
    return exportSource({ store, dependencies: services.dependencies, issues: ctx.validation.index.issues, describeIssue: ctx.describeIssue });
  }

  async function chooseExcelExport() {
    const lang = getLanguage();
    const src = source();
    const remembered = getPreference('excelExport', null);
    const choice = await excelExportDialog({
      datasets: EXPORT_DATASETS.map((d) => ({ key: d.key, label: pick(d.label, lang), description: pick(d.description, lang), fields: d.fields.map((f) => ({ key: f.key, label: pick(f.label, lang) })), rows: d.rows(src).length })),
      selection: remembered && Array.isArray(remembered.selection) ? remembered.selection : null,
      cover: remembered ? remembered.cover !== false : true,
    });
    if (!choice) return;
    setPreference('excelExport', choice);
    await exportExcel(choice.selection, choice.cover, src);
  }

  async function exportExcel(selection, cover, src = source()) {
    try {
      const { bytes, sheets } = await buildExportWorkbook(src, selection, { language: getLanguage(), theme: readTheme(), cover });
      download(`metric-studio-report-${stamp()}.xlsx`, new Blob([bytes], { type: XLSX_TYPE }));
      ctx.toast.success(t('io.excelExported', { sheets: sheets.length }));
    } catch (err) {
      ctx.toast.error(err.message);
    }
  }

  // ---------------------------------------------------------------- JSON import
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    const text = await file.text();
    fileInput.value = '';
    const result = services.backup.preview(text);
    pending = result;
    clear(preview);
    preview.hidden = false;
    preview.appendChild(h('div', { class: 'small' }, h('strong', { text: file.name }), ` · ${formatNumber(file.size)} B`));

    if (!result.ok) {
      preview.appendChild(h('div', { class: 'preview-block error' }, h('div', { class: 'preview-title' }, icon('warning', { size: 14 }), h('span', { text: t('io.rejected') })), h('ul', { class: 'error-list' }, result.errors.map((e) => h('li', { text: e })))));
      preview.appendChild(h('div', { class: 'btn-row' }, btn(t('common.cancel'), { size: 'sm', on: { click: closePreview } })));
      return;
    }

    preview.appendChild(countsRow(result.counts));
    if (result.repairs.length) preview.appendChild(repairsBlock(result.repairs));
    preview.appendChild(h('p', { class: 'small muted', text: t('io.changeSummary', { add: formatNumber(result.addTotal), update: formatNumber(result.updateTotal), remove: formatNumber(result.deleteTotal) }) }));
    if (result.deleteTotal > 0) {
      const lost = COLLECTIONS.filter((c) => result.willDelete[c] > 0).map((c) => `${formatNumber(result.willDelete[c])} ${t(`collection.${c}`)}`);
      preview.appendChild(h('div', { class: 'preview-block error' },
        h('div', { class: 'preview-title' }, icon('warning', { size: 14 }), h('span', { text: t('io.willDelete') })),
        h('p', { class: 'small', text: lost.join(' · ') }),
      ));
    }
    preview.appendChild(h('div', { class: 'btn-row' },
      btn(t('io.importReplace'), { kind: 'danger', size: 'sm', on: { click: importPending } }),
      btn(t('common.cancel'), { size: 'sm', on: { click: closePreview } }),
    ));
  });

  function closePreview() {
    preview.hidden = true;
    clear(preview);
    pending = null;
  }

  async function importPending() {
    if (!pending || !pending.ok) return;
    const message = pending.deleteTotal > 0
      ? t('io.importMessageDeleting', { n: formatNumber(store.count('metrics')), lost: formatNumber(pending.deleteTotal) })
      : t('io.importMessage', { n: formatNumber(store.count('metrics')) });
    const ok = await confirmDialog({ title: t('io.importTitle'), message, confirmLabel: t('io.importReplace') });
    if (!ok) return;
    try {
      await ctx.drawerClose();
      const { counts, repairs, restorePoint, restorePointError } = await services.backup.importSnapshot(pending, { label: 'Before import' });
      closePreview();
      announce(t('io.imported', { n: formatNumber(counts.metrics || 0) }), repairs, restorePoint, restorePointError);
      await renderRestorePoints();
    } catch (err) {
      ctx.toast.error(err.message);
    }
  }

  // ---------------------------------------------------------------- Excel import
  excelInput.addEventListener('change', async () => {
    const file = excelInput.files && excelInput.files[0];
    if (!file) return;
    excelInput.value = '';
    clear(excelPreview);
    excelPreview.hidden = false;
    excelPreview.appendChild(h('div', { class: 'small' }, h('strong', { text: file.name }), ` · ${formatNumber(file.size)} B`));
    const busy = h('p', { class: 'small muted', text: t('io.excelReading') });
    excelPreview.appendChild(busy);
    let result;
    try {
      result = await previewExcelImport(new Uint8Array(await file.arrayBuffer()), store);
    } catch (err) {
      busy.remove();
      excelPreview.appendChild(h('div', { class: 'preview-block error' }, h('div', { class: 'preview-title' }, icon('warning', { size: 14 }), h('span', { text: t('io.rejected') })), h('ul', { class: 'error-list' }, h('li', { text: err.message }))));
      excelPreview.appendChild(h('div', { class: 'btn-row' }, btn(t('common.cancel'), { size: 'sm', on: { click: closeExcelPreview } })));
      return;
    }
    busy.remove();
    const { plan } = result;
    pendingExcel = plan;

    // What was read, sheet by sheet.
    const readPills = TEMPLATE_SHEETS.filter((s) => plan.rowsRead[s.key] != null).map((s) => h('span', { class: 'count-pill' }, h('strong', { text: formatNumber(plan.rowsRead[s.key]) }), ' ', s.name));
    excelPreview.appendChild(h('div', null, h('div', { class: 'preview-caption', text: t('io.excelRowsBySheet') }), h('div', { class: 'counts' }, readPills)));

    if (!plan.ok) {
      const list = plan.errors.slice(0, 40).map((e) => h('li', { text: e.row ? t('io.excelErrorRow', { sheet: e.sheet, row: e.row, message: e.message }) : e.message }));
      if (plan.errors.length > 40) list.push(h('li', { class: 'muted', text: t('drawer.warningsMore', { n: plan.errors.length - 40 }) }));
      excelPreview.appendChild(h('div', { class: 'preview-block error' }, h('div', { class: 'preview-title' }, icon('warning', { size: 14 }), h('span', { text: t('io.excelErrors') })), h('ul', { class: 'error-list' }, list)));
      if (plan.warnings.length) excelPreview.appendChild(warningsBlock(plan.warnings));
      excelPreview.appendChild(h('div', { class: 'btn-row' }, btn(t('common.cancel'), { size: 'sm', on: { click: closeExcelPreview } })));
      return;
    }

    const totals = { create: 0, update: 0, remove: 0 };
    const changePills = [];
    for (const c of COLLECTIONS) {
      const ch = plan.changes[c];
      totals.create += ch.created;
      totals.update += ch.updated;
      totals.remove += ch.removed;
      if (!ch.created && !ch.updated && !ch.removed) continue;
      const parts = [ch.created && t('io.excelCreate', { n: formatNumber(ch.created) }), ch.updated && t('io.excelUpdate', { n: formatNumber(ch.updated) }), ch.removed && t('io.excelRemove', { n: formatNumber(ch.removed) })].filter(Boolean);
      changePills.push(h('span', { class: 'count-pill pill-change' }, h('strong', { text: t(`collection.${c}`) }), ' · ', parts.join(' · ')));
    }
    excelPreview.appendChild(h('div', null, h('div', { class: 'preview-caption', text: t('io.excelPlan') }), changePills.length ? h('div', { class: 'counts' }, changePills) : h('p', { class: 'small muted', text: t('io.excelNoChange') })));
    if (plan.warnings.length) excelPreview.appendChild(warningsBlock(plan.warnings));
    if (plan.parsed && plan.parsed.repairs.length) excelPreview.appendChild(repairsBlock(plan.parsed.repairs));
    excelPreview.appendChild(h('div', { class: 'btn-row' },
      btn(t('io.excelApply'), { kind: 'primary', size: 'sm', icon: 'upload', disabled: !changePills.length, on: { click: () => importPendingExcel(totals) } }),
      btn(t('common.cancel'), { size: 'sm', on: { click: closeExcelPreview } }),
    ));
  });

  function warningsBlock(warnings) {
    return h('div', { class: 'preview-block warn' },
      h('div', { class: 'preview-title' }, icon('info', { size: 14 }), h('span', { text: t('io.excelWarnings') })),
      h('ul', { class: 'repair-list' }, warnings.slice(0, 20).map((w) => h('li', { text: w.message }))),
    );
  }

  function repairsBlock(repairs) {
    return h('div', { class: 'preview-block warn' },
      h('div', { class: 'preview-title' }, icon('info', { size: 14 }), h('span', { text: t('io.repaired') })),
      h('ul', { class: 'repair-list' }, repairs.map((r) => h('li', { text: `${r.message}${r.count > 1 ? ` (${r.count})` : ''}` }))),
    );
  }

  function closeExcelPreview() {
    excelPreview.hidden = true;
    clear(excelPreview);
    pendingExcel = null;
  }

  async function importPendingExcel(totals) {
    if (!pendingExcel || !pendingExcel.ok) return;
    const ok = await confirmDialog({ title: t('io.excelTitle'), message: t('io.excelMessage', { create: formatNumber(totals.create), update: formatNumber(totals.update), remove: formatNumber(totals.remove) }), confirmLabel: t('io.excelApply'), danger: false });
    if (!ok) return;
    try {
      await ctx.drawerClose();
      const { repairs, restorePoint, restorePointError } = await applyExcelImport(pendingExcel, services.backup, { label: 'Before Excel import' });
      closeExcelPreview();
      announce(t('io.excelImported', { create: formatNumber(totals.create), update: formatNumber(totals.update) }), repairs, restorePoint, restorePointError);
      await renderRestorePoints();
    } catch (err) {
      // The preview was planned against a catalogue that has since moved, so
      // the whole import was refused. Saying which record collided helps
      // nobody: the file has to be previewed again either way.
      const stale = err.name === 'ConflictError' || err.name === 'NotFoundError';
      if (stale) closeExcelPreview();
      ctx.toast.error(stale ? t('io.excelStale') : err.message);
    }
  }

  async function replaceWith(build, title, message, label) {
    const ok = await confirmDialog({ title, message, confirmLabel: t('common.confirm') });
    if (!ok) return;
    try {
      await ctx.drawerClose();
      const t0 = performance.now();
      const { counts, repairs, restorePoint, restorePointError } = await services.backup.replaceWith(build(), { label });
      announce(t('io.replaced', { n: formatNumber(counts.metrics || 0), ms: Math.round(performance.now() - t0) }), repairs, restorePoint, restorePointError);
      await renderRestorePoints();
    } catch (err) {
      ctx.toast.error(err.message);
    }
  }

  function announce(message, repairs, restorePoint, restorePointError) {
    if (restorePointError) {
      ctx.toast.error(`${message} · ${t('io.restoreFailed')}`, { duration: 8000 });
      return;
    }
    if (repairs && repairs.length) {
      const total = repairs.reduce((n, r) => n + r.count, 0);
      ctx.toast.info(`${message} · ${t('io.repairedCount', { n: total })}`, { duration: 6000 });
    } else if (restorePoint) {
      ctx.toast.success(message, { duration: 5000, action: { label: t('io.undo'), onClick: () => restore(restorePoint.id) } });
    } else {
      ctx.toast.success(message);
    }
  }

  // ---------------------------------------------------------------- restore points
  async function renderRestorePoints() {
    clear(restoreList);
    if (!services.backup.supportsRestorePoints()) {
      restoreList.appendChild(h('p', { class: 'hint', text: t('io.restoreUnavailable') }));
      return;
    }
    const points = await services.backup.listRestorePoints();
    if (!points.length) {
      restoreList.appendChild(h('p', { class: 'hint', text: t('io.restoreEmpty') }));
      return;
    }
    for (const p of points) {
      restoreList.appendChild(h('div', { class: 'restore-item' },
        h('div', { class: 'restore-meta' },
          h('strong', { text: p.label || t('io.restoreUnnamed') }),
          h('span', { class: 'muted small', text: `${formatDateTime(p.createdAt)} · ${t('io.restoreCounts', { metrics: formatNumber(p.counts.metrics || 0), bindings: formatNumber(p.counts.bindings || 0) })}` }),
        ),
        h('div', { class: 'restore-actions' },
          btn(t('io.restore'), { size: 'sm', icon: 'arrowLeft', on: { click: () => restore(p.id) } }),
          btn('', { icon: 'trash', size: 'sm', title: t('common.delete'), on: { click: () => dropPoint(p.id) } }),
        ),
      ));
    }
  }

  async function restore(id) {
    const ok = await confirmDialog({ title: t('io.restoreTitle'), message: t('io.restoreMessage'), confirmLabel: t('io.restore'), danger: false });
    if (!ok) return;
    try {
      await ctx.drawerClose();
      const { counts } = await services.backup.restore(id);
      ctx.toast.success(t('io.restored', { n: formatNumber(counts.metrics || 0) }));
      await renderRestorePoints();
    } catch (err) {
      ctx.toast.error(err.message);
    }
  }

  async function dropPoint(id) {
    await services.backup.deleteRestorePoint(id);
    await renderRestorePoints();
  }

  // ---------------------------------------------------------------- counts
  function countsRow(counts) {
    return h('div', { class: 'counts' }, COLLECTIONS.map((c) => h('span', { class: 'count-pill' }, h('strong', { text: formatNumber(counts[c] || 0) }), ' ', t(`collection.${c}`))));
  }

  function refreshCounts() {
    const current = {};
    for (const c of COLLECTIONS) current[c] = store.count(c);
    storageCard.querySelector('.counts').replaceWith(countsRow(current));
  }

  const offStore = store.events.on('change', () => refreshCounts());
  refreshCounts();
  renderRestorePoints();

  return {
    update() {},
    onDrawerClosed() {},
    onMetricOpened() {},
    destroy() {
      offStorage();
      offStore();
      root.remove();
    },
  };
}

const THEME_TOKENS = {
  accent: '--accent', accentStrong: '--accent-strong', accentSoft: '--accent-soft', text: '--text', text2: '--text-2', text3: '--text-3',
  border: '--border', borderStrong: '--border-strong', surface2: '--surface-2', bg: '--bg', warning: '--warning', warningSoft: '--warning-soft',
  success: '--success', successSoft: '--success-soft', danger: '--danger', dangerSoft: '--danger-soft',
};

/** The app's live colour tokens as the workbook's palette; anything that is not a hex colour keeps the default. */
export function readTheme() {
  const theme = { ...DEFAULT_THEME };
  if (typeof getComputedStyle !== 'function' || !document.documentElement) return theme;
  const style = getComputedStyle(document.documentElement);
  for (const [key, token] of Object.entries(THEME_TOKENS)) {
    const raw = style.getPropertyValue(token).trim();
    const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(raw);
    if (!m) continue;
    const hex = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
    theme[key] = hex.toUpperCase();
  }
  return theme;
}
