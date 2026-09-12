import { h, btn, icon, clear, formatNumber } from '../../ui/dom.js';
import { t } from '../../ui/i18n.js';
import { Tree } from '../../ui/tree/tree.js';
import { VirtualList } from '../../ui/table/virtual-list.js';
import { openMenu } from '../../ui/components/menu.js';
import { confirmDialog, promptDialog } from '../../ui/components/confirm.js';
import { bindingChip, severityDot } from '../../ui/components/chip.js';
import { METRIC_STATUSES, METRIC_ROLES } from '../../core/models/metric.js';
import { debounce } from '../../utils/debounce.js';
import { compareText } from '../../utils/text.js';
import { getPreference, setPreference } from '../../utils/preferences.js';
import { worstSeverity } from '../../services/validation-service.js';
import { nodeOptions } from './metric-drawer.js';

const NODE_MIME = 'application/x-metric-studio-node';
const METRIC_MIME = 'application/x-metric-studio-metric';
const ROW_HEIGHT = 40;

/**
 * Metric Master — default workspace.
 * Left: structural hierarchy. Center: virtualised metric table. Right: drawer.
 */
export function mountMetricMasterView(container, ctx) {
  const { store, selectors, services } = ctx;
  const state = {
    nodeId: 'all',
    query: '',
    status: '',
    coverage: '',
    role: '',
    unitId: '',
    warningsOnly: false,
    dimensionId: '',
    sort: { key: 'code', dir: 1 },
    advancedOpen: false,
    items: [],
  };
  const expanded = new Set(getPreference('tree.expanded', []));

  // ---------------------------------------------------------------- layout
  const treeHost = h('div', { class: 'tree-scroll' });
  const pseudoRows = h('div', { class: 'tree-pseudo' });
  const treePane = h('aside', { class: 'pane tree-pane' },
    h('div', { class: 'pane-head' },
      h('span', { class: 'pane-title', text: t('mm.structure') }),
      h('div', { class: 'pane-actions' },
        btn('', { icon: 'plus', size: 'sm', title: t('mm.addRootNode'), on: { click: () => addNode(null) } }),
      ),
    ),
    pseudoRows,
    treeHost,
  );

  const searchInput = h('input', { class: 'input search-input', type: 'search', placeholder: t('mm.searchPlaceholder'), 'aria-label': t('mm.search') });
  const statusSelect = h('select', { class: 'input input-sm', 'aria-label': t('metric.field.status') }, h('option', { value: '', text: t('mm.filter.anyStatus') }), METRIC_STATUSES.map((s) => h('option', { value: s, text: t(`metric.status.${s}`) })));
  const coverageSelect = h('select', { class: 'input input-sm', 'aria-label': t('mm.filter.coverage') }, h('option', { value: '', text: t('mm.filter.anyCoverage') }), coverageOptions(ctx).map((o) => h('option', { value: o.value, text: o.label })));
  const advancedBtn = btn(t('mm.filter.advanced'), { size: 'sm', icon: 'filter', on: { click: () => toggleAdvanced() } });
  const newBtn = btn(t('mm.newMetric'), { kind: 'primary', size: 'sm', icon: 'plus', on: { click: () => newMetric() } });
  const toolbar = h('div', { class: 'toolbar' }, h('div', { class: 'search' }, icon('search', { className: 'search-icon' }), searchInput), statusSelect, coverageSelect, advancedBtn, h('span', { class: 'spacer' }), newBtn);

  const roleSelect = h('select', { class: 'input input-sm' }, h('option', { value: '', text: t('mm.filter.anyRole') }), METRIC_ROLES.map((r) => h('option', { value: r, text: t(`metric.role.${r}`) })));
  const unitSelect = h('select', { class: 'input input-sm' });
  const dimSelect = h('select', { class: 'input input-sm' });
  const warnCheck = h('input', { type: 'checkbox' });
  const advanced = h('div', { class: 'toolbar advanced', hidden: true },
    h('label', { class: 'inline-field' }, h('span', { text: t('metric.field.role') }), roleSelect),
    h('label', { class: 'inline-field' }, h('span', { text: t('metric.field.unit') }), unitSelect),
    h('label', { class: 'inline-field' }, h('span', { text: t('mm.filter.dimension') }), dimSelect),
    h('label', { class: 'check-inline' }, warnCheck, h('span', { text: t('mm.filter.warningsOnly') })),
    btn(t('mm.filter.reset'), { size: 'sm', on: { click: () => resetFilters() } }),
  );

  const crumbs = h('div', { class: 'crumbs' });
  const countLabel = h('span', { class: 'count-label' });
  const listMeta = h('div', { class: 'list-meta' }, crumbs, countLabel);
  const header = h('div', { class: 'table-head metric-row' },
    sortHead('code', t('mm.col.code'), 'col-code'),
    sortHead('name', t('mm.col.name'), 'col-name'),
    sortHead('unit', t('mm.col.unit'), 'col-unit'),
    ...selectors.scenarios().map((s) => h('span', { class: 'col-binding', text: s.code, title: s.name })),
    h('span', { class: 'col-dims', text: t('mm.col.dims'), title: t('mm.col.dimsTitle') }),
    h('span', { class: 'col-warn', text: '' }),
  );
  const empty = h('div', { class: 'empty', hidden: true }, icon('search', { size: 28 }), h('p', { text: t('mm.empty') }), btn(t('mm.newMetric'), { size: 'sm', icon: 'plus', on: { click: () => newMetric() } }));
  const listHost = h('div', { class: 'list-host' });
  const listPane = h('section', { class: 'pane list-pane' }, toolbar, advanced, listMeta, header, listHost, empty);
  const root = h('div', { class: 'mm-layout' }, treePane, listPane);
  container.appendChild(root);

  // ---------------------------------------------------------------- tree
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
      accepts: [NODE_MIME, METRIC_MIME],
      canDrag: () => true,
      canDrop: (payload, targetId) => true,
      onDrop: async (payload, targetId, position) => {
        try {
          if (payload.type === METRIC_MIME) {
            // Dragging from a group moves it out of that group; from "All" / "Not in structure"
            // a singly-placed metric is moved, a multi-placed one gains a placement.
            let fromNodeId = payload.fromNodeId && store.has('structureNodes', payload.fromNodeId) ? payload.fromNodeId : null;
            if (!fromNodeId) {
              const placements = selectors.placementsByMetric(payload.id).filter((l) => store.has('structureNodes', l.structureNodeId));
              if (placements.length === 1) fromNodeId = placements[0].structureNodeId;
            }
            if (fromNodeId) await services.structure.moveMetric(payload.id, fromNodeId, targetId);
            else await services.structure.placeMetric(payload.id, targetId);
            ctx.toast.success(t('mm.metricMoved', { node: store.get('structureNodes', targetId).name }));
          } else if (payload.id !== targetId) {
            if (position === 'into') await services.structure.moveNode(payload.id, targetId);
            else await services.structure.moveNodeRelative(payload.id, targetId, position);
            const parent = position === 'into' ? targetId : store.get('structureNodes', targetId).parentId;
            if (parent) expanded.add(parent);
          }
        } catch (err) {
          ctx.toast.error(err.message);
        }
      },
    },
  });

  function renderPseudoRows() {
    clear(pseudoRows);
    const all = store.count('metrics');
    const unplaced = selectors.unplacedMetricIds().size;
    pseudoRows.append(
      pseudoRow('all', t('mm.allMetrics'), all, 'layers'),
      pseudoRow('unplaced', t('mm.unplaced'), unplaced, 'warning'),
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

  function selectNode(id) {
    state.nodeId = id;
    ctx.router.setParams({ node: id === 'all' ? null : id });
    renderPseudoRows();
    if (id === 'all' || id === 'unplaced') tree.select(null, { silent: true });
    else tree.select(id, { silent: true });
    refreshList({ keepScroll: false });
  }

  async function addNode(parentId) {
    const parent = parentId ? store.get('structureNodes', parentId) : null;
    const values = await promptDialog({ title: parent ? t('mm.addSubNodeTitle', { name: parent.name }) : t('mm.addRootNode'), confirmLabel: t('common.create'), fields: [{ name: 'name', label: t('mm.nodeName'), placeholder: t('mm.nodeNamePlaceholder') }, { name: 'code', label: t('mm.nodeCode'), placeholder: 'VH.DV' }] });
    if (!values || !values.name) return;
    try {
      const node = await services.structure.createNode({ parentId, name: values.name, code: values.code });
      if (parentId) expanded.add(parentId);
      setPreference('tree.expanded', [...expanded]);
      renderTree();
      selectNode(node.id);
    } catch (err) {
      ctx.toast.error(err.message);
    }
  }

  function nodeMenu(entry, anchor) {
    const node = entry.node;
    openMenu(anchor, [
      { label: t('mm.newMetricHere'), icon: 'plus', onClick: () => newMetric(node.id) },
      { label: t('mm.addSubNode'), icon: 'folder', onClick: () => addNode(node.id) },
      { separator: true },
      { label: t('common.rename'), icon: 'edit', onClick: async () => {
        const values = await promptDialog({ title: t('mm.renameNode'), fields: [{ name: 'name', label: t('mm.nodeName'), value: node.name }, { name: 'code', label: t('mm.nodeCode'), value: node.code }, { name: 'owner', label: t('metric.field.owner'), value: node.owner }] });
        if (!values) return;
        try { await services.structure.updateNode(node.id, values); } catch (err) { ctx.toast.error(err.message); }
      } },
      { label: t('mm.moveUp'), icon: 'up', onClick: () => services.structure.reorderNode(node.id, 'up').catch((e) => ctx.toast.error(e.message)) },
      { label: t('mm.moveDown'), icon: 'down', onClick: () => services.structure.reorderNode(node.id, 'down').catch((e) => ctx.toast.error(e.message)) },
      { label: t('mm.moveTo'), icon: 'arrowRight', onClick: async () => {
        const options = [{ value: '', label: t('mm.rootLevel') }, ...nodeOptions(ctx).filter((o) => o.value !== node.id && !services.structure.isDescendant(o.value, node.id))];
        const values = await promptDialog({ title: t('mm.moveNodeTitle', { name: node.name }), confirmLabel: t('common.move'), fields: [{ name: 'parentId', label: t('mm.newParent'), type: 'select', value: node.parentId || '', options }] });
        if (!values) return;
        try { await services.structure.moveNode(node.id, values.parentId || null); if (values.parentId) expanded.add(values.parentId); renderTree(); } catch (err) { ctx.toast.error(err.message); }
      } },
      { separator: true },
      { label: t('common.delete'), icon: 'trash', danger: true, onClick: () => deleteNode(node) },
    ]);
  }

  async function deleteNode(node) {
    const counts = selectors.nodeCounts(node.id);
    const children = entryChildren(node.id);
    const hasContent = counts.direct > 0 || children > 0;
    const choice = await confirmDialog({
      title: t('mm.deleteNodeTitle', { name: node.name }),
      message: hasContent ? t('mm.deleteNodeMessage', { metrics: counts.direct, nodes: children }) : t('mm.deleteNodeEmpty'),
      confirmLabel: t('common.delete'),
      options: hasContent ? [{ value: 'moveToParent', label: t('mm.deleteMoveToParent') }] : null,
    });
    if (!choice) return;
    try {
      await services.structure.deleteNode(node.id, { strategy: hasContent ? 'moveToParent' : 'refuse' });
      if (state.nodeId === node.id) selectNode(node.parentId || 'all');
      ctx.toast.success(t('mm.nodeDeleted', { name: node.name }));
    } catch (err) {
      ctx.toast.error(err.message);
    }
  }

  function entryChildren(nodeId) {
    const entry = selectors.structureTree().byId.get(nodeId);
    return entry ? entry.children.length : 0;
  }

  // ---------------------------------------------------------------- list
  const list = new VirtualList(listHost, { rowHeight: ROW_HEIGHT, keyOf: (m) => m.id, emptyNode: empty, renderRow: renderRow });

  function renderRow(m) {
    const unit = m.unitId ? store.get('units', m.unitId) : null;
    const cov = selectors.coverageOf(m.id);
    const issues = ctx.validation.issuesForMetric(m.id);
    const sev = worstSeverity(issues);
    const dims = selectors.metricDimensions(m.id).length;
    const row = h('div', { class: ['metric-row', 'row', m.status !== 'approved' && `status-${m.status}`, ctx.currentMetricId === m.id && 'active'], role: 'row', tabindex: '-1', draggable: true, dataset: { id: m.id }, on: {
      click: () => openMetric(m.id),
      keydown: (e) => { if (e.key === 'Enter') openMetric(m.id); },
      dragstart: (e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(METRIC_MIME, JSON.stringify({ id: m.id, fromNodeId: state.nodeId !== 'all' && state.nodeId !== 'unplaced' ? state.nodeId : null }));
        row.classList.add('dragging');
      },
      dragend: () => row.classList.remove('dragging'),
    } },
      h('span', { class: 'col-code mono', text: m.code }),
      h('span', { class: 'col-name' }, h('span', { class: 'name-text', text: m.name }), m.aliases.length ? h('span', { class: 'name-alias', text: m.aliases.slice(0, 2).join(' · ') }) : null),
      h('span', { class: 'col-unit muted', text: unit ? unit.code : '' }),
      ...selectors.scenarios().map((s) => h('span', { class: 'col-binding' }, bindingChip(s.code, cov[s.id], { compact: true }))),
      h('span', { class: 'col-dims muted', text: dims ? String(dims) : '' }),
      h('span', { class: 'col-warn' }, sev ? severityDot(sev, issues.length) : null),
    );
    return row;
  }

  function sortHead(key, label, className) {
    const el = h('button', { type: 'button', class: ['th', className], on: { click: () => { if (state.sort.key === key) state.sort.dir *= -1; else state.sort = { key, dir: 1 }; updateSortMarks(); refreshList(); } } }, h('span', { text: label }), h('span', { class: 'sort-mark' }));
    el.dataset.key = key;
    return el;
  }

  function updateSortMarks() {
    for (const th of header.querySelectorAll('.th')) {
      const mark = th.querySelector('.sort-mark');
      mark.textContent = th.dataset.key === state.sort.key ? (state.sort.dir > 0 ? '▲' : '▼') : '';
    }
  }

  function scopeIds() {
    if (state.nodeId === 'all') return null;
    if (state.nodeId === 'unplaced') return selectors.unplacedMetricIds();
    if (!store.has('structureNodes', state.nodeId)) return null;
    return selectors.metricIdsUnderNode(state.nodeId);
  }

  function computeItems() {
    const scope = scopeIds();
    const hits = selectors.searchMetrics(state.query);
    let items = [];
    const source = scope ? [...scope].map((id) => store.get('metrics', id)).filter(Boolean) : store.list('metrics');
    for (const m of source) {
      if (hits && !hits.has(m.id)) continue;
      if (state.status && m.status !== state.status) continue;
      if (state.role && m.role !== state.role) continue;
      if (state.unitId && m.unitId !== state.unitId) continue;
      if (state.coverage && selectors.coverageClass(m.id) !== state.coverage) continue;
      if (state.dimensionId && !selectors.metricDimensions(m.id).some((l) => l.dimensionId === state.dimensionId)) continue;
      if (state.warningsOnly && ctx.validation.issuesForMetric(m.id).length === 0) continue;
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
  }

  function renderMeta() {
    clear(crumbs);
    if (state.nodeId === 'all') crumbs.appendChild(h('span', { class: 'crumb last', text: t('mm.allMetrics') }));
    else if (state.nodeId === 'unplaced') crumbs.appendChild(h('span', { class: 'crumb last', text: t('mm.unplaced') }));
    else {
      const path = selectors.nodePath(state.nodeId);
      path.forEach((n, i) => {
        crumbs.appendChild(h('span', { class: ['crumb', i === path.length - 1 && 'last'], text: n.name, on: { click: () => selectNode(n.id) } }));
        if (i < path.length - 1) crumbs.appendChild(h('span', { class: 'crumb-sep', text: '›' }));
      });
    }
    const total = state.nodeId === 'all' ? store.count('metrics') : scopeIds().size;
    countLabel.textContent = state.items.length === total ? t('mm.count', { n: formatNumber(total) }) : t('mm.countFiltered', { n: formatNumber(state.items.length), total: formatNumber(total) });
  }

  function refreshRows() {
    list.refresh();
  }

  // ---------------------------------------------------------------- filters
  const onSearch = debounce(() => { state.query = searchInput.value; refreshList({ keepScroll: false }); }, 160);
  searchInput.addEventListener('input', onSearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { searchInput.value = ''; state.query = ''; refreshList(); searchInput.blur(); }
    if (e.key === 'Enter' && state.items.length) openMetric(state.items[0].id);
  });
  statusSelect.addEventListener('change', () => { state.status = statusSelect.value; refreshList({ keepScroll: false }); });
  coverageSelect.addEventListener('change', () => { state.coverage = coverageSelect.value; refreshList({ keepScroll: false }); });
  roleSelect.addEventListener('change', () => { state.role = roleSelect.value; refreshList({ keepScroll: false }); });
  unitSelect.addEventListener('change', () => { state.unitId = unitSelect.value; refreshList({ keepScroll: false }); });
  dimSelect.addEventListener('change', () => { state.dimensionId = dimSelect.value; refreshList({ keepScroll: false }); });
  warnCheck.addEventListener('change', () => { state.warningsOnly = warnCheck.checked; refreshList({ keepScroll: false }); });

  function toggleAdvanced() {
    state.advancedOpen = !state.advancedOpen;
    advanced.hidden = !state.advancedOpen;
    advancedBtn.classList.toggle('active', state.advancedOpen);
  }

  function resetFilters() {
    Object.assign(state, { query: '', status: '', coverage: '', role: '', unitId: '', warningsOnly: false, dimensionId: '' });
    searchInput.value = '';
    statusSelect.value = '';
    coverageSelect.value = '';
    roleSelect.value = '';
    unitSelect.value = '';
    dimSelect.value = '';
    warnCheck.checked = false;
    refreshList({ keepScroll: false });
  }

  function fillAdvancedOptions() {
    unitSelect.replaceChildren(h('option', { value: '', text: t('mm.filter.anyUnit') }), ...selectors.units().map((u) => h('option', { value: u.id, text: u.code, selected: u.id === state.unitId })));
    dimSelect.replaceChildren(h('option', { value: '', text: t('mm.filter.anyDimension') }), ...selectors.dimensionsSorted().map((d) => h('option', { value: d.id, text: `${d.code} ${d.name}`, selected: d.id === state.dimensionId })));
  }

  // ---------------------------------------------------------------- actions
  function openMetric(id) {
    ctx.router.setParams({ metric: id });
    ctx.openMetric(id);
  }

  async function newMetric(nodeId = null) {
    const targetNode = nodeId || (state.nodeId !== 'all' && state.nodeId !== 'unplaced' ? state.nodeId : null);
    const options = [{ value: '', label: t('mm.noPlacement') }, ...nodeOptions(ctx)];
    const values = await promptDialog({
      title: t('mm.newMetricTitle'),
      confirmLabel: t('common.create'),
      fields: [
        { name: 'name', label: t('metric.field.name'), placeholder: t('drawer.namePlaceholder') },
        { name: 'structureNodeId', label: t('drawer.section.structure'), type: 'select', value: targetNode || '', options },
      ],
    });
    if (!values || !values.name) return;
    try {
      const m = await services.metrics.create({ name: values.name }, { structureNodeId: values.structureNodeId || null });
      ctx.toast.success(t('mm.metricCreated', { code: m.code }));
      if (values.structureNodeId && state.nodeId !== 'all' && !selectors.metricIdsUnderNode(state.nodeId).has(m.id)) selectNode(values.structureNodeId);
      openMetric(m.id);
    } catch (err) {
      ctx.toast.error(err.message);
    }
  }

  // ---------------------------------------------------------------- sync
  const scheduleTree = debounce(() => renderTree(), 30);
  const scheduleList = debounce(() => refreshList(), 30);
  const offStore = store.events.on('change', (evt) => {
    const c = evt.collection;
    if (c === '*') {
      fillAdvancedOptions();
      scheduleTree();
      scheduleList();
      return;
    }
    if (c === 'structureNodes' || c === 'metricStructures' || c === 'metrics') scheduleTree();
    if (c === 'metrics' || c === 'metricStructures' || c === 'bindings' || c === 'metricDimensions' || c === 'units' || c === 'structureNodes') scheduleList();
    if (c === 'units' || c === 'dimensions') fillAdvancedOptions();
  });
  const offValidation = ctx.validation.onChange(() => {
    if (state.warningsOnly) refreshList();
    else refreshRows();
  });
  const offKeys = keyHandler((e) => {
    if (e.key === '/' && !isTyping()) {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  });

  fillAdvancedOptions();
  updateSortMarks();
  renderTree();
  let initialised = false;

  return {
    update(route) {
      const nodeId = route.params.node || 'all';
      const first = !initialised;
      initialised = true;
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
      const metricId = route.params.metric;
      if (metricId && store.has('metrics', metricId) && metricId !== ctx.currentMetricId) ctx.openMetric(metricId);
    },
    onDrawerClosed() {
      ctx.router.setParams({ metric: null });
      refreshRows();
    },
    onMetricOpened() {
      refreshRows();
    },
    destroy() {
      offStore();
      offValidation();
      offKeys();
      onSearch.cancel();
      list.destroy();
      root.remove();
    },
  };
}

function coverageOptions(ctx) {
  const scenarios = ctx.selectors.scenarios();
  const out = [{ value: 'both', label: t('coverage.both') }];
  for (const s of scenarios) out.push({ value: `${s.code.toLowerCase()}-only`, label: t('coverage.only', { scenario: s.code }) });
  out.push({ value: 'none', label: t('coverage.none') });
  return out;
}

function keyHandler(fn) {
  document.addEventListener('keydown', fn);
  return () => document.removeEventListener('keydown', fn);
}

function isTyping() {
  const el = document.activeElement;
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}
