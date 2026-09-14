import { COLLECTIONS } from '../collections.js';
import { EventBus } from './events.js';

/**
 * In-memory normalised state. The store is a cache of what the repository
 * has acknowledged; services write to the repository first and then call
 * upsert/remove here. Each collection has a revision counter that selectors
 * use to memoise derived indexes.
 *
 * Events: 'change' -> { collection, type: 'upsert'|'remove'|'hydrate', ids }
 */
export class Store {
  constructor(events = new EventBus()) {
    this.events = events;
    this.data = {};
    this.revision = {};
    this._listCache = {};
    for (const c of COLLECTIONS) {
      this.data[c] = new Map();
      this.revision[c] = 0;
      this._listCache[c] = null;
    }
    this.globalRevision = 0;
    // Whether this cache is known to match the backend. A partial batch that
    // could not be reconciled marks the collections it touched as unsynced;
    // the next hydrate clears it.
    this.sync = { ok: true, collections: [], error: null };
  }

  /** Events: 'sync' -> { ok, collections, error } */
  markUnsynced(collections, error = null) {
    const set = new Set([...(this.sync.ok ? [] : this.sync.collections), ...collections]);
    this.sync = { ok: false, collections: [...set], error };
    this.events.emit('sync', this.sync);
  }

  markSynced() {
    if (this.sync.ok) return;
    this.sync = { ok: true, collections: [], error: null };
    this.events.emit('sync', this.sync);
  }

  _touch(collection) {
    this.revision[collection] += 1;
    this.globalRevision += 1;
    this._listCache[collection] = null;
  }

  _assertCollection(collection) {
    if (!this.data[collection]) throw new Error(`Unknown collection "${collection}"`);
  }

  hydrate(snapshot = {}) {
    for (const c of COLLECTIONS) {
      const map = new Map();
      for (const rec of snapshot[c] || []) {
        if (rec && rec.id) map.set(rec.id, rec);
      }
      this.data[c] = map;
      this._touch(c);
    }
    this.markSynced();
    this.events.emit('change', { collection: '*', type: 'hydrate', ids: [] });
  }

  list(collection) {
    this._assertCollection(collection);
    if (!this._listCache[collection]) this._listCache[collection] = [...this.data[collection].values()];
    return this._listCache[collection];
  }

  get(collection, id) {
    this._assertCollection(collection);
    return this.data[collection].get(id) || null;
  }

  has(collection, id) {
    this._assertCollection(collection);
    return this.data[collection].has(id);
  }

  count(collection) {
    this._assertCollection(collection);
    return this.data[collection].size;
  }

  upsert(collection, record) {
    this._assertCollection(collection);
    if (!record || !record.id) throw new Error('record.id is required');
    this.data[collection].set(record.id, record);
    this._touch(collection);
    this.events.emit('change', { collection, type: 'upsert', ids: [record.id] });
    return record;
  }

  upsertMany(collection, records) {
    this._assertCollection(collection);
    const ids = [];
    for (const record of records) {
      if (!record || !record.id) continue;
      this.data[collection].set(record.id, record);
      ids.push(record.id);
    }
    if (ids.length) {
      this._touch(collection);
      this.events.emit('change', { collection, type: 'upsert', ids });
    }
    return ids;
  }

  remove(collection, id) {
    this._assertCollection(collection);
    const existed = this.data[collection].delete(id);
    if (existed) {
      this._touch(collection);
      this.events.emit('change', { collection, type: 'remove', ids: [id] });
    }
    return existed;
  }

  removeMany(collection, ids) {
    this._assertCollection(collection);
    const removed = [];
    for (const id of ids) if (this.data[collection].delete(id)) removed.push(id);
    if (removed.length) {
      this._touch(collection);
      this.events.emit('change', { collection, type: 'remove', ids: removed });
    }
    return removed;
  }

  /**
   * Apply a whole batch at once: every collection is mutated before the first
   * event fires, so no listener can observe a half-applied cascade.
   * @param {{upserts?: Object<string, object[]>, removals?: Object<string, string[]>}} changes
   */
  applyChanges({ upserts = {}, removals = {} } = {}) {
    const touched = new Map();
    for (const [collection, records] of Object.entries(upserts)) {
      this._assertCollection(collection);
      const ids = [];
      for (const record of records || []) {
        if (!record || !record.id) continue;
        this.data[collection].set(record.id, record);
        ids.push(record.id);
      }
      if (ids.length) touched.set(collection, { type: 'upsert', ids });
    }
    for (const [collection, list] of Object.entries(removals)) {
      this._assertCollection(collection);
      const ids = [];
      for (const id of list || []) if (this.data[collection].delete(id)) ids.push(id);
      if (ids.length) {
        const prev = touched.get(collection);
        touched.set(collection, { type: prev ? 'mixed' : 'remove', ids: prev ? [...prev.ids, ...ids] : ids });
      }
    }
    for (const collection of touched.keys()) this._touch(collection);
    for (const [collection, evt] of touched) this.events.emit('change', { collection, type: evt.type, ids: evt.ids });
    return touched.size;
  }

  /** Plain-object snapshot (arrays per collection), safe to serialise. */
  snapshot() {
    const out = {};
    for (const c of COLLECTIONS) out[c] = [...this.data[c].values()];
    return out;
  }

  revisionOf(collections) {
    return collections.map((c) => this.revision[c]).join(':');
  }
}
