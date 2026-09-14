import { h, btn, icon, formatNumber } from '../../ui/dom.js';
import { t } from '../../ui/i18n.js';
import { openMenu } from '../../ui/components/menu.js';
import { confirmDialog, promptDialog } from '../../ui/components/confirm.js';
import { debounce } from '../../utils/debounce.js';
import { getPreference, setPreference } from '../../utils/preferences.js';
import { pageHeader } from '../../ui/workspace/page-header.js';
import { workspaceLayout } from '../../ui/workspace/workspace-layout.js';
import { createInsightsPanel, insightRow, insightSection, insightStat } from '../../ui/workspace/insights-panel.js';
import { hierarchyWorkspace } from '../../ui/hierarchy/hierarchy-workspace.js';
import { nodeOptions } from '../metric-master/metric-drawer.js';

const NODE_MIME = 'application/x-metric-studio-node';
const METRIC_MIME = 'application/x-metric-studio-metric';

/**
 * Structure — the governance hierarchy as a workspace of its own.
 *
 * In Metric Master the tree is a navigator that scopes the grid; here it is
 * the thing being edited: add, rename, move, reorder, delete, drag a group
 * under another, drag a metric in. The inspector on the right says what a
 * group holds and where it sits, and carries every action, so the … menu
 * and the panel always agree.
 */
export function mountStructureView(container, ctx) {
  const { store, selectors, services } = ctx;
  const state = { nodeId: null };
  const expanded = new Set(getPreference('structure.expanded', getPreference('tree.expanded', [])));

  const addRootBtn = btn(t('mm.addRootNode'), { kind: 'primary', size: 'sm', icon: 'plus', on: { click: () => addNode(null) } });
  const meta = h('span', { class: 'muted small' });
  const header = pageHeader({ title: t('nav.structure'), subtitle: t('structure.subtitle'), meta, actions: [addRootBtn] });

  const hierarchy = hierarchyWorkspace({
    title: t('structure.hierarchy'),
    emptyText: t('structure.empty'),
    expanded,
    onToggle: () => setPreference('structure.expanded', [...expanded]),
    getRoots: () => selectors.structureTree().roots,
    renderLabel: (entry, el) => {
      const counts = selectors.nodeCounts(entry.node.id);
      el.append(
        icon('folder', { size: 14, className: 'tree-icon' }),
        h('span', { class: 'tree-name', text: entry.node.name, title: entry.node.code ? `${entry.node.code} · ${entry.node.name}` : entry.node.name }),
        entry.node.code && h('span', { class: 'tree-code mono muted', text: entry.node.code }),
        h('span', { class: 'tree-count', text: counts.total ? formatNumber(counts.total) : '' }),
        h('button', { type: 'button', class: 'tree-more', title: t('common.more'), on: { click: (e) => { e.stopPropagation(); nodeMenu(entry.node, e.currentTarget); } } }, icon('more', { size: 14 })),
      );
    },
    onSelect: (id) => select(id),
    onContextMenu: (entry, e) => nodeMenu(entry.node, e.target),
    dnd: {
      mimeType: NODE_MIME,
      accepts: [NODE_MIME, METRIC_MIME],
      canDrag: () => true,
      canDrop: () => true,
      onDrop: async (payload, targetId, position) => {
        try {
          if (payload.type === METRIC_MIME) {
            await services.structure.placeMetric(payload.id, targetId);
            ctx.toast.success(t('mm.metricMoved', { node: store.get('structureNodes', targetId).name }));
          } else if (payload.id !== targetId) {
            if (position === 'into') await services.structure.moveNode(payload.id, targetId);
            else await services.structure.moveNodeRelative(payload.id, targetId, position);
            const parent = position === 'into' ? targetId : store.get('structureNodes', targetId).parentId;
            if (parent) expanded.add(parent);
            setPreference('structure.expanded', [...expanded]);
          }
        } catch (err) {
          ctx.toast.error(err.message);
        }
      },
    },
  });

  const insights = createInsightsPanel({ preferenceKey: 'structure', title: t('insights.title'), emptyText: t('structure.pick') });
  const layout = workspaceLayout({ header: header.el, main: hierarchy.el, insights: insights.el, className: 'structure-ws' });
  container.appendChild(layout.el);

  // ---------------------------------------------------------------- selection + inspector
  function select(id) {
    state.nodeId = id && store.has('structureNodes', id) ? id : null;
    ctx.router.setParams({ node: state.nodeId });
    hierarchy.select(state.nodeId, { silent: true });
    renderInsights();
  }

  function renderInsights() {
    const node = state.nodeId ? store.get('structureNodes', state.nodeId) : null;
    if (!node) {
      insights.setContent(null);
      return;
    }
    const counts = selectors.nodeCounts(node.id);
    const entry = selectors.structureTree().byId.get(node.id);
    const children = entry ? entry.children.length : 0;
    const path = selectors.nodePath(node.id);
    const direct = [...selectors.metricIdsInNode(node.id)].map((id) => store.get('metrics', id)).filter(Boolean).sort((a, b) => a.code.localeCompare(b.code));
    const content = h('div', { class: 'insight' },
      h('div', { class: 'insight-head' },
        h('div', { class: 'insight-title', text: node.name }),
        h('div', { class: 'insight-sub' }, node.code && h('span', { class: 'mono', text: node.code }), node.owner && h('span', { class: 'tag', text: node.owner })),
      ),
      insightSection(t('structure.path'),
        h('div', { class: 'link-path' }, path.map((n, i) => h('span', { class: ['crumb', i === path.length - 1 && 'last'], text: n.name, on: { click: () => select(n.id) } }))),
        node.description && h('p', { class: 'insight-para', text: node.description }),
      ),
      insightSection(t('structure.contents'),
        h('div', { class: 'insight-stats' },
          insightStat(formatNumber(counts.direct), t('structure.directMetrics'), { onClick: () => ctx.router.navigate('metrics', { node: node.id }) }),
          insightStat(formatNumber(counts.total), t('structure.totalMetrics'), { onClick: () => ctx.router.navigate('metrics', { node: node.id }) }),
          insightStat(formatNumber(children), t('structure.subGroups')),
        ),
      ),
      direct.length ? insightSection(t('structure.directList', { n: direct.length }),
        h('ul', { class: 'insight-list' }, direct.slice(0, 12).map((m) => h('li', null, h('span', { class: 'mono muted', text: m.code }), h('button', { type: 'button', class: 'link ellipsis', on: { click: () => ctx.router.navigate('metrics', { node: node.id, selected: m.id }) } }, m.name))), direct.length > 12 && h('li', { class: 'muted', text: t('structure.andMore', { n: direct.length - 12 }) })),
      ) : null,
      h('div', { class: 'insight-actions' },
        btn(t('common.rename'), { size: 'sm', icon: 'edit', on: { click: () => renameNode(node) } }),
        btn(t('mm.addSubNode'), { size: 'sm', icon: 'plus', on: { click: () => addNode(node.id) } }),
        btn(t('mm.moveTo'), { size: 'sm', icon: 'arrowRight', on: { click: () => moveNodeDialog(node) } }),
        btn(t('mm.newMetricHere'), { size: 'sm', icon: 'layers', on: { click: () => ctx.router.navigate('metrics', { node: node.id }) } }),
        btn(t('common.delete'), { size: 'sm', icon: 'trash', kind: 'danger-ghost', on: { click: () => deleteNode(node) } }),
      ),
    );
    insights.setContent(content);
  }

  // ---------------------------------------------------------------- editing
  function nodeMenu(node, anchor) {
    openMenu(anchor, [
      { label: t('mm.addSubNode'), icon: 'folder', onClick: () => addNode(node.id) },
      { label: t('common.rename'), icon: 'edit', onClick: () => renameNode(node) },
      { separator: true },
      { label: t('mm.moveUp'), icon: 'up', onClick: () => services.structure.reorderNode(node.id, 'up').catch((e) => ctx.toast.error(e.message)) },
      { label: t('mm.moveDown'), icon: 'down', onClick: () => services.structure.reorderNode(node.id, 'down').catch((e) => ctx.toast.error(e.message)) },
      { label: t('mm.moveTo'), icon: 'arrowRight', onClick: () => moveNodeDialog(node) },
      { separator: true },
      { label: t('mm.showMetrics'), icon: 'layers', onClick: () => ctx.router.navigate('metrics', { node: node.id }) },
      { separator: true },
      { label: t('common.delete'), icon: 'trash', danger: true, onClick: () => deleteNode(node) },
    ]);
  }

  async function addNode(parentId) {
    const parent = parentId ? store.get('structureNodes', parentId) : null;
    const node = await promptDialog({
      title: parent ? t('mm.addSubNodeTitle', { name: parent.name }) : t('mm.addRootNode'),
      confirmLabel: t('common.create'),
      fields: [{ name: 'name', label: t('mm.nodeName'), placeholder: t('mm.nodeNamePlaceholder'), required: true }, { name: 'code', label: t('mm.nodeCode'), placeholder: 'VH.DV' }, { name: 'owner', label: t('metric.field.owner') }],
      submit: (values) => services.structure.createNode({ parentId, name: values.name, code: values.code, owner: values.owner }),
    });
    if (!node) return;
    if (parentId) expanded.add(parentId);
    setPreference('structure.expanded', [...expanded]);
    hierarchy.render();
    select(node.id);
  }

  async function renameNode(node) {
    await promptDialog({
      title: t('mm.renameNode'),
      fields: [{ name: 'name', label: t('mm.nodeName'), value: node.name, required: true }, { name: 'code', label: t('mm.nodeCode'), value: node.code }, { name: 'owner', label: t('metric.field.owner'), value: node.owner }, { name: 'description', label: t('metric.field.definition'), value: node.description || '' }],
      submit: (values) => services.structure.updateNode(node.id, values),
    });
  }

  async function moveNodeDialog(node) {
    const options = [{ value: '', label: t('mm.rootLevel') }, ...nodeOptions(ctx).filter((o) => o.value !== node.id && !services.structure.isDescendant(o.value, node.id))];
    const moved = await promptDialog({
      title: t('mm.moveNodeTitle', { name: node.name }),
      confirmLabel: t('common.move'),
      fields: [{ name: 'parentId', label: t('mm.newParent'), type: 'select', value: node.parentId || '', options }],
      submit: async (values) => { await services.structure.moveNode(node.id, values.parentId || null); return { parentId: values.parentId }; },
    });
    if (!moved) return;
    if (moved.parentId) expanded.add(moved.parentId);
    setPreference('structure.expanded', [...expanded]);
    hierarchy.render();
  }

  async function deleteNode(node) {
    const counts = selectors.nodeCounts(node.id);
    const entry = selectors.structureTree().byId.get(node.id);
    const children = entry ? entry.children.length : 0;
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
      if (state.nodeId === node.id) select(node.parentId || null);
      ctx.toast.success(t('mm.nodeDeleted', { name: node.name }));
    } catch (err) {
      ctx.toast.error(err.message);
    }
  }

  // ---------------------------------------------------------------- sync
  function renderMeta() {
    const nodes = store.count('structureNodes');
    const roots = selectors.structureTree().roots.length;
    meta.textContent = t('structure.meta', { nodes: formatNumber(nodes), roots: formatNumber(roots), unplaced: formatNumber(selectors.unplacedMetricIds().size) });
  }
  const schedule = debounce(() => { hierarchy.render(); hierarchy.select(state.nodeId, { silent: true }); renderInsights(); renderMeta(); }, 30);
  const offStore = store.events.on('change', (evt) => { if (['*', 'structureNodes', 'metricStructures', 'metrics'].includes(evt.collection)) schedule(); });
  hierarchy.render();
  renderMeta();

  return {
    update(route) {
      const id = route.params.node;
      if (id && store.has('structureNodes', id)) {
        const entry = selectors.structureTree().byId.get(id);
        if (entry) for (const p of entry.path.slice(0, -1)) expanded.add(p);
        hierarchy.render();
        if (id !== state.nodeId) select(id);
        hierarchy.reveal(id);
      } else if (!id && state.nodeId) {
        hierarchy.select(state.nodeId, { silent: true });
      }
    },
    onShow() {},
    onDrawerClosed() {},
    onMetricOpened() {},
    destroy() { offStore(); schedule.cancel(); layout.el.remove(); },
  };
}
