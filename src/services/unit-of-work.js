/**
 * Unit of work: a set of writes that must land together or not at all.
 *
 * Services describe what they want to change, the repository applies it in
 * one transaction, and only the acknowledged result is pushed into the store.
 * A failure therefore leaves both the database and the UI state untouched,
 * instead of half a cascade.
 *
 * Order matters even so. A backend that cannot be atomic applies the
 * operations in the order they were queued, so services queue dependent
 * records before the record they depend on: a cascade that stops halfway then
 * leaves a parent with fewer children, never an orphan pointing at nothing.
 */
export class UnitOfWork {
  constructor() {
    this.ops = [];
    this.guards = [];
    this.requires = [];
  }

  /**
   * An invariant that must still hold where the data actually lives.
   *
   * Serialising commands inside one repository instance is not enough when
   * the store is shared: two tabs each hold their own mirror, so each can
   * check an acyclic tree and together produce a cycle. A guard is re-run by
   * the adapter against the records it reads inside the same transaction that
   * writes, and throwing from it aborts the whole batch.
   *
   * @param {string} collection records to read
   * @param {(records: object[]) => void} check throws to refuse the batch
   */
  guard(collection, check) {
    this.guards.push({ collection, check });
    return this;
  }

  /**
   * A record this batch depends on, which must still exist where the data
   * lives when the batch is written: the parent a node is created under, the
   * metric a binding belongs to. Cheaper than a guard — one `get` — and it
   * fails with NotFoundError, which is what the caller would have thrown had
   * it known.
   */
  require(collection, id) {
    if (id) this.requires.push({ collection, id });
    return this;
  }

  save(collection, record, expectedToken = null) {
    this.ops.push({ op: 'save', collection, record, expectedToken });
    return this;
  }

  /**
   * @param {boolean} [optional] true for a record that only exists because of
   * another one: if it is already gone the batch should carry on, which is
   * what makes replaying a failed batch safe on a non-atomic backend.
   */
  remove(collection, id, expectedToken = null, { optional = false } = {}) {
    this.ops.push({ op: 'remove', collection, id, expectedToken, optional });
    return this;
  }

  get size() {
    return this.ops.length;
  }
}

/** Apply a unit of work and mirror the acknowledged result into the store. */
export async function commit(repo, store, work) {
  const ops = work instanceof UnitOfWork ? work.ops : work;
  if (!ops.length) return { saved: [], removed: [] };
  const result = await repo.applyBatch(ops, batchOptions(work));
  mirror(store, result);
  return result;
}

/**
 * Run a command inside the repository's critical section, so the invariants
 * it checks still hold when it writes, then mirror the acknowledged result.
 * `plan` receives a handle onto the repository's own records.
 */
export async function commitExclusive(repo, store, plan) {
  const result = await repo.runExclusive(async (tx) => {
    const work = await plan(tx);
    const ops = work instanceof UnitOfWork ? work.ops : work;
    if (!ops || !ops.length) return { saved: [], removed: [] };
    return tx.applyBatch(ops, batchOptions(work));
  });
  mirror(store, result);
  return result;
}

function batchOptions(work) {
  return work instanceof UnitOfWork ? { guards: work.guards, requires: work.requires } : {};
}

/** Push an acknowledged repository result into the store in one change. */
export function mirror(store, result) {
  const upserts = {};
  const removals = {};
  for (const { collection, record } of result.saved) {
    if (!upserts[collection]) upserts[collection] = [];
    upserts[collection].push(record);
  }
  for (const { collection, id } of result.removed) {
    if (!removals[collection]) removals[collection] = [];
    removals[collection].push(id);
  }
  store.applyChanges({ upserts, removals });
}
