import { COLLECTIONS, ConflictError, NotFoundError, StorageUnavailableError, clone, tokenOf } from './repository.js';
import { splitList } from '../utils/text.js';
import { MemoryRepository, UniquenessError } from './memory-repository.js';
import { UNIQUE_KEYS, uniqueKeyOf } from '../core/collections.js';

const DB_NAME = 'metric-studio';
export const DB_VERSION = 5; // v5: reports + metricReports object stores
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
  constructor({ dbName = DB_NAME, indexedDB = globalThis.indexedDB, blockedTimeoutMs = 4000 } = {}) {
    super();
    this._dbName = dbName;
    this._idb = indexedDB || null;
    this._blockedTimeoutMs = blockedTimeoutMs;
    this._db = null;
    this._persistent = false;
    this._error = null;
    // Why persistence is off, when it is: 'unsupported' (no IndexedDB at
    // all), 'blocked' (an older tab holds the database), 'upgrade-failed',
    // 'open-failed', or 'superseded' (a newer tab upgraded it under us).
    this._reason = this._idb ? null : 'unsupported';
    this._migration = null;
  }

  describe() {
    return {
      persistent: this._persistent,
      kind: this._persistent ? 'indexeddb' : 'memory',
      atomicBatch: true,
      restorePoints: true,
      // A session that never had IndexedDB, or whose user chose to continue
      // without it, writes to memory on purpose and is told so. A connection
      // that was durable and then lost is a different thing: its writes are
      // refused, because acknowledging them would be a lie.
      writable: this._reason !== 'superseded',
      reason: this._persistent ? null : this._reason,
      // "No IndexedDB" is the only case where nothing of the user's can be
      // on disk. Every other failure means a database exists that this
      // session could not open, and the app must not seed a demo over it.
      hasExistingData: !this._persistent && this._reason != null && this._reason !== 'unsupported',
      migration: this._migration,
      detail: this._error ? String(this._error.message || this._error) : '',
    };
  }

  async init() {
    if (!this._idb) return this;
    try {
      const opened = await openDatabase(this._idb, this._dbName, DB_VERSION, { blockedTimeoutMs: this._blockedTimeoutMs });
      this._db = opened.db;
      this._migration = opened.migration;
      this._persistent = true;
      this._reason = null;
      // A newer release in another tab wants to upgrade the database. Step
      // aside — holding on would block it forever, since it cannot know we
      // are here — and stop pretending to persist.
      this._db.onversionchange = () => {
        this._db.close();
        this._db = null;
        this._persistent = false;
        this._reason = 'superseded';
        this._error = new Error('Another tab opened a newer version of Metric Studio');
        this._emitStatus();
      };
      await this.refresh();
    } catch (err) {
      this._error = err;
      this._db = null;
      this._persistent = false;
      this._reason = err && err.reason ? err.reason : 'open-failed';
    }
    return this;
  }

  /**
   * Re-read everything from the database into the mirror. What another tab
   * wrote since this one loaded is invisible until then; the app calls this
   * when it regains focus, and tests call it to model a tab catching up.
   */
  async refresh() {
    if (!this._db) return this;
    for (const c of COLLECTIONS) {
      const rows = await idbRequest(this._db.transaction(c, 'readonly').objectStore(c).getAll());
      const map = new Map();
      for (const r of rows) if (r && r.id) map.set(r.id, r);
      this._data[c] = map;
    }
    const points = await idbRequest(this._db.transaction(RESTORE_STORE, 'readonly').objectStore(RESTORE_STORE).getAll());
    this._restorePoints = new Map();
    for (const p of points) {
      if (!p || !p.id) continue;
      this._restorePoints.set(p.id, p);
      this._restoreSeq = Math.max(this._restoreSeq, p.seq || 0);
    }
    return this;
  }

  /**
   * A durable connection that was lost refuses every write. The memory
   * session a user knowingly continues in (no IndexedDB, or a database that
   * would not open) keeps writing to memory, as it always did.
   */
  _assertWritable() {
    if (this._reason === 'superseded') throw new StorageUnavailableError('superseded', this._error ? this._error.message : '');
  }

  /** One transaction for the whole plan: all of it lands, or none of it does. */
  async _commit(plan) {
    if (!this._db) {
      this._assertWritable();
      return;
    }
    const { clearAll = false, puts = [], deletes = [], guards = [], requires = [] } = plan;
    const touched = new Set();
    if (clearAll) {
      for (const c of COLLECTIONS) touched.add(c);
      // The catalogue is about to be someone else's; codes are re-derived
      // from it. Cleared in the same transaction, so no allocation can slip
      // in between the old sequence and the new data.
      touched.add(SEQUENCE_STORE);
    }
    for (const p of puts) touched.add(p.collection);
    for (const d of deletes) touched.add(d.collection);
    for (const g of guards) touched.add(g.collection);
    for (const r of requires) touched.add(r.collection);
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
    const refreshWhole = [];
    try {
      const uniqueCollections = [...touched].filter((c) => UNIQUE_KEYS[c]);
      await commitChecked(tx, { checks, requires, guards, uniqueCollections }, (onWriteError) => {
        if (clearAll) {
          for (const c of COLLECTIONS) tx.objectStore(c).clear();
          tx.objectStore(SEQUENCE_STORE).clear();
        }
        // Deletes go first: a batch may free a unique relationship and
        // re-create it, and the index judges each put against what is in the
        // store at that moment. The contract promises removals are planned
        // first; writing them first is what keeps that promise here.
        for (const d of deletes) tx.objectStore(d.collection).delete(d.id);
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
      }, {
        onStale: (collection, id, stored) => stale.push({ collection, id, stored }),
        onGuardFailed: (collection, records) => refreshWhole.push({ collection, records }),
      });
    } catch (err) {
      // No wait for the transaction here: commitChecked only settles on the
      // transaction's own complete/abort/error, so it is already finished.
      // Attaching fresh handlers to a finished transaction would wait for
      // events that can never fire again.
      // Whatever the database actually held is now known; the mirror stops
      // repeating what it wrongly believed, so a retry is judged against the
      // truth rather than failing the same way again.
      this._refreshMirror(stale);
      for (const { collection, records } of refreshWhole) this._replaceMirror(collection, records);
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

  /** A guard read the whole collection; the mirror may as well learn it. */
  _replaceMirror(collection, records) {
    if (!this._data[collection]) return;
    const map = new Map();
    for (const r of records) if (r && r.id) map.set(r.id, r);
    this._data[collection] = map;
  }

  /**
   * Read the sequence and write it back inside one transaction, so two tabs
   * allocating at the same moment are serialised by the database rather than
   * by each connection's own memory. The first allocation of a session has no
   * stored sequence yet, so the floor is derived from the records themselves.
   */
  async _nextSequenceValue(desc) {
    if (!this._db) {
      this._assertWritable();
      return super._nextSequenceValue(desc);
    }
    const { key, collection, floorOf } = desc;
    // The floor comes from the records in the database, read in the same
    // transaction: this connection's mirror does not know what another tab
    // imported a moment ago. What this connection remembers is deliberately
    // ignored — after another tab replaced the catalogue it is just wrong.
    const tx = this._db.transaction([SEQUENCE_STORE, collection], 'readwrite');
    const seqStore = tx.objectStore(SEQUENCE_STORE);
    const value = await new Promise((resolve, reject) => {
      let out = null;
      tx.oncomplete = () => resolve(out);
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      const rows = tx.objectStore(collection).getAll();
      rows.onerror = () => reject(rows.error || new Error('IndexedDB read failed'));
      rows.onsuccess = () => {
        const floor = floorOf(rows.result || []);
        const req = seqStore.get(key);
        req.onerror = () => reject(req.error || new Error('IndexedDB read failed'));
        req.onsuccess = () => {
          const stored = req.result && Number.isInteger(req.result.next) ? req.result.next : 0;
          out = Math.max(stored, floor);
          seqStore.put({ id: key, next: out + 1 });
        };
      };
    });
    return value;
  }

  async _commitRestorePoint(point) {
    if (!this._db) {
      this._assertWritable();
      return;
    }
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
    if (!this._db) {
      this._assertWritable();
      return;
    }
    const tx = this._db.transaction(RESTORE_STORE, 'readwrite');
    tx.objectStore(RESTORE_STORE).delete(id);
    await txDone(tx);
  }

  close() {
    if (this._db) this._db.close();
    this._db = null;
  }
}

/**
 * Open the database at the current schema version, upgrading if needed.
 *
 * The unique index on each relationship store is created only after the
 * store has been deduplicated: a database written by an earlier release may
 * legitimately hold the same relationship twice, and creating a unique index
 * over duplicates aborts the whole upgrade — which used to leave the user
 * looking at a demo catalogue with their own data invisible on disk. The
 * primary placement wins; otherwise the first by id.
 *
 * An open blocked by an older tab is given a moment: a tab running this
 * release steps aside on versionchange. One that does not is reported as
 * `blocked`, never as an empty database.
 */
function openDatabase(idb, name, version, { blockedTimeoutMs = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    let req;
    const migration = { deduplicated: 0, removed: [], ownersMigrated: 0 };
    let blockedTimer = null;
    let settled = false;
    const finish = (fn) => (value) => {
      if (settled) return;
      settled = true;
      if (blockedTimer) clearTimeout(blockedTimer);
      fn(value);
    };
    const ok = finish(resolve);
    const bad = finish(reject);
    try {
      req = idb.open(name, version);
    } catch (err) {
      bad(tagged(err, 'open-failed'));
      return;
    }
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const tx = req.transaction;
      const oldVersion = event && Number.isFinite(event.oldVersion) ? event.oldVersion : 0;
      tx.onabort = () => bad(tagged(tx.error || new Error('Upgrade aborted'), 'upgrade-failed'));
      for (const c of COLLECTIONS) {
        const store = db.objectStoreNames.contains(c) ? tx.objectStore(c) : db.createObjectStore(c, { keyPath: 'id' });
        const fields = UNIQUE_KEYS[c];
        if (!fields || store.indexNames.contains(UNIQUE_INDEX)) continue;
        // The composite key of a structural relationship, enforced by the
        // database itself. A client-side scan only sees this connection's
        // mirror, so two tabs could each decide a relationship was free.
        dedupeThenIndex(store, c, fields, migration);
      }
      if (!db.objectStoreNames.contains(RESTORE_STORE)) db.createObjectStore(RESTORE_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(SEQUENCE_STORE)) db.createObjectStore(SEQUENCE_STORE, { keyPath: 'id' });
      // v4: a metric has `owners` (several), no longer `owner` (one). Records
      // written by an earlier release are rewritten in place — same id, same
      // version and token, same timestamps — so nothing else notices.
      if (oldVersion < 4 && oldVersion > 0) migrateOwners(tx.objectStore('metrics'), migration);
    };
    req.onsuccess = () => ok({ db: req.result, migration });
    req.onerror = () => bad(tagged(req.error || new Error('IndexedDB open failed'), req.error && req.error.name === 'AbortError' ? 'upgrade-failed' : 'open-failed'));
    req.onblocked = () => {
      // Another tab still holds the older version. Give it the time a tab of
      // this release needs to close on versionchange; an older one never will.
      if (blockedTimer) return;
      blockedTimer = setTimeout(() => bad(tagged(new Error('Another tab is holding an older version of the database'), 'blocked')), blockedTimeoutMs);
    };
  });
}

function tagged(err, reason) {
  const e = err instanceof Error ? err : new Error(String(err));
  e.reason = reason;
  return e;
}

/**
 * Walk the store inside the upgrade transaction, delete every record whose
 * composite key was already seen, then create the unique index — all before
 * the transaction can commit, because the index creation is issued from the
 * cursor's last callback.
 */
function dedupeThenIndex(store, collection, fields, migration) {
  const seen = new Map();
  const survivors = new Map();
  const cursor = store.openCursor();
  cursor.onsuccess = () => {
    const cur = cursor.result;
    if (cur) {
      const record = cur.value;
      const key = uniqueKeyOf(collection, record);
      const prior = survivors.get(key);
      if (!prior) {
        survivors.set(key, record);
        seen.set(key, cur.primaryKey);
      } else if (record.isPrimary && !prior.isPrimary) {
        // Keep the primary placement, drop the earlier non-primary one.
        store.delete(seen.get(key));
        migration.removed.push({ collection, id: prior.id });
        migration.deduplicated += 1;
        survivors.set(key, record);
        seen.set(key, cur.primaryKey);
      } else {
        cur.delete();
        migration.removed.push({ collection, id: record.id });
        migration.deduplicated += 1;
      }
      cur.continue();
      return;
    }
    store.createIndex(UNIQUE_INDEX, fields, { unique: true });
  };
}

/**
 * Rewrite `owner: 'Alice'` as `owners: ['Alice']` inside the upgrade
 * transaction. A record that already carries `owners` keeps it; a legacy
 * `owner` is only used when `owners` is absent or empty, so no stored value
 * is silently replaced by an empty list.
 */
function migrateOwners(store, migration) {
  const cursor = store.openCursor();
  cursor.onsuccess = () => {
    const cur = cursor.result;
    if (!cur) return;
    const record = cur.value;
    if (record && typeof record === 'object' && ('owner' in record || !Array.isArray(record.owners))) {
      const owners = Array.isArray(record.owners) && record.owners.length ? record.owners : splitList(record.owner);
      const next = { ...record, owners };
      delete next.owner;
      cur.update(next);
      migration.ownersMigrated += 1;
    }
    cur.continue();
  };
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
function commitChecked(tx, { checks, requires, guards, uniqueCollections }, write, { onStale, onGuardFailed }) {
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
    if (!checks.length && !guardReads.length && !requires.length) {
      finish();
      return;
    }
    let pending = checks.length + guardReads.length + requires.length;
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
    // A record the batch depends on must still be there where the data lives.
    for (const r of requires) {
      let req;
      try {
        req = tx.objectStore(r.collection).get(r.id);
      } catch (err) {
        fail(err);
        settle();
        continue;
      }
      req.onsuccess = () => {
        if (!req.result) {
          onStale(r.collection, r.id, null);
          fail(new NotFoundError(r.collection, r.id));
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
          // The guard saw the truth; hand it to the mirror so the retry does.
          onGuardFailed(entry.guard.collection, (req.result || []).map(clone));
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
