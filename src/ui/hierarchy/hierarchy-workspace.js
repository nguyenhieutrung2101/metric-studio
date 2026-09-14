import { h, btn, icon } from '../dom.js';
import { t } from '../i18n.js';
import { Tree } from '../tree/tree.js';

/**
 * A hierarchy pane with the same grammar everywhere a tree is edited:
 * the Structure workspace and the Dimensions workspace.
 *
 *   ┌ title · expand all · collapse all · actions ┐
 *   │ tree rows: same indentation guides, same   │
 *   │ drag indicators, same selected state, same │
 *   │ … menu, same keyboard navigation           │
 *   └────────────────────────────────────────────┘
 *
 * Consistency is the point: a person who learned to reorganise the metric
 * structure already knows how to reorganise dimension members.
 *
 * hierarchyWorkspace({ title, getRoots, renderLabel, onSelect, onContextMenu, dnd, actions, expanded, allIds })
 *   → { el, tree, render(), select(id), reveal(id), expandAll(), collapseAll(), setTitle(text), setEmptyText(text) }
 */
export function hierarchyWorkspace({ title, getRoots, renderLabel, onSelect, onContextMenu = null, dnd = null, actions = [], expanded = new Set(), onToggle = null, allIds = null, emptyText = '' }) {
  const titleEl = h('span', { class: 'pane-title', text: title });
  const scroll = h('div', { class: 'tree-scroll hierarchy-scroll' });
  const emptyLabel = h('p', { text: emptyText });
  const empty = h('div', { class: 'empty small', hidden: true }, icon('folder', { size: 24 }), emptyLabel);
  const expandBtn = btn('', { icon: 'chevronDown', size: 'sm', className: 'btn-ghost', title: t('hierarchy.expandAll'), on: { click: () => expandAll() } });
  const collapseBtn = btn('', { icon: 'chevronRight', size: 'sm', className: 'btn-ghost', title: t('hierarchy.collapseAll'), on: { click: () => collapseAll() } });
  const head = h('div', { class: 'pane-head' }, titleEl, h('div', { class: 'pane-actions' }, expandBtn, collapseBtn, ...actions));
  const el = h('section', { class: 'pane hierarchy-pane' }, head, scroll, empty);

  const tree = new Tree(scroll, {
    expanded,
    getRoots,
    renderLabel,
    onSelect,
    onToggle,
    onContextMenu,
    dnd,
  });

  function collect(entries, out) {
    for (const e of entries) {
      if (e.children && e.children.length) {
        out.push(e.node.id);
        collect(e.children, out);
      }
    }
    return out;
  }

  function render() {
    const roots = getRoots();
    empty.hidden = roots.length > 0;
    tree.render();
  }

  function expandAll() {
    for (const id of collect(getRoots(), [])) expanded.add(id);
    if (onToggle) onToggle(null, true);
    render();
  }

  function collapseAll() {
    expanded.clear();
    if (onToggle) onToggle(null, false);
    render();
  }

  return {
    el,
    tree,
    expanded,
    render,
    expandAll,
    collapseAll,
    select: (id, opts) => tree.select(id, opts),
    reveal: (id) => tree.reveal(id),
    setTitle: (text) => { titleEl.textContent = text; },
    setEmptyText: (text) => { emptyLabel.textContent = text; },
  };
}
