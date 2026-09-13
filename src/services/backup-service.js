import { COLLECTIONS, SCHEMA_VERSION } from '../core/collections.js';
import { parseSnapshot, APP_ID } from './snapshot-schema.js';

/**
 * BackupService — JSON export, validated import, and the restore points that
 * make every destructive operation reversible.
 *
 * No snapshot reaches the repository without passing `parseSnapshot` first,
 * and no replace happens without a restore point being written first (when
 * the repository supports them), so a bad import is always undoable.
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
   * What an import would do, including what it would delete. Import always
   * replaces, so a file that omits a collection empties it; the caller must
   * show that before asking for confirmation.
   */
  preview(json) {
    const parsed = parseSnapshot(json);
    const willDelete = {};
    let deleteTotal = 0;
    for (const c of COLLECTIONS) {
      const current = this.store.count(c);
      const incoming = parsed.ok ? parsed.counts[c] : 0;
      const lost = parsed.ok && incoming === 0 && current > 0 ? current : 0;
      willDelete[c] = lost;
      deleteTotal += lost;
    }
    return { ...parsed, willDelete, deleteTotal };
  }

  /**
   * Replace everything with a validated snapshot.
   * @returns {Promise<{counts, repairs, restorePoint}>}
   */
  async importSnapshot(json, { label = 'Before import' } = {}) {
    const parsed = json && json.ok === true && json.data ? json : parseSnapshot(json);
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
