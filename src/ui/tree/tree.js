import { h, icon } from '../dom.js';

/**
 * Generic hierarchical tree with expand/collapse, selection, keyboard
 * navigation and HTML5 drag & drop hooks.
 *
 * new Tree(container, {
 *   getRoots() → entries, entry = { node: { id, name }, children: [entry] }
 *   renderLabel(entry, labelEl)             // fill the label (name, counters, badges)
 *   onSelect(id), onToggle?(id, open)
 *   expanded: Set<string>, selectedId
 *   dnd: { mimeType, canDrag(entry) → bool, canDrop(payload, targetId, position) → bool, onDrop(payload, targetId, position), accepts: [mimeTypes] }
 *   onContextMenu?(entry, event)
 * })
 */
export class Tree {
  constructor(container, opts) {
    this.opts = opts;
    this.expanded = opts.expanded || new Set();
    this.selectedId = opts.selectedId || null;
    this.el = h('div', { class: 'tree', role: 'tree' });
    container.appendChild(this.el);
    this.rowsById = new Map();
    this._dragOver = null;
    this.el.addEventListener('keydown', (e) => this._onKey(e));
  }

  render() {
    const roots = this.opts.getRoots();
    this.rowsById = new Map();
    const frag = document.createDocumentFragment();
    for (const entry of roots) this._renderEntry(entry, 0, frag);
    this.el.replaceChildren(frag);
  }

  _renderEntry(entry, depth, parent) {
    const id = entry.node.id;
    const hasChildren = entry.children && entry.children.length > 0;
    const open = hasChildren && this.expanded.has(id);
    const toggle = h('button', { type: 'button', class: ['tree-toggle', !hasChildren && 'hidden'], tabindex: '-1', 'aria-label': open ? 'collapse' : 'expand', on: { click: (e) => { e.stopPropagation(); this.toggle(id); } } }, icon(open ? 'chevronDown' : 'chevronRight', { size: 14 }));
    const label = h('div', { class: 'tree-label' });
    this.opts.renderLabel(entry, label);
    const row = h('div', {
      class: ['tree-row', id === this.selectedId && 'selected'],
      role: 'treeitem',
      tabindex: id === this.selectedId ? '0' : '-1',
      'aria-expanded': hasChildren ? String(open) : undefined,
      'aria-level': String(depth + 1),
      dataset: { id },
      style: { '--depth': depth },
      on: {
        click: () => this.select(id),
        dblclick: () => { if (hasChildren) this.toggle(id); },
        contextmenu: (e) => { if (this.opts.onContextMenu) { e.preventDefault(); this.opts.onContextMenu(entry, e); } },
      },
    }, toggle, label);
    this._wireDnd(row, entry);
    this.rowsById.set(id, row);
    parent.appendChild(row);
    if (open) {
      const group = h('div', { class: 'tree-group', role: 'group' });
      for (const child of entry.children) this._renderEntry(child, depth + 1, group);
      parent.appendChild(group);
    }
  }

  _wireDnd(row, entry) {
    const dnd = this.opts.dnd;
    if (!dnd) return;
    if (dnd.canDrag && dnd.canDrag(entry)) {
      row.draggable = true;
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(dnd.mimeType, JSON.stringify({ id: entry.node.id }));
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
    }
    const accepts = dnd.accepts || [dnd.mimeType];
    const typeOf = (e) => accepts.find((tp) => e.dataTransfer.types.includes(tp));
    row.addEventListener('dragover', (e) => {
      const type = typeOf(e);
      if (!type) return;
      const rect = row.getBoundingClientRect();
      const y = (e.clientY - rect.top) / rect.height;
      const position = type !== dnd.mimeType ? 'into' : y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'into';
      if (!dnd.canDrop({ type }, entry.node.id, position)) {
        this._clearDragOver();
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      this._clearDragOver();
      row.classList.add(`drop-${position}`);
      this._dragOver = row;
    });
    row.addEventListener('dragleave', () => {
      if (this._dragOver === row) this._clearDragOver();
    });
    row.addEventListener('drop', (e) => {
      const type = typeOf(e);
      if (!type) return;
      e.preventDefault();
      const position = row.classList.contains('drop-before') ? 'before' : row.classList.contains('drop-after') ? 'after' : 'into';
      this._clearDragOver();
      let payload = null;
      try {
        payload = JSON.parse(e.dataTransfer.getData(type));
      } catch {
        return;
      }
      dnd.onDrop({ type, ...payload }, entry.node.id, position);
    });
  }

  _clearDragOver() {
    if (this._dragOver) this._dragOver.classList.remove('drop-before', 'drop-after', 'drop-into');
    this._dragOver = null;
  }

  toggle(id, force = null) {
    const open = force == null ? !this.expanded.has(id) : force;
    if (open) this.expanded.add(id);
    else this.expanded.delete(id);
    if (this.opts.onToggle) this.opts.onToggle(id, open);
    this.render();
  }

  expandPath(ids) {
    for (const id of ids) this.expanded.add(id);
  }

  select(id, { silent = false } = {}) {
    if (this.selectedId === id) {
      if (!silent && this.opts.onSelect) this.opts.onSelect(id);
      return;
    }
    const prev = this.rowsById.get(this.selectedId);
    if (prev) {
      prev.classList.remove('selected');
      prev.tabIndex = -1;
    }
    this.selectedId = id;
    const row = this.rowsById.get(id);
    if (row) {
      row.classList.add('selected');
      row.tabIndex = 0;
    }
    if (!silent && this.opts.onSelect) this.opts.onSelect(id);
  }

  reveal(id) {
    const row = this.rowsById.get(id);
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
  }

  _onKey(e) {
    const rows = [...this.el.querySelectorAll('.tree-row')];
    const idx = rows.indexOf(document.activeElement);
    if (idx === -1) return;
    const row = rows[idx];
    const id = row.dataset.id;
    if (e.key === 'ArrowDown' && rows[idx + 1]) { e.preventDefault(); rows[idx + 1].focus(); }
    else if (e.key === 'ArrowUp' && rows[idx - 1]) { e.preventDefault(); rows[idx - 1].focus(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); if (row.getAttribute('aria-expanded') === 'false') this.toggle(id, true); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); if (row.getAttribute('aria-expanded') === 'true') this.toggle(id, false); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.select(id); }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const again = this.rowsById.get(id);
      if (again) again.focus();
    }
  }
}
