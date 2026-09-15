import { IDBFactory } from 'fake-indexeddb';
import { LocalRepository } from '../src/repositories/local-repository.js';
import { Store } from '../src/core/store/store.js';
import { createSelectors } from '../src/core/store/selectors.js';
import { MetricService } from '../src/services/metric-service.js';
import { StructureService } from '../src/services/structure-service.js';
import { ReportService } from '../src/services/report-service.js';
import { BindingService } from '../src/services/binding-service.js';
import { DimensionService } from '../src/services/dimension-service.js';
import { DependencyService } from '../src/services/dependency-service.js';
import { BackupService } from '../src/services/backup-service.js';
import { buildDemoSnapshot } from '../src/data/seed.js';

/**
 * IndexedDB fixtures over fake-indexeddb.
 *
 * One IDBFactory is one browser profile: two repositories opened on the same
 * factory and database name are two tabs of the same app, each with its own
 * mirror and its own store, sharing nothing but the database. That is the
 * shape every cross-tab test needs, and it is exactly the shape the
 * MemoryRepository tests cannot produce.
 */
export function freshFactory() {
  return new IDBFactory();
}

let dbSeq = 0;
export function freshDbName() {
  dbSeq += 1;
  return `metric-studio-test-${dbSeq}`;
}

/** A repository on the given factory, initialised, as a browser tab would have it. */
export async function openRepo(factory, dbName) {
  const repo = new LocalRepository({ dbName, indexedDB: factory });
  await repo.init();
  return repo;
}

/** A full application context — a "tab" — over an IndexedDB repository. */
export async function openTab(factory, dbName, { seed = false } = {}) {
  const repo = await openRepo(factory, dbName);
  const store = new Store();
  const selectors = createSelectors(store);
  if (seed) store.hydrate(await repo.replaceAll(buildDemoSnapshot()));
  else store.hydrate(await repo.loadAll());
  const metrics = new MetricService({ store, selectors, repo });
  const structure = new StructureService({ store, selectors, repo });
  const reports = new ReportService({ store, selectors, repo });
  const bindings = new BindingService({ store, selectors, repo, metricService: metrics });
  const dimensions = new DimensionService({ store, selectors, repo });
  const dependencies = new DependencyService(store, selectors);
  const backup = new BackupService({ store, repo });
  return { repo, store, selectors, metrics, structure, reports, bindings, dimensions, dependencies, backup };
}

/** A tab catching up with what other tabs wrote: re-read the database into mirror and store. */
export async function reload(tab) {
  await tab.repo.refresh();
  tab.store.hydrate(await tab.repo.loadAll());
  return tab;
}

/** Raw access to a database on the factory, for building legacy layouts by hand. */
export function rawOpen(factory, dbName, version, upgrade) {
  return new Promise((resolve, reject) => {
    const req = factory.open(dbName, version);
    req.onupgradeneeded = (e) => upgrade && upgrade(req.result, req.transaction, e);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('blocked'));
  });
}

export function rawDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('aborted'));
  });
}

export function rawAll(db, storeName) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
