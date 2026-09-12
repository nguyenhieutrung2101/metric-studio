import { h, btn, icon, clear, formatNumber } from '../../ui/dom.js';
import { t } from '../../ui/i18n.js';
import { GraphView } from '../../ui/graph/graph-view.js';
import { combobox } from '../../ui/components/combobox.js';
import { bindingChip } from '../../ui/components/chip.js';
import { DependencyService } from '../../services/dependency-service.js';
import { splitNodeKey } from '../../core/models/binding.js';
import { debounce } from '../../utils/debounce.js';
import { worstSeverity } from '../../services/validation-service.js';

/**
 * Dependencies — focused subgraph around a root Metric × Scenario.
 * Never renders the whole catalogue; expand the fringe on demand.
 */
export function mountDependencyView(container, ctx) {
  const { store, selectors, services } = ctx;
  const dep = services.dependencies;
  const state = { metricId: null, scenarioId: (selectors.scenarios()[0] || {}).id || null, mode: 'same', depthDown: 3, depthUp: 1, expanded: new Set(), collapsed: new Set(), selected: null, graph: null };

  // ---------------------------------------------------------------- toolbar
  const rootPicker = combobox({
    placeholder: t('dep.pickRoot'),
    className: 'combo-wide',
    search: (q) => selectors.suggestMetrics(q, 10).map((m) => ({ id: m.id, label: m.name, sub: m.code, meta: coverageText(m.id) })),
    onSelect: (item) => setRoot(item.id, { navigate: true }),
  });
  const scenarioSeg = h('div', { class: 'seg', role: 'radiogroup' });
  const depthDown = h('select', { class: 'input input-sm', title: t('dep.depthDown') }, [1, 2, 3, 4, 5].map((n) => h('option', { value: n, text: t('dep.depthDownOpt', { n }), selected: n === state.depthDown })));
  const depthUp = h('select', { class: 'input input-sm', title: t('dep.depthUp') }, [0, 1, 2, 3].map((n) => h('option', { value: n, text: t('dep.depthUpOpt', { n }), selected: n === state.depthUp })));
  depthDown.addEventListener('change', () => { state.depthDown = Number(depthDown.value); state.expanded.clear(); state.collapsed.clear(); render(); });
  depthUp.addEventListener('change', () => { state.depthUp = Number(depthUp.value); state.expanded.clear(); state.collapsed.clear(); render(); });
  const statsEl = h('span', { class: 'muted small graph-stats' });
  const toolbar = h('div', { class: 'toolbar' }, rootPicker.el, scenarioSeg, depthDown, depthUp, h('span', { class: 'spacer' }), statsEl);

  // ---------------------------------------------------------------- canvas + panel
  const canvasHost = h('div', { class: 'graph-host' });
  const legend = h('div', { class: 'graph-legend' },
    legendItem('source', t('binding.type.source')), legendItem('formula', t('binding.type.formula')), legendItem('assumption', t('binding.type.assumption')), legendItem('none', t('binding.type.none')),
    h('span', { class: 'legend-item' }, h('span', { class: 'legend-edge cross' }), h('span', { text: t('dep.crossEdge') })),
    h('span', { class: 'legend-item' }, h('span', { class: 'legend-hint', text: t('dep.legendHint') })),
  );
  const emptyState = h('div', { class: 'empty graph-empty' }, icon('graph', { size: 32 }), h('p', { text: t('dep.empty') }), h('div', { class: 'suggest-list' }));
  const panel = h('aside', { class: 'pane side-panel', hidden: true });
  const body = h('div', { class: 'dep-layout' }, h('div', { class: 'graph-area' }, canvasHost, legend, emptyState), panel);
  const root = h('div', { class: 'view-single dep-view' }, toolbar, body);
  container.appendChild(root);

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

  function renderScenarioSeg() {
    clear(scenarioSeg);
    for (const s of selectors.scenarios()) {
      scenarioSeg.appendChild(h('button', { type: 'button', role: 'radio', class: ['seg-btn', state.mode === 'same' && state.scenarioId === s.id && 'active'], on: { click: () => { state.scenarioId = s.id; state.mode = 'same'; resetExpansion(); render({ navigate: true }); } } }, s.code));
    }
    scenarioSeg.appendChild(h('button', { type: 'button', role: 'radio', class: ['seg-btn', state.mode === 'cross' && 'active'], title: t('dep.crossTitle'), on: { click: () => { state.mode = 'cross'; resetExpansion(); render({ navigate: true }); } } }, t('dep.cross')));
  }

  function resetExpansion() {
    state.expanded.clear();
    state.collapsed.clear();
  }

  // ---------------------------------------------------------------- nodes
  function renderNode(node) {
    const type = node.missing ? 'missing' : node.type;
    const scenario = node.scenario ? node.scenario.code : '?';
    const issues = node.metricId ? ctx.validation.issuesForMetric(node.metricId).filter((i) => !i.scenarioId || i.scenarioId === node.scenarioId) : [];
    const sev = worstSeverity(issues);
    const el = h('div', { class: ['node-card', `type-${type}`, node.isRoot && 'root', node.external && 'external', node.inCycle && 'cycle', node.metric && node.metric.status !== 'approved' && `status-${node.metric.status}`], role: 'button', tabindex: '0', title: node.metric ? `${node.metric.code} · ${node.metric.name}` : node.token });
    el.append(
      h('div', { class: 'node-top' }, h('span', { class: 'node-scn', text: scenario }), h('span', { class: `node-type chip-${type}`, text: node.missing ? t('dep.missing') : t(`binding.type.${type}.short`) }), sev && h('span', { class: `sev-dot sev-${sev}` })),
      h('div', { class: 'node-name', text: node.metric ? node.metric.name : node.token }),
      h('div', { class: 'node-code mono', text: node.metric ? node.metric.code : t('dep.unresolved') }),
    );
    if (node.hasMoreDown && !node.missing) el.appendChild(h('button', { type: 'button', class: 'node-expand right', title: t('dep.expandDown'), on: { click: (e) => { e.stopPropagation(); expand(node.key); } } }, '+'));
    if (node.hasMoreUp && !node.missing) el.appendChild(h('button', { type: 'button', class: 'node-expand left', title: t('dep.expandUp'), on: { click: (e) => { e.stopPropagation(); expand(node.key); } } }, '+'));
    if (!node.isRoot && !node.missing && state.graph && state.graph.edges.some((e) => e.from === node.key) && !state.collapsed.has(node.key) && node.depth > 0) {
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
    renderScenarioSeg();
    if (navigate) ctx.router.setParams({ metric: state.metricId, scenario: store.get('scenarios', state.scenarioId)?.code, mode: state.mode === 'cross' ? 'cross' : null });
    const has = state.metricId && store.has('metrics', state.metricId) && state.scenarioId;
    emptyState.hidden = !!has;
    canvasHost.hidden = !has;
    legend.hidden = !has;
    if (!has) {
      renderSuggestions();
      panel.hidden = true;
      statsEl.textContent = '';
      return;
    }
    state.graph = dep.subgraph({ metricId: state.metricId, scenarioId: state.scenarioId, mode: state.mode, depthDown: state.depthDown, depthUp: state.depthUp, expanded: state.expanded, collapsed: state.collapsed });
    view.setGraph(state.graph, { keepView });
    if (state.selected && !state.graph.nodes.has(state.selected)) state.selected = null;
    applyHighlight();
    const s = dep.stats();
    statsEl.textContent = t('dep.stats', { nodes: formatNumber(state.graph.nodes.size), edges: formatNumber(state.graph.edges.length), total: formatNumber(s.edges), cycles: s.cycles });
    renderPanel();
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
    renderPanel();
  }

  function applyHighlight() {
    if (!state.graph) return;
    if (!state.selected) {
      view.highlight({});
      return;
    }
    view.highlight({ selected: state.selected, down: DependencyService.reachable(state.selected, state.graph.edges, 'down'), up: DependencyService.reachable(state.selected, state.graph.edges, 'up') });
  }

  function renderPanel() {
    clear(panel);
    const key = state.selected;
    if (!key || !state.graph || !state.graph.nodes.has(key)) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    const node = state.graph.nodes.get(key);
    const m = node.metric;
    const b = node.binding;
    panel.append(h('div', { class: 'pane-head' }, h('span', { class: 'pane-title', text: m ? m.name : node.token }), btn('', { icon: 'close', size: 'sm', title: t('common.close'), on: { click: () => select(null) } })));
    const content = h('div', { class: 'side-content' });
    if (!m) {
      content.append(h('p', { class: 'hint warn', text: t('dep.missingHint', { token: node.token }) }));
      const users = state.graph.edges.filter((e) => e.to === key);
      for (const e of users) {
        const from = state.graph.nodes.get(e.from);
        if (from && from.metric) content.appendChild(h('button', { type: 'button', class: 'suggestion', on: { click: () => ctx.openMetric(from.metricId, { section: 'bindings', scenarioId: from.scenarioId }) } }, h('span', { class: 'mono muted', text: from.metric.code }), h('span', { text: t('dep.fixIn', { name: from.metric.name }) })));
      }
      panel.appendChild(content);
      return;
    }
    content.append(
      h('div', { class: 'side-row' }, h('span', { class: 'mono muted', text: m.code }), bindingChip(node.scenario.code, b && b.type !== 'none' ? b.type : null)),
      m.definition && h('p', { class: 'side-def', text: m.definition }),
    );
    if (b && b.type === 'formula') content.append(h('div', { class: 'side-label', text: t('binding.formula') }), h('pre', { class: 'formula-pre', text: b.formulaText }));
    if (b && b.type === 'source') content.append(h('div', { class: 'side-label', text: t('binding.type.source') }), h('p', { class: 'mono small', text: [b.source.system, b.source.dataset, b.source.field].filter(Boolean).join(' / ') || '—' }));
    if (b && b.type === 'assumption') content.append(h('div', { class: 'side-label', text: t('binding.type.assumption') }), h('p', { class: 'small' }, h('strong', { text: b.assumption.value || '—' }), b.assumption.basis ? h('span', { class: 'muted', text: ` — ${b.assumption.basis}` }) : null));
    const down = state.graph.edges.filter((e) => e.from === key);
    const up = state.graph.edges.filter((e) => e.to === key);
    const relList = (edges, pick, label) => {
      if (!edges.length) return null;
      return h('div', null, h('div', { class: 'side-label', text: `${label} (${edges.length})` }), h('ul', { class: 'rel-list' }, edges.map((e) => {
        const other = state.graph.nodes.get(pick(e));
        return h('li', null, h('button', { type: 'button', class: 'link', on: { click: () => select(pick(e)) } }, h('span', { class: 'mono muted', text: other && other.metric ? other.metric.code : '?' }), h('span', { text: other && other.metric ? other.metric.name : e.token })), e.isCrossScenario && h('span', { class: 'tag tag-cross', text: other && other.scenario ? other.scenario.code : '' }), !e.resolved && h('span', { class: 'tag tag-warn', text: t('dep.missing') }));
      })));
    };
    content.append(relList(down, (e) => e.to, t('dep.dependsOn')), relList(up, (e) => e.from, t('dep.usedBy')));
    const issues = ctx.validation.issuesForMetric(m.id).filter((i) => !i.scenarioId || i.scenarioId === node.scenarioId);
    if (issues.length) content.append(h('div', { class: 'side-label', text: t('warnings.title') }), h('ul', { class: 'issue-list' }, issues.slice(0, 5).map((i) => h('li', { class: 'issue-item' }, h('span', { class: `sev-dot sev-${i.severity}` }), h('span', { text: ctx.describeIssue(i) })))));
    content.append(h('div', { class: 'side-actions' },
      btn(t('dep.openMetric'), { size: 'sm', icon: 'external', on: { click: () => ctx.openMetric(m.id, { section: 'bindings', scenarioId: node.scenarioId }) } }),
      !node.isRoot && btn(t('dep.makeRoot'), { size: 'sm', icon: 'graph', on: { click: () => setRoot(m.id, { scenarioId: node.scenarioId, navigate: true }) } }),
    ));
    panel.appendChild(content);
  }

  const schedule = debounce(() => render({ keepView: true }), 60);
  const offStore = store.events.on('change', (evt) => { if (['*', 'metrics', 'bindings', 'scenarios'].includes(evt.collection)) schedule(); });
  const offValidation = ctx.validation.onChange(() => schedule());
  render();

  return {
    update(route) {
      const p = route.params;
      const scenario = p.scenario ? selectors.scenarioByCode(p.scenario) : null;
      if (scenario) state.scenarioId = scenario.id;
      state.mode = p.mode === 'cross' ? 'cross' : 'same';
      if (p.metric && store.has('metrics', p.metric)) {
        if (p.metric !== state.metricId) setRoot(p.metric, { scenarioId: scenario ? scenario.id : null });
        else render({ keepView: true });
      } else render();
    },
    onDrawerClosed() {},
    onMetricOpened() {},
    destroy() { offStore(); offValidation(); schedule.cancel(); view.destroy(); root.remove(); },
  };
}
