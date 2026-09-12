import { COLLECTIONS, SCHEMA_VERSION } from '../core/collections.js';

const APP_ID = 'metric-studio';

/** JSON backup: export the whole store, validate and import a file. */
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

  static inspect(json) {
    let payload = json;
    if (typeof json === 'string') {
      try {
        payload = JSON.parse(json);
      } catch (err) {
        return { ok: false, errors: [`Invalid JSON: ${err.message}`], counts: {} };
      }
    }
    const errors = [];
    if (!payload || typeof payload !== 'object') return { ok: false, errors: ['Backup must be a JSON object'], counts: {} };
    // Accept either the wrapped form { app, data } or a bare snapshot.
    const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
    if (payload.app && payload.app !== APP_ID) errors.push(`Unexpected app id "${payload.app}"`);
    if (payload.schemaVersion && payload.schemaVersion > SCHEMA_VERSION) errors.push(`Schema version ${payload.schemaVersion} is newer than this app supports (${SCHEMA_VERSION})`);
    const counts = {};
    for (const c of COLLECTIONS) {
      const arr = data[c];
      if (arr == null) {
        counts[c] = 0;
        continue;
      }
      if (!Array.isArray(arr)) {
        errors.push(`"${c}" must be an array`);
        continue;
      }
      const bad = arr.filter((r) => !r || typeof r !== 'object' || !r.id).length;
      if (bad) errors.push(`"${c}" has ${bad} record(s) without an id`);
      counts[c] = arr.length;
    }
    if (!COLLECTIONS.some((c) => counts[c] > 0)) errors.push('Backup contains no records');
    return { ok: errors.length === 0, errors, counts, data };
  }

  async importSnapshot(json) {
    const check = BackupService.inspect(json);
    if (!check.ok) throw new Error(check.errors.join('; '));
    const saved = await this.repo.replaceAll(check.data);
    this.store.hydrate(saved);
    return check.counts;
  }
}
