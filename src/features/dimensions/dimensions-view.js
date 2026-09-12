import { h, btn, icon, clear, formatNumber } from '../../ui/dom.js';
import { t } from '../../ui/i18n.js';
import { Tree } from '../../ui/tree/tree.js';
import { openMenu } from '../../ui/components/menu.js';
import { confirmDialog, promptDialog } from '../../ui/components/confirm.js';
import { debounce } from '../../utils/debounce.js';

const MEMBER_MIME = 'application/x-metric-studio-member';

/** Dimensions — master data: dimension list on the left, member hierarchy on the right. */
export function mountDimensionsView(container, ctx) {
  const { store, selectors, services } = ctx;
  const state = { dimensionId: null, expanded: new Set() };

  const listEl = h('div', { class: 'dim-list' });
  const left = h('aside', { class: 'pane tree-pane' }, h('div', { class: 'pane-head' }, h('span', { class: 'pane-title', text: t('dims.title') }), h('div', { class: 'pane-actions' }, btn('', { icon: 'plus', size: 'sm', title: t('dims.new'), on: { click: () => newDimension() } }))), listEl);
  const right = h('section', { class: 'pane detail-pane' });
  const root = h('div', { class: 'mm-layout' }, left, right);
  container.appendChild(root);

  function renderList() {
    clear(listEl);
    const dims = selectors.dimensionsSorted();
    if (!dims.length) listEl.appendChild(h('div', { class: 'empty small' }, h('p', { text: t('dims.empty') })));
    for (const d of dims) {
      const members = selectors.membersByDimension(d.id).length;
      const links = selectors.linksByDimension(d.id).length;
      listEl.appendChild(h('div', { class: ['tree-row', 'pseudo', d.id === state.dimensionId && 'selected'], tabindex: '0', on: { click: () => selectDimension(d.id), keydown: (e) => { if (e.key === 'Enter') selectDimension(d.id); } } },
        h('span', { class: 'tree-toggle hidden' }),
        h('div', { class: 'tree-label' }, h('span', { class: 'mono muted', text: d.code }), h('span', { class: 'tree-name', text: d.name }), h('span', { class: 'tree-count', text: `${formatNumber(members)} · ${formatNumber(links)}`, title: t('dims.counts', { members, metrics: links }) })),
      ));
    }
  }

  function selectDimension(id) {
    state.dimensionId = id;
    ctx.router.setParams({ dimension: id });
    renderList();
    renderDetail();
  }

  let tree = null;
  function renderDetail() {
    clear(right);
    tree = null;
    const d = state.dimensionId ? store.get('dimensions', state.dimensionId) : null;
    if (!d) {
      right.appendChild(h('div', { class: 'empty' }, icon('layers', { size: 28 }), h('p', { text: t('dims.pick') })));
      return;
    }
    const memberTree = selectors.memberTree(d.id);
    const links = selectors.linksByDimension(d.id);
    right.append(
      h('div', { class: 'detail-head' },
        h('div', null, h('span', { class: 'mono muted', text: d.code }), h('h2', { class: 'detail-title', text: d.name }), d.description && h('p', { class: 'muted small', text: d.description })),
        h('div', { class: 'pane-actions' },
          btn(t('common.rename'), { size: 'sm', icon: 'edit', on: { click: () => editDimension(d) } }),
          btn('', { icon: 'more', size: 'sm', on: { click: (e) => openMenu(e.currentTarget, [{ label: t('common.delete'), icon: 'trash', danger: true, onClick: () => deleteDimension(d) }]) } }),
        ),
      ),
      h('div', { class: 'detail-grid' },
        h('div', { class: 'detail-col' },
          h('div', { class: 'pane-head' }, h('span', { class: 'pane-title', text: t('dims.members', { n: memberTree.byId.size, depth: memberTree.depth }) }), h('div', { class: 'pane-actions' }, btn(t('dims.addMember'), { size: 'sm', icon: 'plus', on: { click: () => addMember(d.id, null) } }))),
          h('div', { class: 'tree-scroll member-tree', ref: (el) => { setTimeout(() => buildTree(el, d.id), 0); } }),
        ),
        h('div', { class: 'detail-col' },
          h('div', { class: 'pane-head' }, h('span', { class: 'pane-title', text: t('dims.usedBy', { n: links.length }) })),
          h('ul', { class: 'link-list scroll' }, links.length ? links.map((l) => {
            const m = store.get('metrics', l.metricId);
            if (!m) return null;
            return h('li', { class: 'link-item clickable', on: { click: () => ctx.openMetric(m.id, { section: 'dimensions' }) } }, h('span', { class: 'mono muted', text: m.code }), h('span', { class: 'link-name', text: m.name }), l.required && h('span', { class: 'tag', text: t('drawer.requiredShort') }), l.maxLevel && h('span', { class: 'tag', text: `L≤${l.maxLevel}` }));
          }) : h('li', { class: 'hint', text: t('dims.notUsed') })),
        ),
      ),
    );
  }

  function buildTree(host, dimensionId) {
    if (!host.isConnected) return;
    tree = new Tree(host, {
      expanded: state.expanded,
      getRoots: () => selectors.memberTree(dimensionId).roots,
      renderLabel: (entry, el) => {
        el.append(h('span', { class: 'mono muted', text: entry.node.code }), h('span', { class: 'tree-name', text: entry.node.name }), h('span', { class: 'tree-count', text: `L${entry.node.level}` }), h('button', { type: 'button', class: 'tree-more', on: { click: (e) => { e.stopPropagation(); memberMenu(entry.node, e.currentTarget); } } }, icon('more', { size: 14 })));
      },
      onSelect: () => {},
      onContextMenu: (entry, e) => memberMenu(entry.node, e.target),
      dnd: {
        mimeType: MEMBER_MIME,
        canDrag: () => true,
        canDrop: (payload, targetId, position) => position === 'into',
        onDrop: async (payload, targetId) => {
          if (payload.id === targetId) return;
          try { await services.dimensions.moveMember(payload.id, targetId); state.expanded.add(targetId); } catch (err) { ctx.toast.error(err.message); }
        },
      },
    });
    for (const r of selectors.memberTree(dimensionId).roots) state.expanded.add(r.node.id);
    tree.render();
  }

  function memberMenu(member, anchor) {
    openMenu(anchor, [
      { label: t('dims.addChild'), icon: 'plus', onClick: () => addMember(member.dimensionId, member.id) },
      { label: t('common.rename'), icon: 'edit', onClick: async () => {
        const v = await promptDialog({ title: t('common.rename'), fields: [{ name: 'name', label: t('metric.field.name'), value: member.name }, { name: 'code', label: t('metric.field.code'), value: member.code }, { name: 'aliases', label: t('metric.field.aliases'), value: member.aliases.join(', ') }] });
        if (!v) return;
        try { await services.dimensions.updateMember(member.id, v); } catch (err) { ctx.toast.error(err.message); }
      } },
      { label: t('dims.moveToRoot'), icon: 'arrowLeft', disabled: !member.parentId, onClick: () => services.dimensions.moveMember(member.id, null).catch((e) => ctx.toast.error(e.message)) },
      { separator: true },
      { label: t('common.delete'), icon: 'trash', danger: true, onClick: async () => {
        const children = selectors.membersByDimension(member.dimensionId).filter((m) => m.parentId === member.id).length;
        const ok = await confirmDialog({ title: t('dims.deleteMemberTitle', { name: member.name }), message: children ? t('dims.deleteMemberChildren', { n: children }) : '', confirmLabel: t('common.delete') });
        if (!ok) return;
        try { await services.dimensions.deleteMember(member.id, { strategy: 'moveToParent' }); } catch (err) { ctx.toast.error(err.message); }
      } },
    ]);
  }

  async function addMember(dimensionId, parentId) {
    const parent = parentId ? store.get('dimensionMembers', parentId) : null;
    const v = await promptDialog({ title: parent ? t('dims.addChildTitle', { name: parent.name }) : t('dims.addMember'), confirmLabel: t('common.create'), fields: [{ name: 'name', label: t('metric.field.name') }, { name: 'code', label: t('metric.field.code') }] });
    if (!v || !v.name) return;
    try {
      await services.dimensions.createMember({ dimensionId, parentId, name: v.name, code: v.code });
      if (parentId) state.expanded.add(parentId);
    } catch (err) { ctx.toast.error(err.message); }
  }

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
    try { await services.dimensions.deleteDimension(d.id); state.dimensionId = null; renderList(); renderDetail(); } catch (err) { ctx.toast.error(err.message); }
  }

  const schedule = debounce(() => { renderList(); renderDetail(); }, 30);
  const offStore = store.events.on('change', (evt) => { if (['*', 'dimensions', 'dimensionMembers', 'metricDimensions', 'metrics'].includes(evt.collection)) schedule(); });
  renderList();
  renderDetail();

  return {
    update(route) {
      const id = route.params.dimension;
      if (id && store.has('dimensions', id) && id !== state.dimensionId) { state.dimensionId = id; renderList(); renderDetail(); }
      if (route.params.metric && store.has('metrics', route.params.metric)) ctx.openMetric(route.params.metric, { section: 'dimensions' });
    },
    onDrawerClosed() { ctx.router.setParams({ metric: null }); },
    onMetricOpened() {},
    destroy() { offStore(); schedule.cancel(); root.remove(); },
  };
}
