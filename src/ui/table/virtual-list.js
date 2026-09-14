import { h } from '../dom.js';

/**
 * Windowed list: renders only the rows in view (+ overscan). Row elements are
 * reused by key so scrolling does not churn the DOM.
 *
 * new VirtualList(container, { rowHeight, renderRow(item, index, el?) → HTMLElement, keyOf(item), overscan })
 */
export class VirtualList {
  /**
   * @param {object} opts
   * @param {number|'row'|'dense'} [opts.rowHeight] a pixel height, or the name
   *   of a density token (`--row-h` / `--row-h-dense`) that is re-read when
   *   the density preference changes.
   * @param {(item) => void} [opts.onSelect] single click / arrow keys: the row
   *   becomes the selection (inspect).
   * @param {(item) => void} [opts.onActivate] double click / Enter: act on the
   *   row (open the editor).
   */
  constructor(container, { rowHeight = 40, renderRow, keyOf = (x) => x.id, overscan = 8, emptyNode = null, onSelect = null, onActivate = null }) {
    this.container = container;
    this._rowHeightSpec = rowHeight;
    this.rowHeight = resolveRowHeight(rowHeight);
    this.renderRow = renderRow;
    this.keyOf = keyOf;
    this.overscan = overscan;
    this.items = [];
    this.pool = new Map();
    this.emptyNode = emptyNode;
    this.onSelect = onSelect;
    this.onActivate = onActivate;
    this.selectedKey = null;
    this.spacer = h('div', { class: 'vlist-spacer' });
    this.rows = h('div', { class: 'vlist-rows' });
    this.viewport = h('div', { class: 'vlist', tabindex: '0' }, this.spacer, this.rows);
    container.appendChild(this.viewport);
    // Selection is wired once, by delegation, so rows the views render need
    // no handlers of their own and the contract stays the same everywhere:
    // click selects, double-click / Enter activates, arrows move.
    this.rows.addEventListener('click', (e) => {
      const row = e.target.closest('[data-key]');
      if (!row || e.target.closest('button, a, input, select')) return;
      this.select(row.dataset.key);
    });
    this.rows.addEventListener('dblclick', (e) => {
      const row = e.target.closest('[data-key]');
      if (!row || e.target.closest('button, a, input, select')) return;
      this.activate(row.dataset.key);
    });
    this.viewport.addEventListener('keydown', (e) => this._onKey(e));
    this._onDensity = () => {
      if (typeof this._rowHeightSpec !== 'string') return;
      this.rowHeight = resolveRowHeight(this._rowHeightSpec);
      this.spacer.style.height = `${this.items.length * this.rowHeight}px`;
      this.refresh();
    };
    window.addEventListener('density-change', this._onDensity);
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
      el.dataset.key = String(key);
      el.classList.toggle('selected', this.selectedKey != null && String(key) === String(this.selectedKey));
      next.set(key, el);
      frag.appendChild(el);
    }
    this.pool = next;
    this.rows.replaceChildren(frag);
    if (this.emptyNode) this.emptyNode.hidden = this.items.length > 0;
  }

  // ------------------------------------------------------------ selection
  itemOf(key) {
    if (key == null) return null;
    return this.items.find((it) => String(this.keyOf(it)) === String(key)) || null;
  }

  /** Mark a row as the selection without re-rendering; notify if asked. */
  setSelected(key, { silent = true } = {}) {
    this.selectedKey = key == null ? null : String(key);
    for (const [k, el] of this.pool) el.classList.toggle('selected', String(k) === this.selectedKey);
    if (!silent && this.onSelect) this.onSelect(this.itemOf(key));
  }

  select(key) {
    this.setSelected(key, { silent: true });
    if (this.onSelect) this.onSelect(this.itemOf(key));
  }

  activate(key) {
    const item = this.itemOf(key);
    if (item && this.onActivate) this.onActivate(item);
  }

  _onKey(e) {
    if (!this.items.length) return;
    const idx = this.selectedKey == null ? -1 : this.items.findIndex((it) => String(this.keyOf(it)) === this.selectedKey);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? Math.min(this.items.length - 1, idx + 1) : Math.max(0, idx - 1);
      this.select(this.keyOf(this.items[next]));
      this.scrollToIndex(next);
    } else if (e.key === 'Enter' && idx >= 0) {
      e.preventDefault();
      this.activate(this.selectedKey);
    } else if (e.key === 'Home') {
      e.preventDefault();
      this.select(this.keyOf(this.items[0]));
      this.scrollToIndex(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      this.select(this.keyOf(this.items[this.items.length - 1]));
      this.scrollToIndex(this.items.length - 1);
    }
  }

  destroy() {
    this.viewport.removeEventListener('scroll', this._onScroll);
    window.removeEventListener('density-change', this._onDensity);
    if (this._ro) this._ro.disconnect();
    this.viewport.remove();
  }
}

/** A number as given, or a density token read from the document. */
function resolveRowHeight(spec) {
  if (typeof spec === 'number') return spec;
  const name = spec === 'dense' ? '--row-h-dense' : '--row-h';
  const raw = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement).getPropertyValue(name) : '';
  const px = parseInt(raw, 10);
  return Number.isFinite(px) && px > 0 ? px : (spec === 'dense' ? 36 : 40);
}
