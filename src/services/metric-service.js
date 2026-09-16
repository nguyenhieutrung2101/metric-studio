import { createMetric, MetricStatus } from '../core/models/metric.js';
import { createMetricStructure } from '../core/models/structure.js';
import { NotFoundError, tokenOf } from '../repositories/repository.js';
import { referenceKey, padNumber } from '../utils/text.js';
import { UnitOfWork, commit, commitExclusive } from './unit-of-work.js';
import { ValidationFailure, StaleCascadeError } from './errors.js';

// Where the services' shared refusals live now; re-exported so every caller
// that learned them from here still finds them.
export { ValidationFailure, StaleCascadeError };

/** Records that only exist because of a metric and go with it. */
const DEPENDENT_COLLECTIONS = ['metricStructures', 'bindings', 'metricDimensions', 'metricReports'];

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

  /**
   * Preview of the next code, for the placeholder in the create form only.
   * The code a metric actually gets is allocated by the repository at save
   * time: this reads the store, which two concurrent creates would read
   * identically.
   */
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

  /** The canonical-code pattern, shared with the repository's allocator. */
  get _codePattern() {
    return new RegExp(`^${this.codePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)$`);
  }

  _assertCodeUnique(code, exceptId = null) {
    const ids = this.selectors.metricsByCode().get(referenceKey(code)) || [];
    if (ids.some((id) => id !== exceptId)) throw new ValidationFailure(`Metric code "${code}" is already used`, 'code');
  }

  /**
   * The same question asked where the data lives. This tab's store cannot
   * see the metric another tab created with the same manual code a moment
   * ago; the guard reads the stored collection inside the write transaction
   * and refuses the second one. Legacy duplicates already on disk are a
   * validation finding, not a reason to refuse an unrelated edit — the guard
   * only travels with a write that sets a new code.
   */
  _codeGuard(code, exceptId) {
    const key = referenceKey(code);
    return (stored) => {
      for (const m of stored) if (m.id !== exceptId && referenceKey(m.code) === key) throw new ValidationFailure(`Metric code "${code}" is already used`, 'code');
    };
  }

  /** The metric and its first placement are created together or not at all. */
  async create(input, { structureNodeId = null, isPrimary = true } = {}) {
    const name = String(input.name || '').trim();
    if (!name) throw new ValidationFailure('Name is required', 'name');
    // Allocated inside the repository's write queue, and for a durable
    // adapter inside a transaction, so two creates started at once cannot be
    // handed the same number.
    const code = String(input.code || '').trim()
      || await this.repo.allocateCode('metrics', { prefix: this.codePrefix, width: 6, pattern: this._codePattern });
    this._assertCodeUnique(code);
    const metric = createMetric({ ...input, name, code, version: 0 });
    const work = new UnitOfWork().save('metrics', metric, null).guard('metrics', this._codeGuard(code, metric.id));
    if (structureNodeId && this.store.has('structureNodes', structureNodeId)) {
      work.save('metricStructures', createMetricStructure({ metricId: metric.id, structureNodeId, isPrimary }), null).require('structureNodes', structureNodeId);
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
    // Uniqueness is asked only of a write that sets a new code. A legacy
    // duplicate already on disk is a validation finding; refusing to let its
    // name be edited would leave the person no way to fix it.
    const codeChanged = referenceKey(merged.code) !== referenceKey(existing.code);
    if (codeChanged) this._assertCodeUnique(merged.code, id);
    const work = new UnitOfWork().save('metrics', merged, expectedToken == null ? tokenOf(existing) : expectedToken);
    if (codeChanged) work.guard('metrics', this._codeGuard(merged.code, id));
    const result = await commit(this.repo, this.store, work);
    return result.saved.find((x) => x.collection === 'metrics').record;
  }

  /**
   * Metric plus every record that only exists because of it, in one
   * transaction. The dependent records are queued first: on a backend that
   * cannot commit atomically, stopping halfway then leaves a metric with
   * fewer bindings, which is retryable, instead of orphan bindings pointing
   * at a metric that is gone.
   */
  /**
   * Delete a metric and everything that only exists because of it.
   *
   * What depends on the metric is collected inside the repository's critical
   * section: reading the store first would miss a binding or a placement
   * created since the store was last mirrored, and that record would outlive
   * the metric it points at.
   */
  async remove(id, expectedToken) {
    if (!this.store.has('metrics', id)) throw new NotFoundError('metrics', id);
    // The dependents are collected from this instance's records, then the
    // batch carries a guard that refuses if the database holds one the
    // collection missed — a binding another tab created a moment ago. The
    // guard hands the database's records to the mirror, so the one retry
    // collects the complete set. Two rounds suffice: the second is judged
    // against what the first one just learned.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await commitExclusive(this.repo, this.store, (tx) => {
          const existing = tx.get('metrics', id);
          if (!existing) throw new NotFoundError('metrics', id);
          const work = new UnitOfWork();
          const removing = new Set();
          for (const collection of DEPENDENT_COLLECTIONS) {
            for (const r of tx.list(collection)) {
              if (r.metricId !== id) continue;
              work.remove(collection, r.id, tokenOf(r), { optional: true });
              removing.add(r.id);
            }
            work.guard(collection, (stored) => {
              for (const r of stored) if (r.metricId === id && !removing.has(r.id)) throw new StaleCascadeError(collection, r.id);
            });
          }
          work.remove('metrics', id, expectedToken == null ? tokenOf(existing) : expectedToken);
          return work;
        });
        return true;
      } catch (err) {
        if (err instanceof StaleCascadeError && attempt === 0) continue;
        throw err;
      }
    }
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
