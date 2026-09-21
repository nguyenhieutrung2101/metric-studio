import { h, btn, icon, clear, formatNumber } from '../../ui/dom.js';
import { t, getLanguage } from '../../ui/i18n.js';
import { confirmDialog, promptDialog } from '../../ui/components/confirm.js';
import { pageHeader } from '../../ui/workspace/page-header.js';
import { workspaceLayout } from '../../ui/workspace/workspace-layout.js';
import { createUnit } from '../../core/models/unit.js';
import { createScenario, isValidScenarioCode } from '../../core/models/scenario.js';
import { tokenOf } from '../../repositories/repository.js';
import { debounce } from '../../utils/debounce.js';
import { downloadBlob } from '../../utils/download.js';
import { buildTemplateWorkbook } from '../../services/excel-template.js';
import { previewExcelImport, applyExcelImport } from '../../services/excel-import.js';
import { DEFAULT_THEME } from '../../services/xlsx.js';
import { openMenu } from '../../ui/components/menu.js';

/**
 * Master data — the units and the scenarios everything else refers to.
 *
 * Two lists, each in a pane of its own that scrolls on its own. A long list
 * of units must not drag the page, because the heading it is under and the
 * buttons that act on it are the two things a person needs while reading it.
 */
export function mountMasterDataView(container, ctx) {
  const { store, selectors, repo, services } = ctx;
  const meta = h('span', { class: 'muted small' });
  const header = pageHeader({ title: t('nav.master-data'), subtitle: t('master.subtitle'), meta });

  const unitsBody = h('div', { class: 'md-scroll' });
  const unitsCount = h('span', { class: 'tree-count' });
  const unitsPane = h('section', { class: 'pane md-pane' },
    h('div', { class: 'pane-head' },
      h('span', { class: 'pane-title', text: t('master.units') }),
      unitsCount,
      h('div', { class: 'pane-actions' },
        btn(t('master.unitsExcel'), { size: 'sm', icon: 'download', on: { click: (e) => unitsExcelMenu(e.currentTarget) } }),
        btn(t('master.addUnit'), { size: 'sm', icon: 'plus', on: { click: () => editUnit(null) } }),
      ),
    ),
    unitsBody,
  );

  const scenariosBody = h('div', { class: 'md-scroll' });
  const scenariosCount = h('span', { class: 'tree-count' });
  const scenariosPane = h('section', { class: 'pane md-pane' },
    h('div', { class: 'pane-head' },
      h('span', { class: 'pane-title', text: t('master.scenarios') }),
      scenariosCount,
      h('div', { class: 'pane-actions' }, btn(t('master.addScenario'), { size: 'sm', icon: 'plus', on: { click: () => editScenario(null) } })),
    ),
    scenariosBody,
  );

  const split = h('div', { class: 'md-split' }, unitsPane, scenariosPane);
  const main = h('div', { class: 'md-main' }, split);
  const layout = workspaceLayout({ header: header.el, main, className: 'md-ws' });
  container.appendChild(layout.el);

  // ---------------------------------------------------------------- units
  function usage(unitId) {
    let n = 0;
    for (const m of store.list('metrics')) if (m.unitId === unitId) n += 1;
    return n;
  }

  function renderUnits() {
    const units = selectors.units();
    unitsCount.textContent = formatNumber(units.length);
    clear(unitsBody);
    if (!units.length) {
      unitsBody.appendChild(h('div', { class: 'empty small' }, icon('layers', { size: 24 }), h('p', { text: t('master.noUnits') })));
      return;
    }
    unitsBody.appendChild(h('table', { class: 'table' },
      h('thead', null, h('tr', null, h('th', { text: t('mm.col.code') }), h('th', { text: t('mm.col.name') }), h('th', { class: 'num', text: t('master.usedBy') }), h('th'))),
      h('tbody', null, units.map((u) => h('tr', null,
        h('td', { class: 'mono', text: u.code }),
        h('td', { text: u.name }),
        h('td', { class: 'muted num', text: formatNumber(usage(u.id)) }),
        h('td', { class: 'actions' }, btn('', { icon: 'edit', size: 'sm', title: t('common.edit'), on: { click: () => editUnit(u) } }), btn('', { icon: 'trash', size: 'sm', title: t('common.delete'), on: { click: () => deleteUnit(u) } })),
      ))),
    ));
  }

  async function editUnit(u) {
    await promptDialog({
      title: u ? t('common.edit') : t('master.addUnit'),
      confirmLabel: u ? t('common.save') : t('common.create'),
      fields: [{ name: 'code', label: t('mm.col.code'), value: u ? u.code : '', required: true }, { name: 'name', label: t('mm.col.name'), value: u ? u.name : '' }],
      submit: async (v) => {
        const rec = u ? { ...u, ...v } : createUnit(v);
        const saved = await repo.saveUnit(rec, u ? tokenOf(u) : null);
        store.upsert('units', saved);
        return saved;
      },
    });
  }

  async function deleteUnit(u) {
    const n = usage(u.id);
    const ok = await confirmDialog({ title: t('master.deleteUnitTitle', { code: u.code }), message: n ? t('master.deleteUnitUsed', { n }) : '', confirmLabel: t('common.delete') });
    if (!ok) return;
    try { await repo.deleteUnit(u.id, tokenOf(u)); store.remove('units', u.id); } catch (err) { ctx.toast.error(err.message); }
  }

  // ---------------------------------------------------------------- units in batch
  /**
   * A short list is quicker to type than to import; a hundred units from
   * another system are not. The template is the one the full import uses,
   * cut down to the sheet this pane is about, and the file goes back through
   * the same planner — so what is learned here is true there.
   */
  function unitsExcelMenu(anchor) {
    openMenu(anchor, [
      { label: t('master.unitsTemplateFilled'), icon: 'download', onClick: () => downloadUnitsTemplate(true) },
      { label: t('master.unitsTemplateBlank'), icon: 'download', onClick: () => downloadUnitsTemplate(false) },
      { separator: true },
      { label: t('master.unitsImport'), icon: 'upload', onClick: () => fileInput.click() },
    ]);
  }

  async function downloadUnitsTemplate(includeData) {
    try {
      const bytes = await buildTemplateWorkbook({ store, language: getLanguage(), includeData, theme: DEFAULT_THEME, only: ['units'] });
      downloadBlob(bytes, `metric-studio-units-${includeData ? 'data' : 'blank'}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    } catch (err) {
      ctx.toast.error(err.message);
    }
  }

  const fileInput = h('input', { type: 'file', accept: '.xlsx', hidden: true });
  unitsPane.appendChild(fileInput);
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    fileInput.value = '';
    await importUnits(file);
  });

  async function importUnits(file) {
    let plan;
    try {
      ({ plan } = await previewExcelImport(new Uint8Array(await file.arrayBuffer()), store));
    } catch (err) {
      ctx.toast.error(err.message);
      return;
    }
    const rows = plan.rowsRead.units || 0;
    // A file for this pane is about units. Anything else in it is a sign the
    // wrong file was picked, and saying so is better than quietly importing
    // half a catalogue from a pane that does not show it.
    const others = Object.entries(plan.rowsRead).filter(([key, n]) => key !== 'units' && n > 0).map(([key]) => key);
    if (others.length) {
      ctx.toast.error(t('master.unitsOnlyFile', { sheets: others.join(', ') }));
      return;
    }
    if (!plan.ok) {
      const first = plan.errors[0];
      ctx.toast.error(first ? (first.row ? t('io.excelErrorRow', { sheet: first.sheet, row: first.row, message: first.message }) : first.message) : t('io.rejected'));
      return;
    }
    const change = plan.changes.units;
    if (!rows || (!change.created && !change.updated)) {
      ctx.toast.info(t('master.unitsNoChange'));
      return;
    }
    const ok = await confirmDialog({
      title: t('master.unitsImportTitle'),
      message: t('master.unitsImportMessage', { create: formatNumber(change.created), update: formatNumber(change.updated) }),
      confirmLabel: t('io.excelApply'),
      danger: false,
    });
    if (!ok) return;
    try {
      await applyExcelImport(plan, services.backup, { label: 'Before units import' });
      ctx.toast.success(t('master.unitsImported', { create: formatNumber(change.created), update: formatNumber(change.updated) }));
    } catch (err) {
      const stale = err.name === 'ConflictError' || err.name === 'NotFoundError';
      ctx.toast.error(stale ? t('io.excelStale') : err.message);
    }
  }

  // ---------------------------------------------------------------- scenarios
  function scenarioUsage(scenarioId) {
    let n = 0;
    for (const b of store.list('bindings')) if (b.scenarioId === scenarioId) n += 1;
    return n;
  }

  function renderScenarios() {
    const scenarios = selectors.scenarios();
    scenariosCount.textContent = formatNumber(scenarios.length);
    clear(scenariosBody);
    scenariosBody.appendChild(h('p', { class: 'md-hint small muted', text: t('master.scenariosHint') }));
    scenariosBody.appendChild(h('table', { class: 'table' },
      h('thead', null, h('tr', null, h('th', { text: t('mm.col.code') }), h('th', { text: t('mm.col.name') }), h('th', { text: t('master.scenarioDescription') }), h('th', { class: 'num', text: t('master.bindings') }), h('th'))),
      h('tbody', null, scenarios.map((s) => h('tr', null,
        h('td', { class: 'mono', text: s.code }),
        h('td', { text: s.name }),
        h('td', { class: 'muted small', text: s.description || '' }),
        h('td', { class: 'muted num', text: formatNumber(scenarioUsage(s.id)) }),
        h('td', { class: 'actions' },
          btn('', { icon: 'edit', size: 'sm', title: t('common.edit'), on: { click: () => editScenario(s) } }),
          btn('', { icon: 'trash', size: 'sm', title: t('common.delete'), on: { click: () => deleteScenario(s) } }),
        ),
      ))),
    ));
  }

  /**
   * Scenarios are the user's to define. The two the demo ships with are
   * examples, not a fixed pair: a code is any short label a formula can use
   * to reach across, and there can be as many as the planning process needs.
   */
  async function editScenario(s) {
    await promptDialog({
      title: s ? t('common.edit') : t('master.addScenario'),
      confirmLabel: s ? t('common.save') : t('common.create'),
      fields: [
        { name: 'code', label: t('master.scenarioCode'), value: s ? s.code : '', placeholder: 'TT', required: true },
        { name: 'name', label: t('master.scenarioName'), value: s ? s.name : '', placeholder: 'Thực tế / Actual', required: true },
        { name: 'description', label: t('master.scenarioDescription'), value: s ? s.description || '' : '' },
      ],
      submit: async (v) => {
        const code = String(v.code || '').trim().toUpperCase();
        const name = String(v.name || '').trim();
        if (!isValidScenarioCode(code)) throw fieldError(t('master.scenarioCodeInvalid'), 'code');
        const clash = selectors.scenarios().find((x) => x.code === code && (!s || x.id !== s.id));
        if (clash) throw fieldError(t('master.scenarioCodeTaken', { code }), 'code');
        const rec = s ? { ...s, code, name, description: v.description || '' } : createScenario({ code, name, description: v.description || '', sortOrder: selectors.scenarios().length + 1 });
        const saved = await repo.saveScenario(rec, s ? tokenOf(s) : null);
        store.upsert('scenarios', saved);
        return saved;
      },
    });
  }

  async function deleteScenario(s) {
    const n = scenarioUsage(s.id);
    if (n) { ctx.toast.error(t('master.deleteScenarioUsed', { n })); return; }
    const ok = await confirmDialog({ title: t('master.deleteScenarioTitle', { code: s.code }), message: t('master.deleteScenarioMessage', { code: s.code }), confirmLabel: t('common.delete'), danger: true });
    if (!ok) return;
    try { await repo.deleteScenario(s.id, tokenOf(s)); store.remove('scenarios', s.id); } catch (err) { ctx.toast.error(err.message); }
  }

  // ---------------------------------------------------------------- sync
  function renderMeta() {
    meta.textContent = t('master.meta', { units: formatNumber(store.count('units')), scenarios: formatNumber(store.count('scenarios')) });
  }
  const schedule = debounce(() => { renderUnits(); renderScenarios(); renderMeta(); }, 30);
  const offStore = store.events.on('change', (evt) => { if (['*', 'units', 'scenarios', 'metrics', 'bindings'].includes(evt.collection)) schedule(); });
  renderUnits();
  renderScenarios();
  renderMeta();
  return { update() {}, onShow() {}, onDrawerClosed() {}, onMetricOpened() {}, destroy() { offStore(); schedule.cancel(); layout.el.remove(); } };
}

/** An error the dialog can pin to one field. */
function fieldError(message, field) {
  const err = new Error(message);
  err.field = field;
  return err;
}
