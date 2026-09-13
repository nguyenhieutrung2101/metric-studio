import { referenceKey } from '../utils/text.js';

/**
 * Resolving a formula reference token to a metric, defined once.
 *
 * The selectors use it over the live store; the schema boundary uses it over
 * the records of a file being imported, where there is no store yet. Both
 * have to agree, or a formula would mean one thing during import and another
 * one afterwards.
 *
 * Priority is code → alias → exact name, and several hits at the winning
 * level are ambiguous rather than a guess. Keys go through `referenceKey`,
 * so case, spacing and diacritics do not matter — the same normalisation
 * that decides whether two references are the same reference.
 */
export function buildReferenceLookup(metrics) {
  const byCode = new Map();
  const byAlias = new Map();
  const byName = new Map();
  const push = (map, key, id) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    const arr = map.get(key);
    if (!arr.includes(id)) arr.push(id);
  };
  for (const m of metrics) {
    push(byCode, referenceKey(m.code), m.id);
    for (const a of m.aliases || []) push(byAlias, referenceKey(a), m.id);
    push(byName, referenceKey(m.name), m.id);
  }
  return { byCode, byAlias, byName };
}

/** @returns {{ status: 'resolved'|'ambiguous'|'missing', metricId: string|null, candidates: string[] }} */
export function resolveReferenceIn(lookup, token) {
  const key = referenceKey(token);
  if (!key) return { status: 'missing', metricId: null, candidates: [] };
  for (const map of [lookup.byCode, lookup.byAlias, lookup.byName]) {
    const ids = map.get(key);
    if (ids && ids.length === 1) return { status: 'resolved', metricId: ids[0], candidates: ids };
    if (ids && ids.length > 1) return { status: 'ambiguous', metricId: null, candidates: ids };
  }
  return { status: 'missing', metricId: null, candidates: [] };
}
