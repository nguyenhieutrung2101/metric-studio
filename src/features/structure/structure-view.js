import { h, btn, icon, formatNumber } from '../../ui/dom.js';
import { t } from '../../ui/i18n.js';
import { openMenu } from '../../ui/components/menu.js';
import { confirmDialog, promptDialog } from '../../ui/components/confirm.js';
import { combobox } from '../../ui/components/combobox.js';
import { debounce } from '../../utils/debounce.js';
import { getPreference, setPreference } from '../../utils/preferences.js';
import { pageHeader } from '../../ui/workspace/page-header.js';
import { workspaceLayout } from '../../ui/workspace/workspace-layout.js';
import { createInsightsPanel, insightSection, insightStat } from '../../ui/workspace/insights-panel.js';
import { hierarchyWorkspace } from '../../ui/hierarchy/hierarchy-workspace.js';
import { nodeOptions } from '../metric-master/metric-drawer.js';
import { ReportKind } from '../../core/models/report.js';

const NODE_MIME = 'application/x-metric-studio-node';
const METRIC_MIME = 'application/x-metric-studio-metric';
const REPORT_MIME = 'application/x-metric-studio-report';

/**
 * Structure — two hierarchies side by side, one inspector.
 *
 *   ┌ Hierarchy ──────────────┬ Reports ────────────────┬ Insights ┐
 *   │ where a metric belongs  │ where a metric is shown │          │
 *   └─────────────────────────┴─────────────────────────┴──────────┘
 *
 * The governance hierarchy is edited exactly as before: add, rename, move,
 * reorder, delete, drag a group under another. The Reports pane has the
 * same grammar for folders and reports, plus one more move: a metric
 * dragged from a group's list (or picked in the inspector) is linked to a
 * report. One selection at a time — a group or a report — and the
 * inspector on the right carries every action, so the … menu and the
 * panel always agree.
 */
export function mountStructureView(container, ctx) {
  const { store, selectors, services } = ctx;
  const state = { nodeId: null, reportId: null };
  const expanded = new Set(getPreference('structure.expanded', getPreference('tree.expanded', [])));
  const expandedReports = new Set(getPreference('reports.expanded', []));
  const rememberExpanded = () => setPreference('structure.expanded', [...expanded]);
  const rememberReports = () => setPreference('reports.expanded', [...expandedReports]);

  const meta = h('span', { class: 'muted small' });
  const header = pageHeader({ title: t('nav.structure'), subtitle: t('structure.subtitle'), meta });

  // ---------------------------------------------------------------- hierarchy pane
  const addRootBtn = btn(t('mm.addRootNode'), { size: 'sm', icon: 'plus', on: { click: () => addNode(null) } });
  const hierarchy = hierarchyWorkspace({
    title: t('structure.hierarchy'),
    emptyText: t('structure.empty'),
    expanded,
    onToggle: rememberExpanded,
    actions: [addRootBtn],
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
            if (payload.fromNodeId && payload.fromNodeId !== targetId) await services.structure.moveMetric(payload.id, payload.fromNodeId, targetId);
            else await services.structure.placeMetric(payload.id, targetId);
            ctx.toast.success(t('mm.metricMoved', { node: store.get('structureNodes', targetId).name }));
          } else if (payload.id !== targetId) {
            if (position === 'into') await services.structure.moveNode(payload.id, targetId);
            else await services.structure.moveNodeRelative(payload.id, targetId, position);
            const parent = position === 'into' ? targetId : store.get('structureNodes', targetId).parentId;
            if (parent) expanded.add(parent);
            rememberExpanded();
          }
        } catch (err) {
          ctx.toast.error(err.message);
        }
      },
    },
  });

  // ---------------------------------------------------------------- reports pane
  // "+ Folder" and "+ Report" add into the folder in context: the selected
  // folder, the folder of the selected report, or the root.
  const folderInContext = () => {
    const r = state.reportId ? store.get('reports', state.reportId) : null;
    if (!r) return null;
    return r.kind === ReportKind.FOLDER ? r.id : r.parentId || null;
  };
  const addFolderBtn = btn(t('reports.addFolder'), { size: 'sm', icon: 'folder', on: { click: () => addReport(folderInContext(), ReportKind.FOLDER) } });
  const addReportBtn = btn(t('reports.addReport'), { size: 'sm', icon: 'file', on: { click: () => addReport(folderInContext(), ReportKind.REPORT) } });
  const reports = hierarchyWorkspace({
    title: t('reports.title'),
    emptyText: t('reports.empty'),
    expanded: expandedReports,
    onToggle: rememberReports,
    actions: [addFolderBtn, addReportBtn],
    getRoots: () => selectors.reportTree().roots,
    renderLabel: (entry, el) => {
      const r = entry.node;
      const folder = r.kind === ReportKind.FOLDER;
      const counts = selectors.reportCounts(r.id);
      const n = folder ? counts.total : counts.direct;
      el.append(
        icon(folder ? 'folder' : 'file', { size: 14, className: ['tree-icon', !folder && 'tree-icon-report'].filter(Boolean).join(' ') }),
        h('span', { class: 'tree-name', text: r.name, title: r.code ? `${r.code} · ${r.name}` : r.name }),
        r.code && h('span', { class: 'tree-code mono muted', text: r.code }),
        h('span', { class: 'tree-count', text: n ? formatNumber(n) : '', title: folder ? t('reports.countFolder', { metrics: counts.total, reports: counts.reports }) : t('reports.countReport', { n }) }),
        h('button', { type: 'button', class: 'tree-more', title: t('common.more'), on: { click: (e) => { e.stopPropagation(); reportMenu(r, e.currentTarget); } } }, icon('more', { size: 14 })),
      );
    },
    onSelect: (id) => selectReport(id),
    onContextMenu: (entry, e) => reportMenu(entry.node, e.target),
    dnd: {
      mimeType: REPORT_MIME,
      accepts: [REPORT_MIME, METRIC_MIME],
      canDrag: () => true,
      // A metric lands only on a report; an item lands inside a folder or
      // beside a sibling whose parent is a folder (or the root).
      canDrop: (payload, targetId, position) => {
        const target = store.get('reports', targetId);
        if (!target) return false;
        if (payload.type === METRIC_MIME) return target.kind === ReportKind.REPORT;
        if (position === 'into') return target.kind === ReportKind.FOLDER;
        const parent = target.parentId ? store.get('reports', target.parentId) : null;
        return !parent || parent.kind === ReportKind.FOLDER;
      },
      onDrop: async (payload, targetId, position) => {
        try {
          if (payload.type === METRIC_MIME) {
            const moved = payload.fromReportId && payload.fromReportId !== targetId;
            if (moved) await services.reports.moveLink(payload.id, payload.fromReportId, targetId);
            else await services.reports.linkMetric(payload.id, targetId);
            ctx.toast.success(t(moved ? 'reports.metricMoved' : 'reports.metricLinked', { report: store.get('reports', targetId).name }));
          } else if (payload.id !== targetId) {
            if (position === 'into') await services.reports.move(payload.id, targetId);
            else await services.reports.moveRelative(payload.id, targetId, position);
            const parent = position === 'into' ? targetId : store.get('reports', targetId).parentId;
            if (parent) expandedReports.add(parent);
            rememberReports();
          }
        } catch (err) {
          ctx.toast.error(err.message);
        }
      },
    },
  });

  // The wrapper is the size container the split queries: too narrow for two
  // panes side by side, and they stack.
  const split = h('div', { class: 'structure-split' }, hierarchy.el, reports.el);
  const main = h('div', { class: 'structure-main' }, split);
  const insights = createInsightsPanel({ preferenceKey: 'structure', title: t('insights.title'), emptyText: t('structure.pick') });
  const layout = workspaceLayout({ header: header.el, main, insights: insights.el, className: 'structure-ws' });
  container.appendChild(layout.el);

  // ---------------------------------------------------------------- selection + inspector
  function select(id) {
    state.nodeId = id && store.has('structureNodes', id) ? id : null;
    if (state.nodeId) {
      state.reportId = null;
      reports.select(null, { silent: true });
    }
    ctx.router.setParams({ node: state.nodeId, report: state.reportId });
    hierarchy.select(state.nodeId, { silent: true });
    renderInsights();
  }

  function selectReport(id) {
    state.reportId = id && store.has('reports', id) ? id : null;
    if (state.reportId) {
      state.nodeId = null;
      hierarchy.select(null, { silent: true });
    }
    ctx.router.setParams({ node: state.nodeId, report: state.reportId });
    reports.select(state.reportId, { silent: true });
    renderInsights();
  }

  /** A metric row in the inspector can be dragged onto a group or a report. */
  function draggableMetric(m, payload, ...children) {
    return h('li', {
      draggable: true,
      title: t('reports.dragHint'),
      on: {
        dragstart: (e) => {
          e.dataTransfer.effectAllowed = 'copyMove';
          e.dataTransfer.setData(METRIC_MIME, JSON.stringify({ id: m.id, ...payload }));
          e.currentTarget.classList.add('dragging');
        },
        dragend: (e) => e.currentTarget.classList.remove('dragging'),
      },
    }, icon('drag', { size: 12, className: 'drag-handle' }), ...children);
  }

  function renderInsights() {
    const report = state.reportId ? store.get('reports', state.reportId) : null;
    const node = !report && state.nodeId ? store.get('structureNodes', state.nodeId) : null;
    if (report) insights.setContent(reportInsights(report));
    else if (node) insights.setContent(nodeInsights(node));
    else insights.setContent(null);
  }

  function nodeInsights(node) {
    const counts = selectors.nodeCounts(node.id);
    const entry = selectors.structureTree().byId.get(node.id);
    const children = entry ? entry.children.length : 0;
    const path = selectors.nodePath(node.id);
    const direct = [...selectors.metricIdsInNode(node.id)].map((id) => store.get('metrics', id)).filter(Boolean).sort((a, b) => a.code.localeCompare(b.code));
    return h('div', { class: 'insight' },
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
          insightStat(formatNumber(counts.direct), t('structure.directMetrics'), { onClick: () => ctx.router.navigate('metrics', { node: node.id, direct: 1 }) }),
          insightStat(formatNumber(counts.total), t('structure.totalMetrics'), { onClick: () => ctx.router.navigate('metrics', { node: node.id }) }),
          insightStat(formatNumber(children), t('structure.subGroups')),
        ),
      ),
      direct.length ? insightSection(t('structure.directList', { n: direct.length }),
        h('ul', { class: 'insight-list drag-list' }, direct.slice(0, 12).map((m) => draggableMetric(m, { fromNodeId: node.id },
          h('span', { class: 'mono muted', text: m.code }),
          h('button', { type: 'button', class: 'link ellipsis', title: m.name, on: { click: () => ctx.router.navigate('metrics', { node: node.id, selected: m.id }) } }, m.name),
        )), direct.length > 12 && h('li', { class: 'muted', text: t('structure.andMore', { n: direct.length - 12 }) })),
      ) : null,
      h('div', { class: 'insight-actions' },
        btn(t('common.rename'), { size: 'sm', icon: 'edit', on: { click: () => renameNode(node) } }),
        btn(t('mm.addSubNode'), { size: 'sm', icon: 'plus', on: { click: () => addNode(node.id) } }),
        btn(t('mm.moveTo'), { size: 'sm', icon: 'arrowRight', on: { click: () => moveNodeDialog(node) } }),
        btn(t('mm.newMetricHere'), { size: 'sm', icon: 'layers', on: { click: () => ctx.router.navigate('metrics', { node: node.id, new: 1 }) } }),
        btn(t('common.delete'), { size: 'sm', icon: 'trash', kind: 'danger-ghost', on: { click: () => deleteNode(node) } }),
      ),
    );
  }

  function reportInsights(r) {
    const folder = r.kind === ReportKind.FOLDER;
    const counts = selectors.reportCounts(r.id);
    const path = selectors.reportPath(r.id);
    const links = folder ? [] : selectors.reportLinks(r.id).map((link) => ({ link, metric: store.get('metrics', link.metricId) })).filter((x) => x.metric);
    const inside = [];
    if (folder) {
      const visit = (entry, guard) => {
        for (const c of entry.children) {
          if (guard.has(c.node.id)) continue;
          guard.add(c.node.id);
          if (c.node.kind !== ReportKind.FOLDER) inside.push(c.node);
          visit(c, guard);
        }
      };
      const entry = selectors.reportTree().byId.get(r.id);
      if (entry) visit(entry, new Set([r.id]));
    }
    const linked = new Set(links.map((x) => x.metric.id));
    const picker = folder ? null : combobox({
      placeholder: t('reports.linkMetric'),
      search: (q) => selectors.suggestMetrics(q, 12, linked).map((m) => ({ id: m.id, label: m.name, meta: m.code })),
      onSelect: (item, { clear }) => {
        clear();
        services.reports.linkMetric(item.id, r.id).then(() => ctx.toast.success(t('reports.metricLinked', { report: r.name }))).catch((e) => ctx.toast.error(e.message));
      },
    });
    return h('div', { class: 'insight' },
      h('div', { class: 'insight-head' },
        h('div', { class: 'insight-title', text: r.name }),
        h('div', { class: 'insight-sub' }, r.code && h('span', { class: 'mono', text: r.code }), h('span', { class: 'tag', text: t(folder ? 'reports.kind.folder' : 'reports.kind.report') }), r.owner && h('span', { class: 'tag', text: r.owner })),
      ),
      insightSection(t('structure.path'),
        h('div', { class: 'link-path' }, path.map((p, i) => h('span', { class: ['crumb', i === path.length - 1 && 'last'], text: p.name, on: { click: () => selectReport(p.id) } }))),
        r.description && h('p', { class: 'insight-para', text: r.description }),
      ),
      insightSection(t('structure.contents'),
        h('div', { class: 'insight-stats' }, folder
          ? [insightStat(formatNumber(counts.reports), t('reports.reportsStat')), insightStat(formatNumber(counts.folders), t('reports.foldersStat')), insightStat(formatNumber(counts.total), t('reports.metricsStat'))]
          : [insightStat(formatNumber(counts.direct), t('reports.metricsStat'))]),
      ),
      folder
        ? insightSection(t('reports.insideList', { n: inside.length }),
          inside.length
            ? h('ul', { class: 'insight-list' }, inside.slice(0, 12).map((x) => h('li', null,
              icon('file', { size: 14, className: 'muted' }),
              h('button', { type: 'button', class: 'link ellipsis', title: x.name, on: { click: () => { const entry = selectors.reportTree().byId.get(x.id); if (entry) for (const p of entry.path.slice(0, -1)) expandedReports.add(p); rememberReports(); reports.render(); selectReport(x.id); reports.reveal(x.id); } } }, x.name),
              x.code && h('span', { class: 'mono muted small', text: x.code }),
            )), inside.length > 12 && h('li', { class: 'muted', text: t('structure.andMore', { n: inside.length - 12 }) }))
            : h('p', { class: 'insight-para muted', text: t('reports.noReportsInside') }),
        )
        : insightSection(t('reports.linkedList', { n: links.length }),
          links.length
            ? h('ul', { class: 'insight-list drag-list' }, links.map(({ link, metric }) => draggableMetric(metric, { fromReportId: r.id },
              h('span', { class: 'mono muted', text: metric.code }),
              h('button', { type: 'button', class: 'link ellipsis', title: metric.name, on: { click: () => ctx.router.navigate('metrics', { selected: metric.id }) } }, metric.name),
              btn('', { icon: 'close', size: 'sm', className: 'btn-ghost link-remove', title: t('reports.unlink'), on: { click: () => services.reports.unlinkMetric(link.id).catch((e) => ctx.toast.error(e.message)) } }),
            )))
            : h('p', { class: 'insight-para muted', text: t('reports.noMetrics') }),
          picker.el,
        ),
      h('div', { class: 'insight-actions' },
        btn(t('common.rename'), { size: 'sm', icon: 'edit', on: { click: () => editReport(r) } }),
        folder && btn(t('reports.addFolder'), { size: 'sm', icon: 'folder', on: { click: () => addReport(r.id, ReportKind.FOLDER) } }),
        folder && btn(t('reports.addReport'), { size: 'sm', icon: 'file', on: { click: () => addReport(r.id, ReportKind.REPORT) } }),
        btn(t('mm.moveTo'), { size: 'sm', icon: 'arrowRight', on: { click: () => moveReportDialog(r) } }),
        btn(t('common.delete'), { size: 'sm', icon: 'trash', kind: 'danger-ghost', on: { click: () => deleteReport(r) } }),
      ),
    );
  }

  // ---------------------------------------------------------------- hierarchy editing
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
      fields: [{ name: 'name', label: t('mm.nodeName'), placeholder: t('mm.nodeNamePlaceholder'), required: true }, { name: 'code', label: t('mm.nodeCode'), placeholder: services.structure.nextCode() }, { name: 'owner', label: t('metric.field.owner') }],
      submit: (values) => services.structure.createNode({ parentId, name: values.name, code: values.code, owner: values.owner }),
    });
    if (!node) return;
    if (parentId) expanded.add(parentId);
    rememberExpanded();
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
    rememberExpanded();
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

  // ---------------------------------------------------------------- report editing
  function reportMenu(r, anchor) {
    const folder = r.kind === ReportKind.FOLDER;
    openMenu(anchor, [
      folder && { label: t('reports.addFolder'), icon: 'folder', onClick: () => addReport(r.id, ReportKind.FOLDER) },
      folder && { label: t('reports.addReport'), icon: 'file', onClick: () => addReport(r.id, ReportKind.REPORT) },
      { label: t('common.rename'), icon: 'edit', onClick: () => editReport(r) },
      { separator: true },
      { label: t('mm.moveUp'), icon: 'up', onClick: () => services.reports.reorder(r.id, 'up').catch((e) => ctx.toast.error(e.message)) },
      { label: t('mm.moveDown'), icon: 'down', onClick: () => services.reports.reorder(r.id, 'down').catch((e) => ctx.toast.error(e.message)) },
      { label: t('mm.moveTo'), icon: 'arrowRight', onClick: () => moveReportDialog(r) },
      { separator: true },
      { label: t('common.delete'), icon: 'trash', danger: true, onClick: () => deleteReport(r) },
    ].filter(Boolean));
  }

  const kindOptions = () => [{ value: ReportKind.FOLDER, label: t('reports.kind.folder') }, { value: ReportKind.REPORT, label: t('reports.kind.report') }];

  async function addReport(parentId, kind) {
    const parent = parentId ? store.get('reports', parentId) : null;
    const folder = kind === ReportKind.FOLDER;
    const created = await promptDialog({
      title: parent ? t(folder ? 'reports.addFolderIn' : 'reports.addReportIn', { name: parent.name }) : t(folder ? 'reports.addFolder' : 'reports.addReport'),
      confirmLabel: t('common.create'),
      fields: [
        { name: 'name', label: t(folder ? 'reports.folderName' : 'reports.reportName'), placeholder: t(folder ? 'reports.folderPlaceholder' : 'reports.reportPlaceholder'), required: true },
        { name: 'code', label: t('reports.code'), placeholder: services.reports.nextCode() },
        { name: 'owner', label: t('metric.field.owner') },
        { name: 'description', label: t('metric.field.definition') },
      ],
      submit: (v) => services.reports.create({ parentId, kind, name: v.name, code: v.code, owner: v.owner, description: v.description }),
    });
    if (!created) return;
    if (parentId) expandedReports.add(parentId);
    rememberReports();
    reports.render();
    selectReport(created.id);
  }

  async function editReport(r) {
    await promptDialog({
      title: t(r.kind === ReportKind.FOLDER ? 'reports.editFolder' : 'reports.editReport'),
      fields: [
        { name: 'name', label: t('metric.field.name'), value: r.name, required: true },
        { name: 'code', label: t('reports.code'), value: r.code },
        { name: 'kind', label: t('reports.kind'), type: 'select', value: r.kind, options: kindOptions() },
        { name: 'owner', label: t('metric.field.owner'), value: r.owner },
        { name: 'description', label: t('metric.field.definition'), value: r.description || '' },
      ],
      submit: (v) => services.reports.update(r.id, v),
    });
  }

  /** Folders the item can move into: every folder but itself and its own subtree. */
  function folderOptions(except) {
    const out = [{ value: '', label: t('mm.rootLevel') }];
    const walk = (entry) => {
      if (entry.node.id === except) return;
      if (entry.node.kind === ReportKind.FOLDER) out.push({ value: entry.node.id, label: `${'  '.repeat(entry.depth)}${entry.node.name}` });
      for (const c of entry.children) walk(c);
    };
    for (const root of selectors.reportTree().roots) walk(root);
    return out;
  }

  async function moveReportDialog(r) {
    const moved = await promptDialog({
      title: t('mm.moveNodeTitle', { name: r.name }),
      confirmLabel: t('common.move'),
      fields: [{ name: 'parentId', label: t('reports.newParent'), type: 'select', value: r.parentId || '', options: folderOptions(r.id) }],
      submit: async (v) => { await services.reports.move(r.id, v.parentId || null); return { parentId: v.parentId }; },
    });
    if (!moved) return;
    if (moved.parentId) expandedReports.add(moved.parentId);
    rememberReports();
    reports.render();
  }

  async function deleteReport(r) {
    const folder = r.kind === ReportKind.FOLDER;
    const entry = selectors.reportTree().byId.get(r.id);
    const children = entry ? entry.children.length : 0;
    const links = folder ? 0 : selectors.reportLinks(r.id).length;
    const hasContent = children > 0 || links > 0;
    const choice = await confirmDialog({
      title: t('reports.deleteTitle', { name: r.name }),
      message: !hasContent ? t('reports.deleteEmpty') : folder ? t('reports.deleteFolderMessage', { n: children }) : t('reports.deleteReportMessage', { n: links }),
      confirmLabel: t('common.delete'),
      options: hasContent ? [{ value: 'moveToParent', label: t(folder ? 'reports.deleteMoveUp' : 'reports.deleteUnlink') }] : null,
    });
    if (!choice) return;
    try {
      await services.reports.delete(r.id, { strategy: hasContent ? 'moveToParent' : 'refuse' });
      if (state.reportId === r.id) selectReport(r.parentId || null);
      ctx.toast.success(t('reports.deleted', { name: r.name }));
    } catch (err) {
      ctx.toast.error(err.message);
    }
  }

  // ---------------------------------------------------------------- sync
  function renderMeta() {
    const nodes = store.count('structureNodes');
    const roots = selectors.structureTree().roots.length;
    let reportCount = 0;
    let folderCount = 0;
    for (const r of store.list('reports')) if (r.kind === ReportKind.FOLDER) folderCount += 1; else reportCount += 1;
    meta.textContent = `${t('structure.meta', { nodes: formatNumber(nodes), roots: formatNumber(roots), unplaced: formatNumber(selectors.unplacedMetricIds().size) })} · ${t('reports.meta', { reports: formatNumber(reportCount), folders: formatNumber(folderCount) })}`;
  }
  function renderAll() {
    if (state.nodeId && !store.has('structureNodes', state.nodeId)) state.nodeId = null;
    if (state.reportId && !store.has('reports', state.reportId)) state.reportId = null;
    hierarchy.render();
    hierarchy.select(state.nodeId, { silent: true });
    reports.render();
    reports.select(state.reportId, { silent: true });
    renderInsights();
    renderMeta();
  }
  const schedule = debounce(renderAll, 30);
  const offStore = store.events.on('change', (evt) => { if (['*', 'structureNodes', 'metricStructures', 'metrics', 'reports', 'metricReports'].includes(evt.collection)) schedule(); });
  renderAll();

  return {
    update(route) {
      const id = route.params.node;
      const rid = route.params.report;
      if (id && !store.has('structureNodes', id)) {
        // A bookmark to a group that is gone: say so, show nothing selected.
        ctx.toast.info(t('mm.nodeGone'));
        ctx.router.setParams({ node: null });
        select(null);
        return;
      }
      if (rid && !store.has('reports', rid)) {
        ctx.toast.info(t('reports.gone'));
        ctx.router.setParams({ report: null });
        selectReport(null);
        return;
      }
      if (rid) {
        const entry = selectors.reportTree().byId.get(rid);
        if (entry) for (const p of entry.path.slice(0, -1)) expandedReports.add(p);
        reports.render();
        if (rid !== state.reportId) selectReport(rid);
        reports.reveal(rid);
      } else if (id) {
        const entry = selectors.structureTree().byId.get(id);
        if (entry) for (const p of entry.path.slice(0, -1)) expanded.add(p);
        hierarchy.render();
        if (id !== state.nodeId) select(id);
        hierarchy.reveal(id);
      } else {
        if (state.nodeId) hierarchy.select(state.nodeId, { silent: true });
        if (state.reportId) reports.select(state.reportId, { silent: true });
      }
    },
    onShow() {},
    onDrawerClosed() {},
    onMetricOpened() {},
    destroy() { offStore(); schedule.cancel(); layout.el.remove(); },
  };
}
