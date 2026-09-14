import { h, btn, icon, formatNumber } from '../../ui/dom.js';
import { t } from '../../ui/i18n.js';
import { VirtualList } from '../../ui/table/virtual-list.js';
import { severityDot } from '../../ui/components/chip.js';
import { normalizeText } from '../../utils/text.js';
import { pageHeader } from '../../ui/workspace/page-header.js';
import { workspaceLayout } from '../../ui/workspace/workspace-layout.js';
import { createInsightsPanel, insightRow, insightSection } from '../../ui/workspace/insights-panel.js';
import { filterBar } from '../../ui/filter/filter-bar.js';
import { writeFilters, readFilters, filtersDiffer } from '../../ui/workspace/route-state.js';

const SEVERITIES = ['error', 'warning', 'info'];
const ENTITY_TYPES = ['metric', 'binding', 'structure', 'dimension', 'member', 'metricDimension', 'metricStructure'];
const RANK = { error: 0, warning: 1, info: 2 };

/**
 * Quality — the workbench for everything validation found.
 *
 * Opens with the numbers (errors, warnings, info, metrics affected), lists
 * every issue underneath, and inspects one at a time: what rule, about which
 * thing, and the one button that goes there. Click inspects; double-click or
 * Enter jumps straight to the problem.
 */
export function mountQualityView(container, ctx) {
  const { store, selectors } = ctx;
  const state = { query: '', filters: {}, items: [], selectedId: null };

  // ---------------------------------------------------------------- header + KPIs
  const countLabel = h('span', { class: 'count-label' });
  const header = pageHeader({ title: t('nav.quality'), subtitle: t('quality.subtitle'), meta: countLabel, actions: [btn(t('warnings.revalidate'), { size: 'sm', icon: 'check', on: { click: () => ctx.validation.run() } })] });
  const kpis = h('div', { class: 'kpi-row' });

  function kpi(value, caption, { className = '', active = false, onClick = null } = {}) {
    return h(onClick ? 'button' : 'div', { type: onClick ? 'button' : undefined, class: ['kpi', className, active && 'active', !onClick && 'static'], on: onClick ? { click: onClick } : undefined },
      h('span', { class: 'kpi-value', text: formatNumber(value) }), h('span', { class: 'kpi-caption', text: caption }));
  }

  function renderKpis() {
    const index = ctx.validation.index;
    const affected = [...index.byMetric.keys()].filter((id) => store.has('metrics', id)).length;
    kpis.replaceChildren(
      ...SEVERITIES.map((s) => kpi(index.bySeverity[s] || 0, t(`severity.${s}`), { className: `kpi-${s}`, active: state.filters.severity === s, onClick: () => filters.set('severity', state.filters.severity === s ? '' : s) })),
      kpi(affected, t('quality.kpi.metricsAffected'), { className: 'kpi-neutral' }),
      kpi(Math.max(0, store.count('metrics') - affected), t('quality.kpi.clean'), { className: 'kpi-ok' }),
    );
  }

  // ---------------------------------------------------------------- filters
  const FILTER_SPEC = { severity: {}, entity: {}, rule: {}, scenario: {} };
  const filters = filterBar({
    search: { placeholder: t('warnings.searchPlaceholder'), onChange: (q) => { state.query = q; ctx.router.setParams({ q: q || null }); refresh(); }, onEnter: () => { if (state.items.length) select(state.items[0].id); } },
    filters: [
      { key: 'severity', label: t('quality.filter.severity'), options: SEVERITIES.map((s) => ({ value: s, label: t(`severity.${s}`) })) },
      { key: 'entity', label: t('quality.filter.entity'), options: ENTITY_TYPES.map((e) => ({ value: e, label: t(`entity.${e}`) })) },
      { key: 'rule', label: t('quality.filter.rule'), options: () => [...new Set(ctx.validation.index.issues.map((i) => i.code))].sort().map((c) => ({ value: c, label: c })) },
      { key: 'scenario', label: t('quality.filter.scenario'), options: () => selectors.scenarios().map((s) => ({ value: s.id, label: s.code })) },
    ],
    extra: [h('span', { class: 'muted small list-hint', text: t('quality.hint') })],
    onChange: (values) => { state.filters = values; writeFilters(ctx.router, values, FILTER_SPEC); refresh(); renderKpis(); },
  });

  // ---------------------------------------------------------------- grid
  const head = h('div', { class: 'table-head issue-row' }, h('span', { class: 'col-sev' }), h('span', { class: 'col-entity', text: t('warnings.entity') }), h('span', { class: 'col-msg', text: t('warnings.message') }), h('span', { class: 'col-code', text: t('warnings.rule') }));
  const empty = h('div', { class: 'empty', hidden: true }, icon('check', { size: 28 }), h('p', { text: t('warnings.empty') }));
  const listHost = h('div', { class: 'list-host' });
  const main = h('section', { class: 'pane' }, listHost, empty);
  const list = new VirtualList(listHost, {
    rowHeight: 'row',
    keyOf: (i) => i.id,
    emptyNode: empty,
    renderRow,
    onSelect: (i) => select(i ? i.id : null),
    onActivate: (i) => jump(i),
    header: head,
    minWidth: 28 + 24 + 200 + 280 + 160 + 30,
  });

  function entityLabel(issue) {
    const { type, id } = issue.entity;
    if (issue.metricId) {
      const m = store.get('metrics', issue.metricId);
      const scn = issue.scenarioId ? store.get('scenarios', issue.scenarioId) : null;
      return m ? `${m.code} · ${m.name}${scn ? ` · ${scn.code}` : ''}` : id;
    }
    if (type === 'structure') { const n = store.get('structureNodes', id); return n ? n.name : id; }
    if (type === 'dimension') { const d = store.get('dimensions', id); return d ? `${d.code} · ${d.name}` : id; }
    if (type === 'member') { const mem = store.get('dimensionMembers', id); const d = mem && store.get('dimensions', mem.dimensionId); return mem ? `${d ? d.code + ' › ' : ''}${mem.name}` : id; }
    return id;
  }

  function renderRow(issue) {
    return h('div', { class: ['issue-row', 'row', `sev-row-${issue.severity}`], role: 'row', tabindex: '-1', dataset: { id: issue.id }, title: t('quality.hint') },
      h('span', { class: 'col-sev' }, severityDot(issue.severity)),
      h('span', { class: 'col-entity' }, h('span', { class: 'tag', text: t(`entity.${issue.entity.type}`) }), h('span', { class: 'entity-label ellipsis', text: entityLabel(issue), title: entityLabel(issue) })),
      h('span', { class: 'col-msg ellipsis', text: ctx.describeIssue(issue), title: ctx.describeIssue(issue) }),
      h('span', { class: 'col-code mono muted small', text: issue.code }),
    );
  }

  // ---------------------------------------------------------------- drill-through
  function jump(issue) {
    if (!issue) return;
    const { type, id } = issue.entity;
    if (issue.metricId && store.has('metrics', issue.metricId)) {
      const section = type === 'binding' ? 'bindings' : type === 'metricDimension' ? 'dimensions' : issue.code.includes('UNPLACED') ? 'structure' : 'definition';
      ctx.openMetric(issue.metricId, { section, scenarioId: issue.scenarioId || null });
      return;
    }
    if (type === 'structure' || issue.structureNodeId) { ctx.router.navigate('structure', { node: issue.structureNodeId || id }); return; }
    if (type === 'dimension' || type === 'member' || issue.dimensionId) {
      const member = type === 'member' ? id : null;
      const dimId = issue.dimensionId || (type === 'dimension' ? id : (store.get('dimensionMembers', id) || {}).dimensionId);
      ctx.router.navigate('dimensions', { dimension: dimId, member });
      return;
    }
    ctx.toast.info(t('warnings.noTarget'));
  }

  // ---------------------------------------------------------------- insights
  const insights = createInsightsPanel({ preferenceKey: 'quality', title: t('insights.title'), emptyText: t('quality.pick') });

  function select(id) {
    state.selectedId = id && state.items.some((i) => i.id === id) ? id : null;
    list.setSelected(state.selectedId);
    ctx.router.setParams({ issue: state.selectedId });
    renderInsights();
  }

  /**
   * A link to one issue (an overview row, a bookmark) selects and reveals
   * it. If the filters hide it they are cleared; if it is no longer
   * reported, the page says so instead of showing an unrelated list.
   */
  function reveal(issueId) {
    const all = ctx.validation.index.issues;
    if (!all.some((i) => i.id === issueId)) {
      ctx.toast.info(t('quality.issueGone'));
      ctx.router.setParams({ issue: null });
      return;
    }
    if (!state.items.some((i) => i.id === issueId)) filters.reset();
    select(issueId);
    const idx = state.items.findIndex((i) => i.id === issueId);
    if (idx >= 0) list.scrollToIndex(idx);
  }

  function renderInsights() {
    const issue = state.selectedId ? state.items.find((i) => i.id === state.selectedId) : null;
    if (!issue) { insights.setContent(null); return; }
    const m = issue.metricId ? store.get('metrics', issue.metricId) : null;
    const scn = issue.scenarioId ? store.get('scenarios', issue.scenarioId) : null;
    const node = issue.structureNodeId ? store.get('structureNodes', issue.structureNodeId) : issue.entity.type === 'structure' ? store.get('structureNodes', issue.entity.id) : null;
    const member = issue.entity.type === 'member' ? store.get('dimensionMembers', issue.entity.id) : null;
    const dimId = issue.dimensionId || (issue.entity.type === 'dimension' ? issue.entity.id : member ? member.dimensionId : null);
    const dim = dimId ? store.get('dimensions', dimId) : null;
    const content = h('div', { class: ['insight', `insight-sev-${issue.severity}`] },
      h('div', { class: 'insight-head' },
        h('div', { class: 'insight-title', text: t(`severity.${issue.severity}`) }),
        h('div', { class: 'insight-sub' }, h('span', { class: 'mono', text: issue.code }), h('span', { class: 'tag', text: t(`entity.${issue.entity.type}`) })),
      ),
      insightSection(t('warnings.message'), h('p', { class: 'insight-para', text: ctx.describeIssue(issue) })),
      insightSection(t('quality.about'),
        m && insightRow(t('quality.metric'), h('button', { type: 'button', class: 'link', on: { click: () => ctx.router.navigate('metrics', { selected: m.id }) } }, `${m.code} · ${m.name}`)),
        scn && insightRow(t('quality.scenario'), h('button', { type: 'button', class: 'link', on: { click: () => ctx.router.navigate('bindings', { selected: m ? m.id : null, scenario: scn.code }) } }, `${scn.code} · ${scn.name}`)),
        node && insightRow(t('quality.node'), h('button', { type: 'button', class: 'link', on: { click: () => ctx.router.navigate('structure', { node: node.id }) } }, selectors.nodePathLabel(node.id, ' › '))),
        dim && insightRow(t('quality.dimension'), h('button', { type: 'button', class: 'link', on: { click: () => ctx.router.navigate('dimensions', { dimension: dim.id }) } }, `${dim.code} · ${dim.name}`)),
        member && insightRow(t('quality.member'), h('button', { type: 'button', class: 'link', on: { click: () => ctx.router.navigate('dimensions', { dimension: member.dimensionId, member: member.id }) } }, member.name)),
        !m && !scn && !node && !dim && !member && h('p', { class: 'insight-para muted', text: entityLabel(issue) }),
      ),
      h('div', { class: 'insight-actions' },
        btn(t('quality.fix'), { kind: 'primary', size: 'sm', icon: 'arrowRight', on: { click: () => jump(issue) } }),
        m && btn(t('quality.openInMaster'), { size: 'sm', icon: 'layers', on: { click: () => ctx.router.navigate('metrics', { selected: m.id }) } }),
        m && scn && btn(t('quality.openInBindings'), { size: 'sm', icon: 'link', on: { click: () => ctx.router.navigate('bindings', { selected: m.id, scenario: scn.code }) } }),
      ),
    );
    insights.setContent(content);
  }

  // ---------------------------------------------------------------- refresh
  function refresh() {
    const all = ctx.validation.index.issues;
    const q = normalizeText(state.query);
    const f = state.filters;
    state.items = all
      .filter((i) => (!f.severity || i.severity === f.severity)
        && (!f.entity || i.entity.type === f.entity)
        && (!f.rule || i.code === f.rule)
        && (!f.scenario || i.scenarioId === f.scenario)
        && (!q || normalizeText(`${ctx.describeIssue(i)} ${entityLabel(i)} ${i.code}`).includes(q)))
      .sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.code.localeCompare(b.code) || entityLabel(a).localeCompare(entityLabel(b)));
    list.setItems(state.items);
    countLabel.textContent = state.items.length === all.length ? t('quality.issues', { n: formatNumber(all.length) }) : t('quality.issuesFiltered', { n: formatNumber(state.items.length), total: formatNumber(all.length) });
    if (state.selectedId && !state.items.some((i) => i.id === state.selectedId)) state.selectedId = null;
    list.setSelected(state.selectedId);
    renderInsights();
  }

  const layout = workspaceLayout({ header: header.el, main, insights: insights.el, className: 'quality-ws' });
  layout.el.insertBefore(kpis, layout.body);
  layout.el.insertBefore(filters.el, layout.body);
  container.appendChild(layout.el);

  const offValidation = ctx.validation.onChange(() => { refresh(); renderKpis(); });
  refresh();
  renderKpis();

  return {
    update(route) {
      const p = route.params;
      const wanted = readFilters(p, FILTER_SPEC);
      if (wanted.severity && !SEVERITIES.includes(wanted.severity)) wanted.severity = '';
      if (filtersDiffer(state.filters, wanted, FILTER_SPEC)) filters.setMany(wanted);
      if ((p.q || '') !== state.query) filters.setSearch(p.q || '');
      if (p.issue && p.issue !== state.selectedId) reveal(p.issue);
    },
    onShow() { list.refresh(); },
    onHide() {},
    onShortcut(e) {
      if (e.key === '/') { e.preventDefault(); filters.searchInput.focus(); filters.searchInput.select(); }
    },
    onDrawerClosed() {},
    onMetricOpened() {},
    destroy() { offValidation(); list.destroy(); layout.el.remove(); },
  };
}
