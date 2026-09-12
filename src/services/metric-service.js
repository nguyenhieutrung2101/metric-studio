import { createMetric, MetricStatus } from '../core/models/metric.js';
import { createMetricStructure } from '../core/models/structure.js';
import { NotFoundError } from '../repositories/repository.js';
import { referenceKey, padNumber } from '../utils/text.js';

export class ValidationFailure extends Error {
  constructor(message, field = null) {
    super(message);
    this.name = 'ValidationFailure';
    this.field = field;
  }
}

/**
 * MetricService — the only writer of the `metrics` collection.
 * Identity rules live here: ids are never reassigned, codes are unique and
 * allocated sequentially, and deleting a metric cascades its link records
 * (placements, bindings, dimension links) but never rewrites other metrics'
 * formulas — those become visible "missing reference" warnings.
 */
export class MetricService {
  constructor({ store, selectors, repo, codePrefix = 'M.' }) {
    this.store = store;
    this.selectors = selectors;
    this.repo = repo;
    this.codePrefix = codePrefix;
  }

  nextCode() {
    const prefix = this.codePrefix;
    let max = 0;
    for (const m of this.store.list('metrics')) {
      if (m.code && m.code.startsWith(prefix)) {
        const n = Number(m.code.slice(prefix.length));
        if (Number.isInteger(n) && n > max) max = n;
      }
    }
    return `${prefix}${padNumber(max + 1, 6)}`;
  }

  _assertCodeUnique(code, exceptId = null) {
    const ids = this.selectors.metricsByCode().get(referenceKey(code)) || [];
    if (ids.some((id) => id !== exceptId)) throw new ValidationFailure(`Metric code "${code}" is already used`, 'code');
  }

  async create(input, { structureNodeId = null, isPrimary = true } = {}) {
    const name = String(input.name || '').trim();
    if (!name) throw new ValidationFailure('Name is required', 'name');
    const code = String(input.code || '').trim() || this.nextCode();
    this._assertCodeUnique(code);
    const metric = createMetric({ ...input, name, code, version: 0 });
    const saved = await this.repo.saveMetric(metric, null);
    this.store.upsert('metrics', saved);
    if (structureNodeId && this.store.has('structureNodes', structureNodeId)) {
      const link = createMetricStructure({ metricId: saved.id, structureNodeId, isPrimary });
      const savedLink = await this.repo.saveMetricStructure(link, null);
      this.store.upsert('metricStructures', savedLink);
    }
    return saved;
  }

  async update(id, patch, expectedVersion) {
    const existing = this.store.get('metrics', id);
    if (!existing) throw new NotFoundError('metrics', id);
    const merged = createMetric({ ...existing, ...patch, id: existing.id, createdAt: existing.createdAt, version: existing.version });
    if (!merged.name) throw new ValidationFailure('Name is required', 'name');
    if (!merged.code) merged.code = existing.code || this.nextCode();
    this._assertCodeUnique(merged.code, id);
    const saved = await this.repo.saveMetric(merged, expectedVersion == null ? existing.version : expectedVersion);
    this.store.upsert('metrics', saved);
    return saved;
  }

  async remove(id, expectedVersion) {
    const existing = this.store.get('metrics', id);
    if (!existing) throw new NotFoundError('metrics', id);
    // Version check first so a stale delete does not cascade anything.
    await this.repo.deleteMetric(id, expectedVersion == null ? existing.version : expectedVersion);
    this.store.remove('metrics', id);
    const cascade = [
      ['metricStructures', this.store.list('metricStructures').filter((l) => l.metricId === id)],
      ['bindings', this.store.list('bindings').filter((b) => b.metricId === id)],
      ['metricDimensions', this.store.list('metricDimensions').filter((l) => l.metricId === id)],
    ];
    for (const [collection, records] of cascade) {
      for (const r of records) {
        try {
          await this.repo.remove(collection, r.id, null);
        } catch (err) {
          if (err.name !== 'NotFoundError') throw err;
        }
      }
      this.store.removeMany(collection, records.map((r) => r.id));
    }
    return true;
  }

  /**
   * Explicit "Create Draft Metric" from a formula reference. The token is kept
   * as an alias so the formula keeps resolving after the user renames it.
   */
  async createDraftFromReference(token, { structureNodeId = null, name = null, unitId = null } = {}) {
    const label = String(name || token || '').trim();
    if (!label) throw new ValidationFailure('Reference token is required', 'name');
    const aliases = referenceKey(token) !== referenceKey(label) ? [token] : [];
    const res = this.selectors.resolveReference(token);
    if (res.status === 'resolved') return this.store.get('metrics', res.metricId);
    return this.create({ name: label, aliases, status: MetricStatus.DRAFT, unitId }, { structureNodeId });
  }
}
