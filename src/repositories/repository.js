import { COLLECTIONS } from '../core/collections.js';

export { COLLECTIONS };

/** Thrown when expectedVersion does not match the stored version. */
export class ConflictError extends Error {
  constructor(collection, id, expectedVersion, current) {
    super(`Conflict on ${collection}/${id}: expected version ${expectedVersion}, current is ${current ? current.version : 'deleted'}`);
    this.name = 'ConflictError';
    this.collection = collection;
    this.id = id;
    this.expectedVersion = expectedVersion;
    this.current = current || null;
  }
}

export class NotFoundError extends Error {
  constructor(collection, id) {
    super(`${collection}/${id} not found`);
    this.name = 'NotFoundError';
    this.collection = collection;
    this.id = id;
  }
}

export class NotImplementedError extends Error {
  constructor(what) {
    super(`${what} is not implemented`);
    this.name = 'NotImplementedError';
  }
}

/**
 * Repository contract.
 *
 * Generic operations are the adapter surface; the named helpers below are
 * convenience wrappers so services read naturally. Every save takes an
 * expectedVersion and returns the acknowledged record (with the new version).
 * Adapters must reject stale saves with ConflictError and never overwrite.
 */
export class Repository {
  /** Open connections, run migrations. */
  async init() {
    return this;
  }

  /** @returns {{ persistent: boolean, kind: string, detail?: string }} */
  describe() {
    return { persistent: false, kind: 'abstract' };
  }

  /** Full snapshot { collection: record[] } used to hydrate the store. */
  async loadAll() {
    throw new NotImplementedError('loadAll');
  }

  async list(collection) {
    throw new NotImplementedError(`list(${collection})`);
  }

  async get(collection, id) {
    throw new NotImplementedError(`get(${collection}, ${id})`);
  }

  /**
   * Save a record.
   * @param {string} collection
   * @param {object} record  full record; record.version is ignored, expectedVersion is used
   * @param {number|null} expectedVersion  null/undefined means "must be new"
   */
  async save(collection, record, expectedVersion) {
    throw new NotImplementedError(`save(${collection})`);
  }

  async remove(collection, id, expectedVersion) {
    throw new NotImplementedError(`remove(${collection}, ${id})`);
  }

  /** Bulk write without version checks (seeding, import). Returns saved records. */
  async saveMany(collection, records) {
    throw new NotImplementedError(`saveMany(${collection})`);
  }

  /** Replace everything with the given snapshot (import / reset). */
  async replaceAll(snapshot) {
    throw new NotImplementedError('replaceAll');
  }

  async clear() {
    throw new NotImplementedError('clear');
  }

  // ------------------------------------------------------------ named helpers
  listMetrics() { return this.list('metrics'); }
  getMetric(id) { return this.get('metrics', id); }
  saveMetric(metric, expectedVersion) { return this.save('metrics', metric, expectedVersion); }
  deleteMetric(id, expectedVersion) { return this.remove('metrics', id, expectedVersion); }

  listBindings() { return this.list('bindings'); }
  saveBinding(binding, expectedVersion) { return this.save('bindings', binding, expectedVersion); }
  deleteBinding(id, expectedVersion) { return this.remove('bindings', id, expectedVersion); }

  listStructure() { return this.list('structureNodes'); }
  saveStructure(node, expectedVersion) { return this.save('structureNodes', node, expectedVersion); }
  deleteStructure(id, expectedVersion) { return this.remove('structureNodes', id, expectedVersion); }

  listMetricStructures() { return this.list('metricStructures'); }
  saveMetricStructure(link, expectedVersion) { return this.save('metricStructures', link, expectedVersion); }
  deleteMetricStructure(id, expectedVersion) { return this.remove('metricStructures', id, expectedVersion); }

  listDimensions() { return this.list('dimensions'); }
  saveDimension(dim, expectedVersion) { return this.save('dimensions', dim, expectedVersion); }
  deleteDimension(id, expectedVersion) { return this.remove('dimensions', id, expectedVersion); }

  listDimensionMembers() { return this.list('dimensionMembers'); }
  saveDimensionMember(member, expectedVersion) { return this.save('dimensionMembers', member, expectedVersion); }
  deleteDimensionMember(id, expectedVersion) { return this.remove('dimensionMembers', id, expectedVersion); }

  listMetricDimensions() { return this.list('metricDimensions'); }
  saveMetricDimension(link, expectedVersion) { return this.save('metricDimensions', link, expectedVersion); }
  deleteMetricDimension(id, expectedVersion) { return this.remove('metricDimensions', id, expectedVersion); }

  listScenarios() { return this.list('scenarios'); }
  saveScenario(s, expectedVersion) { return this.save('scenarios', s, expectedVersion); }

  listUnits() { return this.list('units'); }
  saveUnit(u, expectedVersion) { return this.save('units', u, expectedVersion); }
  deleteUnit(id, expectedVersion) { return this.remove('units', id, expectedVersion); }
}

export function assertCollection(collection) {
  if (!COLLECTIONS.includes(collection)) throw new Error(`Unknown collection "${collection}"`);
}

export function clone(record) {
  if (record == null) return record;
  if (typeof structuredClone === 'function') return structuredClone(record);
  return JSON.parse(JSON.stringify(record));
}
