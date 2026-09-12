import { nodeKey, splitNodeKey, BindingType } from '../core/models/binding.js';

/**
 * DependencyService
 *
 * Builds and caches the dependency graph from Formula bindings. Nodes are
 * Metric × Scenario (`metricId|scenarioId`); an edge goes from the formula's
 * node to each referenced node. Edges carry the target scenario so that
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
      const seen = new Set();
      for (const ref of b.parsedReferences || []) {
        let targetScenarioId = b.scenarioId;
        let scenarioResolved = true;
        if (ref.scenarioCode) {
          const s = selectors.scenarioByCode(ref.scenarioCode);
          if (s) targetScenarioId = s.id;
          else scenarioResolved = false;
        } else if (ref.scenarioId && store.has('scenarios', ref.scenarioId)) {
          targetScenarioId = ref.scenarioId;
        }

        // Prefer the id cached at save time; fall back to re-resolving the token.
        let targetMetricId = ref.metricId && store.has('metrics', ref.metricId) ? ref.metricId : null;
        if (!targetMetricId) {
          const r = selectors.resolveReference(ref.token);
          if (r.status === 'resolved') targetMetricId = r.metricId;
        }

        const to = targetMetricId ? nodeKey(targetMetricId, targetScenarioId) : `missing:${ref.token}|${targetScenarioId}`;
        if (seen.has(to)) continue;
        seen.add(to);
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
          dimensionContext: ref.dimensionContext || null,
          isCrossScenario: targetScenarioId !== b.scenarioId,
          resolved: !!targetMetricId && scenarioResolved,
          scenarioResolved,
        };
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
      return { key, metricId: null, scenarioId, metric: null, scenario: this.store.get('scenarios', scenarioId), binding: null, type: 'missing', missing: true, token };
    }
    const { metricId, scenarioId } = splitNodeKey(key);
    const metric = this.store.get('metrics', metricId);
    const scenario = this.store.get('scenarios', scenarioId);
    const binding = this.selectors.bindingFor(metricId, scenarioId);
    return { key, metricId, scenarioId, metric, scenario, binding, type: binding ? binding.type : BindingType.NONE, missing: !metric };
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
   */
  subgraph({ metricId, scenarioId, mode = 'same', depthDown = 3, depthUp = 1, expanded = new Set(), collapsed = new Set() }) {
    const root = nodeKey(metricId, scenarioId);
    const nodes = new Map();
    const edges = new Map();

    const addNode = (key, depth) => {
      if (nodes.has(key)) {
        const n = nodes.get(key);
        if (Math.abs(depth) < Math.abs(n.depth)) n.depth = depth;
        return n;
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
        edges.set(e.id, e);
        addNode(e.to, depth + 1);
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
        edges.set(e.id, e);
        addNode(e.from, -(depth + 1));
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

    return { root, nodes, edges: [...edges.values()] };
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

    for (const start of keys) {
      if (index.has(start)) continue;
      const work = [[start, 0]];
      while (work.length) {
        const frame = work[work.length - 1];
        const v = frame[0];
        if (frame[1] === 0) {
          index.set(v, counter);
          low.set(v, counter);
          counter += 1;
          stack.push(v);
          onStack.add(v);
        }
        const succ = (outgoing.get(v) || []).filter((e) => e.resolved).map((e) => e.to);
        if (frame[1] < succ.length) {
          const w = succ[frame[1]];
          frame[1] += 1;
          if (!index.has(w)) work.push([w, 0]);
          else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
        } else {
          work.pop();
          if (work.length) {
            const parent = work[work.length - 1][0];
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
            if (comp.length > 1 || succ.includes(v)) cycles.push(comp.reverse());
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
