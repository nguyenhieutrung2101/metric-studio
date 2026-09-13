/**
 * Unit of work: a set of writes that must land together or not at all.
 *
 * Services describe what they want to change, the repository applies it in
 * one transaction, and only the acknowledged result is pushed into the store.
 * A failure therefore leaves both the database and the UI state untouched,
 * instead of half a cascade.
 */
export class UnitOfWork {
  constructor() {
    this.ops = [];
  }

  save(collection, record, expectedToken = null) {
    this.ops.push({ op: 'save', collection, record, expectedToken });
    return this;
  }

  remove(collection, id, expectedToken = null) {
    this.ops.push({ op: 'remove', collection, id, expectedToken });
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
