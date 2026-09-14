import { h, btn, icon, clear, formatNumber } from '../../ui/dom.js';
import { t } from '../../ui/i18n.js';
import { GraphView } from '../../ui/graph/graph-view.js';
import { combobox } from '../../ui/components/combobox.js';
import { VirtualList } from '../../ui/table/virtual-list.js';
import { bindingChip } from '../../ui/components/chip.js';
import { DependencyService } from '../../services/dependency-service.js';
import { splitNodeKey } from '../../core/models/binding.js';
import { debounce } from '../../utils/debounce.js';
import { worstSeverity } from '../../services/validation-service.js';
import { pageHeader } from '../../ui/workspace/page-header.js';
import { contextBar, contextSelect } from '../../ui/workspace/context-bar.js';
import { workspaceLayout } from '../../ui/workspace/workspace-layout.js';
import { createInsightsPanel, insightSection } from '../../ui/workspace/insights-panel.js';
import { renderBindingInsights } from '../bindings/binding-insights.js';

/**
 * Dependencies — a focused subgraph around one root Metric × Scenario.
 *
 * Two rows above the canvas say two different things. The context bar
 * chooses what the graph is about: the root metric and the scenario (or
 * cross-scenario). The view bar chooses how it is drawn: how many levels
 * down and up, graph or table. Neither hides rows, so there is no filter
 * bar here.
 *
 * Selecting a node inspects it in the same Insights panel every workspace
 * has — the binding, its references, its neighbours in this graph — and
 * never opens the editor by itself. Double-click a node to re-root.
 */
export function mountDependencyView(container, ctx) {
  const { store, selectors, services } = ctx;
  const dep = services.dependencies;
  const state = { metricId: null, scenarioId: (selectors.scenarios()[0] || {}).id || null, mode: 'same', depthDown: 3, depthUp: 1, expanded: new Set(), collapsed: new Set(), selected: null, graph: null };

  // ---------------------------------------------------------------- header + context
  const statsEl = h('span', { class: 'muted small graph-stats' });
  const header = pageHeader({ title: t('nav.dependencies'), subtitle: t('dep.subtitle'), meta: statsEl });
  const rootPicker = combobox({
    placeholder: t('dep.pickRoot'),
    className: 'combo-wide',
    search: (q) => selectors.suggestMetrics(q, 10).map((m) => ({ id: m.id, label: m.name, sub: m.code, meta: coverageText(m.id) })),
    onSelect: (item) => setRoot(item.id, { navigate: true }),
  });
  const scenarioCtx = contextSelect({
    label: t('dep.scenario'),
    icon: 'layers',
    options: () => [
      ...selectors.scenarios().map((s) => ({ value: s.id, label: s.code, sub: s.name })),
      { value: 'cross', label: t('dep.cross'), sub: t('dep.crossTitle') },
    ],
    onChange: (v) => {
      if (v === 'cross') state.mode = 'cross';
      else { state.mode = 'same'; state.scenarioId = v; }
      resetExpansion();
      render({ navigate: true });
    },
  });
  const context = contextBar(
    h('div', { class: 'ctx ctx-root' }, icon('graph', { size: 14, className: 'ctx-icon' }), h('span', { class: 'ctx-label', text: t('dep.root') }), rootPicker.el),
    scenarioCtx.el,
    h('span', { class: 'spacer' }),
    h('span', { class: 'ctx-hint muted small', text: t('dep.contextHint') }),
  );

  // ---------------------------------------------------------------- view controls
  const modeSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': t('dep.viewMode') });
  const depthDown = h('select', { class: 'input input-sm', title: t('dep.depthDown') }, [1, 2, 3, 4, 5].map((n) => h('option', { value: n, text: t('dep.depthDownOpt', { n }), selected: n === state.depthDown })));
  const depthUp = h('select', { class: 'input input-sm', title: t('dep.depthUp') }, [0, 1, 2, 3].map((n) => h('option', { value: n, text: t('dep.depthUpOpt', { n }), selected: n === state.depthUp })));
  depthDown.addEventListener('change', () => { state.depthDown = Number(depthDown.value); resetExpansion(); render(); });
  depthUp.addEventListener('change', () => { state.depthUp = Number(depthUp.value); resetExpansion(); render(); });
  const tableSearch = h('input', { class: 'input search-input', type: 'search', placeholder: t('dep.tableSearch') });
  const tableSearchWrap = h('div', { class: 'search', hidden: true }, icon('search', { className: 'search-icon' }), tableSearch);
  const tableScenario = h('select', { class: 'input input-sm', hidden: true });
  const tableCount = h('span', { class: 'muted small', hidden: true });
  // Graph and Table are two views of the same context. The table lists the
  // edges of the graph on screen by default; "All catalogue" is an explicit
  // scope that says so, and only there does a scenario filter make sense.
  const scopeSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': t('dep.scopeLabel'), hidden: true });
  const viewBar = h('div', { class: 'view-bar' }, h('span', { class: 'view-bar-label', text: t('dep.viewMode') }), modeSeg, depthDown, depthUp, scopeSeg, tableSearchWrap, tableScenario, h('span', { class: 'spacer' }), tableCount);

  // ---------------------------------------------------------------- canvas + table
  const canvasHost = h('div', { class: 'graph-host' });
  const legend = h('div', { class: 'graph-legend' },
    legendItem('source', t('binding.type.source')), legendItem('formula', t('binding.type.formula')), legendItem('assumption', t('binding.type.assumption')), legendItem('none', t('binding.type.none')),
    h('span', { class: 'legend-item' }, h('span', { class: 'legend-edge cross' }), h('span', { text: t('dep.crossEdge') })),
    h('span', { class: 'legend-item' }, h('span', { class: 'legend-hint', text: t('dep.legendHint') })),
  );
  const emptyState = h('div', { class: 'empty graph-empty' }, icon('graph', { size: 32 }), h('p', { text: t('dep.empty') }), h('div', { class: 'suggest-list' }));
  const truncatedNote = h('div', { class: 'graph-note', role: 'status', hidden: true });
  const graphArea = h('div', { class: 'graph-area' }, canvasHost, truncatedNote, legend, emptyState);
  const tableHead = h('div', { class: 'table-head edge-row' },
    h('span', { text: t('dep.col.targetScenario') }), h('span', { text: t('dep.col.target') }), h('span', { text: t('dep.col.type') }),
    h('span', { text: t('dep.col.sourceScenario') }), h('span', { text: t('dep.col.source') }), h('span', { class: 'num', text: t('dep.col.seq') }),
    h('span', { text: t('dep.col.refType') }), h('span', { text: t('dep.col.dimension') }), h('span', { text: t('dep.col.operator') }),
  );
  const tableEmptyText = h('p', { text: t('dep.tableEmpty') });
  const tableEmpty = h('div', { class: 'empty', hidden: true }, icon('graph', { size: 28 }), tableEmptyText);
  const tableHost = h('div', { class: 'list-host' });
  const tableArea = h('div', { class: 'edge-table', hidden: true }, tableHost, tableEmpty);
  const main = h('section', { class: 'pane dep-main' }, graphArea, tableArea);

  const insights = createInsightsPanel({ preferenceKey: 'dependencies', title: t('insights.title'), emptyText: t('dep.pickNode') });
  const layout = workspaceLayout({ header: header.el, context: context.el, main, insights: insights.el, className: 'dep-ws' });
  layout.el.insertBefore(viewBar, layout.body);
  container.appendChild(layout.el);

  const tableState = { query: '', scenarioId: '', selected: null, scope: 'graph' };
  const table = new VirtualList(tableHost, {
    rowHeight: 'dense',
    keyOf: (r) => r.id,
    emptyNode: tableEmpty,
    renderRow: renderEdgeRow,
    header: tableHead,
    minWidth: 28 + 56 + 160 + 64 + 64 + 160 + 40 + 96 + 90 + 64 + 80,
    onSelect: (r) => { tableState.selected = r ? r.id : null; renderTableInsights(r); },
    onActivate: (r) => ctx.openMetric(r.targetMetricId, { section: 'bindings', scenarioId: r.targetScenarioId }),
  });
  let viewMode = 'graph';

  function renderModeSeg() {
    clear(modeSeg);
    for (const m of ['graph', 'table']) {
      modeSeg.appendChild(h('button', { type: 'button', role: 'radio', class: ['seg-btn', viewMode === m && 'active'], 'aria-checked': String(viewMode === m), on: { click: () => setMode(m) } }, t(`dep.mode.${m}`)));
    }
  }

  function setMode(m) {
    if (viewMode === m) return;
    viewMode = m;
    ctx.router.setParams({ view: m === 'table' ? 'table' : null });
    renderModeSeg();
    applyMode();
  }

  function renderScopeSeg() {
    clear(scopeSeg);
    for (const sc of ['graph', 'all']) {
      scopeSeg.appendChild(h('button', { type: 'button', role: 'radio', class: ['seg-btn', tableState.scope === sc && 'active'], 'aria-checked': String(tableState.scope === sc), on: { click: () => setScope(sc) } }, t(`dep.scope.${sc}`)));
    }
  }

  function setScope(sc) {
    if (tableState.scope === sc) return;
    tableState.scope = sc;
    ctx.router.setParams({ scope: sc === 'all' ? 'all' : null });
    renderScopeSeg();
    applyMode();
  }

  function applyMode() {
    const tableOn = viewMode === 'table';
    graphArea.hidden = tableOn;
    tableArea.hidden = !tableOn;
    // Depth is a graph setting; it still shapes the table when the table
    // lists this graph's edges, so it stays visible in that scope.
    for (const el of [depthDown, depthUp]) el.hidden = tableOn && tableState.scope === 'all';
    for (const el of [tableSearchWrap, tableCount, scopeSeg]) el.hidden = !tableOn;
    tableScenario.hidden = !tableOn || tableState.scope !== 'all';
    if (tableOn) {
      render({ keepView: true });
    } else {
      render({ keepView: true });
    }
  }

  function renderEdgeRow(r) {
    return h('div', { class: ['edge-row', 'row', !r.resolved && 'unresolved'], role: 'row', tabindex: '-1', dataset: { id: r.id }, title: t('dep.tableHint') },
      h('span', { class: 'mono', text: r.targetScenario }),
      h('span', { class: 'cell-two' }, h('span', { class: 'mono muted', text: r.targetCode }), h('span', { class: 'ellipsis', text: r.targetName })),
      h('span', null, bindingChip('', 'formula')),
      h('span', { class: ['mono', r.referenceType === 'cross-scenario' && 'tag tag-cross'], text: r.sourceScenario }),
      h('span', { class: 'cell-two' }, h('span', { class: 'mono muted', text: r.sourceCode }), h('span', { class: ['ellipsis', !r.resolved && 'danger'], text: r.resolved ? r.sourceName : t('dep.unresolved') })),
      h('span', { class: 'num', text: String(r.sequence) }),
      h('span', { class: 'muted small', text: r.referenceType === 'cross-scenario' ? t('dep.crossEdge') : t('dep.sameEdge') }),
      h('span', { class: 'mono small ellipsis', text: r.dimensionContext }),
      h('span', { class: 'mono small', text: r.operator }),
    );
  }

  function refreshTable() {
    const q = tableState.query.trim().toLowerCase();
    let rows = dep.referenceRows();
    const inGraph = tableState.scope === 'graph';
    if (inGraph) {
      // The same edges the canvas draws, one row per reference occurrence.
      const ids = new Set(state.graph ? state.graph.edges.map((e) => e.id) : []);
      rows = rows.filter((r) => ids.has(r.edgeId));
      tableEmptyText.textContent = state.metricId ? t('dep.tableEmpty') : t('dep.tableNoRoot');
    } else {
      if (tableState.scenarioId) rows = rows.filter((r) => r.targetScenarioId === tableState.scenarioId);
      tableEmptyText.textContent = t('dep.tableEmpty');
    }
    if (q) rows = rows.filter((r) => [r.targetCode, r.targetName, r.targetAliases, r.sourceCode, r.sourceName, r.sourceAliases, r.token, r.formulaText].some((v) => String(v || '').toLowerCase().includes(q)));
    table.setItems(rows);
    // A row the table no longer shows is not inspected either.
    if (tableState.selected && !rows.some((r) => r.id === tableState.selected)) { tableState.selected = null; renderTableInsights(null); }
    table.setSelected(tableState.selected);
    tableCount.textContent = inGraph ? t('dep.tableCountGraph', { n: formatNumber(rows.length) }) : t('dep.tableCount', { n: formatNumber(rows.length), total: formatNumber(dep.referenceRows().length) });
  }

  function renderTableInsights(row) {
    if (!row) { insights.setContent(null); return; }
    insights.setContent(renderBindingInsights(ctx, row.targetMetricId, row.targetScenarioId, {
      onEdit: () => ctx.openMetric(row.targetMetricId, { section: 'bindings', scenarioId: row.targetScenarioId }),
      onDependencies: () => { setMode('graph'); setRoot(row.targetMetricId, { scenarioId: row.targetScenarioId, navigate: true }); },
      onReference: (metricId, scenarioId) => { setMode('graph'); setRoot(metricId, { scenarioId, navigate: true }); },
    }));
  }

  function fillTableScenario() {
    tableScenario.replaceChildren(h('option', { value: '', text: t('dep.anyScenario') }), ...selectors.scenarios().map((s) => h('option', { value: s.id, text: s.code, selected: s.id === tableState.scenarioId })));
  }
  const onTableSearch = debounce(() => { tableState.query = tableSearch.value; refreshTable(); }, 120);
  tableSearch.addEventListener('input', onTableSearch);
  tableScenario.addEventListener('change', () => { tableState.scenarioId = tableScenario.value; refreshTable(); });
  fillTableScenario();
  renderModeSeg();
  renderScopeSeg();

  const view = new GraphView(canvasHost, {
    renderNode,
    onSelect: (key) => select(key),
    onRoot: (key) => { const { metricId, scenarioId } = splitNodeKey(key); setRoot(metricId, { scenarioId, navigate: true }); },
  });

  function legendItem(type, label) {
    return h('span', { class: 'legend-item' }, h('span', { class: `legend-swatch type-${type}` }), h('span', { text: label }));
  }

  function coverageText(metricId) {
    const cov = selectors.coverageOf(metricId);
    return selectors.scenarios().map((s) => `${s.code}:${cov[s.id] ? t(`binding.type.${cov[s.id]}.short`) : '—'}`).join(' ');
  }

  function renderScenarioCtx() {
    if (state.mode === 'cross') scenarioCtx.setValue('cross', t('dep.cross'));
    else {
      const s = store.get('scenarios', state.scenarioId);
      scenarioCtx.setValue(state.scenarioId, s ? s.code : '—');
    }
  }

  function resetExpansion() {
    state.expanded.clear();
    state.collapsed.clear();
  }

  // ---------------------------------------------------------------- nodes
  function renderNode(node) {
    const type = node.missing || node.unknownScenario ? 'missing' : node.type;
    const scenario = node.scenarioCode || '?';
    const issues = node.metricId ? ctx.validation.issuesForMetric(node.metricId).filter((i) => !i.scenarioId || i.scenarioId === node.scenarioId) : [];
    const sev = worstSeverity(issues);
    const el = h('div', { class: ['node-card', `type-${type}`, node.isRoot && 'root', node.external && 'external', node.inCycle && 'cycle', node.metric && node.metric.status !== 'approved' && `status-${node.metric.status}`], role: 'button', tabindex: '0', title: node.metric ? `${node.metric.code} · ${node.metric.name}` : node.token });
    el.append(
      h('div', { class: 'node-top' }, h('span', { class: ['node-scn', node.unknownScenario && 'unknown'], text: scenario }), h('span', { class: `node-type chip-${type}`, text: node.unknownScenario ? t('dep.unknownScenario') : node.missing ? t('dep.missing') : t(`binding.type.${type}.short`) }), sev && h('span', { class: `sev-dot sev-${sev}` })),
      h('div', { class: 'node-name', text: node.metric ? node.metric.name : node.token }),
      h('div', { class: 'node-code mono', text: node.metric ? node.metric.code : t('dep.unresolved') }),
    );
    const inert = node.missing || node.unknownScenario;
    if (node.hasMoreDown && !inert) el.appendChild(h('button', { type: 'button', class: 'node-expand right', title: t('dep.expandDown'), on: { click: (e) => { e.stopPropagation(); expand(node.key); } } }, '+'));
    if (node.hasMoreUp && !inert) el.appendChild(h('button', { type: 'button', class: 'node-expand left', title: t('dep.expandUp'), on: { click: (e) => { e.stopPropagation(); expand(node.key); } } }, '+'));
    if (!node.isRoot && !inert && state.graph && state.graph.edges.some((e) => e.from === node.key) && !state.collapsed.has(node.key) && node.depth > 0) {
      el.appendChild(h('button', { type: 'button', class: 'node-expand right collapse', title: t('dep.collapse'), on: { click: (e) => { e.stopPropagation(); collapse(node.key); } } }, '−'));
    }
    return el;
  }

  function expand(key) {
    state.collapsed.delete(key);
    state.expanded.add(key);
    render({ keepView: true });
  }

  function collapse(key) {
    state.expanded.delete(key);
    state.collapsed.add(key);
    render({ keepView: true });
  }

  // ---------------------------------------------------------------- render
  function render({ keepView = false, navigate = false } = {}) {
    renderScenarioCtx();
    if (navigate) ctx.router.setParams({ metric: state.metricId, scenario: store.get('scenarios', state.scenarioId)?.code, mode: state.mode === 'cross' ? 'cross' : null });
    const has = state.metricId && store.has('metrics', state.metricId) && state.scenarioId;
    const tableOn = viewMode === 'table';
    emptyState.hidden = !!has || tableOn;
    canvasHost.hidden = !has;
    legend.hidden = !has;
    if (!has) {
      state.graph = null;
      if (!tableOn) { renderSuggestions(); insights.setContent(null); }
      truncatedNote.hidden = true;
      statsEl.textContent = '';
      if (tableOn) refreshTable();
      return;
    }
    // The same subgraph feeds the canvas and the table: one context, two views.
    state.graph = dep.subgraph({ metricId: state.metricId, scenarioId: state.scenarioId, mode: state.mode, depthDown: state.depthDown, depthUp: state.depthUp, expanded: state.expanded, collapsed: state.collapsed });
    if (tableOn) {
      const s = dep.stats();
      statsEl.textContent = t('dep.stats', { nodes: formatNumber(state.graph.nodes.size), edges: formatNumber(state.graph.edges.length), total: formatNumber(s.edges), cycles: s.cycles });
      refreshTable();
      return;
    }
    truncatedNote.hidden = !state.graph.truncated;
    if (state.graph.truncated) truncatedNote.textContent = t('dep.truncated', { n: formatNumber(state.graph.nodeLimit), e: formatNumber(state.graph.edgeLimit) });
    view.setGraph(state.graph, { keepView });
    if (state.selected && !state.graph.nodes.has(state.selected)) state.selected = null;
    applyHighlight();
    const s = dep.stats();
    statsEl.textContent = t('dep.stats', { nodes: formatNumber(state.graph.nodes.size), edges: formatNumber(state.graph.edges.length), total: formatNumber(s.edges), cycles: s.cycles });
    renderNodeInsights();
  }

  function renderSuggestions() {
    const list = emptyState.querySelector('.suggest-list');
    clear(list);
    const scored = [];
    for (const m of store.list('metrics')) {
      let n = 0;
      for (const s of selectors.scenarios()) n += dep.edgesFrom(`${m.id}|${s.id}`).length + dep.edgesTo(`${m.id}|${s.id}`).length;
      if (n) scored.push({ m, n });
    }
    scored.sort((a, b) => b.n - a.n);
    for (const { m, n } of scored.slice(0, 6)) list.appendChild(h('button', { type: 'button', class: 'suggestion', on: { click: () => setRoot(m.id, { navigate: true }) } }, h('span', { class: 'mono muted', text: m.code }), h('span', { text: m.name }), h('span', { class: 'muted small', text: t('dep.edgeCount', { n }) })));
  }

  function setRoot(metricId, { scenarioId = null, navigate = false } = {}) {
    state.metricId = metricId;
    if (scenarioId) state.scenarioId = scenarioId;
    else {
      // Prefer a scenario where the metric has a formula.
      const cov = selectors.coverageOf(metricId);
      if (!cov[state.scenarioId]) {
        const withFormula = selectors.scenarios().find((s) => cov[s.id] === 'formula') || selectors.scenarios().find((s) => cov[s.id]);
        if (withFormula) state.scenarioId = withFormula.id;
      }
    }
    resetExpansion();
    state.selected = null;
    const m = store.get('metrics', metricId);
    if (m) rootPicker.input.value = `${m.code} · ${m.name}`;
    render({ navigate });
  }

  function select(key) {
    state.selected = key;
    applyHighlight();
    renderNodeInsights();
  }

  function applyHighlight() {
    if (!state.graph) return;
    if (!state.selected) {
      view.highlight({});
      return;
    }
    view.highlight({ selected: state.selected, down: DependencyService.reachable(state.selected, state.graph.edges, 'down'), up: DependencyService.reachable(state.selected, state.graph.edges, 'up') });
  }

  /** The Insights panel for the selected node: its binding, plus its neighbours in this graph. */
  function renderNodeInsights() {
    const key = state.selected;
    if (!key || !state.graph || !state.graph.nodes.has(key)) {
      insights.setContent(null);
      return;
    }
    const node = state.graph.nodes.get(key);
    const m = node.metric;
    const users = state.graph.edges.filter((e) => e.to === key);
    const fixList = () => h('ul', { class: 'insight-list' }, users.map((e) => {
      const from = state.graph.nodes.get(e.from);
      if (!from || !from.metric) return null;
      return h('li', null, h('span', { class: 'mono muted', text: from.metric.code }), h('button', { type: 'button', class: 'link ellipsis', on: { click: () => ctx.openMetric(from.metricId, { section: 'bindings', scenarioId: from.scenarioId }) } }, t('dep.fixIn', { name: from.metric.name })));
    }));
    if (node.unknownScenario || !m) {
      insights.setContent(h('div', { class: 'insight insight-sev-error' },
        h('div', { class: 'insight-head' }, h('div', { class: 'insight-title', text: node.token || '?' }), h('div', { class: 'insight-sub' }, h('span', { class: 'tag', text: node.unknownScenario ? t('dep.unknownScenario') : t('dep.missing') }))),
        insightSection(t('group.quality'), h('p', { class: 'insight-para', text: node.unknownScenario ? t('dep.unknownScenarioHint', { code: node.scenarioCode || '?' }) : t('dep.missingHint', { token: node.token }) }), fixList()),
      ));
      return;
    }
    const content = renderBindingInsights(ctx, m.id, node.scenarioId, {
      onEdit: () => ctx.openMetric(m.id, { section: 'bindings', scenarioId: node.scenarioId }),
      onReference: (metricId, scenarioId) => {
        const k = `${metricId}|${scenarioId}`;
        if (state.graph.nodes.has(k)) { select(k); view.centerOn(k); } else setRoot(metricId, { scenarioId, navigate: true });
      },
    });
    if (!content) { insights.setContent(null); return; }
    const down = state.graph.edges.filter((e) => e.from === key);
    const relList = (edges, pick, label) => {
      if (!edges.length) return null;
      return h('div', null, h('div', { class: 'insight-heading', text: `${label} (${edges.length})` }), h('ul', { class: 'insight-list' }, edges.map((e) => {
        const other = state.graph.nodes.get(pick(e));
        return h('li', null,
          h('span', { class: 'mono muted', text: other && other.metric ? other.metric.code : '?' }),
          h('button', { type: 'button', class: 'link ellipsis', on: { click: () => { select(pick(e)); view.centerOn(pick(e)); } } }, other && other.metric ? other.metric.name : e.token),
          e.isCrossScenario && h('span', { class: 'tag tag-cross', text: (other && other.scenarioCode) || '' }),
          !e.resolved && h('span', { class: 'tag tag-warn', text: t('dep.missing') }));
      })));
    };
    const inGraph = h('div', { class: 'insight-section' }, h('div', { class: 'insight-heading', text: t('dep.inGraph') }), relList(down, (e) => e.to, t('dep.dependsOn')) || h('p', { class: 'insight-para muted', text: `${t('dep.dependsOn')}: 0` }), relList(users, (e) => e.from, t('dep.usedBy')) || h('p', { class: 'insight-para muted', text: `${t('dep.usedBy')}: 0` }));
    const actions = content.querySelector('.insight-actions');
    content.insertBefore(inGraph, actions);
    if (!node.isRoot) actions.appendChild(btn(t('dep.makeRoot'), { size: 'sm', icon: 'graph', on: { click: () => setRoot(m.id, { scenarioId: node.scenarioId, navigate: true }) } }));
    insights.setContent(content);
  }

  const schedule = debounce(() => render({ keepView: true }), 60);
  const offStore = store.events.on('change', (evt) => { if (['*', 'metrics', 'bindings', 'scenarios'].includes(evt.collection)) schedule(); });
  const offValidation = ctx.validation.onChange(() => schedule());
  render();

  return {
    update(route) {
      const p = route.params;
      const wanted = p.view === 'table' ? 'table' : 'graph';
      const wantedScope = p.scope === 'all' ? 'all' : 'graph';
      if (wantedScope !== tableState.scope) { tableState.scope = wantedScope; renderScopeSeg(); }
      if (wanted !== viewMode) {
        viewMode = wanted;
        renderModeSeg();
        applyMode();
      }
      const scenario = p.scenario ? selectors.scenarioByCode(p.scenario) : null;
      if (scenario) state.scenarioId = scenario.id;
      state.mode = p.mode === 'cross' ? 'cross' : 'same';
      if (p.metric && store.has('metrics', p.metric)) {
        if (p.metric !== state.metricId) setRoot(p.metric, { scenarioId: scenario ? scenario.id : null });
        else render({ keepView: true });
      } else if (state.metricId && store.has('metrics', state.metricId)) {
        // A bare route (a top-bar link) does not mean "forget the root".
        render({ keepView: true, navigate: true });
      } else render();
    },
    onShow() { if (viewMode === 'table') table.refresh(); },
    onHide() {},
    onShortcut(e) {
      if (e.key === '/' && viewMode === 'table') { e.preventDefault(); tableSearch.focus(); tableSearch.select(); }
    },
    onDrawerClosed() {},
    onMetricOpened() {},
    destroy() { offStore(); offValidation(); schedule.cancel(); onTableSearch.cancel(); table.destroy(); view.destroy(); layout.el.remove(); },
  };
}
