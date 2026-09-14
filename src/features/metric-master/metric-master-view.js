import { h, btn, icon, clear, formatNumber } from '../../ui/dom.js';
import { t } from '../../ui/i18n.js';
import { Tree } from '../../ui/tree/tree.js';
import { VirtualList } from '../../ui/table/virtual-list.js';
import { openMenu } from '../../ui/components/menu.js';
import { promptDialog } from '../../ui/components/confirm.js';
import { bindingChip, severityDot } from '../../ui/components/chip.js';
import { METRIC_STATUSES } from '../../core/models/metric.js';
import { debounce } from '../../utils/debounce.js';
import { compareText } from '../../utils/text.js';
import { getPreference, setPreference } from '../../utils/preferences.js';
import { worstSeverity } from '../../services/validation-service.js';
import { pageHeader } from '../../ui/workspace/page-header.js';
import { contextBar, contextSelect } from '../../ui/workspace/context-bar.js';
import { workspaceLayout } from '../../ui/workspace/workspace-layout.js';
import { createInsightsPanel } from '../../ui/workspace/insights-panel.js';
import { filterBar } from '../../ui/filter/filter-bar.js';
import { writeFilters, readFilters, filtersDiffer } from '../../ui/workspace/route-state.js';
import { nodeOptions } from './metric-drawer.js';
import { renderMetricInsights } from './metric-insights.js';

const NODE_MIME = 'application/x-metric-studio-node';
const METRIC_MIME = 'application/x-metric-studio-metric';

/**
 * Metric Master — the worksheet.
 *
 *   structure navigator │ primary grid │ insights
 *
 * The contract: a single click selects a row and the inspector shows it;
 * double-click, Enter or *Edit* open the editor. Inspecting ten metrics
 * means ten clicks, not ten drawers. The structure tree on the left is a
 * context selector here — it scopes the grid — and editing the hierarchy
 * lives in the Structure workspace; dropping a metric onto a node is the
 * one edit that stays, because it is about the metric, not the tree.
 */
export function mountMetricMasterView(container, ctx) {
  const { store, selectors, services } = ctx;
  const state = {
    nodeId: 'all',
    query: '',
    filters: {},
    sort: { key: 'code', dir: 1 },
    items: [],
    selectedId: null,
  };
  const expanded = new Set(getPreference('tree.expanded', []));

  // ---------------------------------------------------------------- header + context
  const newBtn = btn(t('mm.newMetric'), { kind: 'primary', size: 'sm', icon: 'plus', on: { click: () => newMetric() } });
  const countLabel = h('span', { class: 'count-label' });
  const header = pageHeader({ title: t('nav.metrics'), meta: countLabel, actions: [newBtn] });

  const structureCtx = contextSelect({
    label: t('mm.structure'),
    icon: 'folder',
    value: t('mm.allMetrics'),
    renderPicker: (close) => structurePicker(close),
  });
  const context = contextBar(structureCtx.el, h('span', { class: 'spacer' }), h('span', { class: 'ctx-hint muted small', text: t('mm.contextHint') }));

  // ---------------------------------------------------------------- filters
  // Every filter has a place in the URL, so a remembered route, a bookmark
  // and a drill-through from elsewhere all mean the same rows.
  const FILTER_SPEC = { status: {}, coverage: {}, unitId: { param: 'unit' }, dimensionId: { param: 'dimension' }, warningsOnly: { type: 'toggle', param: 'warn' }, direct: { type: 'toggle' } };
  const filters = filterBar({
    search: { placeholder: t('mm.searchPlaceholder'), onChange: (q) => { state.query = q; ctx.router.setParams({ q: q || null }); refreshList({ keepScroll: false }); }, onEnter: () => { if (state.items.length) select(state.items[0].id); } },
    filters: [
      { key: 'status', label: t('metric.field.status'), options: METRIC_STATUSES.map((s) => ({ value: s, label: t(`metric.status.${s}`) })) },
      { key: 'coverage', label: t('mm.filter.coverage'), options: () => coverageOptions() },
      { key: 'unitId', label: t('metric.field.unit'), options: () => selectors.units().map((u) => ({ value: u.id, label: u.code })) },
      { key: 'dimensionId', label: t('mm.filter.dimension'), options: () => selectors.dimensionsSorted().map((d) => ({ value: d.id, label: `${d.code} ${d.name}` })) },
      { key: 'warningsOnly', label: t('mm.filter.warningsOnly'), type: 'toggle' },
      { key: 'direct', label: t('mm.filter.direct'), type: 'toggle' },
    ],
    onChange: (values) => { state.filters = values; writeFilters(ctx.router, values, FILTER_SPEC); refreshList({ keepScroll: false }); },
  });
  const searchInput = filters.searchInput;

  // ---------------------------------------------------------------- structure navigator (side)
  const treeHost = h('div', { class: 'tree-scroll' });
  const pseudoRows = h('div', { class: 'tree-pseudo' });
  const side = h('aside', { class: 'pane tree-pane' },
    h('div', { class: 'pane-head' },
      h('span', { class: 'pane-title', text: t('mm.structure') }),
      h('div', { class: 'pane-actions' }, btn('', { icon: 'external', size: 'sm', className: 'btn-ghost', title: t('mm.openStructure'), on: { click: () => ctx.router.navigate('structure', { node: state.nodeId !== 'all' && state.nodeId !== 'unplaced' ? state.nodeId : null }) } })),
    ),
    pseudoRows,
    treeHost,
  );

  const tree = new Tree(treeHost, {
    expanded,
    getRoots: () => selectors.structureTree().roots,
    renderLabel: (entry, el) => {
      const counts = selectors.nodeCounts(entry.node.id);
      el.append(
        icon('folder', { size: 14, className: 'tree-icon' }),
        h('span', { class: 'tree-name', text: entry.node.name, title: entry.node.code ? `${entry.node.code} · ${entry.node.name}` : entry.node.name }),
        h('span', { class: 'tree-count', text: counts.total ? formatNumber(counts.total) : '' }),
        h('button', { type: 'button', class: 'tree-more', title: t('common.more'), on: { click: (e) => { e.stopPropagation(); nodeMenu(entry, e.currentTarget); } } }, icon('more', { size: 14 })),
      );
    },
    onSelect: (id) => selectNode(id),
    onToggle: () => setPreference('tree.expanded', [...expanded]),
    onContextMenu: (entry, e) => nodeMenu(entry, e.target),
    dnd: {
      mimeType: NODE_MIME,
      accepts: [METRIC_MIME],
      // The navigator does not reorder the hierarchy; that is the Structure
      // workspace's job. It does accept a metric dropped onto a group.
      canDrag: () => false,
      canDrop: (payload) => payload.type === METRIC_MIME,
      onDrop: async (payload, targetId) => {
        if (payload.type !== METRIC_MIME) return;
        try {
          let fromNodeId = payload.fromNodeId && store.has('structureNodes', payload.fromNodeId) ? payload.fromNodeId : null;
          if (!fromNodeId) {
            const placements = selectors.placementsByMetric(payload.id).filter((l) => store.has('structureNodes', l.structureNodeId));
            if (placements.length === 1) fromNodeId = placements[0].structureNodeId;
          }
          if (fromNodeId) await services.structure.moveMetric(payload.id, fromNodeId, targetId);
          else await services.structure.placeMetric(payload.id, targetId);
          ctx.toast.success(t('mm.metricMoved', { node: store.get('structureNodes', targetId).name }));
        } catch (err) {
          ctx.toast.error(err.message);
        }
      },
    },
  });

  function nodeMenu(entry, anchor) {
    const node = entry.node;
    openMenu(anchor, [
      { label: t('mm.newMetricHere'), icon: 'plus', onClick: () => newMetric(node.id) },
      { label: t('mm.openInStructure'), icon: 'external', onClick: () => ctx.router.navigate('structure', { node: node.id }) },
    ]);
  }

  function renderPseudoRows() {
    clear(pseudoRows);
    pseudoRows.append(
      pseudoRow('all', t('mm.allMetrics'), store.count('metrics'), 'layers'),
      pseudoRow('unplaced', t('mm.unplaced'), selectors.unplacedMetricIds().size, 'warning'),
    );
  }

  function pseudoRow(id, label, count, iconName) {
    const row = h('div', { class: ['tree-row', 'pseudo', state.nodeId === id && 'selected'], role: 'treeitem', tabindex: '0', dataset: { id }, on: { click: () => selectNode(id), keydown: (e) => { if (e.key === 'Enter') selectNode(id); } } },
      h('span', { class: 'tree-toggle hidden' }),
      h('div', { class: 'tree-label' }, icon(iconName, { size: 14, className: 'tree-icon' }), h('span', { class: 'tree-name', text: label }), h('span', { class: ['tree-count', id === 'unplaced' && count > 0 && 'warn'], text: formatNumber(count) })),
    );
    if (id === 'unplaced') {
      row.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes(METRIC_MIME)) { e.preventDefault(); row.classList.add('drop-into'); } });
      row.addEventListener('dragleave', () => row.classList.remove('drop-into'));
      row.addEventListener('drop', async (e) => {
        row.classList.remove('drop-into');
        if (!e.dataTransfer.types.includes(METRIC_MIME)) return;
        e.preventDefault();
        try {
          const payload = JSON.parse(e.dataTransfer.getData(METRIC_MIME));
          for (const l of selectors.placementsByMetric(payload.id)) await services.structure.removePlacement(l.id);
        } catch (err) {
          ctx.toast.error(err.message);
        }
      });
    }
    return row;
  }

  function renderTree() {
    renderPseudoRows();
    tree.selectedId = state.nodeId;
    tree.render();
  }

  /** The tree, offered as the picker of the structure context control. */
  function structurePicker(close) {
    const host = h('div', { class: 'ctx-tree' });
    const pick = (id) => { close(); selectNode(id); };
    host.appendChild(h('button', { type: 'button', class: ['ctx-option', state.nodeId === 'all' && 'active'], on: { click: () => pick('all') } }, h('span', { text: t('mm.allMetrics') })));
    host.appendChild(h('button', { type: 'button', class: ['ctx-option', state.nodeId === 'unplaced' && 'active'], on: { click: () => pick('unplaced') } }, h('span', { text: t('mm.unplaced') })));
    const walk = (entry, depth) => {
      const counts = selectors.nodeCounts(entry.node.id);
      host.appendChild(h('button', { type: 'button', class: ['ctx-option', state.nodeId === entry.node.id && 'active'], style: { paddingLeft: `${8 + depth * 14}px` }, on: { click: () => pick(entry.node.id) } },
        h('span', { text: entry.node.name }), h('span', { class: 'ctx-option-sub', text: counts.total ? formatNumber(counts.total) : '' })));
      for (const c of entry.children) walk(c, depth + 1);
    };
    for (const r of selectors.structureTree().roots) walk(r, 0);
    return host;
  }

  function selectNode(id) {
    state.nodeId = id;
    ctx.router.setParams({ node: id === 'all' ? null : id });
    renderPseudoRows();
    if (id === 'all' || id === 'unplaced') tree.select(null, { silent: true });
    else tree.select(id, { silent: true });
    refreshList({ keepScroll: false });
  }

  // ---------------------------------------------------------------- grid (main)
  const crumbs = h('div', { class: 'crumbs' });
  const gridHead = h('div', { class: 'table-head metric-row' },
    sortHead('code', t('mm.col.code'), 'col-code'),
    sortHead('name', t('mm.col.name'), 'col-name'),
    sortHead('unit', t('mm.col.unit'), 'col-unit'),
    ...selectors.scenarios().map((s) => h('span', { class: 'col-binding', text: s.code, title: s.name })),
    h('span', { class: 'col-dims', text: t('mm.col.dims'), title: t('mm.col.dimsTitle') }),
    h('span', { class: 'col-warn', text: '' }),
  );
  const empty = h('div', { class: 'empty', hidden: true }, icon('search', { size: 28 }), h('p', { text: t('mm.empty') }), btn(t('mm.newMetric'), { size: 'sm', icon: 'plus', on: { click: () => newMetric() } }));
  const listHost = h('div', { class: 'list-host' });
  const main = h('section', { class: 'pane list-pane' }, h('div', { class: 'list-meta' }, crumbs, h('span', { class: 'muted small list-hint', text: t('mm.rowHint') })), listHost, empty);

  // One column model for header and rows: identity columns keep a readable
  // minimum and stick to the left; the grid scrolls sideways past that.
  const scenarioCount = selectors.scenarios().length;
  const columns = { template: `96px minmax(200px, 1fr) 72px repeat(${scenarioCount}, 108px) 44px 28px`, minWidth: 28 + 96 + 200 + 72 + 108 * scenarioCount + 44 + 28 + 10 * (5 + scenarioCount) };
  const list = new VirtualList(listHost, {
    rowHeight: 'row',
    keyOf: (m) => m.id,
    emptyNode: empty,
    renderRow,
    onSelect: (m) => select(m ? m.id : null),
    onActivate: (m) => openMetric(m.id),
    header: gridHead,
    minWidth: columns.minWidth,
  });
  gridHead.style.gridTemplateColumns = columns.template;

  function renderRow(m) {
    const unit = m.unitId ? store.get('units', m.unitId) : null;
    const cov = selectors.coverageOf(m.id);
    const issues = ctx.validation.issuesForMetric(m.id);
    const sev = worstSeverity(issues);
    const dims = selectors.metricDimensions(m.id).length;
    const row = h('div', { class: ['metric-row', 'row', m.status !== 'approved' && `status-${m.status}`, ctx.currentMetricId === m.id && 'active'], role: 'row', tabindex: '-1', draggable: true, dataset: { id: m.id }, on: {
      dragstart: (e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(METRIC_MIME, JSON.stringify({ id: m.id, fromNodeId: state.nodeId !== 'all' && state.nodeId !== 'unplaced' ? state.nodeId : null }));
        row.classList.add('dragging');
      },
      dragend: () => row.classList.remove('dragging'),
    } },
      h('span', { class: 'col-code mono', text: m.code }),
      h('span', { class: 'col-name' }, h('span', { class: 'name-text', text: m.name }), (m.aliases || []).length ? h('span', { class: 'name-alias', text: m.aliases.slice(0, 2).join(' · ') }) : null),
      h('span', { class: 'col-unit muted', text: unit ? unit.code : '' }),
      ...selectors.scenarios().map((s) => h('span', { class: 'col-binding' }, bindingChip(s.code, cov[s.id], { compact: true }))),
      h('span', { class: 'col-dims muted', text: dims ? String(dims) : '' }),
      h('span', { class: 'col-warn' }, sev ? severityDot(sev, issues.length) : null),
    );
    row.style.gridTemplateColumns = gridHead.style.gridTemplateColumns;
    return row;
  }

  function sortHead(key, label, className) {
    const el = h('button', { type: 'button', class: ['th', className], on: { click: () => { if (state.sort.key === key) state.sort.dir *= -1; else state.sort = { key, dir: 1 }; updateSortMarks(); refreshList(); } } }, h('span', { text: label }), h('span', { class: 'sort-mark' }));
    el.dataset.key = key;
    return el;
  }

  function updateSortMarks() {
    for (const th of gridHead.querySelectorAll('.th')) {
      th.querySelector('.sort-mark').textContent = th.dataset.key === state.sort.key ? (state.sort.dir > 0 ? '▲' : '▼') : '';
    }
  }

  function scopeIds() {
    if (state.nodeId === 'all') return null;
    if (state.nodeId === 'unplaced') return selectors.unplacedMetricIds();
    if (!store.has('structureNodes', state.nodeId)) return null;
    // "This group only" is a filter on the context, not a different context:
    // the group stays selected, its sub-groups' metrics are hidden.
    return state.filters.direct ? selectors.metricIdsInNode(state.nodeId) : selectors.metricIdsUnderNode(state.nodeId);
  }

  /**
   * A context that stopped existing — a bookmark to a deleted group, a node
   * removed in another tab or by an import — falls back to "all" and says
   * so, instead of a grid that claims a scope it cannot show.
   */
  function normalizeNode(nodeId) {
    if (nodeId === 'all' || nodeId === 'unplaced' || store.has('structureNodes', nodeId)) return nodeId;
    ctx.toast.info(t('mm.nodeGone'));
    return 'all';
  }

  function computeItems() {
    const scope = scopeIds();
    const hits = selectors.searchMetrics(state.query);
    const f = state.filters;
    const items = [];
    const source = scope ? [...scope].map((id) => store.get('metrics', id)).filter(Boolean) : store.list('metrics');
    for (const m of source) {
      if (hits && !hits.has(m.id)) continue;
      if (f.status && m.status !== f.status) continue;
      if (f.unitId && m.unitId !== f.unitId) continue;
      if (f.coverage && selectors.coverageLevel(m.id) !== f.coverage) continue;
      if (f.dimensionId && !selectors.metricDimensions(m.id).some((l) => l.dimensionId === f.dimensionId)) continue;
      if (f.warningsOnly && ctx.validation.issuesForMetric(m.id).length === 0) continue;
      items.push(m);
    }
    const { key, dir } = state.sort;
    const unitCode = (m) => (m.unitId && store.get('units', m.unitId) ? store.get('units', m.unitId).code : '');
    items.sort((a, b) => {
      let c = 0;
      if (key === 'code') c = compareText(a.code, b.code);
      else if (key === 'name') c = compareText(a.name, b.name);
      else if (key === 'unit') c = compareText(unitCode(a), unitCode(b));
      return c * dir || compareText(a.code, b.code);
    });
    return items;
  }

  function refreshList({ keepScroll = true } = {}) {
    state.items = computeItems();
    list.setItems(state.items, { keepScroll });
    renderMeta();
    if (state.selectedId && !state.items.some((m) => m.id === state.selectedId)) select(null);
  }

  function renderMeta() {
    clear(crumbs);
    if (state.nodeId === 'all') { crumbs.appendChild(h('span', { class: 'crumb last', text: t('mm.allMetrics') })); structureCtx.setValue('all', t('mm.allMetrics')); }
    else if (state.nodeId === 'unplaced') { crumbs.appendChild(h('span', { class: 'crumb last', text: t('mm.unplaced') })); structureCtx.setValue('unplaced', t('mm.unplaced')); }
    else {
      const path = selectors.nodePath(state.nodeId);
      path.forEach((n, i) => {
        crumbs.appendChild(h('span', { class: ['crumb', i === path.length - 1 && 'last'], text: n.name, on: { click: () => selectNode(n.id) } }));
        if (i < path.length - 1) crumbs.appendChild(h('span', { class: 'crumb-sep', text: '›' }));
      });
      structureCtx.setValue(state.nodeId, path.map((n) => n.name).join(' › '));
    }
    const scope = scopeIds();
    const total = scope ? scope.size : store.count('metrics');
    countLabel.textContent = state.items.length === total ? t('mm.count', { n: formatNumber(total) }) : t('mm.countFiltered', { n: formatNumber(state.items.length), total: formatNumber(total) });
  }

  // ---------------------------------------------------------------- insights
  const insights = createInsightsPanel({ preferenceKey: 'metricMaster', title: t('insights.title'), emptyText: t('insights.empty') });

  function select(id) {
    state.selectedId = id && store.has('metrics', id) ? id : null;
    list.setSelected(state.selectedId);
    ctx.router.setParams({ selected: state.selectedId });
    renderInsights();
  }

  function renderInsights() {
    if (!state.selectedId) {
      insights.setContent(null);
      return;
    }
    insights.setContent(renderMetricInsights(ctx, state.selectedId, {
      onEdit: () => openMetric(state.selectedId),
      onDependencies: () => ctx.router.navigate('dependencies', { metric: state.selectedId }),
      onStructure: (nodeId) => selectNode(nodeId),
    }));
  }

  // ---------------------------------------------------------------- layout
  const layout = workspaceLayout({ header: header.el, context: context.el, side, main, insights: insights.el, className: 'mm-ws' });
  layout.el.insertBefore(filters.el, layout.body);
  container.appendChild(layout.el);

  // ---------------------------------------------------------------- actions
  function openMetric(id) {
    if (ctx.openMetric(id)) ctx.router.setParams({ metric: id });
  }

  async function newMetric(nodeId = null) {
    const targetNode = nodeId || (state.nodeId !== 'all' && state.nodeId !== 'unplaced' ? state.nodeId : null);
    const options = [{ value: '', label: t('mm.noPlacement') }, ...nodeOptions(ctx)];
    const created = await promptDialog({
      title: t('mm.newMetricTitle'),
      confirmLabel: t('common.create'),
      fields: [
        { name: 'name', label: t('metric.field.name'), placeholder: t('drawer.namePlaceholder'), required: true },
        { name: 'structureNodeId', label: t('drawer.section.structure'), type: 'select', value: targetNode || '', options },
      ],
      // The dialog stays open with the name typed if the save fails.
      submit: async (values) => ({ metric: await services.metrics.create({ name: values.name }, { structureNodeId: values.structureNodeId || null }), structureNodeId: values.structureNodeId }),
    });
    if (!created) return;
    const m = created.metric;
    ctx.toast.success(t('mm.metricCreated', { code: m.code }));
    if (created.structureNodeId && state.nodeId !== 'all' && !selectors.metricIdsUnderNode(state.nodeId).has(m.id)) selectNode(created.structureNodeId);
    refreshList();
    select(m.id);
    openMetric(m.id);
  }

  // ---------------------------------------------------------------- sync
  const scheduleTree = debounce(() => renderTree(), 30);
  const scheduleList = debounce(() => { refreshList(); renderInsights(); }, 30);
  const offStore = store.events.on('change', (evt) => {
    const c = evt.collection;
    if (c === 'structureNodes' && state.nodeId !== 'all' && state.nodeId !== 'unplaced' && !store.has('structureNodes', state.nodeId)) {
      selectNode(normalizeNode(state.nodeId));
      return;
    }
    if (c === '*') { scheduleTree(); scheduleList(); return; }
    if (c === 'structureNodes' || c === 'metricStructures' || c === 'metrics') scheduleTree();
    if (['metrics', 'metricStructures', 'bindings', 'metricDimensions', 'units', 'structureNodes', 'dimensions'].includes(c)) scheduleList();
  });
  const offValidation = ctx.validation.onChange(() => {
    if (state.filters.warningsOnly) refreshList();
    else list.refresh();
    renderInsights();
  });

  updateSortMarks();
  renderTree();
  let initialised = false;

  return {
    update(route) {
      const nodeId = normalizeNode(route.params.node || 'all');
      if (nodeId !== (route.params.node || 'all')) ctx.router.setParams({ node: null });
      const first = !initialised;
      initialised = true;
      // Filters and query come from the route: a remembered route resumes
      // them, a drill-through sets them explicitly.
      const wanted = readFilters(route.params, FILTER_SPEC);
      if (filtersDiffer(state.filters, wanted, FILTER_SPEC)) filters.setMany(wanted);
      if ((route.params.q || '') !== state.query) filters.setSearch(route.params.q || '');
      if (nodeId !== state.nodeId || first) {
        state.nodeId = nodeId;
        if (store.has('structureNodes', nodeId)) {
          const entry = selectors.structureTree().byId.get(nodeId);
          if (entry) for (const id of entry.path.slice(0, -1)) expanded.add(id);
        }
        renderTree();
        tree.reveal(nodeId);
        refreshList({ keepScroll: false });
      }
      const selected = route.params.selected;
      if (selected && store.has('metrics', selected)) {
        // A direct link to a metric shows that metric. If the filters hide
        // it, they are cleared — and the person is told — rather than the
        // link landing on a grid where the requested row is nowhere.
        if (!state.items.some((m) => m.id === selected)) {
          if (!selectors.metricIdsUnderNode(state.nodeId).has(selected) && state.nodeId !== 'all' && !(state.nodeId === 'unplaced' && selectors.unplacedMetricIds().has(selected))) selectNode('all');
          if (!state.items.some((m) => m.id === selected)) { filters.reset(); ctx.toast.info(t('mm.filtersClearedToReveal')); }
        }
        if (selected !== state.selectedId) select(selected);
        const idx = state.items.findIndex((m) => m.id === selected);
        if (idx >= 0) list.scrollToIndex(idx);
      }
      if (route.params.new) {
        // A quick action from elsewhere ("New metric"): open the dialog once, then forget the flag.
        ctx.router.setParams({ new: null });
        newMetric(store.has('structureNodes', state.nodeId) ? state.nodeId : null);
      }
      const metricId = route.params.metric;
      if (metricId && store.has('metrics', metricId) && metricId !== ctx.currentMetricId) ctx.openMetric(metricId);
    },
    onShow() {
      list.refresh();
    },
    onHide() {},
    /** `/` focuses search — only while this workspace is the one on screen. */
    onShortcut(e) {
      if (e.key === '/') {
        e.preventDefault();
        searchInput.focus();
        searchInput.select();
      }
    },
    onDrawerClosed() {
      ctx.router.setParams({ metric: null });
      list.refresh();
    },
    onMetricOpened(id) {
      // Editing a metric also makes it the selection, so the inspector and
      // the editor never disagree about which record is in front of the user.
      if (id && id !== state.selectedId) select(id);
      list.refresh();
    },
    destroy() {
      offStore();
      offValidation();
      
      list.destroy();
      layout.el.remove();
    },
  };
}

function coverageOptions() {
  return ['complete', 'partial', 'missing'].map((v) => ({ value: v, label: t(`coverage.${v}`) }));
}

