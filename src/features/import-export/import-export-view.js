import { h, btn, icon, clear, formatNumber } from '../../ui/dom.js';
import { t } from '../../ui/i18n.js';
import { confirmDialog } from '../../ui/components/confirm.js';
import { BackupService } from '../../services/backup-service.js';
import { buildDemoSnapshot, buildLargeSnapshot } from '../../data/seed.js';
import { COLLECTIONS } from '../../core/collections.js';

/** Import / Export — JSON backup, reset, demo datasets, Phase 2 Excel placeholder. */
export function mountImportExportView(container, ctx) {
  const { store, services, repoInfo } = ctx;
  const preview = h('div', { class: 'import-preview', hidden: true });
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  let pending = null;

  const storageCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', { text: t('io.storage') })),
    h('p', { class: 'small' }, icon(repoInfo.persistent ? 'check' : 'warning', { size: 14 }), ' ', repoInfo.persistent ? t('io.storagePersistent') : t('io.storageMemory')),
    h('div', { class: 'counts' }, COLLECTIONS.map((c) => h('span', { class: 'count-pill' }, h('strong', { text: formatNumber(store.count(c)) }), ' ', t(`collection.${c}`)))),
  );

  const exportCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', { text: t('io.export') })),
    h('p', { class: 'small muted', text: t('io.exportHint') }),
    btn(t('io.downloadJson'), { kind: 'primary', size: 'sm', icon: 'download', on: { click: exportJson } }),
  );

  const importCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', { text: t('io.import') })),
    h('p', { class: 'small muted', text: t('io.importHint') }),
    h('div', { class: 'btn-row' }, btn(t('io.chooseFile'), { size: 'sm', icon: 'upload', on: { click: () => fileInput.click() } }), fileInput),
    preview,
  );

  const demoCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', { text: t('io.demo') })),
    h('p', { class: 'small muted', text: t('io.demoHint') }),
    h('div', { class: 'btn-row' },
      btn(t('io.resetDemo'), { size: 'sm', icon: 'layers', on: { click: () => replaceWith(buildDemoSnapshot, t('io.resetDemoTitle'), t('io.resetDemoMessage')) } }),
      btn(t('io.loadLarge'), { size: 'sm', icon: 'layers', on: { click: () => replaceWith(() => buildLargeSnapshot({ metrics: 3000, dimensions: 120 }), t('io.loadLargeTitle'), t('io.loadLargeMessage')) } }),
      btn(t('io.clearAll'), { kind: 'danger-ghost', size: 'sm', icon: 'trash', on: { click: () => replaceWith(() => ({}), t('io.clearTitle'), t('io.clearMessage')) } }),
    ),
  );

  const excelCard = h('div', { class: 'card card-muted' },
    h('div', { class: 'card-head' }, h('h2', { text: t('io.excel') }), h('span', { class: 'tag', text: t('io.phase2') })),
    h('p', { class: 'small muted', text: t('io.excelHint') }),
    h('ol', { class: 'small muted steps' }, ['io.excelStep1', 'io.excelStep2', 'io.excelStep3', 'io.excelStep4'].map((k) => h('li', { text: t(k) }))),
    btn(t('io.excelImport'), { size: 'sm', disabled: true, icon: 'upload' }),
  );

  const root = h('div', { class: 'view-single view-scroll' }, h('div', { class: 'cards' }, storageCard, exportCard, importCard, demoCard, excelCard));
  container.appendChild(root);

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

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    const text = await file.text();
    fileInput.value = '';
    const check = BackupService.inspect(text);
    pending = check;
    clear(preview);
    preview.hidden = false;
    preview.appendChild(h('div', { class: 'small' }, h('strong', { text: file.name }), ` · ${formatNumber(file.size)} B`));
    if (!check.ok) {
      preview.appendChild(h('ul', { class: 'error-list' }, check.errors.map((e) => h('li', { text: e }))));
      return;
    }
    preview.appendChild(h('div', { class: 'counts' }, COLLECTIONS.map((c) => h('span', { class: 'count-pill' }, h('strong', { text: formatNumber(check.counts[c] || 0) }), ' ', t(`collection.${c}`)))));
    preview.appendChild(h('div', { class: 'btn-row' }, btn(t('io.importReplace'), { kind: 'danger', size: 'sm', on: { click: importPending } }), btn(t('common.cancel'), { size: 'sm', on: { click: () => { preview.hidden = true; pending = null; } } })));
  });

  async function importPending() {
    if (!pending || !pending.ok) return;
    const ok = await confirmDialog({ title: t('io.importTitle'), message: t('io.importMessage', { n: formatNumber(store.count('metrics')) }), confirmLabel: t('io.importReplace') });
    if (!ok) return;
    try {
      await ctx.drawerClose();
      const counts = await services.backup.importSnapshot(pending.data);
      ctx.toast.success(t('io.imported', { n: formatNumber(counts.metrics || 0) }));
      preview.hidden = true;
      pending = null;
      refreshCounts();
    } catch (err) {
      ctx.toast.error(err.message);
    }
  }

  async function replaceWith(build, title, message) {
    const ok = await confirmDialog({ title, message, confirmLabel: t('common.confirm') });
    if (!ok) return;
    try {
      await ctx.drawerClose();
      const t0 = performance.now();
      const snapshot = build();
      await services.backup.importSnapshot({ data: snapshot });
      ctx.toast.success(t('io.replaced', { n: formatNumber(store.count('metrics')), ms: Math.round(performance.now() - t0) }));
      refreshCounts();
    } catch (err) {
      ctx.toast.error(err.message);
    }
  }

  function refreshCounts() {
    const counts = storageCard.querySelector('.counts');
    counts.replaceChildren(...COLLECTIONS.map((c) => h('span', { class: 'count-pill' }, h('strong', { text: formatNumber(store.count(c)) }), ' ', t(`collection.${c}`))));
  }

  const offStore = store.events.on('change', () => refreshCounts());
  return { update() {}, onDrawerClosed() {}, onMetricOpened() {}, destroy() { offStore(); root.remove(); } };
}
