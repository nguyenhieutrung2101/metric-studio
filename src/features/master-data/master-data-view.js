import { h, btn, icon, clear, formatNumber } from '../../ui/dom.js';
import { t } from '../../ui/i18n.js';
import { confirmDialog, promptDialog } from '../../ui/components/confirm.js';
import { createUnit } from '../../core/models/unit.js';
import { debounce } from '../../utils/debounce.js';

/** Master data — units and scenarios. Small tables, no drama. */
export function mountMasterDataView(container, ctx) {
  const { store, selectors, repo } = ctx;
  const unitsEl = h('div', { class: 'card' });
  const scenariosEl = h('div', { class: 'card' });
  const root = h('div', { class: 'view-single view-scroll' }, h('div', { class: 'cards' }, unitsEl, scenariosEl));
  container.appendChild(root);

  function usage(unitId) {
    let n = 0;
    for (const m of store.list('metrics')) if (m.unitId === unitId) n += 1;
    return n;
  }

  function renderUnits() {
    clear(unitsEl);
    unitsEl.append(
      h('div', { class: 'card-head' }, h('h2', { text: t('master.units') }), btn(t('master.addUnit'), { size: 'sm', icon: 'plus', on: { click: () => editUnit(null) } })),
      h('table', { class: 'table' },
        h('thead', null, h('tr', null, h('th', { text: t('mm.col.code') }), h('th', { text: t('mm.col.name') }), h('th', { text: t('master.usedBy') }), h('th'))),
        h('tbody', null, selectors.units().map((u) => h('tr', null,
          h('td', { class: 'mono', text: u.code }),
          h('td', { text: u.name }),
          h('td', { class: 'muted', text: formatNumber(usage(u.id)) }),
          h('td', { class: 'actions' }, btn('', { icon: 'edit', size: 'sm', title: t('common.edit'), on: { click: () => editUnit(u) } }), btn('', { icon: 'trash', size: 'sm', title: t('common.delete'), on: { click: () => deleteUnit(u) } })),
        ))),
      ),
    );
  }

  function renderScenarios() {
    clear(scenariosEl);
    scenariosEl.append(
      h('div', { class: 'card-head' }, h('h2', { text: t('master.scenarios') }), h('span', { class: 'muted small', text: t('master.scenariosHint') })),
      h('table', { class: 'table' },
        h('thead', null, h('tr', null, h('th', { text: t('mm.col.code') }), h('th', { text: t('mm.col.name') }), h('th', { text: t('master.bindings') }), h('th'))),
        h('tbody', null, selectors.scenarios().map((s) => h('tr', null,
          h('td', { class: 'mono', text: s.code }),
          h('td', { text: s.name }),
          h('td', { class: 'muted', text: formatNumber(selectors.coverageSummary().perScenario[s.id] || 0) }),
          h('td', { class: 'actions' }, btn('', { icon: 'edit', size: 'sm', title: t('common.rename'), on: { click: async () => {
            const v = await promptDialog({ title: t('common.rename'), fields: [{ name: 'name', label: t('mm.col.name'), value: s.name }] });
            if (!v || !v.name) return;
            try { const saved = await repo.saveScenario({ ...s, name: v.name }, s.version); store.upsert('scenarios', saved); } catch (err) { ctx.toast.error(err.message); }
          } } })),
        ))),
      ),
    );
  }

  async function editUnit(u) {
    const v = await promptDialog({ title: u ? t('common.edit') : t('master.addUnit'), confirmLabel: u ? t('common.save') : t('common.create'), fields: [{ name: 'code', label: t('mm.col.code'), value: u ? u.code : '' }, { name: 'name', label: t('mm.col.name'), value: u ? u.name : '' }] });
    if (!v || !v.code) return;
    try {
      const rec = u ? { ...u, ...v } : createUnit(v);
      const saved = await repo.saveUnit(rec, u ? u.version : null);
      store.upsert('units', saved);
    } catch (err) { ctx.toast.error(err.message); }
  }

  async function deleteUnit(u) {
    const n = usage(u.id);
    const ok = await confirmDialog({ title: t('master.deleteUnitTitle', { code: u.code }), message: n ? t('master.deleteUnitUsed', { n }) : '', confirmLabel: t('common.delete') });
    if (!ok) return;
    try { await repo.deleteUnit(u.id, u.version); store.remove('units', u.id); } catch (err) { ctx.toast.error(err.message); }
  }

  const schedule = debounce(() => { renderUnits(); renderScenarios(); }, 30);
  const offStore = store.events.on('change', (evt) => { if (['*', 'units', 'scenarios', 'metrics', 'bindings'].includes(evt.collection)) schedule(); });
  renderUnits();
  renderScenarios();
  return { update() {}, onDrawerClosed() {}, onMetricOpened() {}, destroy() { offStore(); schedule.cancel(); root.remove(); } };
}
