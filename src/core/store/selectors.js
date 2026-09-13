import { normalizeText, referenceKey, compareText } from '../../utils/text.js';

const EMPTY_SET = new Set();
const EMPTY_ARRAY = Object.freeze([]);
const EMPTY_MAP = new Map();

/**
 * Read models over the store. Every selector is memoised on the revision of
 * the collections it reads, so repeated calls between changes are O(1) and a
 * change rebuilds only the affected index (O(n), trivial at 5k metrics).
 */
export function createSelectors(store) {
  const memo = new Map();

  function cached(name, collections, compute) {
    const rev = store.revisionOf(collections);
    const hit = memo.get(name);
    if (hit && hit.rev === rev) return hit.value;
    const value = compute();
    memo.set(name, { rev, value });
    return value;
  }

  // ---------------------------------------------------------------- scenarios / units
  const scenarios = () =>
    cached('scenarios', ['scenarios'], () =>
      [...store.list('scenarios')].sort((a, b) => a.sortOrder - b.sortOrder || compareText(a.code, b.code)),
    );

  const scenarioByCode = (code) => {
    const key = String(code || '').toUpperCase();
    const map = cached('scenarioByCode', ['scenarios'], () => new Map(store.list('scenarios').map((s) => [s.code.toUpperCase(), s])));
    return map.get(key) || null;
  };

  const units = () => cached('units', ['units'], () => [...store.list('units')].sort((a, b) => compareText(a.code, b.code)));

  // ---------------------------------------------------------------- metrics
  const metricsSorted = () =>
    cached('metricsSorted', ['metrics'], () =>
      [...store.list('metrics')].sort((a, b) => compareText(a.code, b.code) || compareText(a.name, b.name)),
    );

  const metricsByCode = () =>
    cached('metricsByCode', ['metrics'], () => {
      const map = new Map();
      for (const m of store.list('metrics')) {
        const key = referenceKey(m.code);
        if (!key) continue;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(m.id);
      }
      return map;
    });

  // ---------------------------------------------------------------- structure
  function buildTree(records) {
    const byId = new Map();
    for (const n of records) byId.set(n.id, { node: n, children: [], depth: 0, path: [] });
    const roots = [];
    for (const entry of byId.values()) {
      const parent = entry.node.parentId ? byId.get(entry.node.parentId) : null;
      if (parent && parent !== entry) parent.children.push(entry);
      else roots.push(entry);
    }
    const sortFn = (a, b) => a.node.sortOrder - b.node.sortOrder || compareText(a.node.name, b.node.name);
    let depth = 0;
    const seen = new Set();
    const visit = (entry, d, path) => {
      if (seen.has(entry.node.id)) return; // defensive against parent cycles
      seen.add(entry.node.id);
      entry.depth = d;
      entry.path = [...path, entry.node.id];
      depth = Math.max(depth, d + 1);
      entry.children.sort(sortFn);
      for (const child of entry.children) visit(child, d + 1, entry.path);
    };
    roots.sort(sortFn);
    for (const r of roots) visit(r, 0, []);
    // Nodes caught in a parent cycle never got visited: surface them as roots.
    for (const entry of byId.values()) {
      if (!seen.has(entry.node.id)) {
        entry.orphanCycle = true;
        roots.push(entry);
        visit(entry, 0, []);
      }
    }
    return { roots, byId, depth };
  }

  const structureTree = () => cached('structureTree', ['structureNodes'], () => buildTree(store.list('structureNodes')));

  const placementIndex = () =>
    cached('placementIndex', ['metricStructures'], () => {
      const byNode = new Map();
      const byMetric = new Map();
      for (const ms of store.list('metricStructures')) {
        if (!byNode.has(ms.structureNodeId)) byNode.set(ms.structureNodeId, new Set());
        byNode.get(ms.structureNodeId).add(ms.metricId);
        if (!byMetric.has(ms.metricId)) byMetric.set(ms.metricId, []);
        byMetric.get(ms.metricId).push(ms);
      }
      return { byNode, byMetric };
    });

  const metricIdsInNode = (nodeId) => placementIndex().byNode.get(nodeId) || EMPTY_SET;
  const placementsByMetric = (metricId) => placementIndex().byMetric.get(metricId) || EMPTY_ARRAY;

  /** Deduplicated set of metric ids in a node and all its descendants. */
  const subtreeIndex = () =>
    cached('subtreeIndex', ['structureNodes', 'metricStructures', 'metrics'], () => {
      const { roots, byId } = structureTree();
      const { byNode } = placementIndex();
      const result = new Map();
      // `children` is built from parentId links, which concurrent edits can
      // make cyclic. Every traversal carries a guard: a broken hierarchy must
      // surface as a validation error, never as a stack overflow.
      const walk = (entry, path) => {
        if (result.has(entry.node.id)) return result.get(entry.node.id);
        if (path.has(entry.node.id)) return EMPTY_SET;
        path.add(entry.node.id);
        const set = new Set();
        for (const id of byNode.get(entry.node.id) || []) if (store.has('metrics', id)) set.add(id);
        for (const child of entry.children) for (const id of walk(child, path)) set.add(id);
        path.delete(entry.node.id);
        result.set(entry.node.id, set);
        return set;
      };
      for (const r of roots) walk(r, new Set());
      // Nodes trapped in a cycle are never reached from a root.
      for (const entry of byId.values()) if (!result.has(entry.node.id)) walk(entry, new Set());
      return result;
    });

  const metricIdsUnderNode = (nodeId) => subtreeIndex().get(nodeId) || EMPTY_SET;

  const nodeCounts = (nodeId) => {
    let direct = 0;
    for (const id of metricIdsInNode(nodeId)) if (store.has('metrics', id)) direct += 1;
    return { direct, total: metricIdsUnderNode(nodeId).size };
  };

  const unplacedMetricIds = () =>
    cached('unplaced', ['metrics', 'metricStructures', 'structureNodes'], () => {
      const { byMetric } = placementIndex();
      const set = new Set();
      for (const m of store.list('metrics')) {
        const links = byMetric.get(m.id);
        const valid = links && links.some((l) => store.has('structureNodes', l.structureNodeId));
        if (!valid) set.add(m.id);
      }
      return set;
    });

  const nodePath = (nodeId) => {
    const entry = structureTree().byId.get(nodeId);
    if (!entry) return [];
    return entry.path.map((id) => store.get('structureNodes', id)).filter(Boolean);
  };

  const nodePathLabel = (nodeId, sep = ' / ') => nodePath(nodeId).map((n) => n.name).join(sep);

  // ---------------------------------------------------------------- bindings
  const bindingIndex = () =>
    cached('bindingIndex', ['bindings'], () => {
      const byMetric = new Map();
      for (const b of store.list('bindings')) {
        if (!byMetric.has(b.metricId)) byMetric.set(b.metricId, new Map());
        byMetric.get(b.metricId).set(b.scenarioId, b);
      }
      return byMetric;
    });

  const bindingsByMetric = (metricId) => bindingIndex().get(metricId) || EMPTY_MAP;
  const bindingFor = (metricId, scenarioId) => bindingsByMetric(metricId).get(scenarioId) || null;

  /** { [scenarioId]: 'source'|'formula'|'assumption'|null } — type 'none' counts as unbound. */
  const coverageOf = (metricId) => {
    const out = {};
    for (const s of scenarios()) {
      const b = bindingFor(metricId, s.id);
      out[s.id] = b && b.type !== 'none' ? b.type : null;
    }
    return out;
  };

  /** 'none' | 'both' | '<code>-only' (e.g. 'tt-only'). */
  const coverageClass = (metricId) => {
    const cov = coverageOf(metricId);
    const list = scenarios();
    const bound = list.filter((s) => cov[s.id]);
    if (bound.length === 0) return 'none';
    if (bound.length === list.length) return 'both';
    return `${bound[0].code.toLowerCase()}-only`;
  };

  const coverageSummary = () =>
    cached('coverageSummary', ['metrics', 'bindings', 'scenarios'], () => {
      const list = scenarios();
      const summary = { total: 0, both: 0, none: 0, perScenario: {} };
      for (const s of list) summary.perScenario[s.id] = 0;
      for (const m of store.list('metrics')) {
        summary.total += 1;
        const cov = coverageOf(m.id);
        let bound = 0;
        for (const s of list) {
          if (cov[s.id]) {
            bound += 1;
            summary.perScenario[s.id] += 1;
          }
        }
        if (bound === 0) summary.none += 1;
        else if (bound === list.length) summary.both += 1;
      }
      return summary;
    });

  // ---------------------------------------------------------------- dimensions
  const dimensionsSorted = () =>
    cached('dimensionsSorted', ['dimensions'], () =>
      [...store.list('dimensions')].sort((a, b) => a.sortOrder - b.sortOrder || compareText(a.code, b.code)),
    );

  const metricDimensionIndex = () =>
    cached('metricDimensionIndex', ['metricDimensions'], () => {
      const byMetric = new Map();
      const byDimension = new Map();
      for (const link of store.list('metricDimensions')) {
        if (!byMetric.has(link.metricId)) byMetric.set(link.metricId, []);
        byMetric.get(link.metricId).push(link);
        if (!byDimension.has(link.dimensionId)) byDimension.set(link.dimensionId, []);
        byDimension.get(link.dimensionId).push(link);
      }
      return { byMetric, byDimension };
    });

  const metricDimensions = (metricId) => metricDimensionIndex().byMetric.get(metricId) || EMPTY_ARRAY;
  const linksByDimension = (dimensionId) => metricDimensionIndex().byDimension.get(dimensionId) || EMPTY_ARRAY;

  const memberIndex = () =>
    cached('memberIndex', ['dimensionMembers'], () => {
      const byDimension = new Map();
      for (const m of store.list('dimensionMembers')) {
        if (!byDimension.has(m.dimensionId)) byDimension.set(m.dimensionId, []);
        byDimension.get(m.dimensionId).push(m);
      }
      return byDimension;
    });

  const membersByDimension = (dimensionId) => memberIndex().get(dimensionId) || EMPTY_ARRAY;

  /** Member hierarchy of one dimension: { roots, byId, depth }. */
  const memberTree = (dimensionId) => {
    const trees = cached('memberTrees', ['dimensionMembers'], () => new Map());
    if (!trees.has(dimensionId)) trees.set(dimensionId, buildTree(membersByDimension(dimensionId)));
    return trees.get(dimensionId);
  };

  // ---------------------------------------------------------------- search & references
  const searchIndex = () =>
    cached('searchIndex', ['metrics', 'units'], () => {
      const rows = [];
      for (const m of store.list('metrics')) {
        const unit = m.unitId ? store.get('units', m.unitId) : null;
        rows.push({
          id: m.id,
          text: normalizeText([m.code, m.name, ...(m.aliases || []), m.definition, unit ? unit.code : ''].join(' ; ')),
        });
      }
      return rows;
    });

  /** Set of matching metric ids for a free-text query, or null when the query is empty. */
  const searchMetrics = (query) => {
    const terms = normalizeText(query).split(' ').filter(Boolean);
    if (terms.length === 0) return null;
    const out = new Set();
    for (const row of searchIndex()) {
      let ok = true;
      for (const t of terms) {
        if (!row.text.includes(t)) {
          ok = false;
          break;
        }
      }
      if (ok) out.add(row.id);
    }
    return out;
  };

  const referenceLookup = () =>
    cached('referenceLookup', ['metrics'], () => {
      const byCode = new Map();
      const byAlias = new Map();
      const byName = new Map();
      const push = (map, key, id) => {
        if (!key) return;
        if (!map.has(key)) map.set(key, []);
        const arr = map.get(key);
        if (!arr.includes(id)) arr.push(id);
      };
      for (const m of store.list('metrics')) {
        push(byCode, referenceKey(m.code), m.id);
        for (const a of m.aliases || []) push(byAlias, referenceKey(a), m.id);
        push(byName, referenceKey(m.name), m.id);
      }
      return { byCode, byAlias, byName };
    });

  /**
   * Resolve a formula reference token to a metric.
   * Priority: code → alias → exact name. Several hits at the winning level = ambiguous.
   */
  const resolveReference = (token) => {
    const key = referenceKey(token);
    if (!key) return { status: 'missing', metricId: null, candidates: [] };
    const { byCode, byAlias, byName } = referenceLookup();
    for (const map of [byCode, byAlias, byName]) {
      const ids = map.get(key);
      if (ids && ids.length === 1) return { status: 'resolved', metricId: ids[0], candidates: ids };
      if (ids && ids.length > 1) return { status: 'ambiguous', metricId: null, candidates: ids };
    }
    return { status: 'missing', metricId: null, candidates: [] };
  };

  /** Ranked metric suggestions for a partial reference / search string. */
  const suggestMetrics = (query, limit = 8, exclude = null) => {
    const q = normalizeText(query);
    if (!q) return metricsSorted().filter((m) => !exclude || !exclude.has(m.id)).slice(0, limit);
    const scored = [];
    for (const m of store.list('metrics')) {
      if (exclude && exclude.has(m.id)) continue;
      const code = normalizeText(m.code);
      const name = normalizeText(m.name);
      let score = 0;
      if (code === q || name === q) score = 100;
      else if (code.startsWith(q)) score = 80;
      else if (name.startsWith(q)) score = 70;
      else if ((m.aliases || []).some((a) => normalizeText(a).startsWith(q))) score = 60;
      else if (name.includes(q) || code.includes(q)) score = 40;
      else if ((m.aliases || []).some((a) => normalizeText(a).includes(q))) score = 30;
      else if (normalizeText(m.definition).includes(q)) score = 10;
      if (score > 0) scored.push({ metric: m, score });
    }
    scored.sort((a, b) => b.score - a.score || compareText(a.metric.name, b.metric.name));
    return scored.slice(0, limit).map((s) => s.metric);
  };

  /** Bindings whose formulas reference the given metric (by cached resolution). */
  const referencingBindings = (metricId) => {
    const map = cached('referencingIndex', ['bindings'], () => {
      const out = new Map();
      for (const b of store.list('bindings')) {
        for (const r of b.parsedReferences || []) {
          if (!r.metricId) continue;
          if (!out.has(r.metricId)) out.set(r.metricId, []);
          if (!out.get(r.metricId).includes(b)) out.get(r.metricId).push(b);
        }
      }
      return out;
    });
    return map.get(metricId) || EMPTY_ARRAY;
  };

  return {
    scenarios,
    scenarioByCode,
    units,
    metricsSorted,
    metricsByCode,
    structureTree,
    metricIdsInNode,
    metricIdsUnderNode,
    placementsByMetric,
    nodeCounts,
    unplacedMetricIds,
    nodePath,
    nodePathLabel,
    bindingsByMetric,
    bindingFor,
    coverageOf,
    coverageClass,
    coverageSummary,
    dimensionsSorted,
    metricDimensions,
    linksByDimension,
    membersByDimension,
    memberTree,
    searchMetrics,
    resolveReference,
    suggestMetrics,
    referencingBindings,
  };
}
