import { h, btn, icon, clear, formatNumber } from '../../ui/dom.js';
import { t } from '../../ui/i18n.js';
import { openMenu } from '../../ui/components/menu.js';
import { confirmDialog, promptDialog } from '../../ui/components/confirm.js';
import { debounce } from '../../utils/debounce.js';
import { getPreference, setPreference } from '../../utils/preferences.js';
import { pageHeader } from '../../ui/workspace/page-header.js';
import { workspaceLayout } from '../../ui/workspace/workspace-layout.js';
import { createInsightsPanel, insightRow, insightSection, insightStat } from '../../ui/workspace/insights-panel.js';
import { hierarchyWorkspace } from '../../ui/hierarchy/hierarchy-workspace.js';

const MEMBER_MIME = 'application/x-metric-studio-member';

/**
 * Dimensions — the same three panes as every other workspace:
 *
 *   dimension list │ member hierarchy │ insights
 *
 * The member tree uses the hierarchy grammar from the Structure workspace,
 * so drag, … menu, expand/collapse and keyboard navigation behave the same
 * way. Selecting a dimension inspects the dimension; selecting a member
 * inspects the member. Every action lives in the inspector as well as in
 * the … menu.
 */
export function mountDimensionsView(container, ctx) {
  const { store, selectors, services } = ctx;
  const state = { dimensionId: null, memberId: null };
  const expanded = new Set(getPreference('dims.expanded', []));
  const rememberExpanded = () => setPreference('dims.expanded', [...expanded]);

  // ---------------------------------------------------------------- header
  const newBtn = btn(t('dims.new'), { kind: 'primary', size: 'sm', icon: 'plus', on: { click: () => newDimension() } });
  const meta = h('span', { class: 'muted small' });
  const header = pageHeader({ title: t('nav.dimensions'), subtitle: t('dims.subtitle'), meta, actions: [newBtn] });

  // ---------------------------------------------------------------- dimension list (side)
  const listEl = h('div', { class: 'dims-list', role: 'listbox' });
  const side = h('aside', { class: 'pane tree-pane' },
    h('div', { class: 'pane-head' }, h('span', { class: 'pane-title', text: t('dims.title') })),
    listEl,
  );

  function renderList() {
    clear(listEl);
    const dims = selectors.dimensionsSorted();
    if (!dims.length) listEl.appendChild(h('div', { class: 'empty small' }, icon('layers', { size: 24 }), h('p', { text: t('dims.empty') })));
    for (const d of dims) {
      const members = selectors.membersByDimension(d.id).length;
      const links = selectors.linksByDimension(d.id).length;
      listEl.appendChild(h('div', {
        class: ['tree-row', 'pseudo', d.id === state.dimensionId && 'selected'],
        role: 'option',
        'aria-selected': String(d.id === state.dimensionId),
        tabindex: d.id === state.dimensionId || (!state.dimensionId && d === dims[0]) ? '0' : '-1',
        dataset: { id: d.id },
        on: {
          click: () => selectDimension(d.id),
          keydown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectDimension(d.id); }
            else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const rows = [...listEl.querySelectorAll('.tree-row')];
              const next = rows[rows.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1)];
              if (next) next.focus();
            }
          },
          contextmenu: (e) => { e.preventDefault(); dimensionMenu(d, e.target); },
        },
      },
      h('span', { class: 'tree-toggle hidden' }),
      h('div', { class: 'tree-label' },
        icon('layers', { size: 14, className: 'tree-icon' }),
        h('span', { class: 'tree-name', text: d.name, title: `${d.code} · ${d.name}` }),
        h('span', { class: 'tree-code mono muted', text: d.code }),
        h('span', { class: 'tree-count', text: `${formatNumber(members)} · ${formatNumber(links)}`, title: t('dims.counts', { members, metrics: links }) }),
        h('button', { type: 'button', class: 'tree-more', title: t('common.more'), on: { click: (e) => { e.stopPropagation(); dimensionMenu(d, e.currentTarget); } } }, icon('more', { size: 14 })),
      )));
    }
  }

  // ---------------------------------------------------------------- member hierarchy (main)
  const addMemberBtn = btn(t('dims.addMember'), { size: 'sm', icon: 'plus', on: { click: () => state.dimensionId && addMember(state.dimensionId, null) } });
  const hierarchy = hierarchyWorkspace({
    title: t('dims.title'),
    emptyText: t('dims.pick'),
    expanded,
    onToggle: rememberExpanded,
    actions: [addMemberBtn],
    getRoots: () => (state.dimensionId ? selectors.memberTree(state.dimensionId).roots : []),
    renderLabel: (entry, el) => {
      const m = entry.node;
      const children = entry.children.length;
      el.append(
        h('span', { class: 'tree-name', text: m.name, title: m.code ? `${m.code} · ${m.name}` : m.name }),
        m.code && h('span', { class: 'tree-code mono muted', text: m.code }),
        h('span', { class: 'tree-level', text: `L${m.level}` }),
        h('span', { class: 'tree-count', text: children ? formatNumber(children) : '' }),
        h('button', { type: 'button', class: 'tree-more', title: t('common.more'), on: { click: (e) => { e.stopPropagation(); memberMenu(m, e.currentTarget); } } }, icon('more', { size: 14 })),
      );
    },
    onSelect: (id) => selectMember(id),
    onContextMenu: (entry, e) => memberMenu(entry.node, e.target),
    dnd: {
      mimeType: MEMBER_MIME,
      canDrag: () => true,
      canDrop: (payload, targetId, position) => position === 'into' && payload.id !== targetId,
      onDrop: async (payload, targetId) => {
        if (payload.id === targetId) return;
        try {
          await services.dimensions.moveMember(payload.id, targetId);
          expanded.add(targetId);
          rememberExpanded();
        } catch (err) { ctx.toast.error(err.message); }
      },
    },
  });

  // ---------------------------------------------------------------- insights
  const insights = createInsightsPanel({ preferenceKey: 'dimensions', title: t('insights.title'), emptyText: t('dims.pick') });
  const layout = workspaceLayout({ header: header.el, side, main: hierarchy.el, insights: insights.el, className: 'dims-ws' });
  container.appendChild(layout.el);

  function selectDimension(id, { keepMember = false } = {}) {
    const changed = id !== state.dimensionId;
    state.dimensionId = id && store.has('dimensions', id) ? id : null;
    if (!keepMember || changed) state.memberId = null;
    if (changed && state.dimensionId) for (const r of selectors.memberTree(state.dimensionId).roots) expanded.add(r.node.id);
    ctx.router.setParams({ dimension: state.dimensionId, member: state.memberId });
    renderAll();
  }

  function selectMember(id) {
    state.memberId = id && store.has('dimensionMembers', id) ? id : null;
    hierarchy.select(state.memberId, { silent: true });
    ctx.router.setParams({ member: state.memberId });
    renderInsights();
  }

  function renderHierarchy() {
    const d = state.dimensionId ? store.get('dimensions', state.dimensionId) : null;
    if (!d) {
      hierarchy.setTitle(t('dims.title'));
      hierarchy.setEmptyText(t('dims.pick'));
      addMemberBtn.disabled = true;
    } else {
      const tree = selectors.memberTree(d.id);
      hierarchy.setTitle(t('dims.members', { n: formatNumber(tree.byId.size), depth: formatNumber(tree.depth) }));
      hierarchy.setEmptyText(t('dims.noMembers'));
      addMemberBtn.disabled = false;
    }
    hierarchy.render();
    hierarchy.select(state.memberId, { silent: true });
  }

  function renderInsights() {
    const d = state.dimensionId ? store.get('dimensions', state.dimensionId) : null;
    const m = state.memberId ? store.get('dimensionMembers', state.memberId) : null;
    if (!d) { insights.setContent(null); return; }
    insights.setContent(m && m.dimensionId === d.id ? memberInsights(d, m) : dimensionInsights(d));
  }

  function dimensionInsights(d) {
    const tree = selectors.memberTree(d.id);
    const links = selectors.linksByDimension(d.id);
    const metrics = links.map((l) => ({ link: l, metric: store.get('metrics', l.metricId) })).filter((x) => x.metric).sort((a, b) => a.metric.code.localeCompare(b.metric.code));
    return h('div', { class: 'insight' },
      h('div', { class: 'insight-head' },
        h('div', { class: 'insight-title', text: d.name }),
        h('div', { class: 'insight-sub' }, h('span', { class: 'mono', text: d.code }), h('span', { class: 'tag', text: t('dims.dimension') })),
      ),
      d.description && insightSection(t('metric.field.definition'), h('p', { class: 'insight-para', text: d.description })),
      insightSection(t('structure.contents'),
        h('div', { class: 'insight-stats' },
          insightStat(formatNumber(tree.byId.size), t('dims.membersStat')),
          insightStat(formatNumber(tree.depth), t('dims.depthStat')),
          insightStat(formatNumber(metrics.length), t('dims.metricsStat')),
        ),
      ),
      insightSection(t('dims.usedByList'),
        metrics.length
          ? h('ul', { class: 'insight-list' }, metrics.slice(0, 12).map(({ link, metric }) => h('li', null,
            h('span', { class: 'mono muted', text: metric.code }),
            h('button', { type: 'button', class: 'link ellipsis', title: metric.name, on: { click: () => openMetric(metric.id) } }, metric.name),
            link.required && h('span', { class: 'tag', text: t('drawer.requiredShort') }),
            link.maxLevel && h('span', { class: 'tag', text: `L≤${link.maxLevel}` }),
          )), metrics.length > 12 && h('li', { class: 'muted', text: t('dims.andMore', { n: metrics.length - 12 }) }))
          : h('p', { class: 'insight-para muted', text: t('dims.notUsed') }),
      ),
      h('div', { class: 'insight-actions' },
        btn(t('dims.addMember'), { size: 'sm', icon: 'plus', on: { click: () => addMember(d.id, null) } }),
        btn(t('common.rename'), { size: 'sm', icon: 'edit', on: { click: () => editDimension(d) } }),
        btn(t('common.delete'), { size: 'sm', icon: 'trash', kind: 'danger-ghost', on: { click: () => deleteDimension(d) } }),
      ),
    );
  }

  function memberInsights(d, m) {
    const tree = selectors.memberTree(d.id);
    const entry = tree.byId.get(m.id);
    const children = entry ? entry.children.length : 0;
    let subtree = 0;
    const walk = (e) => { for (const c of e.children) { subtree += 1; walk(c); } };
    if (entry) walk(entry);
    const path = entry ? entry.path.map((id) => store.get('dimensionMembers', id)).filter(Boolean) : [m];
    const parent = m.parentId ? store.get('dimensionMembers', m.parentId) : null;
    return h('div', { class: 'insight' },
      h('div', { class: 'insight-head' },
        h('div', { class: 'insight-title', text: m.name }),
        h('div', { class: 'insight-sub' }, m.code && h('span', { class: 'mono', text: m.code }), h('span', { class: 'tag', text: `${t('dims.level')} ${m.level}` }), h('span', { class: 'muted', text: d.name })),
      ),
      insightSection(t('structure.path'),
        h('div', { class: 'link-path' }, path.map((n, i) => h('span', { class: ['crumb', i === path.length - 1 && 'last'], text: n.name, on: { click: () => selectMember(n.id) } }))),
      ),
      insightSection(t('dims.member'),
        insightRow(t('dims.parent'), parent ? h('button', { type: 'button', class: 'link', on: { click: () => selectMember(parent.id) } }, parent.name) : t('dims.rootMember')),
        (m.aliases || []).length ? insightRow(t('metric.field.aliases'), h('span', { class: 'mono small', text: m.aliases.join(' · ') })) : null,
        h('div', { class: 'insight-stats' },
          insightStat(formatNumber(children), t('dims.childrenStat')),
          insightStat(formatNumber(subtree), t('dims.subtreeStat')),
        ),
      ),
      h('div', { class: 'insight-actions' },
        btn(t('dims.addChild'), { size: 'sm', icon: 'plus', on: { click: () => addMember(d.id, m.id) } }),
        btn(t('common.rename'), { size: 'sm', icon: 'edit', on: { click: () => renameMember(m) } }),
        btn(t('dims.moveTo'), { size: 'sm', icon: 'arrowRight', on: { click: () => moveMemberDialog(m) } }),
        btn(t('common.delete'), { size: 'sm', icon: 'trash', kind: 'danger-ghost', on: { click: () => deleteMember(m) } }),
      ),
    );
  }

  function openMetric(id) {
    if (ctx.openMetric(id, { section: 'dimensions' })) ctx.router.setParams({ metric: id });
  }

  // ---------------------------------------------------------------- menus
  function dimensionMenu(d, anchor) {
    openMenu(anchor, [
      { label: t('dims.addMember'), icon: 'plus', onClick: () => addMember(d.id, null) },
      { label: t('common.rename'), icon: 'edit', onClick: () => editDimension(d) },
      { separator: true },
      { label: t('common.delete'), icon: 'trash', danger: true, onClick: () => deleteDimension(d) },
    ]);
  }

  function memberMenu(member, anchor) {
    openMenu(anchor, [
      { label: t('dims.addChild'), icon: 'plus', onClick: () => addMember(member.dimensionId, member.id) },
      { label: t('common.rename'), icon: 'edit', onClick: () => renameMember(member) },
      { separator: true },
      { label: t('dims.moveTo'), icon: 'arrowRight', onClick: () => moveMemberDialog(member) },
      { label: t('dims.moveToRoot'), icon: 'arrowLeft', disabled: !member.parentId, onClick: () => services.dimensions.moveMember(member.id, null).catch((e) => ctx.toast.error(e.message)) },
      { separator: true },
      { label: t('common.delete'), icon: 'trash', danger: true, onClick: () => deleteMember(member) },
    ]);
  }

  // ---------------------------------------------------------------- member editing
  async function addMember(dimensionId, parentId) {
    const parent = parentId ? store.get('dimensionMembers', parentId) : null;
    const v = await promptDialog({ title: parent ? t('dims.addChildTitle', { name: parent.name }) : t('dims.addMember'), confirmLabel: t('common.create'), fields: [{ name: 'name', label: t('metric.field.name') }, { name: 'code', label: t('metric.field.code') }] });
    if (!v || !v.name) return;
    try {
      const member = await services.dimensions.createMember({ dimensionId, parentId, name: v.name, code: v.code });
      if (parentId) expanded.add(parentId);
      rememberExpanded();
      if (dimensionId !== state.dimensionId) selectDimension(dimensionId);
      renderHierarchy();
      selectMember(member.id);
    } catch (err) { ctx.toast.error(err.message); }
  }

  async function renameMember(member) {
    const v = await promptDialog({ title: t('common.rename'), fields: [{ name: 'name', label: t('metric.field.name'), value: member.name }, { name: 'code', label: t('metric.field.code'), value: member.code }, { name: 'aliases', label: t('metric.field.aliases'), value: (member.aliases || []).join(', ') }] });
    if (!v) return;
    try { await services.dimensions.updateMember(member.id, v); } catch (err) { ctx.toast.error(err.message); }
  }

  async function moveMemberDialog(member) {
    const tree = selectors.memberTree(member.dimensionId);
    const options = [{ value: '', label: t('mm.rootLevel') }];
    const visit = (entry) => {
      if (entry.node.id === member.id || services.dimensions.isMemberDescendant(entry.node.id, member.id)) return;
      options.push({ value: entry.node.id, label: `${'  '.repeat(entry.depth)}${entry.node.name}` });
      for (const c of entry.children) visit(c);
    };
    for (const r of tree.roots) visit(r);
    const v = await promptDialog({ title: t('dims.moveMemberTitle', { name: member.name }), confirmLabel: t('common.move'), fields: [{ name: 'parentId', label: t('dims.newParent'), type: 'select', value: member.parentId || '', options }] });
    if (!v) return;
    try {
      await services.dimensions.moveMember(member.id, v.parentId || null);
      if (v.parentId) expanded.add(v.parentId);
      rememberExpanded();
      const parent = v.parentId ? store.get('dimensionMembers', v.parentId) : null;
      ctx.toast.success(t('dims.memberMoved', { name: member.name, parent: parent ? parent.name : t('mm.rootLevel') }));
    } catch (err) { ctx.toast.error(err.message); }
  }

  async function deleteMember(member) {
    const children = selectors.membersByDimension(member.dimensionId).filter((m) => m.parentId === member.id).length;
    const ok = await confirmDialog({ title: t('dims.deleteMemberTitle', { name: member.name }), message: children ? t('dims.deleteMemberChildren', { n: children }) : '', confirmLabel: t('common.delete') });
    if (!ok) return;
    try {
      await services.dimensions.deleteMember(member.id, { strategy: 'moveToParent' });
      if (state.memberId === member.id) selectMember(member.parentId || null);
    } catch (err) { ctx.toast.error(err.message); }
  }

  // ---------------------------------------------------------------- dimension editing
  async function newDimension() {
    const v = await promptDialog({ title: t('dims.new'), confirmLabel: t('common.create'), fields: [{ name: 'name', label: t('metric.field.name') }, { name: 'code', label: t('metric.field.code'), placeholder: services.dimensions.nextCode() }, { name: 'description', label: t('metric.field.definition') }] });
    if (!v || !v.name) return;
    try { const d = await services.dimensions.createDimension(v); selectDimension(d.id); } catch (err) { ctx.toast.error(err.message); }
  }

  async function editDimension(d) {
    const v = await promptDialog({ title: t('common.rename'), fields: [{ name: 'name', label: t('metric.field.name'), value: d.name }, { name: 'code', label: t('metric.field.code'), value: d.code }, { name: 'description', label: t('metric.field.definition'), value: d.description }] });
    if (!v) return;
    try { await services.dimensions.updateDimension(d.id, v); } catch (err) { ctx.toast.error(err.message); }
  }

  async function deleteDimension(d) {
    const links = selectors.linksByDimension(d.id).length;
    const ok = await confirmDialog({ title: t('dims.deleteTitle', { name: d.name }), message: t('dims.deleteMessage', { members: selectors.membersByDimension(d.id).length, metrics: links }), confirmLabel: t('common.delete') });
    if (!ok) return;
    try {
      await services.dimensions.deleteDimension(d.id);
      if (state.dimensionId === d.id) selectDimension(null);
    } catch (err) { ctx.toast.error(err.message); }
  }

  // ---------------------------------------------------------------- sync
  function renderMeta() {
    meta.textContent = t('dims.meta', { dimensions: formatNumber(store.count('dimensions')), members: formatNumber(store.count('dimensionMembers')) });
  }
  function renderAll() {
    if (state.dimensionId && !store.has('dimensions', state.dimensionId)) { state.dimensionId = null; state.memberId = null; }
    if (state.memberId && !store.has('dimensionMembers', state.memberId)) state.memberId = null;
    renderList();
    renderHierarchy();
    renderInsights();
    renderMeta();
  }
  const schedule = debounce(renderAll, 30);
  const offStore = store.events.on('change', (evt) => { if (['*', 'dimensions', 'dimensionMembers', 'metricDimensions', 'metrics'].includes(evt.collection)) schedule(); });
  renderAll();

  return {
    update(route) {
      const id = route.params.dimension;
      const memberId = route.params.member;
      if (id && store.has('dimensions', id) && id !== state.dimensionId) selectDimension(id, { keepMember: true });
      if (memberId && store.has('dimensionMembers', memberId) && memberId !== state.memberId) {
        const m = store.get('dimensionMembers', memberId);
        if (m.dimensionId !== state.dimensionId) selectDimension(m.dimensionId);
        const entry = selectors.memberTree(m.dimensionId).byId.get(memberId);
        if (entry) for (const p of entry.path.slice(0, -1)) expanded.add(p);
        renderHierarchy();
        selectMember(memberId);
        hierarchy.reveal(memberId);
      }
      const metricId = route.params.metric;
      if (metricId && store.has('metrics', metricId) && metricId !== ctx.currentMetricId) ctx.openMetric(metricId, { section: 'dimensions' });
    },
    onShow() {},
    onDrawerClosed() { ctx.router.setParams({ metric: null }); },
    onMetricOpened() {},
    destroy() { offStore(); schedule.cancel(); layout.el.remove(); },
  };
}
