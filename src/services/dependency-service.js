import { nodeKey, splitNodeKey, BindingType } from '../core/models/binding.js';
import { referenceKey } from '../utils/text.js';

const UNKNOWN_SCENARIO = 'unknown-scenario:';

/**
 * A reference such as `[XX:REVENUE]` names a scenario that does not exist.
 * It must not collapse onto the node of the scenario the formula happens to
 * live in — that would claim REVENUE|TT is a dependency when nothing says so.
 * The unresolved code therefore gets its own scenario identity, which no real
 * scenario id can collide with because real ids never contain a colon.
 */
export function unknownScenarioId(code) {
  return `${UNKNOWN_SCENARIO}${String(code || '').trim().toUpperCase()}`;
}

export function isUnknownScenarioId(id) {
  return typeof id === 'string' && id.startsWith(UNKNOWN_SCENARIO);
}

export function unknownScenarioCode(id) {
  return isUnknownScenarioId(id) ? id.slice(UNKNOWN_SCENARIO.length) : null;
}

/** Default ceiling on how many nodes one focused subgraph may materialise. */
export const SUBGRAPH_NODE_LIMIT = 300;

/**
 * And on edges. Layout cost and the number of SVG paths follow the edges,
 * not the nodes: 300 nodes that all depend on each other are 44,850 edges.
 */
export const SUBGRAPH_EDGE_LIMIT = 900;

/**
 * DependencyService
 *
 * Builds and caches the dependency graph from Formula bindings. Nodes are
 * Metric × Scenario (`metricId|scenarioId`); an edge goes from the formula's
 * node to each referenced node. Dependency is expressed between metrics, so
 * several dimensional slices of one metric form a single edge that lists
 * them in `dimensionContexts`. Edges carry the target scenario so that
 * explicit cross-scenario references ([TT:REVENUE] inside a GD formula) are
 * first-class. The index is rebuilt lazily when bindings, metrics or
 * scenarios change and never persisted — users do not maintain edges.
 */
export class DependencyService {
  constructor(store, selectors) {
    this.store = store;
    this.selectors = selectors;
    this._cache = null;
    this._cacheRev = null;
  }

  invalidate() {
    this._cache = null;
    this._cacheRev = null;
  }

  _index() {
    const rev = this.store.revisionOf(['bindings', 'metrics', 'scenarios']);
    if (this._cache && this._cacheRev === rev) return this._cache;
    this._cache = this._build();
    this._cacheRev = rev;
    return this._cache;
  }

  _build() {
    const { store, selectors } = this;
    const edges = [];
    const outgoing = new Map();
    const incoming = new Map();
    const push = (map, key, edge) => {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(edge);
    };

    for (const b of store.list('bindings')) {
      if (b.type !== BindingType.FORMULA) continue;
      if (!store.has('metrics', b.metricId) || !store.has('scenarios', b.scenarioId)) continue;
      const from = nodeKey(b.metricId, b.scenarioId);
      const byTarget = new Map();
      for (const ref of b.parsedReferences || []) {
        let targetScenarioId = b.scenarioId;
        let scenarioResolved = true;
        if (ref.scenarioCode) {
          const s = selectors.scenarioByCode(ref.scenarioCode);
          if (s) {
            targetScenarioId = s.id;
          } else {
            scenarioResolved = false;
            targetScenarioId = unknownScenarioId(ref.scenarioCode);
          }
        } else if (ref.scenarioId && store.has('scenarios', ref.scenarioId)) {
          targetScenarioId = ref.scenarioId;
        }

        // Prefer the id cached at save time; fall back to re-resolving the token.
        let targetMetricId = ref.metricId && store.has('metrics', ref.metricId) ? ref.metricId : null;
        if (!targetMetricId) {
          const r = selectors.resolveReference(ref.token);
          if (r.status === 'resolved') targetMetricId = r.metricId;
        }

        const to = targetMetricId ? nodeKey(targetMetricId, targetScenarioId) : `missing:${referenceKey(ref.token)}|${targetScenarioId}`;
        // The graph is a dependency between metrics, so two slices of the same
        // metric are one edge. The edge carries every slice that produced it
        // rather than silently keeping the first one.
        const existing = byTarget.get(to);
        if (existing) {
          if (ref.dimensionContext) existing.dimensionContexts.push(ref.dimensionContext);
          continue;
        }
        const edge = {
          id: `${from}->${to}`,
          bindingId: b.id,
          from,
          to,
          fromMetricId: b.metricId,
          fromScenarioId: b.scenarioId,
          targetMetricId,
          targetScenarioId,
          token: ref.token,
          scenarioCode: ref.scenarioCode || null,
          dimensionContexts: ref.dimensionContext ? [ref.dimensionContext] : [],
          isCrossScenario: targetScenarioId !== b.scenarioId,
          resolved: !!targetMetricId && scenarioResolved,
          scenarioResolved,
        };
        byTarget.set(to, edge);
        edges.push(edge);
        push(outgoing, from, edge);
        push(incoming, to, edge);
      }
    }

    return { edges, outgoing, incoming, cycles: null };
  }

  edges() {
    return this._index().edges;
  }

  edgesFrom(key) {
    return this._index().outgoing.get(key) || [];
  }

  edgesTo(key) {
    return this._index().incoming.get(key) || [];
  }

  /** Metrics (any scenario) that have at least one dependency edge. */
  hasEdges(metricId, scenarioId) {
    const key = nodeKey(metricId, scenarioId);
    return this.edgesFrom(key).length > 0 || this.edgesTo(key).length > 0;
  }

  nodeInfo(key) {
    if (key.startsWith('missing:')) {
      const rest = key.slice('missing:'.length);
      const i = rest.lastIndexOf('|');
      const token = rest.slice(0, i);
      const scenarioId = rest.slice(i + 1);
      const scenario = this.store.get('scenarios', scenarioId);
      return {
        key, metricId: null, scenarioId, metric: null, scenario, binding: null,
        type: 'missing', missing: true, token,
        unknownScenario: isUnknownScenarioId(scenarioId),
        scenarioCode: scenario ? scenario.code : unknownScenarioCode(scenarioId),
      };
    }
    const { metricId, scenarioId } = splitNodeKey(key);
    const metric = this.store.get('metrics', metricId);
    const scenario = this.store.get('scenarios', scenarioId);
    const unknownScenario = isUnknownScenarioId(scenarioId);
    const binding = unknownScenario ? null : this.selectors.bindingFor(metricId, scenarioId);
    return {
      key, metricId, scenarioId, metric, scenario, binding,
      type: binding ? binding.type : BindingType.NONE,
      missing: !metric,
      unknownScenario,
      scenarioCode: scenario ? scenario.code : unknownScenarioCode(scenarioId),
    };
  }

  /**
   * Focused subgraph around a root node.
   * @param {object} opts
   * @param {string} opts.metricId
   * @param {string} opts.scenarioId
   * @param {'same'|'cross'} [opts.mode='same']  in 'same' mode cross-scenario targets are shown but not expanded
   * @param {number} [opts.depthDown=3]  how many levels of dependencies (what the root uses)
   * @param {number} [opts.depthUp=1]    how many levels of dependents (what uses the root)
   * @param {Set<string>} [opts.expanded]  node keys expanded beyond the default depth
   * @param {Set<string>} [opts.collapsed] node keys whose branches are hidden
   * @param {number} [opts.maxNodes]  hard ceiling on materialised nodes; the
   *   breadth-first walk stops at the budget and the result is flagged
   *   `truncated` so the view can say so. One hub metric used by 5,000 others
   *   would otherwise lay out 5,001 cards at depth 1.
   * @param {number} [opts.maxEdges]  the same ceiling on edges, which is the
   *   one the layout and the SVG actually pay for.
   */
  subgraph({ metricId, scenarioId, mode = 'same', depthDown = 3, depthUp = 1, expanded = new Set(), collapsed = new Set(), maxNodes = SUBGRAPH_NODE_LIMIT, maxEdges = SUBGRAPH_EDGE_LIMIT }) {
    const root = nodeKey(metricId, scenarioId);
    const nodes = new Map();
    const edges = new Map();
    const budget = Math.max(1, maxNodes);
    const edgeBudget = Math.max(1, maxEdges);
    let truncated = false;
    const addEdge = (edge) => {
      if (edges.has(edge.id)) return true;
      if (edges.size >= edgeBudget) {
        truncated = true;
        return false;
      }
      edges.set(edge.id, edge);
      return true;
    };

    const addNode = (key, depth) => {
      if (nodes.has(key)) {
        const n = nodes.get(key);
        if (Math.abs(depth) < Math.abs(n.depth)) n.depth = depth;
        return n;
      }
      if (nodes.size >= budget) {
        truncated = true;
        return null;
      }
      const info = this.nodeInfo(key);
      const node = {
        ...info,
        depth,
        isRoot: key === root,
        external: mode === 'same' && info.scenarioId !== scenarioId,
        hasMoreDown: false,
        hasMoreUp: false,
        collapsed: collapsed.has(key),
      };
      nodes.set(key, node);
      return node;
    };

    const mayExpand = (node, depth, limit) => {
      if (node.missing) return false;
      if (node.unknownScenario) return false;
      if (collapsed.has(node.key)) return false;
      if (node.external) return false;
      if (expanded.has(node.key)) return true;
      return depth < limit;
    };

    // Downstream: what the root depends on.
    const queueDown = [[root, 0]];
    const visitedDown = new Set([root]);
    addNode(root, 0);
    while (queueDown.length) {
      const [key, depth] = queueDown.shift();
      const node = nodes.get(key);
      const out = this.edgesFrom(key);
      if (!mayExpand(node, depth, depthDown)) {
        if (out.length) node.hasMoreDown = true;
        continue;
      }
      for (const e of out) {
        // An edge whose endpoint the budget refused has nothing to point at,
        // so it stays out of the layout and the node keeps its fringe marker.
        if (edges.size >= edgeBudget || !addNode(e.to, depth + 1)) {
          node.hasMoreDown = true;
          truncated = truncated || edges.size >= edgeBudget;
          continue;
        }
        addEdge(e);
        if (!visitedDown.has(e.to)) {
          visitedDown.add(e.to);
          queueDown.push([e.to, depth + 1]);
        }
      }
    }

    // Upstream: what depends on the root.
    const queueUp = [[root, 0]];
    const visitedUp = new Set([root]);
    while (queueUp.length) {
      const [key, depth] = queueUp.shift();
      const node = nodes.get(key);
      const inc = this.edgesTo(key);
      if (!mayExpand(node, depth, depthUp)) {
        if (inc.length) node.hasMoreUp = true;
        continue;
      }
      for (const e of inc) {
        if (edges.size >= edgeBudget || !addNode(e.from, -(depth + 1))) {
          node.hasMoreUp = true;
          truncated = truncated || edges.size >= edgeBudget;
          continue;
        }
        addEdge(e);
        if (!visitedUp.has(e.from)) {
          visitedUp.add(e.from);
          queueUp.push([e.from, depth + 1]);
        }
      }
    }

    // Fringe flags for nodes reached but not expanded.
    for (const node of nodes.values()) {
      if (!node.hasMoreDown && this.edgesFrom(node.key).some((e) => !edges.has(e.id))) node.hasMoreDown = true;
      if (!node.hasMoreUp && this.edgesTo(node.key).some((e) => !edges.has(e.id))) node.hasMoreUp = true;
    }

    const cycleKeys = this.cycleMembers();
    for (const node of nodes.values()) node.inCycle = cycleKeys.has(node.key);

    // A node the edge budget left unconnected is not worth a card of its own.
    const connected = new Set([root]);
    for (const e of edges.values()) {
      connected.add(e.from);
      connected.add(e.to);
    }
    for (const key of [...nodes.keys()]) if (!connected.has(key)) nodes.delete(key);
    return { root, nodes, edges: [...edges.values()], truncated, nodeLimit: budget, edgeLimit: edgeBudget };
  }

  /** Keys reachable from `key` following edges in the given direction, within a subgraph edge list. */
  static reachable(key, edgeList, direction = 'down') {
    const adj = new Map();
    for (const e of edgeList) {
      const [a, b] = direction === 'down' ? [e.from, e.to] : [e.to, e.from];
      if (!adj.has(a)) adj.set(a, []);
      adj.get(a).push(b);
    }
    const seen = new Set();
    const stack = [key];
    while (stack.length) {
      const k = stack.pop();
      for (const n of adj.get(k) || []) {
        if (!seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    seen.delete(key);
    return seen;
  }

  /**
   * Cycles in the whole graph (resolved edges only), as arrays of node keys.
   * Iterative Tarjan SCC so deep chains cannot overflow the stack.
   *
   * Each frame keeps the successor list it is iterating. Recomputing it on
   * every loop pass turns one node with N dependencies into N filter+map
   * passes over N edges — 5,000 dependencies cost ~750 ms; the frame makes it
   * one pass, so the whole walk stays linear in edges.
   */
  findCycles() {
    const idx = this._index();
    if (idx.cycles) return idx.cycles;
    const outgoing = idx.outgoing;
    const keys = new Set();
    for (const e of idx.edges) {
      if (!e.resolved) continue;
      keys.add(e.from);
      keys.add(e.to);
    }
    const index = new Map();
    const low = new Map();
    const onStack = new Set();
    const stack = [];
    const cycles = [];
    let counter = 0;

    const enter = (v) => {
      index.set(v, counter);
      low.set(v, counter);
      counter += 1;
      stack.push(v);
      onStack.add(v);
      const succ = [];
      let selfLoop = false;
      for (const e of outgoing.get(v) || []) {
        if (!e.resolved) continue;
        succ.push(e.to);
        if (e.to === v) selfLoop = true;
      }
      return { v, i: 0, succ, selfLoop };
    };

    for (const start of keys) {
      if (index.has(start)) continue;
      const work = [enter(start)];
      while (work.length) {
        const frame = work[work.length - 1];
        const { v, succ } = frame;
        if (frame.i < succ.length) {
          const w = succ[frame.i];
          frame.i += 1;
          if (!index.has(w)) work.push(enter(w));
          else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
        } else {
          work.pop();
          if (work.length) {
            const parent = work[work.length - 1].v;
            low.set(parent, Math.min(low.get(parent), low.get(v)));
          }
          if (low.get(v) === index.get(v)) {
            const comp = [];
            let w;
            do {
              w = stack.pop();
              onStack.delete(w);
              comp.push(w);
            } while (w !== v);
            if (comp.length > 1 || frame.selfLoop) cycles.push(comp.reverse());
          }
        }
      }
    }
    idx.cycles = cycles;
    return cycles;
  }

  cycleMembers() {
    const idx = this._index();
    if (!idx.cycleMembers) {
      const set = new Set();
      for (const c of this.findCycles()) for (const k of c) set.add(k);
      idx.cycleMembers = set;
    }
    return idx.cycleMembers;
  }

  stats() {
    const idx = this._index();
    const nodes = new Set();
    for (const e of idx.edges) {
      nodes.add(e.from);
      if (e.resolved) nodes.add(e.to);
    }
    return { edges: idx.edges.length, nodes: nodes.size, unresolved: idx.edges.filter((e) => !e.resolved).length, crossScenario: idx.edges.filter((e) => e.isCrossScenario).length, cycles: this.findCycles().length };
  }
}
