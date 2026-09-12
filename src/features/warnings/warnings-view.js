import { h, btn, icon, formatNumber } from '../../ui/dom.js';
import { t } from '../../ui/i18n.js';
import { VirtualList } from '../../ui/table/virtual-list.js';
import { severityDot } from '../../ui/components/chip.js';
import { debounce } from '../../utils/debounce.js';
import { normalizeText } from '../../utils/text.js';

const SEVERITIES = ['error', 'warning', 'info'];
const ENTITY_TYPES = ['metric', 'binding', 'structure', 'dimension', 'member', 'metricDimension', 'metricStructure'];

/** Warning center — every validation issue, filterable, click to jump to the problem. */
export function mountWarningsView(container, ctx) {
  const { store } = ctx;
  const state = { severity: new Set(SEVERITIES), entity: '', query: '', items: [] };
  const summary = h('div', { class: 'summary-row' });
  const searchInput = h('input', { class: 'input search-input', type: 'search', placeholder: t('warnings.searchPlaceholder') });
  const sevToggles = h('div', { class: 'seg' }, SEVERITIES.map((s) => h('button', { type: 'button', class: ['seg-btn', `seg-${s}`, 'active'], dataset: { sev: s }, on: { click: (e) => { if (state.severity.has(s)) state.severity.delete(s); else state.severity.add(s); e.currentTarget.classList.toggle('active', state.severity.has(s)); refresh(); } } }, severityDot(s), h('span', { text: t(`severity.${s}`) }))));
  const entitySelect = h('select', { class: 'input input-sm', on: { change: (e) => { state.entity = e.target.value; refresh(); } } }, h('option', { value: '', text: t('warnings.anyEntity') }), ENTITY_TYPES.map((e) => h('option', { value: e, text: t(`entity.${e}`) })));
  const toolbar = h('div', { class: 'toolbar' }, h('div', { class: 'search' }, icon('search', { className: 'search-icon' }), searchInput), sevToggles, entitySelect, h('span', { class: 'spacer' }), btn(t('warnings.revalidate'), { size: 'sm', on: { click: () => ctx.validation.run() } }));
  const header = h('div', { class: 'table-head issue-row' }, h('span', { class: 'col-sev' }), h('span', { class: 'col-entity', text: t('warnings.entity') }), h('span', { class: 'col-msg', text: t('warnings.message') }), h('span', { class: 'col-code', text: t('warnings.rule') }));
  const empty = h('div', { class: 'empty', hidden: true }, icon('check', { size: 28 }), h('p', { text: t('warnings.empty') }));
  const listHost = h('div', { class: 'list-host' });
  const root = h('div', { class: 'view-single' }, summary, toolbar, header, listHost, empty);
  container.appendChild(root);

  const list = new VirtualList(listHost, { rowHeight: 44, keyOf: (i) => i.id, emptyNode: empty, renderRow });

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
    return h('div', { class: ['issue-row', 'row', `sev-row-${issue.severity}`], role: 'row', tabindex: '-1', on: { click: () => jump(issue) } },
      h('span', { class: 'col-sev' }, severityDot(issue.severity)),
      h('span', { class: 'col-entity' }, h('span', { class: 'tag', text: t(`entity.${issue.entity.type}`) }), h('span', { class: 'entity-label', text: entityLabel(issue) })),
      h('span', { class: 'col-msg', text: ctx.describeIssue(issue), title: ctx.describeIssue(issue) }),
      h('span', { class: 'col-code mono muted small', text: issue.code }),
    );
  }

  function jump(issue) {
    const { type, id } = issue.entity;
    if (issue.metricId && store.has('metrics', issue.metricId)) {
      const section = type === 'binding' ? 'bindings' : type === 'metricDimension' ? 'dimensions' : issue.code.includes('UNPLACED') ? 'structure' : 'definition';
      ctx.openMetric(issue.metricId, { section, scenarioId: issue.scenarioId || null });
      return;
    }
    if (type === 'structure' || issue.structureNodeId) { ctx.router.navigate('metrics', { node: issue.structureNodeId || id }); return; }
    if (type === 'dimension' || type === 'member' || issue.dimensionId) {
      const dimId = issue.dimensionId || (type === 'dimension' ? id : (store.get('dimensionMembers', id) || {}).dimensionId);
      ctx.router.navigate('dimensions', { dimension: dimId });
      return;
    }
    ctx.toast.info(t('warnings.noTarget'));
  }

  function refresh() {
    const all = ctx.validation.index.issues;
    const q = normalizeText(state.query);
    const rank = { error: 0, warning: 1, info: 2 };
    state.items = all
      .filter((i) => state.severity.has(i.severity) && (!state.entity || i.entity.type === state.entity) && (!q || normalizeText(`${ctx.describeIssue(i)} ${entityLabel(i)} ${i.code}`).includes(q)))
      .sort((a, b) => rank[a.severity] - rank[b.severity] || a.code.localeCompare(b.code) || entityLabel(a).localeCompare(entityLabel(b)));
    list.setItems(state.items);
    const by = ctx.validation.index.bySeverity;
    summary.replaceChildren(...SEVERITIES.map((s) => h('span', { class: ['stat', `stat-${s}`] }, h('span', { class: 'stat-value', text: formatNumber(by[s] || 0) }), h('span', { class: 'stat-label', text: t(`severity.${s}`) }))), h('span', { class: 'muted small', text: t('warnings.hint') }));
  }

  const onSearch = debounce(() => { state.query = searchInput.value; refresh(); }, 160);
  searchInput.addEventListener('input', onSearch);
  const offValidation = ctx.validation.onChange(() => refresh());
  refresh();
  return {
    update(route) { if (route.params.severity && SEVERITIES.includes(route.params.severity)) { state.severity = new Set([route.params.severity]); sevToggles.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.sev === route.params.severity)); refresh(); } },
    onDrawerClosed() {},
    onMetricOpened() {},
    destroy() { offValidation(); onSearch.cancel(); list.destroy(); root.remove(); },
  };
}
