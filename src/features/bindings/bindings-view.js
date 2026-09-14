import { h, icon, formatNumber } from '../../ui/dom.js';
import { t } from '../../ui/i18n.js';
import { VirtualList } from '../../ui/table/virtual-list.js';
import { bindingChip, severityDot } from '../../ui/components/chip.js';
import { BINDING_TYPES } from '../../core/models/binding.js';
import { debounce } from '../../utils/debounce.js';
import { compareText } from '../../utils/text.js';
import { worstSeverity } from '../../services/validation-service.js';
import { pageHeader } from '../../ui/workspace/page-header.js';
import { contextBar, contextSelect } from '../../ui/workspace/context-bar.js';
import { workspaceLayout } from '../../ui/workspace/workspace-layout.js';
import { createInsightsPanel } from '../../ui/workspace/insights-panel.js';
import { filterBar } from '../../ui/filter/filter-bar.js';
import { writeFilters, readFilters, filtersDiffer, normalizeCoverage } from '../../ui/workspace/route-state.js';
import { renderMetricInsights } from '../metric-master/metric-insights.js';
import { renderBindingInsights } from './binding-insights.js';

const COVERAGE = ['', 'complete', 'partial', 'missing'];

/**
 * Bindings — the coverage matrix as a worksheet.
 *
 * One row per metric, one cell per scenario in context. The context bar
 * decides which scenarios the matrix is about; the filter bar only hides
 * rows. A cell is a thing of its own: click to inspect the binding in the
 * Insights panel, double-click (or Enter) to edit it in the drawer, ← → to
 * walk across scenarios. Coverage — complete, partial, missing — is judged
 * over the scenarios in context, so narrowing the context narrows the
 * question.
 */
export function mountBindingsView(container, ctx) {
  const { store, selectors } = ctx;
  const allScenarios = selectors.scenarios();
  const state = {
    visible: new Set(allScenarios.map((s) => s.id)),
    coverage: '',
    query: '',
    filters: {},
    items: [],
    selectedId: null,
    scenarioId: null,
  };
  const scenarios = () => allScenarios.filter((s) => state.visible.has(s.id));

  // ---------------------------------------------------------------- header + context
  const countLabel = h('span', { class: 'count-label' });
  const header = pageHeader({ title: t('nav.bindings'), subtitle: t('bindings.subtitle'), meta: countLabel });
  const scenarioCtx = contextSelect({
    label: t('bindings.scenarioContext'),
    icon: 'layers',
    value: t('bindings.allScenarios'),
    renderPicker: () => scenarioPicker(),
  });
  const context = contextBar(scenarioCtx.el, h('span', { class: 'spacer' }), h('span', { class: 'ctx-hint muted small', text: t('bindings.contextHint') }));

  function scenarioPicker() {
    const rows = allScenarios.map((s) => {
      const cb = h('input', { type: 'checkbox', checked: state.visible.has(s.id), on: { change: () => {
        if (cb.checked) state.visible.add(s.id);
        else if (state.visible.size > 1) state.visible.delete(s.id);
        else cb.checked = true;
        applyContext();
      } } });
      return h('label', { class: 'ctx-check' }, cb, h('span', { class: 'mono', text: s.code }), h('span', { class: 'muted', text: s.name }));
    });
    return h('div', null,
      h('button', { type: 'button', class: ['ctx-option', state.visible.size === allScenarios.length && 'active'], on: { click: () => { for (const s of allScenarios) state.visible.add(s.id); applyContext(); scenarioCtx.close(); } } }, t('bindings.allScenarios')),
      ...rows,
    );
  }

  function applyContext() {
    const list = scenarios();
    scenarioCtx.setValue('', list.length === allScenarios.length ? t('bindings.allScenarios') : list.map((s) => s.code).join(', '));
    ctx.router.setParams({ scenarios: list.length === allScenarios.length ? null : list.map((s) => s.code).join(',') });
    if (state.scenarioId && !state.visible.has(state.scenarioId)) state.scenarioId = null;
    // A context change normalises the filters in the same step. No filter
    // may keep acting on rows without a control that shows it: "partial"
    // means nothing with one scenario, and a type filter on a scenario that
    // left the context is dropped.
    const coverage = normalizeCoverage(state.coverage, list.length);
    if (coverage !== state.coverage) {
      ctx.toast.info(t('bindings.partialReset'));
      setCoverage(coverage);
    }
    const drop = {};
    for (const s of allScenarios) if (!state.visible.has(s.id) && state.filters[`type:${s.id}`]) drop[`type:${s.id}`] = '';
    if (Object.keys(drop).length) filters.setMany(drop);
    renderHead();
    refresh({ keepScroll: true });
    renderInsights();
  }

  /** Put the context back to every scenario — what an overview tile means by "all". */
  function contextAll() {
    for (const s of allScenarios) state.visible.add(s.id);
    applyContext();
  }

  // ---------------------------------------------------------------- filters
  const segButtons = new Map();
  const coverageSeg = h('div', { class: 'seg coverage-seg', role: 'radiogroup' }, COVERAGE.map((v) => {
    const b = h('button', { type: 'button', role: 'radio', class: ['seg-btn', v === state.coverage && 'active', v && `seg-${v}`], 'aria-checked': String(v === state.coverage), on: { click: () => setCoverage(v) } },
      h('span', { text: v ? t(`coverage.${v}`) : t('coverage.all') }), h('span', { class: 'seg-count' }));
    segButtons.set(v, b);
    return b;
  }));
  const FILTER_SPEC = Object.fromEntries([
    ...allScenarios.map((s) => [`type:${s.id}`, { param: `t_${s.code}` }]),
    ['warningsOnly', { type: 'toggle', param: 'warn' }],
  ]);
  const filters = filterBar({
    search: { placeholder: t('mm.searchPlaceholder'), onChange: (q) => { state.query = q; ctx.router.setParams({ q: q || null }); refresh({ keepScroll: false }); }, onEnter: () => { if (state.items.length) selectCell(state.items[0].id, state.scenarioId); } },
    filters: [
      ...allScenarios.map((s) => ({ key: `type:${s.id}`, label: t('bindings.typeFilter', { scenario: s.code }), options: BINDING_TYPES.filter((x) => x !== 'none').map((x) => ({ value: x, label: t(`binding.type.${x}`) })) })),
      { key: 'warningsOnly', label: t('mm.filter.warningsOnly'), type: 'toggle' },
    ],
    extra: [coverageSeg],
    onChange: (values) => { state.filters = values; writeFilters(ctx.router, values, FILTER_SPEC); refresh({ keepScroll: false }); },
  });

  function setCoverage(v) {
    state.coverage = v;
    for (const [k, b] of segButtons) { b.classList.toggle('active', k === v); b.setAttribute('aria-checked', String(k === v)); }
    ctx.router.setParams({ coverage: v || null });
    refresh({ keepScroll: false });
  }

  // ---------------------------------------------------------------- matrix
  const head = h('div', { class: 'table-head binding-row bmatrix-row' });
  const empty = h('div', { class: 'empty', hidden: true }, icon('layers', { size: 28 }), h('p', { text: t('bindings.empty') }));
  const listHost = h('div', { class: 'list-host' });
  const main = h('section', { class: 'pane grid-pane' }, listHost, empty);

  const list = new VirtualList(listHost, {
    rowHeight: 'row',
    keyOf: (m) => m.id,
    emptyNode: empty,
    renderRow,
    // Arrow keys walk rows and keep the column; a click on the row's own
    // cells (code, name) inspects the metric.
    onSelect: (m, { source } = {}) => selectCell(m ? m.id : null, source === 'keyboard' ? state.scenarioId : null),
    onActivate: (m) => open(m.id, state.scenarioId),
    header: head,
  });
  // ← → walk across the scenarios of the selected row; the list handles ↑ ↓ Enter.
  list.viewport.addEventListener('keydown', (e) => {
    if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || !state.selectedId) return;
    e.preventDefault();
    const cols = scenarios();
    const at = state.scenarioId ? cols.findIndex((s) => s.id === state.scenarioId) : -1;
    const next = e.key === 'ArrowRight' ? Math.min(cols.length - 1, at + 1) : Math.max(-1, at - 1);
    selectCell(state.selectedId, next < 0 ? null : cols[next].id);
  });

  // Identity and every scenario cell keep a readable minimum; past that the
  // matrix scrolls sideways with the header and identity columns pinned.
  function template() {
    return `96px minmax(200px, 1fr) ${scenarios().map(() => 'minmax(220px, 1.2fr)').join(' ')} 120px 28px`;
  }

  function minWidth() {
    const n = scenarios().length;
    return 28 + 96 + 200 + 220 * n + 120 + 28 + 6 * (3 + n);
  }

  function renderHead() {
    // "Partial" cannot happen with one scenario in context; hide the dead segment.
    segButtons.get('partial').hidden = scenarios().length < 2;
    head.style.gridTemplateColumns = template();
    list.setMinWidth(minWidth());
    head.replaceChildren(
      h('span', { class: 'col-code', text: t('mm.col.code') }),
      h('span', { class: 'col-name', text: t('mm.col.name') }),
      ...scenarios().map((s) => h('span', { class: 'col-binding-wide', text: s.name, title: s.code })),
      h('span', { class: 'col-legacy', text: t('bindings.legacy') }),
      h('span', { class: 'col-warn', text: '' }),
    );
  }

  function renderRow(m) {
    const cols = scenarios();
    const cov = selectors.coverageOf(m.id);
    const bindings = selectors.bindingsByMetric(m.id);
    const legacy = cols.map((s) => bindings.get(s.id)).filter((b) => b && b.legacyCode).map((b) => b.legacyCode);
    const issues = ctx.validation.issuesForMetric(m.id).filter((i) => i.entity.type === 'binding' || i.scenarioId);
    const sev = worstSeverity(issues);
    const row = h('div', { class: ['binding-row', 'bmatrix-row', 'row', ctx.currentMetricId === m.id && 'active'], role: 'row', tabindex: '-1', dataset: { id: m.id }, style: { gridTemplateColumns: template() }, title: t('bindings.contextHint') },
      h('span', { class: 'col-code mono', text: m.code }),
      h('span', { class: 'col-name' }, h('span', { class: 'name-text', text: m.name })),
      ...cols.map((s) => {
        const b = bindings.get(s.id);
        const detail = b && cov[s.id] ? (b.type === 'formula' ? b.formulaText : b.type === 'source' ? [b.source.system, b.source.dataset].filter(Boolean).join(' / ') : b.assumption.value) : '';
        return h('span', {
          class: ['bcell', m.id === state.selectedId && s.id === state.scenarioId && 'selected'],
          dataset: { scenario: s.id },
          on: {
            click: (e) => { e.stopPropagation(); selectCell(m.id, s.id); },
            dblclick: (e) => { e.stopPropagation(); open(m.id, s.id); },
          },
        }, bindingChip(s.code, cov[s.id]), detail && h('span', { class: 'binding-detail mono', text: detail, title: detail }));
      }),
      h('span', { class: 'col-legacy mono muted', text: legacy.join(' · '), title: legacy.join(' · ') }),
      h('span', { class: 'col-warn' }, sev ? severityDot(sev, issues.length) : null),
    );
    return row;
  }

  function compute() {
    const hits = selectors.searchMetrics(state.query);
    const ids = scenarios().map((s) => s.id);
    const f = state.filters;
    const out = [];
    const counts = { '': 0, complete: 0, partial: 0, missing: 0 };
    for (const m of store.list('metrics')) {
      if (hits && !hits.has(m.id)) continue;
      const cov = selectors.coverageOf(m.id);
      let ok = true;
      for (const s of allScenarios) if (f[`type:${s.id}`] && cov[s.id] !== f[`type:${s.id}`]) ok = false;
      if (!ok) continue;
      if (f.warningsOnly && !ctx.validation.issuesForMetric(m.id).some((i) => i.entity.type === 'binding' || i.scenarioId)) continue;
      const level = selectors.coverageLevel(m.id, ids);
      counts[''] += 1;
      counts[level] += 1;
      if (state.coverage && level !== state.coverage) continue;
      out.push(m);
    }
    out.sort((a, b) => compareText(a.code, b.code));
    for (const [k, b] of segButtons) b.querySelector('.seg-count').textContent = formatNumber(counts[k]);
    return out;
  }

  function refresh({ keepScroll = true } = {}) {
    state.items = compute();
    list.setItems(state.items, { keepScroll });
    const total = store.count('metrics');
    countLabel.textContent = state.items.length === total ? t('mm.count', { n: formatNumber(total) }) : t('mm.countFiltered', { n: formatNumber(state.items.length), total: formatNumber(total) });
    if (state.selectedId && !list.itemOf(state.selectedId)) selectCell(null, null);
  }

  // ---------------------------------------------------------------- selection + insights
  const insights = createInsightsPanel({ preferenceKey: 'bindings', title: t('insights.title'), emptyText: t('bindings.pick') });

  function selectCell(metricId, scenarioId) {
    const prev = { m: state.selectedId, s: state.scenarioId };
    state.selectedId = metricId && store.has('metrics', metricId) ? metricId : null;
    state.scenarioId = state.selectedId && scenarioId && state.visible.has(scenarioId) ? scenarioId : null;
    list.setSelected(state.selectedId);
    if (prev.s !== state.scenarioId || prev.m !== state.selectedId) list.refresh();
    const s = state.scenarioId ? store.get('scenarios', state.scenarioId) : null;
    ctx.router.setParams({ selected: state.selectedId, scenario: s ? s.code : null });
    renderInsights();
  }

  function renderInsights() {
    if (!state.selectedId) { insights.setContent(null); return; }
    const s = state.scenarioId ? store.get('scenarios', state.scenarioId) : null;
    const goDependencies = () => ctx.router.navigate('dependencies', { metric: state.selectedId, scenario: s ? s.code : null });
    if (!s) {
      insights.setContent(renderMetricInsights(ctx, state.selectedId, {
        onEdit: () => open(state.selectedId, null),
        onDependencies: goDependencies,
        onStructure: (nodeId) => ctx.router.navigate('metrics', { node: nodeId, selected: state.selectedId }),
      }));
      return;
    }
    insights.setContent(renderBindingInsights(ctx, state.selectedId, s.id, {
      onEdit: () => open(state.selectedId, s.id),
      onDependencies: goDependencies,
      onReference: (metricId, scenarioId) => {
        if (!list.itemOf(metricId)) { filters.reset(); setCoverage(''); }
        const idx = state.items.findIndex((m) => m.id === metricId);
        if (idx >= 0) list.scrollToIndex(idx);
        selectCell(metricId, scenarioId && state.visible.has(scenarioId) ? scenarioId : null);
      },
    }));
  }

  function open(id, scenarioId = null) {
    if (ctx.openMetric(id, { section: 'bindings', scenarioId })) ctx.router.setParams({ metric: id });
  }

  // ---------------------------------------------------------------- layout + sync
  const layout = workspaceLayout({ header: header.el, context: context.el, main, insights: insights.el, className: 'bindings-ws' });
  layout.el.insertBefore(filters.el, layout.body);
  container.appendChild(layout.el);

  const schedule = debounce(() => { refresh(); renderInsights(); }, 30);
  const offStore = store.events.on('change', (evt) => { if (['*', 'metrics', 'bindings', 'scenarios'].includes(evt.collection)) schedule(); });
  const offValidation = ctx.validation.onChange(() => { if (state.filters.warningsOnly) refresh(); else list.refresh(); renderInsights(); });
  renderHead();
  refresh();

  return {
    onShow() { list.refresh(); },
    onHide() {},
    onShortcut(e) {
      if (e.key === '/') { e.preventDefault(); filters.searchInput.focus(); filters.searchInput.select(); }
    },
    update(route) {
      const p = route.params;
      if (p.scenarios === 'all') {
        // A drill-through that means every scenario, whatever this page remembered.
        if (state.visible.size !== allScenarios.length) contextAll();
        ctx.router.setParams({ scenarios: null });
      } else if (p.scenarios) {
        const codes = new Set(String(p.scenarios).split(',').map((c) => c.trim().toUpperCase()));
        const wanted = allScenarios.filter((s) => codes.has(s.code.toUpperCase())).map((s) => s.id);
        if (wanted.length && (wanted.length !== state.visible.size || wanted.some((id) => !state.visible.has(id)))) { state.visible = new Set(wanted); applyContext(); }
      }
      const wantedFilters = readFilters(p, FILTER_SPEC);
      if (filtersDiffer(state.filters, wantedFilters, FILTER_SPEC)) filters.setMany(wantedFilters);
      if ((p.q || '') !== state.query) filters.setSearch(p.q || '');
      const coverage = normalizeCoverage(COVERAGE.includes(p.coverage) ? p.coverage : '', scenarios().length);
      if (coverage !== state.coverage) setCoverage(coverage);
      const scenario = p.scenario ? selectors.scenarioByCode(p.scenario) : null;
      if (p.selected && store.has('metrics', p.selected)) {
        if (!state.items.some((m) => m.id === p.selected)) {
          // The link asked for this metric; filters that hide it are cleared, and said so.
          filters.reset();
          if (state.coverage) setCoverage('');
          ctx.toast.info(t('mm.filtersClearedToReveal'));
        }
        if (p.selected !== state.selectedId || (scenario ? scenario.id : null) !== state.scenarioId) selectCell(p.selected, scenario ? scenario.id : null);
        const idx = state.items.findIndex((m) => m.id === p.selected);
        if (idx >= 0) list.scrollToIndex(idx);
      }
      const metricId = p.metric;
      if (metricId && store.has('metrics', metricId) && metricId !== ctx.currentMetricId) ctx.openMetric(metricId, { section: 'bindings', scenarioId: scenario ? scenario.id : null });
    },
    onDrawerClosed() { ctx.router.setParams({ metric: null }); list.refresh(); },
    onMetricOpened(id) { if (id !== state.selectedId) selectCell(id, state.scenarioId); else list.refresh(); },
    destroy() { offStore(); offValidation(); list.destroy(); schedule.cancel(); layout.el.remove(); },
  };
}
