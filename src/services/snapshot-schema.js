import { COLLECTIONS, SCHEMA_VERSION } from '../core/collections.js';
import { createMetric, MetricStatus } from '../core/models/metric.js';
import { createBinding } from '../core/models/binding.js';
import { createStructureNode, createMetricStructure } from '../core/models/structure.js';
import { createDimension, createDimensionMember, createMetricDimension } from '../core/models/dimension.js';
import { createScenario } from '../core/models/scenario.js';
import { createUnit } from '../core/models/unit.js';

export const APP_ID = 'metric-studio';

/**
 * Snapshot schema boundary.
 *
 * Everything entering the application from outside (a JSON backup, later an
 * Excel import) goes through `parseSnapshot`. It answers three questions:
 *
 *   - is this file structurally sound?          → `errors` (import is refused)
 *   - what had to be repaired to make it sound? → `repairs` (reported, applied)
 *   - what will the import actually contain?    → `data`, fully normalised
 *
 * Records come out with the exact shape the model factories produce, so no
 * view can crash on a field an imported record happened not to have. Records
 * that cannot be made sound (an orphan binding, a duplicate composite key)
 * are dropped and listed, never silently kept.
 */

/** Collections whose absence is fatal when another collection references them. */
const REFERENCED_BY = {
  metrics: ['bindings', 'metricStructures', 'metricDimensions'],
  scenarios: ['bindings'],
  structureNodes: ['metricStructures'],
  dimensions: ['dimensionMembers', 'metricDimensions'],
};

export function parseSnapshot(input) {
  const errors = [];
  const repairs = [];
  const addRepair = (code, message, count = 1) => {
    const existing = repairs.find((r) => r.code === code);
    if (existing) existing.count += count;
    else repairs.push({ code, message, count });
  };

  let raw = {};
  let present = {};
  let payload = input;
  if (typeof input === 'string') {
    try {
      payload = JSON.parse(input);
    } catch (err) {
      return fail([`Invalid JSON: ${err.message}`]);
    }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return fail(['A backup must be a JSON object']);

  const wrapped = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data);
  raw = wrapped ? payload.data : payload;
  if (wrapped && payload.app && payload.app !== APP_ID) errors.push(`Unexpected app id "${payload.app}"`);
  if (wrapped && payload.schemaVersion && payload.schemaVersion > SCHEMA_VERSION) {
    errors.push(`Schema version ${payload.schemaVersion} is newer than this app supports (${SCHEMA_VERSION})`);
  }

  // ---------------------------------------------------------------- shape
  present = {};
  const lists = {};
  for (const c of COLLECTIONS) {
    const value = raw[c];
    present[c] = value != null;
    if (value == null) {
      lists[c] = [];
      continue;
    }
    if (!Array.isArray(value)) {
      errors.push(`"${c}" must be an array`);
      lists[c] = [];
      continue;
    }
    lists[c] = value;
  }
  const unknownKeys = Object.keys(raw).filter((k) => !COLLECTIONS.includes(k) && !['app', 'schemaVersion', 'exportedAt', 'data'].includes(k));
  if (unknownKeys.length) addRepair('UNKNOWN_KEYS', `Ignored unknown top-level key(s): ${unknownKeys.join(', ')}`, unknownKeys.length);
  if (errors.length) return fail(errors);
  if (!COLLECTIONS.some((c) => lists[c].length > 0)) return fail(['The backup contains no records']);

  // A collection that is entirely absent while another one points at it would
  // turn every referencing record into an orphan. That is a truncated file,
  // not something to repair silently.
  for (const [target, sources] of Object.entries(REFERENCED_BY)) {
    if (present[target] && lists[target].length > 0) continue;
    const referencing = sources.filter((s) => lists[s].length > 0);
    if (referencing.length) {
      errors.push(`"${target}" is missing or empty while ${referencing.map((s) => `${lists[s].length} ${s}`).join(', ')} reference it`);
    }
  }
  if (errors.length) return fail(errors);

  // ---------------------------------------------------------------- per-record normalisation
  const data = {};
  const factories = {
    units: createUnit,
    scenarios: createScenario,
    metrics: createMetric,
    structureNodes: createStructureNode,
    metricStructures: createMetricStructure,
    bindings: createBinding,
    dimensions: createDimension,
    dimensionMembers: createDimensionMember,
    metricDimensions: createMetricDimension,
  };

  for (const c of COLLECTIONS) {
    const seen = new Set();
    const out = [];
    lists[c].forEach((rec, i) => {
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
        errors.push(`"${c}"[${i}] is not an object`);
        return;
      }
      if (!rec.id || typeof rec.id !== 'string') {
        errors.push(`"${c}"[${i}] has no usable id`);
        return;
      }
      if (seen.has(rec.id)) {
        errors.push(`"${c}" contains id "${rec.id}" more than once`);
        return;
      }
      seen.add(rec.id);
      const normalised = factories[c]({ ...rec });
      normalised.id = rec.id;
      if (typeof rec.createdAt === 'string') normalised.createdAt = rec.createdAt;
      if (typeof rec.updatedAt === 'string') normalised.updatedAt = rec.updatedAt;
      normalised.version = Number.isInteger(rec.version) && rec.version > 0 ? rec.version : 1;
      out.push(normalised);
    });
    data[c] = out;
  }
  if (errors.length) return fail(errors);

  // ---------------------------------------------------------------- identity
  for (const m of data.metrics) {
    if (!m.name) errors.push(`Metric "${m.code || m.id}" has no name`);
  }
  for (const s of data.scenarios) {
    if (!s.code) errors.push(`Scenario "${s.id}" has no code`);
  }
  if (errors.length) return fail(errors);

  const metricIds = new Set(data.metrics.map((m) => m.id));
  const scenarioIds = new Set(data.scenarios.map((s) => s.id));
  const nodeIds = new Set(data.structureNodes.map((n) => n.id));
  const dimensionIds = new Set(data.dimensions.map((d) => d.id));
  const unitIds = new Set(data.units.map((u) => u.id));

  // ---------------------------------------------------------------- referential repairs
  for (const m of data.metrics) {
    if (m.unitId && !unitIds.has(m.unitId)) {
      m.unitId = null;
      addRepair('METRIC_UNIT_CLEARED', 'Metric referencing a unit that is not in the file: unit cleared');
    }
    if (!Object.values(MetricStatus).includes(m.status)) m.status = MetricStatus.DRAFT;
  }

  data.structureNodes = repairHierarchy(data.structureNodes, nodeIds, addRepair, 'STRUCTURE');
  data.dimensionMembers = repairMembers(data.dimensionMembers, dimensionIds, addRepair);

  data.bindings = dropWhere(data.bindings, (b) => !metricIds.has(b.metricId) || !scenarioIds.has(b.scenarioId), addRepair, 'BINDING_ORPHAN_DROPPED', 'Binding referencing a metric or scenario that is not in the file: dropped');
  data.metricStructures = dropWhere(data.metricStructures, (l) => !metricIds.has(l.metricId) || !nodeIds.has(l.structureNodeId), addRepair, 'PLACEMENT_ORPHAN_DROPPED', 'Structural placement referencing a missing metric or group: dropped');
  data.metricDimensions = dropWhere(data.metricDimensions, (l) => !metricIds.has(l.metricId) || !dimensionIds.has(l.dimensionId), addRepair, 'LINK_ORPHAN_DROPPED', 'Metric-dimension link referencing a missing record: dropped');

  // ---------------------------------------------------------------- composite uniqueness
  data.bindings = keepFirstByKey(data.bindings, (b) => `${b.metricId}|${b.scenarioId}`, addRepair, 'BINDING_DUPLICATE_DROPPED', 'More than one binding for the same metric and scenario: extra dropped');
  data.metricStructures = keepFirstByKey(data.metricStructures, (l) => `${l.metricId}|${l.structureNodeId}`, addRepair, 'PLACEMENT_DUPLICATE_DROPPED', 'The same metric placed twice in the same group: extra dropped');
  data.metricDimensions = keepFirstByKey(data.metricDimensions, (l) => `${l.metricId}|${l.dimensionId}`, addRepair, 'LINK_DUPLICATE_DROPPED', 'The same metric linked twice to the same dimension: extra dropped');

  // Exactly one primary placement per metric.
  const byMetric = new Map();
  for (const l of data.metricStructures) {
    if (!byMetric.has(l.metricId)) byMetric.set(l.metricId, []);
    byMetric.get(l.metricId).push(l);
  }
  for (const links of byMetric.values()) {
    const primaries = links.filter((l) => l.isPrimary);
    if (primaries.length === 0) {
      links[0].isPrimary = true;
      addRepair('PLACEMENT_PRIMARY_SET', 'Metric without a primary placement: first placement marked primary');
    } else if (primaries.length > 1) {
      for (const extra of primaries.slice(1)) extra.isPrimary = false;
      addRepair('PLACEMENT_PRIMARY_TRIMMED', 'Metric with several primary placements: only the first kept');
    }
  }

  // Cached formula references pointing at metrics that are not in the file are
  // reset so they get re-resolved instead of pointing into nothing.
  for (const b of data.bindings) {
    for (const ref of b.parsedReferences || []) {
      if (ref.metricId && !metricIds.has(ref.metricId)) {
        ref.metricId = null;
        ref.status = 'missing';
        addRepair('REFERENCE_RESET', 'Cached formula reference pointing outside the file: reset to be re-resolved');
      }
      if (ref.scenarioId && !scenarioIds.has(ref.scenarioId)) ref.scenarioId = b.scenarioId;
    }
  }

  const counts = {};
  for (const c of COLLECTIONS) counts[c] = data[c].length;
  return { ok: true, errors: [], repairs, data, counts, present };

  function fail(errs) {
    const counts0 = {};
    for (const c of COLLECTIONS) counts0[c] = Array.isArray(raw[c]) ? raw[c].length : 0;
    return { ok: false, errors: errs, repairs, data: null, counts: counts0, present: present || {} };
  }
}

function dropWhere(list, predicate, addRepair, code, message) {
  const kept = [];
  let dropped = 0;
  for (const rec of list) {
    if (predicate(rec)) dropped += 1;
    else kept.push(rec);
  }
  if (dropped) addRepair(code, message, dropped);
  return kept;
}

function keepFirstByKey(list, keyOf, addRepair, code, message) {
  const seen = new Set();
  const kept = [];
  let dropped = 0;
  for (const rec of list) {
    const key = keyOf(rec);
    if (seen.has(key)) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    kept.push(rec);
  }
  if (dropped) addRepair(code, message, dropped);
  return kept;
}

/** Detach nodes whose parent is missing, and break parent cycles. */
function repairHierarchy(nodes, validIds, addRepair, prefix) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    if (n.parentId && !validIds.has(n.parentId)) {
      n.parentId = null;
      addRepair(`${prefix}_PARENT_CLEARED`, 'Node whose parent is not in the file: moved to the root level');
    }
    if (n.parentId === n.id) {
      n.parentId = null;
      addRepair(`${prefix}_SELF_PARENT`, 'Node that was its own parent: moved to the root level');
    }
  }
  for (const n of nodes) {
    const seen = new Set([n.id]);
    let cur = n.parentId ? byId.get(n.parentId) : null;
    while (cur) {
      if (seen.has(cur.id)) {
        cur.parentId = null;
        addRepair(`${prefix}_CYCLE_BROKEN`, 'Parent cycle detected: the closing link was moved to the root level');
        break;
      }
      seen.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : null;
    }
  }
  return nodes;
}

/** Members must belong to an existing dimension, sit under a parent of the same dimension, and have a level matching their depth. */
function repairMembers(members, dimensionIds, addRepair) {
  const kept = dropWhere(members, (m) => !dimensionIds.has(m.dimensionId), addRepair, 'MEMBER_ORPHAN_DROPPED', 'Dimension member belonging to a dimension that is not in the file: dropped');
  const byId = new Map(kept.map((m) => [m.id, m]));
  for (const m of kept) {
    const parent = m.parentId ? byId.get(m.parentId) : null;
    if (m.parentId && (!parent || parent.dimensionId !== m.dimensionId || parent.id === m.id)) {
      m.parentId = null;
      addRepair('MEMBER_PARENT_CLEARED', 'Dimension member with an invalid parent: moved to the top level');
    }
  }
  for (const m of kept) {
    const seen = new Set([m.id]);
    let cur = m.parentId ? byId.get(m.parentId) : null;
    while (cur) {
      if (seen.has(cur.id)) {
        cur.parentId = null;
        addRepair('MEMBER_CYCLE_BROKEN', 'Cyclic member hierarchy: the closing link was moved to the top level');
        break;
      }
      seen.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : null;
    }
  }
  let relevelled = 0;
  for (const m of kept) {
    let depth = 1;
    let cur = m.parentId ? byId.get(m.parentId) : null;
    const guard = new Set([m.id]);
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id);
      depth += 1;
      cur = cur.parentId ? byId.get(cur.parentId) : null;
    }
    if (m.level !== depth) {
      m.level = depth;
      relevelled += 1;
    }
  }
  if (relevelled) addRepair('MEMBER_LEVEL_FIXED', 'Dimension member level did not match its depth: recomputed', relevelled);
  return kept;
}
