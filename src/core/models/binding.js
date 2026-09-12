import { newId } from '../../utils/id.js';
import { nowIso } from '../../utils/time.js';
import { trimOrEmpty } from '../../utils/text.js';

export const BindingType = Object.freeze({
  SOURCE: 'source',
  FORMULA: 'formula',
  ASSUMPTION: 'assumption',
  NONE: 'none',
});
export const BINDING_TYPES = Object.values(BindingType);

export const BindingStatus = Object.freeze({ DRAFT: 'draft', APPROVED: 'approved' });
export const BINDING_STATUSES = Object.values(BindingStatus);

export function createSourceInfo(input = {}) {
  return {
    system: trimOrEmpty(input.system),
    dataset: trimOrEmpty(input.dataset),
    field: trimOrEmpty(input.field),
    owner: trimOrEmpty(input.owner),
    frequency: trimOrEmpty(input.frequency),
    note: trimOrEmpty(input.note),
  };
}

export function createAssumptionInfo(input = {}) {
  return {
    value: trimOrEmpty(input.value),
    basis: trimOrEmpty(input.basis),
    validFrom: trimOrEmpty(input.validFrom),
    validTo: trimOrEmpty(input.validTo),
    note: trimOrEmpty(input.note),
  };
}

/**
 * A binding is the scenario-specific answer to "how do we get this metric's
 * value". Exactly one per (metricId, scenarioId).
 */
export function createBinding(input = {}) {
  const ts = nowIso();
  return {
    id: input.id || newId(),
    metricId: input.metricId,
    scenarioId: input.scenarioId,
    type: BINDING_TYPES.includes(input.type) ? input.type : BindingType.NONE,
    legacyCode: trimOrEmpty(input.legacyCode),
    source: createSourceInfo(input.source),
    formulaText: trimOrEmpty(input.formulaText),
    parsedReferences: Array.isArray(input.parsedReferences) ? input.parsedReferences.map((r) => ({ ...r })) : [],
    formulaErrors: Array.isArray(input.formulaErrors) ? input.formulaErrors.map((e) => ({ ...e })) : [],
    assumption: createAssumptionInfo(input.assumption),
    status: BINDING_STATUSES.includes(input.status) ? input.status : BindingStatus.DRAFT,
    note: trimOrEmpty(input.note),
    createdAt: input.createdAt || ts,
    updatedAt: input.updatedAt || ts,
    version: Number.isInteger(input.version) ? input.version : 0,
  };
}

/** Key of the graph node a binding represents. */
export function nodeKey(metricId, scenarioId) {
  return `${metricId}|${scenarioId}`;
}

export function splitNodeKey(key) {
  const i = key.indexOf('|');
  return { metricId: key.slice(0, i), scenarioId: key.slice(i + 1) };
}
