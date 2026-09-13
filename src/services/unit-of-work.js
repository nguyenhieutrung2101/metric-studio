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
  const result = await repo.applyBatch(ops);
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
  return result;
}
