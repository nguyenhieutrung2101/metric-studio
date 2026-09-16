import { COLLECTIONS, SCHEMA_VERSION } from '../core/collections.js';
import { parseSnapshot, APP_ID } from './snapshot-schema.js';
import { commit, UnitOfWork } from './unit-of-work.js';

/**
 * BackupService — JSON export, validated import, and the restore points that
 * make every destructive operation reversible.
 *
 * No snapshot reaches the repository without passing `parseSnapshot` first,
 * with no exception for callers that claim to have parsed it already, and no
 * replace happens without a restore point being written first (when the
 * repository supports them), so a bad import is always undoable.
 */
export class BackupService {
  constructor({ store, repo }) {
    this.store = store;
    this.repo = repo;
  }

  exportSnapshot() {
    return { app: APP_ID, schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), data: this.store.snapshot() };
  }

  exportJson(pretty = true) {
    return JSON.stringify(this.exportSnapshot(), null, pretty ? 2 : 0);
  }

  /** Validate and normalise without touching anything. */
  static inspect(json) {
    return parseSnapshot(json);
  }

  /**
   * What an import would actually do.
   *
   * Import replaces, so the records that disappear are the ones whose id is
   * NOT in the file. Comparing counts would miss the common case of a
   * smaller file: 20 incoming metrics replacing 100 deletes 80 of them while
   * the collection is still non-empty.
   */
  preview(json) {
    const parsed = parseSnapshot(json);
    const willDelete = {};
    const willAdd = {};
    const willUpdate = {};
    let deleteTotal = 0;
    let addTotal = 0;
    let updateTotal = 0;
    for (const c of COLLECTIONS) {
      if (!parsed.ok) {
        willDelete[c] = 0;
        willAdd[c] = 0;
        willUpdate[c] = 0;
        continue;
      }
      const incomingIds = new Set(parsed.data[c].map((r) => r.id));
      let lost = 0;
      let kept = 0;
      for (const rec of this.store.list(c)) {
        if (incomingIds.has(rec.id)) kept += 1;
        else lost += 1;
      }
      willDelete[c] = lost;
      willUpdate[c] = kept;
      willAdd[c] = incomingIds.size - kept;
      deleteTotal += lost;
      updateTotal += kept;
      addTotal += willAdd[c];
    }
    return { ...parsed, willDelete, willAdd, willUpdate, deleteTotal, addTotal, updateTotal };
  }

  /**
   * Replace everything with a validated snapshot.
   * @returns {Promise<{counts, repairs, restorePoint, restorePointError}>}
   */
  async importSnapshot(input, { label = 'Before import' } = {}) {
    // A caller may pass a preview result for convenience, but its payload is
    // parsed again rather than trusted: the boundary has no back door. Parsing
    // is idempotent and costs about 100 ms on a 3,000 metric snapshot.
    const raw = input && typeof input === 'object' && input.ok === true && input.data ? input.data : input;
    const parsed = parseSnapshot(raw);
    if (!parsed.ok) throw new Error(parsed.errors.join('; '));
    const { snapshot, restorePoint, restorePointError } = await this._replaceAll(parsed.data, label);
    this.store.hydrate(snapshot);
    return { counts: parsed.counts, repairs: parsed.repairs, restorePoint, restorePointError };
  }

  /** Same path as an import, for the built-in datasets and for clearing. */
  async replaceWith(snapshot, { label = 'Before replace' } = {}) {
    const isEmpty = !COLLECTIONS.some((c) => (snapshot[c] || []).length > 0);
    const parsed = isEmpty ? null : parseSnapshot(snapshot);
    if (parsed && !parsed.ok) throw new Error(parsed.errors.join('; '));
    // Validate before taking the restore point: a bad snapshot must not even
    // cost the user a slot.
    const { point, error } = await this._createRestorePoint(label);
    if (isEmpty) {
      await this.repo.clear();
      this.store.hydrate({});
      return { counts: emptyCounts(), repairs: [], restorePoint: point, restorePointError: error };
    }
    const replaced = await this.repo.replaceAll(parsed.data);
    this.store.hydrate(replaced);
    return { counts: parsed.counts, repairs: parsed.repairs, restorePoint: point, restorePointError: error };
  }

  /**
   * Apply a set of changes a caller planned against this catalogue, each
   * write carrying the token its record had at planning time.
   *
   * The other way in, and the one an upsert takes. `importSnapshot` replaces
   * everything, which is exactly right when the file IS the catalogue and
   * exactly wrong when it is about part of it: a replace deletes whatever
   * another tab created meanwhile, and does so without a single token being
   * checked. Here nothing outside the plan is touched, and a record that
   * moved under the plan's feet fails the batch rather than being
   * overwritten — nothing at all is written in that case, and the caller is
   * expected to plan again against what is now there.
   *
   * @returns {Promise<{changed, restorePoint, restorePointError}>}
   */
  async applyChanges(work, { label = 'Before import' } = {}) {
    const ops = work instanceof UnitOfWork ? work.ops : work;
    if (!Array.isArray(ops)) throw new Error('A change set is required');
    if (!ops.length) return { changed: 0, restorePoint: null, restorePointError: null };
    // A restore point is supposed to hold the catalogue as it is, not as this
    // tab last saw it, so whatever other tabs wrote is read back first.
    // Catching up first is about the plan, not the backup: a requirement is
    // checked against this instance before it is checked against the
    // database, and a mirror that has not heard of a record another tab made
    // would refuse a file that is perfectly good.
    if (typeof this.repo.refresh === 'function') await this.repo.refresh();
    let result;
    try {
      result = await commit(this.repo, this.store, work, this.supportsRestorePoints() ? { restorePoint: label } : {});
    } catch (err) {
      // The plan was built on a catalogue that has moved, and this tab is
      // now the one holding the old story. Reading it back is what makes
      // "try again" mean something: planning from the same stale mirror
      // would fail on the same tokens for ever.
      await this.reload();
      throw err;
    }
    return { changed: ops.length, restorePoint: result.restorePoint || null, restorePointError: null };
  }

  /**
   * Replace everything, with the backup taken by the same operation where the
   * adapter can do that.
   *
   * Reading the catalogue, writing the backup and replacing the data have to
   * be one thing. Done in sequence, a write that lands in between survives
   * the replace and is missing from the backup, so undoing deletes it — the
   * one case a restore point exists to prevent.
   */
  async _replaceAll(data, label) {
    if (this.supportsRestorePoints() && typeof this.repo.replaceAllWithRestorePoint === 'function') {
      const { snapshot, restorePoint } = await this.repo.replaceAllWithRestorePoint(data, label);
      return { snapshot, restorePoint, restorePointError: null };
    }
    const { point, error } = await this._createRestorePoint(label);
    const snapshot = await this.repo.replaceAll(data);
    return { snapshot, restorePoint: point, restorePointError: error };
  }

  /** Catch up with what other tabs wrote: the repository first, then the store. */
  async reload() {
    if (typeof this.repo.refresh === 'function') await this.repo.refresh();
    this.store.hydrate(await this.repo.loadAll());
  }

  // ------------------------------------------------------------ restore points
  supportsRestorePoints() {
    return this.repo.describe().restorePoints === true;
  }

  listRestorePoints() {
    return this.repo.listRestorePoints();
  }

  /**
   * A restore point is a safety net, not the operation itself. Failing to
   * take one must not trap a user whose storage is full (clearing data is
   * their way out), but it must never pass unnoticed either: the caller gets
   * the error back and the UI says the operation cannot be undone.
   */
  async _createRestorePoint(label) {
    if (!this.supportsRestorePoints()) return { point: null, error: null };
    try {
      return { point: await this.repo.createRestorePoint(label), error: null };
    } catch (err) {
      return { point: null, error: err };
    }
  }

  async restore(id) {
    const point = await this.repo.getRestorePoint(id);
    if (!point) throw new Error('Restore point not found');
    const parsed = parseSnapshot(point.data);
    if (!parsed.ok) throw new Error(parsed.errors.join('; '));
    const { snapshot } = await this._replaceAll(parsed.data, 'Before restore');
    this.store.hydrate(snapshot);
    return { counts: parsed.counts, repairs: parsed.repairs };
  }

  deleteRestorePoint(id) {
    return this.repo.deleteRestorePoint(id);
  }
}

function emptyCounts() {
  const out = {};
  for (const c of COLLECTIONS) out[c] = 0;
  return out;
}
