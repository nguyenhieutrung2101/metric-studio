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

/**
 * How a formula binding's text is to be read.
 *
 *   expression  the grammar the parser checks: references, arithmetic, calls.
 *               Anything it cannot parse is a syntax error.
 *   text        a description in words — the rare formula that does not fit
 *               the grammar ("weighted by the SOP v3 table, see appendix").
 *               Never a syntax error, never executable, always reported as
 *               a warning so it stays rare and visible. References written
 *               in brackets are still extracted, so the dependency graph
 *               knows what the description says it consists of.
 */
export const FormulaMode = Object.freeze({ EXPRESSION: 'expression', TEXT: 'text' });
export const FORMULA_MODES = Object.values(FormulaMode);
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
    formulaMode: input.formulaMode === FormulaMode.TEXT ? FormulaMode.TEXT : FormulaMode.EXPRESSION,
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

/** A formula binding whose text is a description in words, not an expression. */
export function isFreeTextFormula(b) {
  return !!b && b.type === BindingType.FORMULA && b.formulaMode === FormulaMode.TEXT;
}

/** Key of the graph node a binding represents. */
export function nodeKey(metricId, scenarioId) {
  return `${metricId}|${scenarioId}`;
}

export function splitNodeKey(key) {
  const i = key.indexOf('|');
  return { metricId: key.slice(0, i), scenarioId: key.slice(i + 1) };
}
