import { nodeKey, splitNodeKey, BindingType } from '../core/models/binding.js';
import { referenceKey } from '../utils/text.js';
import { parseFormula, referenceIdentity } from './formula-parser.js';

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
      // Where each reference sits in the formula: its order of appearance and
      // the operator or function it is an operand of. The edge table hands
      // these to whoever builds execution order or lineage outside the app.
      const placement = referencePlacement(b.formulaText);
      let seq = 0;
      for (const ref of b.parsedReferences || []) {
        seq += 1;
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
        const where = placement.get(referenceIdentity(ref)) || { operator: '' };
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
          sequence: seq,
          operator: where.operator,
          formulaText: b.formulaText,
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

  /**
   * One row per dependency, flat, with names and codes resolved — the edge
   * table people configure pipelines from. The graph is one picture of these
   * rows; the formula text is kept on each so nothing is lost in flattening.
   */
  edgeRows() {
    const { store } = this;
    const scenarioCode = (id) => (store.get('scenarios', id) || {}).code || (typeof id === 'string' && id.startsWith('unknown-scenario:') ? id.slice('unknown-scenario:'.length) : '?');
    const rows = [];
    for (const e of this.edges()) {
      const target = store.get('metrics', e.fromMetricId);
      const source = e.targetMetricId ? store.get('metrics', e.targetMetricId) : null;
      rows.push({
        id: e.id,
        bindingId: e.bindingId,
        targetMetricId: e.fromMetricId,
        targetCode: target ? target.code : '',
        targetName: target ? target.name : '',
        targetAliases: target ? (target.aliases || []).join(' ') : '',
        targetScenarioId: e.fromScenarioId,
        targetScenario: scenarioCode(e.fromScenarioId),
        bindingType: BindingType.FORMULA,
        sourceMetricId: e.targetMetricId,
        sourceCode: source ? source.code : e.token,
        sourceName: source ? source.name : '',
        sourceAliases: source ? (source.aliases || []).join(' ') : '',
        sourceScenarioId: e.targetScenarioId,
        sourceScenario: scenarioCode(e.targetScenarioId),
        sequence: e.sequence,
        referenceType: e.isCrossScenario ? 'cross-scenario' : 'same-scenario',
        dimensionContext: e.dimensionContexts.map((ctx) => ctx.map((p) => (p.member == null ? p.dimension : `${p.dimension}=${p.member}`)).join('; ')).join(' | '),
        operator: e.operator || '',
        resolved: e.resolved,
        token: e.token,
        formulaText: e.formulaText,
      });
    }
    rows.sort((a, b) => a.targetScenario.localeCompare(b.targetScenario) || a.targetCode.localeCompare(b.targetCode) || a.sequence - b.sequence);
    return rows;
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

    // One breadth-first walk per direction, from any seed. The root seeds
    // both; every node the user has expanded seeds both as well, because a
    // "+" on the left of a node that was reached going down asks for its
    // dependents, which a walk that only ever goes down from the root would
    // never look at. Placement is the signed column (right of the root for
    // dependencies, left for dependents); level is the distance used against
    // the depth limits.
    const walk = (dir, startKey, startPlacement, startLevel) => {
      const queue = [[startKey, startPlacement, startLevel]];
      const visited = new Set([startKey]);
      const limit = dir === 'down' ? depthDown : depthUp;
      while (queue.length) {
        const [key, placement, level] = queue.shift();
        const node = nodes.get(key);
        if (!node) continue;
        const next = dir === 'down' ? this.edgesFrom(key) : this.edgesTo(key);
        const more = dir === 'down' ? 'hasMoreDown' : 'hasMoreUp';
        if (!mayExpand(node, level, limit)) {
          if (next.length) node[more] = true;
          continue;
        }
        for (const e of next) {
          const other = dir === 'down' ? e.to : e.from;
          const otherPlacement = dir === 'down' ? placement + 1 : placement - 1;
          if (edges.size >= edgeBudget || !addNode(other, otherPlacement)) {
            node[more] = true;
            truncated = truncated || edges.size >= edgeBudget;
            continue;
          }
          addEdge(e);
          if (!visited.has(other)) {
            visited.add(other);
            queue.push([other, otherPlacement, level + 1]);
          }
        }
      }
    };

    addNode(root, 0);
    walk('down', root, 0, 0);
    walk('up', root, 0, 0);
    for (const key of expanded) {
      const node = nodes.get(key);
      if (!node || key === root) continue;
      walk('down', key, node.depth, Math.abs(node.depth));
      walk('up', key, node.depth, Math.abs(node.depth));
    }

    // Fringe flags for nodes reached but not expanded. A node that can never
    // be expanded from here — external in same-scenario mode, missing, or in
    // an unknown scenario — gets no marker: a "+" that does nothing is worse
    // than none.
    for (const node of nodes.values()) {
      if (node.missing || node.unknownScenario || node.external) {
        node.hasMoreDown = false;
        node.hasMoreUp = false;
        continue;
      }
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

/**
 * For every reference in a formula, the operator or function it is a direct
 * operand of (`*`, `+`, `SUM`…), keyed by reference identity. First
 * occurrence wins; groups are transparent.
 */
function referencePlacement(formulaText) {
  const out = new Map();
  const { ast } = parseFormula(formulaText || '');
  const walk = (node, parentOp) => {
    if (!node) return;
    switch (node.type) {
      case 'reference': {
        const key = referenceIdentity(node);
        if (!out.has(key)) out.set(key, { operator: parentOp });
        break;
      }
      case 'binary':
        walk(node.left, node.op);
        walk(node.right, node.op);
        break;
      case 'unary':
        walk(node.operand, node.op);
        break;
      case 'group':
        walk(node.expression, parentOp);
        break;
      case 'call':
        for (const a of node.args) walk(a, node.name);
        break;
      default:
        break;
    }
  };
  walk(ast, '');
  return out;
}
