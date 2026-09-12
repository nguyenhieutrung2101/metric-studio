import { h, icon, formatNumber } from '../../ui/dom.js';
import { t } from '../../ui/i18n.js';
import { VirtualList } from '../../ui/table/virtual-list.js';
import { bindingChip, severityDot } from '../../ui/components/chip.js';
import { BINDING_TYPES } from '../../core/models/binding.js';
import { debounce } from '../../utils/debounce.js';
import { compareText } from '../../utils/text.js';
import { worstSeverity } from '../../services/validation-service.js';

/**
 * Bindings — scenario coverage view.
 * Makes "Metric Master → TT subset → GD subset" obvious: one row per metric,
 * one chip per scenario, filters for TT-only / GD-only / Both / None.
 */
export function mountBindingsView(container, ctx) {
  const { store, selectors } = ctx;
  const scenarios = selectors.scenarios();
  const state = { coverage: '', query: '', types: {}, warningsOnly: false, items: [] };

  const summary = h('div', { class: 'summary-row' });
  const searchInput = h('input', { class: 'input search-input', type: 'search', placeholder: t('mm.searchPlaceholder') });
  const segButtons = [];
  const seg = h('div', { class: 'seg', role: 'radiogroup' }, [{ value: '', label: t('coverage.all') }, { value: 'both', label: t('coverage.both') }, ...scenarios.map((s) => ({ value: `${s.code.toLowerCase()}-only`, label: t('coverage.only', { scenario: s.code }) })), { value: 'none', label: t('coverage.none') }].map((o) => {
    const b = h('button', { type: 'button', role: 'radio', class: ['seg-btn', o.value === state.coverage && 'active'], 'aria-checked': String(o.value === state.coverage), dataset: { value: o.value }, on: { click: () => { state.coverage = o.value; markSeg(); refresh(); } } }, o.label);
    segButtons.push(b);
    return b;
  }));
  const typeSelects = scenarios.map((s) => {
    const sel = h('select', { class: 'input input-sm', 'aria-label': s.code }, h('option', { value: '', text: t('bindings.anyType', { scenario: s.code }) }), ...BINDING_TYPES.filter((x) => x !== 'none').map((x) => h('option', { value: x, text: `${s.code}: ${t(`binding.type.${x}`)}` })));
    sel.addEventListener('change', () => { state.types[s.id] = sel.value; refresh(); });
    return sel;
  });
  const warnCheck = h('input', { type: 'checkbox', on: { change: (e) => { state.warningsOnly = e.target.checked; refresh(); } } });
  const toolbar = h('div', { class: 'toolbar' }, h('div', { class: 'search' }, icon('search', { className: 'search-icon' }), searchInput), seg, ...typeSelects, h('label', { class: 'check-inline' }, warnCheck, h('span', { text: t('mm.filter.warningsOnly') })));
  const header = h('div', { class: 'table-head binding-row' },
    h('span', { class: 'col-code', text: t('mm.col.code') }),
    h('span', { class: 'col-name', text: t('mm.col.name') }),
    ...scenarios.map((s) => h('span', { class: 'col-binding-wide', text: s.name })),
    h('span', { class: 'col-legacy', text: t('bindings.legacy') }),
    h('span', { class: 'col-warn', text: '' }),
  );
  const empty = h('div', { class: 'empty', hidden: true }, icon('layers', { size: 28 }), h('p', { text: t('bindings.empty') }));
  const listHost = h('div', { class: 'list-host' });
  const root = h('div', { class: 'view-single' }, summary, toolbar, header, listHost, empty);
  container.appendChild(root);

  const list = new VirtualList(listHost, { rowHeight: 40, keyOf: (m) => m.id, emptyNode: empty, renderRow });

  function markSeg() {
    for (const b of segButtons) {
      const on = b.dataset.value === state.coverage;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    }
  }

  function renderRow(m) {
    const cov = selectors.coverageOf(m.id);
    const bindings = selectors.bindingsByMetric(m.id);
    const legacy = scenarios.map((s) => bindings.get(s.id)).filter((b) => b && b.legacyCode).map((b) => b.legacyCode);
    const issues = ctx.validation.issuesForMetric(m.id).filter((i) => i.entity.type === 'binding' || i.scenarioId);
    const sev = worstSeverity(issues);
    return h('div', { class: ['binding-row', 'row', ctx.currentMetricId === m.id && 'active'], role: 'row', tabindex: '-1', dataset: { id: m.id }, on: { click: () => open(m.id) } },
      h('span', { class: 'col-code mono', text: m.code }),
      h('span', { class: 'col-name' }, h('span', { class: 'name-text', text: m.name })),
      ...scenarios.map((s) => {
        const b = bindings.get(s.id);
        const detail = b && cov[s.id] ? (b.type === 'formula' ? b.formulaText : b.type === 'source' ? [b.source.system, b.source.dataset].filter(Boolean).join(' / ') : b.assumption.value) : '';
        return h('span', { class: 'col-binding-wide', on: { click: (e) => { e.stopPropagation(); open(m.id, s.id); } } }, bindingChip(s.code, cov[s.id]), detail && h('span', { class: 'binding-detail mono', text: detail, title: detail }));
      }),
      h('span', { class: 'col-legacy mono muted', text: legacy.join(' · ') }),
      h('span', { class: 'col-warn' }, sev ? severityDot(sev, issues.length) : null),
    );
  }

  function compute() {
    const hits = selectors.searchMetrics(state.query);
    const out = [];
    for (const m of store.list('metrics')) {
      if (hits && !hits.has(m.id)) continue;
      if (state.coverage && selectors.coverageClass(m.id) !== state.coverage) continue;
      const cov = selectors.coverageOf(m.id);
      let ok = true;
      for (const s of scenarios) if (state.types[s.id] && cov[s.id] !== state.types[s.id]) ok = false;
      if (!ok) continue;
      if (state.warningsOnly && !ctx.validation.issuesForMetric(m.id).some((i) => i.entity.type === 'binding' || i.scenarioId)) continue;
      out.push(m);
    }
    out.sort((a, b) => compareText(a.code, b.code));
    return out;
  }

  function renderSummary() {
    const s = selectors.coverageSummary();
    summary.replaceChildren(
      stat(t('bindings.summary.total'), s.total, 'all'),
      h('span', { class: 'summary-arrow', text: '→' }),
      ...scenarios.map((sc) => h('span', { class: 'stat' }, h('span', { class: 'stat-value', text: formatNumber(s.perScenario[sc.id]) }), h('span', { class: 'stat-label', text: t('bindings.summary.scenario', { scenario: sc.code }) }))),
      stat(t('coverage.both'), s.both, 'both'),
      stat(t('coverage.none'), s.none, 'none', s.none > 0),
    );
  }

  function stat(label, value, coverage, warn = false) {
    const target = coverage === 'all' ? '' : coverage;
    return h('button', { type: 'button', class: ['stat', warn && 'warn', state.coverage === target && 'active'], on: { click: () => { state.coverage = target; markSeg(); refresh(); } } }, h('span', { class: 'stat-value', text: formatNumber(value) }), h('span', { class: 'stat-label', text: label }));
  }

  function refresh() {
    state.items = compute();
    list.setItems(state.items);
    renderSummary();
  }

  function open(id, scenarioId = null) {
    ctx.router.setParams({ metric: id });
    ctx.openMetric(id, { section: 'bindings', scenarioId });
  }

  const onSearch = debounce(() => { state.query = searchInput.value; refresh(); }, 160);
  searchInput.addEventListener('input', onSearch);
  const schedule = debounce(refresh, 30);
  const offStore = store.events.on('change', (evt) => { if (['*', 'metrics', 'bindings', 'scenarios'].includes(evt.collection)) schedule(); });
  const offValidation = ctx.validation.onChange(() => (state.warningsOnly ? refresh() : list.refresh()));
  refresh();

  return {
    update(route) {
      if (route.params.coverage && route.params.coverage !== state.coverage) { state.coverage = route.params.coverage; markSeg(); refresh(); }
      const metricId = route.params.metric;
      if (metricId && store.has('metrics', metricId) && metricId !== ctx.currentMetricId) ctx.openMetric(metricId, { section: 'bindings' });
    },
    onDrawerClosed() { ctx.router.setParams({ metric: null }); list.refresh(); },
    onMetricOpened() { list.refresh(); },
    destroy() { offStore(); offValidation(); onSearch.cancel(); list.destroy(); root.remove(); },
  };
}
