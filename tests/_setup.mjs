import { Store } from '../src/core/store/store.js';
import { createSelectors } from '../src/core/store/selectors.js';
import { MemoryRepository } from '../src/repositories/memory-repository.js';
import { MetricService } from '../src/services/metric-service.js';
import { StructureService } from '../src/services/structure-service.js';
import { ReportService } from '../src/services/report-service.js';
import { BindingService } from '../src/services/binding-service.js';
import { DimensionService } from '../src/services/dimension-service.js';
import { DependencyService } from '../src/services/dependency-service.js';
import { BackupService } from '../src/services/backup-service.js';
import { buildDemoSnapshot } from '../src/data/seed.js';

/** Fresh in-memory application context, optionally seeded with the demo catalogue. */
export async function createContext({ seed = true } = {}) {
  const repo = new MemoryRepository();
  await repo.init();
  const store = new Store();
  const selectors = createSelectors(store);
  if (seed) {
    const saved = await repo.replaceAll(buildDemoSnapshot());
    store.hydrate(saved);
  }
  const metrics = new MetricService({ store, selectors, repo });
  const structure = new StructureService({ store, selectors, repo });
  const reports = new ReportService({ store, selectors, repo });
  const bindings = new BindingService({ store, selectors, repo, metricService: metrics });
  const dimensions = new DimensionService({ store, selectors, repo });
  const dependencies = new DependencyService(store, selectors);
  const backup = new BackupService({ store, repo });
  return { repo, store, selectors, metrics, structure, reports, bindings, dimensions, dependencies, backup };
}

export const TT = 'scn-tt';
export const GD = 'scn-gd';
