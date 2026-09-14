import { h, btn, icon, clear, formatNumber } from '../../ui/dom.js';
import { t } from '../../ui/i18n.js';
import { confirmDialog, promptDialog } from '../../ui/components/confirm.js';
import { createUnit } from '../../core/models/unit.js';
import { createScenario } from '../../core/models/scenario.js';
import { tokenOf } from '../../repositories/repository.js';
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

  function scenarioUsage(scenarioId) {
    let n = 0;
    for (const b of store.list('bindings')) if (b.scenarioId === scenarioId) n += 1;
    return n;
  }

  function renderScenarios() {
    clear(scenariosEl);
    scenariosEl.append(
      h('div', { class: 'card-head' }, h('h2', { text: t('master.scenarios') }), btn(t('master.addScenario'), { size: 'sm', icon: 'plus', on: { click: () => editScenario(null) } })),
      h('p', { class: 'small muted', text: t('master.scenariosHint') }),
      h('table', { class: 'table' },
        h('thead', null, h('tr', null, h('th', { text: t('mm.col.code') }), h('th', { text: t('mm.col.name') }), h('th', { text: t('master.scenarioDescription') }), h('th', { text: t('master.bindings') }), h('th'))),
        h('tbody', null, selectors.scenarios().map((s) => h('tr', null,
          h('td', { class: 'mono', text: s.code }),
          h('td', { text: s.name }),
          h('td', { class: 'muted small', text: s.description || '' }),
          h('td', { class: 'muted', text: formatNumber(scenarioUsage(s.id)) }),
          h('td', { class: 'actions' },
            btn('', { icon: 'edit', size: 'sm', title: t('common.edit'), on: { click: () => editScenario(s) } }),
            btn('', { icon: 'trash', size: 'sm', title: t('common.delete'), on: { click: () => deleteScenario(s) } }),
          ),
        ))),
      ),
    );
  }

  /**
   * Scenarios are the user's to define. The two the demo ships with are
   * examples, not a fixed pair: a code is any short label a formula can use
   * to reach across, and there can be as many as the planning process needs.
   */
  async function editScenario(s) {
    const v = await promptDialog({
      title: s ? t('common.edit') : t('master.addScenario'),
      confirmLabel: s ? t('common.save') : t('common.create'),
      fields: [
        { name: 'code', label: t('master.scenarioCode'), value: s ? s.code : '', placeholder: 'TT' },
        { name: 'name', label: t('master.scenarioName'), value: s ? s.name : '', placeholder: 'Thực tế / Actual' },
        { name: 'description', label: t('master.scenarioDescription'), value: s ? s.description || '' : '' },
      ],
    });
    if (!v) return;
    const code = String(v.code || '').trim().toUpperCase();
    const name = String(v.name || '').trim();
    if (!/^[A-Z0-9]{1,8}$/.test(code)) { ctx.toast.error(t('master.scenarioCodeInvalid')); return; }
    if (!name) return;
    const clash = selectors.scenarios().find((x) => x.code === code && (!s || x.id !== s.id));
    if (clash) { ctx.toast.error(t('master.scenarioCodeTaken', { code })); return; }
    try {
      const rec = s ? { ...s, code, name, description: v.description || '' } : createScenario({ code, name, description: v.description || '', sortOrder: selectors.scenarios().length + 1 });
      const saved = await repo.saveScenario(rec, s ? tokenOf(s) : null);
      store.upsert('scenarios', saved);
    } catch (err) { ctx.toast.error(err.message); }
  }

  async function deleteScenario(s) {
    const n = scenarioUsage(s.id);
    if (n) { ctx.toast.error(t('master.deleteScenarioUsed', { n })); return; }
    const ok = await confirmDialog({ title: t('master.deleteScenarioTitle', { code: s.code }), message: t('master.deleteScenarioMessage', { code: s.code }), confirmLabel: t('common.delete'), danger: true });
    if (!ok) return;
    try { await repo.deleteScenario(s.id, tokenOf(s)); store.remove('scenarios', s.id); } catch (err) { ctx.toast.error(err.message); }
  }

  async function editUnit(u) {
    const v = await promptDialog({ title: u ? t('common.edit') : t('master.addUnit'), confirmLabel: u ? t('common.save') : t('common.create'), fields: [{ name: 'code', label: t('mm.col.code'), value: u ? u.code : '' }, { name: 'name', label: t('mm.col.name'), value: u ? u.name : '' }] });
    if (!v || !v.code) return;
    try {
      const rec = u ? { ...u, ...v } : createUnit(v);
      const saved = await repo.saveUnit(rec, u ? tokenOf(u) : null);
      store.upsert('units', saved);
    } catch (err) { ctx.toast.error(err.message); }
  }

  async function deleteUnit(u) {
    const n = usage(u.id);
    const ok = await confirmDialog({ title: t('master.deleteUnitTitle', { code: u.code }), message: n ? t('master.deleteUnitUsed', { n }) : '', confirmLabel: t('common.delete') });
    if (!ok) return;
    try { await repo.deleteUnit(u.id, tokenOf(u)); store.remove('units', u.id); } catch (err) { ctx.toast.error(err.message); }
  }

  const schedule = debounce(() => { renderUnits(); renderScenarios(); }, 30);
  const offStore = store.events.on('change', (evt) => { if (['*', 'units', 'scenarios', 'metrics', 'bindings'].includes(evt.collection)) schedule(); });
  renderUnits();
  renderScenarios();
  return { update() {}, onDrawerClosed() {}, onMetricOpened() {}, destroy() { offStore(); schedule.cancel(); root.remove(); } };
}
