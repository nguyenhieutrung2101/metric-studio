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

const REFERENCE_STATUSES = new Set(['resolved', 'missing', 'ambiguous', 'unknown-scenario']);

/**
 * Parsed references are cached parser output, but they also arrive from
 * imported files, where anything at all can be in them. Everything that reads
 * a reference (validation, the dependency graph, the drawer) assumes this
 * shape, so it is enforced once, here, at the model boundary.
 */
export function sanitizeParsedReferences(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const token = trimOrEmpty(raw.token);
    if (!token) continue;
    out.push({
      raw: trimOrEmpty(raw.raw) || `[${token}]`,
      token,
      scenarioCode: raw.scenarioCode == null ? null : String(raw.scenarioCode).trim().toUpperCase() || null,
      dimensionContext: sanitizeDimensionContext(raw.dimensionContext),
      metricId: typeof raw.metricId === 'string' && raw.metricId ? raw.metricId : null,
      scenarioId: typeof raw.scenarioId === 'string' && raw.scenarioId ? raw.scenarioId : null,
      status: REFERENCE_STATUSES.has(raw.status) ? raw.status : 'missing',
    });
  }
  return out;
}

function sanitizeDimensionContext(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const pair of value) {
    if (!pair || typeof pair !== 'object' || Array.isArray(pair)) continue;
    const dimension = trimOrEmpty(pair.dimension);
    if (!dimension) continue;
    out.push({ dimension, member: pair.member == null ? null : trimOrEmpty(pair.member) });
  }
  return out.length ? out : null;
}

export function sanitizeFormulaErrors(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const e of value) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    out.push({ message: trimOrEmpty(e.message), position: Number.isFinite(e.position) ? e.position : 0 });
  }
  return out;
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
    parsedReferences: sanitizeParsedReferences(input.parsedReferences),
    formulaErrors: sanitizeFormulaErrors(input.formulaErrors),
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
