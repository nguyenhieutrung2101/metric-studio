/**
 * Persisted collections. Order matters for import: parents before children.
 * Every record in every collection has { id, version, createdAt, updatedAt }.
 */
export const COLLECTIONS = Object.freeze([
  'units',
  'scenarios',
  'metrics',
  'structureNodes',
  'metricStructures',
  'bindings',
  'dimensions',
  'dimensionMembers',
  'metricDimensions',
]);

export const SCHEMA_VERSION = 1;

/**
 * Structural uniqueness enforced at the persistence boundary, not in the UI.
 * These are relationships that simply cannot exist twice: a metric has one
 * binding per scenario, sits once in a given group, and is linked once to a
 * given dimension.
 *
 * Business codes (metric code, dimension code) are deliberately NOT here.
 * Duplicated codes are a governance finding the warning centre must report on
 * imported legacy data, not a reason to refuse the import.
 */
export const UNIQUE_KEYS = Object.freeze({
  bindings: ['metricId', 'scenarioId'],
  metricStructures: ['metricId', 'structureNodeId'],
  metricDimensions: ['metricId', 'dimensionId'],
});

export function uniqueKeyOf(collection, record) {
  const fields = UNIQUE_KEYS[collection];
  if (!fields) return null;
  return fields.map((f) => String(record[f] ?? '')).join('|');
}

