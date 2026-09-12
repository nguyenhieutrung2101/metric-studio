import { COLLECTIONS } from './repository.js';
import { MemoryRepository } from './memory-repository.js';

const DB_NAME = 'metric-studio';
const DB_VERSION = 1;

/**
 * Browser-local persistence: an in-memory mirror (inherited) with write-through
 * to IndexedDB. Reads are served from memory; every acknowledged write is
 * committed to IndexedDB before the memory mirror is updated.
 *
 * When IndexedDB is unavailable (private mode, some file:// contexts) the
 * repository keeps working in memory and reports persistent=false so the UI
 * can warn the user.
 */
export class LocalRepository extends MemoryRepository {
  constructor({ dbName = DB_NAME, indexedDB = globalThis.indexedDB } = {}) {
    super();
    this._dbName = dbName;
    this._idb = indexedDB || null;
    this._db = null;
    this._persistent = false;
    this._error = null;
  }

  describe() {
    return { persistent: this._persistent, kind: this._persistent ? 'indexeddb' : 'memory', detail: this._error ? String(this._error.message || this._error) : '' };
  }

  async init() {
    if (!this._idb) return this;
    try {
      this._db = await openDatabase(this._idb, this._dbName, DB_VERSION);
      this._persistent = true;
      for (const c of COLLECTIONS) {
        const rows = await idbRequest(this._db.transaction(c, 'readonly').objectStore(c).getAll());
        const map = this._data[c];
        map.clear();
        for (const r of rows) if (r && r.id) map.set(r.id, r);
      }
    } catch (err) {
      this._error = err;
      this._db = null;
      this._persistent = false;
    }
    return this;
  }

  async _persist(collection, record) {
    if (!this._db) return;
    const tx = this._db.transaction(collection, 'readwrite');
    tx.objectStore(collection).put(record);
    await txDone(tx);
  }

  async _persistMany(collection, records) {
    if (!this._db || records.length === 0) return;
    const tx = this._db.transaction(collection, 'readwrite');
    const store = tx.objectStore(collection);
    for (const r of records) store.put(r);
    await txDone(tx);
  }

  async _delete(collection, id) {
    if (!this._db) return;
    const tx = this._db.transaction(collection, 'readwrite');
    tx.objectStore(collection).delete(id);
    await txDone(tx);
  }

  async _clearAll() {
    if (!this._db) return;
    const tx = this._db.transaction([...COLLECTIONS], 'readwrite');
    for (const c of COLLECTIONS) tx.objectStore(c).clear();
    await txDone(tx);
  }

  close() {
    if (this._db) this._db.close();
    this._db = null;
  }
}

function openDatabase(idb, name, version) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = idb.open(name, version);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const c of COLLECTIONS) {
        if (!db.objectStoreNames.contains(c)) db.createObjectStore(c, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

function idbRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}
