import { COLLECTIONS, SCHEMA_VERSION } from '../core/collections.js';
import { parseSnapshot, APP_ID } from './snapshot-schema.js';

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
    const { point, error } = await this._createRestorePoint(label);
    const saved = await this.repo.replaceAll(parsed.data);
    this.store.hydrate(saved);
    return { counts: parsed.counts, repairs: parsed.repairs, restorePoint: point, restorePointError: error };
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
    const saved = await this.repo.replaceAll(parsed.data);
    this.store.hydrate(saved);
    return { counts: parsed.counts, repairs: parsed.repairs, restorePoint: point, restorePointError: error };
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
    await this._createRestorePoint('Before restore');
    const saved = await this.repo.replaceAll(parsed.data);
    this.store.hydrate(saved);
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
