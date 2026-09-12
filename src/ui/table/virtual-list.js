import { h } from '../dom.js';

/**
 * Windowed list: renders only the rows in view (+ overscan). Row elements are
 * reused by key so scrolling does not churn the DOM.
 *
 * new VirtualList(container, { rowHeight, renderRow(item, index, el?) → HTMLElement, keyOf(item), overscan })
 */
export class VirtualList {
  constructor(container, { rowHeight = 40, renderRow, keyOf = (x) => x.id, overscan = 8, emptyNode = null }) {
    this.container = container;
    this.rowHeight = rowHeight;
    this.renderRow = renderRow;
    this.keyOf = keyOf;
    this.overscan = overscan;
    this.items = [];
    this.pool = new Map();
    this.emptyNode = emptyNode;
    this.spacer = h('div', { class: 'vlist-spacer' });
    this.rows = h('div', { class: 'vlist-rows' });
    this.viewport = h('div', { class: 'vlist', tabindex: '0' }, this.spacer, this.rows);
    container.appendChild(this.viewport);
    this._raf = null;
    this._onScroll = () => {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => {
        this._raf = null;
        this.render();
      });
    };
    this.viewport.addEventListener('scroll', this._onScroll, { passive: true });
    this._ro = typeof ResizeObserver === 'function' ? new ResizeObserver(this._onScroll) : null;
    if (this._ro) this._ro.observe(this.viewport);
    this._lastRange = [-1, -1];
  }

  setItems(items, { keepScroll = true } = {}) {
    this.items = items;
    this.spacer.style.height = `${items.length * this.rowHeight}px`;
    if (!keepScroll) this.viewport.scrollTop = 0;
    this._lastRange = [-1, -1];
    this.render(true);
  }

  refresh() {
    this._lastRange = [-1, -1];
    this.pool.clear();
    this.render(true);
  }

  scrollToIndex(index, { block = 'nearest' } = {}) {
    if (index < 0 || index >= this.items.length) return;
    const top = index * this.rowHeight;
    const vh = this.viewport.clientHeight;
    const st = this.viewport.scrollTop;
    if (block === 'center') this.viewport.scrollTop = top - vh / 2 + this.rowHeight / 2;
    else if (top < st) this.viewport.scrollTop = top;
    else if (top + this.rowHeight > st + vh) this.viewport.scrollTop = top + this.rowHeight - vh;
  }

  render(force = false) {
    const vh = this.viewport.clientHeight || 600;
    const st = this.viewport.scrollTop;
    const start = Math.max(0, Math.floor(st / this.rowHeight) - this.overscan);
    const end = Math.min(this.items.length, Math.ceil((st + vh) / this.rowHeight) + this.overscan);
    if (!force && start === this._lastRange[0] && end === this._lastRange[1]) return;
    this._lastRange = [start, end];
    const next = new Map();
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i += 1) {
      const item = this.items[i];
      const key = this.keyOf(item);
      let el = force ? null : this.pool.get(key);
      if (!el) el = this.renderRow(item, i);
      el.style.transform = `translateY(${i * this.rowHeight}px)`;
      el.style.height = `${this.rowHeight}px`;
      el.dataset.index = String(i);
      next.set(key, el);
      frag.appendChild(el);
    }
    this.pool = next;
    this.rows.replaceChildren(frag);
    if (this.emptyNode) this.emptyNode.hidden = this.items.length > 0;
  }

  destroy() {
    this.viewport.removeEventListener('scroll', this._onScroll);
    if (this._ro) this._ro.disconnect();
    this.viewport.remove();
  }
}
