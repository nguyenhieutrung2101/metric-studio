import { h, svg, btn, prefersReducedMotion } from '../dom.js';
import { layoutGraph, edgePath } from './graph-layout.js';

const ZMIN = 0.25;
const ZMAX = 2.5;

/**
 * Pan / zoom canvas with HTML nodes and SVG edges. Feels like Org Builder:
 * grab to pan, wheel to zoom around the cursor with a short ease, fit button.
 *
 * new GraphView(container, { renderNode(node) → HTMLElement, onSelect(key), onExpand(key, dir), onCollapse(key), onRoot(key) })
 * view.setGraph({ nodes: Map, edges: [] })   view.highlight({ up: Set, down: Set, selected })   view.fit()
 */
export class GraphView {
  constructor(container, opts) {
    this.opts = opts;
    this.zoom = 1;
    this.tx = 0;
    this.ty = 0;
    this.layout = null;
    this.nodeEls = new Map();
    this.edgeEls = new Map();
    this._anim = null;
    this.svg = svg('svg', { class: 'graph-edges' });
    this.defs = svg('defs', null,
      svg('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: 'arrow-head' })),
      svg('marker', { id: 'arrow-cross', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: 'arrow-head cross' })),
    );
    this.svg.appendChild(this.defs);
    this.nodesLayer = h('div', { class: 'graph-nodes' });
    this.world = h('div', { class: 'graph-world' }, this.svg, this.nodesLayer);
    this.viewport = h('div', { class: 'graph-viewport', tabindex: '0' }, this.world);
    this.zoomLabel = h('span', { class: 'graph-zoom-label', text: '100%' });
    this.controls = h('div', { class: 'graph-controls' },
      btn('', { icon: 'zoomOut', title: 'Zoom out', on: { click: () => this.zoomBy(1 / 1.25) } }),
      this.zoomLabel,
      btn('', { icon: 'zoomIn', title: 'Zoom in', on: { click: () => this.zoomBy(1.25) } }),
      btn('', { icon: 'fit', title: 'Fit', on: { click: () => this.fit() } }),
    );
    this.el = h('div', { class: 'graph' }, this.viewport, this.controls);
    container.appendChild(this.el);
    this._wirePan();
    this._wireZoom();
    this._ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this._applyTransform()) : null;
    if (this._ro) this._ro.observe(this.viewport);
  }

  // ------------------------------------------------------------ rendering
  setGraph(graph, { keepView = false } = {}) {
    this.graph = graph;
    const nodes = [...graph.nodes.values()].map((n) => ({ key: n.key, depth: n.depth }));
    this.layout = layoutGraph(nodes, graph.edges);
    const { positions, nodeWidth, nodeHeight, width, height } = this.layout;
    this.world.style.width = `${width}px`;
    this.world.style.height = `${height}px`;
    this.svg.setAttribute('width', String(width));
    this.svg.setAttribute('height', String(height));
    this.svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

    // Nodes
    const nextNodes = new Map();
    const frag = document.createDocumentFragment();
    for (const node of graph.nodes.values()) {
      const pos = positions.get(node.key);
      let el = this.nodeEls.get(node.key);
      const fresh = this.opts.renderNode(node);
      if (el) el.replaceWith(fresh);
      el = fresh;
      el.classList.add('graph-node');
      el.style.width = `${nodeWidth}px`;
      el.style.height = `${nodeHeight}px`;
      el.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
      el.dataset.key = node.key;
      if (!this.nodeEls.has(node.key)) el.classList.add('enter');
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && this.opts.onSelect) this.opts.onSelect(node.key);
      });
      nextNodes.set(node.key, el);
      frag.appendChild(el);
    }
    this.nodesLayer.replaceChildren(frag);
    this.nodeEls = nextNodes;

    // Edges
    this.edgeEls = new Map();
    const edgeFrag = document.createDocumentFragment();
    for (const e of graph.edges) {
      const a = positions.get(e.from);
      const b = positions.get(e.to);
      if (!a || !b) continue;
      const path = svg('path', { class: ['graph-edge', e.isCrossScenario && 'cross', !e.resolved && 'unresolved'].filter(Boolean).join(' '), d: edgePath(a, b, nodeWidth, nodeHeight), 'marker-end': e.isCrossScenario ? 'url(#arrow-cross)' : 'url(#arrow)', 'data-from': e.from, 'data-to': e.to });
      this.edgeEls.set(e.id, path);
      edgeFrag.appendChild(path);
    }
    this.svg.replaceChildren(this.defs, edgeFrag);
    if (!keepView) this.fit();
    else this._applyTransform();
  }

  highlight({ selected = null, up = new Set(), down = new Set() } = {}) {
    const any = !!selected;
    this.el.classList.toggle('has-focus', any);
    for (const [key, el] of this.nodeEls) {
      el.classList.toggle('selected', key === selected);
      el.classList.toggle('hl-up', up.has(key));
      el.classList.toggle('hl-down', down.has(key));
      el.classList.toggle('dim', any && key !== selected && !up.has(key) && !down.has(key));
    }
    for (const [, path] of this.edgeEls) {
      const f = path.dataset.from;
      const to = path.dataset.to;
      const lit = any && ((f === selected || up.has(f) || down.has(f)) && (to === selected || up.has(to) || down.has(to)));
      path.classList.toggle('lit', lit);
      path.classList.toggle('dim', any && !lit);
    }
  }

  // ------------------------------------------------------------ view transform
  _applyTransform() {
    this.world.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.zoom})`;
    this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
  }

  fit() {
    if (!this.layout) return;
    const vw = this.viewport.clientWidth || 800;
    const vh = this.viewport.clientHeight || 600;
    const pad = 40;
    const z = Math.min((vw - pad * 2) / Math.max(1, this.layout.width), (vh - pad * 2) / Math.max(1, this.layout.height), 1);
    this._anim = null;
    this.zoom = Math.max(ZMIN, Math.min(ZMAX, z));
    this.tx = (vw - this.layout.width * this.zoom) / 2;
    this.ty = (vh - this.layout.height * this.zoom) / 2;
    this._applyTransform();
  }

  centerOn(key) {
    if (!this.layout) return;
    const p = this.layout.positions.get(key);
    if (!p) return;
    const vw = this.viewport.clientWidth;
    const vh = this.viewport.clientHeight;
    this.tx = vw / 2 - (p.x + this.layout.nodeWidth / 2) * this.zoom;
    this.ty = vh / 2 - (p.y + this.layout.nodeHeight / 2) * this.zoom;
    this._applyTransform();
  }

  zoomBy(factor, ax = null, ay = null) {
    const vw = this.viewport.clientWidth;
    const vh = this.viewport.clientHeight;
    this._animateZoomTo(this.zoom * factor, ax == null ? vw / 2 : ax, ay == null ? vh / 2 : ay);
  }

  _animateZoomTo(target, ax, ay) {
    target = Math.max(ZMIN, Math.min(ZMAX, target));
    const wx = (ax - this.tx) / this.zoom;
    const wy = (ay - this.ty) / this.zoom;
    if (prefersReducedMotion()) {
      this.zoom = target;
      this.tx = ax - wx * this.zoom;
      this.ty = ay - wy * this.zoom;
      this._applyTransform();
      return;
    }
    const running = !!this._anim;
    this._anim = { target, ax, ay, wx, wy };
    if (!running) requestAnimationFrame(() => this._zoomStep());
  }

  _zoomStep() {
    const a = this._anim;
    if (!a) return;
    const d = a.target - this.zoom;
    const done = Math.abs(d) < 0.0015;
    this.zoom = done ? a.target : this.zoom + d * 0.3;
    this.tx = a.ax - a.wx * this.zoom;
    this.ty = a.ay - a.wy * this.zoom;
    this._applyTransform();
    if (done) {
      this._anim = null;
      return;
    }
    requestAnimationFrame(() => this._zoomStep());
  }

  _wireZoom() {
    this.viewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = this.viewport.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
      const base = this._anim ? this._anim.target : this.zoom;
      this._animateZoomTo(base * factor, e.clientX - rect.left, e.clientY - rect.top);
    }, { passive: false });
  }

  _wirePan() {
    let dragging = false;
    let captured = false;
    let sx = 0;
    let sy = 0;
    let ox = 0;
    let oy = 0;
    let moved = false;
    let downNode = null;
    let lastTap = { key: null, at: 0 };
    this.viewport.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.graph-node button')) return;
      dragging = true;
      captured = false;
      moved = false;
      downNode = e.target.closest('.graph-node');
      sx = e.clientX;
      sy = e.clientY;
      ox = this.tx;
      oy = this.ty;
    });
    this.viewport.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) > 3) {
        moved = true;
        // Capture only once a real pan starts so plain clicks still reach the nodes.
        try {
          this.viewport.setPointerCapture(e.pointerId);
          captured = true;
        } catch { /* ignore */ }
        this.viewport.classList.add('panning');
      }
      if (!moved) return;
      this.tx = ox + dx;
      this.ty = oy + dy;
      this._applyTransform();
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      this.viewport.classList.remove('panning');
      if (captured) {
        try {
          this.viewport.releasePointerCapture(e.pointerId);
        } catch { /* ignore */ }
      }
      if (moved) return;
      const key = downNode ? downNode.dataset.key : null;
      if (key) {
        const now = Date.now();
        if (lastTap.key === key && now - lastTap.at < 350) {
          lastTap = { key: null, at: 0 };
          const node = this.graph && this.graph.nodes.get(key);
          if (this.opts.onRoot && node && !node.missing) this.opts.onRoot(key);
          return;
        }
        lastTap = { key, at: now };
        if (this.opts.onSelect) this.opts.onSelect(key);
      } else if (this.opts.onSelect) this.opts.onSelect(null);
    };
    this.viewport.addEventListener('pointerup', end);
    this.viewport.addEventListener('pointercancel', end);
    this.viewport.addEventListener('keydown', (e) => {
      const step = 40;
      if (e.key === 'ArrowLeft') this.tx += step;
      else if (e.key === 'ArrowRight') this.tx -= step;
      else if (e.key === 'ArrowUp') this.ty += step;
      else if (e.key === 'ArrowDown') this.ty -= step;
      else if (e.key === '+' || e.key === '=') this.zoomBy(1.25);
      else if (e.key === '-') this.zoomBy(1 / 1.25);
      else if (e.key === '0') this.fit();
      else return;
      e.preventDefault();
      this._applyTransform();
    });
  }

  destroy() {
    if (this._ro) this._ro.disconnect();
    this.el.remove();
  }
}
