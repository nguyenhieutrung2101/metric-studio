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
