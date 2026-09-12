import { Repository, ConflictError, NotFoundError, COLLECTIONS, assertCollection, clone } from './repository.js';

/**
 * Reference implementation. Records are cloned on the way in and out so the
 * repository behaves like a remote store (mutating a returned object never
 * mutates what is persisted). Optimistic concurrency:
 *
 *   save(c, rec, expectedVersion)
 *     new record        → expectedVersion must be null/undefined/0 → version 1
 *     existing record   → expectedVersion must equal stored.version → version + 1
 *     otherwise         → ConflictError { current }
 */
export class MemoryRepository extends Repository {
  constructor() {
    super();
    this._data = {};
    for (const c of COLLECTIONS) this._data[c] = new Map();
  }

  describe() {
    return { persistent: false, kind: 'memory' };
  }

  async loadAll() {
    const out = {};
    for (const c of COLLECTIONS) out[c] = [...this._data[c].values()].map(clone);
    return out;
  }

  async list(collection) {
    assertCollection(collection);
    return [...this._data[collection].values()].map(clone);
  }

  async get(collection, id) {
    assertCollection(collection);
    const rec = this._data[collection].get(id);
    return rec ? clone(rec) : null;
  }

  async save(collection, record, expectedVersion) {
    assertCollection(collection);
    if (!record || !record.id) throw new Error('record.id is required');
    const existing = this._data[collection].get(record.id) || null;
    const expected = expectedVersion == null ? 0 : expectedVersion;
    if (existing) {
      if (existing.version !== expected) throw new ConflictError(collection, record.id, expected, clone(existing));
    } else if (expected !== 0) {
      throw new ConflictError(collection, record.id, expected, null);
    }
    const saved = clone(record);
    saved.version = (existing ? existing.version : 0) + 1;
    saved.updatedAt = new Date().toISOString();
    if (!saved.createdAt) saved.createdAt = existing ? existing.createdAt : saved.updatedAt;
    await this._persist(collection, saved);
    this._data[collection].set(saved.id, saved);
    return clone(saved);
  }

  async remove(collection, id, expectedVersion) {
    assertCollection(collection);
    const existing = this._data[collection].get(id);
    if (!existing) throw new NotFoundError(collection, id);
    if (expectedVersion != null && existing.version !== expectedVersion) {
      throw new ConflictError(collection, id, expectedVersion, clone(existing));
    }
    await this._delete(collection, id);
    this._data[collection].delete(id);
    return true;
  }

  async saveMany(collection, records) {
    assertCollection(collection);
    const saved = [];
    const ts = new Date().toISOString();
    for (const record of records) {
      if (!record || !record.id) continue;
      const rec = clone(record);
      if (!Number.isInteger(rec.version) || rec.version < 1) rec.version = 1;
      if (!rec.createdAt) rec.createdAt = ts;
      if (!rec.updatedAt) rec.updatedAt = ts;
      this._data[collection].set(rec.id, rec);
      saved.push(rec);
    }
    await this._persistMany(collection, saved);
    return saved.map(clone);
  }

  async replaceAll(snapshot) {
    await this.clear();
    const out = {};
    for (const c of COLLECTIONS) out[c] = await this.saveMany(c, snapshot[c] || []);
    return out;
  }

  async clear() {
    for (const c of COLLECTIONS) this._data[c].clear();
    await this._clearAll();
  }

  // Hooks for persistent subclasses.
  async _persist() {}
  async _persistMany() {}
  async _delete() {}
  async _clearAll() {}
}
