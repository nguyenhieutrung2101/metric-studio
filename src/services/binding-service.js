import { createBinding, BindingType } from '../core/models/binding.js';
import { NotFoundError } from '../repositories/repository.js';
import { parseFormula, distinctReferences } from './formula-parser.js';
import { ValidationFailure } from './metric-service.js';

/**
 * Parse a formula and resolve its references against the catalogue.
 * Pure with respect to persistence; used for live editor feedback, on save
 * and by the seed builder. Never creates metrics.
 */
export function resolveFormula(formulaText, scenarioId, selectors, store) {
  const parsed = parseFormula(formulaText);
  const references = distinctReferences(parsed.references).map((r) => {
    let targetScenarioId = scenarioId;
    let status = 'resolved';
    if (r.scenarioCode) {
      const s = selectors.scenarioByCode(r.scenarioCode);
      if (s) targetScenarioId = s.id;
      else status = 'unknown-scenario';
    }
    const res = selectors.resolveReference(r.token);
    const metricId = res.status === 'resolved' ? res.metricId : null;
    if (status === 'resolved') status = res.status; // resolved | ambiguous | missing
    const suggestions = metricId ? [] : selectors.suggestMetrics(r.token, 5).map((m) => ({ id: m.id, code: m.code, name: m.name }));
    const candidates = res.candidates.map((id) => store.get('metrics', id)).filter(Boolean).map((m) => ({ id: m.id, code: m.code, name: m.name }));
    return {
      raw: r.raw,
      token: r.token,
      scenarioCode: r.scenarioCode || null,
      dimensionContext: r.dimensionContext || null,
      metricId,
      scenarioId: targetScenarioId,
      status,
      candidates,
      suggestions,
      isCrossScenario: targetScenarioId !== scenarioId,
    };
  });
  return { ok: parsed.ok, isEmpty: parsed.isEmpty, errors: parsed.errors, references, ast: parsed.ast };
}

/** Strip UI-only fields before persisting. */
function persistableReferences(references) {
  return references.map(({ raw, token, scenarioCode, dimensionContext, metricId, scenarioId, status }) => ({ raw, token, scenarioCode, dimensionContext, metricId, scenarioId, status }));
}

/**
 * BindingService — exactly one binding per Metric × Scenario.
 * Saving a binding never touches MetricStructure (invariant tested).
 */
export class BindingService {
  constructor({ store, selectors, repo, metricService = null }) {
    this.store = store;
    this.selectors = selectors;
    this.repo = repo;
    this.metricService = metricService;
  }

  preview(formulaText, scenarioId) {
    return resolveFormula(formulaText, scenarioId, this.selectors, this.store);
  }

  async setBinding(metricId, scenarioId, input, expectedVersion) {
    if (!this.store.has('metrics', metricId)) throw new NotFoundError('metrics', metricId);
    if (!this.store.has('scenarios', scenarioId)) throw new NotFoundError('scenarios', scenarioId);
    const existing = this.selectors.bindingFor(metricId, scenarioId);
    const binding = createBinding({ ...(existing || {}), ...input, id: existing ? existing.id : input.id, metricId, scenarioId, createdAt: existing ? existing.createdAt : undefined, version: existing ? existing.version : 0 });
    let resolution = null;
    if (binding.type === BindingType.FORMULA) {
      resolution = resolveFormula(binding.formulaText, scenarioId, this.selectors, this.store);
      binding.parsedReferences = persistableReferences(resolution.references);
      binding.formulaErrors = resolution.errors.map((e) => ({ message: e.message, position: e.position }));
    } else {
      binding.parsedReferences = [];
      binding.formulaErrors = [];
    }
    const saved = await this.repo.saveBinding(binding, existing ? (expectedVersion == null ? existing.version : expectedVersion) : null);
    this.store.upsert('bindings', saved);
    return { binding: saved, resolution };
  }

  /** Re-parse an existing formula binding (after a referenced metric was created or renamed). */
  async refreshReferences(bindingId) {
    const b = this.store.get('bindings', bindingId);
    if (!b) throw new NotFoundError('bindings', bindingId);
    if (b.type !== BindingType.FORMULA) return { binding: b, resolution: null };
    return this.setBinding(b.metricId, b.scenarioId, { formulaText: b.formulaText, type: b.type }, b.version);
  }

  async removeBinding(metricId, scenarioId, expectedVersion) {
    const existing = this.selectors.bindingFor(metricId, scenarioId);
    if (!existing) return false;
    await this.repo.deleteBinding(existing.id, expectedVersion == null ? existing.version : expectedVersion);
    this.store.remove('bindings', existing.id);
    return true;
  }

  /**
   * Explicit user action: turn a missing reference into a draft metric, then
   * re-resolve the binding so the edge appears. Requires a structure node when
   * one is available in the catalogue (Metric Master completeness first).
   */
  async createDraftFromReference(bindingId, token, { structureNodeId = null, name = null, unitId = null } = {}) {
    if (!this.metricService) throw new Error('metricService is required');
    if (!structureNodeId && this.store.count('structureNodes') > 0) throw new ValidationFailure('Choose a structure node for the new draft metric', 'structureNodeId');
    const metric = await this.metricService.createDraftFromReference(token, { structureNodeId, name, unitId });
    const result = await this.refreshReferences(bindingId);
    return { metric, ...result };
  }
}
