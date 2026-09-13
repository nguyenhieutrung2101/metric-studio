import { COLLECTIONS } from './repository.js';
import { MemoryRepository } from './memory-repository.js';

const DB_NAME = 'metric-studio';
const DB_VERSION = 2;
const RESTORE_STORE = '_restorePoints';

/**
 * Browser-local persistence: the in-memory mirror inherited from
 * MemoryRepository, made durable in IndexedDB.
 *
 * Every plan is committed inside ONE IndexedDB transaction spanning all the
 * object stores it touches, so a failure halfway through an import or a
 * cascading delete leaves the database exactly as it was. The memory mirror
 * is only updated once that transaction completes.
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
    return {
      persistent: this._persistent,
      kind: this._persistent ? 'indexeddb' : 'memory',
      atomicBatch: true,
      restorePoints: true,
      detail: this._error ? String(this._error.message || this._error) : '',
    };
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
      const points = await idbRequest(this._db.transaction(RESTORE_STORE, 'readonly').objectStore(RESTORE_STORE).getAll());
      for (const p of points) {
        if (!p || !p.id) continue;
        this._restorePoints.set(p.id, p);
        this._restoreSeq = Math.max(this._restoreSeq, p.seq || 0);
      }
    } catch (err) {
      this._error = err;
      this._db = null;
      this._persistent = false;
    }
    return this;
  }

  /** One transaction for the whole plan: all of it lands, or none of it does. */
  async _commit(plan) {
    if (!this._db) return;
    const { clearAll = false, puts = [], deletes = [] } = plan;
    const touched = new Set();
    if (clearAll) for (const c of COLLECTIONS) touched.add(c);
    for (const p of puts) touched.add(p.collection);
    for (const d of deletes) touched.add(d.collection);
    if (touched.size === 0) return;
    const tx = this._db.transaction([...touched], 'readwrite');
    try {
      if (clearAll) for (const c of COLLECTIONS) tx.objectStore(c).clear();
      for (const p of puts) tx.objectStore(p.collection).put(p.record);
      for (const d of deletes) tx.objectStore(d.collection).delete(d.id);
    } catch (err) {
      // put() throws synchronously on an unclonable value or a bad key. The
      // requests queued before it would otherwise still commit, leaving the
      // database changed while the caller is told the write failed.
      abort(tx);
      await txSettled(tx);
      throw err;
    }
    await txDone(tx);
  }

  async _commitRestorePoint(point) {
    if (!this._db) return;
    const tx = this._db.transaction(RESTORE_STORE, 'readwrite');
    try {
      tx.objectStore(RESTORE_STORE).put(point);
    } catch (err) {
      abort(tx);
      await txSettled(tx);
      throw err;
    }
    await txDone(tx);
  }

  async _deleteRestorePoint(id) {
    if (!this._db) return;
    const tx = this._db.transaction(RESTORE_STORE, 'readwrite');
    tx.objectStore(RESTORE_STORE).delete(id);
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
      if (!db.objectStoreNames.contains(RESTORE_STORE)) db.createObjectStore(RESTORE_STORE, { keyPath: 'id' });
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

function abort(tx) {
  try {
    tx.abort();
  } catch {
    /* already finished or aborting */
  }
}

/** Resolve once the transaction has finished, however it finished. */
function txSettled(tx) {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}
