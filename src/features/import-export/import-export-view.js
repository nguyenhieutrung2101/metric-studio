import { h, btn, icon, clear, formatNumber } from '../../ui/dom.js';
import { t } from '../../ui/i18n.js';
import { confirmDialog } from '../../ui/components/confirm.js';
import { buildDemoSnapshot, buildLargeSnapshot } from '../../data/seed.js';
import { bindingRows, toCsv, BINDING_COLUMNS, EDGE_COLUMNS } from '../../services/export-tables.js';
import { COLLECTIONS } from '../../core/collections.js';
import { formatDateTime } from '../../utils/time.js';

/**
 * Import / Export — JSON backup, restore points, demo datasets and the
 * Phase 2 Excel placeholder.
 *
 * Every destructive action goes through BackupService, which validates the
 * incoming snapshot and writes a restore point first.
 */
export function mountImportExportView(container, ctx) {
  const { store, services } = ctx;
  const preview = h('div', { class: 'import-preview', hidden: true });
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  const restoreList = h('div', { class: 'restore-list' });
  let pending = null;

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

  const importCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', { text: t('io.import') })),
    h('p', { class: 'small muted', text: t('io.importHint') }),
    h('div', { class: 'btn-row' }, btn(t('io.chooseFile'), { size: 'sm', icon: 'upload', on: { click: () => fileInput.click() } }), fileInput),
    preview,
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

  const excelCard = h('div', { class: 'card card-muted' },
    h('div', { class: 'card-head' }, h('h2', { text: t('io.excel') }), h('span', { class: 'tag', text: t('io.phase2') })),
    h('p', { class: 'small muted', text: t('io.excelHint') }),
    h('ol', { class: 'small muted steps' }, ['io.excelStep1', 'io.excelStep2', 'io.excelStep3', 'io.excelStep4'].map((k) => h('li', { text: t(k) }))),
    btn(t('io.excelImport'), { size: 'sm', disabled: true, icon: 'upload' }),
  );

  // The workbook import card stays out of view until Phase 2 ships it.
  excelCard.hidden = true;
  const root = h('div', { class: 'view-single view-scroll' }, h('div', { class: 'cards' }, storageCard, exportCard, importCard, restoreCard, demoCard, excelCard));
  container.appendChild(root);

  // ---------------------------------------------------------------- export
  function exportJson() {
    const json = services.backup.exportJson();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `metric-studio-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    ctx.toast.success(t('io.exported'));
  }

  function downloadCsv(name, csv) {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `metric-studio-${name}-${new Date().toISOString().slice(0, 10)}.csv` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    ctx.toast.success(t('io.exported'));
  }

  // ---------------------------------------------------------------- import
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
    if (result.repairs.length) {
      preview.appendChild(h('div', { class: 'preview-block warn' },
        h('div', { class: 'preview-title' }, icon('info', { size: 14 }), h('span', { text: t('io.repaired') })),
        h('ul', { class: 'repair-list' }, result.repairs.map((r) => h('li', { text: `${r.message}${r.count > 1 ? ` (${r.count})` : ''}` }))),
      ));
    }
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
    destroy() { offStorage();
      offStore();
      root.remove();
    },
  };
}
