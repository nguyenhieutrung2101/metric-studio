import { createMetric, MetricStatus } from '../core/models/metric.js';
import { createMetricStructure } from '../core/models/structure.js';
import { NotFoundError, tokenOf } from '../repositories/repository.js';
import { referenceKey, padNumber } from '../utils/text.js';
import { UnitOfWork, commit } from './unit-of-work.js';

export class ValidationFailure extends Error {
  constructor(message, field = null) {
    super(message);
    this.name = 'ValidationFailure';
    this.field = field;
  }
}

/**
 * MetricService — the only writer of the `metrics` collection.
 *
 * Identity rules live here: ids are never reassigned, codes are unique and
 * allocated sequentially, and deleting a metric removes its link records in
 * the same transaction. Other metrics' formulas keep their text and surface
 * as "missing reference" warnings, which is the visible failure we want.
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

  /** The metric and its first placement are created together or not at all. */
  async create(input, { structureNodeId = null, isPrimary = true } = {}) {
    const name = String(input.name || '').trim();
    if (!name) throw new ValidationFailure('Name is required', 'name');
    const code = String(input.code || '').trim() || this.nextCode();
    this._assertCodeUnique(code);
    const metric = createMetric({ ...input, name, code, version: 0 });
    const work = new UnitOfWork().save('metrics', metric, null);
    if (structureNodeId && this.store.has('structureNodes', structureNodeId)) {
      work.save('metricStructures', createMetricStructure({ metricId: metric.id, structureNodeId, isPrimary }), null);
    }
    const result = await commit(this.repo, this.store, work);
    return result.saved.find((s) => s.collection === 'metrics').record;
  }

  async update(id, patch, expectedToken) {
    const existing = this.store.get('metrics', id);
    if (!existing) throw new NotFoundError('metrics', id);
    const merged = createMetric({ ...existing, ...patch, id: existing.id, createdAt: existing.createdAt, version: existing.version });
    if (!merged.name) throw new ValidationFailure('Name is required', 'name');
    if (!merged.code) merged.code = existing.code || this.nextCode();
    this._assertCodeUnique(merged.code, id);
    const saved = await this.repo.saveMetric(merged, expectedToken == null ? tokenOf(existing) : expectedToken);
    this.store.upsert('metrics', saved);
    return saved;
  }

  /** Metric plus every record that only exists because of it, in one transaction. */
  async remove(id, expectedToken) {
    const existing = this.store.get('metrics', id);
    if (!existing) throw new NotFoundError('metrics', id);
    const work = new UnitOfWork().remove('metrics', id, expectedToken == null ? tokenOf(existing) : expectedToken);
    for (const l of this.store.list('metricStructures')) if (l.metricId === id) work.remove('metricStructures', l.id, tokenOf(l));
    for (const b of this.store.list('bindings')) if (b.metricId === id) work.remove('bindings', b.id, tokenOf(b));
    for (const l of this.store.list('metricDimensions')) if (l.metricId === id) work.remove('metricDimensions', l.id, tokenOf(l));
    await commit(this.repo, this.store, work);
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
