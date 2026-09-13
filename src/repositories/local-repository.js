import { COLLECTIONS, ConflictError, clone, tokenOf } from './repository.js';
import { MemoryRepository, UniquenessError } from './memory-repository.js';
import { UNIQUE_KEYS, uniqueKeyOf } from '../core/collections.js';

const DB_NAME = 'metric-studio';
const DB_VERSION = 3;
const RESTORE_STORE = '_restorePoints';
const SEQUENCE_STORE = '_sequences';
const UNIQUE_INDEX = 'uk';

/**
 * Browser-local persistence: the in-memory mirror inherited from
 * MemoryRepository, made durable in IndexedDB.
 *
 * Every plan is committed inside ONE IndexedDB transaction spanning all the
 * object stores it touches, so a failure halfway through an import or a
 * cascading delete leaves the database exactly as it was. The memory mirror
 * is only updated once that transaction completes.
 *
 * The mirror speaks only for this connection. A second tab has its own, so a
 * token compared against the mirror says nothing about what is in the
 * database — two tabs could both pass that check and the second would
 * silently overwrite the first. Every expected token is therefore compared
 * again inside the same readwrite transaction that performs the write, and
 * structural uniqueness is enforced by unique IndexedDB indexes rather than
 * by scanning the mirror. The database is the arbiter; the mirror is a cache,
 * and a failed check refreshes it from what was actually read.
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
    const { clearAll = false, puts = [], deletes = [], guards = [] } = plan;
    const touched = new Set();
    if (clearAll) for (const c of COLLECTIONS) touched.add(c);
    for (const p of puts) touched.add(p.collection);
    for (const d of deletes) touched.add(d.collection);
    for (const g of guards) touched.add(g.collection);
    if (touched.size === 0) return;

    // A wholesale replacement (import, restore, seed) deliberately overwrites
    // whatever is there, so it carries no expectations to check.
    const checks = [];
    if (!clearAll) {
      for (const p of puts) {
        if (p.expected === undefined) continue;
        checks.push({ collection: p.collection, id: p.record.id, expected: p.expected, optional: false });
      }
      for (const d of deletes) {
        if (d.expected == null) continue;
        checks.push({ collection: d.collection, id: d.id, expected: d.expected, optional: d.optional === true });
      }
    }

    const tx = this._db.transaction([...touched], 'readwrite');
    const stale = [];
    try {
      const uniqueCollections = [...touched].filter((c) => UNIQUE_KEYS[c]);
      await commitChecked(tx, checks, guards, uniqueCollections, (onWriteError) => {
        if (clearAll) for (const c of COLLECTIONS) tx.objectStore(c).clear();
        // put() throws synchronously on an unclonable value or a bad key, and
        // a unique index rejects a duplicate relationship asynchronously.
        // Either way the transaction is aborted, so the requests queued
        // before it never land.
        for (const p of puts) {
          const req = tx.objectStore(p.collection).put(p.record);
          // A unique index rejects the duplicate on the request, not on the
          // transaction, so the reason has to be caught here to reach the
          // caller as a UniquenessError rather than as "transaction failed".
          req.onerror = () => onWriteError(p.collection, req.error, uniqueKeyOf(p.collection, p.record));
        }
        for (const d of deletes) tx.objectStore(d.collection).delete(d.id);
      }, (collection, id, stored) => stale.push({ collection, id, stored }));
    } catch (err) {
      // No wait for the transaction here: commitChecked only settles on the
      // transaction's own complete/abort/error, so it is already finished.
      // Attaching fresh handlers to a finished transaction would wait for
      // events that can never fire again.
      // Whatever the database actually held is now known; the mirror stops
      // repeating what it wrongly believed, so a retry is judged against the
      // truth rather than failing the same way again.
      this._refreshMirror(stale);
      throw err;
    }
  }

  /** Replace mirror entries with what the database turned out to hold. */
  _refreshMirror(entries) {
    for (const { collection, id, stored } of entries) {
      if (!this._data[collection]) continue;
      if (stored) this._data[collection].set(id, stored);
      else this._data[collection].delete(id);
    }
  }

  /**
   * Read the sequence and write it back inside one transaction, so two tabs
   * allocating at the same moment are serialised by the database rather than
   * by each connection's own memory. The first allocation of a session has no
   * stored sequence yet, so the floor is derived from the records themselves.
   */
  async _nextSequenceValue(key, remembered, floor) {
    if (!this._db) return super._nextSequenceValue(key, remembered, floor);
    const tx = this._db.transaction(SEQUENCE_STORE, 'readwrite');
    const store = tx.objectStore(SEQUENCE_STORE);
    const value = await new Promise((resolve, reject) => {
      let out = null;
      tx.oncomplete = () => resolve(out);
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      const req = store.get(key);
      req.onsuccess = () => {
        const stored = req.result && Number.isInteger(req.result.next) ? req.result.next : 0;
        out = Math.max(stored, remembered ?? 0, floor());
        store.put({ id: key, next: out + 1 });
      };
      req.onerror = () => reject(req.error || new Error('IndexedDB read failed'));
    });
    return value;
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

  async _clearSequences() {
    if (!this._db) return;
    const tx = this._db.transaction(SEQUENCE_STORE, 'readwrite');
    tx.objectStore(SEQUENCE_STORE).clear();
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
      const tx = req.transaction;
      for (const c of COLLECTIONS) {
        const store = db.objectStoreNames.contains(c) ? tx.objectStore(c) : db.createObjectStore(c, { keyPath: 'id' });
        // The composite key of a structural relationship, enforced by the
        // database itself. A client-side scan only sees this connection's
        // mirror, so two tabs could each decide a relationship was free.
        const fields = UNIQUE_KEYS[c];
        if (fields && !store.indexNames.contains(UNIQUE_INDEX)) store.createIndex(UNIQUE_INDEX, fields, { unique: true });
      }
      if (!db.objectStoreNames.contains(RESTORE_STORE)) db.createObjectStore(RESTORE_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(SEQUENCE_STORE)) db.createObjectStore(SEQUENCE_STORE, { keyPath: 'id' });
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

/**
 * Compare every expected token against the database, then write — all inside
 * one readwrite transaction, so nothing can change between the check and the
 * write. The reads are issued together and the writes only from the last
 * read's callback, which keeps the transaction alive without awaiting inside
 * it.
 */
function commitChecked(tx, checks, guards, uniqueCollections, write, onStale) {
  return new Promise((resolve, reject) => {
    let failure = null;
    const fail = (err) => { if (!failure) failure = err; };
    const onWriteError = (collection, err, key) => {
      if (err && err.name === 'ConstraintError') fail(new UniquenessError(collection, key || 'unique index'));
      else fail(err || new Error('IndexedDB write failed'));
    };
    const finish = () => {
      if (failure) {
        abort(tx);
        return;
      }
      try {
        write(onWriteError);
      } catch (err) {
        fail(err);
        abort(tx);
      }
    };
    tx.oncomplete = () => (failure ? reject(failure) : resolve());
    const translate = (err) => (err && err.name === 'ConstraintError'
      ? new UniquenessError(uniqueCollections.join('/') || 'unknown', String(err.message || 'unique index'))
      : err);
    tx.onabort = () => reject(failure || translate(tx.error) || new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(failure || translate(tx.error) || new Error('IndexedDB transaction failed'));
    // Guards read whole collections from the database, so the invariant is
    // judged on what is actually stored rather than on a mirror that another
    // connection has already made obsolete.
    const guardReads = guards.map((g) => ({ guard: g, req: null }));
    if (!checks.length && !guardReads.length) {
      finish();
      return;
    }
    let pending = checks.length + guardReads.length;
    const settle = () => {
      pending -= 1;
      if (pending === 0) finish();
    };
    for (const check of checks) {
      let req;
      try {
        req = tx.objectStore(check.collection).get(check.id);
      } catch (err) {
        fail(err);
        settle();
        continue;
      }
      req.onsuccess = () => {
        const stored = req.result || null;
        const actual = stored ? tokenOf(stored) : null;
        // An optional removal exists to tidy up after a record that may
        // already be gone; only a record that is still there with a
        // different token is a conflict.
        const gone = stored === null;
        if (actual !== check.expected && !(gone && check.optional)) {
          onStale(check.collection, check.id, stored ? clone(stored) : null);
          fail(new ConflictError(check.collection, check.id, check.expected, stored ? clone(stored) : null));
        }
        settle();
      };
      req.onerror = () => {
        fail(req.error || new Error('IndexedDB read failed'));
        settle();
      };
    }
    for (const entry of guardReads) {
      let req;
      try {
        req = tx.objectStore(entry.guard.collection).getAll();
      } catch (err) {
        fail(err);
        settle();
        continue;
      }
      req.onsuccess = () => {
        try {
          entry.guard.check(req.result || []);
        } catch (err) {
          fail(err);
        }
        settle();
      };
      req.onerror = () => {
        fail(req.error || new Error('IndexedDB read failed'));
        settle();
      };
    }
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
