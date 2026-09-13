import { Repository, ConflictError, NotFoundError, COLLECTIONS, assertCollection, clone, tokenOf } from './repository.js';
import { uniqueKeyOf } from '../core/collections.js';

/** Thrown when a write would create a second record for a unique relationship. */
export class UniquenessError extends Error {
  constructor(collection, key) {
    super(`${collection} already has a record for ${key}`);
    this.name = 'UniquenessError';
    this.collection = collection;
    this.key = key;
  }
}

/**
 * Reference implementation and the base class for every local adapter.
 *
 * Every mutation follows the same shape:
 *
 *   1. plan   — validate concurrency tokens and build the new records
 *   2. commit — hand the whole plan to `_commit()`, which a subclass makes
 *               durable atomically (base class: nothing to do)
 *   3. apply  — only then mutate the in-memory mirror
 *
 * A failure in step 2 therefore leaves both the backing store and the mirror
 * exactly as they were.
 */
export class MemoryRepository extends Repository {
  constructor() {
    super();
    this._data = {};
    for (const c of COLLECTIONS) this._data[c] = new Map();
    this._restorePoints = new Map();
    this._restoreSeq = 0;
  }

  describe() {
    return { persistent: false, kind: 'memory', atomicBatch: true, restorePoints: true };
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

  // ------------------------------------------------------------ single writes
  async save(collection, record, expectedToken) {
    const plan = this._planSave(collection, record, expectedToken);
    await this._commit({ puts: [plan], ops: [{ kind: 'put', ...plan }] });
    this._data[collection].set(plan.record.id, plan.record);
    return clone(plan.record);
  }

  async remove(collection, id, expectedToken) {
    const plan = this._planRemove(collection, id, expectedToken);
    await this._commit({ deletes: [plan], ops: [{ kind: 'delete', ...plan }] });
    this._data[collection].delete(id);
    return true;
  }

  // ------------------------------------------------------------ batch
  async applyBatch(ops) {
    if (!Array.isArray(ops)) throw new Error('applyBatch expects an array of operations');
    const puts = [];
    const deletes = [];
    const touched = new Set();
    // Removals are planned first so that a batch which frees a unique
    // relationship and re-creates it elsewhere is not rejected by itself.
    const ctx = { pending: new Set(), removing: new Map() };
    const planned = new Map();
    for (const op of ops) {
      if (!op || op.op !== 'remove') continue;
      const key = `${op.collection}/${op.id}`;
      if (touched.has(key)) throw new Error(`applyBatch touches ${key} more than once`);
      touched.add(key);
      const plan = this._planRemove(op.collection, op.id, op.expectedToken, op.optional === true);
      if (!plan) continue; // already gone, and the caller said that is fine
      planned.set(op, plan);
      deletes.push(plan);
      if (!ctx.removing.has(op.collection)) ctx.removing.set(op.collection, new Set());
      ctx.removing.get(op.collection).add(op.id);
    }
    for (const op of ops) {
      if (!op) continue;
      if (op.op === 'remove') continue;
      if (op.op !== 'save') throw new Error(`Unknown batch operation "${op.op}"`);
      const key = `${op.collection}/${op.record ? op.record.id : op.id}`;
      if (touched.has(key)) throw new Error(`applyBatch touches ${key} more than once`);
      touched.add(key);
      const plan = this._planSave(op.collection, op.record, op.expectedToken, ctx);
      planned.set(op, plan);
      puts.push(plan);
    }
    // The ordered view lets a non-atomic adapter replay the caller's order;
    // an atomic one can keep using puts/deletes and ignore it.
    const ordered = [];
    for (const op of ops) {
      const plan = op && planned.get(op);
      if (!plan) continue;
      ordered.push(op.op === 'remove' ? { kind: 'delete', ...plan } : { kind: 'put', ...plan });
    }
    await this._commit({ puts, deletes, ops: ordered });
    for (const p of puts) this._data[p.collection].set(p.record.id, p.record);
    for (const d of deletes) this._data[d.collection].delete(d.id);
    return {
      saved: puts.map((p) => ({ collection: p.collection, record: clone(p.record) })),
      removed: deletes.map((d) => ({ collection: d.collection, id: d.id })),
    };
  }

  // ------------------------------------------------------------ bulk
  async saveMany(collection, records) {
    assertCollection(collection);
    const prepared = this._prepareBulk(collection, records);
    await this._commit({ puts: prepared });
    for (const p of prepared) this._data[collection].set(p.record.id, p.record);
    return prepared.map((p) => clone(p.record));
  }

  async replaceAll(snapshot) {
    const puts = [];
    for (const c of COLLECTIONS) {
      assertCollection(c);
      puts.push(...this._prepareBulk(c, snapshot[c] || []));
    }
    // One commit for clear + every insert: a failure keeps the old data.
    await this._commit({ clearAll: true, puts });
    for (const c of COLLECTIONS) this._data[c] = new Map();
    for (const p of puts) this._data[p.collection].set(p.record.id, p.record);
    const out = {};
    for (const c of COLLECTIONS) out[c] = [...this._data[c].values()].map(clone);
    return out;
  }

  async clear() {
    await this._commit({ clearAll: true });
    for (const c of COLLECTIONS) this._data[c].clear();
  }

  // ------------------------------------------------------------ restore points
  async listRestorePoints() {
    return this._sortedRestorePoints().map(({ id, label, createdAt, counts, seq }) => ({ id, label, createdAt, counts, seq }));
  }

  /** Newest first. Ordered by sequence, because several points can share a millisecond. */
  _sortedRestorePoints() {
    return [...this._restorePoints.values()].sort((a, b) => (b.seq || 0) - (a.seq || 0) || b.createdAt.localeCompare(a.createdAt));
  }

  async createRestorePoint(label = '', { max = 3 } = {}) {
    const data = await this.loadAll();
    const counts = {};
    let total = 0;
    for (const c of COLLECTIONS) {
      counts[c] = data[c].length;
      total += data[c].length;
    }
    if (total === 0) return null;
    this._restoreSeq += 1;
    const point = { id: `rp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, seq: this._restoreSeq, label: String(label || ''), createdAt: new Date().toISOString(), counts, data };
    await this._commitRestorePoint(point);
    this._restorePoints.set(point.id, point);
    await this._pruneRestorePoints(max);
    return { id: point.id, seq: point.seq, label: point.label, createdAt: point.createdAt, counts };
  }

  async getRestorePoint(id) {
    const p = this._restorePoints.get(id);
    return p ? clone(p) : null;
  }

  async deleteRestorePoint(id) {
    if (!this._restorePoints.has(id)) return false;
    await this._deleteRestorePoint(id);
    this._restorePoints.delete(id);
    return true;
  }

  async _pruneRestorePoints(max) {
    for (const old of this._sortedRestorePoints().slice(max)) await this.deleteRestorePoint(old.id);
  }

  // ------------------------------------------------------------ planning
  _planSave(collection, record, expectedToken, ctx = null) {
    assertCollection(collection);
    if (!record || !record.id) throw new Error('record.id is required');
    const existing = this._data[collection].get(record.id) || null;
    const expected = expectedToken == null ? null : String(expectedToken);
    if (existing) {
      if (tokenOf(existing) !== expected) throw new ConflictError(collection, record.id, expected, clone(existing));
    } else if (expected !== null) {
      throw new ConflictError(collection, record.id, expected, null);
    }
    this._assertUnique(collection, record, ctx);
    const saved = clone(record);
    saved.version = (existing ? existing.version : 0) + 1;
    saved.concurrencyToken = String(saved.version);
    saved.updatedAt = new Date().toISOString();
    if (!saved.createdAt) saved.createdAt = existing ? existing.createdAt : saved.updatedAt;
    return { collection, record: saved };
  }

  /**
   * Reject a write that would duplicate a structural relationship.
   * Records the same batch is deleting do not count as occupying their key.
   */
  _assertUnique(collection, record, ctx = null) {
    const key = uniqueKeyOf(collection, record);
    if (!key) return;
    const removing = ctx && ctx.removing ? ctx.removing.get(collection) : null;
    for (const other of this._data[collection].values()) {
      if (other.id === record.id) continue;
      if (removing && removing.has(other.id)) continue;
      if (uniqueKeyOf(collection, other) === key) throw new UniquenessError(collection, key);
    }
    if (ctx && ctx.pending) {
      const pendingKey = `${collection}:${key}`;
      if (ctx.pending.has(pendingKey)) throw new UniquenessError(collection, key);
      ctx.pending.add(pendingKey);
    }
  }

  /** @returns {{collection, id}|null} null only when the record is gone and `optional` is set. */
  _planRemove(collection, id, expectedToken, optional = false) {
    assertCollection(collection);
    const existing = this._data[collection].get(id);
    if (!existing) {
      if (optional) return null;
      throw new NotFoundError(collection, id);
    }
    if (expectedToken != null && tokenOf(existing) !== String(expectedToken)) {
      throw new ConflictError(collection, id, String(expectedToken), clone(existing));
    }
    return { collection, id };
  }

  _prepareBulk(collection, records) {
    const ts = new Date().toISOString();
    const out = [];
    const keys = new Set();
    for (const record of records || []) {
      if (!record || !record.id) continue;
      const key = uniqueKeyOf(collection, record);
      if (key) {
        if (keys.has(key)) throw new UniquenessError(collection, key);
        keys.add(key);
      }
      const rec = clone(record);
      if (!Number.isInteger(rec.version) || rec.version < 1) rec.version = 1;
      rec.concurrencyToken = String(rec.version);
      if (!rec.createdAt) rec.createdAt = ts;
      if (!rec.updatedAt) rec.updatedAt = ts;
      out.push({ collection, record: rec });
    }
    return out;
  }

  // ------------------------------------------------------------ durability hooks
  /**
   * Make a plan durable. Must be atomic: either every put/delete lands or
   * none does. The base class keeps data in memory only, so there is
   * nothing to do.
   * @param {{clearAll?: boolean, puts?: Array<{collection, record}>, deletes?: Array<{collection, id}>, ops?: Array<{kind: 'put'|'delete', collection, record?, id?}>}} _plan
   *        `ops` is the same work in the caller's order, for adapters that
   *        cannot commit atomically and must replay it step by step.
   */
  async _commit(_plan) {}

  async _commitRestorePoint(_point) {}

  async _deleteRestorePoint(_id) {}
}
