import { COLLECTIONS } from '../core/collections.js';

export { COLLECTIONS };

/**
 * Optimistic-concurrency token.
 *
 * `version` is the domain revision: a small integer meant for humans ("you
 * opened v12, the current one is v13"). `concurrencyToken` is the opaque
 * value the backend uses to detect a stale write. Local adapters derive the
 * token from the version; a SharePoint adapter will put its ETag there
 * verbatim. Nothing outside a repository adapter may parse, compare with
 * `<`/`>`, or do arithmetic on a token.
 */
export function tokenOf(record) {
  if (record == null) return null;
  if (record.concurrencyToken != null) return String(record.concurrencyToken);
  if (record.version == null) return null;
  return String(record.version);
}

/** Thrown when the expected concurrency token does not match the stored one. */
export class ConflictError extends Error {
  constructor(collection, id, expectedToken, current) {
    const currentLabel = current ? `v${current.version}` : 'deleted';
    super(`Conflict on ${collection}/${id}: expected token ${expectedToken}, current is ${currentLabel}`);
    this.name = 'ConflictError';
    this.collection = collection;
    this.id = id;
    this.expectedToken = expectedToken;
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
 * Rules every adapter must honour:
 *
 * 1. A write is acknowledged only after it is durable. The in-memory mirror
 *    is updated *after* the backing store confirms, never before.
 * 2. `save` and `remove` take the caller's expected concurrency token and
 *    reject a stale write with ConflictError. Nothing is overwritten
 *    silently.
 * 3. `applyBatch`, `replaceAll` and `clear` are all-or-nothing. A failure
 *    anywhere leaves the store exactly as it was. An adapter that genuinely
 *    cannot be atomic must say so in `describe().atomicBatch === false` so
 *    callers can choose a different strategy.
 * 4. Records handed out are copies. Mutating a returned object never changes
 *    what is stored.
 */
export class Repository {
  async init() {
    return this;
  }

  /** @returns {{ persistent: boolean, kind: string, atomicBatch: boolean, restorePoints: boolean, detail?: string }} */
  describe() {
    return { persistent: false, kind: 'abstract', atomicBatch: false, restorePoints: false };
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
   * @param {string} collection
   * @param {object} record full record; its own version/token fields are ignored
   * @param {string|null} expectedToken token from the record the caller read,
   *        or null/undefined when the record must not exist yet
   */
  async save(collection, record, expectedToken) {
    throw new NotImplementedError(`save(${collection})`);
  }

  async remove(collection, id, expectedToken) {
    throw new NotImplementedError(`remove(${collection}, ${id})`);
  }

  /**
   * Apply several writes as one unit.
   * @param {Array<{op: 'save'|'remove', collection: string, record?: object, id?: string, expectedToken?: string|null}>} ops
   * @returns {Promise<{saved: Array<{collection, record}>, removed: Array<{collection, id}>}>}
   */
  async applyBatch(ops) {
    throw new NotImplementedError('applyBatch');
  }

  /** Bulk write without token checks (seeding, import). All or nothing. */
  async saveMany(collection, records) {
    throw new NotImplementedError(`saveMany(${collection})`);
  }

  /** Replace everything with the given snapshot. All or nothing. */
  async replaceAll(snapshot) {
    throw new NotImplementedError('replaceAll');
  }

  async clear() {
    throw new NotImplementedError('clear');
  }

  // ------------------------------------------------------------ restore points
  /**
   * A restore point is a full snapshot taken automatically before a
   * destructive operation (import, reset, clear). Adapters that cannot store
   * them report `describe().restorePoints === false` and return an empty list.
   */
  async listRestorePoints() {
    return [];
  }

  async createRestorePoint() {
    return null;
  }

  async getRestorePoint() {
    return null;
  }

  async deleteRestorePoint() {
    return false;
  }

  // ------------------------------------------------------------ named helpers
  listMetrics() { return this.list('metrics'); }
  getMetric(id) { return this.get('metrics', id); }
  saveMetric(metric, expectedToken) { return this.save('metrics', metric, expectedToken); }
  deleteMetric(id, expectedToken) { return this.remove('metrics', id, expectedToken); }

  listBindings() { return this.list('bindings'); }
  saveBinding(binding, expectedToken) { return this.save('bindings', binding, expectedToken); }
  deleteBinding(id, expectedToken) { return this.remove('bindings', id, expectedToken); }

  listStructure() { return this.list('structureNodes'); }
  saveStructure(node, expectedToken) { return this.save('structureNodes', node, expectedToken); }
  deleteStructure(id, expectedToken) { return this.remove('structureNodes', id, expectedToken); }

  listMetricStructures() { return this.list('metricStructures'); }
  saveMetricStructure(link, expectedToken) { return this.save('metricStructures', link, expectedToken); }
  deleteMetricStructure(id, expectedToken) { return this.remove('metricStructures', id, expectedToken); }

  listDimensions() { return this.list('dimensions'); }
  saveDimension(dim, expectedToken) { return this.save('dimensions', dim, expectedToken); }
  deleteDimension(id, expectedToken) { return this.remove('dimensions', id, expectedToken); }

  listDimensionMembers() { return this.list('dimensionMembers'); }
  saveDimensionMember(member, expectedToken) { return this.save('dimensionMembers', member, expectedToken); }
  deleteDimensionMember(id, expectedToken) { return this.remove('dimensionMembers', id, expectedToken); }

  listMetricDimensions() { return this.list('metricDimensions'); }
  saveMetricDimension(link, expectedToken) { return this.save('metricDimensions', link, expectedToken); }
  deleteMetricDimension(id, expectedToken) { return this.remove('metricDimensions', id, expectedToken); }

  listScenarios() { return this.list('scenarios'); }
  saveScenario(s, expectedToken) { return this.save('scenarios', s, expectedToken); }

  listUnits() { return this.list('units'); }
  saveUnit(u, expectedToken) { return this.save('units', u, expectedToken); }
  deleteUnit(id, expectedToken) { return this.remove('units', id, expectedToken); }
}

export function assertCollection(collection) {
  if (!COLLECTIONS.includes(collection)) throw new Error(`Unknown collection "${collection}"`);
}

export function clone(record) {
  if (record == null) return record;
  if (typeof structuredClone === 'function') return structuredClone(record);
  return JSON.parse(JSON.stringify(record));
}
