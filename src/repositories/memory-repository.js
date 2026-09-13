import { Repository, ConflictError, NotFoundError, COLLECTIONS, assertCollection, clone, tokenOf } from './repository.js';
import { uniqueKeyOf } from '../core/collections.js';
import { padNumber } from '../utils/text.js';

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
    this._sequences = new Map();
    this._writeQueue = Promise.resolve();
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

  /**
   * Every mutation runs to completion before the next one starts.
   *
   * Planning reads the current state and committing is asynchronous, so
   * without this two overlapping writes would both pass the token and
   * uniqueness checks against the same stale state and the second would
   * silently overwrite the first. Serialising is what makes the concurrency
   * promise in the contract true rather than aspirational.
   */
  _serialize(work) {
    const result = this._writeQueue.then(work, work);
    this._writeQueue = result.then(noop, noop);
    return result;
  }

  // ------------------------------------------------------------ single writes
  save(collection, record, expectedToken) {
    return this._serialize(() => this._saveNow(collection, record, expectedToken));
  }

  remove(collection, id, expectedToken) {
    return this._serialize(() => this._removeNow(collection, id, expectedToken));
  }

  applyBatch(ops, options) {
    return this._serialize(() => this._applyBatchNow(ops, options));
  }

  saveMany(collection, records) {
    return this._serialize(() => this._saveManyNow(collection, records));
  }

  replaceAll(snapshot) {
    return this._serialize(() => this._replaceAllNow(snapshot));
  }

  clear() {
    return this._serialize(() => this._clearNow());
  }

  /**
   * Run a command that must see a consistent world.
   *
   * Serialising each write is not enough for an invariant that spans several
   * records: two moves can each check that they create no cycle, then each
   * write, and together produce one. The check has to happen inside the same
   * critical section as the write, against the records the repository holds
   * rather than against a mirror that is updated afterwards. The handle
   * reaches the unserialised operations directly, because the caller already
   * owns the queue slot.
   */
  runExclusive(fn) {
    return this._serialize(() => fn({
      list: (collection) => {
        assertCollection(collection);
        return [...this._data[collection].values()].map(clone);
      },
      get: (collection, id) => {
        assertCollection(collection);
        const r = this._data[collection].get(id);
        return r ? clone(r) : null;
      },
      applyBatch: (ops, options) => this._applyBatchNow(ops, options),
      save: (collection, record, expectedToken) => this._saveNow(collection, record, expectedToken),
      remove: (collection, id, expectedToken) => this._removeNow(collection, id, expectedToken),
    }));
  }

  /**
   * Allocate the next canonical code for a collection.
   *
   * Reading the highest existing code and then writing a record is a
   * check-then-act across an await like any other, so it runs inside the
   * write queue and the high-water mark is remembered rather than recomputed:
   * three creates started at once must produce three codes, not one code
   * three times. `pattern` extracts the number from an existing code.
   */
  allocateCode(collection, { prefix, width, pattern }) {
    return this._serialize(() => this._allocateCodeNow(collection, { prefix, width, pattern }));
  }

  createRestorePoint(label = '', options = {}) {
    return this._serialize(() => this._createRestorePointNow(label, options));
  }

  deleteRestorePoint(id) {
    return this._serialize(() => this._deleteRestorePointNow(id));
  }

  async _saveNow(collection, record, expectedToken) {
    const plan = this._planSave(collection, record, expectedToken);
    await this._commit({ puts: [plan], ops: [{ kind: 'put', ...plan }] });
    this._data[collection].set(plan.record.id, plan.record);
    return clone(plan.record);
  }

  async _removeNow(collection, id, expectedToken) {
    const plan = this._planRemove(collection, id, expectedToken);
    await this._commit({ deletes: [plan], ops: [{ kind: 'delete', ...plan }] });
    this._data[collection].delete(id);
    return true;
  }

  // ------------------------------------------------------------ batch
  async _applyBatchNow(ops, { guards = [] } = {}) {
    if (!Array.isArray(ops)) throw new Error('applyBatch expects an array of operations');
    // Fail fast against what this instance knows; the adapter re-runs the
    // same guards against the durable store, which is the one that decides.
    for (const g of guards) g.check([...this._data[g.collection].values()].map(clone));
    const puts = [];
    const deletes = [];
    const touched = new Set();
    // Removals are planned first so that a batch which frees a unique
    // relationship and re-creates it elsewhere is not rejected by itself.
    const ctx = { pending: new Set(), removing: new Map() };
    const planned = new Map();
    const alreadyGone = [];
    for (const op of ops) {
      if (!op || op.op !== 'remove') continue;
      const key = `${op.collection}/${op.id}`;
      if (touched.has(key)) throw new Error(`applyBatch touches ${key} more than once`);
      touched.add(key);
      const plan = this._planRemove(op.collection, op.id, op.expectedToken, op.optional === true);
      if (!plan) {
        // Already gone in the store. The caller asked us to carry on, but it
        // still has to learn the record no longer exists, or its own mirror
        // keeps showing something the database does not have.
        alreadyGone.push({ collection: op.collection, id: op.id });
        continue;
      }
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
    await this._commit({ puts, deletes, ops: ordered, guards });
    for (const p of puts) this._data[p.collection].set(p.record.id, p.record);
    for (const d of deletes) this._data[d.collection].delete(d.id);
    return {
      saved: puts.map((p) => ({ collection: p.collection, record: clone(p.record) })),
      // Records that were already absent are reported as removed too: after
      // this call they are gone, which is all the caller needs to know.
      removed: [...deletes.map((d) => ({ collection: d.collection, id: d.id })), ...alreadyGone],
      alreadyGone,
    };
  }

  // ------------------------------------------------------------ bulk
  async _saveManyNow(collection, records) {
    assertCollection(collection);
    const prepared = this._prepareBulk(collection, records);
    await this._commit({ puts: prepared });
    for (const p of prepared) this._data[collection].set(p.record.id, p.record);
    return prepared.map((p) => clone(p.record));
  }

  async _replaceAllNow(snapshot) {
    // The catalogue is about to be someone else's; codes must be re-derived
    // from it rather than carried over from the one being replaced.
    this._sequences.clear();
    await this._clearSequences();
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

  async _clearNow() {
    this._sequences.clear();
    await this._clearSequences();
    await this._commit({ clearAll: true });
    for (const c of COLLECTIONS) this._data[c].clear();
  }

  // ------------------------------------------------------------ code allocation
  async _allocateCodeNow(collection, { prefix, width, pattern }) {
    assertCollection(collection);
    const key = `${collection}:${prefix}`;
    const floor = () => this._highestCode(collection, pattern) + 1;
    const next = await this._nextSequenceValue(key, this._sequences.get(key) ?? null, floor);
    this._sequences.set(key, next + 1);
    return `${prefix}${padNumber(next, width)}`;
  }

  _highestCode(collection, pattern) {
    let max = 0;
    for (const record of this._data[collection].values()) {
      const m = pattern.exec(record.code || '');
      if (m) max = Math.max(max, Number(m[1]) || 0);
    }
    return max;
  }

  /**
   * The value to hand out. In memory the queue is the only writer, so the
   * remembered mark is authoritative; an adapter whose store is shared with
   * other connections overrides this to read and bump the sequence inside one
   * transaction.
   */
  async _nextSequenceValue(key, remembered, floor) {
    return Math.max(remembered ?? 0, floor());
  }

  /** Durable sequences, if the adapter keeps any. */
  async _clearSequences() {}

  // ------------------------------------------------------------ restore points
  async listRestorePoints() {
    return this._sortedRestorePoints().map(({ id, label, createdAt, counts, seq }) => ({ id, label, createdAt, counts, seq }));
  }

  /** Newest first. Ordered by sequence, because several points can share a millisecond. */
  _sortedRestorePoints() {
    return [...this._restorePoints.values()].sort((a, b) => (b.seq || 0) - (a.seq || 0) || b.createdAt.localeCompare(a.createdAt));
  }

  async _createRestorePointNow(label = '', { max = 3 } = {}) {
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

  async _deleteRestorePointNow(id) {
    if (!this._restorePoints.has(id)) return false;
    await this._deleteRestorePoint(id);
    this._restorePoints.delete(id);
    return true;
  }

  async _pruneRestorePoints(max) {
    for (const old of this._sortedRestorePoints().slice(max)) await this._deleteRestorePointNow(old.id);
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
    // `expected` travels with the plan so an adapter whose durable store can
    // be written by someone else (another tab, another user) can repeat the
    // check where the data actually lives, inside its own transaction. The
    // check above is against this instance's mirror, which only speaks for
    // this instance.
    return { collection, record: saved, expected };
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
    return { collection, id, expected: expectedToken == null ? null : String(expectedToken), optional };
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

function noop() {}
